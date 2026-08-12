#include "EngineInstaller.h"
#include "EngineCatalog.h"
#include "SystemProbe.h"
#include "sidecar/ProcessOutputReader.h"
#include <BinaryData.h>
#include <map>
#include <mutex>

/*
    The installer, end to end.

    Read the header first: it says what is pinned and what is refused. This file
    is the mechanism, and the two parts of it worth knowing before reading are:

      1. NOTHING IS INSTALLED UNTIL EVERYTHING WORKED. Every byte lands under
         <appSupport>/engines/<id>.incoming/ - downloads, the unpacked source,
         the virtual environment, the probe's own output - and the last thing
         install() does is move that directory onto <id>/. A power cut in the
         middle leaves the previous install, or nothing. There is deliberately no
         state that means "half installed", because status() would have to have
         an opinion about it and every opinion available is wrong.

      2. THE PROBE IS A REAL RUN. The install ends by transcribing a generated
         one-second tone with the engine that was just installed and requiring
         notes-or-a-clean-empty-answer out of it. "The files are on disk" is a
         claim about the disk; the user's question is whether this thing works on
         this machine, and torch on macOS answers that question at import time
         about half the time it is going to answer it at all.
*/

namespace
{
    constexpr int    kMaxRedirects        = 5;
    constexpr int    kConnectTimeoutMs    = 30000;
    constexpr int    kDownloadAttempts    = 3;
    constexpr int    kProgressIntervalMs  = 200;    // 5 Hz, matching the bridge's gate
    constexpr int    kReadChunkBytes      = 64 * 1024;
    constexpr int    kVenvTimeoutMs       = 5 * 60 * 1000;
    constexpr int    kPipTimeoutMs        = 45 * 60 * 1000;
    constexpr int    kProbeTimeoutMs      = 10 * 60 * 1000;
    constexpr int    kPythonProbeTimeoutMs = 15000;

    juce::String hostOf (const juce::String& url)
    {
        auto rest = url.fromFirstOccurrenceOf ("://", false, false);
        return rest.upToFirstOccurrenceOf ("/", false, false)
                   .upToFirstOccurrenceOf ("?", false, false)
                   .upToFirstOccurrenceOf ("#", false, false)
                   .fromLastOccurrenceOf ("@", false, false)   // strip any userinfo
                   .upToFirstOccurrenceOf (":", false, false)  // strip any port
                   .toLowerCase();
    }

    /**  The bytes of a committed resource, looked up by the name it has on disk.

         NOT by the generated symbol. juce_add_binary_data mangles a filename
         into a C++ identifier by turning dots into underscores and DELETING
         everything else that is not alphanumeric - so
         `bass-v2-requirements-macos-arm64.txt` becomes
         `bassv2requirementsmacosarm64_txt`, which is not a rule anybody should
         be reimplementing here. JUCE also emits `originalFilenames`, parallel to
         `namedResourceList`, so the original name is the key that cannot drift.
         (This was a real bug, caught by the install probe: the mangling was
         guessed as "everything becomes an underscore" and the lookup silently
         missed.) */
    const char* binaryResource (const juce::String& filename, int& size)
    {
        for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
            if (filename == BinaryData::originalFilenames[i])
                return BinaryData::getNamedResource (BinaryData::namedResourceList[i], size);

        return nullptr;
    }

    bool writeBinaryResource (const juce::String& filename, const juce::File& destination,
                              juce::String& error)
    {
        int size = 0;

        if (const auto* data = binaryResource (filename, size))
        {
            destination.getParentDirectory().createDirectory();

            if (destination.replaceWithData (data, (size_t) size))
                return true;

            error = "Could not write " + destination.getFullPathName();
            return false;
        }

        error = "This build does not contain " + filename + ", which the installer needs.";
        return false;
    }

    /** "macos-arm64". Compiled per slice, so a universal build answers correctly
        in each of its two halves rather than once for both. */
    juce::String platformTag()
    {
       #if JUCE_MAC
        #if defined (__aarch64__) || defined (__arm64__)
         return "macos-arm64";
        #else
         return "macos-x86_64";
        #endif
       #elif JUCE_WINDOWS
        return "windows-x86_64";
       #elif JUCE_LINUX
        return "linux-x86_64";
       #else
        return {};
       #endif
    }

    juce::String venvBinary (const juce::File& venv, const juce::String& name)
    {
       #if JUCE_WINDOWS
        return venv.getChildFile ("Scripts").getChildFile (name + ".exe").getFullPathName();
       #else
        return venv.getChildFile ("bin").getChildFile (name).getFullPathName();
       #endif
    }

    //== version comparison ====================================================

    struct Version
    {
        int major = 0, minor = 0, patch = 0;

        bool operator< (const Version& other) const noexcept
        {
            if (major != other.major) return major < other.major;
            if (minor != other.minor) return minor < other.minor;
            return patch < other.patch;
        }
    };

    Version parseVersion (const juce::String& text)
    {
        auto parts = juce::StringArray::fromTokens (text.trim(), ".", "");
        Version version;
        version.major = parts.size() > 0 ? parts[0].getIntValue() : 0;
        version.minor = parts.size() > 1 ? parts[1].getIntValue() : 0;
        version.patch = parts.size() > 2 ? parts[2].getIntValue() : 0;
        return version;
    }

    /** Understands the two forms the manifest uses: ">=3.10" and "<3.13",
        comma-separated. Anything it does not understand is ignored rather than
        silently treated as a refusal - a requirement string this cannot read is
        a bug here, not a reason to tell the user their Python is wrong. */
    bool versionSatisfies (const Version& version, const juce::String& requirement)
    {
        for (const auto& clause : juce::StringArray::fromTokens (requirement, ",", ""))
        {
            const auto trimmed = clause.trim();

            if (trimmed.startsWith (">="))
            {
                if (version < parseVersion (trimmed.substring (2)))
                    return false;
            }
            else if (trimmed.startsWith ("<"))
            {
                const auto maximum = parseVersion (trimmed.substring (1));

                if (! (version < maximum))
                    return false;
            }
        }

        return true;
    }

    //== child processes =======================================================

    struct ProcessOutcome
    {
        bool ok = false;
        bool cancelled = false;
        bool timedOut = false;
        int  exitCode = -1;
        juce::String output;
    };

    /**  Runs a child, streaming its output to `onChunk` and polling cancel.

         The reader is on its own thread for the reason ProcessOutputReader
         documents: readProcessOutput() blocks until the child says something,
         and a pip resolving torch says nothing for a long time. */
    ProcessOutcome runProcess (const juce::StringArray& argv, int timeoutMs,
                               std::function<bool()> shouldCancel,
                               std::function<void (const juce::String&)> onTick,
                               const juce::File& workingDirectory = {})
    {
        ProcessOutcome outcome;

        juce::ChildProcess child;

        // JUCE has no working-directory argument, and the AMT entry point must
        // run from its own tree so relative imports resolve. Changing the
        // process-wide cwd is not acceptable inside a DAW, so the caller passes
        // an absolute script path and the script chdir()s itself; this parameter
        // stays for the one platform case where that is not enough.
        juce::ignoreUnused (workingDirectory);

        if (! child.start (argv, juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr))
        {
            outcome.output = "could not start " + argv[0];
            return outcome;
        }

        ProcessOutputReader reader (child);
        reader.start();

        const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) timeoutMs;

        for (;;)
        {
            if (! child.isRunning())
                break;

            if (shouldCancel != nullptr && shouldCancel())
            {
                child.kill();
                outcome.cancelled = true;
                break;
            }

            if (juce::Time::getMillisecondCounter() > deadline)
            {
                child.kill();
                outcome.timedOut = true;
                break;
            }

            if (onTick != nullptr)
                onTick ({});

            juce::Thread::sleep (100);
        }

