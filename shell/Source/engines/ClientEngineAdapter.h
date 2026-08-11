#pragma once
#include <JuceHeader.h>
#include "EngineAdapter.h"
#include "EngineCatalog.h"

/**
    An engine that runs in the WEB VIEW, seen from the shell.

    THE ONE THING IT DOES is exist. Riffsheet's own transcriber is TypeScript in
    the page (webcore/src/audio/riffsheetEngine.ts) and the samples it listens to
    are already on that side of the bridge, so there is nothing here to drive.
    But the user's engine choice, the picker, `auto`, the cards and
    `listEngines()` all live in the shell, and a second mechanism just for one
    engine would be a second thing to keep in step and a second thing to get out
    of step. So the engine gets a row and an adapter like everything else, and
    this class answers the three questions the registry actually asks:

        manifest()     - the compiled-in row
        capabilities() - straight off that row
        status()       - ALWAYS `ready`. It ships inside the web bundle the app
                         cannot start without, so there is no state in which the
                         app is running and this engine is not installed. No
                         discovery, no probing, no files to stat.

    ...and refuses the one it must never be asked:

        transcribe()   - fails with a sentence saying where the engine actually
                         runs. This is a CATEGORY ERROR, not an engine failure,
                         and it is unreachable through the normal path:
                         EngineRegistry::resolve(true) skips in-page engines, so
                         fnTranscribe resolves past this one to whatever the
                         shell can really drive. It is implemented, rather than
                         asserted away, because "unreachable" is a claim about
                         today's callers and a wrong answer here would be a
                         silent one.

    prepare()/endOfJob() are honest no-ops: prepare() takes nothing, so
    endOfJob() has nothing to give back.
*/
class ClientEngineAdapter final : public EngineAdapter
{
public:
    explicit ClientEngineAdapter (const EngineManifest& rowToUse) : row (rowToUse)
    {
        jassert (EngineCatalog::runsInPage (row));
    }

    const EngineManifest& manifest() const noexcept override { return row; }

    Capabilities capabilities() const override
    {
        Capabilities out;
        // No instrument list: it does not take a constraint and it does not
        // claim a set of instruments it was trained on, because it was not
        // trained at all. An empty list already reads as "anything it hears".
        out.producesBeatGrid   = row.producesBeatGrid;
        out.producesTrueBeats  = false;
        out.producesConfidence = row.producesConfidence;
        out.producesVelocity   = row.producesVelocity;
        out.acceptsInstrumentConstraint = row.acceptsInstrumentConstraint;
        out.needsGainNorm      = row.needsGainNorm;
        out.needsTuningNorm    = row.needsTuningNorm;
        out.preferredInputRate = row.preferredInputRate;
        return out;
    }

    Status status() const override
    {
        Status out;
        out.availability = Availability::ready;
        out.stateName = "ready";
        out.location = "built in - runs in the Riffsheet window";
        out.detail = "Riffsheet's own engine. It listens in the app itself, so there is nothing "
                     "to install and nothing to start.";
        return out;
    }

    void rediscover() override {}

    bool prepare (std::function<void (const juce::String&)>, std::function<bool()>) override
    {
        return true;
    }

    void endOfJob() override {}

    juce::var transcribe (const AudioInput&, const Request&, Callbacks, juce::String& error) override
    {
        error = manifestText (row.name) + " runs in the Riffsheet window, not in the audio plugin, "
                "so it cannot be driven from here.";
        return {};
    }

private:
    const EngineManifest& row;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ClientEngineAdapter)
};
