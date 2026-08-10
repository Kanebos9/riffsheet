#pragma once
#include <JuceHeader.h>
#include <cstdint>
#include <functional>
#include <vector>

class OrtSession;

/**
    Beat This!'s input side: audio in, framewise beat/downbeat logits out.

    EVERY NUMBER IN THIS FILE WAS READ OFF UPSTREAM AND CARRIES THE LINE IT CAME
    FROM. This is the single highest-risk file in the whole engine plan
    (engine-architecture.md section 6.3): unlike Basic Pitch, whose ONNX graph
    contains its own CQT front end, the Beat This! graph starts at the log-mel
    spectrogram. Everything before it - resampling, STFT, the mel filterbank, the
    log compression - is ours to reproduce, and a filterbank that is close but
    not identical produces beats that are plausible and wrong. No test that only
    checks "beats exist" catches that, which is why BeatTrackerTests asserts the
    filterbank against upstream's own numbers in two independent projections.

    The pinned sources:

        beat_this 1.1.0, beat_this/preprocessing.py:27-59  (LogMelSpect)
        beat_this 1.1.0, beat_this/inference.py:90-257     (split/predict/aggregate)
        torchaudio 2.11.0, transforms.MelSpectrogram + functional.melscale_fbanks

    WHY THE RESAMPLER HAS A LOW-PASS IN FRONT OF IT AND BasicPitchFrontend'S DOES
    NOT. Both resample to 22050 Hz with juce::LagrangeInterpolator, which is this
    project's one answer to "how does Riffsheet resample". A Lagrange
    interpolator has no anti-alias filter, so decimating 44.1 kHz audio folds
    everything above 11 kHz back down into the band. Basic Pitch tolerates that
    because its CQT looks at pitch, where the folded energy is broadband and
    quiet; a mel front end with f_max = 11000 feeds that folded energy straight
    into the top bands, which are exactly the bands percussive onsets live in. So
    downsampling here goes through a linear-phase FIR first and its group delay
    is removed exactly, which keeps every onset where it was.
*/
namespace BeatThisFrontend
{
    //== constants, pinned ====================================================
    // beat_this/preprocessing.py:28-40, LogMelSpect's defaults - the only values
    // the shipped inference path ever uses (inference.py:267 constructs it with
    // no arguments but `device`).

    constexpr int    kSampleRate    = 22050;    // sample_rate
    constexpr int    kFftSize       = 1024;     // n_fft (win_length defaults to n_fft)
    constexpr int    kHop           = 441;      // hop_length
    constexpr int    kMelBands      = 128;      // n_mels
    constexpr double kFMin          = 30.0;     // f_min
    constexpr double kFMax          = 11000.0;  // f_max
    constexpr double kLogMultiplier = 1000.0;   // log_multiplier, used as log1p(1000 * x)
    constexpr int    kFftBins       = kFftSize / 2 + 1;             // 513, onesided
    constexpr int    kFps           = kSampleRate / kHop;           // 50, and it is exact

    // beat_this/inference.py:249-252 (Spect2Frames::spect2frames) and :100-135
    // (split_piece). The model was not trained on the edges of its input, so the
    // first and last `kBorderFrames` predictions of every chunk are discarded and
    // consecutive chunks overlap by that much.
    constexpr int kChunkFrames  = 1500;   // chunk_size
    constexpr int kBorderFrames = 6;      // border_size
    constexpr int kChunkStride  = kChunkFrames - 2 * kBorderFrames;   // 1488
    constexpr int kKeptPerChunk = kChunkFrames - 2 * kBorderFrames;   // 1488

    // The exported graph's names. Asked for by name rather than by index because
    // graph order would silently swap beats and downbeats on a re-export, and the
    // two are almost the same signal - the swap would look like a bad model, not
    // like a bug.
    constexpr const char* kInputName         = "spect";
    constexpr const char* kBeatOutput        = "beat";
    constexpr const char* kDownbeatOutput    = "downbeat";
    constexpr const char* kModelBinaryName   = "small0_onnx";
    constexpr const char* kModelFileName     = "small0.onnx";

    //== the mel filterbank ===================================================

    /** The filterbank torchaudio builds for those constants: 513 x 128, laid out
        row-major by FFT bin. Built once, on first use, and never again - it is
        the same matrix for every call.

        It is `mel_scale="slaney"` with `norm=None`, i.e. the Slaney mel FORMULA
        with triangles that peak at 1.0 rather than Slaney AREA normalisation.
        The two are routinely confused and the difference is a per-band gain, so
        the test asserts both projections of the matrix rather than trusting this
        comment. */
    const std::vector<float>& melFilterbank();

    /** First and last non-zero mel index for FFT bin `bin`, so the projection can
        skip the ~99% of the matrix that is zero. `last` is exclusive; an empty
        range is first == last. */
    void melRangeForBin (int bin, int& first, int& last);

    //== audio ================================================================

    /** Frames a signal of `sampleCount` samples produces.
        torch.stft(center=True): 1 + sampleCount // hop. */
    constexpr int frameCount (int64_t sampleCount) noexcept
    {
        return (int) (1 + sampleCount / kHop);
    }

    /** Reads any format JUCE knows, downmixes to mono and resamples to
        kSampleRate. Returns false with `error` set. */
    bool readMonoAt22050 (const juce::File& file, std::vector<float>& out, juce::String& error);

    /** The same conversion for audio already in memory. */
    void resampleToMono22050 (const float* const* channels, int channelCount,
                              int64_t frameCount, double sourceRate,
                              std::vector<float>& out);

    //== the spectrogram ======================================================

    /** log1p(1000 * melSpectrogram(mono)), frames x 128, row-major by frame -
        precisely what `LogMelSpect.forward` returns, transposed the same way.

        Returns false with `error` set when the signal is shorter than one FFT
        window: torch's reflect padding is undefined there too, and 46 ms of audio
        has no beat in it to find. */
    bool computeLogMel (const std::vector<float>& mono, std::vector<float>& out,
                        int& frames, juce::String& error);

    //== the model pass =======================================================

    /** Runs the whole spectrogram through `session` in upstream's overlapping
        chunks and aggregates the framewise logits.

        This is `split_predict_aggregate` with `overlap_mode="keep_first"`: chunks
        are written back in reverse order so an earlier chunk's prediction wins
        wherever two overlap. `beatLogits` and `downbeatLogits` come back
        `frames` long.

        Returns false with `error` set; "cancelled" is the reserved string. */
    bool runModel (OrtSession& session,
                   const std::vector<float>& logMel, int frames,
                   const std::function<void (int, int)>& onProgress,
                   const std::function<bool()>& shouldCancel,
                   std::vector<float>& beatLogits,
                   std::vector<float>& downbeatLogits,
                   juce::String& error);
}
