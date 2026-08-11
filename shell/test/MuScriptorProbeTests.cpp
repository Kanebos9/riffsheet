#include <JuceHeader.h>
#include "MuScriptorProbe.h"

/*
    The HTTP handshake that finds a transcription server nobody told us about.

    THE BUG THIS FILE IS THE EVIDENCE FOR. A user started MuScriptor themselves,
    from their own launcher, and Riffsheet reported "stopped" at a server that was
    plainly answering. Every identity test in the shell went through the operating
    system - `lsof` for the pid holding the port, `ps` for its command line - and
    those tools answer nothing at all inside a sandboxed plugin host, say nothing
    about another user's processes, and are not implemented on Windows. The server
    was reachable the whole time; only the question was wrong.

    So these tests ask the SERVER, over a real socket, and they are written
    against a fake that answers the way MuScriptor's own routes do: /health with
    {"status":"ok"} and /instruments with the 35-name group list from BRIDGE.md.
    A fake is the right tool here for once - the thing under test is our JSON
    reading and our identity rule, not FastAPI - but the socket, the HTTP and the
    juce::URL client are all real, because "we can parse what we would have sent"
    is not a proof of anything.

    WHAT IS DELIBERATELY NOT ASSERTED HERE: that a handshake is enough to kill a
    process or to upload a recording to it. It is not, and MuScriptorServer keeps
    both of those on the pid-and-command-line proof. See the
    `handshakeIdentifiedOnly` flag there.
*/

namespace
{
    /** MuScriptor's own 35 instrument groups, as documented in BRIDGE.md. The
        fake answers with the real list because the identity rule is about this
        list; a made-up one would test the rule against itself. */
    const char* const kRealGroups =
        R"({"instruments":["acoustic_piano","electric_piano","chromatic_percussion","organ",)"
        R"("acoustic_guitar","clean_electric_guitar","distorted_electric_guitar","acoustic_bass",)"
        R"("electric_bass","violin","viola","cello","contrabass","orchestral_harp","timpani",)"
        R"("string_ensemble","synth_strings","voice","orchestra_hit","trumpet","trombone","tuba",)"
        R"("french_horn","brass_section","soprano_and_alto_sax","tenor_sax","baritone_sax","oboe",)"
        R"("english_horn","bassoon","clarinet","flutes","synth_lead","synth_pad","drums"]})";

    /** A one-connection-at-a-time HTTP server that can pretend to be a
        MuScriptor, or pretend to be something else entirely on the same port.
        Every response closes its connection, so nothing is left half-open when a
        test finishes. */
    class FakeServer final : private juce::Thread
    {
    public:
        FakeServer() : juce::Thread ("Riffsheet muscriptor probe test") {}

        ~FakeServer() override { stop(); }

        /** Binds a free loopback port. Returns 0 on failure. */
        int start()
        {
            for (int candidate = 46310; candidate < 46410; ++candidate)
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

        void stop()
        {
            signalThreadShouldExit();
            listener.close();
            stopThread (4000);
        }

        void set (const juce::String& path, const juce::String& body)
        {
            const juce::ScopedLock sl (lock);
            routes.set (path, body);
        }

        void remove (const juce::String& path)
        {
            const juce::ScopedLock sl (lock);
            routes.remove (path);
        }

        std::atomic<int> requestCount { 0 };

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

            juce::String body;
            bool known = false;

            {
                const juce::ScopedLock sl (lock);
                known = routes.contains (path);

                if (known)
                    body = routes[path];
            }

            if (! known)
            {
                send (connection, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n"
                                  "Connection: close\r\n\r\n");
                return;
            }

            send (connection,
                  "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                      + juce::String (body.getNumBytesAsUTF8()) + "\r\nConnection: close\r\n\r\n"
                      + body);
        }

        static void send (juce::StreamingSocket& connection, const juce::String& text)
        {
            const auto* bytes = text.toRawUTF8();
            connection.write (bytes, (int) std::strlen (bytes));
            connection.close();
        }

        juce::StreamingSocket listener;
        int port = 0;
        juce::CriticalSection lock;
        juce::HashMap<juce::String, juce::String> routes;
    };

    /** A MuScriptor as far as any client can tell. */
    void makeItAMuScriptor (FakeServer& server)
    {
        server.set ("/health", R"({"status":"ok"})");
        server.set ("/instruments", kRealGroups);
    }
}

//==============================================================================
class MuScriptorProbeTests final : public juce::UnitTest
{
public:
    MuScriptorProbeTests()
        : juce::UnitTest ("MuScriptorProbe - finding a server nobody told us about",
                          "MuScriptorProbe")
    {
    }

