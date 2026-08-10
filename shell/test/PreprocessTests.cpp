#include <JuceHeader.h>

#include "EngineCatalog.h"
#include "EnginePreprocess.h"

#include <cmath>
#include <vector>

/**
    What happens to the audio between the user's file and an engine's ears.

    THE ONE TEST THAT MATTERS MOST IS `the timebase survives a correction`.
    Correcting pitch by resampling also changes time, and every note the engine
    reports afterwards is in the stretched timebase. Nothing about the output
    LOOKS wrong when that map is missing - the notes are all there, the pitches
    are right, and the whole take drifts against its own beat grid by a fraction
    of a percent that grows to seconds over three minutes. So the click-track
    fixture below is built the way the physical situation really is: an
    instrument tuned 30 cents sharp does NOT play late, it plays on time at the
    wrong pitch. The correction is what makes it play late, and the inverse map
    is what puts it back. A click track pins that to the millisecond.

    Everything here is synthetic and generated in the test: no fixture files, no
    model, no network, no venv. The units under test are the estimator, the
    resample-and-write step and the inverse map, and all three are pure.
*/
class PreprocessTests final : public juce::UnitTest
{
public:
    PreprocessTests() : juce::UnitTest ("EnginePreprocess", "EnginePreprocess") {}

    //== fixtures =============================================================

    /** A scratch directory of our own, removed however the run ends. */
    struct Scratch
    {
        Scratch()
            : dir (juce::File::getSpecialLocation (juce::File::tempDirectory)
                       .getChildFile ("riffsheet-preprocess-tests-"
                                      + juce::String (juce::Random::getSystemRandom().nextInt (1000000))))
        {
            dir.createDirectory();
        }

        ~Scratch() { dir.deleteRecursively(); }

        juce::File file (const juce::String& name) const { return dir.getChildFile (name); }

        juce::File dir;
    };

    static juce::AudioBuffer<float> makeTone (double rate, double seconds,
                                              const std::vector<double>& partialsHz,
                                              const std::vector<double>& amplitudes)
    {
        const auto frames = (int) std::floor (rate * seconds);
        juce::AudioBuffer<float> buffer (1, frames);
        buffer.clear();

        auto* out = buffer.getWritePointer (0);

        for (size_t p = 0; p < partialsHz.size(); ++p)
        {
            const auto omega = juce::MathConstants<double>::twoPi * partialsHz[p] / rate;
            const auto amp = amplitudes[p];

            for (int n = 0; n < frames; ++n)
                out[n] += (float) (amp * std::sin (omega * (double) n));
        }

        return buffer;
    }

    /** Scales a buffer so its peak lands exactly on `dbfs`. */
    static void setPeak (juce::AudioBuffer<float>& buffer, double dbfs)
    {
        const auto peak = (double) buffer.getMagnitude (0, 0, buffer.getNumSamples());

        if (peak > 0.0)
            buffer.applyGain ((float) (std::pow (10.0, dbfs / 20.0) / peak));
    }

    static double peakDbfs (const juce::AudioBuffer<float>& buffer)
    {
        const auto peak = (double) buffer.getMagnitude (0, 0, buffer.getNumSamples());
        return peak > 0.0 ? 20.0 * std::log10 (peak) : -300.0;
    }

    static bool writeWav (const juce::File& file, const juce::AudioBuffer<float>& buffer, double rate)
    {
        file.deleteFile();
        auto stream = std::unique_ptr<juce::FileOutputStream> (file.createOutputStream());

        if (stream == nullptr || ! stream->openedOk())
            return false;

        juce::WavAudioFormat wav;
        std::unique_ptr<juce::AudioFormatWriter> writer (
            wav.createWriterFor (stream.get(), rate, 1, 24, {}, 0));

        if (writer == nullptr)
            return false;

        stream.release();
        const auto ok = writer->writeFromAudioSampleBuffer (buffer, 0, buffer.getNumSamples());
        writer.reset();
        return ok;
    }

    static juce::AudioBuffer<float> readWav (const juce::File& file, double& rate)
    {
        juce::AudioFormatManager formats;
        formats.registerBasicFormats();
        std::unique_ptr<juce::AudioFormatReader> reader (formats.createReaderFor (file));

        if (reader == nullptr)
            return {};

        rate = reader->sampleRate;
        juce::AudioBuffer<float> buffer ((int) reader->numChannels, (int) reader->lengthInSamples);
        reader->read (&buffer, 0, (int) reader->lengthInSamples, 0, true, true);
        return buffer;
    }

