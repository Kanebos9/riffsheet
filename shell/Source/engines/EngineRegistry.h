#pragma once
#include <JuceHeader.h>
#include <atomic>
#include <memory>
#include <mutex>
#include <vector>
#include "EngineAdapter.h"
#include "EngineCatalog.h"
#include "EngineSettings.h"

/**
    One job's worth of the adapter contract, with endOfJob() guaranteed.

        prepare() -> transcribe() -> endOfJob()

    and endOfJob() gives back whatever prepare() took, every time, however the
    job ended - success, engine error, cancel, or an exception on the way past.

    WHY IT IS A CLASS AND NOT FOUR LINES IN THE TRANSCRIBE JOB. The lambda in
    NativeBridge.cpp cannot be unit-tested: that file needs a plugin host to
    link. "The engine is always given back" is exactly the promise that must not
    rot silently, so it lives in a class the test binary can drive with a fake
    adapter and prove on all three exits. The bridge holds one of these inside
    its EndOfJob scope, declared so that the machine-wide lock is released
    FIRST and this destructor runs immediately after - which is the queue rule
    (see NativeBridge::fnTranscribe).

    Worker threads only: every call blocks.
*/
class EngineJob
{
public:
    explicit EngineJob (EngineAdapter& adapterToUse) : adapter (adapterToUse) {}

    /** Gives the engine back. Runs exactly once, whatever happened. */
    ~EngineJob()
    {
        // Never throws, by contract - a throwing endOfJob() during stack
        // unwinding would take the process with it.
        adapter.endOfJob();
    }

    bool prepare (std::function<void (const juce::String&)> onProgress,
                  std::function<bool()> shouldCancel)
    {
        prepared = adapter.prepare (std::move (onProgress), std::move (shouldCancel));
        return prepared;
    }

    juce::var transcribe (const EngineAdapter::AudioInput& input,
                          const EngineAdapter::Request& request,
                          EngineAdapter::Callbacks callbacks,
                          juce::String& error)
    {
        // Calling this without a successful prepare() is a programming error,
        // not a user-visible state: every adapter is allowed to assume the
        // engine it asked for is there.
        jassert (prepared);
        return adapter.transcribe (input, request, std::move (callbacks), error);
    }

    EngineAdapter& getAdapter() noexcept { return adapter; }

private:
    EngineAdapter& adapter;
    bool prepared = false;

    JUCE_DECLARE_NON_COPYABLE (EngineJob)
};

/**
    Every engine this build can drive, and what `auto` means right now.

    It lives on the processor beside the MuScriptor server, because the adapters
    must outlive the editor for exactly the reason the server does: closing the
    plugin window may not kill a transcription in flight.

    WHAT `auto` MEANS, and why it is that. The first engine in
    EngineCatalog::autoOrder() that is present on this machine - today
    Riffsheet's own in-page engine, then MuScriptor, then the bundled fallback.
    The ORDER and the argument for it live in the catalogue, deliberately: this
    class walks a list it does not own, so "which engine is best" stays one
    decision in one place. An explicit choice is honoured whenever that engine is
    on this machine; when it is not, resolution falls back along the same order
    and `reason` says why, in a sentence a person can read - the same shape as
    configuredModel/resolvedModel/modelReason.

    THE `nativeOnly` FLAG, and why resolution has two answers. Riffsheet's own
    engine does not run in this process at all (AdapterKind::inPageClient): the
    page has the samples and runs it there. So there are two honest answers to
    "which engine is this?" - the one the USER is on, which is what the picker
    and every card must show, and the one THIS PROCESS would use if it were
    asked to transcribe, which is what fnTranscribe needs. `resolve(true)` gives
    the second by skipping in-page engines. It is also exactly the chain a take
    falls through to when the in-page engine refuses a chord, which is why the
    page is told the answer (`nativeFallbackEngine` in listEngines) rather than
    re-deriving the order for itself.

    WHY A NOT-INSTALLED CHOICE STILL RESOLVES TO ITSELF WHEN THERE IS NO
    ALTERNATIVE. Falling back to an engine that is equally unavailable would
    replace one honest error ("MuScriptor was not found - here is where I
    looked") with a vaguer one. If nothing in the build can transcribe, the user
    is better served by the chosen engine's own failure.

    THE IN-PROCESS MUTEX. Engines whose manifest says EngineConcurrency::inProcess do
    not take the machine-wide EngineLock - see engine-architecture.md §1.3b: the
    lock exists for a 1.5 GB server that answers a second client with HTTP 503,
    and queueing a 30 MB in-process inference behind a four-minute MuScriptor job
    would make the always-available fallback the slowest path in the app. What
    they do take is the mutex below, so eight plugin instances in one REAPER
    build one session at a time rather than eight. `localBusy` is what makes such
    a job visible to engineStatus().busy even though it holds no file lock.

    THREADING. add() is construction-time. resolve()/find()/all() take the list
    lock and are cheap enough for the message thread (they stat a few files, the
    same as engineStatus() already does). LocalJob blocks and belongs on a worker
    thread.
*/
class EngineRegistry
{
public:
    /** Uses the process-wide <appSupport>/engine.json. */
    EngineRegistry();

