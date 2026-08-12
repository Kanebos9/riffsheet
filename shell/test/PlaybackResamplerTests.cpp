#include <JuceHeader.h>
#include "plugin/PlaybackResampler.h"

#include <cmath>
#include <vector>

/**
    The transport's rate conversion.

    THE BUG THIS FILE EXISTS FOR. The playback phase used to be stored as a whole
    number of source frames and re-truncated at the end of every processBlock, so
    a fraction of a frame was discarded per block. Playing 44.1 kHz into a 48 kHz
    host at 64-frame blocks that is 0.8 frames lost every block - 1.36% slow,
    2.45 seconds adrift after three minutes - and at 512-frame blocks it is
    0.085%. Playback speed therefore changed with the host's buffer size.

    A one-block test cannot see any of that: one block was always very nearly
    right. So the tests below run block after block after block and check the
    ACCUMULATED phase, which is the only place the fault was ever visible.

    They call riffsheet::playback::render() and ::advance() directly, and so does
    RiffsheetAudioProcessor::processBlock(); there is deliberately no second copy
    of the arithmetic in here that could drift away from the shipped one.
*/
namespace
{
    using namespace riffsheet::playback;

    struct RateCase { double rate; const char* name; };

    const RateCase commonRates[] { { 44100.0, "44.1k" }, { 48000.0, "48k" },
                                   { 88200.0, "88.2k" }, { 96000.0, "96k" } };
    const int commonBlockSizes[] { 64, 128, 512 };

    /** Whole blocks only, so the expected phase is exact rather than an average
        over a partial last block. */
    std::int64_t blocksFor (double seconds, double hostRate, int blockSize)
    {
        return (std::int64_t) std::llround (seconds * hostRate / (double) blockSize);
    }

    /** Runs real audio through the real render loop, block by block, exactly the
        way processBlock does - including storing the returned phase back and
        starting the next block from it. Returns the final phase in source
        frames. The source is a second longer than the run, so the end is never
        reached and nothing but the arithmetic is under test. */
    double phaseAfterRendering (double sourceRate, double hostRate, int blockSize, double seconds)
    {
        const auto step = stepFor (sourceRate, hostRate);
        const auto blocks = blocksFor (seconds, hostRate, blockSize);
        const auto needed = (std::int64_t) ((double) (blocks * blockSize) * step + sourceRate);

        std::vector<float> src ((size_t) needed);

        // A ramp rather than silence: interpolating a constant would look right
        // even if the fractional part were computed wrongly.
        for (size_t i = 0; i < src.size(); ++i)
            src[i] = (float) (i % 1000) * 0.001f;

        double position = 0.0;
        double sink = 0.0;

        for (std::int64_t b = 0; b < blocks; ++b)
        {
            const auto r = render (src.data(), (std::int64_t) src.size(), position, step, blockSize,
                                   [&sink] (int, float s) { sink += s; });

            // The store-back. This is the line that used to be
            // `playbackPositionSamples = (int64_t) pos;`.
            position = r.position;

            if (r.hitEnd)
                break;
        }

        juce::ignoreUnused (sink);
        return position;
    }

    /** The phase arithmetic on its own, for durations whose audio would not fit
        in memory (an hour at 96 kHz is 1.4 GB of float). */
    double phaseAfterAdvancing (double sourceRate, double hostRate, int blockSize, double seconds)
    {
        const auto step = stepFor (sourceRate, hostRate);
        const auto blocks = blocksFor (seconds, hostRate, blockSize);

        double position = 0.0;

        for (std::int64_t b = 0; b < blocks; ++b)
            position = advance (position, step, blockSize);

        return position;
    }
}

class PlaybackResamplerTests final : public juce::UnitTest
{
public:
    PlaybackResamplerTests() : juce::UnitTest ("PlaybackResampler", "PlaybackResampler") {}