    /** A click track: short bursts at known times over a sustained tone.

        The bursts are 4 ms of 8 kHz under a Hann envelope, at 0.85; the tone
        peaks at 0.11, so the sum never reaches 1.0 and the 24-bit fixture cannot
        clip. That matters more than it looks: a clipped burst has a FLAT top,
        the detector below then has no peak to find, and the test fails for a
        reason that has nothing to do with the code under test. The tone is what
        the tuning estimator reads; the bursts are what the timebase is measured
        with, and 18 dB between them keeps the two from ever being confused. */
    static juce::AudioBuffer<float> makeClickTrack (double rate, double seconds,
                                                    const std::vector<double>& clickTimes,
                                                    double toneHz)
    {
        auto buffer = makeTone (rate, seconds,
                                { toneHz, toneHz * 2.0, toneHz * 3.0 },
                                { 0.06, 0.03, 0.02 });

        auto* out = buffer.getWritePointer (0);
        const auto burst = (int) std::floor (rate * 0.004);

        for (const auto time : clickTimes)
        {
            const auto start = (int) std::llround (time * rate);

            for (int n = 0; n < burst && start + n < buffer.getNumSamples(); ++n)
            {
                const auto envelope = 0.5 - 0.5 * std::cos (juce::MathConstants<double>::twoPi
                                                            * (double) n / (double) (burst - 1));
                out[start + n] += (float) (0.85 * envelope
                                             * std::sin (juce::MathConstants<double>::twoPi * 8000.0
                                                          * (double) n / rate));
            }
        }

        return buffer;
    }

    /** The energy centroid of each burst, in seconds.

        Not the loudest sample: resampling moves the 8 kHz carrier's peaks
        relative to the envelope, so an argmax wanders by up to half a carrier
        period for reasons that have nothing to do with the timebase. The
        centroid of x^2 over the burst is a property of the ENVELOPE, which is
        what the resampler preserves and what a beat lands on. */
    static std::vector<double> findClicks (const juce::AudioBuffer<float>& buffer, double rate)
    {
        std::vector<double> times;
        const auto* in = buffer.getReadPointer (0);
        const auto frames = buffer.getNumSamples();
        const auto refractory = (int) (rate * 0.05);
        const auto halfWindow = (int) (rate * 0.004);

        auto n = 0;

        while (n < frames)
        {
            if (std::abs (in[n]) < 0.4f)
            {
                ++n;
                continue;
            }

            auto best = n;
            auto end = n;

            while (end < frames && end < n + refractory)
            {
                if (std::abs (in[end]) > std::abs (in[best]))
                    best = end;

                ++end;
            }

            const auto gate = 0.3 * std::abs ((double) in[best]);
            auto weight = 0.0, moment = 0.0;

            for (auto k = juce::jmax (0, best - halfWindow);
                 k < juce::jmin (frames, best + halfWindow); ++k)
            {
                const auto magnitude = std::abs ((double) in[k]);

                if (magnitude < gate)
                    continue;

                const auto energy = magnitude * magnitude;
                weight += energy;
                moment += energy * (double) k;
            }

            times.push_back ((weight > 0.0 ? moment / weight : (double) best) / rate);
            n = end;
        }

        return times;
    }

    static juce::var makeNote (double start, double end, int pitch)
    {
        auto* object = new juce::DynamicObject();
        object->setProperty ("pitch", pitch);
        object->setProperty ("start", start);
        object->setProperty ("end", end);
        return juce::var (object);
    }

    //== the tests ============================================================

    void runTest() override
    {
        theManifestDecidesWhoGetsThis();
        estimatorReadsConcertPitch();
        estimatorReadsADetunedTone();
        estimatorRefusesNoise();
        estimatorRefusesTheQuarterToneBoundary();
        estimatorIgnoresATransposition();
        fastPathTouchesNothing();
        inTuneAndAlreadyLevelIsLeftAlone();
        peakNormalisationHitsTheTarget();
        silenceIsLeftAlone();
        theBoostIsCapped();
        timebaseSurvivesACorrection();
        inverseMapCoversEveryTime();
        realClipExport();
    }

    //-- who gets preprocessed at all -----------------------------------------

