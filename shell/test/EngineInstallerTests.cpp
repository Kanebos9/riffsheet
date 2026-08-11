#include <JuceHeader.h>
#include "EngineInstaller.h"
#include "EngineCatalog.h"
#include "sidecar/SidecarAdapter.h"
#include "sidecar/SidecarMidi.h"

/*
    The installer, and the two things in it that are silently wrong when they are
    wrong: the downloader and the MIDI reader.

    THE DOWNLOADER IS TESTED AGAINST A REAL SERVER, not a mock. Resume, redirect
    handling and Content-Length disagreement are all HTTP behaviour, and a fake
    that answers the way we think a server answers would only prove that our idea
    of a server matches our idea of a client. So this file starts a loopback
    HTTP server, serves real bytes over a real socket, and drives the real
    juce::URL path through it.

    THE ONE RELAXATION, AND WHY IT CANNOT LEAK. The shipped policy is https-only
    with a fixed host list, and a loopback test server has neither. HostPolicy is
    therefore a parameter of fetch(), and the tests pass one that allows plain
    http to 127.0.0.1. install() does not take a policy at all - it uses
    HostPolicy::shipped() - so there is no code path from the bridge to a
    relaxed policy, and the first two tests below are the ones that prove the
    shipped policy still refuses what it should.
*/

namespace
{
    juce::String hexDigestOf (const juce::MemoryBlock& bytes)
    {
        return juce::SHA256 (bytes.getData(), bytes.getSize()).toHexString();
    }

    juce::MemoryBlock makeBytes (int length, int seed)
    {
        juce::MemoryBlock block ((size_t) length);
        auto* data = static_cast<juce::uint8*> (block.getData());
        juce::Random random (seed);

        for (int i = 0; i < length; ++i)
            data[i] = (juce::uint8) random.nextInt (256);

        return block;
    }

    /** A one-connection-at-a-time HTTP/1.1 server, enough for these tests and
        nothing more. Every response closes its connection, so no client can be
        holding one open when the test finishes. */
    class TestHttpServer final : private juce::Thread
    {
    public:
        struct Route
        {
            juce::MemoryBlock body;
            int status = 200;
            juce::String redirectTo;    // when set, answers 302 with this Location
            bool honourRange = true;    // false = answer 200 with the whole body
            bool truncateAfter = false; // close the socket early, mid-body
        };

        TestHttpServer() : juce::Thread ("Riffsheet test http") {}

        ~TestHttpServer() override
        {
            signalThreadShouldExit();
            listener.close();
            stopThread (4000);
        }

        /** Binds a free loopback port. Returns 0 on failure. */
        int start()
        {
            for (int candidate = 45871; candidate < 45971; ++candidate)
            {
                if (listener.createListener (candidate, "127.0.0.1"))
                {
                    port = candidate;
                    startThread();
                    return port;
                }
            }

            return 0;
        }

        juce::String url (const juce::String& path) const
        {
            return "http://127.0.0.1:" + juce::String (port) + path;
        }

        /** The same server under a name the policy does not know, which is how
            "the allowlist is checked after a redirect too" is proved. */
        juce::String urlByOtherName (const juce::String& path) const
        {
            return "http://localhost:" + juce::String (port) + path;
        }

        void set (const juce::String& path, Route route)
        {
            const juce::ScopedLock sl (lock);
            routes.set (path, std::make_shared<Route> (std::move (route)));
        }

        std::atomic<int> requestCount { 0 };
        std::atomic<int> rangedRequestCount { 0 };

    private:
        void run() override
        {
            while (! threadShouldExit())
            {
                std::unique_ptr<juce::StreamingSocket> connection (listener.waitForNextConnection());

                if (connection == nullptr)
                    continue;

                serve (*connection);
            }
        }

        void serve (juce::StreamingSocket& connection)
        {
            juce::String request;

            // Headers only: nothing here ever sends a body.
            while (! request.contains ("\r\n\r\n") && request.length() < 8192)
            {
                char byte = 0;

                if (connection.read (&byte, 1, true) != 1)
                    return;

                request += juce::String::charToString ((juce::juce_wchar) (juce::uint8) byte);
            }

            ++requestCount;

            const auto firstLine = request.upToFirstOccurrenceOf ("\r\n", false, false);
            const auto path = firstLine.fromFirstOccurrenceOf (" ", false, false)
                                       .upToFirstOccurrenceOf (" ", false, false);

            std::shared_ptr<Route> route;

            {
                const juce::ScopedLock sl (lock);
                route = routes[path];
            }

            if (route == nullptr)
            {
                send (connection, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n"
                                  "Connection: close\r\n\r\n", {});
                return;
            }

            if (route->redirectTo.isNotEmpty())
            {
                send (connection, "HTTP/1.1 302 Found\r\nLocation: " + route->redirectTo
                                  + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", {});
                return;
            }

            juce::int64 from = 0;
            const auto rangeHeader = requestHeader (request, "Range");

            if (rangeHeader.isNotEmpty())
            {
                ++rangedRequestCount;

                if (route->honourRange)
                    from = rangeHeader.fromFirstOccurrenceOf ("bytes=", false, false)
                                      .upToFirstOccurrenceOf ("-", false, false)
                                      .getLargeIntValue();
            }

            const auto total = (juce::int64) route->body.getSize();
            from = juce::jlimit ((juce::int64) 0, total, from);
            const auto length = total - from;

            juce::MemoryBlock slice (static_cast<const char*> (route->body.getData()) + from,
                                     (size_t) length);

            juce::String head;

            if (from > 0)
                head = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes "
                     + juce::String (from) + "-" + juce::String (total - 1) + "/" + juce::String (total)
                     + "\r\n";
            else
                head = "HTTP/1.1 " + juce::String (route->status) + " OK\r\n";

            head += "Accept-Ranges: bytes\r\nContent-Length: " + juce::String (length)
                  + "\r\nConnection: close\r\n\r\n";

            if (route->truncateAfter)
                slice.setSize ((size_t) juce::jmax ((juce::int64) 1, length / 3), false);

            send (connection, head, slice);
        }

        static juce::String requestHeader (const juce::String& request, const juce::String& name)
        {
            for (const auto& line : juce::StringArray::fromLines (request))
                if (line.startsWithIgnoreCase (name + ":"))
                    return line.fromFirstOccurrenceOf (":", false, false).trim();

            return {};
        }

        static void send (juce::StreamingSocket& connection, const juce::String& head,
                          const juce::MemoryBlock& body)
        {
            const auto headBytes = head.toRawUTF8();
            connection.write (headBytes, (int) std::strlen (headBytes));

            if (body.getSize() > 0)
                connection.write (body.getData(), (int) body.getSize());

            connection.close();
        }

        juce::StreamingSocket listener;
        int port = 0;
        juce::CriticalSection lock;
        juce::HashMap<juce::String, std::shared_ptr<Route>> routes;
    };

