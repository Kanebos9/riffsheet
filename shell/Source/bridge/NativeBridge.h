#pragma once
#include <JuceHeader.h>
#include <map>
#include <set>
#include "WebResources.h"
#include "PcmStore.h"

class RiffsheetAudioProcessor;

/**
    The JS <-> C++ contract. Every native function the web app can call, and
    every event the shell pushes back, is defined here. BRIDGE.md documents the
    same surface for Team B - keep the two in step.

    Threading: JUCE invokes native functions on the message thread. Anything
    that can block is pushed onto a worker pool and completes the JS promise
    from there, which is allowed. Long transcription/OMR subprocess work has a
    separate pool so queue waits cannot starve ordinary native calls.
*/
class NativeBridge final : private juce::Timer
{
public:
    explicit NativeBridge (RiffsheetAudioProcessor& processor);

    /** Forwards an OS drag-and-drop of real files onto the plugin window. */
    void notifyFilesDropped (const juce::StringArray& paths);

    ~NativeBridge() override;

    /** Adds every native function + the resource provider to `options`. */
    juce::WebBrowserComponent::Options configure (juce::WebBrowserComponent::Options options);

    /** Called by the editor once the browser exists, so events can be pushed. */
    void attachWebView (juce::WebBrowserComponent* view);
    void detachWebView();

    /** Cancels and joins every asynchronous operation while the editor's
        WebBrowserComponent (and therefore JUCE's native completion provider)
        is still alive. The editor must call this from its destructor body,
        before member destruction begins. Safe to call more than once. */
    void shutdown();

private:
    using Completion = juce::WebBrowserComponent::NativeFunctionCompletion;

    void timerCallback() override;
    void emit (const juce::Identifier& eventId, const juce::var& payload);

    // --- native functions ----------------------------------------------------
    void fnGetShellInfo      (const juce::Array<juce::var>&, Completion);
    void fnGetHostInfo       (const juce::Array<juce::var>&, Completion);
    void fnPickAudioFile     (const juce::Array<juce::var>&, Completion);
    void fnPickInputFile     (const juce::Array<juce::var>&, Completion);
    void fnLoadAudioPath     (const juce::Array<juce::var>&, Completion);
    void fnLoadAudioBytes    (const juce::Array<juce::var>&, Completion);
    void fnAuthorizeRecentPaths (const juce::Array<juce::var>&, Completion);
    void fnTranscribe        (const juce::Array<juce::var>&, Completion);
    void fnTrackBeats        (const juce::Array<juce::var>&, Completion);
    void fnExportFile        (const juce::Array<juce::var>&, Completion);
    void fnExportFiles       (const juce::Array<juce::var>&, Completion);
    void fnBeginMidiDrag     (const juce::Array<juce::var>&, Completion);
    void fnPlaybackLoad      (const juce::Array<juce::var>&, Completion);
    void fnPlaybackTransport (const juce::Array<juce::var>&, Completion);
    void fnPlaybackSetGain   (const juce::Array<juce::var>&, Completion);
    void fnPlaybackDiagnostics (const juce::Array<juce::var>&, Completion);
    void fnPcmRetain         (const juce::Array<juce::var>&, Completion);
    void fnPcmRelease        (const juce::Array<juce::var>&, Completion);
    void fnPcmDiagnostics    (const juce::Array<juce::var>&, Completion);
    void fnCaptureStart      (const juce::Array<juce::var>&, Completion);
    void fnCaptureStop       (const juce::Array<juce::var>&, Completion);
    void fnCaptureStatus     (const juce::Array<juce::var>&, Completion);
    void fnImportDroppedFile (const juce::Array<juce::var>&, Completion);
    void fnOmrStatus         (const juce::Array<juce::var>&, Completion);
    void fnRecognizeScoreImage (const juce::Array<juce::var>&, Completion);
    void fnLog               (const juce::Array<juce::var>&, Completion);
    void fnGetPersistedState (const juce::Array<juce::var>&, Completion);
    void fnSetPersistedState (const juce::Array<juce::var>&, Completion);
    void fnEngineStatus      (const juce::Array<juce::var>&, Completion);
    void fnRecheckEngine     (const juce::Array<juce::var>&, Completion);
    void fnListEngines       (const juce::Array<juce::var>&, Completion);
    void fnSelectEngine      (const juce::Array<juce::var>&, Completion);
    void fnInstallEngine     (const juce::Array<juce::var>&, Completion);
    void fnCancelInstall     (const juce::Array<juce::var>&, Completion);
    void fnUninstallEngine   (const juce::Array<juce::var>&, Completion);
    void fnValidateExistingEngineInstall (const juce::Array<juce::var>&, Completion);
    void fnOpenEngineSetup   (const juce::Array<juce::var>&, Completion);
    void fnSetEngineModel    (const juce::Array<juce::var>&, Completion);
    void fnStopEngine        (const juce::Array<juce::var>&, Completion);
    void fnStopExternalEngine (const juce::Array<juce::var>&, Completion);
    void fnTranscribeCancel  (const juce::Array<juce::var>&, Completion);
    void fnHostTimelineProbe (const juce::Array<juce::var>&, Completion);

