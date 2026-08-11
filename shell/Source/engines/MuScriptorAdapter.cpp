#include "MuScriptorAdapter.h"
#include "EngineCatalog.h"
#include "EngineSettings.h"
#include "ModelCatalog.h"
#include "SystemProbe.h"     // physicalRamMb(), for the per-model RAM table

namespace
{
    const EngineManifest& muScriptorRow()
    {
        // Guaranteed by EngineCatalog.cpp's static_assert: "muscriptor" is the
        // id `auto` prefers, and that id is proved to be in the table at compile
        // time. If this ever fires, the table was renamed without the resolver.
        const auto* row = EngineCatalog::find ("muscriptor");
        jassert (row != nullptr);
        return *row;
    }

    juce::var makeObject (std::initializer_list<std::pair<juce::Identifier, juce::var>> properties)
    {
        auto* object = new juce::DynamicObject();

        for (const auto& property : properties)
            object->setProperty (property.first, property.second);

        return juce::var (object);
    }
}

//==============================================================================
MuScriptorAdapter::MuScriptorAdapter (MuScriptorServer& serverToWrap)
    : server (serverToWrap), row (muScriptorRow())
{
    // EngineSettings spells the path itself so the test binary does not have to
    // link the server. This is the one build that has both, so it is the one
    // place the two spellings can be proved equal.
    jassert (EngineSettings::shared().getFile() == MuScriptorServer::engineConfigFile());
}

const EngineManifest& MuScriptorAdapter::manifest() const noexcept
{
    return row;
}

EngineAdapter::Capabilities MuScriptorAdapter::capabilities() const
{
    Capabilities caps;

    // The 35 group names come from GET /instruments and are cached. Only ask a
    // server that is already answering: getInstruments() blocks for up to three
    // seconds on a port with nothing behind it, and capabilities() is documented
    // as cheap enough for the message thread. The manifest's
    // instrumentStrengths is what the card shows when there is no live server.
    if (server.getState() == MuScriptorServer::State::ready)
        caps.instruments = server.getInstruments();

    caps.producesBeatGrid = row.producesBeatGrid;
    caps.producesTrueBeats = true;   // via BeatTracker: a bundled ONNX model, not this venv
    caps.producesConfidence = row.producesConfidence;
    caps.producesVelocity = row.producesVelocity;
    caps.acceptsInstrumentConstraint = row.acceptsInstrumentConstraint;
    caps.needsGainNorm = row.needsGainNorm;
    caps.needsTuningNorm = row.needsTuningNorm;
    caps.preferredInputRate = row.preferredInputRate;
    return caps;
}