    /** The relaxation, in one place, so it is greppable. */
    EngineInstall::HostPolicy loopbackPolicy()
    {
        EngineInstall::HostPolicy policy;
        policy.requireHttps = false;
        policy.hosts = { "127.0.0.1" };
        return policy;
    }
}

//==============================================================================
class EngineInstallerTests final : public juce::UnitTest
{
public:
    EngineInstallerTests() : juce::UnitTest ("EngineInstaller", "EngineInstaller") {}

    void runTest() override
    {
        testShippedPolicy();
        testPlans();
        testDiskSpace();
        testVenvRetargeting();
        testDigest();
        testDownloads();
        testMidiReader();
        runExistingInstallTests();
    }

private:
    //== what the shipped policy refuses =======================================
    void testShippedPolicy()
    {
        beginTest ("the shipped policy is https-only");

        const auto policy = EngineInstall::HostPolicy::shipped();
        juce::String error;

        expect (! policy.allows ("http://github.com/a/b", error),
                "plain http must be refused whatever the host is");
        expect (error.contains ("https"), "the refusal must say why: " + error);

        expect (policy.allows ("https://github.com/a/b", error), error);

        beginTest ("the shipped policy refuses a host that is not on the list");

        expect (! policy.allows ("https://example.com/model.pth", error));
        expect (error.contains ("example.com"), "the refusal names the host: " + error);

        // The one suffix entry, and the two ways it must not over-match.
        expect (policy.allowsHost ("us.aws.cdn.hf.co"), "the HF CDN must be reachable");
        expect (policy.allowsHost ("huggingface.co"));
        expect (! policy.allowsHost ("nothf.co"), "a suffix match must be on a dot boundary");
        expect (! policy.allowsHost ("hf.co.attacker.example"), "the match must be on the END");
        expect (! policy.allowsHost ("github.com.attacker.example"));
        expect (! policy.allowsHost (""));

        beginTest ("a URL with an embedded userinfo cannot spoof the host");

        // https://github.com@evil.example/ is a URL whose HOST is evil.example.
        expect (! policy.allows ("https://github.com@evil.example/x", error), error);
    }

    //== the compiled-in plans =================================================
    void testPlans()
    {
        beginTest ("every one-click row has a plan whose assets are all pinned");

        auto oneClickRows = 0;

        for (const auto* row = EngineCatalog::begin(); row != EngineCatalog::end(); ++row)
        {
            if (row->install != InstallKind::oneClick)
                continue;

            ++oneClickRows;

            juce::String error;
            const auto plan = EngineInstall::planFor (*row, error);

            // A platform with no committed lock file is a legitimate answer, and
            // it must be a clean refusal rather than a half-plan.
            if (error.isNotEmpty())
            {
                expect (plan.assets.empty(), "a refused plan must carry nothing");
                logMessage ("  " + juce::String (row->id) + ": no plan here - " + error);
                continue;
            }

            expect (plan.requirementsResource.isNotEmpty(),
                    juce::String (row->id) + " must have a pip lock");

            const auto policy = EngineInstall::HostPolicy::shipped();

            for (const auto& asset : plan.assets)
            {
                juce::String reason;
                expect (policy.allows (asset.url, reason), reason);
                expectEquals (asset.sha256.length(), 64, juce::String (row->id) + ": " + asset.url);
                expect (asset.sha256.containsOnly ("0123456789abcdef"));
                expect (asset.bytes > 0);
                expect (asset.destination.isNotEmpty());
            }

            // The manifest's own download is the plan's first asset, so the
            // compile-time licensing audit in EngineCatalog.cpp and the runtime
            // plan cannot drift apart.
            if (row->download.archive != ArchiveKind::pipPackage)
            {
                expect (! plan.assets.empty());
                expectEquals (plan.assets.front().url, juce::String (row->download.url));
                expectEquals (plan.assets.front().sha256, juce::String (row->download.sha256));
                expectEquals (plan.assets.front().bytes, row->download.bytes);
            }
        }

        expect (oneClickRows >= 2, "the table should offer at least two one-click engines");

        beginTest ("a guided engine has no plan at all");

        if (const auto* muScriptor = EngineCatalog::find ("muscriptor"))
        {
            juce::String error;
            const auto plan = EngineInstall::planFor (*muScriptor, error);
            expect (error.isNotEmpty(), "MuScriptor must never be installable");
            expect (plan.assets.empty());
        }
        else
        {
            expect (false, "the catalog lost muscriptor");
        }

        beginTest ("stage names are the wire spellings");

        expectEquals (juce::String (EngineInstall::stageName (EngineInstall::Stage::checking)),
                      juce::String ("checking"));
        expectEquals (juce::String (EngineInstall::stageName (EngineInstall::Stage::downloading)),
                      juce::String ("downloading"));
        expectEquals (juce::String (EngineInstall::stageName (EngineInstall::Stage::verifying)),
                      juce::String ("verifying"));
        expectEquals (juce::String (EngineInstall::stageName (EngineInstall::Stage::extracting)),
                      juce::String ("extracting"));
        expectEquals (juce::String (EngineInstall::stageName (EngineInstall::Stage::installing)),
                      juce::String ("installing"));
        expectEquals (juce::String (EngineInstall::stageName (EngineInstall::Stage::probing)),
                      juce::String ("probing"));
    }

    //== disk space ============================================================
    void testDiskSpace()
    {
        beginTest ("the disk check refuses below three times the download");

        const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory);

        // A petabyte is not free anywhere, and asking for one byte always is.
        const auto refusal = EngineInstaller::checkDiskSpace (temp, (juce::int64) 1e15);
        expect (refusal.isNotEmpty(), "a petabyte must be refused");
        expect (refusal.contains ("MB"), "the refusal must carry both numbers: " + refusal);

        expect (EngineInstaller::checkDiskSpace (temp, 1).isEmpty(), "one byte must be fine");

        beginTest ("the requirement really is three times the larger number");