    /** The other half of this feature is a pair of booleans in the compiled
        engine table, and the bridge reads them straight off the manifest. Flip
        one by accident and the built-in engine starts being handed a resampled,
        re-levelled file for every job with nothing to say so. */
    void theManifestDecidesWhoGetsThis()
    {
        beginTest ("the manifest decides which engines are preprocessed");

        const auto* basicPitch = EngineCatalog::find ("basic-pitch");
        const auto* muScriptor = EngineCatalog::find ("muscriptor");

        expect (basicPitch != nullptr && muScriptor != nullptr, "the catalog lost an engine");

        if (basicPitch == nullptr || muScriptor == nullptr)
            return;

        // Basic Pitch normalises internally and was measured gain-invariant, so
        // preprocessing it would be a copy, a resample and a rewrite for nothing.
        expect (! basicPitch->needsGainNorm, "basic-pitch normalises its own input");
        expect (! basicPitch->needsTuningNorm, "basic-pitch asked for no tuning correction");

        // MuScriptor does neither for itself.
        expect (muScriptor->needsGainNorm, "muscriptor has no internal gain normalisation");
        expect (muScriptor->needsTuningNorm, "muscriptor expects A440");
    }

    //-- the estimate ---------------------------------------------------------

    void estimatorReadsConcertPitch()
    {
        beginTest ("a 440 Hz tone is at concert pitch");

        const auto tone = makeTone (EnginePreprocess::kAnalysisRate, 16.0,
                                    { 440.0, 880.0, 1320.0 }, { 0.25, 0.12, 0.08 });
        const auto estimate = EnginePreprocess::estimateTuning (tone.getReadPointer (0),
                                                                tone.getNumSamples(),
                                                                EnginePreprocess::kAnalysisRate);

        logMessage ("  440 Hz -> " + juce::String (estimate.cents, 2) + " cents, agreement "
                    + juce::String (estimate.concentration, 3) + ", "
                    + juce::String (estimate.peaks) + " partials");

        expect (estimate.peaks >= EnginePreprocess::kMinPeaks, "too few partials to judge");
        expect (estimate.concentration > 0.9, "a pure tone's partials must agree");
        expect (std::abs (estimate.cents) < 3.0, "440 Hz is 0 cents off A440");
        expect (! estimate.confident, "0 cents is not worth resampling for");
    }

    void estimatorReadsADetunedTone()
    {
        beginTest ("a 452 Hz tone is 47 cents sharp");

        // 1200*log2(452/440) = 46.59
        const auto tone = makeTone (EnginePreprocess::kAnalysisRate, 16.0,
                                    { 452.0, 904.0, 1356.0 }, { 0.25, 0.12, 0.08 });
        const auto estimate = EnginePreprocess::estimateTuning (tone.getReadPointer (0),
                                                                tone.getNumSamples(),
                                                                EnginePreprocess::kAnalysisRate);

        logMessage ("  452 Hz -> " + juce::String (estimate.cents, 2) + " cents, agreement "
                    + juce::String (estimate.concentration, 3) + ", "
                    + juce::String (estimate.peaks) + " partials");

        expect (std::abs (estimate.cents - 46.59) <= 3.0,
                "expected +46.6 cents, got " + juce::String (estimate.cents, 2));
        expect (estimate.reliable, "three loud partials in agreement is reliable evidence");
        expect (estimate.confident, "47 cents is worth correcting");
    }

    void estimatorRefusesNoise()
    {
        beginTest ("white noise has no tuning and says so");

        const auto rate = EnginePreprocess::kAnalysisRate;
        juce::AudioBuffer<float> noise (1, (int) (rate * 16.0));
        juce::Random random (20260810);
        auto* out = noise.getWritePointer (0);

        for (int n = 0; n < noise.getNumSamples(); ++n)
            out[n] = (float) (random.nextDouble() * 2.0 - 1.0) * 0.5f;

        const auto estimate = EnginePreprocess::estimateTuning (out, noise.getNumSamples(), rate);

        logMessage ("  noise -> " + juce::String (estimate.cents, 2) + " cents, agreement "
                    + juce::String (estimate.concentration, 3) + ", "
                    + juce::String (estimate.peaks) + " partials");

        expect (! estimate.reliable, "noise must never look like a reliable estimate");
        expect (! estimate.confident, "noise must never be acted on");

        // ...and through the real entry point, the file is untouched.
        Scratch scratch;
        const auto source = scratch.file ("noise.wav");
        setPeak (noise, -12.0);
        expect (writeWav (source, noise, rate), "could not write the fixture");

        const auto before = juce::MD5 (source).toHexString();

        EnginePreprocess::Request request;
        request.wantTuningNorm = true;
        request.wantGainNorm = true;   // already at -12 dBFS, so this has nothing to do either
        request.engineId = "test";

        const auto result = EnginePreprocess::run (source, request, nullptr);

        expect (result.file == source, "an unconfident estimate must return the caller's own file");
        expect (! result.wroteFile, "nothing may be written");
        expect (result.pitchRatio == 1.0, "and the timebase must be untouched");
        expectEquals (juce::MD5 (source).toHexString(), before, "the source file was modified");
        logMessage ("  note: " + result.note);
    }

