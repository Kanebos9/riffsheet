#include "EngineRegistry.h"

EngineRegistry::EngineRegistry()
    : settings (EngineSettings::shared())
{
}

EngineRegistry::EngineRegistry (EngineSettings& settingsToUse)
    : settings (settingsToUse)
{
}

void EngineRegistry::add (std::unique_ptr<EngineAdapter> adapter)
{
    if (adapter == nullptr)
        return;

    const std::lock_guard<std::mutex> guard (listLock);
    adapters.push_back (std::move (adapter));
}

EngineAdapter* EngineRegistry::findLocked (const juce::String& id) const
{
    for (const auto& adapter : adapters)
        if (id == adapter->manifest().id)
            return adapter.get();

    return nullptr;
}

EngineAdapter* EngineRegistry::find (const juce::String& id) const
{
    const std::lock_guard<std::mutex> guard (listLock);
    return findLocked (id);
}

std::vector<EngineAdapter*> EngineRegistry::all() const
{
    const std::lock_guard<std::mutex> guard (listLock);
    std::vector<EngineAdapter*> result;
    result.reserve (adapters.size());

    for (const auto& adapter : adapters)
        result.push_back (adapter.get());

    return result;
}

juce::String EngineRegistry::configuredEngine() const
{
    const auto configured = settings.selectedEngine();
    return configured.isNotEmpty() ? configured : juce::String (EngineSettings::defaultSelection());
}

juce::String EngineRegistry::displayName (const EngineAdapter& adapter)
{
    return manifestText (adapter.manifest().name);
}

juce::String EngineRegistry::stateName (EngineAdapter::Availability availability)
{
    switch (availability)
    {
        case EngineAdapter::Availability::ready:        return "ready";
        case EngineAdapter::Availability::installed:    return "installed";
        case EngineAdapter::Availability::notInstalled: return "not-installed";
        case EngineAdapter::Availability::broken:       return "broken";
    }

    return "not-installed";
}

//==============================================================================
EngineRegistry::Resolution EngineRegistry::chooseAutomatically (const juce::String& configured,
                                                               bool nativeOnly) const
{
    Resolution out;
    out.configured = configured;

    const auto usable = [nativeOnly] (EngineAdapter* adapter)
    {
        if (adapter == nullptr || ! isPresent (adapter->status().availability))
            return false;

        // A native job cannot be handed to an engine that runs in the web view.
        // Skipping it here rather than failing later is what makes the shell's
        // own transcribe path keep working when `auto` heads at an in-page
        // engine: the page runs that one itself and never asks us to.
        return ! (nativeOnly && EngineCatalog::runsInPage (adapter->manifest()));
    };

    // FIRST USABLE IN THE CATALOGUE'S ORDER WINS. The order and the reasoning
    // behind it are EngineCatalog's, not this function's - it only walks it.
    const auto order = EngineCatalog::autoOrder();
    EngineAdapter* firstKnown = nullptr;

    for (const auto* id : order)
    {
        auto* candidate = findLocked (id);

        if (candidate == nullptr)
            continue;

        if (firstKnown == nullptr && ! (nativeOnly && EngineCatalog::runsInPage (candidate->manifest())))
            firstKnown = candidate;

        if (! usable (candidate))
            continue;

        out.adapter = candidate;
        out.reason = candidate == firstKnown && candidate->manifest().install == InstallKind::bundled
                       ? "Auto is using " + displayName (*candidate) + " - it is built in and needs no setup."
                       : displayName (*candidate) + " is installed, so Auto is using it.";
        break;
    }

    if (out.adapter == nullptr)
    {
        // Nothing on this machine can run. Prefer the engine the user is most
        // likely to be setting up, so the failure they read is one they can act on.
        auto* chosen = firstKnown != nullptr ? firstKnown
                                             : (adapters.empty() ? nullptr : adapters.front().get());

        if (chosen != nullptr)
        {
            out.adapter = chosen;
            out.reason = "No engine is installed yet, so Auto is using " + displayName (*chosen)
                       + " and will report what it needs.";
        }
        else
        {
            out.reason = "This build has no transcription engine compiled in.";
        }
    }

    if (out.adapter != nullptr)
        out.resolved = out.adapter->manifest().id;
    else
        out.resolved = EngineCatalog::fallbackId();

    return out;
}