EngineAdapter::Status MuScriptorAdapter::status() const
{
    Status out;

    const auto state = server.getState();
    const auto executable = server.getEngineExecutable();
    const auto idle = server.getIdleState();
    const auto config = server.getConfig();

    out.stateName = [state]
    {
        switch (state)
        {
            case MuScriptorServer::State::stopped:  return "stopped";
            case MuScriptorServer::State::starting: return "starting";
            case MuScriptorServer::State::ready:    return "ready";
            case MuScriptorServer::State::failed:   return "failed";
        }

        return "stopped";
    }();

    out.location = executable.getFullPathName();
    out.port = server.getActivePort();
    out.adopted = server.isAdopted();
    out.error = server.getLastError();
    out.searchedPaths = server.getVenvSearchPaths();

    // "installed" is about the disk, not about whether a server happens to be
    // up: stopped is the normal resting state for this engine and must never
    // read as missing.
    if (! executable.existsAsFile())
        out.availability = Availability::notInstalled;
    else if (state == MuScriptorServer::State::failed)
        out.availability = Availability::broken;
    else if (state == MuScriptorServer::State::ready)
        out.availability = Availability::ready;
    else
        out.availability = Availability::installed;

    out.detail = [&]() -> juce::String
    {
        if (out.availability == Availability::notInstalled)
            return "Not found on this machine yet. The steps below install it.";

        if (out.availability == Availability::broken)
            return "The last attempt to start it failed.";

        if (state == MuScriptorServer::State::ready)
            return server.isAdopted()
                     ? "Using the server already running on port " + juce::String (out.port) + "."
                     : "Running on port " + juce::String (out.port) + ".";

        return "Installed. It starts when a transcription needs it and stops again straight after.";
    }();

    juce::Array<juce::var> installedList;
    const auto installedNames = ModelCatalog::installedModels();

    for (const auto& name : installedNames)
        installedList.add (name);

    // ALL THREE SIZES AS DATA, not just the ones on disk. The card used to be
    // able to say "you have medium" and nothing else; a user deciding whether
    // to download large had no way to find out from Riffsheet what large would
    // cost them, and the 0.9 / 1.8 / 5 GB figures existed only inside
    // ModelCatalog's auto rule and inside a paragraph of BRIDGE.md. Sending the
    // table means the page renders the numbers the resolver actually uses -
    // including `fits`, which is that rule's own 40%-of-physical answer rather
    // than a second copy of the arithmetic in TypeScript.
    const auto ramTotalMb = SystemProbe::physicalRamMb();
    juce::Array<juce::var> modelTable;

    for (const auto& name : ModelCatalog::allModelNames())
        modelTable.add (makeObject ({
            { "name", name },
            { "approxResidentMb", ModelCatalog::estimatedResidentMb (name) },
            { "installed", installedNames.contains (name) },
            { "fits", ModelCatalog::fitsInPhysicalRam (name, ramTotalMb) } }));

    // The MuScriptor-only half of engineStatus(), merged over the shared shape
    // by NativeBridge::makeEngineStatusVar(). Every one of these fields exists
    // today and keeps its meaning exactly.
    out.extra = makeObject ({
        { "model", server.getRunningModelDescription() },
        { "modelSource", server.getRunningModelSource() },
        { "configuredModel", server.getConfiguredModel() },
        { "resolvedModel", server.getResolvedModel() },
        { "modelReason", server.getModelReason() },
        { "installedModels", installedList },
        { "models", modelTable },
        { "venv", config.venv.getFullPathName() },
        { "executable", executable.getFullPathName() },
        { "setupDirectory", MuScriptorServer::recommendedSetupDirectory().getFullPathName() },
        { "engineConfigPath", MuScriptorServer::engineConfigFile().getFullPathName() },
        { "engineConfigExists", MuScriptorServer::engineConfigFile().existsAsFile() },
        { "idleSeconds", idle.idleSeconds },
        { "canStop", idle.canStop },

        // "Somebody else's server is on the wire", and "you may ask Riffsheet
        // to stop it anyway". Two fields rather than one because the first
        // decides what the card SAYS about who owns the server and the second
        // decides whether the button is offered at all - on Windows, where the
        // listening pid's command line cannot be read, the first is true and
        // the second is false, and collapsing them would offer a button that
        // can only ever refuse.
        { "externalServer", idle.external },
        { "canStopExternal", idle.canStopExternal },
        // Null rather than 0 when the platform will not say - "unknown" and
        // "using no memory" must not look the same.
        { "memoryMb", idle.memoryMb > 0 ? juce::var (idle.memoryMb) : juce::var() } });

    return out;
}

void MuScriptorAdapter::rediscover()
{
    server.rediscoverEngine();
    server.reapOrphanServers();
    server.refreshStatus();
}

bool MuScriptorAdapter::prepare (std::function<void (const juce::String&)> onProgress,
                                 std::function<bool()> shouldCancel)
{
    return server.ensureRunning (std::move (onProgress), std::move (shouldCancel));
}

void MuScriptorAdapter::endOfJob()
{
    // Never before EngineLock::release(): a job queued behind this one must take
    // the engine before the shutdown is even offered, which is what makes the
    // LAST finisher the one that stops the server. NativeBridge's EndOfJob
    // destructor is what keeps that order.
    server.stopAfterJob();
}

juce::var MuScriptorAdapter::transcribe (const AudioInput& input,
                                         const Request& request,
                                         Callbacks callbacks,
                                         juce::String& error)
{
    MuScriptorServer::TranscribeOptions options;
    options.instruments = request.instruments;
    options.detectTempo = request.detectTempo;
    options.clientId = request.clientId;

    MuScriptorServer::TranscribeCallbacks forwarded;
    forwarded.onProgress = std::move (callbacks.onProgress);
    forwarded.shouldCancel = std::move (callbacks.shouldCancel);

    return server.transcribe (input.file, options, std::move (forwarded), error);
}