    void estimatorRefusesTheQuarterToneBoundary()
    {
        beginTest ("a quarter tone off is ambiguous and is refused");

        // 452.9 Hz is 50.03 cents sharp, which the circular estimator cannot
        // tell from 49.97 cents flat. Guessing would be a coin toss applied to
        // somebody's recording.
        const auto tone = makeTone (EnginePreprocess::kAnalysisRate, 16.0,
                                    { 452.9, 905.8, 1358.7 }, { 0.25, 0.12, 0.08 });
        const auto estimate = EnginePreprocess::estimateTuning (tone.getReadPointer (0),
                                                                tone.getNumSamples(),
                                                                EnginePreprocess::kAnalysisRate);

        logMessage ("  452.9 Hz -> " + juce::String (estimate.cents, 2) + " cents");

        expect (std::abs (estimate.cents) >= EnginePreprocess::kAmbiguousCents,
                "expected an estimate at the wrap, got " + juce::String (estimate.cents, 2));
        expect (estimate.ambiguous, "the wrap must be flagged");
        expect (! estimate.confident, "an ambiguous estimate must not be acted on");
    }

    void estimatorIgnoresATransposition()
    {
        beginTest ("a whole tone up is a transposition, not a detuning");

        // 493.88 Hz is B4: 200 cents above A440 and exactly on the grid. The
        // right answer is "this is in tune", because it is - a capo is not a
        // tuning error, and an estimator that "corrected" it would transpose
        // somebody's recording by a whole tone.
        const auto tone = makeTone (EnginePreprocess::kAnalysisRate, 16.0,
                                    { 493.883, 987.767, 1481.65 }, { 0.25, 0.12, 0.08 });
        const auto estimate = EnginePreprocess::estimateTuning (tone.getReadPointer (0),
                                                                tone.getNumSamples(),
                                                                EnginePreprocess::kAnalysisRate);

        logMessage ("  493.88 Hz (B4) -> " + juce::String (estimate.cents, 2) + " cents");

        expect (std::abs (estimate.cents) < 3.0, "B4 is on the A440 grid");
        expect (! estimate.confident, "nothing to correct");
    }

    //-- run() ----------------------------------------------------------------

    void fastPathTouchesNothing()
    {
        beginTest ("both flags off does no work at all");

        // Deliberately a path that does not exist: the fast path must return
        // before it decodes, before it writes, and before it even stats.
        const juce::File nothing ("/riffsheet/no/such/file.wav");

        EnginePreprocess::Request request;   // both flags default to false
        const auto result = EnginePreprocess::run (nothing, request, nullptr);

        expect (result.file == nothing, "the caller's own file must come back");
        expect (! result.wroteFile);
        expect (result.error.isEmpty(), "a no-op cannot fail: " + result.error);
        expect (result.pitchRatio == 1.0);
        expect (result.note.isNotEmpty(), "the note is never empty");
    }

