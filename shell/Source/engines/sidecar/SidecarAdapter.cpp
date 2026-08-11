#include "SidecarAdapter.h"
#include "SidecarMidi.h"
#include "ProcessOutputReader.h"
#include "EngineInstaller.h"

namespace
{
    /** A subprocess engine on this machine takes seconds, not minutes; the
        ceiling exists so a wedged child cannot hold a worker for ever, and it is
        generous enough that a long take on a slow machine finishes inside it. */
    constexpr int kJobTimeoutMs = 30 * 60 * 1000;

    juce::var makeObject (std::initializer_list<std::pair<juce::Identifier, juce::var>> properties)
    {
        auto* object = new juce::DynamicObject();

        for (const auto& property : properties)
            object->setProperty (property.first, property.second);

        return juce::var (object);
    }

    juce::File venvBinary (const juce::File& venv, const juce::String& name)
    {
       #if JUCE_WINDOWS
        return venv.getChildFile ("Scripts").getChildFile (name + ".exe");
       #else
        return venv.getChildFile ("bin").getChildFile (name);
       #endif
    }

    /** The last line of `text` that parses as a JSON object.

        Lifted from the beat sidecar for the same reason it had it: a Python
        process prints deprecation warnings, progress bars and library chatter,
        and the answer is whichever line at the end of all that is an object. */
    juce::var lastJsonObject (const juce::String& text)
    {
        auto lines = juce::StringArray::fromLines (text);

        for (int i = lines.size(); --i >= 0;)
        {
            const auto line = lines[i].trim();

            if (! line.startsWithChar ('{'))
                continue;

            const auto parsed = juce::JSON::parse (line);

            if (parsed.getDynamicObject() != nullptr)
                return parsed;
        }

        return {};
    }

    juce::String lastLines (const juce::String& output, int count)
    {
        auto lines = juce::StringArray::fromLines (output.trim());

        while (lines.size() > count)
            lines.remove (0);

        lines.removeEmptyStrings();
        return lines.joinIntoString (" / ");
    }
}

//==============================================================================
SidecarAdapter::SidecarAdapter (const EngineManifest& rowToUse) : row (rowToUse)
{
    rediscover();
}

const EngineManifest& SidecarAdapter::manifest() const noexcept { return row; }

juce::File SidecarAdapter::installDirectory() const
{
    const auto ours = EngineInstaller::engineDirectory (row.id);

    // A copy Riffsheet installed itself always wins: it is the one whose bytes
    // were hashed and whose venv was built and verified here. The recorded
    // location is the OTHER door - somebody who already had this engine pointed
    // us at it (NativeBridge::fnValidateExistingEngineInstall) - and it is only
    // consulted when there is nothing of ours to prefer. It is re-read rather
    // than cached because the folder it names can be deleted from under us, and
    // `recordedLocation` already answers with an invalid File when it has been.
    if (ours.isDirectory())
        return ours;

    if (const auto pointed = EngineInstaller::recordedLocation (row.id); pointed != juce::File())
        return pointed;

    return ours;
}

juce::File SidecarAdapter::executable() const
{
    const auto base = installDirectory();

    // Normally the venv the installer built, one level down. When the user
    // pointed us at a copy they already had, `base` may BE the environment
    // rather than contain one - a plain prefix like /usr/local, or a venv
    // somebody made by hand. Both are just "a folder with bin/ in it", so the
    // only question is which of the two we are holding.
    const auto venv = base.getChildFile ("venv").isDirectory() ? base.getChildFile ("venv") : base;

    // A pip console script IS the engine; a script engine is run by the venv's
    // own interpreter. Either way the answer is inside the environment, and
    // never a Python found on PATH at run time - that would be a different set
    // of packages than the one that was verified.
    if (row.adapter == AdapterKind::sidecarPipCli)
        return venvBinary (venv, row.id);

    return venvBinary (venv, "python");
}

EngineAdapter::Capabilities SidecarAdapter::capabilities() const
{
    Capabilities caps;
    caps.producesBeatGrid = row.producesBeatGrid;
    caps.producesTrueBeats = true;      // via BeatTracker, which needs no venv at all
    caps.producesConfidence = row.producesConfidence;
    caps.producesVelocity = row.producesVelocity;
    caps.acceptsInstrumentConstraint = row.acceptsInstrumentConstraint;
    caps.needsGainNorm = row.needsGainNorm;
    caps.needsTuningNorm = row.needsTuningNorm;
    caps.preferredInputRate = row.preferredInputRate;

    for (int i = 0; i < row.instrumentStrengthCount; ++i)
        caps.instruments.add (row.instrumentStrengths[i]);

    return caps;
}

