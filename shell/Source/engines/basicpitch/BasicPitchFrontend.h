#pragma once
#include <JuceHeader.h>
#include <functional>
#include <vector>

class OrtSession;

/**
    Basic Pitch's input side: audio in, posteriorgrams out.

    EVERY NUMBER IN THIS FILE WAS READ OFF UPSTREAM AND CARRIES THE LINE IT CAME
    FROM. None of them is remembered, inferred or rounded. A wrong hop size here
    does not crash and does not look wrong - it produces perfectly plausible
    notes at the wrong times, which is the worst failure mode this project has
    available to it (engine-architecture.md, Risk 2). The pinned source is:

        spotify/basic-pitch  v0.4.0, model blob dfb20ef5 (basic_pitch/constants.py,
        basic_pitch/inference.py)

    WHAT THE MODEL DOES AND DOES NOT INCLUDE. `nmp.onnx` is the WHOLE network:
    the harmonic-stacked CQT front end is inside the graph (Conv/Pad/Slice/Log/
    Sqrt nodes, 248 of them), so this file computes no spectrogram at all. Its
    entire job is: resample to 22050 Hz mono, pad, cut fixed-length overlapping
    windows, and stitch the three output stacks back into one timeline the way
    `unwrap_output()` does. That is why NeuralNote needs a CQT in C++ and
    Riffsheet does not - they run the four CNN sub-graphs, we run the exported
    end-to-end graph.
*/
namespace BasicPitchFrontend
{
    //== constants, pinned ====================================================
    // basic_pitch/constants.py, v0.4.0

    constexpr int kSampleRate         = 22050;   // AUDIO_SAMPLE_RATE
    constexpr int kFftHop             = 256;     // FFT_HOP
    constexpr int kWindowSeconds      = 2;       // AUDIO_WINDOW_LENGTH
    constexpr int kAnnotationsFps     = kSampleRate / kFftHop;                  // ANNOTATIONS_FPS = 86 (integer division, as upstream)
    constexpr int kFramesPerWindow    = kAnnotationsFps * kWindowSeconds;       // ANNOT_N_FRAMES  = 172
    constexpr int kSamplesPerWindow   = kSampleRate * kWindowSeconds - kFftHop; // AUDIO_N_SAMPLES = 43844
    constexpr int kNoteBins           = 88;      // N_FREQ_BINS_NOTES    = ANNOTATIONS_N_SEMITONES * 1
    constexpr int kContourBins        = 264;     // N_FREQ_BINS_CONTOURS = ANNOTATIONS_N_SEMITONES * 3
    constexpr int kMidiOffset         = 21;      // ANNOTATIONS_BASE_FREQUENCY 27.5 Hz == MIDI 21

    // basic_pitch/inference.py, run_inference(): "# overlap 30 frames"
    constexpr int kOverlappingFrames  = 30;                                     // n_overlapping_frames
    constexpr int kOverlapSamples     = kOverlappingFrames * kFftHop;           // overlap_len = 7680
    constexpr int kHopSamples         = kSamplesPerWindow - kOverlapSamples;    // hop_size    = 36164
    constexpr int kTrimFramesPerSide  = kOverlappingFrames / 2;                 // unwrap_output(): n_olap = 15
    constexpr int kFramesKeptPerWindow = kFramesPerWindow - 2 * kTrimFramesPerSide;  // 142

    // basic_pitch/inference.py, Model.predict(), MODEL_TYPES.ONNX. The output
    // ORDER in the graph is contour, note, onset by index; upstream asks for
    // them by name, and so do we, because relying on graph order would silently
    // swap onsets and notes if the model were ever re-exported.
    constexpr const char* kInputName   = "serving_default_input_2:0";
    constexpr const char* kNoteOutput  = "StatefulPartitionedCall:1";
    constexpr const char* kOnsetOutput = "StatefulPartitionedCall:2";
    constexpr const char* kContourOutput = "StatefulPartitionedCall:0";

    //== framing ==============================================================