    void inTuneAndAlreadyLevelIsLeftAlone()
    {
        beginTest ("in tune and already at -12 dBFS: the file is byte identical");

        Scratch scratch;
        const auto source = scratch.file ("a440.wav");

        auto tone = makeTone (44100.0, 16.0, { 440.0, 880.0, 1320.0 }, { 0.25, 0.12, 0.08 });
        setPeak (tone, EnginePreprocess::kTargetPeakDbfs);
        expect (writeWav (source, tone, 44100.0), "could not write the fixture");

        const auto before = juce::MD5 (source).toHexString();
        const auto sizeBefore = source.getSize();

        EnginePreprocess::Request request;
        request.wantGainNorm = true;
        request.wantTuningNorm = true;
        request.engineId = "muscriptor";

        const auto result = EnginePreprocess::run (source, request, nullptr);

        logMessage ("  " + juce::String (result.cents, 2) + " cents, peak "
                    + juce::String (result.sourcePeakDbfs, 3) + " dBFS");
        logMessage ("  note: " + result.note);

        expect (result.file == source, "run() must return the ORIGINAL file object");
        expect (! result.wroteFile, "nothing may be written when nothing has to change");
        expect (result.pitchRatio == 1.0);
        expect (result.gainDb == 0.0);
        expectEquals (juce::MD5 (source).toHexString(), before, "the source file was modified");
        expectEquals (source.getSize(), sizeBefore);
        expect (std::abs (result.sourcePeakDbfs - EnginePreprocess::kTargetPeakDbfs) < 0.05,
                "the measured peak is wrong");
    }

    void peakNormalisationHitsTheTarget()
    {
        beginTest ("peak normalisation lands on -12 dBFS, in both directions");

        for (const auto startDbfs : { -3.0, -40.0 })
        {
            Scratch scratch;
            const auto source = scratch.file ("level.wav");

            auto tone = makeTone (44100.0, 4.0, { 440.0, 880.0 }, { 0.25, 0.12 });
            setPeak (tone, startDbfs);
            expect (writeWav (source, tone, 44100.0), "could not write the fixture");

            const auto before = juce::MD5 (source).toHexString();

            EnginePreprocess::Request request;
            request.wantGainNorm = true;     // tuning deliberately off: only the level moves
            request.engineId = "muscriptor";

            const auto result = EnginePreprocess::run (source, request, nullptr);

            expect (result.wroteFile, "a level change has to be written somewhere");
            expect (result.file != source, "and never over the source");
            expectEquals (juce::MD5 (source).toHexString(), before, "the source file was modified");
            expect (result.pitchRatio == 1.0, "levelling must not touch the timebase");

            double rate = 0.0;
            const auto written = readWav (result.file, rate);
            const auto achieved = peakDbfs (written);

            logMessage ("  " + juce::String (startDbfs, 1) + " dBFS -> "
                        + juce::String (achieved, 3) + " dBFS (gain "
                        + juce::String (result.gainDb, 2) + " dB)");

            expectWithinAbsoluteError (achieved, EnginePreprocess::kTargetPeakDbfs, 0.05);
            expectEquals (rate, 44100.0, "the sample rate must not drift");
            expect (written.getNumSamples() == tone.getNumSamples(),
                    "levelling must not change the length");

            result.file.deleteFile();
        }
    }

    void silenceIsLeftAlone()
    {
        beginTest ("a -70 dBFS take is left alone");

        Scratch scratch;
        const auto source = scratch.file ("quiet.wav");

        auto tone = makeTone (44100.0, 4.0, { 440.0, 880.0 }, { 0.25, 0.12 });
        setPeak (tone, -70.0);
        expect (writeWav (source, tone, 44100.0), "could not write the fixture");

        const auto before = juce::MD5 (source).toHexString();

        EnginePreprocess::Request request;
        request.wantGainNorm = true;
        request.engineId = "muscriptor";

        const auto result = EnginePreprocess::run (source, request, nullptr);

        logMessage ("  peak " + juce::String (result.sourcePeakDbfs, 1) + " dBFS");
        logMessage ("  note: " + result.note);

        expect (result.file == source, "amplifying silence amplifies only noise");
        expect (! result.wroteFile);
        expect (result.gainDb == 0.0);
        expectEquals (juce::MD5 (source).toHexString(), before, "the source file was modified");
        expect (result.note.contains ("quiet"), "the reason has to be sayable: " + result.note);
    }