void SidecarAdapter::rediscover()
{
    const auto binary = executable();
    const auto present = binary.existsAsFile();

    const juce::ScopedLock sl (stateLock);
    installed = present;
    location = present ? binary.getFullPathName() : installDirectory().getFullPathName();

    if (present)
        lastError.clear();
}

EngineAdapter::Status SidecarAdapter::status() const
{
    Status out;

    const juce::ScopedLock sl (stateLock);

    out.location = location;
    out.error = lastError;
    out.searchedPaths.add (installDirectory().getFullPathName());

    if (! installed)
    {
        out.availability = Availability::notInstalled;
        out.stateName = "stopped";
        out.detail = "Not installed yet. One click downloads and sets it up - about "
                   + juce::String (juce::roundToInt ((double) row.approxDiskBytes / (1024.0 * 1024.0)))
                   + " MB on disk.";
        return out;
    }

    // There is no server to be up or down: the program exists, so the engine is
    // usable this second. `broken` is reserved for an install that ran and then
    // failed, which is a fact from the last job rather than from the disk.
    out.availability = lastError.isNotEmpty() ? Availability::broken : Availability::ready;
    out.stateName = lastError.isNotEmpty() ? "failed" : "ready";
    out.detail = lastError.isNotEmpty()
                   ? "Installed, but the last run failed."
                   : "Installed. It runs when a transcription needs it and exits straight after.";
    return out;
}

bool SidecarAdapter::prepare (std::function<void (const juce::String&)> onProgress,
                              std::function<bool()> shouldCancel)
{
    juce::ignoreUnused (shouldCancel);

    rediscover();

    const auto binary = executable();

    if (! binary.existsAsFile())
    {
        const juce::ScopedLock sl (stateLock);
        lastError = juce::String (row.name) + " is not installed. Install it from the engine "
                                              "setup screen and try again.";
        return false;
    }

    if (onProgress != nullptr)
        onProgress ("Starting " + juce::String (row.name) + "...");

    return true;
}

void SidecarAdapter::endOfJob()
{
    // Nothing to give back: the process exited inside transcribe(). This is the
    // one-job rule for free, and it is the reason a sidecar engine costs nothing
    // while the app is idle.
}

