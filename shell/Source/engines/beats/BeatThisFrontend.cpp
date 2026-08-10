#include "BeatThisFrontend.h"
#include "onnx/OrtSession.h"

#include <algorithm>
#include <cmath>

namespace BeatThisFrontend
{
namespace
{
    //== the Slaney mel scale =================================================
    // torchaudio/functional/functional.py, _hz_to_mel / _mel_to_hz with
    // mel_scale="slaney". The break point at 1000 Hz and the 27-step log decade
    // are Slaney's Auditory Toolbox, not HTK's - HTK's single log formula would
    // put every filter in the wrong place, and the spectrogram would still look
    // perfectly reasonable.

    constexpr double kMelBreakHz    = 1000.0;
    constexpr double kMelLinearStep = 200.0 / 3.0;                  // f_sp

    double melLogStep()
    {
        static const double step = std::log (6.4) / 27.0;
        return step;
    }

    double hzToMel (double hz)
    {
        const auto linear = hz / kMelLinearStep;

        if (hz < kMelBreakHz)
            return linear;

        return (kMelBreakHz / kMelLinearStep) + std::log (hz / kMelBreakHz) / melLogStep();
    }

    double melToHz (double mel)
    {
        constexpr double breakMel = kMelBreakHz / kMelLinearStep;

        if (mel < breakMel)
            return mel * kMelLinearStep;

        return kMelBreakHz * std::exp (melLogStep() * (mel - breakMel));
    }

    struct Filterbank
    {
        std::vector<float> weights;                 // kFftBins * kMelBands
        std::vector<int> first, last;               // per bin, [first, last)
    };

    Filterbank buildFilterbank()
    {
        Filterbank fb;
        fb.weights.assign ((size_t) kFftBins * (size_t) kMelBands, 0.0f);
        fb.first.assign ((size_t) kFftBins, 0);
        fb.last.assign ((size_t) kFftBins, 0);

        // torchaudio: all_freqs = linspace(0, sample_rate // 2, n_freqs). The
        // integer division is upstream's and it matters: 22050 // 2 is 11025, and
        // the bin spacing that follows is 11025 / 512, not 11025.0 / 512.
        const auto nyquist = (double) (kSampleRate / 2);

        // n_mels + 2 points on the mel axis: each filter spans its two neighbours.
        const auto melMin = hzToMel (kFMin);
        const auto melMax = hzToMel (kFMax);
        std::vector<double> points ((size_t) kMelBands + 2);

        for (size_t i = 0; i < points.size(); ++i)
            points[i] = melToHz (melMin + (melMax - melMin) * (double) i / (double) (kMelBands + 1));

        for (int bin = 0; bin < kFftBins; ++bin)
        {
            const auto freq = nyquist * (double) bin / (double) (kFftBins - 1);
            auto* row = fb.weights.data() + (size_t) bin * (size_t) kMelBands;
            auto firstSet = -1, lastSet = -1;

            for (int mel = 0; mel < kMelBands; ++mel)
            {
                // _create_triangular_filterbank, spelled out: upstream computes
                //     down_slopes = -(points[m]   - freq) / (points[m+1] - points[m])
                //     up_slopes   =  (points[m+2] - freq) / (points[m+2] - points[m+1])
                //     fb          =  max(0, min(down_slopes, up_slopes))
                // so the rising and falling edges share an apex with no special
                // case, and a bin outside the triangle makes one of them negative.
                const auto rising  = (freq - points[(size_t) mel])
                                       / (points[(size_t) mel + 1] - points[(size_t) mel]);
                const auto falling = (points[(size_t) mel + 2] - freq)
                                       / (points[(size_t) mel + 2] - points[(size_t) mel + 1]);
                const auto weight  = juce::jmax (0.0, juce::jmin (rising, falling));

                if (weight > 0.0)
                {
                    row[mel] = (float) weight;

                    if (firstSet < 0)
                        firstSet = mel;

                    lastSet = mel;
                }
            }

            fb.first[(size_t) bin] = firstSet < 0 ? 0 : firstSet;
            fb.last[(size_t) bin]  = firstSet < 0 ? 0 : lastSet + 1;
        }

        return fb;
    }

