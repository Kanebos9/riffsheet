#include "EnginePreprocess.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace EnginePreprocess
{
namespace
{
    constexpr double kTwoPi = 6.283185307179586476925286766559;
    constexpr int    kFftBins = kFftSize / 2 + 1;

    /** Periodic Hann, the same convention every STFT in this codebase uses. */
    const std::vector<float>& hannWindow()
    {
        static const std::vector<float> window = []
        {
            std::vector<float> w ((size_t) kFftSize);

            for (int n = 0; n < kFftSize; ++n)
                w[(size_t) n] = (float) (0.5 - 0.5 * std::cos (kTwoPi * (double) n / (double) kFftSize));

            return w;
        }();

        return window;
    }

    /** Floored rather than -infinity: this number is reported over the bridge,
        and an infinity is not a JSON value. -300 dBFS is digital silence by any
        measure anybody will ever have. */
    double gainToDb (double gain) noexcept
    {
        return gain > 0.0 ? juce::jmax (-300.0, 20.0 * std::log10 (gain)) : -300.0;
    }

    double dbToGain (double db) noexcept
    {
        return std::pow (10.0, db / 20.0);
    }

    /** Cents away from the nearest A440 semitone, in [-50, +50). */
    double centsOffGrid (double frequencyHz) noexcept
    {
        const auto d = 1200.0 * std::log2 (frequencyHz / 440.0);
        auto wrapped = d - 100.0 * std::floor (d / 100.0 + 0.5);

        if (wrapped >= 50.0)   // the boundary belongs to the flat side, so the interval is half open
            wrapped -= 100.0;

        return wrapped;
    }

    juce::String describeCents (double cents)
    {
        const auto rounded = juce::String (std::abs (cents), 1);
        return rounded + (cents >= 0.0 ? " cents sharp" : " cents flat");
    }

    //==========================================================================
    struct Decoded
    {
        juce::AudioBuffer<float> mono;
        double sampleRate = 0.0;
        juce::String error;

        bool ok() const noexcept { return error.isEmpty() && mono.getNumSamples() > 0; }
    };

    /** The WHOLE file, downmixed to mono at its own rate.

        Deliberately re-read rather than borrowed from the PcmStore entry the job
        is already holding: that buffer has been downmixed AND resampled to the
        store's rate once already, so writing the engine's copy from it would
        resample twice and would quietly change the rate the engine sees. It also
        does not exist at all for a `{ path }` transcribe. One decode of a take
        is milliseconds against a transcription, and it keeps this file free of
        PcmStore so it can be unit-tested without a plugin host. */
    Decoded decodeMono (const juce::File& file)
    {
        Decoded out;

        juce::AudioFormatManager formats;
        formats.registerBasicFormats();

        std::unique_ptr<juce::AudioFormatReader> reader (formats.createReaderFor (file));

        if (reader == nullptr)
        {
            out.error = "Riffsheet could not re-read " + file.getFileName()
                      + " - the format is not one this build understands.";
            return out;
        }

        const auto frames = (juce::int64) reader->lengthInSamples;
        const auto channels = (int) reader->numChannels;

        if (frames <= 0 || channels <= 0 || reader->sampleRate <= 0.0)
        {
            out.error = "There is no audio in " + file.getFileName() + ".";
            return out;
        }

        // Same spirit as PcmStore's decode ceiling: peak use here is the source
        // channels plus one mono buffer, and preprocessing must never be the
        // thing that takes the host down.
        const auto bytes = frames * (juce::int64) (channels + 1) * (juce::int64) sizeof (float);

        if (frames > (juce::int64) std::numeric_limits<int>::max() || bytes > kMaxDecodeBytes)
        {
            out.error = file.getFileName() + " is too long to preprocess in memory.";
            return out;
        }

        juce::AudioBuffer<float> whole (channels, (int) frames);

        if (! reader->read (&whole, 0, (int) frames, 0, true, true))
        {
            out.error = "Reading " + file.getFileName() + " failed part way through.";
            return out;
        }

        out.mono.setSize (1, (int) frames);
        out.mono.copyFrom (0, 0, whole, 0, 0, (int) frames);

        for (int ch = 1; ch < channels; ++ch)
            out.mono.addFrom (0, 0, whole, ch, 0, (int) frames);

        if (channels > 1)
            out.mono.applyGain (1.0f / (float) channels);

        out.sampleRate = reader->sampleRate;
        return out;
    }

    /** juce::LagrangeInterpolator, the project's resampler since PcmStore.cpp:278.
        `speedRatio` is input samples consumed per output sample. */
    void resample (const juce::AudioBuffer<float>& in, double speedRatio,
                   juce::AudioBuffer<float>& out, int numOut)
    {
        out.setSize (1, numOut);
        out.clear();

        juce::LagrangeInterpolator interpolator;
        interpolator.reset();
        interpolator.process (speedRatio, in.getReadPointer (0), out.getWritePointer (0), numOut);
    }

    //== the timebase map's two primitives ====================================

    bool isNumber (const juce::var& value) noexcept
    {
        return value.isDouble() || value.isInt() || value.isInt64();
    }

    void scaleNumber (juce::DynamicObject* object, const char* name, double factor)
    {
        if (object == nullptr || ! object->hasProperty (name))
            return;

        const auto value = object->getProperty (name);

        if (isNumber (value))
            object->setProperty (name, (double) value * factor);
    }

    void scaleNumberArray (juce::DynamicObject* object, const char* name, double factor)
    {
        if (object == nullptr || ! object->hasProperty (name))
            return;

        auto value = object->getProperty (name);

        if (auto* array = value.getArray())
        {
            for (auto& item : *array)
                if (isNumber (item))
                    item = (double) item * factor;

            object->setProperty (name, value);
        }
    }
}

//==============================================================================
TuningEstimate estimateTuning (const float* mono, juce::int64 numSamples, double sampleRate)
{
    TuningEstimate estimate;

    if (mono == nullptr || numSamples < kFftSize || sampleRate <= 0.0)
        return estimate;

    const auto& window = hannWindow();

    juce::dsp::FFT fft (12);   // 2^12 == kFftSize
    jassert (fft.getSize() == kFftSize);

    std::vector<float> scratch ((size_t) kFftSize * 2, 0.0f);
    std::vector<float> magnitude ((size_t) kFftBins, 0.0f);
    std::vector<float> sorted ((size_t) kFftBins, 0.0f);

    // Only bins that can carry a fundamental worth measuring. Below 80 Hz a
    // 5.4 Hz bin is a quarter tone wide and says nothing; above 2 kHz the
    // partials of everything in the room outnumber the fundamentals.
    const auto binHz = sampleRate / (double) kFftSize;
    const auto firstBin = juce::jmax (1, (int) std::floor (kMinPeakHz / binHz));
    const auto lastBin  = juce::jmin (kFftBins - 2, (int) std::ceil (kMaxPeakHz / binHz));

    if (firstBin >= lastBin)
        return estimate;

    auto sumRe = 0.0, sumIm = 0.0, sumWeight = 0.0;
    auto peaks = 0;

    for (juce::int64 offset = 0; offset + kFftSize <= numSamples; offset += kHop)
    {
        std::fill (scratch.begin(), scratch.end(), 0.0f);

        for (int n = 0; n < kFftSize; ++n)
            scratch[(size_t) n] = mono[offset + n] * window[(size_t) n];

        fft.performRealOnlyForwardTransform (scratch.data(), true);

        for (int bin = 0; bin < kFftBins; ++bin)
        {
            const auto re = scratch[(size_t) bin * 2];
            const auto im = scratch[(size_t) bin * 2 + 1];
            magnitude[(size_t) bin] = std::sqrt (re * re + im * im);
        }

        // A partial has to stand well clear of the frame's own noise floor. The
        // median over the whole spectrum IS that floor for anything tonal, and
        // for a frame that is all noise it rises with the noise - which is
        // exactly why white noise yields almost no peaks and so no estimate.
        sorted = magnitude;
        std::nth_element (sorted.begin(), sorted.begin() + kFftBins / 2, sorted.end());
        const auto threshold = (double) sorted[(size_t) (kFftBins / 2)] * kPeakOverMedian;

        if (! (threshold > 0.0))
            continue;

        for (int bin = firstBin; bin <= lastBin; ++bin)
        {
            const auto m1 = (double) magnitude[(size_t) bin];

            if (m1 < threshold)
                continue;

            const auto m0 = (double) magnitude[(size_t) (bin - 1)];
            const auto m2 = (double) magnitude[(size_t) (bin + 1)];

            if (! (m1 > m0 && m1 >= m2))   // three-point local maximum
                continue;

            // Parabolic interpolation on the LOG magnitudes: for a Hann window
            // that is accurate to a fraction of a cent, and a bare bin index
            // would be up to a quarter tone out at these frequencies.
            const auto a = std::log (m0 + 1.0e-20);
            const auto b = std::log (m1 + 1.0e-20);
            const auto c = std::log (m2 + 1.0e-20);
            const auto denominator = a - 2.0 * b + c;

            auto delta = 0.0;

            if (std::abs (denominator) > 1.0e-20)
                delta = 0.5 * (a - c) / denominator;

            if (! std::isfinite (delta) || std::abs (delta) > 0.5)
                delta = 0.0;

            const auto frequency = ((double) bin + delta) * binHz;

            if (frequency < kMinPeakHz || frequency > kMaxPeakHz)
                continue;

            // Every partial gets a vote on the unit circle at its distance from
            // the nearest equal-tempered step, weighted by how loud it is. The
            // circle is what makes 49 cents sharp and 51 cents flat the same
            // answer, which is true and is why kAmbiguousCents exists.
            const auto phase = kTwoPi * centsOffGrid (frequency) / 100.0;

            sumRe += m1 * std::cos (phase);
            sumIm += m1 * std::sin (phase);
            sumWeight += m1;
            ++peaks;
        }
    }

    estimate.peaks = peaks;

    if (peaks <= 0 || ! (sumWeight > 0.0))
        return estimate;

    estimate.concentration = std::sqrt (sumRe * sumRe + sumIm * sumIm) / sumWeight;

    auto cents = 100.0 * std::atan2 (sumIm, sumRe) / kTwoPi;

    if (cents >= 50.0)
        cents -= 100.0;

    estimate.cents = juce::jlimit (-50.0, 50.0, cents);
    estimate.reliable = peaks >= kMinPeaks && estimate.concentration > kMinConcentration;
    estimate.ambiguous = std::abs (estimate.cents) >= kAmbiguousCents;
    estimate.confident = estimate.reliable
                      && ! estimate.ambiguous
                      && std::abs (estimate.cents) > kMinCents;
    return estimate;
}

//==============================================================================
Result run (const juce::File& source,
            const Request& request,
            const std::function<bool()>& shouldCancel)
{
    const auto cancelled = [&shouldCancel] { return shouldCancel != nullptr && shouldCancel(); };

    Result out;
    out.file = source;   // and it stays this object unless a file is actually written

    // THE FAST PATH, and the reason this whole step is free for engines that
    // want nothing: no decode, no STFT, no stat, no file. An engine whose
    // manifest asks for neither correction - or a user who turned both off -
    // gets exactly the bytes it would have got before this existed.
    if (! request.wantGainNorm && ! request.wantTuningNorm && ! (request.outputRate > 0.0))
    {
        out.note = "The engine was given the recording untouched.";
        return out;
    }

    if (cancelled())
    {
        out.error = "cancelled";
        out.note = "Cancelled before the recording was prepared.";
        return out;
    }

    auto decoded = decodeMono (source);

    if (! decoded.ok())
    {
        // NOT FATAL. Losing a transcription because the level could not be
        // measured would be a far worse bug than not levelling it.
        out.error = decoded.error;
        out.note = "The recording could not be re-read to prepare it, so the engine was "
                   "given it untouched.";
        return out;
    }

    if (cancelled())
    {
        out.error = "cancelled";
        out.note = "Cancelled while preparing the recording.";
        return out;
    }

    //-- 1. how far off A440 is it? -------------------------------------------
    TuningEstimate estimate;

    if (request.wantTuningNorm && ! request.drumsOnly)
    {
        // The estimate runs at 22.05 kHz whatever the file is: nothing it looks
        // at is above 2 kHz, and halving the rate halves the FFT count.
        if (std::abs (decoded.sampleRate - kAnalysisRate) < 1.0e-9)
        {
            estimate = estimateTuning (decoded.mono.getReadPointer (0),
                                       decoded.mono.getNumSamples(), kAnalysisRate);
        }
        else
        {
            const auto ratio = decoded.sampleRate / kAnalysisRate;
            const auto analysisFrames =
                (juce::int64) std::floor ((double) decoded.mono.getNumSamples() / ratio);

            if (analysisFrames >= kFftSize)
            {
                juce::AudioBuffer<float> analysis;
                resample (decoded.mono, ratio, analysis, (int) analysisFrames);
                estimate = estimateTuning (analysis.getReadPointer (0), analysisFrames, kAnalysisRate);
            }
        }
    }

    out.cents = estimate.cents;
    out.concentration = estimate.concentration;
    out.peaks = estimate.peaks;

    if (cancelled())
    {
        out.error = "cancelled";
        out.note = "Cancelled while preparing the recording.";
        return out;
    }

    //-- 2. the resample that corrects it -------------------------------------
    //
    // Playing at speed s multiplies every frequency by s and divides every time
    // by s, so correcting a recording that is `cents` sharp means playing it at
    // s = 2^(-cents/1200) - and every time the engine reports afterwards is in
    // that stretched timebase until applyTimebase() puts it back.
    const auto speed = estimate.confident ? std::pow (2.0, -estimate.cents / 1200.0) : 1.0;
    const auto outputRate = request.outputRate > 0.0 ? request.outputRate : decoded.sampleRate;
    const auto rateChanged = std::abs (outputRate - decoded.sampleRate) > 1.0e-9;
    const auto needsResample = speed != 1.0 || rateChanged;

    juce::AudioBuffer<float> processed;

    if (needsResample)
    {
        const auto speedRatio = speed * decoded.sampleRate / outputRate;
        const auto frames = (juce::int64) std::floor ((double) decoded.mono.getNumSamples() / speedRatio);

        if (frames < 1 || frames > (juce::int64) std::numeric_limits<int>::max())
        {
            out.file = source;
            out.error = "The corrected copy would be an impossible length.";
            out.note = "The tuning correction could not be applied, so the engine was given "
                       "the recording untouched.";
            return out;
        }

        resample (decoded.mono, speedRatio, processed, (int) frames);
    }
    else
    {
        processed = std::move (decoded.mono);
    }

    //-- 3. the level ---------------------------------------------------------
    //
    // Measured AFTER the resample, on purpose: interpolation can overshoot the
    // original peak, so a gain worked out beforehand would miss the target by
    // exactly the amount that matters.
    const auto peak = (double) processed.getMagnitude (0, 0, processed.getNumSamples());
    const auto peakDbfs = gainToDb (peak);
    out.sourcePeakDbfs = peakDbfs;

    auto gainDb = 0.0;
    auto gainCapped = false;
    auto tooQuiet = false;

    if (request.wantGainNorm)
    {
        if (peakDbfs < kSilenceDbfs)
        {
            // Amplifying silence amplifies only the noise in it.
            tooQuiet = true;
        }
        else
        {
            gainDb = request.targetPeakDbfs - peakDbfs;

            if (gainDb > kMaxBoostDb)
            {
                gainDb = kMaxBoostDb;
                gainCapped = true;
            }

            if (std::abs (gainDb) <= kGainDeadbandDb)
                gainDb = 0.0;
        }
    }

    const auto needsGain = gainDb != 0.0;

    //-- 4. is there anything to write at all? --------------------------------
    if (! needsResample && ! needsGain)
    {
        out.file = source;
        out.wroteFile = false;
        out.pitchRatio = 1.0;

        juce::StringArray reasons;

        if (request.wantTuningNorm && ! request.drumsOnly)
        {
            if (estimate.ambiguous)
                reasons.add ("The tuning came out " + describeCents (estimate.cents)
                             + ", which is the quarter-tone boundary where sharp and flat are the "
                               "same answer, so it was left alone.");
            else if (! estimate.reliable)
                reasons.add ("The tuning could not be estimated with confidence ("
                             + juce::String (estimate.peaks) + " partials, agreement "
                             + juce::String (estimate.concentration, 2) + "), so it was left alone.");
            else
                reasons.add ("The tuning is within " + juce::String (std::abs (estimate.cents), 1)
                             + " cents of A440, so the pitch was left alone.");
        }

        if (request.wantGainNorm)
        {
            if (tooQuiet)
                reasons.add ("The recording peaks at " + juce::String (peakDbfs, 1)
                             + " dBFS, which is quiet enough that raising it would raise only "
                               "noise, so the level was left alone.");
            else
                reasons.add ("The level is already " + juce::String (peakDbfs, 1)
                             + " dBFS, so it was left alone.");
        }

        out.note = reasons.isEmpty() ? juce::String ("The engine was given the recording untouched.")
                                     : reasons.joinIntoString (" ");
        return out;
    }

    if (needsGain)
        processed.applyGain ((float) dbToGain (gainDb));

    //-- 5. write it, next to nothing of the user's -------------------------
    //
    // A NEW FILE IN THE TEMP DIRECTORY, never the source: ensureSourceFile()
    // hands back the user's own file when there is one, so anything written
    // over it would be an edit to a file they chose in a dialog.
    //
    // The name is derived from the source, its mtime and the exact parameters,
    // so a crashed job's leftover is overwritten by the next identical one
    // instead of accumulating. The caller still deletes it when the job ends -
    // this file belongs to the job, exactly like the take's temp WAV belongs to
    // its PcmStore entry.
    const auto key = source.getFullPathName()
                   + "|" + juce::String (source.getLastModificationTime().toMilliseconds())
                   + "|" + juce::String (source.getSize())
                   + "|" + juce::String (speed, 12)
                   + "|" + juce::String (gainDb, 6)
                   + "|" + juce::String (outputRate, 3);

    auto name = "riffsheet-pre-" + juce::String::toHexString ((juce::int64) key.hashCode64());

    if (request.engineId.isNotEmpty())
        name += "-" + juce::File::createLegalFileName (request.engineId);

    const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
                          .getChildFile (name + ".wav");
    temp.deleteFile();

    auto stream = std::unique_ptr<juce::FileOutputStream> (temp.createOutputStream());

    if (stream == nullptr || ! stream->openedOk())
    {
        stream.reset();
        temp.deleteFile();
        out.file = source;
        out.error = "could not create " + temp.getFullPathName();
        out.note = "The prepared copy could not be written, so the engine was given the "
                   "recording untouched.";
        return out;
    }

    juce::WavAudioFormat wav;
    std::unique_ptr<juce::AudioFormatWriter> writer (
        wav.createWriterFor (stream.get(), outputRate, 1, 24, {}, 0));

    if (writer == nullptr)
    {
        stream.reset();
        temp.deleteFile();
        out.file = source;
        out.error = "could not create a WAV writer for " + temp.getFullPathName();
        out.note = "The prepared copy could not be written, so the engine was given the "
                   "recording untouched.";
        return out;
    }

    stream.release();   // the writer owns it now

    if (! writer->writeFromAudioSampleBuffer (processed, 0, processed.getNumSamples()))
    {
        writer.reset();
        temp.deleteFile();
        out.file = source;
        out.error = "could not write " + temp.getFullPathName();
        out.note = "The prepared copy could not be written, so the engine was given the "
                   "recording untouched.";
        return out;
    }

    writer.reset();   // flush the header before anybody reads it

    out.file = temp;
    out.wroteFile = true;
    out.pitchRatio = speed;
    out.gainDb = gainDb;

    juce::StringArray done;

    if (estimate.confident)
        done.add ("Corrected " + describeCents (estimate.cents) + " to A440.");

    if (needsGain)
        done.add ("Brought the level from " + juce::String (peakDbfs, 1) + " dBFS to "
                  + juce::String (peakDbfs + gainDb, 1) + " dBFS."
                  + (gainCapped ? " The boost was capped at " + juce::String (kMaxBoostDb, 0) + " dB."
                                : juce::String()));

    if (rateChanged)
        done.add ("Resampled to " + juce::String (outputRate, 0) + " Hz for this engine.");

    out.note = done.isEmpty() ? juce::String ("The engine was given a prepared copy of the recording.")
                              : done.joinIntoString (" ");
    return out;
}

//==============================================================================
void applyTimebase (juce::var& result, double pitchRatio)
{
    if (! (pitchRatio > 0.0) || pitchRatio == 1.0)
        return;

    auto* object = result.getDynamicObject();

    if (object == nullptr)
        return;

    // Notes first, because they are the thing a wrong map is most visibly wrong
    // about: at 20 cents a three-minute take drifts two seconds against its own
    // beat grid, which reads as a bad transcription rather than as a bug here.
    auto notes = object->getProperty ("notes");

    if (auto* array = notes.getArray())
    {
        for (auto& note : *array)
        {
            if (auto* noteObject = note.getDynamicObject())
            {
                scaleNumber (noteObject, "start", pitchRatio);
                scaleNumber (noteObject, "end", pitchRatio);
            }
        }

        object->setProperty ("notes", notes);
    }

    scaleNumber (object, "onsetDelay", pitchRatio);

    // The constant-tempo grid: times stretch with the audio, tempo does the
    // opposite. `beatsPerBar` is a count and stays where it is.
    auto beatGrid = object->getProperty ("beatGrid");

    if (auto* grid = beatGrid.getDynamicObject())
    {
        scaleNumber (grid, "firstDownbeat", pitchRatio);
        scaleNumber (grid, "onsetDelay", pitchRatio);
        scaleNumberArray (grid, "beats", pitchRatio);

        if (grid->hasProperty ("bpm") && isNumber (grid->getProperty ("bpm")))
            grid->setProperty ("bpm", (double) grid->getProperty ("bpm") / pitchRatio);

        object->setProperty ("beatGrid", beatGrid);
    }

    // The tracked per-beat times, which are measured on the same prepared file.
    auto preciseBeats = object->getProperty ("preciseBeats");

    if (auto* beats = preciseBeats.getDynamicObject())
    {
        scaleNumberArray (beats, "beats", pitchRatio);
        scaleNumberArray (beats, "downbeats", pitchRatio);

        if (beats->hasProperty ("bpm") && isNumber (beats->getProperty ("bpm")))
            beats->setProperty ("bpm", (double) beats->getProperty ("bpm") / pitchRatio);

        object->setProperty ("preciseBeats", preciseBeats);
    }

    // The SMF the engine handed back is bytes, not numbers, and its note times
    // are in the prepared file's timebase - so after a correction it disagrees
    // with the note list beside it. Rewriting a MIDI file to fix that is work
    // nobody needs: the page rebuilds MIDI from `notes` and reads this field
    // nowhere. Drop it rather than ship two timebases in one payload.
    if (object->hasProperty ("midiBase64"))
        object->setProperty ("midiBase64", juce::String());
}
}