    /** For tests, which must not touch the user's real settings. */
    explicit EngineRegistry (EngineSettings& settingsToUse);

    /** Registers an adapter. Construction time only: nothing here is designed
        to have engines appear and disappear while jobs are resolving. */
    void add (std::unique_ptr<EngineAdapter> adapter);

    EngineAdapter* find (const juce::String& id) const;
    std::vector<EngineAdapter*> all() const;

    //== resolution ============================================================

    struct Resolution
    {
        juce::String configured;    // 'auto' | '<id>' - what the user asked for
        juce::String resolved;      // what that means right now; always a real id
        juce::String reason;        // one plain sentence
        EngineAdapter* adapter = nullptr;   // null only when no adapter is registered
    };

    /** What `auto` (or the stored choice) means at this instant.

        `nativeOnly` skips engines that execute in the web view - pass it from
        anything that is about to drive an engine IN THIS PROCESS, and leave it
        false for anything that is reporting the user's choice back to them. */
    Resolution resolve (bool nativeOnly = false) const;

    /** As resolve(), but for one explicit id - the per-transcription override
        (`transcribe({ engineId })`). An id that is unknown, not offered, or has
        no adapter in this build comes back with `adapter == nullptr` and a
        `reason` that says which of those it was. */
    Resolution resolveExplicit (const juce::String& id) const;

    /** 'auto' or an engine id, from RIFFSHEET_ENGINE or engine.json. */
    juce::String configuredEngine() const;

    struct SelectOutcome
    {
        bool ok = false;
        juce::String error;      // set when ok == false
        Resolution resolution;   // the answer after the change
    };

    /** Stores the choice. Refuses an unknown or unoffered id; does NOT refuse
        an engine that is merely not installed yet - that is how the card's
        "Select" affordance works alongside "Install", and resolution then falls
        back with a reason. Refusing while a job runs is the bridge's business,
        not this class's. */
    SelectOutcome select (const juce::String& id);

    //== in-process serialisation ==============================================

    /** RAII. Serialises in-process inference across every plugin instance in
        this process, and marks the app busy while it runs. Blocks in the
        constructor - worker threads only. */
    class LocalJob
    {
    public:
        explicit LocalJob (EngineRegistry& owner);
        ~LocalJob();

    private:
        EngineRegistry& registry;
        std::unique_lock<std::mutex> held;

        JUCE_DECLARE_NON_COPYABLE (LocalJob)
    };

    /** True while an in-process job is running here. engineStatus() reports
        `busy = lock.busy || localBusy`, so an in-process job is visible even
        though it holds no machine-wide lock. */
    bool isLocalBusy() const noexcept { return localBusy.load (std::memory_order_acquire); }

    //== wire spellings ========================================================

    /** 'ready' | 'installed' | 'not-installed' | 'broken'. */
    static juce::String stateName (EngineAdapter::Availability availability);

    /** Is this engine ON THIS MACHINE - so that resolution will try it?

        `broken` counts. It means the engine is installed and its last start
        failed, and the user who installed it is far better served by that
        engine's own error ("the server exited while starting; here is its
        output") than by being moved silently onto a different engine whose
        results are different. It is also exactly what `engineStatus`'s
        long-standing `engineInstalled` field has always reported - the
        executable exists - so keeping the two the same keeps that field's
        meaning unchanged. */
    static bool isPresent (EngineAdapter::Availability availability) noexcept
    {
        return availability != EngineAdapter::Availability::notInstalled;
    }

private:
    /** The `auto` rule, plus the sentence explaining it. */
    Resolution chooseAutomatically (const juce::String& configured, bool nativeOnly) const;
    EngineAdapter* findLocked (const juce::String& id) const;
    static juce::String displayName (const EngineAdapter& adapter);

    EngineSettings& settings;

    mutable std::mutex listLock;
    std::vector<std::unique_ptr<EngineAdapter>> adapters;

    std::mutex inProcessLock;
    std::atomic<bool> localBusy { false };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EngineRegistry)
};