        child.waitForProcessToFinish (5000);
        outcome.output = reader.finishAfterProcessExit();
        outcome.exitCode = (int) child.getExitCode();
        outcome.ok = ! outcome.cancelled && ! outcome.timedOut && outcome.exitCode == 0;
        return outcome;
    }

    /** The tail of a process's output, for an error sentence that has to fit on
        a card. */
    juce::String lastLines (const juce::String& output, int count)
    {
        auto lines = juce::StringArray::fromLines (output.trim());

        while (lines.size() > count)
            lines.remove (0);

        lines.removeEmptyStrings();
        return lines.joinIntoString (" / ");
    }
}

//==============================================================================
namespace EngineInstall
{
    const char* stageName (Stage stage) noexcept
    {
        switch (stage)
        {
            case Stage::checking:    return "checking";
            case Stage::downloading: return "downloading";
            case Stage::verifying:   return "verifying";
            case Stage::extracting:  return "extracting";
            case Stage::installing:  return "installing";
            case Stage::probing:     return "probing";
        }

        return "checking";
    }

    HostPolicy HostPolicy::shipped()
    {
        HostPolicy policy;
        policy.requireHttps = true;

        // Every host any pinned asset resolves to, and nothing else. GitHub's
        // /archive/ URL redirects to codeload; Hugging Face's /resolve/ URL
        // redirects to a regional CDN under hf.co, which is why that one entry
        // is a suffix (see HostPolicy's documentation).
        policy.hosts = { "github.com",
                         "codeload.github.com",
                         "objects.githubusercontent.com",
                         "release-assets.githubusercontent.com",
                         "raw.githubusercontent.com",
                         "huggingface.co",
                         ".hf.co",
                         "pypi.org",
                         "files.pythonhosted.org" };

        return policy;
    }

    bool HostPolicy::allowsHost (const juce::String& host) const
    {
        const auto lower = host.toLowerCase();

        if (lower.isEmpty())
            return false;

        for (const auto& entry : hosts)
        {
            if (entry.startsWithChar ('.'))
            {
                // ".hf.co" matches "us.aws.cdn.hf.co" and never "nothf.co", and
                // never "hf.co.example.com" either, because the match is on the
                // END of the host.
                if (lower.endsWith (entry))
                    return true;
            }
            else if (lower == entry)
            {
                return true;
            }
        }

        return false;
    }

    bool HostPolicy::allows (const juce::String& url, juce::String& error) const
    {
        if (requireHttps && ! url.startsWithIgnoreCase ("https://"))
        {
            error = "refused a download that is not https: " + url;
            return false;
        }

        const auto host = hostOf (url);

        if (! allowsHost (host))
        {
            error = "refused a download from " + (host.isEmpty() ? juce::String ("an unreadable host")
                                                                 : host)
                  + ", which is not one of the hosts Riffsheet is allowed to fetch engines from";
            return false;
        }

        return true;
    }

    juce::int64 Plan::totalDownloadBytes() const noexcept
    {
        juce::int64 total = 0;

        for (const auto& asset : assets)
            total += asset.bytes;

        return total;
    }

    /*
        THE PINNED ASSETS.

        Every digest below was taken from the file on this machine and then
        re-verified against a fresh ranged fetch, because a download that
        silently truncates is exactly the failure this whole file exists to
        catch - it happened once during the audition and the file looked fine.

        instrument-agnostic-amt is pinned at commit
        2964b39af3d122ab087010e562ead53005c57e5d, fetched as GitHub's own zip of
        that tree. GitHub generates that archive on demand; its bytes have been
        stable across fetches here and upstream commits to keeping them stable,
        but if it ever changes this pin fails loudly (which is the correct
        failure) rather than installing something else.

        The checkpoints are pinned at Hugging Face revision
        2be1b9eb21c9b61163c773bd8361e299c60cfcad rather than `main`, so a new
        upload upstream cannot change what a build installs.
    */
    Plan planFor (const EngineManifest& engine, juce::String& error)
    {
        Plan plan;
        plan.engineId = engine.id;
        plan.pythonRequirement = engine.pythonRequirement;
        plan.approxDiskBytes = engine.approxDiskBytes;

        if (engine.install != InstallKind::oneClick)
        {
            error = manifestText (engine.name) + " is not a one-click engine.";
            return {};
        }

        const auto platform = platformTag();

        if (platform.isEmpty())
        {
            error = "Riffsheet has no one-click install for this platform yet.";
            return {};
        }

        plan.requirementsName = manifestText (engine.id) + "-requirements-" + platform + ".txt";

        int requirementsSize = 0;

        if (binaryResource (plan.requirementsName, requirementsSize) == nullptr)
        {
            // Honest, and the card turns into the guide rather than a dead end.
            error = "Riffsheet has no verified package list for " + manifestText (engine.name)
                  + " on " + platform + " yet, so it cannot install it for you here.";
            return {};
        }

        plan.requirementsResource = plan.requirementsName;

        if (manifestText (engine.id) == "bass-v2")
        {
            plan.scriptName = "amt_sidecar.py";
            plan.scriptResource = plan.scriptName;

            plan.assets.push_back ({ engine.download.url,
                                     engine.download.sha256,
                                     engine.download.bytes,
                                     engine.download.archive,
                                     "repo" });

            plan.assets.push_back ({ "https://huggingface.co/anime-song/instrument_agnostic_amt/resolve/"
                                     "2be1b9eb21c9b61163c773bd8361e299c60cfcad/best_model_bass_v2.pth",
                                     "807eedb409c77a710357d57c9e47d17821c4518db3b09c78d8dabd205a2b604a",
                                     57169753, ArchiveKind::singleFile,
                                     "checkpoints/best_model_bass_v2.pth" });

            plan.assets.push_back ({ "https://huggingface.co/anime-song/instrument_agnostic_amt/resolve/"
                                     "2be1b9eb21c9b61163c773bd8361e299c60cfcad/best_model.pth",
                                     "ef752daf323314b9c36d8f7a41089661734627d3437aefbee211e7d130c3c80d",
                                     56066197, ArchiveKind::singleFile,
                                     "checkpoints/best_model.pth" });
        }
        else if (manifestText (engine.id) == "transkun")
        {
            // Nothing to download: the weights are inside the wheel, and the
            // wheel is hash-pinned in the requirements file like everything else.
            plan.consoleScript = "transkun";
        }
        else
        {
            error = "Riffsheet does not know how to install \"" + manifestText (engine.id) + "\".";
            return {};
        }

        // The same audit the catalog runs, applied to every asset rather than
        // only to the manifest's primary one.
        const auto policy = HostPolicy::shipped();

        for (const auto& asset : plan.assets)
        {
            juce::String reason;

            if (! policy.allows (asset.url, reason))
            {
                error = "engine \"" + plan.engineId + "\": " + reason;
                return {};
            }

            if (asset.sha256.length() != 64 || ! asset.sha256.containsOnly ("0123456789abcdef"))
            {
                error = "engine \"" + plan.engineId + "\": an asset is not pinned by sha256.";
                return {};
            }

            if (asset.bytes <= 0)
            {
                error = "engine \"" + plan.engineId + "\": an asset has no pinned size.";
                return {};
            }
        }

        return plan;
    }
}

//==============================================================================
juce::File EngineInstaller::enginesRoot()
{
    return SystemProbe::appSupportDirectory().getChildFile ("engines");
}

juce::File EngineInstaller::engineDirectory (const juce::String& id)
{
    return enginesRoot().getChildFile (id);
}

juce::File EngineInstaller::newIncomingDirectory (const juce::String& id)
{
    return enginesRoot().getChildFile (id + ".incoming-" + juce::Uuid().toDashedString());
}

juce::File EngineInstaller::newPreviousDirectory (const juce::String& id)
{
    return enginesRoot().getChildFile (id + ".previous-" + juce::Uuid().toDashedString());
}

