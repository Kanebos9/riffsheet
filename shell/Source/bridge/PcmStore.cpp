#include "PcmStore.h"
#include "SystemProbe.h"
#include "TransferLimits.h"
#include <limits>

namespace
{
    constexpr double maxDecodedDurationSec = 12.0 * 60.0;
    constexpr juce::int64 maxDecodeWorkingBytes = 1024LL * 1024LL * 1024LL;
    constexpr juce::int64 maxDecodeChannels = 64;
    constexpr double maxPlausibleSampleRate = 768000.0;

    bool checkedMultiply (juce::int64 left, juce::int64 right, juce::int64& result)
    {
        if (left < 0 || right < 0
            || (right != 0 && left > std::numeric_limits<juce::int64>::max() / right))
            return false;

        result = left * right;
        return true;
    }

    bool checkedAdd (juce::int64 left, juce::int64 right, juce::int64& result)
    {
        if (left < 0 || right < 0
            || left > std::numeric_limits<juce::int64>::max() - right)
            return false;

        result = left + right;
        return true;
    }
}

PcmStore::Entry::~Entry()
{
    // A capture has no home on the user's disk, and a file dropped onto the page
    // arrives as bytes rather than a path - in both cases the only copy that
    // ever existed on disk is a temp file the shell wrote, and this Entry is the
    // only thing that knows it is there. Nothing else would ever clean it up: a
    // ten-minute take leaves ~50 MB in /tmp per open.
    //
    // Safe because every user of the audio holds a shared_ptr to this Entry (see
    // the LIFETIME note in the header), so nothing can still be reading the file
    // when this runs. In particular a transcription holds the entry for the
    // whole job, exactly so that MuScriptor cannot have the file pulled out from
    // under it.
    //
    // Never runs on the audio thread: the audio thread reads a raw pointer and
    // never touches a refcount, so it can never be the one that drops the last
    // reference. See RiffsheetAudioProcessor::updateTransportSourceFor().
    for (const auto& file : ownedTempFiles)
        if (file.existsAsFile())
            file.deleteFile();
}

PcmStore::PcmStore()
{
    formatManager.registerBasicFormats();   // wav, aiff, flac, ogg, mp3 (+ CoreAudio on mac)
}

juce::String PcmStore::getReadableWildcards() const
{
    return formatManager.getWildcardForAllFormats();
}

juce::String PcmStore::makeTokenLocked()
{
    return "p" + juce::String (nextId++) + "-"
         + juce::String::toHexString (juce::Random::getSystemRandom().nextInt());
}

int PcmStore::purgeExpiredLocked() const
{
    auto removed = 0;

    for (auto it = entries.begin(); it != entries.end();)
    {
        if (it->second.expired())
        {
            it = entries.erase (it);
            ++removed;
        }
        else
        {
            ++it;
        }
    }

    return removed;
}

int PcmStore::purgeExpired() const
{
    const juce::ScopedLock sl (lock);
    return purgeExpiredLocked();
}