    void theBoostIsCapped()
    {
        beginTest ("the boost is capped at 30 dB");

        Scratch scratch;
        const auto source = scratch.file ("faint.wav");

        auto tone = makeTone (44100.0, 4.0, { 440.0, 880.0 }, { 0.25, 0.12 });
        setPeak (tone, -55.0);   // loud enough to work on, 43 dB short of the target
        expect (writeWav (source, tone, 44100.0), "could not write the fixture");

        EnginePreprocess::Request request;
        request.wantGainNorm = true;
        request.engineId = "muscriptor";

        const auto result = EnginePreprocess::run (source, request, nullptr);

        expect (result.wroteFile);
        expectWithinAbsoluteError (result.gainDb, EnginePreprocess::kMaxBoostDb, 1.0e-9);

        double rate = 0.0;
        const auto written = readWav (result.file, rate);

        logMessage ("  -55 dBFS + " + juce::String (result.gainDb, 1) + " dB -> "
                    + juce::String (peakDbfs (written), 2) + " dBFS");

        expectWithinAbsoluteError (peakDbfs (written), -25.0, 0.05);
        expect (result.note.contains ("capped"), "the cap has to be sayable: " + result.note);

        result.file.deleteFile();
    }

    //-- THE TIMEBASE TEST ----------------------------------------------------

    void timebaseSurvivesACorrection()
    {
        beginTest ("the timebase survives a correction (the 30-cent click track)");

        constexpr auto rate = 44100.0;
        constexpr auto seconds = 16.0;
        constexpr auto detuneCents = 30.0;

        std::vector<double> clickTimes;

        for (auto t = 0.4; t < seconds - 0.5; t += 0.5)
            clickTimes.push_back (t);

        // THE PHYSICAL SITUATION, and the reason this test exists: an instrument
        // tuned 30 cents sharp plays ON TIME at the wrong pitch. Both tracks have
        // their clicks at exactly the same instants; only the sustained tone
        // differs. The correction is what makes the sharp one play LATE, and the
        // inverse map is what has to put it back.
        const auto reference = makeClickTrack (rate, seconds, clickTimes, 440.0);
        const auto detuned = makeClickTrack (rate, seconds, clickTimes,
                                             440.0 * std::pow (2.0, detuneCents / 1200.0));

        Scratch scratch;
        const auto referenceFile = scratch.file ("reference.wav");
        const auto detunedFile = scratch.file ("detuned.wav");

        expect (writeWav (referenceFile, reference, rate), "could not write the reference");
        expect (writeWav (detunedFile, detuned, rate), "could not write the detuned track");

        EnginePreprocess::Request request;
        request.wantTuningNorm = true;   // level deliberately off: one variable at a time
        request.engineId = "muscriptor";

        const auto referenceResult = EnginePreprocess::run (referenceFile, request, nullptr);
        const auto detunedResult = EnginePreprocess::run (detunedFile, request, nullptr);

        logMessage ("  reference: " + juce::String (referenceResult.cents, 2) + " cents, ratio "
                    + juce::String (referenceResult.pitchRatio, 8));
        logMessage ("  detuned:   " + juce::String (detunedResult.cents, 2) + " cents, ratio "
                    + juce::String (detunedResult.pitchRatio, 8));
        logMessage ("  note: " + detunedResult.note);

        expect (! referenceResult.wroteFile, "a track at concert pitch must be left alone");
        expect (detunedResult.wroteFile, "a 30-cent detune must be corrected");
        expect (std::abs (detunedResult.cents - detuneCents) <= 3.0,
                "expected +30 cents, got " + juce::String (detunedResult.cents, 2));

        const auto expectedRatio = std::pow (2.0, -detunedResult.cents / 1200.0);
        expectWithinAbsoluteError (detunedResult.pitchRatio, expectedRatio, 1.0e-12);

        double referenceRate = 0.0, correctedRate = 0.0;
        const auto referenceClicks = findClicks (readWav (referenceResult.file, referenceRate),
                                                 referenceRate);
        const auto correctedAudio = readWav (detunedResult.file, correctedRate);
        const auto correctedClicks = findClicks (correctedAudio, correctedRate);

        expectEquals ((int) referenceClicks.size(), (int) clickTimes.size(),
                      "the reference click detector found the wrong number of clicks");
        expectEquals ((int) correctedClicks.size(), (int) clickTimes.size(),
                      "the corrected click detector found the wrong number of clicks");

        // The correction really did stretch the audio - if this fails, the test
        // is passing for the wrong reason.
        expect (correctedAudio.getNumSamples() > reference.getNumSamples(),
                "a 30-cent-sharp track has to get LONGER when it is corrected");

        if (referenceClicks.size() == correctedClicks.size())
        {
            auto worstRaw = 0.0, worstMapped = 0.0;

            for (size_t i = 0; i < referenceClicks.size(); ++i)
            {
                // Straight out of the corrected file: what a naive job would report.
                worstRaw = juce::jmax (worstRaw, std::abs (correctedClicks[i] - referenceClicks[i]));

                // Through the inverse map: what the job actually reports.
                const auto mapped = correctedClicks[i] * detunedResult.pitchRatio;
                worstMapped = juce::jmax (worstMapped, std::abs (mapped - referenceClicks[i]));
            }

            logMessage ("  worst deviation without the map: "
                        + juce::String (worstRaw * 1000.0, 3) + " ms");
            logMessage ("  worst deviation WITH the map:    "
                        + juce::String (worstMapped * 1000.0, 3) + " ms");

            expect (worstMapped < 0.001,
                    "mapped click times must match the reference within 1 ms, worst was "
                      + juce::String (worstMapped * 1000.0, 3) + " ms");

            // And the map is not decoration: without it the error is far larger
            // than the tolerance it is being held to.
            expect (worstRaw > 0.01,
                    "the uncorrected drift should be tens of milliseconds by the end");
        }

        detunedResult.file.deleteFile();
    }

