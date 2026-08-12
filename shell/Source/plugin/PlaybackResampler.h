#pragma once
#include <cstdint>

/**
    The transport's rate conversion, as one arithmetic unit.

    WHY IT IS ITS OWN HEADER. It used to be eight lines inside
    RiffsheetAudioProcessor::processBlock(), and those eight lines had a bug that
    could only be seen by running many blocks in a row:

        auto pos = (double) playbackPositionSamples;   // int64 -> double
        for (...) { ...; pos += step; }
        playbackPositionSamples = (int64_t) pos;       // ...and back, TRUNCATED

    The phase was stored as a whole number of source frames, so everything after
    the decimal point was thrown away ONCE PER BLOCK. Playing a 44.1 kHz take
    into a 48 kHz host the true advance is 64 x 0.91875 = 58.8 frames per
    64-frame block; 58 got stored. That is 0.8 frames lost every block, 600
    frames a second, and the recording therefore played 1.36% slow - about 2.45
    seconds adrift after three minutes. At 512-frame blocks the same code is
    0.085% slow, so the SPEED OF PLAYBACK DEPENDED ON THE HOST'S BUFFER SIZE,
    which is the part that made it look like a mystery rather than a bug.

    The fix is that the phase is a double and is never rounded. It is here, in a
    header with no JUCE and no plugin behind it, so the tests can run minutes of
    simulated audio through THE SAME CODE the audio thread runs
    (PlaybackResamplerTests) instead of through a copy of it that could drift
    away from the original.

    Position is measured in the SOURCE FILE's own frames, not the host's - that
    is what makes seek, the position readout and the end-of-file test all speak
    one unit.

    Audio-thread safe: no allocation, no locking, no branching on anything but
    the sample count.
*/
namespace riffsheet::playback
{
    /** Source frames consumed per output frame. 1.0 when either rate is unknown,
        which plays the file at whatever rate the device is running - the same
        thing the old code did, and better than silence. */
    inline double stepFor (double sourceRate, double hostRate) noexcept
    {
        return (sourceRate > 0.0 && hostRate > 0.0) ? sourceRate / hostRate : 1.0;
    }

    /** The phase after `frames` output frames. The whole fix in one line: it
        returns a double and the caller stores a double, so nothing is ever
        rounded to a whole source frame. */
    inline double advance (double position, double step, int frames) noexcept
    {
        return position + (double) frames * step;
    }

    struct RenderResult
    {
        int    framesWritten = 0;   /**< How many output frames the sink was given. */
        double position = 0.0;      /**< The phase to store back. Fractional, ALWAYS. */
        bool   hitEnd = false;      /**< The source ran out inside this block. */
    };

    /**
        Linearly interpolates `numFrames` output frames starting at `position`.

        `sink(i, sample)` is called for each output frame; the caller decides what
        to do with it (apply gain, add it to every output channel). A template
        rather than a std::function because this is called from the audio thread
        and must inline to nothing.

        `total` is the number of source frames available. Interpolation reads
        src[index] and src[index + 1], so the last frame index it may use is
        total - 2; the block stops there and reports `hitEnd`.
    */
    template <typename Sink>
    inline RenderResult render (const float* src,
                                std::int64_t total,
                                double position,
                                double step,
                                int numFrames,
                                Sink&& sink)
    {
        RenderResult result;
        result.position = position;

        if (src == nullptr || total <= 1 || numFrames <= 0)
        {
            result.hitEnd = (total <= 1);
            return result;
        }

        int i = 0;

        for (; i < numFrames; ++i)
        {
            // Recomputed from the block's own start rather than accumulated, so
            // the rounding error of one block is not the starting point of the
            // next. (Accumulating would also be fine at these magnitudes; this
            // costs one multiply and removes the question.)
            const auto pos = advance (position, step, i);
            const auto index = (std::int64_t) pos;

            if (index >= total - 1)
                break;

            const auto frac = (float) (pos - (double) index);
            sink (i, src[index] + frac * (src[index + 1] - src[index]));
        }

        result.framesWritten = i;
        result.position = advance (position, step, i);
        result.hitEnd = (i < numFrames);
        return result;
    }
}
