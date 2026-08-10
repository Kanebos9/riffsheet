#include <JuceHeader.h>
#include <BinaryData.h>

#include "beats/BeatDbn.h"
#include "beats/BeatThisFrontend.h"
#include "beats/BeatTracker.h"
#include "onnx/ModelLocator.h"
#include "onnx/OrtSession.h"
#include "sidecar/ProcessOutputReader.h"

#include <cmath>
#include <utility>

/**
    Beat tracking, from the audio to the beat times, against Python goldens.

    WHY THESE GOLDENS ARE TRUSTWORTHY. They were captured BEFORE any of this C++
    existed, from the real Python stack - beat_this 1.1.0 over torch 2.13, then
    madmom's DBNDownBeatTrackingProcessor - by scratchpad/capture_stage1.py and
    capture_stage2.py. So "the C++ agrees with the reference" is a real claim
    here, not "the C++ agrees with itself". They are also captured with the DBN
    ON at min_bpm 30, which is the behaviour wave 4 SHIPS and not the behaviour it
    replaced: the sidecar this deletes ran dbn=False, so a golden taken from its
    output would have tested the wrong target.

    THE TWO FIXTURES ARE A DIAGNOSTIC PAIR, which is the whole point of adding the
    second one:

      beats-clicks.json   35 s of a synthetic 120 BPM 4/4 click track, regenerated
                          below from the same formula the capture used. 71 beats,
                          18 downbeats. Long enough to need TWO model chunks, so
                          it exercises split/aggregate. If this fails, the front
                          end or the model pass is wrong.
      beats-held-note.json 3.84 s of one held bass note - E1 with eight partials
                          and a decaying envelope - regenerated below from the
                          formula the capture used. The network finds almost
                          nothing in it and the honest answer is five beats over
                          a bar and a bit. If THIS fails while the clicks pass,
                          the threshold trim or the short single-chunk path is
                          wrong.

    WHY THE SECOND FIXTURE IS SYNTHETIC NOW. It used to be `E1-clip.wav` from the
    repository root - a real recording, and a gitignored one, so it existed on
    exactly one machine. On CI there was no file: the existence check failed, the
    tests carried on into computeLogMel with an empty buffer, and the run ended in
    a segmentation fault rather than a red test. Both halves of that are fixed
    here - the fixture is a formula, and a missing golden now stops this test
    instead of being walked past.

    Each golden also carries the framewise logits, so a parity failure separates
    into "the spectrogram or the model is wrong" and "the DBN is wrong" without a
    debugger.
*/
class BeatTrackerTests final : public juce::UnitTest
{
public:
    BeatTrackerTests() : juce::UnitTest ("BeatTracker", "BeatTracker") {}

    //== fixtures =============================================================

    static juce::File testDir()
    {
       #ifdef RIFFSHEET_TEST_DIR
        return juce::File (RIFFSHEET_TEST_DIR);
       #else
        return {};
       #endif
    }

    juce::var golden (const juce::String& name)
    {
        const auto file = testDir().getChildFile ("golden").getChildFile (name);
        return juce::JSON::parse (file.loadFileAsString());
    }

    static std::vector<double> toVector (const juce::var& value)
    {
        std::vector<double> out;

        if (const auto* array = value.getArray())
            for (const auto& item : *array)
                out.push_back ((double) item);

        return out;
    }

    /** The synthetic click track, regenerated from the formula the capture used
        (scratchpad/capture_stage1.py, make_clicks). Written out here rather than
        committed as a second .wav: a formula cannot drift out of step with the
        thing that produced the golden, and a binary file can. */
    static std::vector<float> makeClicks (const juce::var& frontend)
    {
        const auto seconds = (double) frontend["clickSeconds"];
        const auto bpm = (double) frontend["clickBpm"];
        const auto beatsPerBar = (int) frontend["clickBeatsPerBar"];
        const auto rate = (double) BeatThisFrontend::kSampleRate;

        const auto total = (int) std::lround (seconds * rate);
        std::vector<double> out ((size_t) total, 0.0);

        const auto period = 60.0 / bpm;
        const auto clickLength = (int) std::lround (0.040 * rate);
        constexpr double tau = 0.008;

        for (int beat = 0;; ++beat)
        {
            const auto start = (int) std::lround (beat * period * rate);

            if (start >= total)
                break;

            const auto downbeat = (beat % beatsPerBar) == 0;
            const auto frequency = downbeat ? 1500.0 : 900.0;
            const auto amplitude = downbeat ? 0.70 : 0.50;

            for (int k = 0; k < juce::jmin (clickLength, total - start); ++k)
            {
                const auto t = (double) k / rate;
                out[(size_t) (start + k)] += amplitude * std::exp (-t / tau)
                                               * std::sin (2.0 * juce::MathConstants<double>::pi * frequency * t);
            }
        }

        return std::vector<float> (out.begin(), out.end());
    }