std::shared_ptr<const PcmStore::Entry> PcmStore::decodeAndStore (const juce::File& file,
                                                                 double targetSampleRate,
                                                                 juce::String& error,
                                                                 bool takeOwnershipOfFile,
                                                                 const juce::String& displayName)
{
    if (! file.existsAsFile())
    {
        error = "File does not exist: " + file.getFullPathName();
        return {};
    }

    std::unique_ptr<juce::AudioFormatReader> reader;

    try
    {
        // Some format readers allocate while parsing metadata, before we have a
        // chance to inspect lengthInSamples. A malicious chunk must become a
        // normal decode error rather than an exception escaping a VST worker.
        reader.reset (formatManager.createReaderFor (file));
    }
    catch (const std::bad_alloc&)
    {
        error = "Audio metadata is too large to read safely: " + file.getFileName();
        return {};
    }

    if (reader == nullptr)
    {
        error = "Unsupported or unreadable audio file: " + file.getFileName();
        return {};
    }

    const auto declaredFrames = reader->lengthInSamples;
    const auto declaredChannels = (juce::int64) reader->numChannels;
    const auto sourceRate = reader->sampleRate > 0.0
                          ? reader->sampleRate
                          : (targetSampleRate > 0.0 ? targetSampleRate : 44100.0);

    if (declaredFrames <= 0 || declaredChannels <= 0)
    {
        error = "Audio file is empty: " + file.getFileName();
        return {};
    }

    if (declaredChannels > maxDecodeChannels)
    {
        error = "Audio has an unsupported channel count (" + juce::String (declaredChannels)
              + "): " + file.getFileName();
        return {};
    }

    if (! std::isfinite (sourceRate) || sourceRate < 1.0 || sourceRate > maxPlausibleSampleRate)
    {
        error = "Audio has an invalid sample rate: " + file.getFileName();
        return {};
    }

    const auto outputRate = targetSampleRate > 0.0 ? targetSampleRate : sourceRate;

    if (! std::isfinite (outputRate) || outputRate < 1.0 || outputRate > maxPlausibleSampleRate)
    {
        error = "Requested output sample rate is invalid";
        return {};
    }

    if (declaredFrames > (juce::int64) std::numeric_limits<int>::max())
    {
        error = "Audio declares too many samples to decode safely: " + file.getFileName();
        return {};
    }

    const auto durationSec = (double) declaredFrames / sourceRate;

    if (! std::isfinite (durationSec) || durationSec > maxDecodedDurationSec)
    {
        error = "Audio is longer than the 12 minute decode limit: " + file.getFileName();
        return {};
    }

    // PCM WAV sample counts come directly from the data-chunk header. Refuse a
    // declaration that cannot fit in the actual file instead of letting JUCE
    // zero-fill attacker-declared gigabytes beyond EOF.
    if (reader->getFormatName() == "WAV file" && reader->bitsPerSample > 0
        && reader->bitsPerSample % 8 == 0)
    {
        juce::int64 declaredPcmBytes = 0;
        juce::int64 bytesPerFrame = 0;

        if (! checkedMultiply (declaredChannels, (juce::int64) reader->bitsPerSample / 8,
                               bytesPerFrame)
            || ! checkedMultiply (declaredFrames, bytesPerFrame, declaredPcmBytes)
            || declaredPcmBytes > file.getSize())
        {
            error = "WAV data length is inconsistent with the file size: " + file.getFileName();
            return {};
        }
    }

    const auto needsResampling = std::abs (sourceRate - outputRate) > 1.0;
    juce::int64 outputFrames = declaredFrames;

    if (needsResampling)
    {
        const auto calculated = std::floor ((long double) declaredFrames
                                             * (long double) outputRate
                                             / (long double) sourceRate);

        if (calculated <= 0.0L
            || calculated > (long double) std::numeric_limits<int>::max())
        {
            error = "Audio cannot be resampled to the requested rate safely: " + file.getFileName();
            return {};
        }

        outputFrames = (juce::int64) calculated;
    }

    // Bound both allocation phases with checked arithmetic. The interleaved
    // source is released before the resampled buffer is created, so peak use is
    // max(source channels + mono, source mono + output mono), not their sum.
    juce::int64 interleavedSamples = 0;
    juce::int64 interleavedBytes = 0;
    juce::int64 sourceMonoBytes = 0;
    juce::int64 outputMonoBytes = 0;
    juce::int64 sourcePhaseBytes = 0;
    juce::int64 resamplePhaseBytes = 0;

    if (! checkedMultiply (declaredFrames, declaredChannels, interleavedSamples)
        || ! checkedMultiply (interleavedSamples, (juce::int64) sizeof (float), interleavedBytes)
        || ! checkedMultiply (declaredFrames, (juce::int64) sizeof (float), sourceMonoBytes)
        || ! checkedMultiply (outputFrames, (juce::int64) sizeof (float), outputMonoBytes)
        || ! checkedAdd (interleavedBytes, sourceMonoBytes, sourcePhaseBytes)
        || ! checkedAdd (sourceMonoBytes, outputMonoBytes, resamplePhaseBytes)
        || juce::jmax (sourcePhaseBytes, resamplePhaseBytes) > maxDecodeWorkingBytes)
    {
        error = "Audio would need more than 1 GB of decode memory: " + file.getFileName();
        return {};
    }

    const auto numSourceFrames = (int) declaredFrames;
    const auto numChannels = (int) declaredChannels;

    try
    {
        // Read the whole thing, then fold to mono.
        juce::AudioBuffer<float> interleavedByChannel (numChannels, numSourceFrames);

        if (! reader->read (&interleavedByChannel, 0, numSourceFrames, 0, true, true))
        {
            error = "Could not decode audio samples from " + file.getFileName();
            return {};
        }

        juce::AudioBuffer<float> sourceMono (1, numSourceFrames);
        sourceMono.copyFrom (0, 0, interleavedByChannel, 0, 0, numSourceFrames);

        for (int ch = 1; ch < numChannels; ++ch)
            sourceMono.addFrom (0, 0, interleavedByChannel, ch, 0, numSourceFrames);

        if (numChannels > 1)
            sourceMono.applyGain (1.0f / (float) numChannels);

        // Do not keep every source channel alive during resampling.
        interleavedByChannel.setSize (0, 0);

        auto entry = std::make_shared<Entry>();
        entry->sourceFile       = file;
        // The bytes we decoded ARE the original, whatever happens to
        // `sourceFile` later. See the field's comment: persistTake() is allowed
        // to repoint sourceFile at a take of our own making, and before this
        // line existed that was the moment the user's real recording became
        // unreachable to everything above.
        entry->originalFile     = file;
        entry->originalIsVerbatim = true;
        entry->sourceFileIsTemp = takeOwnershipOfFile;
        if (takeOwnershipOfFile)
            entry->ownedTempFiles.addIfNotAlreadyThere (file);
        entry->displayName      = displayName.isNotEmpty() ? displayName : file.getFileName();
        entry->sourceSampleRate = sourceRate;
        entry->sourceChannels   = numChannels;

        if (needsResampling)
        {
            const auto ratio = sourceRate / outputRate;   // input samples consumed per output sample
            const auto numOut = (int) outputFrames;

            juce::AudioBuffer<float> resampled (1, numOut);
            juce::LagrangeInterpolator interpolator;
            interpolator.reset();
            interpolator.process (ratio,
                                  sourceMono.getReadPointer (0),
                                  resampled.getWritePointer (0),
                                  numOut);

            entry->mono = std::move (resampled);
            entry->sampleRate = outputRate;
        }
        else
        {
            entry->mono = std::move (sourceMono);
            entry->sampleRate = sourceRate;
        }

        entry->durationSec = durationSec;

        const juce::ScopedLock sl (lock);
        entry->token = makeTokenLocked();
        entries[entry->token] = entry;   // weak: the caller's shared_ptr is the owner
        purgeExpiredLocked();
        return entry;
    }
    catch (const std::bad_alloc&)
    {
        error = "Not enough memory to decode " + file.getFileName();
        return {};
    }
}