//==============================================================================
juce::var SidecarAdapter::transcribe (const AudioInput& input,
                                      const Request& request,
                                      Callbacks callbacks,
                                      juce::String& error)
{
    const auto binary = executable();

    if (! binary.existsAsFile())
    {
        error = juce::String (row.name) + " is not installed.";
        return {};
    }

    const auto scratch = juce::File::getSpecialLocation (juce::File::tempDirectory)
                             .getChildFile ("riffsheet-" + juce::String (row.id) + "-"
                                            + juce::String::toHexString (juce::Random::getSystemRandom()
                                                                             .nextInt64()));
    scratch.createDirectory();

    struct Scratch
    {
        juce::File directory;
        ~Scratch() { directory.deleteRecursively(); }
    } scratchGuard { scratch };

    const auto midiOut = scratch.getChildFile ("out.mid");
    const auto jsonOut = scratch.getChildFile ("out.json");

    //-- the command line ------------------------------------------------------
    juce::StringArray argv;

    for (const auto& token : juce::StringArray::fromTokens (row.argvTemplate, " ", ""))
    {
        if (token.isEmpty())
            continue;

        if      (token == "{python}")      argv.add (binary.getFullPathName());
        else if (token == "{bin}")         argv.add (binary.getFullPathName());
        else if (token == "{script}")      argv.add (installDirectory().getChildFile (row.scriptResource)
                                                                       .getFullPathName());
        else if (token == "{root}")        argv.add (installDirectory().getFullPathName());
        else if (token == "{audio}")       argv.add (input.file.getFullPathName());
        else if (token == "{midi}")        argv.add (midiOut.getFullPathName());
        else if (token == "{json}")        argv.add (jsonOut.getFullPathName());
        // "any", not "": juce::ChildProcess DROPS an empty argument when it
        // builds the child's argv, so `--instruments ""` would reach the sidecar
        // as a bare `--instruments` and be an argparse error rather than "no
        // constraint". Nothing here may ever expand to an empty string.
        else if (token == "{instruments}") argv.add (request.instruments.isEmpty()
                                                         ? juce::String ("any")
                                                         : request.instruments.joinIntoString (","));
        else                                argv.add (token);
    }

    // The rule above, enforced rather than remembered. An empty element here
    // would shift every argument after it by one, silently.
    for (const auto& argument : argv)
    {
        if (argument.isNotEmpty())
            continue;

        error = "Riffsheet built an empty argument for " + juce::String (row.name) + ".";
        jassertfalse;
        return {};
    }

    //-- run it ----------------------------------------------------------------
    juce::ChildProcess child;

    if (! child.start (argv, juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr))
    {
        error = "Could not start " + juce::String (row.name) + ".";

        const juce::ScopedLock sl (stateLock);
        lastError = error;
        return {};
    }

    ProcessOutputReader reader (child);
    reader.start();

    const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) kJobTimeoutMs;
    auto cancelled = false, timedOut = false;

    while (child.isRunning())
    {
        if (callbacks.shouldCancel != nullptr && callbacks.shouldCancel())
        {
            child.kill();
            cancelled = true;
            break;
        }

        if (juce::Time::getMillisecondCounter() > deadline)
        {
            child.kill();
            timedOut = true;
            break;
        }

        juce::Thread::sleep (100);
    }

    child.waitForProcessToFinish (5000);
    const auto output = reader.finishAfterProcessExit();
    const auto exitCode = child.getExitCode();

    if (cancelled)
    {
        error = "cancelled";       // the reserved string, exactly as everywhere else
        return {};
    }

    if (timedOut)
    {
        error = juce::String (row.name) + " did not finish within "
              + juce::String (kJobTimeoutMs / 60000) + " minutes and was stopped.";

        const juce::ScopedLock sl (stateLock);
        lastError = error;
        return {};
    }

    //-- how did it answer? ----------------------------------------------------
    //
    // JSON at {json} first, then the last JSON line of stdout, then the MIDI
    // file. An engine that wrote nothing usable is a failure even with exit 0.
    juce::var payload = jsonOut.existsAsFile() ? juce::JSON::parse (jsonOut) : juce::var();

    if (payload.getDynamicObject() == nullptr)
        payload = lastJsonObject (output);

    juce::Array<juce::var> notes;
    juce::String topInstrument;

    if (auto* object = payload.getDynamicObject())
    {
        const auto reported = object->getProperty ("error");

        if (reported.isString() && reported.toString().isNotEmpty())
        {
            error = juce::String (row.name) + ": " + reported.toString();

            const juce::ScopedLock sl (stateLock);
            lastError = error;
            return {};
        }

        topInstrument = object->getProperty ("instrument").toString();

        if (const auto* array = object->getProperty ("notes").getArray())
        {
            int index = 0;

            for (const auto& item : *array)
            {
                const auto* note = item.getDynamicObject();

                if (note == nullptr)
                    continue;

                const auto instrument = note->getProperty ("instrument").toString();

                notes.add (makeObject ({
                    { "pitch", (int) note->getProperty ("pitch") },
                    { "start", (double) note->getProperty ("start") },
                    { "end", (double) note->getProperty ("end") },
                    { "instrument", instrument.isNotEmpty() ? instrument : topInstrument },
                    { "index", index++ } }));
            }
        }
    }
    else if (midiOut.existsAsFile())
    {
        const auto read = SidecarMidi::read (midiOut);

        if (read.error.isNotEmpty())
        {
            error = juce::String (row.name) + ": " + read.error;

            const juce::ScopedLock sl (stateLock);
            lastError = error;
            return {};
        }

        int index = 0;

        for (const auto& note : read.notes)
            notes.add (makeObject ({ { "pitch", note.pitch },
                                     { "start", note.start },
                                     { "end", note.end },
                                     { "instrument", note.instrument },
                                     { "index", index++ } }));
    }
    else
    {
        // The child's own last words either way: "it wrote nothing" with the
        // reason cut off is a bug report nobody can act on, and an exit code of
        // 0 with no output is exactly the case where the reason matters most.
        error = juce::String (row.name)
              + (exitCode == 0 ? " finished without writing any notes: "
                               : " failed: ")
              + (output.trim().isEmpty() ? juce::String ("it printed nothing at all")
                                         : lastLines (output, 6));

        const juce::ScopedLock sl (stateLock);
        lastError = error;
        return {};
    }

    if (exitCode != 0 && notes.isEmpty())
    {
        error = juce::String (row.name) + " failed: " + lastLines (output, 6);

        const juce::ScopedLock sl (stateLock);
        lastError = error;
        return {};
    }

    //-- the engine's own MIDI, when it wrote one ------------------------------
    juce::String midiBase64;

    if (midiOut.existsAsFile())
        if (juce::MemoryBlock bytes; midiOut.loadFileAsData (bytes))
            midiBase64 = bytes.toBase64Encoding();

    {
        const juce::ScopedLock sl (stateLock);
        lastError.clear();
    }

    if (callbacks.onProgress != nullptr)
        callbacks.onProgress (notes.size(), notes.size());

    // The fixed wire shape. No beat grid: these engines report notes and nothing
    // about tempo, and preciseBeats comes from BeatTracker for every engine now.
    return makeObject ({ { "notes", notes },
                         { "beatGrid", juce::var() },
                         { "onsetDelay", 0.0 },
                         { "midiBase64", midiBase64 },
                         { "truncated", false } });
}