    /** The short single-chunk fixture, from the same formula
        (scratchpad capture, make_held_note): E1 with eight partials at 1/k and a
        (1-exp(-t/0.02))*exp(-t/2.5) envelope, scaled by 0.35. */
    static std::vector<float> makeHeldNote (const juce::var& frontend)
    {
        const auto seconds = (double) frontend["heldSeconds"];
        const auto f0 = (double) frontend["heldF0"];
        const auto partials = (int) frontend["heldPartials"];
        const auto rate = (double) BeatThisFrontend::kSampleRate;

        const auto total = (int) std::lround (seconds * rate);
        std::vector<float> out ((size_t) total, 0.0f);

        for (int i = 0; i < total; ++i)
        {
            const auto t = (double) i / rate;
            const auto envelope = (1.0 - std::exp (-t / 0.02)) * std::exp (-t / 2.5);

            auto sum = 0.0;

            for (int k = 1; k <= partials; ++k)
                sum += std::sin (2.0 * juce::MathConstants<double>::pi * f0 * k * t) / k;

            out[(size_t) i] = (float) (0.35 * envelope * sum);
        }

        return out;
    }

    /** BeatTracker::analyse takes a file, so the generated fixture needs to be
        one for that test. It belongs to this test and is deleted with it. */
    juce::File writeFixtureWav (const std::vector<float>& samples, const juce::String& name)
    {
        const auto file = juce::File::getSpecialLocation (juce::File::tempDirectory)
                              .getChildFile ("riffsheet-beat-fixture-" + name + ".wav");
        file.deleteFile();

        juce::WavAudioFormat format;
        std::unique_ptr<juce::FileOutputStream> out (file.createOutputStream());

        if (out == nullptr)
            return {};

        std::unique_ptr<juce::AudioFormatWriter> writer (
            format.createWriterFor (out.get(), (double) BeatThisFrontend::kSampleRate, 1, 32, {}, 0));

        if (writer == nullptr)
            return {};

        out.release();
        const auto* channel = samples.data();

        if (! writer->writeFromFloatArrays (&channel, 1, (int) samples.size()))
            return {};

        writer.reset();
        return file;
    }

    //== parity ===============================================================

