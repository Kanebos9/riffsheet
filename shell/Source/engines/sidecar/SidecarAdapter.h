#pragma once
#include <JuceHeader.h>
#include "EngineAdapter.h"

/**
    Every subprocess engine, in one class.

    Both one-click engines are the same shape: run a program, give it a file,
    read the notes back. That is already how the old beat sidecar worked and how
    Audiveris is driven, so this is one class driven by two manifest fields -
    `argvTemplate` and `scriptResource` - rather than one class per engine. A new
    subprocess engine is a row in EngineCatalog and a `.py` in Resources/engines;
    it is never a new file here.

    THE TEMPLATE. `argvTemplate` is a space-separated command line with
    placeholders, expanded per job:

        {python}       the installed venv's interpreter
        {bin}          a console script inside the installed venv (Transkun)
        {script}       the sidecar .py the installer wrote into the engine folder
        {root}         the installed engine directory
        {audio}        the input wav
        {midi}         where the engine should write MIDI
        {json}         where the engine may write its notes
        {instruments}  what the user asked to hear, comma separated, may be empty

    HOW THE NOTES COME BACK. A JSON object at {json}, or failing that the last
    JSON line on stdout - the same "scan back for the last JSON line" recovery
    the beat sidecar used, because a Python process prints warnings whenever it
    feels like it. An engine that writes only MIDI (Transkun) is read with
    SidecarMidi instead. Whichever route the notes took, the MIDI file is
    returned as `midiBase64` when there is one, so the user gets the engine's own
    MIDI rather than one rebuilt from rounded numbers.

    ONE JOB, THEN GONE. There is no server and no warm state: the process starts
    when transcribe() is called and has exited before it returns, so endOfJob()
    has nothing to give back. That is the one-job rule satisfied for free rather
    than by a timer.
*/
class SidecarAdapter final : public EngineAdapter
{
public:
    explicit SidecarAdapter (const EngineManifest& row);

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

    /** The installed directory this adapter looks in. Public because the bridge
        reports it after an install and the tests assert on it. */
    juce::File installDirectory() const;

private:
    /** The absolute path {python} / {bin} expands to, or an invalid file when
        the engine is not installed. */
    juce::File executable() const;

    const EngineManifest& row;

    // status() is documented as cheap enough for the message thread, so the
    // stat happens in rediscover() and the answer is cached behind this lock.
    mutable juce::CriticalSection stateLock;
    bool installed = false;
    juce::String location;
    juce::String lastError;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SidecarAdapter)
};
