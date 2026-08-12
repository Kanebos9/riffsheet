#pragma once
#include <JuceHeader.h>
#include "ChildProcessSupervisor.h"

/**
    Owns the local MuScriptor transcription server.

    MuScriptor is a Python HTTP service in a virtualenv on disk. This class
    starts it on demand, reuses one that is already listening, and shuts down
    only the process it started itself.

    Two facts from the server's source shape this client:

    - The model is loaded BEFORE uvicorn binds the port, so a successful
      GET /health means "fully ready to transcribe". There is no warming-up
      window to guess at.
    - POST /transcribe streams Server-Sent Events, one JSON frame per note
      onset/offset, and the tempo grid only arrives in the final frame. So the
      client is a streaming parser, not a request/response call.

    Everything here blocks. Call it from a worker thread.
*/
class MuScriptorServer
{
public:
    MuScriptorServer();
    ~MuScriptorServer();

    struct Config
    {
        juce::File venv;                  // .../muscriptor/venv
        juce::String model = "small";     // the RESOLVED size actually passed to --model
        int port = 8223;
        juce::String host = "127.0.0.1";
        int startupTimeoutMs = 240000;    // first run downloads ~412 MB of weights

        /** Ports to adopt if something healthy is already listening there.
            8222 is the default in the user's own START*.command launchers, so a
            server they started by hand gets reused instead of duplicated. */
        juce::Array<int> reusePorts { 8223, 8222 };
    };

    void setConfig (Config newConfig);
    Config getConfig() const;

    /** Portable engine install contract. The first existing venv is selected
        from, in order: the RIFFSHEET_MUSCRIPTOR_VENV override, the path this app
        remembered in <appSupport>/engine.json, the recommended folder here,
        bundled/portable layouts, known hand-built locations, then PATH. When
        none exists, config.venv points here so errors and setup UI agree. */
    static juce::File recommendedSetupDirectory();
    static juce::String setupInstructions();
    juce::File getEngineExecutable() const;

    /** <appSupport>/engine.json - the one writable place a user can name a venv
        that a Finder-launched DAW will actually read. Static because the setup
        screen has to be able to show and copy the path whether or not an engine
        was ever found. */
    static juce::File engineConfigFile();

    /** The venv locations discovery actually looked in, in order, so a failure
        can say where it looked instead of naming one path nobody has. */
    juce::StringArray getVenvSearchPaths() const;

    /** Runs the whole discovery again, from the environment override down to
        PATH, and adopts the result - so somebody who installs the engine (or
        edits engine.json) while the app is open can press "Check again" instead
        of restarting their DAW. Also refreshes the search-path list the setup
        screen shows.

        Only touches where the engine is LOOKED FOR. A server already running is
        left exactly as it is; the new path is what the next spawn will use.
        Stats a handful of files. Worker threads only. */
    void rediscoverEngine();

    enum class State { stopped, starting, ready, failed };

    State getState() const noexcept { return state.load(); }
    juce::String getLastError() const;

    //==============================================================================
    // Which weights, and saying so honestly - punch-list item 10.

    /** What was asked for: 'auto', or a size named by RIFFSHEET_MUSCRIPTOR_MODEL.
        'auto' is resolved against what is installed and how much memory this
        machine has (see ModelCatalog) the moment a server is started.

        There is no setter: the size dropdown that used to call one is gone, and
        with it the bridge's setEngineModel(). The environment variable is read
        once at construction, so `configuredModel` is fixed for the life of the
        server and nothing can swap weights underneath a running job. */
    juce::String getConfiguredModel() const;

    /** The size 'auto' currently resolves to, plus the sentence explaining why.
        Cheap; safe on the message thread. */
    juce::String getResolvedModel() const;
    juce::String getModelReason() const;

    /** True when we joined a server we did not start. Our model setting is
        irrelevant to such a server and must never be presented as if it applied. */
    bool isAdopted() const noexcept { return adopted.load(); }

    /** The weights the server on the wire is really running, as best as can be
        known:
          - a server we started: the size we passed to --model;
          - a server somebody else started: read out of its command line, since
            MuScriptor's /health reports only {"status":"ok"} and there is no
            other endpoint that names the model;
          - failing that, the literal string "unknown - this server was already
            running", because a guess here would be a lie. */
    juce::String getRunningModelDescription() const;