        EngineInstall::Plan plan;
        plan.assets.push_back ({ "https://github.com/a", juce::String::repeatedString ("a", 64),
                                 1000, ArchiveKind::singleFile, "a" });
        plan.assets.push_back ({ "https://github.com/b", juce::String::repeatedString ("b", 64),
                                 2000, ArchiveKind::singleFile, "b" });

        expectEquals (plan.totalDownloadBytes(), (juce::int64) 3000);
        expectEquals (EngineInstaller::requiredFreeBytes (plan), (juce::int64) 9000);

        plan.approxDiskBytes = 100000;
        expectEquals (EngineInstaller::requiredFreeBytes (plan), (juce::int64) 300000);
    }

    //== relocating a virtual environment ======================================
    //
    // This is here because it was WRONG once and the install probe caught it,
    // which is one round of luck more than a shipped installer should need. pip
    // writes the interpreter's absolute path into every console script it
    // generates, so a venv built in a staging directory and then moved is broken
    // until those lines are rewritten - and the symptom is the engine reporting
    // "No such file or directory" naming a folder that no longer exists.
    void testVenvRetargeting()
    {
        beginTest ("a moved virtual environment has its scripts pointed at the new path");

        const auto oldHome = scratch().getChildFile ("transkun.incoming");
        const auto newHome = scratch().getChildFile ("transkun");
        oldHome.deleteRecursively();
        newHome.deleteRecursively();

        const auto bin = newHome.getChildFile ("venv").getChildFile ("bin");
        expect (bin.createDirectory().wasOk());

        // pip's real two-line /bin/sh shim, which is what it writes when the
        // interpreter path is long or contains a space - and
        // "~/Library/Application Support/..." is both.
        // juce::File::replaceWithText defaults to CRLF line endings, which a
        // /bin/sh script must not have - hence the explicit "\n" here and in
        // every write below.
        const auto writeScript = [] (const juce::File& file, const juce::String& text)
        {
            return file.replaceWithText (text, false, false, "\n");
        };

        const auto shim = bin.getChildFile ("transkun");
        expect (writeScript (shim, "#!/bin/sh\n'''exec' \"" + oldHome.getFullPathName()
                                   + "/venv/bin/python\" \"$0\" \"$@\"\n' '''\n"
                                     "from transkun.transcribe import main\n"));
        expect (shim.setExecutePermission (true));

        // ...and the ordinary shebang form, for a short path.
        const auto plain = bin.getChildFile ("pip");
        expect (writeScript (plain, "#!" + oldHome.getFullPathName() + "/venv/bin/python\n"
                                    "import sys\n"));
        expect (plain.setExecutePermission (true));

        // Something that mentions nothing and must be left exactly alone.
        const auto unrelated = bin.getChildFile ("untouched");
        expect (writeScript (unrelated, "nothing to see here\n"));
        const auto unrelatedBefore = unrelated.loadFileAsString();

        juce::String error;
        const auto rewritten = EngineInstaller::retargetVenvScripts (newHome.getChildFile ("venv"),
                                                                     oldHome.getFullPathName(),
                                                                     newHome.getFullPathName(),
                                                                     error);

        expectEquals (rewritten, 2, error);

        const auto shimText = shim.loadFileAsString();
        expect (shimText.contains (newHome.getFullPathName() + "/venv/bin/python"),
                "the shim must point at the new home: " + shimText);
        expect (! shimText.contains (oldHome.getFullPathName()),
                "no trace of the staging path may be left: " + shimText);
        expect (shimText.startsWith ("#!/bin/sh\n"), "the shim must still be a shim");
        expect (shimText.contains ("from transkun.transcribe import main"),
                "the rest of the file must survive");

        const auto plainText = plain.loadFileAsString();
        expect (plainText.startsWith ("#!" + newHome.getFullPathName() + "/venv/bin/python"), plainText);

        expectEquals (unrelated.loadFileAsString(), unrelatedBefore,
                      "a file that mentions neither path must not be touched");

       #if ! JUCE_WINDOWS
        expect (shim.hasWriteAccess());
        // The executable bit is what makes a console script a console script.
        juce::ChildProcess check;
        expect (check.start ("/bin/test -x " + shim.getFullPathName()));
        check.waitForProcessToFinish (5000);
        expectEquals ((int) check.getExitCode(), 0,
                      juce::String ("the rewrite must keep the file executable"));
       #endif

        beginTest ("retargeting a directory that is not a virtual environment is refused");

        juce::String missingError;
        expectEquals (EngineInstaller::retargetVenvScripts (scratch().getChildFile ("nope"),
                                                            "a", "b", missingError),
                      -1);
        expect (missingError.isNotEmpty());
    }