int EngineInstaller::sweepStaleStaging (const juce::String& id, const juce::File& keep)
{
    const auto root = enginesRoot();

    if (! root.isDirectory())
        return 0;

    int removed = 0;

    // Two passes' worth of wildcard in one iterator. findDirectories only: a
    // FILE called `<id>.incoming-...` is not something this code made, and
    // deleting things we did not create is how a cleanup becomes an incident.
    for (const auto& item : juce::RangedDirectoryIterator (root, false, id + ".incoming-*;" + id + ".previous-*",
                                                           juce::File::findDirectories))
    {
        const auto directory = item.getFile();

        if (directory == keep)
            continue;

        if (directory.deleteRecursively())
            ++removed;
    }

    return removed;
}

juce::File EngineInstaller::downloadsDirectory (const juce::String& id)
{
    return enginesRoot().getChildFile (".downloads").getChildFile (id);
}

//==============================================================================
namespace
{
    /*  The in-process half of ScopedInstallLock - see the header for why one
        lock is not enough. One mutex per engine id, created on first use and
        never destroyed: there are a handful of engine ids in the whole
        application, and a map that erased entries would need its own lock held
        across the try, which is the thing being built here. */
    std::mutex& installMutexFor (const juce::String& id)
    {
        static std::mutex mapLock;
        static std::map<juce::String, std::unique_ptr<std::mutex>> mutexes;

        const std::lock_guard<std::mutex> guard (mapLock);
        auto& slot = mutexes[id];

        if (slot == nullptr)
            slot = std::make_unique<std::mutex>();

        return *slot;
    }

    /*  A lock file name that is legal on every platform and cannot collide with
        another application's. Engine ids are already `[a-z0-9-]`, but a manifest
        is data and this is a filesystem path. */
    juce::String installLockName (const juce::String& id)
    {
        return "riffsheet-engine-install-" + id.retainCharacters ("abcdefghijklmnopqrstuvwxyz"
                                                                  "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_");
    }
}

EngineInstaller::ScopedInstallLock::ScopedInstallLock (const juce::String& engineId)
    : id (engineId)
{
    // In-process first, and non-blocking. It is the cheaper test and the one
    // that actually fires: two plugin instances in one DAW is the common case,
    // and it is precisely the case an fcntl lock cannot see.
    if (! installMutexFor (id).try_lock())
        return;

    inProcess = true;

    // Then the machine. timeOutMillisecs = 0 means "try once and tell me" -
    // enter() returns false when another process holds it, because JUCE drops
    // the file handle on a failed lock and reports that as a failed enter.
    across = std::make_unique<juce::InterProcessLock> (installLockName (id));

    if (! across->enter (0))
    {
        across.reset();
        installMutexFor (id).unlock();
        inProcess = false;
        return;
    }

    held = true;
}

EngineInstaller::ScopedInstallLock::~ScopedInstallLock()
{
    if (across != nullptr)
        across->exit();

    if (inProcess)
        installMutexFor (id).unlock();
}

juce::String EngineInstaller::ScopedInstallLock::whoElse() const
{
    return "Another Riffsheet window is already installing or removing this engine. "
           "Wait for it to finish - they share the same folder, and two at once would "
           "leave a half-built engine behind.";
}

juce::int64 EngineInstaller::bytesOnDisk (const juce::File& directory)
{
    if (directory.existsAsFile())
        return directory.getSize();

    if (! directory.isDirectory())
        return 0;

    juce::int64 total = 0;

    for (const auto& item : juce::RangedDirectoryIterator (directory, true, "*",
                                                           juce::File::findFiles))
        total += item.getFile().getSize();

    return total;
}

//==============================================================================
// "I already have this one"
//==============================================================================

namespace
{
    juce::File locationRecordFor (const juce::String& id)
    {
        return EngineInstaller::enginesRoot().getChildFile (id + ".location");
    }

    /*  The executable a pip console-script engine IS, under one directory.

        Two shapes, because both are what people actually have: an environment
        (a folder with bin/ in it - a venv, or a prefix like /usr/local), and a
        folder holding a venv, which is what Riffsheet's own installer builds. A
        path pointing straight AT the executable is handled by the caller. */
    juce::File consoleScriptUnder (const juce::File& directory, const juce::String& name)
    {
       #if JUCE_WINDOWS
        const auto binDir = juce::String ("Scripts");
        const auto exe = name + ".exe";
       #else
        const auto binDir = juce::String ("bin");
        const auto exe = name;
       #endif

        for (const auto& candidate : { directory.getChildFile (binDir).getChildFile (exe),
                                       directory.getChildFile ("venv").getChildFile (binDir).getChildFile (exe) })
            if (candidate.existsAsFile())
                return candidate;

        return {};
    }

    /*  Does this directory hold a checkout of a repo-shaped engine?

        `infer.py` AND a checkpoints folder with something in it. Both, because
        either alone is a real thing people end up with: the repo cloned but the
        weights never downloaded, or a folder of checkpoints with no code. */
    bool repoLooksComplete (const juce::File& directory, juce::String& missing)
    {
        if (! directory.getChildFile ("infer.py").existsAsFile())
        {
            missing = "there is no infer.py in it";
            return false;
        }

        for (const auto& name : { "checkpoints", "checkpoint", "models" })
        {
            const auto dir = directory.getChildFile (name);

            // An EMPTY checkpoints folder is the commonest half-install there
            // is: the repo cloned, the weights never fetched. It must not pass.
            // Recursive, because weights routinely sit one folder deeper.
            if (dir.isDirectory())
            {
                juce::Array<juce::File> weights;
                dir.findChildFiles (weights, juce::File::findFiles, true);

                if (! weights.isEmpty())
                    return true;
            }
        }

        missing = "it has infer.py but no checkpoints folder with any weights in it";
        return false;
    }
}

juce::File EngineInstaller::recordedLocation (const juce::String& id)
{
    const auto record = locationRecordFor (id);

    if (! record.existsAsFile())
        return {};

    const juce::File found (record.loadFileAsString().trim());
    return found.isDirectory() ? found : juce::File();
}

void EngineInstaller::rememberInstallLocation (const juce::String& id, const juce::File& location)
{
    const auto record = locationRecordFor (id);

    if (location == juce::File())
    {
        record.deleteFile();
        return;
    }

    record.getParentDirectory().createDirectory();
    record.replaceWithText (location.getFullPathName());
}

