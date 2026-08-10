#include "ScoreImageImporter.h"
#include <atomic>
#include <limits>

namespace
{
    constexpr int maxCapturedLogChars = 128 * 1024;
    // This crosses the JSON bridge as base64 before alphaTab reads it. A normal
    // .mxl is tiny; rejecting a freakishly large result avoids multiplying a
    // 100+ MB allocation several times on the owner's 8 GB machine.
    constexpr juce::int64 maxMusicXmlBytes = 32 * 1024 * 1024;

    struct ProcessOutcome
    {
        bool started = false;
        bool cancelled = false;
        bool timedOut = false;
        juce::uint32 exitCode = 1;
        int elapsedMs = 0;
        juce::String output;
    };

    void appendProcessOutput (juce::String& destination, const char* bytes, int count)
    {
        if (count <= 0)
            return;

        destination += juce::String::fromUTF8 (bytes, count);

        if (destination.length() > maxCapturedLogChars)
            destination = "[earlier Audiveris output omitted]\n"
                        + destination.substring (destination.length() - maxCapturedLogChars);
    }

    // ChildProcess::readProcessOutput() blocks on POSIX until the child writes or
    // closes its pipe. Keep that wait off the caller so cancellation and timeout
    // checks remain live even while Audiveris is silent.
    class ProcessOutputReader final : private juce::Thread
    {
    public:
        explicit ProcessOutputReader (juce::ChildProcess& process)
            : juce::Thread ("Riffsheet Audiveris output"), child (process)
        {
        }

        bool start() { return startThread(); }

        juce::String finishAfterProcessExit()
        {
            processFinished.store (true, std::memory_order_release);
            waitForThreadToExit (-1);
            return output;
        }

    private:
        void run() override
        {
            for (;;)
            {
                char buffer[4096];
                const auto count = child.readProcessOutput (buffer, (int) sizeof (buffer));

                if (count > 0)
                {
                    appendProcessOutput (output, buffer, count);
                    continue;
                }

                // On Windows a zero-byte read can occur while the child is still
                // running. On POSIX it means EOF, but only leave once the owner has
                // observed/reaped the child so the final buffered bytes are retained.
                if (processFinished.load (std::memory_order_acquire))
                    break;

                juce::Thread::sleep (10);
            }
        }

        juce::ChildProcess& child;
        std::atomic<bool> processFinished { false };
        juce::String output;
    };

    ProcessOutcome runProcess (const juce::StringArray& arguments,
                               int timeoutMs,
                               const std::function<bool()>& shouldCancel)
    {
        ProcessOutcome outcome;
        juce::ChildProcess child;
        const auto startMs = juce::Time::getMillisecondCounterHiRes();

        outcome.started = child.start (arguments,
                                       juce::ChildProcess::wantStdOut
                                         | juce::ChildProcess::wantStdErr);

        if (! outcome.started)
            return outcome;

        ProcessOutputReader outputReader (child);

        if (! outputReader.start())
        {
            child.kill();
            child.waitForProcessToFinish (-1);
            outcome.output = "Could not start the Audiveris output reader thread.";
            outcome.elapsedMs = (int) juce::jlimit (0.0, (double) std::numeric_limits<int>::max(),
                                                    juce::Time::getMillisecondCounterHiRes() - startMs);
            return outcome;
        }

        const auto deadlineMs = startMs + juce::jmax (1000, timeoutMs);

        while (child.isRunning())
        {
            if (shouldCancel && shouldCancel())
            {
                outcome.cancelled = true;
                child.kill();
                child.waitForProcessToFinish (-1);
                break;
            }

            if (juce::Time::getMillisecondCounterHiRes() >= deadlineMs)
            {
                outcome.timedOut = true;
                child.kill();
                child.waitForProcessToFinish (-1);
                break;
            }

            juce::Thread::sleep (20);
        }

        outcome.output = outputReader.finishAfterProcessExit();

        if (! outcome.cancelled && ! outcome.timedOut)
            outcome.exitCode = child.getExitCode();

        outcome.elapsedMs = (int) juce::jlimit (0.0, (double) std::numeric_limits<int>::max(),
                                                juce::Time::getMillisecondCounterHiRes() - startMs);
        return outcome;
    }