    void inverseMapCoversEveryTime()
    {
        beginTest ("the inverse map covers every time in the payload");

        constexpr auto ratio = 0.9;

        juce::Array<juce::var> notes;
        notes.add (makeNote (1.0, 2.0, 40));
        notes.add (makeNote (10.0, 12.5, 45));

        auto* grid = new juce::DynamicObject();
        grid->setProperty ("bpm", 120.0);
        grid->setProperty ("beatsPerBar", 4);
        grid->setProperty ("firstDownbeat", 2.0);
        grid->setProperty ("onsetDelay", 0.05);
        grid->setProperty ("beats", juce::var (juce::Array<juce::var> { 0.5, 1.0, 1.5 }));

        auto* precise = new juce::DynamicObject();
        precise->setProperty ("beats", juce::var (juce::Array<juce::var> { 1.0, 2.0, 3.0 }));
        precise->setProperty ("downbeats", juce::var (juce::Array<juce::var> { 1.0, 3.0 }));
        precise->setProperty ("bpm", 60.0);
        precise->setProperty ("beatsPerBar", 2);

        auto* root = new juce::DynamicObject();
        root->setProperty ("notes", juce::var (notes));
        root->setProperty ("onsetDelay", 0.05);
        root->setProperty ("beatGrid", juce::var (grid));
        root->setProperty ("preciseBeats", juce::var (precise));
        root->setProperty ("midiBase64", "TVRoZAAAAAY=");
        root->setProperty ("truncated", false);

        juce::var payload (root);
        EnginePreprocess::applyTimebase (payload, ratio);

        auto* out = payload.getDynamicObject();
        expect (out != nullptr);

        const auto* mappedNotes = out->getProperty ("notes").getArray();
        expect (mappedNotes != nullptr && mappedNotes->size() == 2);
        expectWithinAbsoluteError ((double) (*mappedNotes)[0].getDynamicObject()->getProperty ("start"),
                                   0.9, 1.0e-12);
        expectWithinAbsoluteError ((double) (*mappedNotes)[0].getDynamicObject()->getProperty ("end"),
                                   1.8, 1.0e-12);
        expectWithinAbsoluteError ((double) (*mappedNotes)[1].getDynamicObject()->getProperty ("start"),
                                   9.0, 1.0e-12);
        expectWithinAbsoluteError ((double) (*mappedNotes)[1].getDynamicObject()->getProperty ("end"),
                                   11.25, 1.0e-12);

        expectWithinAbsoluteError ((double) out->getProperty ("onsetDelay"), 0.045, 1.0e-12);

        auto* mappedGrid = out->getProperty ("beatGrid").getDynamicObject();
        expect (mappedGrid != nullptr);
        expectWithinAbsoluteError ((double) mappedGrid->getProperty ("firstDownbeat"), 1.8, 1.0e-12);
        expectWithinAbsoluteError ((double) mappedGrid->getProperty ("onsetDelay"), 0.045, 1.0e-12);
        // Times stretch, tempo does the opposite.
        expectWithinAbsoluteError ((double) mappedGrid->getProperty ("bpm"), 120.0 / ratio, 1.0e-9);
        expectEquals ((int) mappedGrid->getProperty ("beatsPerBar"), 4, "a count is not a time");
        const auto* gridBeats = mappedGrid->getProperty ("beats").getArray();
        expect (gridBeats != nullptr && gridBeats->size() == 3);
        expectWithinAbsoluteError ((double) (*gridBeats)[2], 1.35, 1.0e-12);

        auto* mappedPrecise = out->getProperty ("preciseBeats").getDynamicObject();
        expect (mappedPrecise != nullptr);
        const auto* preciseBeats = mappedPrecise->getProperty ("beats").getArray();
        const auto* preciseDownbeats = mappedPrecise->getProperty ("downbeats").getArray();
        expect (preciseBeats != nullptr && preciseBeats->size() == 3);
        expect (preciseDownbeats != nullptr && preciseDownbeats->size() == 2);
        expectWithinAbsoluteError ((double) (*preciseBeats)[2], 2.7, 1.0e-12);
        expectWithinAbsoluteError ((double) (*preciseDownbeats)[1], 2.7, 1.0e-12);
        expectWithinAbsoluteError ((double) mappedPrecise->getProperty ("bpm"), 60.0 / ratio, 1.0e-9);

        // Two timebases in one payload is a trap, so the SMF goes rather than
        // silently disagreeing with the notes beside it.
        expect (out->getProperty ("midiBase64").toString().isEmpty(),
                "the MIDI file is in the corrected timebase and must not ship next to mapped notes");

        beginTest ("the inverse map is a no-op at ratio 1");

        auto* untouched = new juce::DynamicObject();
        untouched->setProperty ("notes", juce::var (juce::Array<juce::var> { makeNote (1.0, 2.0, 40) }));
        untouched->setProperty ("midiBase64", "TVRoZAAAAAY=");
        juce::var same (untouched);
        EnginePreprocess::applyTimebase (same, 1.0);

        const auto* sameNotes = same.getDynamicObject()->getProperty ("notes").getArray();
        expectWithinAbsoluteError ((double) (*sameNotes)[0].getDynamicObject()->getProperty ("start"),
                                   1.0, 1.0e-12);
        expectEquals (same.getDynamicObject()->getProperty ("midiBase64").toString(),
                      juce::String ("TVRoZAAAAAY="),
                      "an uncorrected job keeps its MIDI");
    }