juce::File EngineInstaller::findExistingInstall (const EngineManifest& engine,
                                                 const juce::String& requestedPath,
                                                 juce::StringArray& searched,
                                                 juce::String& detail)
{
    const auto name = manifestText (engine.name);
    const auto pipCli = engine.adapter == AdapterKind::sidecarPipCli;

    // What counts as a working copy at ONE place. Both branches stat and nothing
    // more - see fnValidateExistingEngineInstall for why nothing is executed.
    const auto check = [&engine, pipCli] (const juce::File& where, juce::String& why) -> juce::File
    {
        if (pipCli)
        {
            // The answer is the ENVIRONMENT ROOT - the folder with bin/ in it -
            // because that is what SidecarAdapter::installDirectory() is, and
            // handing back the executable would make the two disagree.
            //
            // A path pointing straight at the console script is the commonest
            // thing somebody pastes, because it is what `which` printed.
            if (where.existsAsFile())
            {
                if (where.getFileNameWithoutExtension() != engine.id)
                {
                    why = "that file is not the " + juce::String (engine.id) + " program";
                    return {};
                }

                return where.getParentDirectory().getParentDirectory();
            }

            const auto found = consoleScriptUnder (where, engine.id);

            if (found == juce::File())
            {
                why = "there is no " + juce::String (engine.id) + " program in it";
                return {};
            }

            return found.getParentDirectory().getParentDirectory();
        }

        if (! where.isDirectory())
        {
            why = "that is not a folder";
            return {};
        }

        juce::String missing;

        if (repoLooksComplete (where, missing))
            return where;

        // One level down, because a downloaded zip usually unpacks into a folder
        // of its own and people point at the folder they unzipped into.
        for (const auto& child : juce::RangedDirectoryIterator (where, false, "*",
                                                                juce::File::findDirectories))
        {
            juce::String ignored;

            if (repoLooksComplete (child.getFile(), ignored))
                return child.getFile();
        }

        why = missing;
        return {};
    };

    // ---- VALIDATE ONE PLACE -------------------------------------------------
    if (requestedPath.isNotEmpty())
    {
        const juce::File where (requestedPath);
        searched.add (where.getFullPathName());

        if (! where.exists())
        {
            detail = "There is nothing at " + where.getFullPathName() + ".";
            return {};
        }

        juce::String why;
        const auto found = check (where, why);

        if (found == juce::File())
        {
            detail = "That is not a working copy of " + name
                   + (why.isNotEmpty() ? " - " + why + "." : ".");
            return {};
        }

        detail = "Found a working copy of " + name + " at " + found.getFullPathName() + ".";
        return found;
    }

    // ---- SNIFF --------------------------------------------------------------
    //
    // Riffsheet's own layout first, because a copy it installed is the one it is
    // surest about, then the places these engines normally end up. PATH is last
    // and only for the console-script engine, since a repo is not on PATH.
    juce::Array<juce::File> candidates;
    candidates.add (engineDirectory (engine.id));

    const auto home = juce::File::getSpecialLocation (juce::File::userHomeDirectory);

    if (pipCli)
    {
        candidates.add (home.getChildFile ("." + juce::String (engine.id)));
        candidates.add (home.getChildFile (juce::String (engine.id)));
        candidates.add (home.getChildFile (".local"));
        candidates.add (juce::File ("/usr/local"));
        candidates.add (juce::File ("/opt/homebrew"));

        // Whatever `which` would answer, without running `which`.
        const auto pathVar = juce::SystemStats::getEnvironmentVariable ("PATH", {});

        for (const auto& entry : juce::StringArray::fromTokens (pathVar, ":", ""))
            if (entry.isNotEmpty())
                candidates.add (juce::File (entry).getParentDirectory());
    }
    else
    {
        candidates.add (home.getChildFile (juce::String (engine.id)));
        candidates.add (home.getChildFile ("Downloads").getChildFile (juce::String (engine.id)));
        candidates.add (home.getChildFile ("src").getChildFile (juce::String (engine.id)));
    }

    for (const auto& where : candidates)
    {
        if (searched.contains (where.getFullPathName()))
            continue;

        searched.add (where.getFullPathName());

        if (! where.exists())
            continue;

        juce::String why;
        const auto found = check (where, why);

        if (found != juce::File())
        {
            detail = "Found a working copy of " + name + " at " + found.getFullPathName() + ".";
            return found;
        }
    }

    detail = "No copy of " + name + " was found. Riffsheet looked in "
           + juce::String (searched.size()) + " places; if it is somewhere else, type the path.";
    return {};
}

juce::String EngineInstaller::sha256Of (const juce::File& file)
{
    if (! file.existsAsFile())
        return {};

    juce::FileInputStream stream (file);

    if (! stream.openedOk())
        return {};

    return juce::SHA256 (stream).toHexString();
}

juce::String EngineInstaller::checkDiskSpace (const juce::File& volumeAnchor, juce::int64 needBytes)
{
    // The anchor may not exist yet; the volume is what is being asked about, so
    // walk up to something that does.
    auto probe = volumeAnchor;

    while (! probe.exists() && probe.getParentDirectory() != probe)
        probe = probe.getParentDirectory();

    const auto free = probe.getBytesFreeOnVolume();

    if (free <= 0)          // the platform would not say; refusing on that would
        return {};          // be refusing on no evidence

    if (free >= needBytes)
        return {};

    // roundToInt, not String(double, 0): JUCE reads a decimal-place count of 0
    // as "use the shortest representation", which would put 6 decimals of
    // megabyte into a sentence a person has to read.
    const auto mb = [] (juce::int64 bytes)
    {
        return juce::String (juce::roundToInt ((double) bytes / (1024.0 * 1024.0)));
    };

    return "There is not enough room on this disk: this install needs about "
         + mb (needBytes) + " MB free and there is " + mb (free) + " MB.";
}

juce::int64 EngineInstaller::requiredFreeBytes (const EngineInstall::Plan& plan) noexcept
{
    // Downloads and the installed tree exist at the same time during the commit,
    // and pip's own cache is a third copy of some of it. Three times the larger
    // of the two numbers is the rule engine-architecture.md §5.3 states.
    const auto biggest = juce::jmax (plan.totalDownloadBytes(), plan.approxDiskBytes);
    return 3 * biggest;
}

//==============================================================================
EngineInstaller::PythonFind EngineInstaller::findPython (const juce::String& requirement)
{
    PythonFind found;

    juce::Array<juce::File> candidates;

    const auto consider = [&candidates, &found] (const juce::File& file)
    {
        if (file.getFullPathName().isEmpty())
            return;

        found.searched.addIfNotAlreadyThere (file.getFullPathName());

        if (file.existsAsFile() && ! candidates.contains (file))
            candidates.add (file);
    };

    // A scripted run wins, exactly like RIFFSHEET_MUSCRIPTOR_VENV does for the
    // other engine: this is the only way to point a DAW-launched plugin at a
    // particular interpreter.
    if (const auto override_ = juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_PYTHON", {});
        override_.isNotEmpty())
        consider (juce::File::getCurrentWorkingDirectory().getChildFile (override_));

    // Newest first, so a machine with several gets the one most likely to have
    // wheels for everything.
    const char* const names[] = { "python3.12", "python3.11", "python3.10", "python3" };

   #if JUCE_WINDOWS
    const char* const prefixes[] = { "C:\\Python312", "C:\\Python311", "C:\\Python310" };

    for (const auto* prefix : prefixes)
        consider (juce::File (juce::String (prefix)).getChildFile ("python.exe"));
   #else
    const char* const prefixes[] = { "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
                                     "/opt/homebrew/opt/python@3.12/bin",
                                     "/opt/homebrew/opt/python@3.11/bin",
                                     "/opt/homebrew/opt/python@3.10/bin" };

    for (const auto* name : names)
        for (const auto* prefix : prefixes)
            consider (juce::File (juce::String (prefix)).getChildFile (name));

    for (const char* version : { "3.12", "3.11", "3.10" })
        consider (juce::File ("/Library/Frameworks/Python.framework/Versions/" + juce::String (version)
                              + "/bin/python3"));
   #endif

    // PATH last on purpose: inside a DAW launched from Finder it is usually the
    // bare system PATH, so it finds least and is the weakest evidence.
   #if JUCE_WINDOWS
    const auto pathSeparator = ";";
   #else
    const auto pathSeparator = ":";
   #endif

    const auto pathDirectories = juce::StringArray::fromTokens (
        juce::SystemStats::getEnvironmentVariable ("PATH", {}), pathSeparator, "");

    for (const auto* name : names)
        for (const auto& directory : pathDirectories)
            if (directory.isNotEmpty())
                consider (juce::File (directory).getChildFile (name));

    juce::StringArray refused;

    for (const auto& candidate : candidates)
    {
        const auto outcome = runProcess ({ candidate.getFullPathName(), "-c",
                                           "import sys;print('%d.%d.%d'%sys.version_info[:3])" },
                                         kPythonProbeTimeoutMs, nullptr, nullptr);

        if (! outcome.ok)
            continue;

        const auto reported = outcome.output.trim().fromLastOccurrenceOf ("\n", false, false).trim();
        const auto version = parseVersion (reported);

        if (version.major == 0)
            continue;

        if (requirement.isNotEmpty() && ! versionSatisfies (version, requirement))
        {
            refused.addIfNotAlreadyThere (candidate.getFullPathName() + " is Python " + reported);
            continue;
        }

        found.interpreter = candidate;
        found.version = reported;
        return found;
    }

    found.error = refused.isEmpty()
                    ? "Riffsheet could not find Python " + requirement + " on this machine. It never "
                      "installs Python itself - install it once and press Check again."
                    : "Riffsheet needs Python " + requirement + " and the ones it found do not fit: "
                      + refused.joinIntoString ("; ") + ".";

    return found;
}