    // --- helpers -------------------------------------------------------------
    /** `fileIsOurTemp` marks browser-provided bytes staged by the shell. They
        are promoted to durable app-support audio before the reply; the staging
        file remains entry-owned and is removed when the entry dies. */
    void decodeAndReply (const juce::File& file, double targetRate, Completion completion,
                         bool fileIsOurTemp = false, juce::String displayNameOverride = {},
                         bool forceOwnedCopy = false);

    /** Bytes in, AudioRef out: stages base64 audio under a unique name in the
        system temp directory and hands it to decodeAndReply() as our own temp.

        The staging file is never in a user folder and never outlives the take -
        decodeAndReply() promotes the decoded audio to durable app-support
        storage, and the staging file stays entry-owned so ~PcmStore::Entry
        deletes it. Shared by importDroppedFile() and loadAudioBytes() so the
        two cannot drift; `stageTag` only distinguishes them in /tmp listings. */
    void stageBytesAndReply (const juce::String& displayName, const juce::String& base64,
                             double targetRate, Completion completion,
                             const juce::String& stageTag);

    /** Describes an entry for the page AND registers the shell's automatic hold
        on it (RiffsheetAudioProcessor::noteHandedOut).

        Not const, and deliberately so: every call site is a handover - the exact
        moment a token leaves C++ for a page that can only hold a string. Doing
        the hold here rather than at each call site is what makes it impossible
        to add a new "returns an AudioRef" path that forgets. */
    juce::var describeEntry (const std::shared_ptr<const PcmStore::Entry>& entry);

    /** Entry count, total bytes and who is holding what. */
    juce::var makePcmStoreVar() const;
    /** Scratch folder for files handed to the OS during a drag. Cleared each
        time, so a session's drags do not pile up in /tmp. */
    juce::File dragScratchDirectory() const;
    /** The engineStatus() payload. Shared with recheckEngine() so the setup
        screen gets one shape of data whether it polled or asked.

        With an empty `id` it answers for the RESOLVED engine, which is what it
        has always done - there was only ever one engine to answer for. With an
        id it answers for that engine, and an unknown id comes back as
        `{ ok:false, error }`. Every field that exists today keeps existing and
        keeps its meaning: the engine-specific half arrives as
        EngineAdapter::Status::extra and is merged over an honest, shared
        default, so a payload for an engine that has no venv says
        `venv: ""` rather than dropping the key and reading as "unknown". */
    juce::var makeEngineStatusVar (const juce::String& id = {});

    /** The listEngines() payload: the compiled-in table plus each adapter's
        cached status(). Pull-only and cheap. */
    juce::var makeEngineListVar();

