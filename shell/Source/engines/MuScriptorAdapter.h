#pragma once
#include <JuceHeader.h>
#include "EngineAdapter.h"
#include "MuScriptorServer.h"

/**
    Adapter #1: the MuScriptor HTTP server in a venv, behind the common door.

    IT OWNS NOTHING AND CHANGES NOTHING. Every method here is a forward to the
    MuScriptorServer the processor already owns, in the same order and with the
    same arguments the transcribe job used before this interface existed, so the
    engine's behaviour is bit for bit what it was:

        prepare()    -> ensureRunning (onProgress, shouldCancel)
        transcribe() -> transcribe (file, options, callbacks, error)
        endOfJob()   -> stopAfterJob()          (after EngineLock::release())

    MuScriptorServer.h is not edited by this wave at all. That is the whole
    design rule: the 1461 lines that know about SSE framing, adopted servers,
    orphan reaping and the one-job shutdown keep their behaviour, and everything
    new is a new file plus a row in EngineCatalog.

    NOT HERE ON PURPOSE: beat tracking. It used to be a Python sidecar run with
    MuScriptor's own interpreter, so a user on the built-in engine could not have
    precise beats at all. It is now BeatTracker - a bundled ONNX model in this
    process, available to every engine - and the bridge calls it directly after
    whichever adapter did the transcription. Putting it on this interface would
    put the coupling that was deleted back.
*/
class MuScriptorAdapter final : public EngineAdapter
{
public:
    explicit MuScriptorAdapter (MuScriptorServer& serverToWrap);

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

private:
    MuScriptorServer& server;
    const EngineManifest& row;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MuScriptorAdapter)
};