    /** Where getRunningModelDescription() came from, for the UI to show. */
    juce::String getRunningModelSource() const;

    /** The SIZE the server on the wire is running - "small", "medium" or
        "large" - or **"" when that cannot be proved**.

        Separate from getRunningModelDescription() because that one is prose the
        card prints, including the sentence "unknown - this server was already
        running", and a chip that wants to say "MuScriptor small" needs a word it
        can put after a name rather than a sentence to parse.

        It is non-empty in exactly two cases:
          - Riffsheet started the server, so the size is the one it passed to
            --model itself;
          - somebody else started it and the operating system let us read its
            command line, and `--model` there named one of the three sizes.

        Everything else answers "": an adopted server whose command line could
        not be read (a sandboxed host, or Windows), a server identified only by
        the HTTP handshake, and a --model that names a path or an hf:// URL
        instead of a size - that last one is a real model but not a size, and
        calling it "small" because it is small would be a guess. */
    juce::String getRunningModelSize() const;

    /** Health-probes the reuse ports without starting anything, and updates the
        adopted/port/model reporting. Blocks for up to a couple of seconds -
        worker threads only.

        A server it cannot identify from the operating system - no listening pid,
        no readable command line, which is the normal state of affairs inside a
        sandboxed host and on Windows - is identified by an HTTP handshake with
        the server itself instead (MuScriptorProbe), and REPORTED. It is not
        adopted for work on that evidence: see isHandshakeIdentifiedOnly(). */
    void refreshStatus();

    /** Kills leftover servers from a previous force-quit and takes over healthy
        orphans. Runs its real work once per process; later calls return at once.
        Blocks - worker threads only. */
    void reapOrphanServers();

    /** Health-probes (including the reuse ports), spawns if needed, then polls
        until ready. Thread-safe; concurrent callers are serialised. */
    bool ensureRunning (std::function<void (const juce::String&)> onProgress = {},
                        std::function<bool()> shouldCancel = {});

    /** True if a MuScriptor is answering on `port`. */
    bool probeHealth (int port) const;

    /** The server being reported is one only its own HTTP handshake vouches for:
        the operating system would not say which process is listening, so the pid
        and command line this class normally requires are unknown.

        It is reported (state, port, externalServer) and it is used for nothing
        else - no audio is uploaded to it and nothing may kill it - because a
        handshake is a good answer to "is something there?" and no answer at all
        to "whose process is this?". Cheap: one atomic. */
    bool isHandshakeIdentifiedOnly() const noexcept { return handshakeIdentifiedOnly.load(); }

    /** The port actually in use - may differ from config.port if an existing
        server was adopted. */
    int getActivePort() const noexcept { return activePort.load(); }
    juce::String getBaseUrl() const;

    //==============================================================================
    // THE ENGINE LIVES FOR ONE JOB.
    //
    // MuScriptor is a Python process holding roughly a gigabyte of weights, and
    // it used to stay resident from the first transcription until the plugin was
    // closed. Then it was closed after five idle minutes. The user's decision,
    // in his words: "i dont want idle timeout to be 5 minutes. i want
    // musicriptor to be killed immediately after its done its job. listening
    // again can trigger again, but it should still die right after."
    //
    // So there is no idle clock and no timer any more. The engine is started by
    // ensureRunning() when a transcription needs it and stopped by stopAfterJob()
    // the moment that transcription ends - success, failure or cancel. "Listen
    // again" simply cold-starts it. STOPPED IS THE NORMAL RESTING STATE and the
    // UI must read it that way; it is not an error and not a failure.
    //
    // THE TWO THINGS THIS MUST NEVER DO.
    //
    //   1. Stop a server Riffsheet did not start. The user runs his own from
    //      START-MEDIUM.command on port 8222 and Riffsheet borrows it; closing
    //      it would be taking something that is not ours. The ONLY evidence of
    //      ownership accepted anywhere below is ServerRegistry - the pid we
    //      wrote down ourselves - backed up by the process's own command line at
    //      the moment of the kill. An adopted server is disconnected from, never
    //      killed.
    //
    //      THE ONE EXCEPTION, and it is not a loophole: stopExternalServer().
    //      It ends a server Riffsheet did not start, it is reachable only from
    //      a button a human presses, nothing in the shell calls it on its own,
    //      and it proves the process's identity four ways before touching it.
    //      Consent is what makes it different, not a weaker test - its test is
    //      strictly stronger than this one's.
    //   2. Stop it mid-job, including a job belonging to another Riffsheet on
    //      this machine. Ending a job releases the machine-wide EngineLock
    //      FIRST, so anybody queued behind it takes the engine before the
    //      shutdown is even offered; the shutdown then refuses while the lock is
    //      held or anybody holds a queue ticket. The queue therefore drains and
    //      the LAST finisher is the one that actually stops the server.

