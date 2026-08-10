#include <JuceHeader.h>
#include "EngineSettings.h"

/**
    <appSupport>/engine.json is shared: MuScriptorServer writes the venv into it,
    EngineSettings writes the engine choice, and two plugin windows read it. The
    tests below are about the three ways that goes wrong - clobbering somebody
    else's key, not noticing a change made elsewhere, and losing a key that
    another writer dropped.

    Every test uses its own file in the temp directory. Nothing here may touch
    the real settings.
*/
class EngineSettingsTests final : public juce::UnitTest
{
public:
    EngineSettingsTests() : juce::UnitTest ("EngineSettings", "EngineSettings") {}

    void runTest() override
    {
        beginTest ("no file at all means auto");
        {
            const Scratch scratch;
            const EngineSettings settings { scratch.file };

            expectEquals (settings.selectedEngine(), juce::String ("auto"));
            expect (! scratch.file.existsAsFile(), "reading must not create the file");
        }

        beginTest ("a round trip preserves the venv, and every other key");
        {
            const Scratch scratch;
            scratch.write ("{ \"venv\": \"/Users/somebody/muscriptor/venv\", "
                           "\"savedAtMs\": 1700000000000, \"somethingElse\": 42 }");

            EngineSettings settings { scratch.file };
            expect (settings.setSelectedEngine ("muscriptor"));

            const auto reread = juce::JSON::parse (scratch.file.loadFileAsString());
            auto* object = reread.getDynamicObject();
            expect (object != nullptr);

            if (object != nullptr)
            {
                expectEquals (object->getProperty ("venv").toString(),
                              juce::String ("/Users/somebody/muscriptor/venv"));
                expectEquals ((int) object->getProperty ("somethingElse"), 42);
                expectEquals (object->getProperty ("selectedEngine").toString(),
                              juce::String ("muscriptor"));
            }

            // ...and a second process reading the same file agrees.
            const EngineSettings other { scratch.file };
            expectEquals (other.selectedEngine(), juce::String ("muscriptor"));
        }

        beginTest ("writing when there is no file creates one with just the choice");
        {
            const Scratch scratch;
            EngineSettings settings { scratch.file };

            expect (settings.setSelectedEngine ("basic-pitch"));
            expect (scratch.file.existsAsFile());
            expectEquals (settings.selectedEngine(), juce::String ("basic-pitch"));

            const auto reread = juce::JSON::parse (scratch.file.loadFileAsString());

            if (auto* object = reread.getDynamicObject())
            {
                expectEquals (object->getProperty ("selectedEngine").toString(),
                              juce::String ("basic-pitch"));
                expect (! object->hasProperty ("venv"), "no venv must be invented");
            }
        }

        beginTest ("an empty choice falls back to auto rather than to nothing");
        {
            const Scratch scratch;
            EngineSettings settings { scratch.file };

            settings.setSelectedEngine ("   ");
            expectEquals (settings.selectedEngine(), juce::String ("auto"));
        }

        beginTest ("a change made by another window is picked up");
        {
            const Scratch scratch;
            EngineSettings settings { scratch.file };

            settings.setSelectedEngine ("auto");
            expectEquals (settings.selectedEngine(), juce::String ("auto"));

            // Another process writes the same file.
            scratch.write ("{ \"venv\": \"/tmp/venv\", \"selectedEngine\": \"muscriptor\" }");
            expectEquals (settings.selectedEngine(), juce::String ("muscriptor"),
                          "the file is the truth; a cached value must not win");
        }

        beginTest ("a dropped key is repaired, not silently forgotten");
        {
            // This is not hypothetical: MuScriptorServer rewrites engine.json as
            // {venv, savedAtMs} whenever discovery finds an engine somewhere
            // other than the recommended folder, which is what happens on a
            // machine whose venv lives on the Desktop. Without the repair the
            // user's engine choice resets to Auto the next time they press
            // "Check again".
            const Scratch scratch;
            EngineSettings settings { scratch.file };

            settings.setSelectedEngine ("muscriptor");
            scratch.write ("{ \"venv\": \"/Users/somebody/muscriptor/venv\", "
                           "\"savedAtMs\": 1700000000001 }");

            expectEquals (settings.selectedEngine(), juce::String ("muscriptor"),
                          "the choice must survive a write that was about something else");

            const auto reread = juce::JSON::parse (scratch.file.loadFileAsString());

            if (auto* object = reread.getDynamicObject())
            {
                expectEquals (object->getProperty ("selectedEngine").toString(),
                              juce::String ("muscriptor"), "and it must be back on disk");
                expectEquals (object->getProperty ("venv").toString(),
                              juce::String ("/Users/somebody/muscriptor/venv"),
                              "without clobbering the venv that dropped it");
            }
        }

        beginTest ("a file that is not JSON at all is survivable");
        {
            const Scratch scratch;
            scratch.write ("this is not json {{{");

            EngineSettings settings { scratch.file };
            expectEquals (settings.selectedEngine(), juce::String ("auto"));

            // ...and writing over it produces a file that parses.
            expect (settings.setSelectedEngine ("muscriptor"));
            const auto reread = juce::JSON::parse (scratch.file.loadFileAsString());
            expect (reread.getDynamicObject() != nullptr);
        }

        beginTest ("the environment override wins, and the choice is still saved");
        {
            const Scratch scratch;
            EngineSettings settings { scratch.file };

            if (EngineSettings::environmentOverride().isNotEmpty())
            {
                // Somebody is running the tests with RIFFSHEET_ENGINE set. Say
                // so rather than asserting the opposite of what they asked for.
                expect (settings.isEnvironmentOverridden());
                expectEquals (settings.selectedEngine(), EngineSettings::environmentOverride());
            }
            else
            {
                expect (! settings.isEnvironmentOverridden());
                settings.setSelectedEngine ("muscriptor");
                expectEquals (settings.selectedEngine(), juce::String ("muscriptor"));
            }
        }

        beginTest ("the shared instance points at engine.json in Application Support");
        {
            const auto file = EngineSettings::shared().getFile();
            expectEquals (file.getFileName(), juce::String ("engine.json"));
            expect (file.getParentDirectory().getFileName().containsIgnoreCase ("riffsheet"),
                    "the engine choice must live beside the venv, not in a second place");
        }
    }

private:
    /** A file of our own, in the temp directory, deleted afterwards. */
    struct Scratch
    {
        Scratch()
            : file (juce::File::getSpecialLocation (juce::File::tempDirectory)
                        .getChildFile ("riffsheet-engine-settings-tests")
                        .getChildFile (juce::Uuid().toDashedString() + ".json"))
        {
            file.getParentDirectory().createDirectory();
        }

        ~Scratch()
        {
            file.deleteFile();
        }

        void write (const juce::String& text) const
        {
            file.replaceWithText (text);
            // Modification-time granularity on some file systems is coarse
            // enough that two writes in the same millisecond look identical.
            // The size differs in every case used here, which is the other half
            // of the staleness check - but bump the stamp anyway so the test is
            // testing the intent rather than an accident of string lengths.
            file.setLastModificationTime (juce::Time::getCurrentTime() + juce::RelativeTime::seconds (1.0));
        }

        const juce::File file;
    };
};

static EngineSettingsTests engineSettingsTests;