    /** How many zeros go in front of the audio: `overlap_len / 2`.
        inference.py, get_audio_input(). */
    constexpr int kLeadingPadSamples = kOverlapSamples / 2;                     // 3840

    /** Number of model windows for `sampleCount` samples of ORIGINAL audio.

        Upstream is `for i in range(0, padded_length, hop_size)`, i.e. the count
        is ceil(padded / hop), and the final window is zero-padded to length.
        The padded length is the original plus kLeadingPadSamples. */
    constexpr int windowCount (int64_t sampleCount) noexcept
    {
        const auto padded = sampleCount + kLeadingPadSamples;
        return (int) ((padded + kHopSamples - 1) / kHopSamples);
    }

    /** Frames the unwrapped posteriorgram is trimmed to.
        unwrap_output(): floor(audio_original_length * (ANNOTATIONS_FPS / AUDIO_SAMPLE_RATE)).
        Both operands are integers upstream too, but the division is float there,
        so this is written as a floating-point floor on purpose. */
    inline int outputFrameCount (int64_t sampleCount) noexcept
    {
        return (int) std::floor ((double) sampleCount * ((double) kAnnotationsFps / (double) kSampleRate));
    }

    /** Seconds of the frame at `frameIndex`.

        NeuralNote's Notes::_modelFrameToTime keeps upstream's WINDOW_OFFSET
        correction behind a test-only #if and ships the plain form; upstream's
        own note_creation.model_frames_to_time applies the offset. We ship the
        plain form, matching NeuralNote, because the offset upstream applies is a
        per-window correction for a windowing scheme this code has already
        undone, and because the pipeline quantises to a grid afterwards: a
        constant 2 ms bias would be inaudible and a per-window sawtooth would
        not. Stated here rather than left to be discovered. */
    constexpr double frameToSeconds (int frameIndex) noexcept
    {
        return (double) frameIndex * (double) kFftHop / (double) kSampleRate;
    }

    /** Fills `window` (kSamplesPerWindow floats) with padded[start .. start+N),
        zero-filling past the end. `padded` is the already-front-padded signal. */
    void fillWindow (const std::vector<float>& padded, int64_t start, std::vector<float>& window);

    //== audio ================================================================

    /** Reads any format JUCE knows, downmixes to mono and resamples to
        kSampleRate with juce::LagrangeInterpolator - the same resampler
        PcmStore::decodeAndStore already uses, so Riffsheet has one answer to
        "how does this project resample" rather than two.

        Returns false with `error` set on an unreadable or empty file. */
    bool readMonoAt22050 (const juce::File& file, std::vector<float>& out, juce::String& error);

    /** Same conversion for audio that is already in memory (a capture whose
        PcmStore entry the job is holding). `channels` may be 1 or more. */
    void resampleToMono22050 (const float* const* channels, int channelCount,
                              int64_t frameCount, double sourceRate,
                              std::vector<float>& out);

    //== the whole model pass =================================================

    /** frames x bins, row-major by frame. */
    using Posteriorgram = std::vector<std::vector<float>>;

    struct Result
    {
        Posteriorgram notes;    // frames x 88
        Posteriorgram onsets;   // frames x 88
        int windowsRun = 0;
        double inferenceMs = 0.0;
    };

    /** Frames `mono` (22050 Hz, from the functions above), runs every window
        through `session`, and stitches the outputs back into one timeline.

        THIS IS WHERE UPSTREAM'S `unwrap_output` LIVES, which is why it is here
        and not in the adapter: the adapter is glue, and the seam between two
        windows is the part a test has to be able to reach. `onProgress` is
        called (completed, total) per window; `shouldCancel` is checked before
        each one, so a cancel lands within one window - about 1.6 seconds of
        audio - rather than at the end of the take.

        Returns false with `error` set. "cancelled" is the reserved string. */
    bool analyse (OrtSession& session,
                  const std::vector<float>& mono,
                  const std::function<void (int, int)>& onProgress,
                  const std::function<bool()>& shouldCancel,
                  Result& out,
                  juce::String& error);
}