EngineRegistry::Resolution EngineRegistry::resolve (bool nativeOnly) const
{
    const auto configured = configuredEngine();

    const std::lock_guard<std::mutex> guard (listLock);

    if (configured == EngineSettings::defaultSelection())
        return chooseAutomatically (configured, nativeOnly);

    const auto* manifest = EngineCatalog::find (configured);

    if (manifest == nullptr || ! EngineCatalog::isOffered (*manifest))
    {
        auto out = chooseAutomatically (configured, nativeOnly);
        out.reason = "\"" + configured + "\" is not an engine this build knows about, so Riffsheet is "
                     "using " + (out.adapter != nullptr ? displayName (*out.adapter) : juce::String (out.resolved))
                   + " instead.";
        return out;
    }

    auto* chosen = findLocked (configured);
    const bool chosenRunsHere = ! (nativeOnly && EngineCatalog::runsInPage (*manifest));

    if (chosen != nullptr && chosenRunsHere && isPresent (chosen->status().availability))
    {
        Resolution out;
        out.configured = configured;
        out.resolved = configured;
        out.adapter = chosen;
        out.reason = "You chose " + displayName (*chosen) + ".";
        return out;
    }

    // The chosen engine cannot run here. Fall back only to one that can -
    // otherwise the chosen engine's own error is the truthful answer. Walked in
    // `auto`'s order so "the next best thing" means the same thing everywhere.
    for (const auto* candidateId : EngineCatalog::autoOrder())
    {
        auto* candidate = findLocked (candidateId);

        if (candidate == nullptr || candidate == chosen || ! isPresent (candidate->status().availability))
            continue;

        if (nativeOnly && EngineCatalog::runsInPage (candidate->manifest()))
            continue;

        Resolution out;
        out.configured = configured;
        out.resolved = candidate->manifest().id;
        out.adapter = candidate;
        out.reason = manifestText (manifest->name)
                   + (chosen == nullptr ? " is not part of this build yet, so Riffsheet is using "
                                        : " is not ready yet, so Riffsheet is using ")
                   + displayName (*candidate) + " instead.";
        return out;
    }

    Resolution out;
    out.configured = configured;
    out.resolved = configured;
    out.adapter = chosen;
    out.reason = chosen != nullptr
                   ? manifestText (manifest->name) + " is not ready yet, and nothing else in this build "
                     "can transcribe, so Riffsheet will report what it needs."
                   : manifestText (manifest->name) + " is not part of this build yet, and nothing else "
                     "can transcribe.";
    return out;
}

EngineRegistry::Resolution EngineRegistry::resolveExplicit (const juce::String& id) const
{
    Resolution out;
    out.configured = id;
    out.resolved = id;

    const auto* manifest = EngineCatalog::find (id);

    if (manifest == nullptr)
    {
        out.reason = "unknown engine \"" + id + "\"";
        return out;
    }

    if (! EngineCatalog::isOffered (*manifest))
    {
        out.reason = manifestText (manifest->name) + " is not offered in this build.";
        return out;
    }

    const std::lock_guard<std::mutex> guard (listLock);
    out.adapter = findLocked (id);

    if (out.adapter == nullptr)
    {
        out.reason = manifestText (manifest->name) + " is not part of this build yet.";
        return out;
    }

    out.reason = "You asked for " + displayName (*out.adapter) + " for this transcription.";
    return out;
}

EngineRegistry::SelectOutcome EngineRegistry::select (const juce::String& id)
{
    SelectOutcome outcome;
    const auto wanted = id.trim().isEmpty() ? juce::String (EngineSettings::defaultSelection())
                                            : id.trim();

    if (wanted != EngineSettings::defaultSelection())
    {
        const auto* manifest = EngineCatalog::find (wanted);

        if (manifest == nullptr || ! EngineCatalog::isOffered (*manifest))
        {
            outcome.error = "unknown engine \"" + wanted + "\"";
            outcome.resolution = resolve();
            return outcome;
        }
    }

    settings.setSelectedEngine (wanted);

    outcome.ok = true;
    outcome.resolution = resolve();

    if (settings.isEnvironmentOverridden())
        outcome.resolution.reason = "RIFFSHEET_ENGINE is set to \"" + settings.selectedEngine()
                                  + "\", so that is what is used until it is unset. Your choice was "
                                    "saved for when it is.";

    return outcome;
}

//==============================================================================
EngineRegistry::LocalJob::LocalJob (EngineRegistry& owner)
    : registry (owner), held (owner.inProcessLock)
{
    registry.localBusy.store (true, std::memory_order_release);
}

EngineRegistry::LocalJob::~LocalJob()
{
    registry.localBusy.store (false, std::memory_order_release);
}