//==============================================================================
/*
    The download.

    Shape: try up to three times, resuming from whatever the last attempt left,
    and check the digest of the finished file. Each attempt walks the redirect
    chain by hand with JUCE following none of it, so the allowlist applies to
    every hop and not only to the URL in the table.
*/
bool EngineInstaller::fetch (const juce::String& url,
                             const juce::File& destination,
                             juce::int64 expectedBytes,
                             const juce::String& expectedSha256,
                             const EngineInstall::HostPolicy& policy,
                             std::function<void (const EngineInstall::Progress&)> onProgress,
                             std::function<bool()> shouldCancel,
                             juce::String& error)
{
    error.clear();

    if (! policy.allows (url, error))
        return false;

    const auto cancelled = [&shouldCancel] { return shouldCancel != nullptr && shouldCancel(); };

    const auto partial = destination.getSiblingFile (destination.getFileName() + ".part");
    const auto meta    = destination.getSiblingFile (destination.getFileName() + ".meta.json");

    destination.getParentDirectory().createDirectory();

    //-- is the partial on disk a prefix OF THIS asset? ------------------------
    //
    // A .part with no meta, or a meta describing a different url/size/digest, is
    // not a prefix of anything we want. Appending to it would produce a file
    // that fails its digest after a long download, which is the worst way to
    // find out.
    const auto discardPartial = [&partial, &meta]
    {
        partial.deleteFile();
        meta.deleteFile();
    };

    if (partial.existsAsFile())
    {
        auto recorded = juce::JSON::parse (meta);
        const auto* object = recorded.getDynamicObject();

        const auto matches = object != nullptr
                          && object->getProperty ("url").toString() == url
                          && object->getProperty ("expectedSha256").toString() == expectedSha256
                          && (juce::int64) (double) object->getProperty ("expectedBytes") == expectedBytes;

        if (! matches || partial.getSize() > expectedBytes)
            discardPartial();
    }
    else
    {
        meta.deleteFile();
    }

    const auto writeMeta = [&] (juce::int64 received)
    {
        auto* object = new juce::DynamicObject();
        object->setProperty ("url", url);
        object->setProperty ("expectedSha256", expectedSha256);
        object->setProperty ("expectedBytes", (double) expectedBytes);
        object->setProperty ("receivedBytes", (double) received);
        object->setProperty ("startedAtMs", juce::Time::getCurrentTime().toMilliseconds());
        meta.replaceWithText (juce::JSON::toString (juce::var (object)));
    };

    juce::String lastError;

    for (int attempt = 0; attempt < kDownloadAttempts; ++attempt)
    {
        if (attempt > 0)
        {
            const int backoffMs = attempt == 1 ? 1000 : (attempt == 2 ? 4000 : 10000);

            for (int waited = 0; waited < backoffMs; waited += 100)
            {
                if (cancelled())
                {
                    error = "cancelled";
                    return false;
                }

                juce::Thread::sleep (100);
            }
        }

        auto already = partial.existsAsFile() ? partial.getSize() : 0;

        if (already == expectedBytes)
            break;      // fully downloaded by a previous attempt; fall through to verify

        //-- walk the redirects ourselves ---------------------------------------
        juce::String currentUrl = url;
        std::unique_ptr<juce::InputStream> stream;
        int statusCode = 0;
        juce::StringPairArray responseHeaders;
        bool serverIgnoredRange = false;

        for (int hop = 0; hop <= kMaxRedirects; ++hop)
        {
            if (cancelled())
            {
                error = "cancelled";
                return false;
            }

            juce::String reason;

            if (! policy.allows (currentUrl, reason))
            {
                // A redirect off the list is a hard stop, not a retry: whatever
                // is at the other end is not what was pinned.
                error = reason;
                return false;
            }

            statusCode = 0;
            responseHeaders.clear();

            // withNumRedirectsToFollow(0) is what makes the allowlist mean
            // anything: JUCE follows nothing, so every hop comes back here and
            // is checked before it is fetched.
            const auto options =
                juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                    .withConnectionTimeoutMs (kConnectTimeoutMs)
                    .withStatusCode (&statusCode)
                    .withResponseHeaders (&responseHeaders)
                    .withNumRedirectsToFollow (0)
                    .withExtraHeaders (already > 0 ? "Range: bytes=" + juce::String (already) + "-"
                                                   : juce::String());

            stream = juce::URL (currentUrl).createInputStream (options);

            if (stream == nullptr)
            {
                lastError = "could not connect to " + hostOf (currentUrl);
                break;
            }

            if (statusCode >= 300 && statusCode < 400)
            {
                const auto location = responseHeaders.getValue ("Location",
                                        responseHeaders.getValue ("location", {}));

                if (location.isEmpty())
                {
                    lastError = "the server redirected without saying where";
                    stream.reset();
                    break;
                }

                currentUrl = location.startsWithIgnoreCase ("http")
                               ? location
                               : juce::URL (currentUrl).withNewSubPath (location).toString (true);
                stream.reset();

                if (hop == kMaxRedirects)
                {
                    error = "refused a download that redirected more than "
                          + juce::String (kMaxRedirects) + " times";
                    return false;
                }

                continue;
            }

            break;
        }

        if (stream == nullptr)
            continue;

        if (statusCode == 200 && already > 0)
        {
            // The server ignored the range and is sending the whole file. Start
            // over rather than appending a second copy onto the first.
            serverIgnoredRange = true;
            already = 0;
        }
        else if (already > 0 && statusCode != 206)
        {
            lastError = "the server answered " + juce::String (statusCode)
                      + " when asked to resume the download";
            continue;
        }
        else if (already == 0 && statusCode != 200)
        {
            lastError = "the server answered " + juce::String (statusCode);
            continue;
        }

        // Content-Length must agree with the pin exactly. It is absent on some
        // servers (GitHub's archive endpoint is chunked), and an absent header
        // is not a disagreement - the size is checked again on the finished file.
        const auto declared = responseHeaders.getValue ("Content-Length",
                                responseHeaders.getValue ("content-length", {}));

        if (declared.isNotEmpty())
        {
            const auto remaining = declared.getLargeIntValue();

            if (already + remaining != expectedBytes)
            {
                error = "refused a download whose size is " + juce::String (already + remaining)
                      + " bytes where " + juce::String (expectedBytes) + " was pinned";
                return false;
            }
        }

        if (serverIgnoredRange)
            partial.deleteFile();

        //-- read ---------------------------------------------------------------
        {
            juce::FileOutputStream out (partial);

            if (! out.openedOk())
            {
                error = "Could not write to " + partial.getFullPathName();
                return false;
            }

            if (already > 0)
            {
                out.setPosition (already);
            }
            else
            {
                out.setPosition (0);
                out.truncate();
            }

            writeMeta (already);

            juce::HeapBlock<char> buffer (kReadChunkBytes);
            auto received = already;
            const auto startedMs = juce::Time::getMillisecondCounterHiRes();
            auto lastReportMs = 0.0;
            auto failed = false;

            for (;;)
            {
                if (cancelled())
                {
                    out.flush();
                    writeMeta (received);
                    // CLOSE THE SOCKET HERE, not at the end of the enclosing scope.
                    // `stream` outlives this loop, and the next thing a cancel leads
                    // to is the host tearing the plugin down: NativeBridge::shutdown()
                    // waits on installWorkers with no timeout, deliberately, because
                    // the lambdas capture the bridge. A connection left open holds a
                    // socket and, on a stalled server, a thread inside read() - so the
                    // wait that must not be given a timeout is exactly the one that
                    // would never end. Resetting it makes the teardown immediate.
                    stream.reset();
                    error = "cancelled";
                    return false;
                }

                const auto read = stream->read (buffer.get(), kReadChunkBytes);

                if (read <= 0)
                    break;

                if (! out.write (buffer.get(), (size_t) read))
                {
                    lastError = "could not write to " + partial.getFullPathName();
                    failed = true;
                    break;
                }

                received += read;

                if (received > expectedBytes)
                {
                    error = "refused a download that is longer than the " + juce::String (expectedBytes)
                          + " bytes that were pinned";
                    out.flush();
                    discardPartial();
                    // Same reasoning as the cancel path above: a server that is sending
                    // more than was pinned is one we stop talking to immediately.
                    stream.reset();
                    return false;
                }

                const auto nowMs = juce::Time::getMillisecondCounterHiRes();

                if (onProgress != nullptr && nowMs - lastReportMs >= kProgressIntervalMs)
                {
                    lastReportMs = nowMs;

                    const auto seconds = juce::jmax (0.001, (nowMs - startedMs) / 1000.0);
                    const auto rate = (double) (received - already) / seconds;

                    EngineInstall::Progress progress;
                    progress.stage = EngineInstall::Stage::downloading;
                    progress.receivedBytes = received;
                    progress.totalBytes = expectedBytes;
                    progress.fraction = expectedBytes > 0 ? (double) received / (double) expectedBytes : 0.0;
                    progress.bytesPerSec = rate;
                    progress.etaSec = rate > 1.0 ? (double) (expectedBytes - received) / rate : -1.0;
                    onProgress (progress);
                }
            }

            out.flush();
            writeMeta (received);

            if (failed)
                continue;
        }

        if (partial.getSize() != expectedBytes)
        {
            lastError = "the download stopped after " + juce::String (partial.getSize())
                      + " of " + juce::String (expectedBytes) + " bytes";
            continue;   // resume on the next attempt
        }

        break;
    }

    if (! partial.existsAsFile() || partial.getSize() != expectedBytes)
    {
        error = lastError.isNotEmpty() ? lastError
                                       : "the download did not finish";
        return false;
    }

    //-- verify ---------------------------------------------------------------
    if (onProgress != nullptr)
    {
        EngineInstall::Progress progress;
        progress.stage = EngineInstall::Stage::verifying;
        progress.message = "Checking " + destination.getFileName();
        progress.receivedBytes = expectedBytes;
        progress.totalBytes = expectedBytes;
        progress.fraction = 1.0;
        onProgress (progress);
    }

    const auto digest = sha256Of (partial);

    if (! digest.equalsIgnoreCase (expectedSha256))
    {
        // Not a prefix of anything. Delete it so a retry cannot resume onto it,
        // and leave nothing behind that a later step could mistake for the file.
        discardPartial();
        destination.deleteFile();
        error = "the downloaded file is not the one Riffsheet expected (sha256 " + digest
              + ", expected " + expectedSha256 + ")";
        return false;
    }

    destination.deleteFile();

    if (! partial.moveFileTo (destination))
    {
        error = "Could not put the download at " + destination.getFullPathName();
        return false;
    }

    meta.deleteFile();
    return true;
}