    /** What the UI needs in order to talk about the server, computed from cached
        facts plus two small files. Cheap enough for the message thread. */
    struct IdleState
    {
        bool   running = false;      // a server is answering on `port`
        bool   ours = false;         // ...and Riffsheet is the one that started it
        bool   busy = false;         // somebody on this machine is transcribing, or queued to
        double idleSeconds = 0.0;    // since the last job finished; 0 while busy
        bool   canStop = false;      // stopEngine() would actually do something
        int    memoryMb = -1;        // resident size of the server process, -1 unknown
        int    port = 0;

        /** A server is on the wire and Riffsheet did NOT start it - the user's
            own START-MEDIUM.command window, usually. `ours` and this are
            opposites while `running`; both are false when nothing is up. */
        bool   external = false;

        /** stopExternalEngine() would get as far as actually trying.

            NOT the same question as `canStop`, which is about a server that is
            ours. This one is "the user has asked to take somebody else's
            server down, and every check we can answer cheaply says we may": it
            is external, nothing on this machine is using it, and the last probe
            read a command line that says muscriptor ... serve. The expensive
            proofs are re-taken from scratch inside stopExternalServer() at the
            moment of the kill, because this field is a cached photograph and a
            kill decision may never rest on one. */
        bool   canStopExternal = false;

        /** Why it cannot be stopped, as a sentence for a human. Empty when it
            can be. */
        juce::String reason;
    };

    IdleState getIdleState() const;

    struct StopOutcome
    {
        bool stopped = false;
        juce::String reason;         // always a sentence, whichever way it went
        int  port = 0;               // where it was, 0 when there was nothing
        int  pid = 0;                // what was ended, 0 when nothing was
        int  freedMb = -1;           // what it was holding, -1 when unmeasurable
    };

    /** Closes the server if - and only if - Riffsheet started it and nothing on
        this machine is using it or waiting to.

        `trigger` is what gets written to the log beside the outcome, so a reader
        of Console.app can tell the automatic post-job shutdown from the user
        pressing the chip.

        Blocks: it re-probes, kills a process and waits for it. Worker threads
        only. */
    StopOutcome stopIfAllowed (const juce::String& trigger);

    /** The immediate post-job shutdown. Call it from the transcription worker
        the moment a job ends, ANY way it ends, and only AFTER the EngineLock has
        been released - see rule 2 above.

        Cheap and instant when there is nothing to do (no server, or one we
        adopted), which is the path most windows take. Blocks otherwise.
        Worker threads only. */
    StopOutcome stopAfterJob();

