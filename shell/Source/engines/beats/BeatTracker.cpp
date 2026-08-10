#include "BeatTracker.h"
#include "BeatDbn.h"
#include "BeatThisFrontend.h"
#include "onnx/ModelLocator.h"
#include "onnx/OrtSession.h"

#include <algorithm>
#include <cmath>

namespace BeatTracker
{
namespace
{
    juce::var toArray (const std::vector<double>& values)
    {
        juce::Array<juce::var> array;
        array.ensureStorageAllocated ((int) values.size());

        for (const auto value : values)
            array.add (value);

        return array;
    }

    /** The whole pass, once the audio is mono at 22050 Hz. */
    juce::var run (const std::vector<float>& mono,
                   juce::String& error,
                   const std::function<bool()>& shouldCancel,
                   const std::function<void (const juce::String&)>& onProgress)
    {
        const auto cancelled = [&shouldCancel] { return shouldCancel != nullptr && shouldCancel(); };

        if (cancelled())
        {
            error = "cancelled";
            return {};
        }

        if (onProgress != nullptr)
            onProgress ("Building the spectrogram...");

        std::vector<float> logMel;
        int frames = 0;

        if (! BeatThisFrontend::computeLogMel (mono, logMel, frames, error))
            return {};

        // The model is located, not assumed: BinaryData first, then the bundle's
        // Resources, then Application Support, then $RIFFSHEET_MODEL_DIR ahead of
        // all of them for development. ModelLocator names every path it tried.
        ModelLocator::Model model;

        if (! ModelLocator::find (BeatThisFrontend::kModelBinaryName,
                                  BeatThisFrontend::kModelFileName, model, error))
            return {};

        if (cancelled())
        {
            error = "cancelled";
            return {};
        }

        if (onProgress != nullptr)
            onProgress ("Tracking the beat...");

        // Built here and destroyed on the way out: the one-job rule applies to a
        // 10 MB graph and its arena exactly as it does to a 1.5 GB server.
        OrtSession session (model.data, model.size, "beat tracker", error);

        if (! session.isValid())
            return {};

        std::vector<float> beatLogits, downbeatLogits;

        if (! BeatThisFrontend::runModel (session, logMel, frames, nullptr, shouldCancel,
                                          beatLogits, downbeatLogits, error))
            return {};

        std::vector<float> activations;
        BeatDbn::activationsFromLogits (beatLogits, downbeatLogits, activations);

        const auto tracked = BeatDbn::track (activations, shouldCancel);

        if (cancelled())
        {
            error = "cancelled";
            return {};
        }

        auto* object = new juce::DynamicObject();
        object->setProperty ("beats", toArray (tracked.beats));
        object->setProperty ("downbeats", toArray (tracked.downbeats));
        object->setProperty ("bpm", estimateBpm (tracked.beats));
        object->setProperty ("beatsPerBar", estimateBeatsPerBar (tracked.beats, tracked.downbeats));
        return juce::var (object);
    }
}

//==============================================================================
juce::var estimateBpm (const std::vector<double>& beats)
{
    // The sidecar's np.polyfit(idx, beats, 1)[0]: the least-squares slope of beat
    // index against seconds, which is robust to a couple of missed beats in a way
    // that a mean of the differences is not.
    if (beats.size() < 2)
        return {};

    const auto n = (double) beats.size();
    auto sumX = 0.0, sumY = 0.0, sumXY = 0.0, sumXX = 0.0;

    for (size_t i = 0; i < beats.size(); ++i)
    {
        const auto x = (double) i;
        sumX += x;
        sumY += beats[i];
        sumXY += x * beats[i];
        sumXX += x * x;
    }

    const auto denominator = n * sumXX - sumX * sumX;

    if (std::abs (denominator) < 1.0e-12)
        return {};

    const auto slope = (n * sumXY - sumX * sumY) / denominator;

    if (! (slope > 0.0))
        return {};

    return 60.0 / slope;
}

juce::var estimateBeatsPerBar (const std::vector<double>& beats,
                               const std::vector<double>& downbeats)
{
    // Also the sidecar's: count the beats in each bar, take the most common
    // count, and refuse to answer unless it holds for 90% of the bars. A metre
    // that changes half way through is better reported as "no answer" than as
    // whichever of the two happened to win.
    if (downbeats.size() < 2)
        return {};

    std::vector<int> spacing;

    for (size_t i = 0; i + 1 < downbeats.size(); ++i)
    {
        auto count = 0;

        for (const auto beat : beats)
            if (beat >= downbeats[i] - 1.0e-6 && beat < downbeats[i + 1] - 1.0e-6)
                ++count;

        if (count > 0)
            spacing.push_back (count);
    }

    if (spacing.empty())
        return {};

    auto common = spacing.front();
    auto commonCount = 0;

    for (const auto candidate : spacing)
    {
        const auto occurrences = (int) std::count (spacing.begin(), spacing.end(), candidate);

        if (occurrences > commonCount)
        {
            commonCount = occurrences;
            common = candidate;
        }
    }

    if ((double) commonCount / (double) spacing.size() < 0.9)
        return {};

    return common;
}

//==============================================================================
juce::var analyse (const juce::File& audioFile,
                   juce::String& error,
                   const std::function<bool()>& shouldCancel,
                   const std::function<void (const juce::String&)>& onProgress)
{
    if (shouldCancel != nullptr && shouldCancel())
    {
        error = "cancelled";
        return {};
    }

    if (! audioFile.existsAsFile())
    {
        error = "audio file not found: " + audioFile.getFullPathName();
        return {};
    }

    std::vector<float> mono;

    if (! BeatThisFrontend::readMonoAt22050 (audioFile, mono, error))
        return {};

    return run (mono, error, shouldCancel, onProgress);
}

juce::var analyse (const float* const* channels, int channelCount,
                   int64_t frameCount, double sampleRate,
                   juce::String& error,
                   const std::function<bool()>& shouldCancel,
                   const std::function<void (const juce::String&)>& onProgress)
{
    std::vector<float> mono;
    BeatThisFrontend::resampleToMono22050 (channels, channelCount, frameCount, sampleRate, mono);

    if (mono.empty())
    {
        error = "There is no audio to track the beat in.";
        return {};
    }

    return run (mono, error, shouldCancel, onProgress);
}
}