std::shared_ptr<const PcmStore::Entry> PcmStore::storeMono (juce::AudioBuffer<float>&& mono,
                                                            double sampleRate,
                                                            const juce::String& name)
{
    auto entry = std::make_shared<Entry>();
    entry->mono = std::move (mono);
    entry->sampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;
    entry->sourceSampleRate = entry->sampleRate;
    entry->sourceChannels = 1;
    entry->displayName = name;
    entry->durationSec = entry->sampleRate > 0.0
                       ? (double) entry->mono.getNumSamples() / entry->sampleRate
                       : 0.0;

    const juce::ScopedLock sl (lock);
    entry->token = makeTokenLocked();
    entries[entry->token] = entry;   // weak: the caller's shared_ptr is the owner
    purgeExpiredLocked();
    return entry;
}

juce::File PcmStore::ensureSourceFile (const juce::String& token, juce::String& error)
{
    const juce::ScopedLock sourceSl (sourceFileLock);

    // A STRONG reference for the whole call: the temp WAV below belongs to the
    // entry and dies with it, so the entry must not be able to go away while we
    // are writing the file or handing the path back.
    std::shared_ptr<Entry> entry;

    {
        const juce::ScopedLock sl (lock);
        const auto it = entries.find (token);

        if (it != entries.end())
            entry = it->second.lock();
    }

    if (entry == nullptr)
    {
        error = "unknown pcm token: " + token;
        return {};
    }

    if (entry->sourceFile.existsAsFile())
        return entry->sourceFile;

    // No file behind this audio (a capture, or the original was moved) - render
    // the samples we hold to a temp WAV.
    const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
                          .getChildFile ("riffsheet-" + token + ".wav");

    if (! temp.existsAsFile() || temp.getSize() == 0)
    {
        temp.deleteFile();

        auto stream = std::unique_ptr<juce::FileOutputStream> (temp.createOutputStream());

        if (stream == nullptr || ! stream->openedOk())
        {
            error = "could not create " + temp.getFullPathName();
            stream.reset();
            temp.deleteFile();
            return {};
        }

        juce::WavAudioFormat wav;
        std::unique_ptr<juce::AudioFormatWriter> writer (
            wav.createWriterFor (stream.get(), entry->sampleRate, 1, 24, {}, 0));

        if (writer == nullptr)
        {
            error = "could not create a WAV writer for " + temp.getFullPathName();
            stream.reset();
            temp.deleteFile();
            return {};
        }

        stream.release();   // the writer owns it now

        if (! writer->writeFromAudioSampleBuffer (entry->mono, 0, entry->mono.getNumSamples()))
        {
            error = "could not write " + temp.getFullPathName();
            writer.reset();
            temp.deleteFile();
            return {};
        }

        writer.reset();     // flush the header before anyone reads it
    }

    const juce::ScopedLock sl (lock);
    entry->sourceFile = temp;
    // Ours, so ~Entry deletes it. Before this existed every capture that was
    // ever transcribed left a WAV in /tmp for the rest of the machine's life.
    entry->sourceFileIsTemp = true;
    entry->ownedTempFiles.addIfNotAlreadyThere (temp);
    return temp;
}

