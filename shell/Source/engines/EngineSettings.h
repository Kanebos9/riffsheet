#pragma once
#include <JuceHeader.h>
#include <mutex>

/**
    Which engine the user chose, kept where a DAW can actually read it.

    IT IS THE SAME FILE THE VENV LIVES IN - <appSupport>/engine.json - and that
    is deliberate. That file already exists, is already read and written by
    MuScriptorServer, and is already the one writable setting a Finder-launched
    host can see, because such a host inherits launchd's environment rather than
    the user's shell. Adding a second file for a second setting would give the
    same person two places to look and two ways to be out of date.

        { "venv": "/path/to/muscriptor/venv", "savedAtMs": 1.7e12,
          "selectedEngine": "auto" }

    THREE RULES THIS CLASS KEEPS.

      1. It never clobbers a key it does not own. A write reads the object back
         first and replaces exactly `selectedEngine`, so the venv somebody
         hand-edited in survives.
      2. It re-reads when the file changes on disk (modification time or size),
         so two open plugin windows - or the standalone app and the plugin -
         agree about the choice without either of them restarting.
      3. It repairs its own key if something else drops it. MuScriptorServer
         rewrites this file as {venv, savedAtMs} when discovery finds an engine
         somewhere other than the recommended folder, which silently loses the
         engine choice. Wave 1 is not allowed to edit that file, so instead: if
         the key was written by this process and has since vanished from a file
         that still exists, it is written back, venv and all. The alternative is
         a user's engine choice quietly resetting to Auto the next time they
         press Check again.

    RIFFSHEET_ENGINE overrides the file for scripted runs, exactly as
    RIFFSHEET_MUSCRIPTOR_MODEL overrides the model: a hard override that nothing
    auto-selects around, with a sentence saying so. The file is still written by
    setSelectedEngine(), so the choice is there when the override goes away.

    Cheap: one file stat per read, one small file read when the stat changed.
    Safe on the message thread. Thread-safe.
*/
class EngineSettings
{
public:
    /** The process-wide instance, on <appSupport>/engine.json. */
    static EngineSettings& shared();

    /** For tests, which must not touch the user's real settings. */
    explicit EngineSettings (juce::File configFile);

    /** 'auto' or an engine id. Never empty. */
    juce::String selectedEngine() const;

    /** Writes `id` into the file, preserving every other key. Returns false
        only when the file could not be written; the in-memory value is updated
        either way, because a read-only Application Support folder must not
        make the app forget what the user just clicked. */
    bool setSelectedEngine (const juce::String& id);

    /** True when RIFFSHEET_ENGINE is set, i.e. selectedEngine() is the
        environment's answer rather than the file's. */
    bool isEnvironmentOverridden() const;

    /** The environment override's raw value, or "". */
    static juce::String environmentOverride();

    juce::File getFile() const noexcept { return file; }

    /** What a machine with no engine.json means. */
    static const char* defaultSelection() noexcept { return "auto"; }

private:
    /** Re-reads the file if its modification time or size changed since the
        last look, and repairs a dropped key. Cheap on the common path. */
    void refresh() const;

    /** The read-modify-write. const because the repair path in refresh() is a
        read that has to put back a key somebody else's write dropped - the
        object's visible state is what it always was, the file is what is being
        made to agree with it. */
    bool writeSelection (const juce::String& value) const;

    const juce::File file;

    mutable std::mutex lock;
    mutable juce::String fromFile { defaultSelection() };
    /** What this process last wrote, "" if it never did. Rule 3 above. */
    mutable juce::String written;
    mutable juce::int64 seenModificationMs = -1;
    mutable juce::int64 seenSize = -1;
    mutable bool everLooked = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EngineSettings)
};