    //-- the A/B harness ------------------------------------------------------

    /** Not a test of the code so much as the tool the wave-6 A/B gate needs:
        with `RIFFSHEET_PREPROCESS_EXPORT=/path/to/real.wav` set, this runs the
        REAL run() over a real recording and leaves the prepared copy on disk,
        so the same bytes an engine would be handed can be sent to MuScriptor
        with the correction on and off and the note times compared.

        Skipped, silently and with nothing to clean up, when the variable is not
        set - which is every CI run. */
    void realClipExport()
    {
        const auto path = juce::SystemStats::getEnvironmentVariable ("RIFFSHEET_PREPROCESS_EXPORT", {});

        if (path.isEmpty())
            return;

        beginTest ("A/B export of a real recording");

        const juce::File source (path);
        expect (source.existsAsFile(), "no such file: " + path);

        if (! source.existsAsFile())
            return;

        EnginePreprocess::Request request;
        request.wantGainNorm = true;
        request.wantTuningNorm = true;
        request.engineId = "muscriptor";

        const auto result = EnginePreprocess::run (source, request, nullptr);

        logMessage ("  source        " + source.getFullPathName());
        logMessage ("  prepared      " + (result.wroteFile ? result.file.getFullPathName()
                                                           : juce::String ("(nothing written)")));
        logMessage ("  cents         " + juce::String (result.cents, 3));
        logMessage ("  agreement     " + juce::String (result.concentration, 4));
        logMessage ("  partials      " + juce::String (result.peaks));
        logMessage ("  pitchRatio    " + juce::String (result.pitchRatio, 12));
        logMessage ("  gainDb        " + juce::String (result.gainDb, 4));
        logMessage ("  sourcePeak    " + juce::String (result.sourcePeakDbfs, 3) + " dBFS");
        logMessage ("  note          " + result.note);

        expect (result.error.isEmpty(), "preprocessing failed: " + result.error);
        // The prepared file is deliberately LEFT on disk here; the A/B script owns it.
    }
};

static PreprocessTests preprocessTests;