//==============================================================================
bool EngineInstaller::writeProbeClip (const juce::File& destination)
{
    constexpr double sampleRate = 44100.0;
    constexpr int    lengthSamples = 44100;
    constexpr double frequency = 110.0;     // A2: in range for a bass model and audible to any other

    juce::AudioBuffer<float> buffer (1, lengthSamples);

    for (int i = 0; i < lengthSamples; ++i)
    {
        // A short fade at each end so the probe is not a click, which some
        // onset-based models would report as a note and others would not.
        const auto fade = juce::jmin (1.0f, (float) juce::jmin (i, lengthSamples - 1 - i) / 2000.0f);
        buffer.setSample (0, i, 0.25f * fade * (float) std::sin (2.0 * juce::MathConstants<double>::pi
                                                                 * frequency * i / sampleRate));
    }

    destination.deleteFile();
    destination.getParentDirectory().createDirectory();

    juce::WavAudioFormat format;
    std::unique_ptr<juce::FileOutputStream> out (destination.createOutputStream());

    if (out == nullptr)
        return false;

    std::unique_ptr<juce::AudioFormatWriter> writer (
        format.createWriterFor (out.get(), sampleRate, 1, 24, {}, 0));

    if (writer == nullptr)
        return false;

    out.release();      // the writer owns it now
    return writer->writeFromAudioSampleBuffer (buffer, 0, lengthSamples);
}

//==============================================================================
namespace
{
    /** Unpacks into `destination`, dropping the archive's single top-level
        directory when it has one - which GitHub's source zips always do. */
    bool unpackZip (const juce::File& archive, const juce::File& destination, juce::String& error)
    {
        const auto scratch = destination.getSiblingFile (destination.getFileName() + ".unzip");
        scratch.deleteRecursively();
        scratch.createDirectory();

        juce::ZipFile zip (archive);

        const auto outcome = zip.uncompressTo (scratch, true);

        if (outcome.failed())
        {
            error = "could not unpack " + archive.getFileName() + ": " + outcome.getErrorMessage();
            scratch.deleteRecursively();
            return false;
        }

        juce::Array<juce::File> children;
        scratch.findChildFiles (children, juce::File::findFilesAndDirectories, false);

        auto source = scratch;

        if (children.size() == 1 && children[0].isDirectory())
            source = children[0];

        destination.deleteRecursively();

        if (! source.moveFileTo (destination))
        {
            error = "could not move the unpacked files into place";
            scratch.deleteRecursively();
            return false;
        }

        scratch.deleteRecursively();
        return true;
    }

}

int EngineInstaller::retargetVenvScripts (const juce::File& venv, const juce::String& from,
                                          const juce::String& to, juce::String& error)
{
   #if JUCE_WINDOWS
    // pip's Windows console scripts are .exe launchers with the interpreter path
    // embedded in a binary payload, which a text rewrite cannot fix. Nothing
    // installs on Windows yet (there is no committed pip lock for it), and
    // whoever adds one has to solve that - probably by invoking `python -m
    // <module>` rather than the .exe. The text pass below still runs, because
    // the `activate` scripts are text and are worth having right.
    const auto scripts = venv.getChildFile ("Scripts");
   #else
    const auto scripts = venv.getChildFile ("bin");
   #endif

    if (! scripts.isDirectory())
    {
        error = "the virtual environment has no scripts directory at " + scripts.getFullPathName();
        return -1;
    }

    // The list is taken BEFORE anything is rewritten. Replacing a file inside a
    // directory that is being walked is exactly the kind of thing that works on
    // one platform and skips entries on another.
    juce::Array<juce::File> candidates;
    scripts.findChildFiles (candidates, juce::File::findFiles, false);

    auto rewrittenCount = 0;

    for (const auto& file : candidates)
    {
        if (file.isSymbolicLink() || file.getSize() > 256 * 1024)
            continue;

        const auto text = file.loadFileAsString();

        if (! text.contains (from))
            continue;

        // In place, with the permission bits kept: pip's console scripts are
        // executable and a rewrite that dropped that would trade one broken
        // engine for another.
        juce::FileOutputStream out (file);

        if (! out.openedOk() || ! out.setPosition (0) || ! out.truncate().wasOk())
        {
            error = "could not rewrite " + file.getFullPathName();
            return -1;
        }

        const auto rewritten = text.replace (from, to);

        if (! out.writeText (rewritten, false, false, nullptr))
        {
            error = "could not rewrite " + file.getFullPathName();
            return -1;
        }

        out.flush();

        if (out.getStatus().failed())
        {
            error = "could not rewrite " + file.getFullPathName();
            return -1;
        }

        ++rewrittenCount;
    }

    return rewrittenCount;
}

