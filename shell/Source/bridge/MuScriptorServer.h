#pragma once
#include <JuceHeader.h>

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
        juce::String model = "medium";    // the RESOLVED size actually passed to --model
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

    /** What the user asked for: 'auto', 'small', 'medium' or 'large'.
        'auto' is resolved against what is installed and how much memory this
        machine has (see ModelCatalog) the moment a server is started. */
    void setConfiguredModel (const juce::String& model);
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

    /** Health-probes the reuse ports without starting anything, and updates the
        adopted/port/model reporting. Blocks for up to a couple of seconds -
        worker threads only. */
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
        /** Why it cannot be stopped, as a sentence for a human. Empty when it
            can be. */
        juce::String reason;
    };

    IdleState getIdleState() const;

    struct StopOutcome
    {
        bool stopped = false;
        juce::String reason;         // always a sentence, whichever way it went
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
    juce::String resolvedModel { "medium" };
    juce::String modelReason;
    juce::String runningModelDescription;
    juce::String runningModelSource { "nothing is running yet" };

    bool haveLiveChild() const;

    mutable juce::CriticalSection startLock;    // serialises ensureRunning()
    std::unique_ptr<juce::ChildProcess> child;  // null when we adopted someone else's server
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

    // There is deliberately no timer and no watchdog thread in here any more.
    // The engine's whole life is bracketed by one transcription job on one
    // worker thread - ensureRunning() at the front, stopAfterJob() at the back -
    // so there is nothing left for a background lifecycle to own, and two
    // mechanisms that could both decide to stop a server is exactly the sort of
    // thing that ends up racing.

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MuScriptorServer)
};
