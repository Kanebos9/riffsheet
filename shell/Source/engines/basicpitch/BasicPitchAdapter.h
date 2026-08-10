#pragma once
#include <JuceHeader.h>
#include <memory>
#include <mutex>
#include "EngineAdapter.h"

class OrtSession;

/**
    Engine #2: Spotify's Basic Pitch, in this process, with nothing to install.

    THIS IS THE ENGINE THAT MAKES A FRESH MACHINE WORK. No venv, no Python, no
    server, no port, no download and no licence to accept: the 225 KiB model is
    compiled into the binary and the runtime is statically linked, so `status()`
    is `ready` from the first launch and can only stop being ready if the build
    itself is broken.

    THE ONE-JOB RULE, and what it means for an engine that owns almost nothing.
    prepare() builds the Ort::Session, endOfJob() destroys it. It would be
    tempting to keep the session alive between jobs - it costs about a hundred
    milliseconds to build - but that would make this the one adapter that does
    not give back what it took, and "same shape, no exceptions to reason about"
    is worth more than 100 ms on a job that lasts seconds. It also keeps the
    steady-state footprint of eight plugin instances at zero.

    NO MACHINE-WIDE LOCK. The manifest says Concurrency::inProcess, so
    NativeBridge does not take EngineLock for this engine and does not queue it
    behind MuScriptor. What serialises it is EngineRegistry::LocalJob, a
    process-local mutex - see engine-architecture.md §1.3b for why the file lock
    would turn the always-available fallback into the slowest path in the app.
*/
class BasicPitchAdapter final : public EngineAdapter
{
public:
    BasicPitchAdapter();
    ~BasicPitchAdapter() override;

    const EngineManifest& manifest() const noexcept override;
    Capabilities capabilities() const override;
    Status status() const override;
    void rediscover() override;

    bool prepare (std::function<void (const juce::String&)> onProgress,
                  std::function<bool()> shouldCancel) override;
    void endOfJob() override;

    juce::var transcribe (const AudioInput& input,
                          const Request& request,
                          Callbacks callbacks,
                          juce::String& error) override;

    /** Milliseconds the last transcribe() spent inside ORT, and how many model
        windows that was. Reported in status().extra so BUILDING.md's timing
        table can be refreshed without a profiler. */
    struct LastRun
    {
        int windows = 0;
        double inferenceMs = 0.0;
        double totalMs = 0.0;
        int notes = 0;
    };

private:
    const EngineManifest& row;

    mutable std::mutex stateLock;
    std::unique_ptr<OrtSession> session;
    juce::String lastError;
    juce::String provider { "CPU" };
    LastRun lastRun;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (BasicPitchAdapter)
};