EngineInstaller::Result EngineInstaller::install (const EngineManifest& engine, Callbacks callbacks)
{
    Result result;
    const auto startedMs = juce::Time::getMillisecondCounterHiRes();

    const auto finish = [&result, startedMs] (bool ok) -> Result&
    {
        result.ok = ok;
        result.elapsedMs = juce::Time::getMillisecondCounterHiRes() - startedMs;
        return result;
    };

    const auto cancelled = [&callbacks]
    {
        return callbacks.shouldCancel != nullptr && callbacks.shouldCancel();
    };

    const auto report = [&callbacks] (EngineInstall::Stage stage, const juce::String& message)
    {
        if (callbacks.onProgress != nullptr)
        {
            EngineInstall::Progress progress;
            progress.stage = stage;
            progress.message = message;
            callbacks.onProgress (progress);
        }
    };

    const auto guideFor = [&engine]
    {
        juce::StringArray steps;

        for (int i = 0; i < engine.guideStepCount; ++i)
            steps.add (manifestText (engine.guideSteps[i].what) + " - "
                       + manifestText (engine.guideSteps[i].detail));

        return steps;
    };

    //-- 1. checking -----------------------------------------------------------
    report (EngineInstall::Stage::checking, "Checking what this needs...");

    juce::String planError;
    const auto plan = EngineInstall::planFor (engine, planError);

    if (planError.isNotEmpty())
    {
        result.error = planError;
        result.guideSteps = guideFor();
        return finish (false);
    }

    //-- 1b. the right to touch this engine's folders --------------------------
    //
    // Taken here, before the first byte is written and after the cheap "is this
    // even installable" work, and held for the rest of the function. Everything
    // past this point moves and recursively deletes whole trees under
    // <appSupport>/engines/<id>, and until now nothing coordinated that between
    // the standalone app and however many plugin instances the user has open.
    // Two installs of the same engine at once deleted each other's staging
    // directories mid-write, and the loser saw a failure that read like a
    // corrupt download.
    const ScopedInstallLock installLock (manifestText (engine.id));

    if (! installLock.isHeld())
    {
        result.error = installLock.whoElse();
        return finish (false);
    }

    const auto engineDir = engineDirectory (engine.id);
    const auto downloads = downloadsDirectory (engine.id);

    enginesRoot().createDirectory();

    // A directory of our own, named with a UUID. Belt and braces on the lock
    // above: on a machine where the lock cannot be taken - a sandboxed host with
    // no access to the lock file's folder - two installs still cannot reach each
    // other's bytes, because there is no shared path left to reach.
    const auto incoming = newIncomingDirectory (manifestText (engine.id));

    // ...and with the lock held, anything ELSE matching that shape is rubbish
    // from a run that crashed or was force-quit: nobody can be using it, because
    // using it would mean holding this lock. Left alone it accumulates a
    // half-built venv per crash.
    if (const auto swept = sweepStaleStaging (manifestText (engine.id), incoming); swept > 0)
        juce::Logger::writeToLog ("Riffsheet/EngineInstaller: cleared " + juce::String (swept)
                                  + " staging director" + (swept == 1 ? "y" : "ies")
                                  + " left by an earlier run");

    if (const auto complaint = checkDiskSpace (enginesRoot(), requiredFreeBytes (plan));
        complaint.isNotEmpty())
    {
        result.error = complaint;
        return finish (false);
    }

    PythonFind python;

    if (plan.needsPython())
    {
        python = findPython (plan.pythonRequirement);

        if (! python.interpreter.existsAsFile())
        {
            result.error = python.error;
            result.guideSteps = guideFor();

            if (result.guideSteps.isEmpty())
                result.guideSteps = { "Install Python " + plan.pythonRequirement
                                      + " - from python.org, or \"brew install python@3.12\" if you "
                                        "use Homebrew. Riffsheet never installs Python itself.",
                                      "Press Install again - it looks for it every time." };

            return finish (false);
        }

        report (EngineInstall::Stage::checking,
                "Using Python " + python.version + " at " + python.interpreter.getFullPathName());
    }

    if (cancelled())
    {
        result.cancelled = true;
        result.error = "cancelled";
        return finish (false);
    }

    // No delete-first any more: `incoming` is a UUID nothing has ever used, and
    // the sweep above has already dealt with what earlier runs left. Deleting a
    // shared `<id>.incoming` here is exactly what used to land on another
    // window's half-built engine.
    if (! incoming.createDirectory())
    {
        result.error = "Could not create " + incoming.getFullPathName();
        return finish (false);
    }

    //-- 2. downloading --------------------------------------------------------
    const auto policy = EngineInstall::HostPolicy::shipped();
    const auto totalBytes = plan.totalDownloadBytes();
    juce::int64 doneBytes = 0;

    for (const auto& asset : plan.assets)
    {
        const auto name = asset.url.fromLastOccurrenceOf ("/", false, false)
                                   .upToFirstOccurrenceOf ("?", false, false);
        const auto staged = downloads.getChildFile (name.isEmpty() ? "asset" : name);

        report (EngineInstall::Stage::downloading, "Downloading " + staged.getFileName());

        juce::String fetchError;

        const auto assetProgress = [&callbacks, doneBytes, totalBytes] (const EngineInstall::Progress& p)
        {
            if (callbacks.onProgress == nullptr)
                return;

            // One bar for the whole install rather than one per file: the user
            // asked for an engine, not for three downloads.
            auto scaled = p;
            scaled.receivedBytes = doneBytes + p.receivedBytes;
            scaled.totalBytes = totalBytes;
            scaled.fraction = totalBytes > 0 ? (double) scaled.receivedBytes / (double) totalBytes : 0.0;
            callbacks.onProgress (scaled);
        };

        if (! fetch (asset.url, staged, asset.bytes, asset.sha256, policy,
                     assetProgress, callbacks.shouldCancel, fetchError))
        {
            incoming.deleteRecursively();
            result.cancelled = fetchError == "cancelled";
            result.error = fetchError;
            return finish (false);
        }

        doneBytes += asset.bytes;

        //-- 3. into the incoming tree ----------------------------------------
        const auto destination = incoming.getChildFile (asset.destination);

        if (asset.archive == ArchiveKind::zip)
        {
            report (EngineInstall::Stage::extracting, "Unpacking " + staged.getFileName());

            juce::String unpackError;

            if (! unpackZip (staged, destination, unpackError))
            {
                incoming.deleteRecursively();
                result.error = unpackError;
                return finish (false);
            }
        }
        else
        {
            destination.getParentDirectory().createDirectory();

            // Copy rather than move: the verified download stays in .downloads
            // so a reinstall after an uninstall does not fetch 113 MB again.
            if (! staged.copyFileTo (destination))
            {
                incoming.deleteRecursively();
                result.error = "Could not put " + staged.getFileName() + " into place";
                return finish (false);
            }
        }
    }

    if (cancelled())
    {
        incoming.deleteRecursively();
        result.cancelled = true;
        result.error = "cancelled";
        return finish (false);
    }

    //-- 4. the virtual environment -------------------------------------------
    juce::File venv;

    if (plan.needsPython())
    {
        venv = incoming.getChildFile ("venv");

        report (EngineInstall::Stage::installing, "Creating a virtual environment...");

        const auto venvOutcome = runProcess ({ python.interpreter.getFullPathName(), "-m", "venv",
                                               venv.getFullPathName() },
                                             kVenvTimeoutMs, callbacks.shouldCancel, nullptr);

        if (! venvOutcome.ok)
        {
            incoming.deleteRecursively();
            result.cancelled = venvOutcome.cancelled;
            result.error = venvOutcome.cancelled
                             ? "cancelled"
                             : "Could not create a virtual environment: "
                               + lastLines (venvOutcome.output, 4);
            return finish (false);
        }

        const auto requirements = incoming.getChildFile (plan.requirementsName);
        juce::String writeError;

        if (! writeBinaryResource (plan.requirementsResource, requirements, writeError))
        {
            incoming.deleteRecursively();
            result.error = writeError;
            return finish (false);
        }

        report (EngineInstall::Stage::installing,
                "Installing packages - this is the slow part.");

        // --require-hashes is the whole point of shipping the lock file: pip
        // refuses anything whose bytes are not the ones this build was tested
        // against, including transitive dependencies, and refuses the file
        // itself if any requirement in it is unpinned.
        const auto pipOutcome = runProcess ({ venvBinary (venv, "python"), "-m", "pip", "install",
                                              "--disable-pip-version-check", "--no-input",
                                              "--require-hashes", "-r", requirements.getFullPathName() },
                                            kPipTimeoutMs, callbacks.shouldCancel,
                                            [&report] (const juce::String&)
                                            {
                                                report (EngineInstall::Stage::installing,
                                                        "Installing packages - this is the slow part.");
                                            });

        if (! pipOutcome.ok)
        {
            incoming.deleteRecursively();
            result.cancelled = pipOutcome.cancelled;
            result.error = pipOutcome.cancelled
                             ? "cancelled"
                             : "Installing the packages failed: " + lastLines (pipOutcome.output, 6);
            return finish (false);
        }

        if (plan.consoleScript.isNotEmpty()
            && ! juce::File (venvBinary (venv, plan.consoleScript)).existsAsFile())
        {
            incoming.deleteRecursively();
            result.error = "The packages installed but " + plan.consoleScript
                         + " is not in the virtual environment.";
            return finish (false);
        }
    }

    //-- 5. the sidecar script -------------------------------------------------
    if (plan.scriptResource.isNotEmpty())
    {
        juce::String writeError;

        if (! writeBinaryResource (plan.scriptResource, incoming.getChildFile (plan.scriptName),
                                   writeError))
        {
            incoming.deleteRecursively();
            result.error = writeError;
            return finish (false);
        }
    }

    //-- 6. move it into place, and only then run it ---------------------------
    //
    // THE ORDER HERE WAS A BUG, AND THE BUG IS WHY THE PROBE EXISTS. It used to
    // probe in the staging directory and move afterwards, which passed - and
    // then the installed engine did not run, because pip writes the venv's own
    // ABSOLUTE path into every console script it generates, so `transkun` still
    // pointed at `<id>.incoming/venv/bin/python` after the move. A probe that
    // tests a path nothing will ever use is not a probe.
    //
    // So: the previous install is stepped aside rather than deleted, the new
    // tree is moved into its real home, its scripts are retargeted, and THEN it
    // is run. A failure rolls the old one back and the user is where they
    // started - which is the same promise the staging directory was making,
    // kept at the other end.
    // UUID'd for the same reason `incoming` is, and with the same consequence:
    // there is no delete-first here either, because there is nothing at this
    // path to delete and nothing another process could have put there.
    const auto previous = newPreviousDirectory (manifestText (engine.id));

    if (engineDir.exists() && ! engineDir.moveFileTo (previous))
    {
        incoming.deleteRecursively();
        result.error = "Could not move the previous install aside at " + engineDir.getFullPathName();
        return finish (false);
    }

    if (! incoming.moveFileTo (engineDir))
    {
        incoming.deleteRecursively();
        previous.moveFileTo (engineDir);
        result.error = "Could not move the finished engine into " + engineDir.getFullPathName();
        return finish (false);
    }

    /** Puts the old install back and reports why. */
    const auto rollBack = [&] (const juce::String& why, bool wasCancelled) -> Result&
    {
        engineDir.deleteRecursively();

        if (previous.exists())
            previous.moveFileTo (engineDir);

        result.cancelled = wasCancelled;
        result.error = why;
        return finish (false);
    };

    if (plan.needsPython())
    {
        const auto staged = venv;                       // where pip wrote its paths
        venv = engineDir.getChildFile ("venv");         // where they have to point now

        juce::String retargetError;

        const auto rewritten = retargetVenvScripts (venv, staged.getParentDirectory().getFullPathName(),
                                                    engineDir.getFullPathName(), retargetError);

        if (rewritten < 0)
            return rollBack (retargetError, false);

        report (EngineInstall::Stage::installing,
                "Pointing " + juce::String (rewritten) + " scripts at their new home...");
    }

    {
        const auto clip = engineDir.getChildFile ("probe.wav");

        if (! writeProbeClip (clip))
            return rollBack ("Could not write the test clip the install ends with.", false);

        report (EngineInstall::Stage::probing, "Trying it on a one-second test clip...");

        // A real run holds real memory - 1.4 to 1.7 GB for these two - so on an
        // 8 GB machine it must not happen underneath somebody else's
        // transcription. It queues for the machine-wide turn like any other job.
        auto holdsTurn = false;

        if (callbacks.acquireMachineTurn != nullptr)
        {
            holdsTurn = callbacks.acquireMachineTurn();

            if (! holdsTurn)
            {
                clip.deleteFile();
                return rollBack ("cancelled", true);
            }
        }

        struct ReleaseTurn
        {
            std::function<void()> release;
            bool held;
            ~ReleaseTurn() { if (held && release != nullptr) release(); }
        } releaseTurn { callbacks.releaseMachineTurn, holdsTurn };

        juce::StringArray argv;
        const auto output = engineDir.getChildFile ("probe.mid");

        if (plan.scriptResource.isNotEmpty())
        {
            argv = { venvBinary (venv, "python"),
                     engineDir.getChildFile (plan.scriptName).getFullPathName(),
                     "--root", engineDir.getFullPathName(),
                     "--audio", clip.getFullPathName(),
                     "--output-midi", output.getFullPathName(),
                     "--instruments", "any" };
        }
        else
        {
            argv = { venvBinary (venv, plan.consoleScript),
                     clip.getFullPathName(), output.getFullPathName(),
                     "--device", "cpu" };
        }

        const auto probeOutcome = runProcess (argv, kProbeTimeoutMs, callbacks.shouldCancel,
                                              [&report] (const juce::String&)
                                              {
                                                  report (EngineInstall::Stage::probing,
                                                          "Trying it on a one-second test clip...");
                                              });

        const auto wrote = output.existsAsFile();

        clip.deleteFile();
        output.deleteFile();

        if (! probeOutcome.ok || ! wrote)
            return rollBack (probeOutcome.cancelled
                                 ? juce::String ("cancelled")
                                 : manifestText (engine.name) + " installed but would not run on this "
                                   "machine: " + lastLines (probeOutcome.output, 6),
                             probeOutcome.cancelled);
    }

    previous.deleteRecursively();

    result.bytesOnDisk = bytesOnDisk (engineDir);
    result.location = plan.needsPython() ? venv.getFullPathName() : engineDir.getFullPathName();
    return finish (true);
}