    void addIfFile (juce::Array<juce::File>& files, const juce::File& candidate)
    {
        if (candidate.existsAsFile() && ! files.contains (candidate))
            files.add (candidate);
    }

   #if JUCE_MAC
    juce::File runtimeJavaForBundle (const juce::File& bundle)
    {
        const auto contents = bundle.getChildFile ("Contents");
        const auto java = contents.getChildFile ("runtime/Contents/Home/bin/java");
        return java.existsAsFile() && contents.getChildFile ("app").isDirectory()
                 ? java : juce::File();
    }

    juce::File appContentsForRuntimeJava (const juce::File& java)
    {
        // <bundle>/Contents/runtime/Contents/Home/bin/java -> <bundle>/Contents
        auto contents = java.getParentDirectory()
                            .getParentDirectory()
                            .getParentDirectory()
                            .getParentDirectory()
                            .getParentDirectory();

        if (contents.getFileName() != "Contents" || ! contents.getChildFile ("app").isDirectory())
            return {};

        return contents;
    }

    void addMacCandidate (juce::Array<juce::File>& files, const juce::File& candidate)
    {
        if (candidate.isDirectory() && candidate.hasFileExtension ("app"))
        {
            addIfFile (files, runtimeJavaForBundle (candidate));
            return;
        }

        // Accept an override aimed at the old app launcher by redirecting it to
        // the bundled runtime. Never execute Contents/MacOS/Audiveris on macOS:
        // that launcher initialises AWT as a GUI app and can abort in
        // RegisterApplication when invoked from a DAW.
        if (candidate.getParentDirectory().getFileName() == "MacOS"
            && candidate.getParentDirectory().getParentDirectory().getFileName() == "Contents")
        {
            addIfFile (files,
                       runtimeJavaForBundle (
                           candidate.getParentDirectory().getParentDirectory().getParentDirectory()));
            return;
        }

        if (candidate.getFileName() == "java"
            && appContentsForRuntimeJava (candidate) != juce::File())
            addIfFile (files, candidate);
    }
   #endif

    juce::StringArray audiverisCommand (const juce::File& executable)
    {
       #if JUCE_MAC
        const auto contents = appContentsForRuntimeJava (executable);

        if (contents == juce::File())
            return {};

        // Invoke the app's own Java runtime directly. Besides avoiding the
        // crashing macOS GUI launcher, headless mode prevents AWT from trying
        // to register a Dock application inside the DAW process context.
        return {
            executable.getFullPathName(),
            "-Djava.awt.headless=true",
            "--add-exports=java.desktop/sun.awt.image=ALL-UNNAMED",
            "--enable-native-access=ALL-UNNAMED",
            "-Dfile.encoding=UTF-8",
            "-Xms256m",
            "-Xmx2G",
            "-classpath", contents.getChildFile ("app/*").getFullPathName(),
            "Audiveris"
        };
       #else
        return { executable.getFullPathName() };
       #endif
    }