    /**
        "Stop it anyway" - the one path that may end a server Riffsheet did NOT
        start, and the only one.

        Everything else in this class refuses such a server on principle, and
        that refusal is right as a DEFAULT: taking down somebody's process
        because we happened to borrow it would be theft. But the refusal was
        also a dead end. A user who force-quits a DAW, leaves a 1.5 GB server on
        port 8222 and no longer has the Terminal window it came from was told
        "close that window yourself" about a window that no longer exists. This
        is that dead end's exit, and it exists only because a human explicitly
        asked for it - nothing in the shell ever calls it on its own.

        WHAT IT PROVES BEFORE IT KILLS ANYTHING. All of it, freshly, after
        taking the machine-wide turn so nothing can start using the server
        underneath the decision:

          1. something is listening on the port we are talking about, and we can
             read WHICH pid - no pid, no kill;
          2. ServerRegistry has NO record of that pid. A record would mean it is
             ours after all, and ours is stopEngine()'s job, not this one;
          3. the process's OWN command line says `muscriptor ... serve` - the
             same two-halves test the reaper uses, so a shell sitting in the
             muscriptor folder or an editor with the source open is never a
             candidate;
          4. it is answering /health as a MuScriptor right now.

        Only then SIGTERM, wait, and SIGKILL if it is still there
        (SystemProbe::terminateProcess). If ANY of the four fails the process is
        left completely alone and `reason` says which one and why.

        It also refuses while anything on this machine is transcribing or queued
        to - an external server is exactly the kind another Riffsheet window may
        be mid-job against, and killing it would destroy their transcription.

        `trigger` goes in the log line beside the outcome. Blocks: probes,
        shells out and waits on a process. Worker threads only. */
    StopOutcome stopExternalServer (const juce::String& trigger);

    //==============================================================================
    struct TranscribeOptions
    {
        /** Restricts the model's output to these instrument groups. Empty means
            "anything". For a bass riff, {"electric_bass"}. Unknown name -> 400. */
        juce::StringArray instruments;

        /** "best-effort" (default), "true" (fail if no grid), "false" (skip). */
        juce::String detectTempo = "best-effort";

        /** Stable per-plugin-instance id. The server runs ONE transcription at a
            time: a resubmit with the same id preempts, a different id gets 503. */
        juce::String clientId;
    };

    struct TranscribeCallbacks
    {
        /** completed/total 5-second chunks. */
        std::function<void (int, int)> onProgress;
        /** Return true to abandon the stream. */
        std::function<bool()> shouldCancel;
    };

    /** Runs a transcription and assembles the SSE stream into one object:

            { notes: [ { pitch, start, end, instrument, index } ],
              beatGrid: { bpm, beatsPerBar, firstDownbeat, beats? } | null,
              onsetDelay: <seconds>,
              midiBase64: "<standard midi file>",
              truncated: <bool> }

        `onsetDelay` is already subtracted from every note time (the raw SSE
        times run late against the beat grid; the server's own MIDI export
        corrects for it, so we do too).

        Returns a void var and fills `error` on failure. */
    juce::var transcribe (const juce::File& audioFile,
                          const TranscribeOptions& options,
                          TranscribeCallbacks callbacks,
                          juce::String& error);

    /*  GONE IN WAVE 4: analyseBeats().

        It ran a beat_this sidecar written to /tmp with MUSCRIPTOR'S OWN
        interpreter, which made precise beat tracking a thing only a user with a
        MuScriptor venv could have - so the built-in engine could not offer it at
        all. Beat tracking is now BeatTracker::analyse(), a free function over a
        bundled ONNX model that every engine can call, and this class is back to
        being only what MuScriptor-the-note-engine needs. See
        shell/Source/engines/beats/BeatTracker.h. */

    /** The 35 instrument-group names the server accepts, fetched from
        GET /instruments (cached). Empty if the server is unreachable. */
    juce::StringArray getInstruments();

    void stop();

private:
    juce::File getServerExecutable() const;
    juce::var  httpGetJson (int port, const juce::String& path, int timeoutMs, juce::String& error) const;
    bool       spawn (juce::String& error);
    void       setError (const juce::String& message);

    /** Re-runs 'auto' against what is installed and how much RAM is free. */
    void       refreshResolvedModel();
    /** Looks up who is listening on `port`, what --model they were given,
        whether Riffsheet is the one that started them, and how much memory
        they are holding. Shells out; worker threads only. */
    void       identifyServerOnPort (int port, bool startedByUs);
    /** Forgets everything cached about a server that is no longer there. */
    void       clearServerFacts();
    /** SIGTERM/SIGKILL for a server another Riffsheet window started, after
        re-proving from its own command line that it really is one. Returns
        true if it was ours to kill and is now gone. */
    bool       killIdentifiedServer (int pid);
    /** True when the server on the wire is one Riffsheet started - this object,
        another window, or a previous run whose orphan we took over. Atomics
        only, so it is safe and cheap on the message thread. */
    bool       weStartedTheServer() const noexcept;
    /** When this server last had anything to do: the later of "this machine last
        finished a transcription" and "Riffsheet started this server". Only ever
        reported, never a decision - nothing waits on a clock any more. */
    double     idleSinceMs() const;