    void runTest() override
    {
        beginTest ("the identity rule needs the server's own group names");
        {
            MuScriptorProbe::forgetCachedAnswers();

            expect (! MuScriptorProbe::instrumentsLookLikeMuScriptor ({}),
                    "an empty list identifies nothing");

            // One name is not a signature: plenty of software has a "voice" or an
            // "organ" in a list somewhere.
            expect (! MuScriptorProbe::instrumentsLookLikeMuScriptor ({ "electric_bass" }),
                    "one name is a coincidence, not an identification");

            expect (! MuScriptorProbe::instrumentsLookLikeMuScriptor (
                        { "guitar", "bass", "piano", "drums", "voice", "organ" }),
                    "ordinary instrument words are not MuScriptor's group names");

            expect (MuScriptorProbe::instrumentsLookLikeMuScriptor (
                        { "electric_bass", "distorted_electric_guitar", "chromatic_percussion" }),
                    "three of the server's own group names is an identification");
        }

        beginTest ("a real socket: a server that answers like MuScriptor is found");
        {
            MuScriptorProbe::forgetCachedAnswers();

            FakeServer server;
            const auto port = server.start();
            expect (port > 0, "could not bind a loopback port for the fake server");
            makeItAMuScriptor (server);

            const auto answer = MuScriptorProbe::handshake ("127.0.0.1", port);
            expect (answer.reachable, "/health said ok and the probe did not believe it");
            expect (answer.identified, "the real group list was not recognised");
            expectEquals (answer.instruments.size(), 35);
            expect (answer.instruments.contains ("electric_bass"));
        }

        beginTest ("nothing listening is not a server");
        {
            MuScriptorProbe::forgetCachedAnswers();

            // Bound and released, so the port is a real one with nothing behind
            // it rather than a number picked out of the air.
            int deadPort = 0;

            {
                FakeServer server;
                deadPort = server.start();
                expect (deadPort > 0);
            }

            const auto answer = MuScriptorProbe::handshake ("127.0.0.1", deadPort, 400);
            expect (! answer.reachable);
            expect (! answer.identified);
            expect (! MuScriptorProbe::answersLikeMuScriptor ("127.0.0.1", deadPort, 400, 0));
        }

        beginTest ("something else on the port is NOT reported as a server");
        {
            MuScriptorProbe::forgetCachedAnswers();

            FakeServer server;
            const auto port = server.start();
            expect (port > 0);

            // The whole reason /health alone was never enough: anything at all
            // can answer it, and one such thing is any other local service with
            // a health endpoint of its own.
            server.set ("/health", R"({"status":"ok"})");

            auto answer = MuScriptorProbe::handshake ("127.0.0.1", port);
            expect (answer.reachable, "the fake did answer /health");
            expect (! answer.identified, "/health alone must never identify a MuScriptor");

            // ...and neither does a service that has an /instruments of its own.
            server.set ("/instruments", R"({"instruments":["kick","snare","hat"]})");
            answer = MuScriptorProbe::handshake ("127.0.0.1", port);
            expect (! answer.identified, "somebody else's instrument list is not MuScriptor's");
        }

        beginTest ("a health endpoint that says something else is not ok");
        {
            MuScriptorProbe::forgetCachedAnswers();

            FakeServer server;
            const auto port = server.start();
            expect (port > 0);
            server.set ("/health", R"({"status":"loading"})");
            server.set ("/instruments", kRealGroups);

            const auto answer = MuScriptorProbe::handshake ("127.0.0.1", port);
            expect (! answer.reachable);
            expect (! answer.identified, "a server that is not ok is not a server to report");
        }

        beginTest ("THE FLIP: found while it runs, gone when it stops");
        {
            MuScriptorProbe::forgetCachedAnswers();

            FakeServer server;
            const auto port = server.start();
            expect (port > 0);
            makeItAMuScriptor (server);

            expect (MuScriptorProbe::answersLikeMuScriptor ("127.0.0.1", port, 1200, 0),
                    "a running MuScriptor was not found");

            server.stop();
            MuScriptorProbe::forgetCachedAnswers();

            expect (! MuScriptorProbe::answersLikeMuScriptor ("127.0.0.1", port, 400, 0),
                    "a stopped server was still being reported");
        }

        beginTest ("the cache stops N windows polling into a flood");
        {
            MuScriptorProbe::forgetCachedAnswers();

            FakeServer server;
            const auto port = server.start();
            expect (port > 0);
            makeItAMuScriptor (server);

            expect (MuScriptorProbe::answersLikeMuScriptor ("127.0.0.1", port, 1200, 5000));
            const auto afterFirst = server.requestCount.load();
            expect (afterFirst >= 2, "the first handshake asks /health and /instruments");

            // The UI polls about every ten seconds, from every open window. Inside
            // the TTL not one of those may reach the socket.
            for (int i = 0; i < 20; ++i)
                expect (MuScriptorProbe::answersLikeMuScriptor ("127.0.0.1", port, 1200, 5000));

            expectEquals (server.requestCount.load(), afterFirst,
                          "a cached answer went to the network anyway");

            // A negative is cached too - a port with nothing behind it must not
            // be retried on every poll either.
            MuScriptorProbe::forgetCachedAnswers();
            expect (MuScriptorProbe::answersLikeMuScriptor ("127.0.0.1", port, 1200, 5000));
            expect (server.requestCount.load() > afterFirst, "forgetting did not re-ask");
        }
    }
};

static MuScriptorProbeTests muScriptorProbeTests;