juce::File PcmStore::persistTake (const juce::String& token,
                                  juce::String& error,
                                  int bitsPerSample,
                                  bool forceOwnedCopy)
{
    const juce::ScopedLock sourceSl (sourceFileLock);

    if (bitsPerSample != 16 && bitsPerSample != 24)
    {
        error = "capture WAV depth must be 16 or 24 bits";
        return {};
    }

    std::shared_ptr<Entry> entry;

    {
        const juce::ScopedLock sl (lock);
        const auto it = entries.find (token);

        if (it != entries.end())
            entry = it->second.lock();
    }

    if (entry == nullptr)
    {
        error = "unknown pcm token: " + token;
        return {};
    }

    // Already durable. This also makes the operation idempotent if a native
    // completion is retried after the write succeeded.
    if (entry->sourceFile.existsAsFile() && ! entry->sourceFileIsTemp && ! forceOwnedCopy)
        return entry->sourceFile;

    if (entry->mono.getNumSamples() <= 0 || entry->sampleRate <= 0.0)
    {
        error = "the decoded audio is empty";
        return {};
    }

    const auto directory = SystemProbe::takesDirectory();

    if (! directory.isDirectory())
    {
        error = "could not create the Riffsheet takes folder at " + directory.getFullPathName();
        return {};
    }

    const auto now = juce::Time::getCurrentTime();
    const auto stamp = juce::String::formatted ("%04d%02d%02d-%02d%02d%02d",
                                                now.getYear(), now.getMonth() + 1, now.getDayOfMonth(),
                                                now.getHours(), now.getMinutes(), now.getSeconds());
    auto stem = juce::File::createLegalFileName (entry->displayName).trim();
    if (stem.isEmpty())
        stem = "Riffsheet take";
    stem = stem.substring (0, 64);

    // UUID rather than getNonexistentChildFile(): multiple plugin instances can
    // stop captures simultaneously, and check-then-create is a race.
    const auto id = juce::Uuid().toString();

    // ---- the verbatim route -------------------------------------------------
    //
    // COPY THE USER'S FILE, DO NOT RE-ENCODE IT. This branch is what makes the
    // takes folder hold the recording rather than a photocopy of the analysis
    // buffer. The old code always wrote `entry->mono` - already folded to mono
    // and already resampled to 44.1 kHz - as a 24-bit WAV and pointed
    // `sourceFile` at it, so a 24-bit/96 kHz stereo file was downgraded on the
    // way in and everything downstream (the document's embedded audio, the
    // "Original" side of the A/B fader, Export ▸ Audio) inherited the downgrade.
    //
    // The bytes are copied rather than merely referenced for the reason
    // forceOwnedCopy exists at all: what gets persisted into a DAW project must
    // be a path this application owns, so restoring a shared project never needs
    // authority over an arbitrary place on the filesystem.
    //
    // Size-bounded, and the fallback below is not a failure: a source bigger
    // than the shared import ceiling keeps the old re-encode, keeps
    // `originalFile` pointing at wherever the user's own file is, and lets
    // getOriginalInfo() report `available = false` so the page says what it did
    // instead of claiming a fidelity it has not got.
    if (forceOwnedCopy
        && entry->originalIsVerbatim
        && entry->originalFile.existsAsFile()
        && ! entry->originalFile.isAChildOf (directory)
        && entry->originalFile.getSize() > 0
        && entry->originalFile.getSize() <= riffsheet::limits::containerBytes)
    {
        auto extension = entry->originalFile.getFileExtension();

        if (extension.isEmpty())
            extension = ".wav";

        const auto verbatimTarget = directory.getChildFile (stem + "-" + stamp + "-" + id + extension);
        const auto verbatimPartial = directory.getChildFile ("." + verbatimTarget.getFileName() + ".partial");

        verbatimPartial.deleteFile();

        // Copy-then-rename, the same crash rule the WAV writer below follows: a
        // half-copied file must never appear at the path a project records.
        if (entry->originalFile.copyFileTo (verbatimPartial)
            && verbatimPartial.moveFileTo (verbatimTarget))
        {
            const juce::ScopedLock sl (lock);
            entry->sourceFile = verbatimTarget;
            entry->sourceFileIsTemp = false;
            entry->originalFile = verbatimTarget;
            entry->originalIsVerbatim = true;
            return verbatimTarget;
        }

        verbatimPartial.deleteFile();
        // Fall through and re-encode. A copy that failed on disk space is still
        // better answered with a smaller derived take than with an error.
    }

    const auto target = directory.getChildFile (stem + "-" + stamp + "-" + id + ".wav");
    const auto partial = directory.getChildFile ("." + target.getFileName() + ".partial");

    partial.deleteFile();
    auto stream = std::unique_ptr<juce::FileOutputStream> (partial.createOutputStream());

    if (stream == nullptr || ! stream->openedOk())
    {
        error = "could not create " + partial.getFullPathName();
        stream.reset();
        partial.deleteFile();
        return {};
    }

    stream->setPosition (0);
    stream->truncate();

    juce::WavAudioFormat wav;
    std::unique_ptr<juce::AudioFormatWriter> writer (
        wav.createWriterFor (stream.get(), entry->sampleRate, 1, bitsPerSample, {}, 0));

    if (writer == nullptr)
    {
        error = "could not create a WAV writer for " + partial.getFullPathName();
        stream.reset();
        partial.deleteFile();
        return {};
    }

    stream.release(); // writer owns and closes it
    const auto wrote = writer->writeFromAudioSampleBuffer (entry->mono, 0, entry->mono.getNumSamples());
    writer.reset(); // flush the WAV header before making the final path visible

    if (! wrote)
    {
        error = "could not write " + partial.getFullPathName();
        partial.deleteFile();
        return {};
    }

    if (! partial.moveFileTo (target))
    {
        error = "could not finish the captured WAV at " + target.getFullPathName();
        partial.deleteFile();
        return {};
    }

    {
        const juce::ScopedLock sl (lock);
        entry->sourceFile = target;
        // Durable takes may be referenced by saved projects months later. They
        // are user data, never scratch owned by the in-memory entry.
        entry->sourceFileIsTemp = false;

        // A take that never had a file of its own - a track capture - has no
        // earlier original to preserve, so THIS is its original: the recorded
        // buffer written out whole, at 24 bits, neither downmixed nor resampled
        // on the way. An entry that DOES have an original keeps pointing at it;
        // this WAV is derived from the analysis buffer and must never be
        // presented as the recording.
        if (entry->originalFile == juce::File())
        {
            entry->originalFile = target;
            entry->originalIsVerbatim = (bitsPerSample >= 24);
        }
    }

    return target;
}