    mutable juce::CriticalSection configLock;
    Config config;
    /** Where discovery looked, in order. Written by rediscoverEngine() - at
        construction and again whenever the setup screen asks - and read from
        other threads, so it lives under configLock with the path it produced. */
    juce::StringArray venvSearchPaths;
    juce::String configuredModel { "auto" };

    std::atomic<State> state { State::stopped };
    std::atomic<int> activePort { 0 };
    std::atomic<bool> adopted { false };

    mutable juce::CriticalSection errorLock;
    juce::String lastError;

    // What we believe about the weights on the wire. Written on a worker thread
    // when a server is started or adopted, read from the message thread by
    // engineStatus(), so it takes a lock.
    mutable juce::CriticalSection modelLock;
    juce::String resolvedModel { "small" };
    juce::String modelReason;
    juce::String runningModelDescription;
    juce::String runningModelSource { "nothing is running yet" };
    /** "" unless the size on the wire was PROVED - see getRunningModelSize(). */
    juce::String runningModelSize;

    bool haveLiveChild() const;

    mutable juce::CriticalSection startLock;    // serialises ensureRunning()

    /** The server process we launched - null when we adopted someone else's.

        A ChildProcessSupervisor rather than a juce::ChildProcess, and the
        difference is two bugs. It reads the child's stdout and stderr
        CONTINUOUSLY, from the moment of launch: this was a bare ChildProcess
        started with both pipes attached and drained exactly once, in the error
        path, after the child had already died - so a server that printed more
        than a pipe buffer's worth of model-loading chatter blocked inside its
        own imports, never bound its port, and was reported as "took too long to
        start" while sitting there holding a gigabyte. And it kills and reaps in
        its destructor, so a startup that is cancelled or times out cannot leave
        the process behind simply because the code path forgot to. */
    std::unique_ptr<ChildProcessSupervisor> child;
    /** The pid of the server this object is responsible for killing, which is
        NOT always `child`: an orphan left by a force-quit gets taken over by pid
        so that this run's clean shutdown finally clears it up. */
    std::atomic<int> ownedServerPid { 0 };
    std::atomic<bool> reapDone { false };
    juce::String startupLog;

    juce::CriticalSection instrumentsLock;
    juce::StringArray cachedInstruments;

    //==============================================================================
    // Cached facts about whatever is on the wire, written on a worker thread by
    // identifyServerOnPort() and read from the message thread by getIdleState().
    // Atomics rather than a lock because engineStatus() reads them from every
    // open window and must never so much as pause the UI.

    std::atomic<int>    serverPid { 0 };            // who is listening on activePort
    std::atomic<int>    serverMemoryMb { -1 };      // its resident size, -1 unknown
    std::atomic<bool>   registryOwned { false };    // ServerRegistry says Riffsheet started it
    std::atomic<double> ourServerSinceMs { 0.0 };   // when Riffsheet started it, 0 unknown
    /** The last probe read a command line saying `muscriptor ... serve`. Kept
        separately from `registryOwned` because the two proofs are independent:
        this one is true of the user's own server as well as of ours, which is
        exactly what makes it the right half to show a "stop it anyway" button
        from. Never sufficient on its own to kill anything. */
    std::atomic<bool>   serverLooksLikeMuScriptor { false };
    /** The server on the wire was recognised by its HTTP handshake alone,
        because the operating system would not name the process behind the port.
        Enough to report it; never enough to send it audio or to end it. */
    std::atomic<bool>   handshakeIdentifiedOnly { false };

    // There is deliberately no timer and no watchdog thread in here any more.
    // The engine's whole life is bracketed by one transcription job on one
    // worker thread - ensureRunning() at the front, stopAfterJob() at the back -
    // so there is nothing left for a background lifecycle to own, and two
    // mechanisms that could both decide to stop a server is exactly the sort of
    // thing that ends up racing.

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MuScriptorServer)
};
