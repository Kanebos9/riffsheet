#include "EngineSettings.h"
#include "SystemProbe.h"

namespace
{
    constexpr const char* kSelectedEngineKey = "selectedEngine";
    constexpr const char* kEnvironmentOverride = "RIFFSHEET_ENGINE";

    /** The parsed var MUST be named. getDynamicObject() hands back a pointer
        into the var's ref-counted payload, and a temporary var dies at the end
        of the full-expression it was created in - so
        `if (auto* o = JSON::parse(...).getDynamicObject())` reads freed memory.
        Same trap as ServerRegistry::readEntries() and readPersistedVenv(). */
    juce::var parseObject (const juce::File& file)
    {
        if (! file.existsAsFile())
            return {};

        const auto parsed = juce::JSON::parse (file.loadFileAsString());

        if (parsed.getDynamicObject() != nullptr)
            return parsed;

        return {};
    }
}

//==============================================================================
EngineSettings& EngineSettings::shared()
{
    // The same path as MuScriptorServer::engineConfigFile(), spelled out rather
    // than called: the unit-test binary links this file and must not have to
    // link the whole MuScriptor server (and with it ServerRegistry, ModelCatalog
    // and a Python process launcher) to check that a JSON round-trip preserves a
    // venv. MuScriptorAdapter jassert()s that the two agree, so drift is caught
    // in the one build that has both.
    static EngineSettings instance { SystemProbe::appSupportDirectory().getChildFile ("engine.json") };
    return instance;
}

EngineSettings::EngineSettings (juce::File configFile)
    : file (std::move (configFile))
{
}

juce::String EngineSettings::environmentOverride()
{
    return juce::SystemStats::getEnvironmentVariable (kEnvironmentOverride, {}).unquoted().trim();
}

bool EngineSettings::isEnvironmentOverridden() const
{
    return environmentOverride().isNotEmpty();
}

juce::String EngineSettings::selectedEngine() const
{
    // A hard override, exactly like RIFFSHEET_MUSCRIPTOR_MODEL: it names an
    // engine and nothing auto-selects around it.
    if (const auto fromEnv = environmentOverride(); fromEnv.isNotEmpty())
        return fromEnv;

    refresh();

    const std::lock_guard<std::mutex> guard (lock);
    return fromFile.isNotEmpty() ? fromFile : juce::String (defaultSelection());
}

void EngineSettings::refresh() const
{
    const auto exists = file.existsAsFile();
    const auto modified = exists ? file.getLastModificationTime().toMilliseconds() : (juce::int64) -1;
    const auto size = exists ? file.getSize() : (juce::int64) -1;

    {
        const std::lock_guard<std::mutex> guard (lock);

        if (everLooked && modified == seenModificationMs && size == seenSize)
            return;   // the common path: one stat, no read

        everLooked = true;
        seenModificationMs = modified;
        seenSize = size;
    }

    const auto parsed = parseObject (file);
    juce::String value;

    if (auto* object = parsed.getDynamicObject())
        value = object->getProperty (kSelectedEngineKey).toString().unquoted().trim();

    juce::String repair;

    {
        const std::lock_guard<std::mutex> guard (lock);

        if (value.isNotEmpty())
        {
            fromFile = value;
            return;
        }

        // The key is gone. If we are the ones who put it there, something else
        // rewrote this file without it - MuScriptorServer does exactly that when
        // discovery lands outside the recommended folder - and the user's choice
        // must not evaporate because of a write that was about something else.
        if (written.isNotEmpty() && exists)
            repair = written;
        else
            fromFile = defaultSelection();
    }

    if (repair.isNotEmpty())
        writeSelection (repair);
}

bool EngineSettings::setSelectedEngine (const juce::String& id)
{
    const auto value = id.trim().isEmpty() ? juce::String (defaultSelection()) : id.trim();

    {
        const std::lock_guard<std::mutex> guard (lock);
        written = value;
    }

    return writeSelection (value);
}

bool EngineSettings::writeSelection (const juce::String& value) const
{
    {
        const std::lock_guard<std::mutex> guard (lock);
        fromFile = value;
    }

    // Read-modify-write, never write-over: `venv` in here is the only record of
    // where a hand-installed engine lives, and losing it would cost the user
    // their setup for a setting that has nothing to do with it.
    const auto parsed = parseObject (file);
    auto* next = new juce::DynamicObject();
    const juce::var payload (next);   // owns `next` from here on

    if (auto* object = parsed.getDynamicObject())
        for (const auto& property : object->getProperties())
            next->setProperty (property.name, property.value);

    next->setProperty (kSelectedEngineKey, value);
    next->setProperty ("savedAtMs", (double) juce::Time::currentTimeMillis());

    file.getParentDirectory().createDirectory();
    const auto ok = file.replaceWithText (juce::JSON::toString (payload, true) + "\n");

    const std::lock_guard<std::mutex> guard (lock);
    // Re-stat so the write we just made is not mistaken for somebody else's
    // change on the next read.
    everLooked = true;
    seenModificationMs = file.existsAsFile() ? file.getLastModificationTime().toMilliseconds() : (juce::int64) -1;
    seenSize = file.existsAsFile() ? file.getSize() : (juce::int64) -1;

    return ok;
}
