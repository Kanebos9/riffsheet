#pragma once
#include <JuceHeader.h>
#include <map>
#include <memory>
#include "PcmStore.h"
#include "MuScriptorServer.h"
#include "TrackCapture.h"
#include "engines/EngineRegistry.h"

/**
    Riffsheet's audio processor.

    It does three jobs:
      - plays back the original recording (the "original" side of the webcore
        crossfader) through the host, with a host-automatable gain;
      - passes the track's own audio through untouched, so dropping Riffsheet on
        a bass track is harmless;
      - reads the host playhead so the web UI gets the DAW's tempo and time
        signature for free.

    It also owns the two long-lived services the UI needs - the decoded-audio
    store and the MuScriptor server - because they must outlive the editor.
    Closing the plugin window must not kill a transcription in flight.
*/
class RiffsheetAudioProcessor final : public juce::AudioProcessor,
                                      private juce::AsyncUpdater
{
public:
    RiffsheetAudioProcessor();
    ~RiffsheetAudioProcessor() override;

    //==============================================================================
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override  { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return "Default"; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    //==============================================================================
    // Services shared with the editor / bridge
    PcmStore& getPcmStore() noexcept { return pcmStore; }
    MuScriptorServer& getMuScriptor() noexcept { return muScriptor; }

    /** Every engine this build can drive, and what `auto` means right now.

        It lives here for the same reason the MuScriptor server does: the
        adapters must outlive the editor, because closing the plugin window may
        not kill a transcription in flight. `getMuScriptor()` stays - the beat
        sidecar still needs the server directly until wave 4 moves beat tracking
        onto a bundled model. */
    EngineRegistry& getEngines() noexcept { return engines; }

    //==============================================================================
    /**
        Who is using which take.

        `PcmStore` holds weak references now (see its header): a take lives
        exactly as long as somebody holds a `shared_ptr` to it. That works for
        C++ callers, but the web app addresses audio by TOKEN - a string - over
        `/native/pcm/<token>.f32` and `playbackLoad(token)`. A string is not a
        reference, so without the two holds below a take would be destroyed the
        instant the shell finished answering the call that created it.

        THESE LIVE ON THE PROCESSOR, NOT THE EDITOR, and that is the whole point.
        In REAPER, clicking another track destroys the editor, the WebView and
        every JS object in it. A hold that lived on the editor would take the
        user's take with it and re-open the amnesia bug the project already fixed
        once (design notes §5.5). A plugin whose window is shut still owns its take.

        Two holds, deliberately:

          - the AUTOMATIC one. Whatever token the shell most recently handed to
            the page is kept alive until the shell hands out another or the page
            makes a declarative pcmRetain() call. So a page that never calls
            pcmRetain() still works, and there is no window between "here is
            your token" and "I am using that token".
          - the DECLARED one. pcmRetain() sets the exact set of tokens the page
            is using; anything not in that set is dropped. Declarative rather
            than paired retain/release on purpose: a page that crashes halfway
            through swapping takes cannot leak, because the next declaration
            sweeps up.

        Neither is a cap and nothing is evicted. Both are released when the take
        is replaced, when the page says so, or when the plugin instance dies.
    */
    struct PcmHoldResult
    {
        juce::StringArray held;      // what the session holds now
        juce::StringArray unknown;   // asked for, but no such live token
        juce::StringArray dropped;   // let go by this call
    };

    /** Keeps the most recently handed-out take alive. Called by the bridge from
        every path that returns a token to the page. */
    void noteHandedOut (std::shared_ptr<const PcmStore::Entry> entry);

    /** The page's declared set, replacing whatever it declared before and
        superseding the provisional automatic handoff. */
    PcmHoldResult setSessionPcmTokens (const juce::StringArray& tokens);

    /** Removes `tokens` from the declared set; an empty array releases all. */
    PcmHoldResult releaseSessionPcmTokens (const juce::StringArray& tokens);

    juce::StringArray getSessionPcmTokens() const;
    juce::String getHandedOutToken() const;

    //==============================================================================
    // Original-file transport, driven from the web UI. All safe to call from
    // the message thread; processBlock only ever reads.
    struct PlaybackStatus
    {
        bool   loaded      = false;
        bool   isPlaying   = false;
        double positionSec = 0.0;
        double lengthSec   = 0.0;
        float  gain        = 1.0f;
        juce::String token;
    };

    /** Audio-thread counters, so a "playback stalled" report can be answered
        with numbers instead of guesses. Deliberately NOT part of PlaybackStatus:
        that struct is pushed to the web app 20 times a second and is
        change-gated, and counters that move every block would turn the gate
        into a firehose. Pull these on demand instead. */
    struct PlaybackDiagnostics
    {
        juce::uint64 blocksRendered      = 0;   // blocks that actually mixed audio
        juce::uint64 blocksSkippedLocked = 0;   // try-lock failed -> silence for that block
        juce::uint64 blocksSkippedEmpty  = 0;   // playing, but nothing loaded
        double       sampleRate          = 0.0;
    };

    PlaybackDiagnostics getPlaybackDiagnostics() const;

    /** Loads a decoded PcmStore entry into the transport.

        An EMPTY token unloads: the transport stops, and it lets go of the take
        it was holding. That matters now that the transport is one of the things
        keeping a take in memory - loading a MIDI file over a wav used to leave
        the wav's ~100 MB held by a transport nobody was listening to. */
    bool loadPlaybackToken (const juce::String& token, juce::String& error);

    /** Stops and releases whatever the transport holds. */
    void unloadPlayback();

    /** The token the transport is holding, or empty. */
    juce::String getPlaybackToken() const;

    void playbackPlay();
    void playbackPause();
    void playbackStop();
    void playbackSeek (double seconds);
    void setPlaybackGain (float linearGain);
    PlaybackStatus getPlaybackStatus() const;

    //==============================================================================
    /**
        The host playhead, copied field for field with NOTHING invented.

        Every optional the host may or may not fill in gets its own `has*` flag,
        because "the host said nothing" and "the host said zero" are different
        answers and the difference is the whole of punch-list item 5. JUCE's
        wrappers are strict pass-through - the VST3 wrapper only sets bpm when
        the host raised kTempoValid and only sets the time signature when it
        raised kTimeSigValid, with no rounding and no power-of-two check on the
        denominator, so 3/6 arrives as 3/6. Every 4/4 and every 120 BPM in JUCE
        is a DEFAULT that somebody's fallback supplied, never a transformation.
        Nothing here uses orFallback() for that reason.
    */
    struct HostInfo
    {
        /** False until the host has given us a playhead position at all. */
        bool   hasPosition = false;

        bool   isPlaying = false;
        bool   isRecording = false;
        bool   isLooping = false;

        bool   hasTempo = false;
        double bpm = 0.0;

        bool   hasTimeSig = false;
        int    timeSigNumerator = 0;
        int    timeSigDenominator = 0;

        bool   hasPpq = false;
        double ppqPosition = 0.0;

        bool   hasPpqOfLastBarStart = false;
        double ppqOfLastBarStart = 0.0;

        bool   hasTimeInSeconds = false;
        double timeInSeconds = 0.0;

        bool   hasTimeInSamples = false;
        juce::int64 timeInSamples = 0;

        bool   hasBarCount = false;
        juce::int64 barCount = 0;

        bool   hasEditOrigin = false;
        double editOriginTime = 0.0;

        bool   hasLoopPoints = false;
        double loopStartPpq = 0.0;
        double loopEndPpq = 0.0;

        bool   hasFrameRate = false;
        int    frameRate = 0;

        /** True when the host gave us a playhead carrying something musically
            usable - a tempo or a bar position. A host that reports only a sample
            count has a playhead but no timeline. */
        bool hasUsableTimeline() const noexcept { return hasPosition && (hasTempo || hasPpq); }
    };

    HostInfo getHostInfo() const;

    //==============================================================================
    // Track capture: transcribe what the DAW track is playing, no export needed.
    struct CaptureResult
    {
        bool ok = false;
        juce::String error;
        std::shared_ptr<const PcmStore::Entry> entry;
        /** Durable WAV written under SystemProbe::takesDirectory(). Empty until
            persistCapturedTake() completes on the bridge worker. */
        juce::File path;
        juce::var context;      // host timeline; see TrackCapture::buildContext
        bool hitLimit = false;
    };

    bool captureStart (bool armToTransport, double maxSeconds, juce::String& error);
    CaptureResult captureStop();
    /** Finish a capture by writing its durable WAV. Safe on a worker thread;
        deliberately separate from captureStop() so the DAW message thread is
        never blocked writing a several-minute take. */
    bool persistCapturedTake (CaptureResult& result);
    TrackCapture& getCapture() noexcept { return capture; }

    //==============================================================================
    /** Editor size, persisted with the plugin state so a reopened window (or a
        reloaded session) comes back exactly as the user left it. */
    juce::Point<int> getEditorSize() const;
    void setEditorSize (juce::Point<int> size);

    //==============================================================================
    /** The web app's own per-instance state, as an opaque JSON string.

        THIS IS WHY IT LIVES ON THE PROCESSOR. In REAPER, clicking another track
        or another FX destroys the plugin editor, and with it the WebView and
        every byte of JavaScript state - the loaded take, the engraved score, the
        user's edits. The processor is the only thing that outlives that, so the
        page hands its state down here on every meaningful change and asks for it
        back on boot (getPersistedState / setPersistedState in BRIDGE.md).

        It is deliberately opaque: the shell never parses it. webcore owns the
        schema and versions it itself, so the two can change independently.

        Because it is also written into getStateInformation(), the same blob is
        what makes a saved-and-reloaded DAW project come back with the sheet on
        screen. */
    juce::String getPersistedWebState() const;

    /** Stores the page's state blob. Returns false and keeps the previous blob
        if `json` is larger than maxPersistedWebStateBytes - a runaway page must
        not be able to bloat the user's project file without being told. */
    bool setPersistedWebState (const juce::String& json);

    /** 8 MB. A riff's notes, peaks and edit log come to a few tens of KB; the cap
        exists to catch a bug, not to constrain honest use. */
    static constexpr int maxPersistedWebStateBytes = 8 * 1024 * 1024;

private:
    /** setStateInformation() may be called off the message thread. Defer the
        open-editor refresh so getActiveEditor() and WebView access stay on it. */
    void handleAsyncUpdate() override;

    /** Publishes `entry` (or nothing) to the audio thread. Pass by value: the
        displaced entry is released AFTER the lock, which matters when releasing
        it is a 100 MB free. */
    void updateTransportSourceFor (std::shared_ptr<const PcmStore::Entry> entry);

    PcmStore pcmStore;
    MuScriptorServer muScriptor;
    /** Declared after the server it wraps: the MuScriptor adapter registered in
        the constructor holds a reference to `muScriptor`, so the server must be
        constructed first and destroyed last. */
    EngineRegistry engines;

    // --- transport -----------------------------------------------------------
    //
    // THERE IS NO SECOND COPY OF THE AUDIO HERE ANY MORE. This used to hold a
    // full `juce::AudioBuffer<float>` copied out of the PcmStore entry, so every
    // take existed twice natively - ~212 MB for a ten-minute mono take before
    // the web UI's own Float32 copy was counted. The transport now plays the
    // shared immutable entry itself.
    //
    // How that stays safe on the audio thread: `loadedEntry` is only ever
    // assigned under `playbackLock` by the message thread, and `processBlock`
    // holds the same lock (try-only) for the whole time it reads. So the samples
    // cannot be freed while a block is mixing. The audio thread reads the three
    // plain values below and NEVER copies, resets or destroys the shared_ptr -
    // a refcount decrement that happened to be the last one would run ~Entry
    // (a large free, plus a file delete) on the audio thread.
    juce::CriticalSection playbackLock;
    std::shared_ptr<const PcmStore::Entry> loadedEntry;
    const float* playbackSamples = nullptr;           // into loadedEntry->mono, published under the lock
    int64_t playbackNumSamples = 0;
    double playbackBufferRate = 0.0;
    int64_t playbackPositionSamples = 0;              // in the entry's own rate
    std::atomic<bool> playing { false };
    std::atomic<float> playbackGain { 1.0f };
    // Audio-thread only (relaxed): see PlaybackDiagnostics.
    std::atomic<juce::uint64> blocksRendered { 0 };
    std::atomic<juce::uint64> blocksSkippedLocked { 0 };
    std::atomic<juce::uint64> blocksSkippedEmpty { 0 };
    juce::LinearSmoothedValue<float> smoothedGain { 1.0f };
    double currentSampleRate = 44100.0;

    TrackCapture capture;

    // --- who is using which take (see the PcmHoldResult comment above) -------
    // Message thread only in practice, but a decode finishes on the worker pool,
    // so it takes a lock like everything else shared across threads here.
    mutable juce::CriticalSection pcmHoldLock;
    std::shared_ptr<const PcmStore::Entry> handedOutEntry;
    std::map<juce::String, std::shared_ptr<const PcmStore::Entry>> sessionHolds;

    mutable juce::CriticalSection editorSizeLock;
    // {0,0} means "the user has never sized this instance", which is what makes
    // RiffsheetAudioProcessorEditor's defaultEditorWidth/Height the ONE place the
    // first-open size is defined. Seeding a real size here instead (it used to be
    // 1180x760) silently outvoted those constants - stored.x was always > 0, so
    // the editor's defaults were dead code and changing them did nothing.
    juce::Point<int> editorSize { 0, 0 };

    // The web app's state blob. Written from the message thread (a native
    // function call) and read from wherever the host asks for plugin state, so
    // it takes a lock like everything else shared across threads here.
    mutable juce::CriticalSection webStateLock;
    juce::String persistedWebState;

    // --- host playhead snapshot ---------------------------------------------
    mutable juce::CriticalSection hostInfoLock;
    HostInfo lastHostInfo;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (RiffsheetAudioProcessor)
};