//==============================================================================
EngineInstaller::Result EngineInstaller::uninstall (const EngineManifest& engine)
{
    Result result;

    if (engine.install != InstallKind::oneClick)
    {
        // Riffsheet did not put the bundled engine or MuScriptor's venv there,
        // so it does not get to remove them - the same principle as never
        // killing a server it did not start.
        result.error = manifestText (engine.name) + " was not installed by Riffsheet, so Riffsheet "
                                                    "will not remove it.";
        return result;
    }

    // The same lock install() takes, for the stronger reason: this deletes the
    // engine directory outright, and doing that underneath a running install
    // would leave the user with neither the old engine nor the new one.
    const ScopedInstallLock installLock (manifestText (engine.id));

    if (! installLock.isHeld())
    {
        result.error = installLock.whoElse();
        return result;
    }

    const auto engineDir = engineDirectory (engine.id);
    const auto downloads = downloadsDirectory (engine.id);

    // Staging trees are counted before they are swept, so "freed 113 MB" is the
    // truth rather than the part of it that happened to be in the final tree.
    juce::int64 staging = 0;

    for (const auto& item : juce::RangedDirectoryIterator (enginesRoot(), false,
                                                           manifestText (engine.id) + ".incoming-*;"
                                                               + manifestText (engine.id) + ".previous-*",
                                                           juce::File::findDirectories))
        staging += bytesOnDisk (item.getFile());

    result.bytesOnDisk = bytesOnDisk (engineDir) + bytesOnDisk (downloads) + staging;

    engineDir.deleteRecursively();
    // Every staging tree for this engine. Safe because the lock is held: no
    // other process can be mid-install, so anything matching is ours or dead.
    sweepStaleStaging (manifestText (engine.id), juce::File());
    downloads.deleteRecursively();

    result.ok = ! engineDir.exists();

    if (! result.ok)
        result.error = "Could not delete " + engineDir.getFullPathName();

    return result;
}
