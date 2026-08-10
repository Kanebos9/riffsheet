#pragma once
#include <JuceHeader.h>
#include <functional>

/**
    Runs an already-installed Audiveris command-line application over a printed
    score image or PDF and returns its compressed MusicXML output.

    This class deliberately does not download, install, or link Audiveris.  It
    is a separate AGPL application and the current installers include their own
    Java runtime.  Keeping discovery and execution here means the WebView only
    has to deal with bytes, just like the existing score-file import path.

    Everything except isSupportedInput() and findExecutable() blocks.  Call
    probe() and run() from a NativeBridge worker, never the message/audio thread.
*/
class ScoreImageImporter final
{
public:
    static constexpr int defaultTimeoutMs = 30 * 60 * 1000;

    struct Status
    {
        bool available = false;
        juce::File executable;
        juce::String version;
        juce::String message;
    };

    struct Result
    {
        bool ok = false;
        bool cancelled = false;
        bool timedOut = false;
        int elapsedMs = 0;

        juce::String sourceName;
        juce::String outputName;
        juce::String error;
        /** Audiveris stdout/stderr, capped so one bad page cannot fill memory. */
        juce::String log;
        juce::MemoryBlock musicXml;
    };

    /** Common printed-score formats supported by Audiveris. */
    static bool isSupportedInput (const juce::File& file);

    /**
        Resolves RIFFSHEET_AUDIVERIS first, then the normal installer locations,
        then PATH where safe. On macOS this returns only the validated Java
        runtime inside Audiveris.app; the GUI app launcher is never used. An
        empty File means Audiveris is not installed.
    */
    static juce::File findExecutable();

    /** Launches `-version` to prove that the discovered executable really runs. */
    static Status probe (int timeoutMs = 10000);

    /**
        Runs:

          Audiveris -batch -swap -transcribe -export -output DIR -- INPUT

        On macOS "Audiveris" above is the app-bundled Java runtime plus the
        headless JVM flags and app classpath, not Contents/MacOS/Audiveris.

        `-swap` keeps a long PDF from holding every recognized page in RAM at
        once. The output directory is unique and deleted before this function returns;
        the .mxl bytes are therefore owned by Result rather than a leaked temp
        path. shouldCancel may be empty. onStage receives a few human-readable
        phase changes, not invented progress percentages.
    */
    static Result run (const juce::File& input,
                       std::function<bool()> shouldCancel = {},
                       std::function<void (const juce::String&)> onStage = {},
                       int timeoutMs = defaultTimeoutMs);

private:
    ScoreImageImporter() = delete;
};