    //== sha256 ================================================================
    void testDigest()
    {
        beginTest ("sha256 of a file matches a known digest");

        auto file = scratch().getChildFile ("digest.bin");

        // The empty string's SHA-256, which is a value anybody can look up.
        file.deleteFile();
        expect (file.create().wasOk());
        expectEquals (EngineInstaller::sha256Of (file),
                      juce::String ("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));

        // "abc", likewise.
        file.replaceWithText ("abc");
        expectEquals (EngineInstaller::sha256Of (file),
                      juce::String ("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));

        const auto bytes = makeBytes (200000, 7);
        file.replaceWithData (bytes.getData(), bytes.getSize());
        expectEquals (EngineInstaller::sha256Of (file), hexDigestOf (bytes));

        expect (EngineInstaller::sha256Of (scratch().getChildFile ("nothing-here")).isEmpty());
    }

    //== the downloader ========================================================
    void testDownloads()
    {
        TestHttpServer server;

        if (server.start() == 0)
        {
            // A machine that will not give us a loopback port is a machine where
            // this cannot be tested, and saying so is better than passing.
            expect (false, "could not bind a loopback port for the download tests");
            return;
        }

        const auto policy = loopbackPolicy();
        const auto payload = makeBytes (300000, 42);
        const auto digest = hexDigestOf (payload);

        {
            TestHttpServer::Route route;
            route.body = payload;
            server.set ("/asset.bin", route);
        }

        const auto downloads = scratch().getChildFile ("downloads");
        downloads.deleteRecursively();
        downloads.createDirectory();

        //-- the happy path, and progress ---------------------------------------
        beginTest ("a pinned download arrives, verifies and lands");
        {
            const auto destination = downloads.getChildFile ("asset.bin");
            juce::String error;
            auto sawDownloading = false, sawVerifying = false;
            juce::int64 highWater = 0;

            const auto ok = EngineInstaller::fetch (server.url ("/asset.bin"), destination,
                                                    (juce::int64) payload.getSize(), digest, policy,
                                                    [&] (const EngineInstall::Progress& progress)
                                                    {
                                                        if (progress.stage == EngineInstall::Stage::downloading)
                                                        {
                                                            sawDownloading = true;
                                                            highWater = juce::jmax (highWater,
                                                                                    progress.receivedBytes);
                                                            expect (progress.totalBytes
                                                                        == (juce::int64) payload.getSize());
                                                            expect (progress.fraction >= 0.0
                                                                        && progress.fraction <= 1.0);
                                                        }
                                                        else if (progress.stage == EngineInstall::Stage::verifying)
                                                        {
                                                            sawVerifying = true;
                                                        }
                                                    },
                                                    nullptr, error);

            expect (ok, error);
            expect (destination.existsAsFile());
            expectEquals (destination.getSize(), (juce::int64) payload.getSize());
            expectEquals (EngineInstaller::sha256Of (destination), digest);
            expect (sawVerifying, "the verify stage must be reported");
            expect (sawDownloading || payload.getSize() < 65536,
                    "a 300 KB download should report progress at least once");
            expect (highWater <= (juce::int64) payload.getSize());

            // Nothing left behind.
            expect (! destination.getSiblingFile ("asset.bin.part").exists());
            expect (! destination.getSiblingFile ("asset.bin.meta.json").exists());
        }

        //-- resume -------------------------------------------------------------
        beginTest ("a truncated .part with matching meta resumes to the right digest");
        {
            const auto destination = downloads.getChildFile ("resume.bin");
            destination.deleteFile();

            const auto partial = downloads.getChildFile ("resume.bin.part");
            const auto meta = downloads.getChildFile ("resume.bin.meta.json");

            const juce::int64 already = 120000;
            partial.replaceWithData (payload.getData(), (size_t) already);

            auto* recorded = new juce::DynamicObject();
            recorded->setProperty ("url", server.url ("/asset.bin"));
            recorded->setProperty ("expectedSha256", digest);
            recorded->setProperty ("expectedBytes", (double) payload.getSize());
            recorded->setProperty ("receivedBytes", (double) already);
            recorded->setProperty ("startedAtMs", 0.0);
            meta.replaceWithText (juce::JSON::toString (juce::var (recorded)));

            const auto rangedBefore = server.rangedRequestCount.load();

            juce::String error;
            const auto ok = EngineInstaller::fetch (server.url ("/asset.bin"), destination,
                                                    (juce::int64) payload.getSize(), digest, policy,
                                                    nullptr, nullptr, error);

            expect (ok, error);
            expectEquals (EngineInstaller::sha256Of (destination), digest);
            expect (server.rangedRequestCount.load() > rangedBefore,
                    "it must actually have asked for a range rather than starting over");
            expect (! partial.exists());
        }

        beginTest ("a .part whose meta describes something else is discarded");
        {
            const auto destination = downloads.getChildFile ("stale.bin");
            destination.deleteFile();

            const auto partial = destination.getSiblingFile ("stale.bin.part");
            const auto meta = destination.getSiblingFile ("stale.bin.meta.json");

            // Bytes that are NOT a prefix of the payload, described as if they
            // belonged to a different asset. Appending to these would produce a
            // file that fails its digest after a full download.
            const auto rubbish = makeBytes (90000, 99);
            partial.replaceWithData (rubbish.getData(), rubbish.getSize());

            auto* recorded = new juce::DynamicObject();
            recorded->setProperty ("url", server.url ("/somewhere-else.bin"));
            recorded->setProperty ("expectedSha256", hexDigestOf (rubbish));
            recorded->setProperty ("expectedBytes", (double) rubbish.getSize());
            recorded->setProperty ("receivedBytes", (double) rubbish.getSize());
            meta.replaceWithText (juce::JSON::toString (juce::var (recorded)));

            juce::String error;
            const auto ok = EngineInstaller::fetch (server.url ("/asset.bin"), destination,
                                                    (juce::int64) payload.getSize(), digest, policy,
                                                    nullptr, nullptr, error);

            expect (ok, error);
            expectEquals (EngineInstaller::sha256Of (destination), digest);
        }

        //-- the wrong file -----------------------------------------------------
        beginTest ("a wrong digest aborts and leaves nothing behind");
        {
            const auto engineDir = scratch().getChildFile ("engines").getChildFile ("pretend");
            engineDir.deleteRecursively();
            engineDir.createDirectory();

            const auto destination = engineDir.getChildFile ("asset.bin");
            const auto wrongDigest = juce::String::repeatedString ("0", 64);

            juce::String error;
            const auto ok = EngineInstaller::fetch (server.url ("/asset.bin"), destination,
                                                    (juce::int64) payload.getSize(), wrongDigest,
                                                    policy, nullptr, nullptr, error);

            expect (! ok, "a file that is not the pinned one must be refused");
            expect (error.contains ("sha256"), error);

            // NOTHING under the engine directory, so no later step can mistake a
            // rejected download for the file it wanted.
            juce::Array<juce::File> leftovers;
            engineDir.findChildFiles (leftovers, juce::File::findFilesAndDirectories, true);

            for (const auto& leftover : leftovers)
                logMessage ("  left behind: " + leftover.getFullPathName());

            expect (leftovers.isEmpty(), "a rejected download must leave the engine folder empty");
        }

        //-- size disagreement --------------------------------------------------
        beginTest ("a Content-Length that disagrees with the pin is refused");
        {
            const auto destination = downloads.getChildFile ("wrongsize.bin");
            juce::String error;

            const auto ok = EngineInstaller::fetch (server.url ("/asset.bin"), destination,
                                                    (juce::int64) payload.getSize() + 1, digest,
                                                    policy, nullptr, nullptr, error);

            expect (! ok);
            expect (error.contains ("size"), error);
            expect (! destination.exists());
        }

        //-- redirects ----------------------------------------------------------
        beginTest ("a redirect to an allowed host is followed");
        {
            TestHttpServer::Route hop;
            hop.redirectTo = server.url ("/asset.bin");
            server.set ("/hop", hop);

            const auto destination = downloads.getChildFile ("hopped.bin");
            juce::String error;

            const auto ok = EngineInstaller::fetch (server.url ("/hop"), destination,
                                                    (juce::int64) payload.getSize(), digest, policy,
                                                    nullptr, nullptr, error);

            expect (ok, error);
            expectEquals (EngineInstaller::sha256Of (destination), digest);
        }

        beginTest ("a redirect to a host that is not on the list is refused");
        {
            TestHttpServer::Route hop;
            // Same machine, same port, a name that is not on the policy's list -
            // so this fails ONLY if the allowlist is applied after the redirect.
            hop.redirectTo = server.urlByOtherName ("/asset.bin");
            server.set ("/evil", hop);

            const auto destination = downloads.getChildFile ("evil.bin");
            juce::String error;

            const auto ok = EngineInstaller::fetch (server.url ("/evil"), destination,
                                                    (juce::int64) payload.getSize(), digest, policy,
                                                    nullptr, nullptr, error);

            expect (! ok, "a redirect off the allowlist must be refused");
            expect (error.contains ("localhost"), "the refusal must name where it was sent: " + error);
            expect (! destination.exists());
        }

        beginTest ("a redirect loop is refused rather than followed for ever");
        {
            TestHttpServer::Route loop;
            loop.redirectTo = server.url ("/loop");
            server.set ("/loop", loop);

            const auto destination = downloads.getChildFile ("loop.bin");
            juce::String error;

            const auto ok = EngineInstaller::fetch (server.url ("/loop"), destination,
                                                    (juce::int64) payload.getSize(), digest, policy,
                                                    nullptr, nullptr, error);

            expect (! ok);
            expect (error.contains ("redirect"), error);
        }

        //-- cancellation -------------------------------------------------------
        beginTest ("cancelling a download stops it and keeps the partial");
        {
            const auto destination = downloads.getChildFile ("cancelled.bin");
            destination.deleteFile();
            destination.getSiblingFile ("cancelled.bin.part").deleteFile();

            juce::String error;

            const auto ok = EngineInstaller::fetch (server.url ("/asset.bin"), destination,
                                                    (juce::int64) payload.getSize(), digest, policy,
                                                    nullptr, [] { return true; }, error);

            expect (! ok);
            expectEquals (error, juce::String ("cancelled"));
            expect (! destination.exists(), "a cancelled download is not an installed file");
        }

        //-- the shipped policy, through the same entry point --------------------
        beginTest ("fetch() with the shipped policy refuses this very server");
        {
            const auto destination = downloads.getChildFile ("refused.bin");
            const auto requestsBefore = server.requestCount.load();
            juce::String error;

            const auto ok = EngineInstaller::fetch (server.url ("/asset.bin"), destination,
                                                    (juce::int64) payload.getSize(), digest,
                                                    EngineInstall::HostPolicy::shipped(),
                                                    nullptr, nullptr, error);

            expect (! ok, "the shipped policy must refuse plain http to a loopback port");
            expect (! destination.exists());
            expectEquals (server.requestCount.load(), requestsBefore,
                          "the refusal must happen before any connection is made");
        }
    }

    //== the MIDI reader =======================================================
    void testMidiReader()
    {
        beginTest ("notes come back out of a MIDI file with the right times");

        // 120 BPM, 480 ticks per quarter: one tick is 1/960 s, a quarter is 0.5 s.
        juce::MidiFile file;
        file.setTicksPerQuarterNote (480);

        juce::MidiMessageSequence tempoTrack;
        tempoTrack.addEvent (juce::MidiMessage::tempoMetaEvent (500000), 0.0);
        file.addTrack (tempoTrack);

        juce::MidiMessageSequence track;
        track.addEvent (juce::MidiMessage::textMetaEvent (3, "electric_bass"), 0.0);
        track.addEvent (juce::MidiMessage::noteOn (1, 40, (juce::uint8) 78), 0.0);
        track.addEvent (juce::MidiMessage::noteOff (1, 40), 480.0);          // 0.0 -> 0.5 s
        track.addEvent (juce::MidiMessage::noteOn (1, 45, (juce::uint8) 100), 960.0);
        track.addEvent (juce::MidiMessage::noteOff (1, 45), 1440.0);         // 1.0 -> 1.5 s
        track.addEvent (juce::MidiMessage::noteOn (1, 52, (juce::uint8) 64), 1920.0);  // never ends
        file.addTrack (track);

        juce::MemoryOutputStream out;
        expect (file.writeTo (out));

        juce::MemoryInputStream in (out.getData(), out.getDataSize(), false);
        const auto result = SidecarMidi::read (in);

        expect (result.error.isEmpty(), result.error);
        expectEquals ((int) result.notes.size(), 2);
        expectEquals (result.droppedUnterminated, 1);

        expectEquals (result.notes[0].pitch, 40);
        expectWithinAbsoluteError (result.notes[0].start, 0.0, 1.0e-6);
        expectWithinAbsoluteError (result.notes[0].end, 0.5, 1.0e-6);
        expectEquals (result.notes[0].velocity, 78);
        expectEquals (result.notes[0].instrument, juce::String ("electric_bass"));

        expectEquals (result.notes[1].pitch, 45);
        expectWithinAbsoluteError (result.notes[1].start, 1.0, 1.0e-6);
        expectWithinAbsoluteError (result.notes[1].end, 1.5, 1.0e-6);

        beginTest ("a tempo change moves the notes after it");
        {
            juce::MidiFile changing;
            changing.setTicksPerQuarterNote (480);

            juce::MidiMessageSequence tempi;
            tempi.addEvent (juce::MidiMessage::tempoMetaEvent (500000), 0.0);     // 120 BPM
            tempi.addEvent (juce::MidiMessage::tempoMetaEvent (250000), 480.0);   // 240 BPM at 0.5 s
            changing.addTrack (tempi);

            juce::MidiMessageSequence notes;
            notes.addEvent (juce::MidiMessage::noteOn (1, 60, (juce::uint8) 90), 480.0);
            notes.addEvent (juce::MidiMessage::noteOff (1, 60), 960.0);
            changing.addTrack (notes);

            juce::MemoryOutputStream bytes;
            expect (changing.writeTo (bytes));

            juce::MemoryInputStream stream (bytes.getData(), bytes.getDataSize(), false);
            const auto read = SidecarMidi::read (stream);

            expectEquals ((int) read.notes.size(), 1);
            expectWithinAbsoluteError (read.notes[0].start, 0.5, 1.0e-6);
            // A quarter note at 240 BPM is a quarter of a second, not half.
            expectWithinAbsoluteError (read.notes[0].end, 0.75, 1.0e-6);
        }

        beginTest ("rubbish is refused rather than read as an empty take");
        {
            juce::MemoryInputStream nonsense ("this is not a MIDI file", 23, false);
            const auto read = SidecarMidi::read (nonsense);
            expect (read.error.isNotEmpty());
            expect (read.notes.empty());
        }

        //-- the real engine's own output ---------------------------------------
        //
        // Committed from a real bass_v2 run so the reader is tested against what
        // the engine actually writes, not only against what JUCE writes.
        const juce::File fixture (juce::String (RIFFSHEET_TEST_DIR) + "/SidecarMidiFixture.mid");

        beginTest ("a MIDI file written by the real engine reads as notes");

        if (! fixture.existsAsFile())
        {
            logMessage ("  no fixture at " + fixture.getFullPathName() + " - skipping");
            expect (true);
            return;
        }

        const auto real = SidecarMidi::read (fixture);

        expect (real.error.isEmpty(), real.error);
        expect (! real.notes.empty(), "the fixture should contain notes");

        for (const auto& note : real.notes)
        {
            expect (note.end > note.start, "every note must end after it starts");
            expect (note.pitch >= 21 && note.pitch <= 108, "pitch " + juce::String (note.pitch));
            expect (note.velocity > 0 && note.velocity <= 127);
        }

        for (size_t i = 1; i < real.notes.size(); ++i)
            expect (real.notes[i].start >= real.notes[i - 1].start, "notes must come back in order");

        logMessage ("  " + juce::String ((int) real.notes.size()) + " notes, "
                    + juce::String (real.notes.front().start, 3) + " s to "
                    + juce::String (real.notes.back().end, 3) + " s");
    }

    //== "I already have this one" =============================================
    //
    // The validator behind NativeBridge::fnValidateExistingEngineInstall, driven
    // against real directories on disk rather than a fake filesystem, because
    // what it does IS stat files and a fake would only prove that our idea of a
    // directory matches our idea of a directory.
    //
    // Nothing here executes anything, which is the property worth protecting:
    // running a stranger's script to see whether it is installed is a bigger
    // promise than this call makes, and on a broken venv it hangs.
    void runExistingInstallTests()
    {
        const auto* repoRow = EngineCatalog::find ("bass-v2");
        const auto* cliRow = EngineCatalog::find ("transkun");
        const auto* bundledRow = EngineCatalog::find (EngineCatalog::fallbackId());

        beginTest ("the two one-click engines are still shaped the way the validator assumes");
        {
            expect (repoRow != nullptr && cliRow != nullptr && bundledRow != nullptr);

            if (repoRow == nullptr || cliRow == nullptr || bundledRow == nullptr)
                return;

            expect (repoRow->adapter == AdapterKind::sidecarVenv,
                    "bass-v2 is validated as a repository checkout");
            expect (cliRow->adapter == AdapterKind::sidecarPipCli,
                    "transkun is validated as a pip console script");
        }

        if (repoRow == nullptr || cliRow == nullptr)
            return;

        const auto root = scratch().getChildFile ("existing");
        root.deleteRecursively();
        root.createDirectory();

        beginTest ("a repo engine needs BOTH its code and its weights");
        {
            const auto justCode = root.getChildFile ("code-only");
            justCode.createDirectory();
            justCode.getChildFile ("infer.py").replaceWithText ("# nothing here yet\n");

            juce::StringArray searched;
            juce::String detail;
            expect (EngineInstaller::findExistingInstall (*repoRow, justCode.getFullPathName(),
                                                          searched, detail) == juce::File(),
                    "a checkout with no weights is the commonest half-install there is");
            expect (detail.containsIgnoreCase ("checkpoint"),
                    "the useful half of a failed check is knowing what was missing: " + detail);
            expect (searched.contains (justCode.getFullPathName()),
                    "every path looked at comes back, in order");

            // ...and an EMPTY checkpoints folder is still no weights.
            justCode.getChildFile ("checkpoints").createDirectory();
            searched.clear();
            detail.clear();
            expect (EngineInstaller::findExistingInstall (*repoRow, justCode.getFullPathName(),
                                                          searched, detail) == juce::File(),
                    "an empty checkpoints folder must not read as installed");
        }

        beginTest ("a complete repo checkout validates, and says where");
        {
            const auto good = root.getChildFile ("bass-repo");
            good.createDirectory();
            good.getChildFile ("infer.py").replaceWithText ("# the entry point\n");
            good.getChildFile ("checkpoints").createDirectory();
            good.getChildFile ("checkpoints").getChildFile ("model.ckpt").replaceWithText ("weights");

            juce::StringArray searched;
            juce::String detail;
            const auto found = EngineInstaller::findExistingInstall (*repoRow, good.getFullPathName(),
                                                                     searched, detail);

            expectEquals (found.getFullPathName(), good.getFullPathName());
            expect (detail.containsIgnoreCase (good.getFullPathName()),
                    "the sentence has to name the place: " + detail);
        }

        beginTest ("a repo one folder down is found, because that is how a zip unpacks");
        {
            const auto outer = root.getChildFile ("downloaded");
            const auto inner = outer.getChildFile ("instrument-agnostic-amt-2964b39");
            inner.createDirectory();
            inner.getChildFile ("infer.py").replaceWithText ("# the entry point\n");
            inner.getChildFile ("checkpoints").createDirectory();
            inner.getChildFile ("checkpoints").getChildFile ("a.ckpt").replaceWithText ("weights");

            juce::StringArray searched;
            juce::String detail;
            expectEquals (EngineInstaller::findExistingInstall (*repoRow, outer.getFullPathName(),
                                                                searched, detail)
                              .getFullPathName(),
                          inner.getFullPathName());
        }

        beginTest ("a console-script engine validates a venv, and answers with the environment");
        {
            // The answer has to be what SidecarAdapter::installDirectory() is,
            // not the executable - handing back the program would make the two
            // disagree and the engine would be "found" and then unrunnable.
            const auto venv = root.getChildFile ("transkun-venv");
            const auto bin = venv.getChildFile (
               #if JUCE_WINDOWS
                "Scripts"
               #else
                "bin"
               #endif
            );
            bin.createDirectory();

            const auto exe = bin.getChildFile (
               #if JUCE_WINDOWS
                "transkun.exe"
               #else
                "transkun"
               #endif
            );
            exe.replaceWithText ("#!/bin/sh\n");

            juce::StringArray searched;
            juce::String detail;
            expectEquals (EngineInstaller::findExistingInstall (*cliRow, venv.getFullPathName(),
                                                                searched, detail)
                              .getFullPathName(),
                          venv.getFullPathName());

            // Pointing straight AT the program is what `which` printed, so it
            // has to work too, and answer with the same environment.
            searched.clear();
            detail.clear();
            expectEquals (EngineInstaller::findExistingInstall (*cliRow, exe.getFullPathName(),
                                                                searched, detail)
                              .getFullPathName(),
                          venv.getFullPathName());
        }

        beginTest ("a folder with no engine in it is refused, and says what was looked for");
        {
            const auto empty = root.getChildFile ("nothing-here");
            empty.createDirectory();

            juce::StringArray searched;
            juce::String detail;
            expect (EngineInstaller::findExistingInstall (*cliRow, empty.getFullPathName(),
                                                          searched, detail) == juce::File());
            expect (detail.containsIgnoreCase ("transkun"), detail);
            expect (! searched.isEmpty());

            searched.clear();
            detail.clear();
            const auto missing = root.getChildFile ("not-even-there");
            expect (EngineInstaller::findExistingInstall (*cliRow, missing.getFullPathName(),
                                                          searched, detail) == juce::File());
            expect (detail.containsIgnoreCase (missing.getFullPathName()), detail);
        }

        beginTest ("a sniff with no path looks in several places and reports every one");
        {
            juce::StringArray searched;
            juce::String detail;
            EngineInstaller::findExistingInstall (*repoRow, "", searched, detail);

            expect (searched.size() >= 2, "a sniff that looks in one place is not a sniff");
            expect (searched.contains (EngineInstaller::engineDirectory (repoRow->id).getFullPathName()),
                    "Riffsheet's own layout is the first place to look");

            juce::StringArray unique;

            for (const auto& one : searched)
            {
                expect (! unique.contains (one), "a path was searched twice: " + one);
                unique.add (one);
            }
        }

        beginTest ("a validated location is remembered, and can be forgotten");
        {
            const auto where = root.getChildFile ("bass-repo");

            EngineInstaller::rememberInstallLocation (repoRow->id, where);
            expectEquals (EngineInstaller::recordedLocation (repoRow->id).getFullPathName(),
                          where.getFullPathName());

            EngineInstaller::rememberInstallLocation (repoRow->id, juce::File());
            expect (EngineInstaller::recordedLocation (repoRow->id) == juce::File(),
                    "forgetting has to actually forget");

            // A remembered folder that has since been deleted reads as absent
            // rather than as a path that no longer exists.
            const auto gone = root.getChildFile ("deleted-later");
            gone.createDirectory();
            EngineInstaller::rememberInstallLocation (repoRow->id, gone);
            gone.deleteRecursively();
            expect (EngineInstaller::recordedLocation (repoRow->id) == juce::File());
            EngineInstaller::rememberInstallLocation (repoRow->id, juce::File());
        }

        root.deleteRecursively();
    }

    //== a scratch directory this test owns ====================================
    juce::File scratch()
    {
        const auto directory = juce::File::getSpecialLocation (juce::File::tempDirectory)
                                   .getChildFile ("riffsheet-installer-tests");
        directory.createDirectory();
        return directory;
    }
};

static EngineInstallerTests engineInstallerTests;

//==============================================================================
/**
    The live install, on this machine, through the production code path.

    IT IS OFF UNLESS ASKED FOR. `RIFFSHEET_LIVE_PHASE` selects one phase and
    nothing runs without it, because this downloads 113 MB of checkpoints and
    builds a virtual environment with torch in it - which is a thing to do
    deliberately, once, not a thing for `ctest` to do on every push.

    WHY IT IS A TEST AND NOT A SHELL SCRIPT. A script would have to reimplement
    the install to run it, and would then be proving the script. This drives
    EngineInstaller::install() and SidecarAdapter::transcribe() - the same
    functions the plugin calls, with the same arguments - so what it proves is
    the code that ships.

        RIFFSHEET_LIVE_PHASE=install    RiffsheetTests EngineInstallLive
        RIFFSHEET_LIVE_PHASE=transcribe RIFFSHEET_LIVE_AUDIO=/path/to.wav ...
        RIFFSHEET_LIVE_PHASE=uninstall  ...
    with RIFFSHEET_LIVE_ENGINE naming the engine (default "bass-v2").
*/
class EngineInstallLiveTests final : public juce::UnitTest
{
public:
    EngineInstallLiveTests() : juce::UnitTest ("EngineInstallLive", "EngineInstallLive") {}

    void runTest() override
    {
        const auto phase = juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_LIVE_PHASE", {});

        if (phase.isEmpty())
            return;

        const auto id = juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_LIVE_ENGINE", "bass-v2");
        const auto* manifest = EngineCatalog::find (id);

        if (manifest == nullptr)
        {
            expect (false, "no engine called \"" + id + "\"");
            return;
        }

        if (phase == "install")     doInstall (*manifest);
        else if (phase == "transcribe") doTranscribe (*manifest);
        else if (phase == "uninstall")  doUninstall (*manifest);
        else expect (false, "unknown RIFFSHEET_LIVE_PHASE \"" + phase + "\"");
    }

private:
    void doInstall (const EngineManifest& manifest)
    {
        beginTest (juce::String ("live install: ") + manifest.name);

        const auto startedMs = juce::Time::getMillisecondCounterHiRes();
        juce::String lastStage;
        int frames = 0;

        EngineInstaller::Callbacks callbacks;

        callbacks.onProgress = [&] (const EngineInstall::Progress& progress)
        {
            ++frames;

            const auto stage = juce::String (EngineInstall::stageName (progress.stage));

            // Every field the bridge event carries, checked here rather than
            // eyeballed in a log: a NaN fraction or a negative byte count would
            // draw a broken progress bar and nothing else would notice.
            expect (progress.receivedBytes >= 0);
            expect (progress.totalBytes >= 0);
            expect (progress.fraction >= 0.0 && progress.fraction <= 1.0,
                    "fraction " + juce::String (progress.fraction));
            expect (progress.bytesPerSec >= 0.0);
            expect (progress.receivedBytes <= progress.totalBytes || progress.totalBytes == 0);

            const auto seconds = (juce::Time::getMillisecondCounterHiRes() - startedMs) / 1000.0;

            if (stage != lastStage || frames % 40 == 0)
            {
                lastStage = stage;
                logMessage ("  [" + juce::String (seconds, 1) + "s] " + stage + " "
                            + juce::String (progress.receivedBytes / 1048576.0, 1) + "/"
                            + juce::String (progress.totalBytes / 1048576.0, 1) + " MB  "
                            + juce::String (progress.bytesPerSec / 1048576.0, 1) + " MB/s  "
                            + (progress.etaSec >= 0 ? juce::String (progress.etaSec, 0) + "s left  " : "")
                            + progress.message);
            }
        };

        const auto result = EngineInstaller::install (manifest, callbacks);

        logMessage ("  " + juce::String (frames) + " progress frames in "
                    + juce::String (result.elapsedMs / 1000.0, 1) + " s");

        if (! result.ok)
        {
            for (const auto& step : result.guideSteps)
                logMessage ("  guide: " + step);

            expect (false, "install failed: " + result.error);
            return;
        }

        logMessage ("  installed " + juce::String (result.bytesOnDisk / 1048576.0, 1)
                    + " MB at " + result.location);
        logMessage ("  approxDiskBytes in the manifest says "
                    + juce::String (manifest.approxDiskBytes / 1048576.0, 1) + " MB");

        expect (result.bytesOnDisk > 0);
        expect (frames > 0, "an install must report progress");
        expect (EngineInstaller::engineDirectory (manifest.id).isDirectory());
        expect (! EngineInstaller::incomingDirectory (manifest.id).exists(),
                "the staging directory must not survive a successful install");
    }

    void doTranscribe (const EngineManifest& manifest)
    {
        const auto path = juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_LIVE_AUDIO", {});
        const juce::File audio (path);

        beginTest (juce::String ("live transcription through ") + manifest.name);

        if (! audio.existsAsFile())
        {
            expect (false, "RIFFSHEET_LIVE_AUDIO does not name a file: " + path);
            return;
        }

        SidecarAdapter adapter (manifest);
        adapter.rediscover();

        const auto before = adapter.status();
        logMessage ("  status before: " + EngineRegistry_stateName (before.availability)
                    + " at " + before.location);

        juce::String error;
        auto progressCalls = 0;

        EngineAdapter::Callbacks callbacks;
        callbacks.onProgress = [&progressCalls] (int, int) { ++progressCalls; };

        const auto startedMs = juce::Time::getMillisecondCounterHiRes();

        expect (adapter.prepare ([this] (const juce::String& message) { logMessage ("  " + message); },
                                 [] { return false; }),
                "prepare failed: " + adapter.status().error);

        EngineAdapter::AudioInput input;
        input.file = audio;

        const auto payload = adapter.transcribe (input, {}, callbacks, error);
        const auto elapsedSec = (juce::Time::getMillisecondCounterHiRes() - startedMs) / 1000.0;

        adapter.endOfJob();

        expect (error.isEmpty(), "transcribe failed: " + error);

        const auto* object = payload.getDynamicObject();
        expect (object != nullptr, "no payload came back");

        if (object == nullptr)
            return;

        const auto* notes = object->getProperty ("notes").getArray();
        expect (notes != nullptr);

        if (notes == nullptr)
            return;

        auto lowest = 128, highest = -1;
        auto lastStart = -1.0;

        for (const auto& item : *notes)
        {
            const auto* note = item.getDynamicObject();
            expect (note != nullptr);

            if (note == nullptr)
                continue;

            const auto pitch = (int) note->getProperty ("pitch");
            const auto start = (double) note->getProperty ("start");
            const auto end = (double) note->getProperty ("end");

            expect (end > start, "note " + juce::String (pitch) + " ends before it starts");
            expect (pitch >= 0 && pitch <= 127);
            expect (start >= lastStart - 1.0e-9, "notes must arrive in time order");

            lastStart = start;
            lowest = juce::jmin (lowest, pitch);
            highest = juce::jmax (highest, pitch);
        }

        const auto midiBase64 = object->getProperty ("midiBase64").toString();

        logMessage ("  " + juce::String (notes->size()) + " notes, pitches "
                    + juce::String (lowest) + "-" + juce::String (highest)
                    + ", " + juce::String (elapsedSec, 2) + " s wall clock, "
                    + juce::String (midiBase64.length()) + " base64 chars of MIDI");
        logMessage ("  progress callbacks: " + juce::String (progressCalls));

        expect (notes->size() > 0, "a real take should produce notes");
        expect (midiBase64.isNotEmpty(), "the engine's own MIDI should come back");
        expect (object->getProperty ("beatGrid").isVoid(),
                "a sidecar engine reports no beat grid");
        expect ((double) object->getProperty ("onsetDelay") == 0.0);
        expect (! (bool) object->getProperty ("truncated"));

        // The one-job rule, observed rather than asserted from the design: the
        // process is gone by the time transcribe() has returned.
        const auto binary = juce::File (before.location).getFileName();
        juce::ChildProcess counter;

        if (counter.start ("/usr/bin/pgrep -f " + juce::String (manifest.id)))
        {
            const auto running = counter.readAllProcessOutput().trim();
            logMessage ("  processes matching \"" + juce::String (manifest.id) + "\" after the job: "
                        + (running.isEmpty() ? juce::String ("none") : running));
        }

        juce::ignoreUnused (binary);
    }

    void doUninstall (const EngineManifest& manifest)
    {
        beginTest (juce::String ("live uninstall: ") + manifest.name);

        const auto before = EngineInstaller::bytesOnDisk (EngineInstaller::engineDirectory (manifest.id));
        const auto result = EngineInstaller::uninstall (manifest);

        logMessage ("  freed " + juce::String (result.bytesOnDisk) + " bytes ("
                    + juce::String (result.bytesOnDisk / 1048576.0, 1) + " MB); the engine folder "
                    + "held " + juce::String (before / 1048576.0, 1) + " MB");

        expect (result.ok, result.error);
        expect (result.bytesOnDisk >= before);
        expect (! EngineInstaller::engineDirectory (manifest.id).exists());
    }

    /** EngineRegistry is not linked into this binary's live half, and one line
        of spelling is cheaper than pulling it in. */
    static juce::String EngineRegistry_stateName (EngineAdapter::Availability availability)
    {
        switch (availability)
        {
            case EngineAdapter::Availability::ready:        return "ready";
            case EngineAdapter::Availability::installed:    return "installed";
            case EngineAdapter::Availability::notInstalled: return "not-installed";
            case EngineAdapter::Availability::broken:       return "broken";
        }

        return "unknown";
    }
};

static EngineInstallLiveTests engineInstallLiveTests;