    void runTest() override
    {
        beginTest ("step is source frames per output frame");
        {
            expectWithinAbsoluteError (stepFor (44100.0, 48000.0), 0.91875, 1.0e-12);
            expectWithinAbsoluteError (stepFor (48000.0, 44100.0), 48000.0 / 44100.0, 1.0e-12);
            expectWithinAbsoluteError (stepFor (44100.0, 44100.0), 1.0, 1.0e-12);
            // Unknown rates play at the device's rate rather than falling silent.
            expectWithinAbsoluteError (stepFor (0.0, 48000.0), 1.0, 1.0e-12);
            expectWithinAbsoluteError (stepFor (44100.0, 0.0), 1.0, 1.0e-12);
        }

        beginTest ("rendering real audio: drift under a frame per minute at every rate x block size");
        {
            // THE REGRESSION LOCK, driven through the loop the audio thread runs.
            // The old truncating code fails this by four orders of magnitude: at
            // 44.1k -> 48k / 64 frames it lost 600 frames a SECOND, i.e. 36000
            // per minute against a budget of one.
            //
            // Thirty seconds rather than three minutes only because the source
            // has to be resident (30 s at 96 kHz is 11 MB, three minutes at every
            // combination would be gigabytes). The per-minute budget is what is
            // checked, and the pure-arithmetic test below carries the same check
            // out to an hour.
            constexpr double seconds = 30.0;
            const auto minutes = seconds / 60.0;

            for (const auto& source : commonRates)
            {
                for (const auto& host : commonRates)
                {
                    for (const auto blockSize : commonBlockSizes)
                    {
                        const auto blocks = blocksFor (seconds, host.rate, blockSize);
                        const auto expected = (double) (blocks * blockSize) * stepFor (source.rate, host.rate);
                        const auto actual = phaseAfterRendering (source.rate, host.rate, blockSize, seconds);
                        const auto driftPerMinute = std::abs (actual - expected) / minutes;

                        expect (driftPerMinute < 1.0,
                                juce::String (source.name) + " -> " + host.name + " @ "
                                    + juce::String (blockSize) + " frames: "
                                    + juce::String (driftPerMinute, 6) + " frames/minute");
                    }
                }
            }
        }

        beginTest ("ten minutes of phase: drift under a frame per minute, every rate x block size");
        {
            constexpr double minutes = 10.0;
            const auto seconds = minutes * 60.0;

            for (const auto& source : commonRates)
            {
                for (const auto& host : commonRates)
                {
                    for (const auto blockSize : commonBlockSizes)
                    {
                        const auto blocks = blocksFor (seconds, host.rate, blockSize);
                        const auto expected = (double) (blocks * blockSize) * stepFor (source.rate, host.rate);
                        const auto actual = phaseAfterAdvancing (source.rate, host.rate, blockSize, seconds);
                        const auto driftPerMinute = std::abs (actual - expected) / minutes;

                        expect (driftPerMinute < 1.0,
                                juce::String (source.name) + " -> " + host.name + " @ "
                                    + juce::String (blockSize) + " frames: "
                                    + juce::String (driftPerMinute, 6) + " frames/minute");
                    }
                }
            }
        }

        beginTest ("playback speed does not depend on the host's block size");
        {
            // The user-visible shape of the old bug: one file, one host rate,
            // three buffer sizes, three different playback speeds.
            //
            // COMPARED AS A SPEED, NOT AS A PHASE, and that is not a detail.
            // Thirty seconds is 22500 blocks of 64 but 2812.5 blocks of 512, and
            // these runs do whole blocks only - so the 512 run legitimately
            // covers 256 output frames more than the 64 run and ends 235 source
            // frames further into the file. Subtracting the two phases measures
            // that difference in DURATION, which is not the thing under test and
            // was never the bug. Dividing each phase by the output frames it
            // took is source-frames-per-output-frame: the playback speed, which
            // is what has to be identical.
            constexpr double seconds = 30.0;
            constexpr double hostRate = 48000.0;
            constexpr double sourceRate = 44100.0;

            const auto trueStep = stepFor (sourceRate, hostRate);

            const auto speedAt = [&] (int blockSize)
            {
                const auto blocks = blocksFor (seconds, hostRate, blockSize);
                const auto outputFrames = (double) (blocks * blockSize);
                return phaseAfterRendering (sourceRate, hostRate, blockSize, seconds) / outputFrames;
            };

            const auto at64  = speedAt (64);
            const auto at128 = speedAt (128);
            const auto at512 = speedAt (512);

            // A minute of output at this host rate is 2,880,000 frames, so a
            // budget of one frame per minute is this many frames per frame. The
            // old code was 0.0136 out at 64 and 0.00085 at 512 - four and three
            // orders of magnitude over.
            const auto perFrameBudget = 1.0 / (hostRate * 60.0);

            expect (std::abs (at64 - at128) < perFrameBudget,
                    "64 vs 128: " + juce::String (std::abs (at64 - at128), 12));
            expect (std::abs (at64 - at512) < perFrameBudget,
                    "64 vs 512: " + juce::String (std::abs (at64 - at512), 12));

            // ...and all three play the take at its true speed rather than
            // merely agreeing with each other on a wrong one.
            for (const auto speed : { at64, at128, at512 })
                expect (std::abs (speed - trueStep) < perFrameBudget,
                        "speed error: " + juce::String (std::abs (speed - trueStep), 12));
        }

        beginTest ("an hour at 96 kHz still lands inside a frame");
        {
            // Double has 53 bits of mantissa; at 3.5e8 frames one ulp is about
            // 6e-8 frames, so the long-file case is bounded by arithmetic rather
            // than by hope. This is the test that catches someone making the
            // phase a float.
            constexpr double seconds = 3600.0;
            const auto blocks = blocksFor (seconds, 48000.0, 512);
            const auto expected = (double) (blocks * 512) * stepFor (96000.0, 48000.0);
            const auto actual = phaseAfterAdvancing (96000.0, 48000.0, 512, seconds);

            expect (std::abs (actual - expected) < 1.0,
                    "hour-long drift: " + juce::String (std::abs (actual - expected)));
        }

        beginTest ("interpolation reads the right samples");
        {
            // 0, 1, 2, 3... at half speed must produce 0, 0.5, 1, 1.5...
            std::vector<float> src (16);
            for (size_t i = 0; i < src.size(); ++i)
                src[i] = (float) i;

            std::vector<float> out;
            const auto r = render (src.data(), (std::int64_t) src.size(), 0.0, 0.5, 8,
                                   [&out] (int, float s) { out.push_back (s); });

            expectEquals (r.framesWritten, 8);
            expect (! r.hitEnd);
            expectWithinAbsoluteError (r.position, 4.0, 1.0e-12);
            expectEquals ((int) out.size(), 8);

            for (int i = 0; i < 8; ++i)
                expectWithinAbsoluteError ((double) out[(size_t) i], 0.5 * i, 1.0e-6);
        }

        beginTest ("a block that starts mid-frame keeps its fraction");
        {
            std::vector<float> src (16);
            for (size_t i = 0; i < src.size(); ++i)
                src[i] = (float) i;

            // Starting at 0.25, step 1.0: 0.25, 1.25, 2.25 - and the phase that
            // comes back is 3.25, not 3.
            std::vector<float> out;
            const auto r = render (src.data(), (std::int64_t) src.size(), 0.25, 1.0, 3,
                                   [&out] (int, float s) { out.push_back (s); });

            expectWithinAbsoluteError (r.position, 3.25, 1.0e-12);
            expectWithinAbsoluteError ((double) out[0], 0.25, 1.0e-6);
            expectWithinAbsoluteError ((double) out[1], 1.25, 1.0e-6);
            expectWithinAbsoluteError ((double) out[2], 2.25, 1.0e-6);
        }

        beginTest ("the sink is given consecutive output indices");
        {
            std::vector<float> src (64, 1.0f);
            std::vector<int> indices;

            render (src.data(), (std::int64_t) src.size(), 0.0, 0.91875, 32,
                    [&indices] (int i, float) { indices.push_back (i); });

            expectEquals ((int) indices.size(), 32);

            for (int i = 0; i < (int) indices.size(); ++i)
                expectEquals (indices[(size_t) i], i);
        }

        beginTest ("the end of the file is reported, not read past");
        {
            std::vector<float> src (10, 1.0f);

            int produced = 0;
            const auto r = render (src.data(), (std::int64_t) src.size(), 8.0, 1.0, 16,
                                   [&produced] (int, float) { ++produced; });

            // Interpolation needs index + 1, so frame 9 is unreachable: only
            // index 8 can be rendered.
            expectEquals (r.framesWritten, 1);
            expectEquals (produced, 1);
            expect (r.hitEnd);
        }

        beginTest ("degenerate inputs render nothing rather than reading memory");
        {
            std::vector<float> src (4, 1.0f);
            int produced = 0;
            const auto sink = [&produced] (int, float) { ++produced; };

            expectEquals (render (nullptr, 100, 0.0, 1.0, 64, sink).framesWritten, 0);
            expectEquals (render (src.data(), 0, 0.0, 1.0, 64, sink).framesWritten, 0);
            expectEquals (render (src.data(), 1, 0.0, 1.0, 64, sink).framesWritten, 0);
            expectEquals (render (src.data(), 4, 0.0, 1.0, 0, sink).framesWritten, 0);
            expectEquals (produced, 0);

            // An empty source is "the end", so the transport stops instead of
            // sitting there playing nothing for ever.
            expect (render (src.data(), 1, 0.0, 1.0, 64, sink).hitEnd);
        }
    }
};

static PlaybackResamplerTests playbackResamplerTests;