std::shared_ptr<const PcmStore::Entry> PcmStore::get (const juce::String& token) const
{
    const juce::ScopedLock sl (lock);
    const auto it = entries.find (token);

    if (it == entries.end())
        return nullptr;

    // A weak_ptr that has expired means every owner let go - the token is dead,
    // not merely unknown. Both answer nullptr; the map slot goes now.
    auto strong = it->second.lock();

    if (strong == nullptr)
        entries.erase (it);

    return strong;
}

std::optional<std::vector<std::byte>> PcmStore::getRawFloatBytes (const juce::String& token) const
{
    // get() hands back a strong reference, which is what keeps the samples alive
    // for the memcpy below.
    const auto entry = get (token);

    if (entry == nullptr)
        return std::nullopt;

    const auto numSamples = (size_t) entry->mono.getNumSamples();
    const auto* src = entry->mono.getReadPointer (0);

    if (numSamples > std::numeric_limits<size_t>::max() / sizeof (float))
        return std::nullopt;

    try
    {
        std::vector<std::byte> bytes (numSamples * sizeof (float));

        // Float32 little-endian - matches JS `new Float32Array(buffer)` on every
        // platform JUCE targets (all little-endian).
        std::memcpy (bytes.data(), src, bytes.size());
        return bytes;
    }
    catch (const std::bad_alloc&)
    {
        // Resource providers cannot surface an exception safely into a DAW.
        // A missing response lets the page report a normal PCM fetch failure.
        return std::nullopt;
    }
}