    juce::Array<juce::File> executableCandidates()
    {
        juce::Array<juce::File> candidates;

        if (const auto overridePath = juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_AUDIVERIS", {});
            overridePath.isNotEmpty())
        {
           #if JUCE_MAC
            addMacCandidate (candidates, juce::File (overridePath.unquoted().trim()));
           #else
            addIfFile (candidates, juce::File (overridePath.unquoted().trim()));
           #endif
        }

        const auto home = juce::File::getSpecialLocation (juce::File::userHomeDirectory);
        const auto applications = juce::File::getSpecialLocation (juce::File::globalApplicationsDirectory);

       #if JUCE_MAC
        addMacCandidate (candidates, applications.getChildFile ("Audiveris.app"));
        addMacCandidate (candidates, home.getChildFile ("Applications/Audiveris.app"));
       #elif JUCE_WINDOWS
        addIfFile (candidates, applications.getChildFile ("Audiveris/Audiveris.exe"));
        addIfFile (candidates, juce::File::getSpecialLocation (juce::File::globalApplicationsDirectoryX86)
                                   .getChildFile ("Audiveris/Audiveris.exe"));
        addIfFile (candidates, juce::File::getSpecialLocation (juce::File::windowsLocalAppData)
                                   .getChildFile ("Programs/Audiveris/Audiveris.exe"));
        addIfFile (candidates, home.getChildFile ("scoop/shims/audiveris.exe"));
        addIfFile (candidates, home.getChildFile ("scoop/apps/audiveris/current/Audiveris.exe"));
       #else
        addIfFile (candidates, juce::File ("/opt/audiveris/bin/Audiveris"));
        addIfFile (candidates, juce::File ("/usr/bin/audiveris"));
        addIfFile (candidates, juce::File ("/usr/local/bin/audiveris"));
        addIfFile (candidates, home.getChildFile (".local/bin/audiveris"));
        // Flatpak exports an executable shim at one of these locations.
        addIfFile (candidates, home.getChildFile (
                                   ".local/share/flatpak/exports/bin/org.audiveris.audiveris"));
        addIfFile (candidates, juce::File (
                                   "/var/lib/flatpak/exports/bin/org.audiveris.audiveris"));
       #endif

        // A DAW often supplies a much smaller PATH than a terminal, so PATH is
        // deliberately the fallback rather than the only discovery mechanism.
        // The macOS app launcher is deliberately excluded: only a validated
        // app-bundled runtime Java command is safe there.
       #if ! JUCE_MAC
        juce::StringArray pathParts;
       #if JUCE_WINDOWS
        pathParts.addTokens (juce::SystemStats::getEnvironmentVariable ("PATH", {}), ";", "\"");
        const juce::StringArray names { "Audiveris.exe", "audiveris.exe" };
       #else
        pathParts.addTokens (juce::SystemStats::getEnvironmentVariable ("PATH", {}), ":", "\"");
        const juce::StringArray names { "Audiveris", "audiveris", "org.audiveris.audiveris" };
       #endif

        for (const auto& path : pathParts)
            for (const auto& name : names)
                addIfFile (candidates, juce::File (path.trim()).getChildFile (name));
       #endif

        return candidates;
    }

    juce::String notInstalledMessage()
    {
       #if JUCE_MAC
        return "Audiveris is not installed with its bundled Java runtime. Install Audiveris.app, "
               "or point RIFFSHEET_AUDIVERIS at Audiveris.app (or its bundled bin/java). "
               "Image/PDF import needs Audiveris; MusicXML, Guitar Pro and MIDI imports do not.";
       #else
        return "Audiveris is not installed. Install its desktop package, or point "
               "RIFFSHEET_AUDIVERIS at the Audiveris executable. Image/PDF import "
               "needs Audiveris; MusicXML, Guitar Pro and MIDI imports do not.";
       #endif
    }

    struct ScopedDirectory
    {
        juce::File directory;
        ~ScopedDirectory() { directory.deleteRecursively(); }
    };
}

bool ScoreImageImporter::isSupportedInput (const juce::File& file)
{
    const auto extension = file.getFileExtension().toLowerCase();
    return extension == ".pdf"
        || extension == ".png"
        || extension == ".jpg"
        || extension == ".jpeg"
        || extension == ".tif"
        || extension == ".tiff"
        || extension == ".bmp"
        || extension == ".omr";
}

juce::File ScoreImageImporter::findExecutable()
{
    const auto candidates = executableCandidates();
    return candidates.isEmpty() ? juce::File() : candidates.getFirst();
}

ScoreImageImporter::Status ScoreImageImporter::probe (int timeoutMs)
{
    Status status;
    status.executable = findExecutable();

    if (status.executable == juce::File())
    {
        status.message = notInstalledMessage();
        return status;
    }

    auto command = audiverisCommand (status.executable);
    command.add ("-version");
    const auto result = runProcess (command, timeoutMs, {});

    if (! result.started)
    {
        status.message = "Audiveris was found at " + status.executable.getFullPathName()
                       + " but could not be launched.";
        return status;
    }

    if (result.timedOut)
    {
        status.message = "Audiveris was found but its version check timed out.";
        return status;
    }

    if (result.exitCode != 0)
    {
        status.message = "Audiveris was found but its version check failed: "
                       + result.output.trim().substring (0, 1000);
        return status;
    }

    status.available = true;
    status.version = result.output.trim();
    status.message = status.version.isNotEmpty() ? status.version : "Audiveris is ready.";
    return status;
}