    /** True while an install job for this engine is in flight in THIS process.
        An install started by another Riffsheet window is not visible here and
        does not need to be: the two would collide on the engine directory, and
        what stops that is the install landing atomically, not a shared flag. */
    bool isInstalling (const juce::String& id) const;
    juce::var makeHostInfoVar() const;
    juce::var makePlaybackVar() const;
    juce::var makeCaptureVar() const;
    static juce::var makeError (const juce::String& message);
    static double optionalRate (const juce::Array<juce::var>& args, int index);
    bool installChooser (std::unique_ptr<juce::FileChooser> next, Completion& completion);
    void finishChooser() noexcept { chooserActive = false; }
    /** Records a file the user chose here, in memory and in the durable
        machine-local record. Called from every picker and drop callback. */
    void authorizeAudioPath (const juce::File& file);

    /** True when this user has chosen this exact file in Riffsheet at some
        point on this machine, or it is a take the app owns. See the long note
        at the top of NativeBridge.cpp for why "at some point" and not "in this
        editor" - the latter is what broke the Recent list. */
    bool isAuthorizedAudioPath (const juce::File& file) const;

    RiffsheetAudioProcessor& proc;
    WebResources resources;

    juce::WebBrowserComponent* web = nullptr;
    juce::CriticalSection webLock;

    juce::ThreadPool workers { juce::ThreadPoolOptions{}.withNumberOfThreads (2)
                                                        .withThreadName ("Riffsheet worker") };
    juce::ThreadPool longWorkers { juce::ThreadPoolOptions{}.withNumberOfThreads (2)
                                                            .withThreadName ("Riffsheet long worker") };
    /** One thread, and its own pool. An engine install downloads for minutes and
        then runs pip for minutes more; putting it on `longWorkers` would let it
        eat one of the two transcription threads, and putting it on `workers`
        would stall every ordinary native call behind it. One thread because two
        simultaneous installs on an 8 GB machine is not a use case, it is a swap
        storm - a second install for a different engine simply queues. */
    juce::ThreadPool installWorkers { juce::ThreadPoolOptions{}.withNumberOfThreads (1)
                                                               .withThreadName ("Riffsheet installer") };
    std::unique_ptr<juce::FileChooser> chooser;
    bool chooserActive = false; // message thread only
    /** Exact paths this user has chosen in Riffsheet: seeded lazily from
        <appSupport>/opened-files.json on a miss, so authorization survives the
        editor teardown a DAW performs on every track click. */
    mutable std::set<juce::String> authorizedAudioPaths;

    juce::String lastPlaybackSignature;
    juce::String lastCaptureSignature;
    juce::String lastHostSignature;
    std::atomic<int> nextJobId { 1 };

    // --- transcription jobs --------------------------------------------------
    /** Per-job cancel flags, shared with the worker so `transcribeCancel` can
        reach a job that is queued behind another machine-wide, not only one that
        is already streaming. shared_ptr because the job outlives the map entry
        whenever it is torn down mid-flight. */
    juce::CriticalSection jobLock;
    std::map<int, std::shared_ptr<std::atomic<bool>>> jobCancels;

    // --- engine installs -----------------------------------------------------
    /** The same shape as jobCancels, for the same reason: cancelInstall must
        reach a job that has not started downloading yet. `installingEngines`
        maps an engine id to its job so a second Install on the same card is
        refused rather than racing, and so listEngines() can say `installing`
        without the page having to remember what it pressed. */
    juce::CriticalSection installLock;
    std::map<int, std::shared_ptr<std::atomic<bool>>> installCancels;
    std::map<juce::String, int> installingEngines;

    /** Raised by shutdown(). It also gates every native-function completion and
        queued event, so neither can call back into a WebView during teardown. */
    std::shared_ptr<std::atomic<bool>> shuttingDown { std::make_shared<std::atomic<bool>> (false) };

    /** Where this instance is in the machine-wide queue: 0 when not waiting,
        1 when next. Reported by engineStatus(). Per bridge rather than per
        process, because two plugin instances in one REAPER have two places. */
    std::atomic<int> queuePosition { 0 };

    /** Rate limiter for the background engine probe kicked off by
        engineStatus(), which shells out and must never run on the caller's
        thread. */
    std::atomic<double> lastEngineProbeMs { 0.0 };
    std::atomic<bool> engineProbeRunning { false };

    JUCE_DECLARE_WEAK_REFERENCEABLE (NativeBridge)
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NativeBridge)
};