    /** The four gates of engine-architecture.md section 6.5, on one fixture. */
    void expectParity (const juce::var& expected, const juce::var& actual, const juce::String& what)
    {
        const auto wantBeats = toVector (expected["beats"]);
        const auto gotBeats = toVector (actual["beats"]);
        const auto wantDownbeats = toVector (expected["downbeats"]);
        const auto gotDownbeats = toVector (actual["downbeats"]);

        expectEquals ((int) gotDownbeats.size(), (int) wantDownbeats.size(),
                      what + ": downbeat count");
        expectEquals ((int) gotBeats.size(), (int) wantBeats.size(), what + ": beat count");

        if (gotBeats.size() != wantBeats.size())
            return;

        auto within10ms = 0;
        auto worst = 0.0;
        auto worstIndex = -1;

        for (size_t i = 0; i < wantBeats.size(); ++i)
        {
            const auto delta = std::abs (gotBeats[i] - wantBeats[i]) * 1000.0;

            if (delta <= 10.0)
                ++within10ms;

            if (delta > worst)
            {
                worst = delta;
                worstIndex = (int) i;
            }
        }

        const auto fraction = wantBeats.empty() ? 1.0 : (double) within10ms / (double) wantBeats.size();

        expect (fraction >= 0.95,
                what + ": only " + juce::String (fraction * 100.0, 1) + "% of beats are within 10 ms "
                       "of the Python golden (needs 95%)");
        expect (worst <= 30.0,
                what + ": beat " + juce::String (worstIndex) + " is " + juce::String (worst, 2)
                       + " ms from its golden (nothing may exceed 30 ms)");

        logMessage ("    " + what + ": " + juce::String ((int) gotBeats.size()) + " beats, "
                      + juce::String (fraction * 100.0, 1) + "% within 10 ms, worst "
                      + juce::String (worst, 3) + " ms");

        // bpm within 0.1%, and beatsPerBar identical - including "both absent",
        // which is the honest answer for a clip with one beat in it.
        const auto wantBpm = expected["bpm"];
        const auto gotBpm = actual["bpm"];
        expectEquals ((int) gotBpm.isVoid(), (int) wantBpm.isVoid(), what + ": bpm present-ness");

        if (! wantBpm.isVoid() && ! gotBpm.isVoid())
        {
            const auto relative = std::abs ((double) gotBpm - (double) wantBpm)
                                    / juce::jmax (1.0e-9, std::abs ((double) wantBpm));
            expect (relative <= 0.001,
                    what + ": bpm " + juce::String ((double) gotBpm, 4) + " against golden "
                           + juce::String ((double) wantBpm, 4));
        }

        const auto wantBar = expected["beatsPerBar"];
        const auto gotBar = actual["beatsPerBar"];
        expectEquals ((int) gotBar.isVoid(), (int) wantBar.isVoid(), what + ": beatsPerBar present-ness");

        if (! wantBar.isVoid() && ! gotBar.isVoid())
            expectEquals ((int) gotBar, (int) wantBar, what + ": beatsPerBar");
    }

    /** Compares the framewise logits, which is what tells a front-end failure
        apart from a DBN failure. */
    void expectLogitParity (const juce::var& expected,
                            const std::vector<float>& beatLogits,
                            const std::vector<float>& downbeatLogits,
                            const juce::String& what)
    {
        const auto wantBeat = toVector (expected["beatLogits"]);
        const auto wantDownbeat = toVector (expected["downbeatLogits"]);

        expectEquals ((int) beatLogits.size(), (int) wantBeat.size(), what + ": logit frame count");

        if (beatLogits.size() != wantBeat.size() || downbeatLogits.size() != wantDownbeat.size())
            return;

        auto worst = 0.0;

        for (size_t i = 0; i < wantBeat.size(); ++i)
            worst = juce::jmax (worst,
                                std::abs ((double) beatLogits[i] - wantBeat[i]),
                                std::abs ((double) downbeatLogits[i] - wantDownbeat[i]));

        // The golden stores four decimals, so 1e-4 is the floor; float32 FFT
        // against torch's, through six transformer layers, lands well inside
        // 0.01 and anything near 1.0 would be a real disagreement.
        expect (worst < 0.05,
                what + ": worst framewise logit difference is " + juce::String (worst, 5));
        logMessage ("    " + what + ": worst logit delta " + juce::String (worst, 5));
    }

    //== the tests ============================================================