PcmStore::OriginalInfo PcmStore::getOriginalInfo (const juce::String& token) const
{
    OriginalInfo info;
    const auto entry = get (token);

    if (entry == nullptr)
        return info;

    const auto file = entry->originalFile;

    if (! file.existsAsFile())
        return info;

    info.bytes = file.getSize();
    info.name = file.getFileName();
    info.verbatim = entry->originalIsVerbatim;
    // Reported even when it is too big to hand over, because "there is a
    // 400 MB original and it will not fit in a document" is a different
    // sentence from "there is no original", and the page has to be able to say
    // the right one.
    info.available = info.bytes > 0 && info.bytes <= riffsheet::limits::containerBytes;
    return info;
}

std::optional<std::vector<std::byte>> PcmStore::getOriginalFileBytes (const juce::String& token) const
{
    // get() hands back a strong reference, which is what stops ~Entry deleting a
    // staged temp file out from under the read below.
    const auto entry = get (token);

    if (entry == nullptr)
        return std::nullopt;

    const auto file = entry->originalFile;

    if (! file.existsAsFile())
        return std::nullopt;

    const auto size = file.getSize();

    // The shared ceiling, checked before anything is allocated. Same constant
    // the picker and the page's document reader use - see TransferLimits.h.
    if (size <= 0 || size > riffsheet::limits::containerBytes)
        return std::nullopt;

    juce::FileInputStream stream (file);

    if (! stream.openedOk())
        return std::nullopt;

    try
    {
        std::vector<std::byte> bytes ((size_t) size);
        const auto read = stream.read (bytes.data(), (int) size);

        // A file that changed underneath us is not the original any more.
        if (read != (int) size)
            return std::nullopt;

        return bytes;
    }
    catch (const std::bad_alloc&)
    {
        // Resource providers cannot surface an exception safely into a DAW; a
        // missing response is a fetch failure the page already handles.
        return std::nullopt;
    }
}

PcmStore::Stats PcmStore::getStats() const
{
    const juce::ScopedLock sl (lock);
    purgeExpiredLocked();

    Stats stats;
    stats.trackedTokens = (int) entries.size();

    for (const auto& pair : entries)
    {
        if (const auto entry = pair.second.lock())
        {
            ++stats.liveEntries;
            stats.totalFrames += (juce::int64) entry->mono.getNumSamples();
            stats.totalBytes  += entry->audioBytes();
        }
    }

    return stats;
}

std::vector<PcmStore::EntryInfo> PcmStore::describeEntries() const
{
    const juce::ScopedLock sl (lock);
    purgeExpiredLocked();

    std::vector<EntryInfo> rows;
    rows.reserve (entries.size());

    for (const auto& pair : entries)
    {
        const auto entry = pair.second.lock();

        if (entry == nullptr)
            continue;

        EntryInfo info;
        info.token            = entry->token;
        info.displayName      = entry->displayName;
        info.sampleRate       = entry->sampleRate;
        info.durationSec      = entry->durationSec;
        info.frames           = (juce::int64) entry->mono.getNumSamples();
        info.bytes            = entry->audioBytes();
        // Minus the strong reference this loop is holding, so a take nobody else
        // wants reads 0 rather than 1.
        info.holders          = juce::jmax (0, (int) entry.use_count() - 1);
        info.hasSourceFile    = entry->sourceFile.existsAsFile();
        info.sourceFileIsTemp = entry->sourceFileIsTemp;
        rows.push_back (std::move (info));
    }

    return rows;
}