ScoreImageImporter::Result ScoreImageImporter::run (
    const juce::File& input,
    std::function<bool()> shouldCancel,
    std::function<void (const juce::String&)> onStage,
    int timeoutMs)
{
    Result result;
    result.sourceName = input.getFileName();

    if (! input.existsAsFile())
    {
        result.error = "No such score image: " + input.getFullPathName();
        return result;
    }

    if (! isSupportedInput (input))
    {
        result.error = "Audiveris reads printed score PDFs and images (PDF, PNG, JPG, TIFF or BMP), "
                       "not " + input.getFileExtension() + ".";
        return result;
    }

    const auto executable = findExecutable();

    if (executable == juce::File())
    {
        result.error = notInstalledMessage();
        return result;
    }

    ScopedDirectory scratch {
        juce::File::getSpecialLocation (juce::File::tempDirectory)
            // Multiple plugin instances can recognize scores at once. A UUID
            // avoids the check-then-create race of getNonexistentChildFile().
            .getChildFile ("riffsheet-omr-" + juce::Uuid().toString())
    };

    if (const auto created = scratch.directory.createDirectory(); created.failed())
    {
        result.error = "Could not create the temporary OMR folder: " + created.getErrorMessage();
        return result;
    }

    if (onStage)
        onStage ("Reading the printed score with Audiveris...");

    auto arguments = audiverisCommand (executable);
    arguments.addArray ({
        "-batch",
        // Audiveris specifically recommends this for multi-page books. On the
        // owner's 8 GB machine, keeping every processed page resident is not a
        // reasonable default; its swap files live in scratch and are cleaned.
        "-swap",
        // Mixed staff+TAB screenshots are common for guitar and bass. Audiveris
        // only identifies tablature when the corresponding processing switches
        // are enabled; once identified, it deliberately ignores the TAB area.
        // That keeps fret digits and TAB lines from contaminating the pitched
        // staff which we import and can regenerate as editable tablature.
        "-constant", "org.audiveris.omr.sheet.ProcessingSwitches.fourStringTablatures=true",
        "-constant", "org.audiveris.omr.sheet.ProcessingSwitches.sixStringTablatures=true",
        "-transcribe",
        "-export",
        "-output", scratch.directory.getFullPathName(),
        "--", input.getFullPathName()
    });

    const auto process = runProcess (arguments, timeoutMs, shouldCancel);
    result.elapsedMs = process.elapsedMs;
    result.cancelled = process.cancelled;
    result.timedOut = process.timedOut;
    result.log = process.output;

    if (! process.started)
    {
        result.error = "Could not launch Audiveris at " + executable.getFullPathName() + ".";
        return result;
    }

    if (process.cancelled)
    {
        result.error = "Image/PDF score import was cancelled.";
        return result;
    }

    if (process.timedOut)
    {
        result.error = "Audiveris did not finish within "
                     + juce::String (juce::jmax (1, timeoutMs / 60000)) + " minutes.";
        return result;
    }

    if (process.exitCode != 0)
    {
        const auto detail = process.output.trim();
        result.error = "Audiveris could not read this score"
                     + (detail.isNotEmpty() ? ": " + detail.substring (0, 2000) : juce::String ("."));
        return result;
    }

    const auto outputs = scratch.directory.findChildFiles (juce::File::findFiles,
                                                           true, "*.mxl");

    if (outputs.isEmpty())
    {
        result.error = "Audiveris finished without producing a MusicXML file."
                     + (process.output.trim().isNotEmpty()
                            ? " Its last message was: " + process.output.trim().substring (
                                  juce::jmax (0, process.output.trim().length() - 1000))
                            : juce::String());
        return result;
    }

    // A single input normally produces one book. If a future Audiveris version
    // emits more, the largest MXL is the compound/full score rather than a tiny
    // per-sheet fragment.
    auto output = outputs.getFirst();
    for (const auto& candidate : outputs)
        if (candidate.getSize() > output.getSize())
            output = candidate;

    const auto outputSize = output.getSize();
    if (outputSize <= 0 || outputSize > maxMusicXmlBytes)
    {
        result.error = outputSize <= 0
                         ? "Audiveris produced an empty MusicXML file."
                         : "Audiveris produced an unexpectedly large MusicXML file.";
        return result;
    }

    if (onStage)
        onStage ("Opening the recognized MusicXML...");

    if (! output.loadFileAsData (result.musicXml))
    {
        result.error = "Could not read Audiveris's MusicXML output.";
        return result;
    }

    result.outputName = output.getFileName();
    result.ok = true;
    return result;
}