    const Filterbank& filterbank()
    {
        static const Filterbank fb = buildFilterbank();
        return fb;
    }

    //== the analysis window ==================================================
    // torch.hann_window(1024) is PERIODIC by default: 0.5 - 0.5*cos(2*pi*n/N),
    // divided by N and not by N-1. The symmetric spelling is the usual mistake
    // and it biases every frame by a fraction of a bin.
    const std::vector<float>& hannWindow()
    {
        static const std::vector<float> window = []
        {
            std::vector<float> w ((size_t) kFftSize);

            for (int n = 0; n < kFftSize; ++n)
                w[(size_t) n] = (float) (0.5 - 0.5 * std::cos (2.0 * juce::MathConstants<double>::pi
                                                                 * (double) n / (double) kFftSize));

            return w;
        }();

        return window;
    }

    /** A linear-phase FIR low-pass, used only when decimating. See the header for
        why BasicPitchFrontend does not have one. */
    void lowPassForDecimation (std::vector<float>& signal, double sourceRate, double targetRate)
    {
        if (sourceRate <= targetRate)
            return;

        // 0.45 * target rate leaves the transition band inside the part of the
        // spectrum the mel filterbank stops looking at (f_max is 11000 of 11025).
        const auto cutoff = 0.45 * targetRate;
        const auto coefficients = juce::dsp::FilterDesign<float>::designFIRLowpassWindowMethod (
                                      (float) cutoff, sourceRate, 96,
                                      juce::dsp::WindowingFunction<float>::blackman);

        if (coefficients == nullptr)
            return;

        const auto* taps = coefficients->getRawCoefficients();
        const auto tapCount = (int) coefficients->getFilterOrder() + 1;
        const auto delay = (tapCount - 1) / 2;   // symmetric, so the delay is exact
        const auto count = (int) signal.size();

        std::vector<float> filtered ((size_t) count, 0.0f);

        for (int i = 0; i < count; ++i)
        {
            double sum = 0.0;

            // Centre the kernel on i + delay so the group delay comes straight
            // back out: an onset that moves is worse than an onset with an alias
            // beside it.
            for (int t = 0; t < tapCount; ++t)
            {
                const auto index = i + delay - t;

                if (index >= 0 && index < count)
                    sum += (double) taps[t] * (double) signal[(size_t) index];
            }

            filtered[(size_t) i] = (float) sum;
        }

        signal.swap (filtered);
    }
}

//==============================================================================
const std::vector<float>& melFilterbank()
{
    return filterbank().weights;
}

void melRangeForBin (int bin, int& first, int& last)
{
    const auto& fb = filterbank();

    if (bin < 0 || bin >= kFftBins)
    {
        first = last = 0;
        return;
    }

    first = fb.first[(size_t) bin];
    last  = fb.last[(size_t) bin];
}

//==============================================================================
void resampleToMono22050 (const float* const* channels, int channelCount,
                          int64_t frameCount, double sourceRate,
                          std::vector<float>& out)
{
    out.clear();

    if (channels == nullptr || channelCount <= 0 || frameCount <= 0 || sourceRate <= 0.0)
        return;

    std::vector<float> mono ((size_t) frameCount, 0.0f);
    const auto scale = 1.0f / (float) channelCount;

    for (int ch = 0; ch < channelCount; ++ch)
    {
        const auto* source = channels[ch];

        if (source == nullptr)
            continue;

        for (int64_t i = 0; i < frameCount; ++i)
            mono[(size_t) i] += source[i] * scale;
    }

    if (std::abs (sourceRate - (double) kSampleRate) < 1.0e-6)
    {
        out = std::move (mono);
        return;
    }

    lowPassForDecimation (mono, sourceRate, (double) kSampleRate);

    const auto ratio = sourceRate / (double) kSampleRate;
    const auto outCount = (int64_t) std::floor ((double) frameCount / ratio);

    if (outCount <= 0)
        return;

    out.assign ((size_t) outCount, 0.0f);

    juce::LagrangeInterpolator interpolator;
    interpolator.reset();
    interpolator.process (ratio, mono.data(), out.data(), (int) outCount, (int) mono.size(), 0);
}

bool readMonoAt22050 (const juce::File& file, std::vector<float>& out, juce::String& error)
{
    out.clear();

    if (! file.existsAsFile())
    {
        error = "The audio file is not there: " + file.getFullPathName();
        return false;
    }

    juce::AudioFormatManager formats;
    formats.registerBasicFormats();

    std::unique_ptr<juce::AudioFormatReader> reader (formats.createReaderFor (file));

    if (reader == nullptr)
    {
        error = "Riffsheet could not read " + file.getFileName()
                  + " - the format is not one this build understands.";
        return false;
    }

    const auto frames = (int64_t) reader->lengthInSamples;
    const auto channels = (int) reader->numChannels;

    if (frames <= 0 || channels <= 0)
    {
        error = "There is no audio in " + file.getFileName() + ".";
        return false;
    }

    juce::AudioBuffer<float> whole (channels, (int) frames);

    if (! reader->read (&whole, 0, (int) frames, 0, true, true))
    {
        error = "Reading " + file.getFileName() + " failed part way through.";
        return false;
    }

    resampleToMono22050 (whole.getArrayOfReadPointers(), channels, frames,
                         reader->sampleRate, out);

    if (out.empty())
    {
        error = "There is no audio in " + file.getFileName() + " once resampled.";
        return false;
    }

    return true;
}

//==============================================================================
bool computeLogMel (const std::vector<float>& mono, std::vector<float>& out,
                    int& frames, juce::String& error)
{
    out.clear();
    frames = 0;

    if ((int64_t) mono.size() < kFftSize)
    {
        error = "There is less than " + juce::String (kFftSize * 1000 / kSampleRate)
                  + " ms of audio here, which is too little to find a beat in.";
        return false;
    }

    const auto count = (int64_t) mono.size();
    frames = frameCount (count);

    // center=True, pad_mode="reflect": frame t is centred on sample t*hop, which
    // is only true if the signal is mirrored by n_fft/2 at both ends first.
    constexpr int pad = kFftSize / 2;
    std::vector<float> padded ((size_t) (count + 2 * pad));

    for (int i = 0; i < pad; ++i)
    {
        padded[(size_t) i] = mono[(size_t) (pad - i)];
        padded[(size_t) (pad + count + i)] = mono[(size_t) (count - 2 - i)];
    }

    std::copy (mono.begin(), mono.end(), padded.begin() + pad);

    const auto& window = hannWindow();
    const auto& fb = filterbank();

    juce::dsp::FFT fft (10);   // 2^10 == kFftSize
    jassert (fft.getSize() == kFftSize);

    // torch.stft(normalized=True), which is what normalized="frame_length" maps
    // to: divide by sqrt(n_fft). Folded into one multiply per bin.
    const auto normalise = (float) (1.0 / std::sqrt ((double) kFftSize));

    std::vector<float> scratch ((size_t) kFftSize * 2, 0.0f);
    std::vector<float> mel ((size_t) kMelBands);
    out.assign ((size_t) frames * (size_t) kMelBands, 0.0f);

    for (int frame = 0; frame < frames; ++frame)
    {
        const auto offset = (size_t) frame * (size_t) kHop;

        std::fill (scratch.begin(), scratch.end(), 0.0f);

        for (int n = 0; n < kFftSize; ++n)
            scratch[(size_t) n] = padded[offset + (size_t) n] * window[(size_t) n];

        fft.performRealOnlyForwardTransform (scratch.data(), true);

        std::fill (mel.begin(), mel.end(), 0.0f);

        for (int bin = 0; bin < kFftBins; ++bin)
        {
            const auto re = scratch[(size_t) bin * 2];
            const auto im = scratch[(size_t) bin * 2 + 1];
            const auto magnitude = std::sqrt (re * re + im * im) * normalise;   // power=1

            if (magnitude <= 0.0f)
                continue;

            const auto* row = fb.weights.data() + (size_t) bin * (size_t) kMelBands;

            for (int m = fb.first[(size_t) bin], end = fb.last[(size_t) bin]; m < end; ++m)
                mel[(size_t) m] += magnitude * row[m];
        }

        auto* destination = out.data() + (size_t) frame * (size_t) kMelBands;

        for (int m = 0; m < kMelBands; ++m)
            destination[m] = std::log1p ((float) kLogMultiplier * mel[(size_t) m]);
    }

    return true;
}

//==============================================================================
bool runModel (OrtSession& session,
               const std::vector<float>& logMel, int frames,
               const std::function<void (int, int)>& onProgress,
               const std::function<bool()>& shouldCancel,
               std::vector<float>& beatLogits,
               std::vector<float>& downbeatLogits,
               juce::String& error)
{
    if (frames <= 0 || logMel.size() != (size_t) frames * (size_t) kMelBands)
    {
        error = "The spectrogram handed to the beat model is the wrong size.";
        return false;
    }

    // split_piece(): starts = arange(-border, frames - border, chunk - 2*border),
    // and when the piece is long enough the last start is pulled left so the last
    // chunk ends exactly at the end of the piece.
    std::vector<int> starts;

    for (int start = -kBorderFrames; start < frames - kBorderFrames; start += kChunkStride)
        starts.push_back (start);

    if (starts.empty())
        starts.push_back (-kBorderFrames);

    if (frames > kChunkStride)
        starts.back() = frames - (kChunkFrames - kBorderFrames);

    // -1000 is upstream's "no chunk covered this frame" sentinel. Every frame is
    // covered by construction; keeping the sentinel means a future off-by-one
    // shows up as an impossible logit rather than as a silent zero.
    beatLogits.assign ((size_t) frames, -1000.0f);
    downbeatLogits.assign ((size_t) frames, -1000.0f);

    std::vector<float> chunk;
    std::vector<OrtSession::Tensor> outputs;
    const std::vector<const char*> inputNames { kInputName };
    const std::vector<const char*> outputNames { kBeatOutput, kDownbeatOutput };

    // overlap_mode="keep_first": run the chunks backwards so that where two
    // chunks overlap, the EARLIER one's prediction is the one left standing.
    const auto total = (int) starts.size();

    for (int i = total; --i >= 0;)
    {
        if (shouldCancel != nullptr && shouldCancel())
        {
            error = "cancelled";
            return false;
        }

        const auto start = starts[(size_t) i];
        const auto lo = juce::jmax (0, start);
        const auto hi = juce::jmin (start + kChunkFrames, frames);
        const auto left = juce::jmax (0, -start);
        const auto right = juce::jmax (0, juce::jmin (kBorderFrames, start + kChunkFrames - frames));
        const auto chunkFrames = (hi - lo) + left + right;

        if (chunkFrames <= 2 * kBorderFrames)
        {
            error = "A beat-model chunk came out shorter than its own borders.";
            return false;
        }

        chunk.assign ((size_t) chunkFrames * (size_t) kMelBands, 0.0f);
        std::copy (logMel.begin() + (ptrdiff_t) ((size_t) lo * kMelBands),
                   logMel.begin() + (ptrdiff_t) ((size_t) hi * kMelBands),
                   chunk.begin() + (ptrdiff_t) ((size_t) left * kMelBands));

        OrtSession::TensorView view;
        view.data = chunk.data();
        view.shape = { 1, (int64_t) chunkFrames, (int64_t) kMelBands };

        if (! session.run (inputNames, { view }, outputNames, outputs, error))
            return false;

        if (outputs.size() != 2
            || outputs[0].dim (1) != (int64_t) chunkFrames
            || outputs[1].dim (1) != (int64_t) chunkFrames)
        {
            error = "The built-in beat model returned a shape this build does not understand. "
                    "The model file and the code that reads it are out of step.";
            return false;
        }

        // aggregate_prediction(): drop border_size frames from each end, then
        // write the rest at [start + border, start + chunk_size - border).
        const auto kept = chunkFrames - 2 * kBorderFrames;
        const auto destination = start + kBorderFrames;
        const auto writable = juce::jlimit (0, kept, frames - destination);

        for (int f = 0; f < writable; ++f)
        {
            beatLogits[(size_t) (destination + f)] = outputs[0].data[(size_t) (kBorderFrames + f)];
            downbeatLogits[(size_t) (destination + f)] = outputs[1].data[(size_t) (kBorderFrames + f)];
        }

        if (onProgress != nullptr)
            onProgress (total - i, total);
    }

    return true;
}
}
