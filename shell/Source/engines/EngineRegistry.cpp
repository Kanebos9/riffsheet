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
    return adapter.manifest().name;
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
EngineRegistry::Resolution EngineRegistry::chooseAutomatically (const juce::String& configured) const
{
    Resolution out;
    out.configured = configured;

    const auto present = [] (EngineAdapter* adapter)
    {
        return adapter != nullptr && isPresent (adapter->status().availability);
    };

    auto* preferred = findLocked (EngineCatalog::autoPreferredId());
    auto* fallback  = findLocked (EngineCatalog::fallbackId());

    if (present (preferred))
    {
        out.adapter = preferred;
        out.reason = displayName (*preferred) + " is installed, so Auto is using it.";
    }
    else if (present (fallback))
    {
        out.adapter = fallback;
        out.reason = preferred != nullptr
                       ? displayName (*preferred) + " is not installed, so Auto is using "
                         + displayName (*fallback) + ", which needs no setup."
                       : "Auto is using " + displayName (*fallback) + ", which needs no setup.";
    }
    else
    {
        // Nothing is on this machine. Prefer the engine the user is most likely
        // to be setting up, so the failure they read is the one they can act on.
        auto* chosen = preferred != nullptr ? preferred
                                            : (fallback != nullptr ? fallback
                                                                   : (adapters.empty() ? nullptr
                                                                                       : adapters.front().get()));

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

EngineRegistry::Resolution EngineRegistry::resolve() const
{
    const auto configured = configuredEngine();

    const std::lock_guard<std::mutex> guard (listLock);

    if (configured == EngineSettings::defaultSelection())
        return chooseAutomatically (configured);

    const auto* manifest = EngineCatalog::find (configured);

    if (manifest == nullptr || ! EngineCatalog::isOffered (*manifest))
    {
        auto out = chooseAutomatically (configured);
        out.reason = "\"" + configured + "\" is not an engine this build knows about, so Riffsheet is "
                     "using " + (out.adapter != nullptr ? displayName (*out.adapter) : juce::String (out.resolved))
                   + " instead.";
        return out;
    }

    auto* chosen = findLocked (configured);

    if (chosen != nullptr && isPresent (chosen->status().availability))
    {
        Resolution out;
        out.configured = configured;
        out.resolved = configured;
        out.adapter = chosen;
        out.reason = "You chose " + displayName (*chosen) + ".";
        return out;
    }

    // The chosen engine is not on this machine. Fall back only to one that is -
    // otherwise the chosen engine's own error is the truthful answer.
    for (const auto* candidateId : { EngineCatalog::fallbackId(), EngineCatalog::autoPreferredId() })
    {
        auto* candidate = findLocked (candidateId);

        if (candidate == nullptr || candidate == chosen || ! isPresent (candidate->status().availability))
            continue;

        Resolution out;
        out.configured = configured;
        out.resolved = candidate->manifest().id;
        out.adapter = candidate;
        out.reason = juce::String (manifest->name)
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
                   ? juce::String (manifest->name) + " is not ready yet, and nothing else in this build "
                     "can transcribe, so Riffsheet will report what it needs."
                   : juce::String (manifest->name) + " is not part of this build yet, and nothing else "
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
        out.reason = juce::String (manifest->name) + " is not offered in this build.";
        return out;
    }

    const std::lock_guard<std::mutex> guard (listLock);
    out.adapter = findLocked (id);

    if (out.adapter == nullptr)
    {
        out.reason = juce::String (manifest->name) + " is not part of this build yet.";
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
