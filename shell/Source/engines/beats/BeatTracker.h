#pragma once
#include <JuceHeader.h>
#include <functional>

/**
    True per-beat times for any audio, with no Python anywhere.

    WHAT THIS REPLACES. Until wave 4 `preciseBeats` was a Python script written to
    /tmp and run with MUSCRIPTOR'S OWN INTERPRETER, so precise beat tracking
    required a MuScriptor venv to exist - which meant a user on the built-in
    engine could not have it at all. That coupling is the reason this file exists.
    Beat tracking is now a free function over a bundled ONNX model, available to
    every engine including Basic Pitch, and the acceptance test for the wave is
    exactly that: no venv, no Python, no MuScriptor, real beats.

    IT IS A FREE FUNCTION AND NOT AN EngineAdapter METHOD, on purpose
    (engine-architecture.md 1.2): putting it on the adapter interface would
    enshrine the "beats belong to one engine" coupling that this deletes.

    THE RETURN SHAPE IS THE WIRE SHAPE AND IT HAS NOT CHANGED. Byte for byte what
    the Python sidecar printed, because webcore already reads it
    (webcore/src/bridge/juce.ts:454, :811-843):

        { beats: number[], downbeats: number[], bpm: number|null,
          beatsPerBar: number|null }

    `bpm` and `beatsPerBar` are computed with the sidecar's own formulas - a
    least-squares slope over beat index, and the modal downbeat spacing accepted
    only at 90% agreement - so a take that produced a null before produces a null
    now.

    THREADING. Blocks, allocates tens of megabytes, and runs inference. Worker
    threads only.
*/
namespace BeatTracker
{
    /** Tracks the beat in `audioFile` and returns the wire object above.

        Returns a void var with `error` set on failure; "cancelled" is the
        reserved error string, as everywhere else in this codebase. A file with
        no beat in it - four seconds of one held note, say - is NOT a failure: it
        comes back as an object with empty arrays and null bpm. */
    juce::var analyse (const juce::File& audioFile,
                       juce::String& error,
                       const std::function<bool()>& shouldCancel = {},
                       const std::function<void (const juce::String&)>& onProgress = {});

    /** The same, for audio already in memory. `channels` may be any count; it is
        downmixed and resampled to the model's 22050 Hz here. */
    juce::var analyse (const float* const* channels, int channelCount,
                       int64_t frameCount, double sampleRate,
                       juce::String& error,
                       const std::function<bool()>& shouldCancel = {},
                       const std::function<void (const juce::String&)>& onProgress = {});

    /** Exposed for the tests: the two derived fields of the wire shape, computed
        exactly as the deleted Python sidecar computed them. */
    juce::var estimateBpm (const std::vector<double>& beats);
    juce::var estimateBeatsPerBar (const std::vector<double>& beats,
                                   const std::vector<double>& downbeats);
}