    void runTest() override
    {
        // EVERYTHING BELOW READS THESE, so a missing one stops the test here.
        //
        // It used to carry on, and the carrying on is what turned "the fixture is
        // missing on this machine" into a segmentation fault on CI: the checks
        // below failed, the code after them fed an empty buffer to the front end,
        // and the run died instead of going red. A missing input is a red test,
        // never a crash - so this section decides, and the rest returns.
        beginTest ("the goldens are where the build says they are");
        {
            auto complete = testDir().isDirectory();
            expect (complete, "RIFFSHEET_TEST_DIR is not set or does not exist");

            for (const auto* name : { "golden/beats-clicks.json",
                                      "golden/beats-held-note.json",
                                      "golden/beats-frontend.json" })
            {
                const auto file = testDir().getChildFile (name);
                const auto present = file.existsAsFile();
                expect (present, juce::String (name) + " is missing from the test directory");
                complete = complete && present;
            }

            if (! complete)
            {
                logMessage ("  the goldens are incomplete - stopping here rather than running "
                            "the rest of this file against nothing");
                return;
            }
        }

        beginTest ("the front-end constants are upstream's, arithmetically");
        {
            const auto frontend = golden ("beats-frontend.json");

            expectEquals (BeatThisFrontend::kSampleRate, (int) frontend["sampleRate"]);
            expectEquals (BeatThisFrontend::kFftSize, (int) frontend["nFft"]);
            expectEquals (BeatThisFrontend::kHop, (int) frontend["hop"]);
            expectEquals (BeatThisFrontend::kMelBands, (int) frontend["nMels"]);
            expectEquals (BeatThisFrontend::kFMin, (double) frontend["fMin"]);
            expectEquals (BeatThisFrontend::kFMax, (double) frontend["fMax"]);
            expectEquals (BeatThisFrontend::kLogMultiplier, (double) frontend["logMultiplier"]);
            expectEquals (BeatThisFrontend::kFftBins, 513);
            expectEquals (BeatThisFrontend::kFps, 50);
            expectEquals (BeatThisFrontend::kChunkStride, 1488);
        }

        beginTest ("THE MEL FILTERBANK: both projections match torchaudio's own matrix");
        {
            // engine-architecture.md section 6.3 names this as the single
            // highest-risk item in the plan, because a filterbank that is close
            // but not identical produces beats that are plausible and wrong.
            // Column sums catch a filter in the wrong PLACE (they are a function
            // of each filter's width in bins); row sums catch a filter with the
            // wrong SHAPE, and are 1.0 wherever two triangles overlap - which is
            // most of the spectrum, and is a property no scaling error survives.
            const auto frontend = golden ("beats-frontend.json");
            const auto wantRows = toVector (frontend["filterbankRowSums"]);
            const auto wantColumns = toVector (frontend["filterbankColumnSums"]);
            const auto& fb = BeatThisFrontend::melFilterbank();

            expectEquals ((int) wantRows.size(), BeatThisFrontend::kFftBins, "row-sum golden size");
            expectEquals ((int) wantColumns.size(), BeatThisFrontend::kMelBands, "column-sum golden size");
            expectEquals ((int) fb.size(),
                          BeatThisFrontend::kFftBins * BeatThisFrontend::kMelBands, "filterbank size");

            if (wantRows.size() != (size_t) BeatThisFrontend::kFftBins)
                return;

            auto worstRow = 0.0, worstColumn = 0.0;
            std::vector<double> columns ((size_t) BeatThisFrontend::kMelBands, 0.0);

            for (int bin = 0; bin < BeatThisFrontend::kFftBins; ++bin)
            {
                auto sum = 0.0;

                for (int mel = 0; mel < BeatThisFrontend::kMelBands; ++mel)
                {
                    const auto weight = (double) fb[(size_t) bin * BeatThisFrontend::kMelBands + (size_t) mel];
                    sum += weight;
                    columns[(size_t) mel] += weight;
                }

                worstRow = juce::jmax (worstRow, std::abs (sum - wantRows[(size_t) bin]));
            }

            for (int mel = 0; mel < BeatThisFrontend::kMelBands; ++mel)
                worstColumn = juce::jmax (worstColumn,
                                          std::abs (columns[(size_t) mel] - wantColumns[(size_t) mel]));

            // torchaudio built its matrix in float32; ours is built in double and
            // stored as float. 1e-4 is generous for that and tight enough that a
            // half-bin shift (which moves a row sum by ~0.5) cannot hide.
            expect (worstRow < 1.0e-4,
                    "worst filterbank ROW sum difference is " + juce::String (worstRow, 8));
            expect (worstColumn < 1.0e-4,
                    "worst filterbank COLUMN sum difference is " + juce::String (worstColumn, 8));
            logMessage ("    worst row-sum delta " + juce::String (worstRow, 9)
                          + ", worst column-sum delta " + juce::String (worstColumn, 9));

            // And the structural claim the fast path relies on: outside the
            // filterbank's span every weight is zero, and inside it the weights
            // over all mels sum to exactly one.
            auto insideBins = 0;

            for (int bin = 0; bin < BeatThisFrontend::kFftBins; ++bin)
                if (wantRows[(size_t) bin] > 0.999 && wantRows[(size_t) bin] < 1.001)
                    ++insideBins;

            expect (insideBins > 400, "the filterbank should cover most of the spectrum");
        }

        beginTest ("the log-mel spectrogram reproduces torchaudio's, sample for sample");
        {
            const auto frontend = golden ("beats-frontend.json");

            juce::String error;
            const auto mono = makeHeldNote (frontend);

            std::vector<float> logMel;
            int frames = 0;
            expect (BeatThisFrontend::computeLogMel (mono, logMel, frames, error), error);
            expectEquals (frames, (int) frontend["held-noteFrames"], "frame count");
            expectEquals (BeatThisFrontend::frameCount ((int64_t) mono.size()), frames,
                          "frameCount() and computeLogMel disagree");

            expectLogMelSamples (logMel, frames, frontend["held-noteLogMelSamples"], "held note");

            const auto clicks = makeClicks (frontend);
            std::vector<float> clickMel;
            int clickFrames = 0;
            expect (BeatThisFrontend::computeLogMel (clicks, clickMel, clickFrames, error), error);
            expectEquals (clickFrames, (int) frontend["clicksFrames"], "click frame count");
            expectLogMelSamples (clickMel, clickFrames, frontend["clicksLogMelSamples"], "clicks");
        }

        beginTest ("the DBN's tempo grid is the one the golden was captured with");
        {
            const auto clicks = golden ("beats-clicks.json");
            const auto dbn = clicks["dbn"];

            expectEquals (BeatDbn::kMinBpm, (double) dbn["minBpm"]);
            expectEquals (BeatDbn::kMaxBpm, (double) dbn["maxBpm"]);
            expectEquals (BeatDbn::kNumTempi, (int) dbn["numTempi"]);
            expectEquals (BeatDbn::kTransitionLambda, (double) dbn["transitionLambda"]);
            expectEquals (BeatDbn::kObservationLambda, (int) dbn["observationLambda"]);
            expectEquals (BeatDbn::kThreshold, (double) dbn["threshold"]);
            expectEquals (BeatDbn::kFps, (double) dbn["fps"]);

            // 30 BPM at 50 fps is a 100-frame interval; 215 BPM is 14 (rounded).
            // If the log spacing or the widening loop ever changes, the state
            // space changes and every beat with it.
            const auto& tempi = BeatDbn::intervals();
            expectEquals ((int) tempi.size(), 60, "tempo count");
            expectEquals (tempi.front(), 14, "fastest interval");
            expectEquals (tempi.back(), 100, "slowest interval");

            auto sum = 0;

            for (const auto interval : tempi)
                sum += interval;

            expectEquals (sum, 2921, "states per beat");
        }

        beginTest ("the DBN alone reproduces madmom, from the golden's own logits");
        {
            // Feeding the DBN the PYTHON logits isolates it completely: if this
            // passes and the end-to-end test does not, the front end is at fault.
            for (const auto* name : { "beats-clicks.json", "beats-held-note.json" })
            {
                const auto expected = golden (name);
                const auto beat = toVector (expected["beatLogits"]);
                const auto downbeat = toVector (expected["downbeatLogits"]);

                std::vector<float> beatLogits (beat.begin(), beat.end());
                std::vector<float> downbeatLogits (downbeat.begin(), downbeat.end());

                std::vector<float> activations;
                BeatDbn::activationsFromLogits (beatLogits, downbeatLogits, activations);
                const auto tracked = BeatDbn::track (activations);

                auto* object = new juce::DynamicObject();
                object->setProperty ("beats", toVar (tracked.beats));
                object->setProperty ("downbeats", toVar (tracked.downbeats));
                object->setProperty ("bpm", BeatTracker::estimateBpm (tracked.beats));
                object->setProperty ("beatsPerBar",
                                     BeatTracker::estimateBeatsPerBar (tracked.beats, tracked.downbeats));

                expectParity (expected, juce::var (object),
                              juce::String ("DBN over golden logits, ") + name);
            }
        }

        beginTest ("end to end: audio in, the golden's beats out");
        {
            juce::String error;
            ModelLocator::Model model;
            expect (ModelLocator::find (BeatThisFrontend::kModelBinaryName,
                                        BeatThisFrontend::kModelFileName, model, error), error);
            logMessage ("    model: " + model.source + ", "
                          + juce::String ((int) (model.size / 1024)) + " KiB");

            OrtSession session (model.data, model.size, "beat tracker", error);
            expect (session.isValid(), error);

            if (! session.isValid())
                return;

            const auto frontend = golden ("beats-frontend.json");

            struct Fixture { const char* golden; bool held; };

            for (const auto& fixture : { Fixture { "beats-held-note.json", true },
                                         Fixture { "beats-clicks.json", false } })
            {
                const auto mono = fixture.held ? makeHeldNote (frontend) : makeClicks (frontend);

                std::vector<float> logMel;
                int frames = 0;
                expect (BeatThisFrontend::computeLogMel (mono, logMel, frames, error), error);

                std::vector<float> beatLogits, downbeatLogits;
                const auto started = juce::Time::getMillisecondCounterHiRes();
                expect (BeatThisFrontend::runModel (session, logMel, frames, nullptr, nullptr,
                                                    beatLogits, downbeatLogits, error), error);
                const auto elapsed = juce::Time::getMillisecondCounterHiRes() - started;

                const auto expected = golden (fixture.golden);
                expectLogitParity (expected, beatLogits, downbeatLogits, fixture.golden);

                std::vector<float> activations;
                BeatDbn::activationsFromLogits (beatLogits, downbeatLogits, activations);
                const auto tracked = BeatDbn::track (activations);

                auto* object = new juce::DynamicObject();
                object->setProperty ("beats", toVar (tracked.beats));
                object->setProperty ("downbeats", toVar (tracked.downbeats));
                object->setProperty ("bpm", BeatTracker::estimateBpm (tracked.beats));
                object->setProperty ("beatsPerBar",
                                     BeatTracker::estimateBeatsPerBar (tracked.beats, tracked.downbeats));

                expectParity (expected, juce::var (object),
                              juce::String ("end to end, ") + fixture.golden);
                logMessage ("    " + juce::String (fixture.golden) + ": inference "
                              + juce::String (elapsed, 1) + " ms for "
                              + juce::String ((double) frames / 50.0, 2) + " s of audio");
            }
        }

        beginTest ("BeatTracker::analyse returns the wire shape webcore already reads");
        {
            juce::String error;

            // The file path, because that is the overload the bridge calls. The
            // fixture is written out here rather than committed, for the same
            // reason it is a formula: a .wav in the tree can drift away from the
            // golden it produced, and a formula cannot.
            const auto fixture = writeFixtureWav (makeHeldNote (golden ("beats-frontend.json")),
                                                  "held-note");
            expect (fixture.existsAsFile(), "could not write the fixture wav");

            if (! fixture.existsAsFile())
                return;

            const auto result = BeatTracker::analyse (fixture, error);
            fixture.deleteFile();

            expect (! result.isVoid(), "analyse failed: " + error);

            if (const auto* object = result.getDynamicObject())
            {
                // juce.ts:454 declares exactly these four, and the two arrays are
                // read unconditionally - a missing key would be `undefined` there
                // and the take would silently lose its grid.
                expect (object->hasProperty ("beats"));
                expect (object->hasProperty ("downbeats"));
                expect (object->hasProperty ("bpm"));
                expect (object->hasProperty ("beatsPerBar"));
                expect (object->getProperty ("beats").isArray());
                expect (object->getProperty ("downbeats").isArray());
            }
            else
            {
                expect (false, "analyse returned something that is not an object");
            }

            expectParity (golden ("beats-held-note.json"), result, "BeatTracker::analyse");
        }

        beginTest ("silence and near-silence come back empty rather than invented");
        {
            // The HMM always produces a path, so without the threshold trim a
            // room-tone take would get a full beat grid over nothing.
            std::vector<float> quiet ((size_t) BeatThisFrontend::kSampleRate * 2, 0.0f);
            std::vector<float> logMel;
            int frames = 0;
            juce::String error;

            expect (BeatThisFrontend::computeLogMel (quiet, logMel, frames, error), error);
            expectEquals (frames, 1 + 2 * BeatThisFrontend::kSampleRate / BeatThisFrontend::kHop);

            std::vector<float> beatLogits ((size_t) frames, -20.0f);
            std::vector<float> downbeatLogits ((size_t) frames, -20.0f);
            std::vector<float> activations;
            BeatDbn::activationsFromLogits (beatLogits, downbeatLogits, activations);

            const auto tracked = BeatDbn::track (activations);
            expectEquals ((int) tracked.beats.size(), 0, "silence should produce no beats");

            expect (BeatTracker::estimateBpm ({}).isVoid());
            expect (BeatTracker::estimateBpm ({ 1.0 }).isVoid());
            expect (BeatTracker::estimateBeatsPerBar ({ 1.0, 2.0 }, {}).isVoid());
        }

        beginTest ("audio shorter than one FFT window is refused, not guessed at");
        {
            std::vector<float> tiny ((size_t) BeatThisFrontend::kFftSize - 1, 0.1f);
            std::vector<float> logMel;
            int frames = 0;
            juce::String error;

            expect (! BeatThisFrontend::computeLogMel (tiny, logMel, frames, error));
            expect (error.isNotEmpty(), "the refusal must say why");
        }

        beginTest ("cancelling stops the DBN rather than finishing the take");
        {
            std::vector<float> beatLogits ((size_t) 4000, 2.0f);
            std::vector<float> downbeatLogits ((size_t) 4000, -1.0f);
            std::vector<float> activations;
            BeatDbn::activationsFromLogits (beatLogits, downbeatLogits, activations);

            auto calls = 0;
            const auto tracked = BeatDbn::track (activations, [&calls] { return ++calls > 5; });
            expectEquals ((int) tracked.beats.size(), 0, "a cancelled track returns nothing");
        }

        beginTest ("ProcessOutputReader still reads a child process (it outlived the sidecar)");
        {
            // The class moved out of MuScriptorServer.cpp when the Python beat
            // sidecar was deleted, because wave 5's SidecarAdapter needs it. An
            // unbuilt header rots; this keeps it compiled and true.
            juce::ChildProcess child;
            const juce::StringArray command { "/bin/echo", "riffsheet" };

            if (child.start (command, juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr))
            {
                ProcessOutputReader reader (child);
                expect (reader.start());
                child.waitForProcessToFinish (5000);
                expect (reader.finishAfterProcessExit().contains ("riffsheet"));
            }
            else
            {
                expect (false, "could not start /bin/echo");
            }
        }
    }

private:

    static juce::var toVar (const std::vector<double>& values)
    {
        juce::Array<juce::var> array;

        for (const auto value : values)
            array.add (value);

        return array;
    }

    void expectLogMelSamples (const std::vector<float>& logMel, int frames,
                              const juce::var& samples, const juce::String& what)
    {
        const std::pair<const char*, int> rows[] {
            { "first", 0 }, { "mid", frames / 2 }, { "last", frames - 1 }
        };

        for (const auto& [label, row] : rows)
        {
            const auto want = toVector (samples[juce::Identifier (label)]);
            expectEquals ((int) want.size(), BeatThisFrontend::kMelBands / 16,
                          what + " " + label + ": golden size");

            auto worst = 0.0;

            for (size_t i = 0; i < want.size(); ++i)
            {
                const auto column = (int) i * 16;
                const auto got = (double) logMel[(size_t) row * BeatThisFrontend::kMelBands + (size_t) column];
                worst = juce::jmax (worst, std::abs (got - want[i]));
            }

            // torch computes this in float32 and so do we, with a different FFT;
            // the values run 0..10, so 1e-3 is three orders below the signal and
            // an order above the float32 noise floor.
            expect (worst < 1.0e-3,
                    what + " " + label + " frame: worst log-mel difference " + juce::String (worst, 7));
        }
    }
};

static BeatTrackerTests beatTrackerTests;
