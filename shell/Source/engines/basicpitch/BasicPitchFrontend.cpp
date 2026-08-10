#include "BasicPitchFrontend.h"
#include "onnx/OrtSession.h"

namespace BasicPitchFrontend
{
    bool analyse (OrtSession& session,
                  const std::vector<float>& mono,
                  const std::function<void (int, int)>& onProgress,
                  const std::function<bool()>& shouldCancel,
                  Result& out,
                  juce::String& error)
    {
        out = {};

        if (mono.empty())
        {
            error = "There is no audio to transcribe.";
            return false;
        }

        const auto originalSamples = (int64_t) mono.size();
        const auto windowTotal = windowCount (originalSamples);

        // The leading pad is upstream's (get_audio_input), and it is why the
        // first note of a take does not land on frame 0 by accident.
        std::vector<float> padded ((size_t) kLeadingPadSamples, 0.0f);
        padded.insert (padded.end(), mono.begin(), mono.end());

        const auto framesKept = (size_t) windowTotal * (size_t) kFramesKeptPerWindow;
        out.notes.reserve (framesKept);
        out.onsets.reserve (framesKept);

        std::vector<float> window;
        std::vector<OrtSession::Tensor> outputs;
        const std::vector<const char*> inputNames { kInputName };
        const std::vector<const char*> outputNames { kNoteOutput, kOnsetOutput };

        for (int windowIdx = 0; windowIdx < windowTotal; ++windowIdx)
        {
            if (shouldCancel != nullptr && shouldCancel())
            {
                error = "cancelled";
                return false;
            }

            fillWindow (padded, (int64_t) windowIdx * kHopSamples, window);

            OrtSession::TensorView view;
            view.data = window.data();
            view.shape = { 1, (int64_t) kSamplesPerWindow, 1 };

            const auto ranAt = juce::Time::getMillisecondCounterHiRes();

            if (! session.run (inputNames, { view }, outputNames, outputs, error))
                return false;

            out.inferenceMs += juce::Time::getMillisecondCounterHiRes() - ranAt;

            if (outputs.size() != 2
                || outputs[0].dim (1) != kFramesPerWindow || outputs[0].dim (2) != kNoteBins
                || outputs[1].dim (1) != kFramesPerWindow || outputs[1].dim (2) != kNoteBins)
            {
                error = "The built-in model returned a shape this build does not understand. "
                        "The model file and the code that reads it are out of step.";
                return false;
            }

            // unwrap_output(): drop kTrimFramesPerSide frames from each end of
            // every window, then lay the rest end to end. That is what makes the
            // overlap an overlap rather than a seam.
            for (int frame = kTrimFramesPerSide; frame < kFramesPerWindow - kTrimFramesPerSide; ++frame)
            {
                const auto offset = (ptrdiff_t) frame * (ptrdiff_t) kNoteBins;

                out.notes.emplace_back (outputs[0].data.begin() + offset,
                                        outputs[0].data.begin() + offset + kNoteBins);
                out.onsets.emplace_back (outputs[1].data.begin() + offset,
                                         outputs[1].data.begin() + offset + kNoteBins);
            }

            ++out.windowsRun;

            if (onProgress != nullptr)
                onProgress (windowIdx + 1, windowTotal);
        }

        // Trim to the real length of the audio: the last window was zero-padded
        // and its tail is silence the model invented nothing from, but reporting
        // it would make every take a fraction of a second longer than it is.
        const auto keepFrames = (size_t) juce::jmax (0, outputFrameCount (originalSamples));

        if (out.notes.size() > keepFrames)
        {
            out.notes.resize (keepFrames);
            out.onsets.resize (keepFrames);
        }

        return true;
    }

    void fillWindow (const std::vector<float>& padded, int64_t start, std::vector<float>& window)
    {
        window.assign ((size_t) kSamplesPerWindow, 0.0f);

        if (start >= (int64_t) padded.size())
            return;

        const auto available = juce::jmin ((int64_t) kSamplesPerWindow,
                                           (int64_t) padded.size() - start);
        std::copy (padded.begin() + (ptrdiff_t) start,
                   padded.begin() + (ptrdiff_t) (start + available),
                   window.begin());
    }

    void resampleToMono22050 (const float* const* channels, int channelCount,
                              int64_t frameCount, double sourceRate,
                              std::vector<float>& out)
    {
        out.clear();

        if (channels == nullptr || channelCount <= 0 || frameCount <= 0 || sourceRate <= 0.0)
            return;

        // Downmix first, then resample once: resampling per channel and averaging
        // afterwards would cost N passes for an identical answer.
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

        const auto ratio = sourceRate / (double) kSampleRate;
        const auto outCount = (int64_t) std::floor ((double) frameCount / ratio);

        if (outCount <= 0)
            return;

        out.assign ((size_t) outCount, 0.0f);

        juce::LagrangeInterpolator interpolator;
        interpolator.reset();
        interpolator.process (ratio, mono.data(), out.data(), (int) outCount,
                              (int) mono.size(), 0);
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

        // Read in blocks so a long take never needs the whole file in float form
        // twice; the mono buffer is the only full-length copy.
        constexpr int64_t blockFrames = 1 << 16;
        std::vector<float> mono ((size_t) frames, 0.0f);
        juce::AudioBuffer<float> block (channels, (int) juce::jmin (blockFrames, frames));
        const auto scale = 1.0f / (float) channels;

        for (int64_t position = 0; position < frames;)
        {
            const auto count = (int) juce::jmin (blockFrames, frames - position);

            if (! reader->read (&block, 0, count, position, true, true))
            {
                error = "Reading " + file.getFileName() + " failed part way through.";
                return false;
            }

            for (int ch = 0; ch < channels; ++ch)
            {
                const auto* source = block.getReadPointer (ch);

                for (int i = 0; i < count; ++i)
                    mono[(size_t) (position + i)] += source[i] * scale;
            }

            position += count;
        }

        if (std::abs (reader->sampleRate - (double) kSampleRate) < 1.0e-6)
        {
            out = std::move (mono);
            return true;
        }

        const auto ratio = reader->sampleRate / (double) kSampleRate;
        const auto outCount = (int64_t) std::floor ((double) frames / ratio);

        if (outCount <= 0)
        {
            error = "The audio in " + file.getFileName() + " is too short to transcribe.";
            return false;
        }

        out.assign ((size_t) outCount, 0.0f);

        juce::LagrangeInterpolator interpolator;
        interpolator.reset();
        interpolator.process (ratio, mono.data(), out.data(), (int) outCount, (int) mono.size(), 0);
        return true;
    }
}
