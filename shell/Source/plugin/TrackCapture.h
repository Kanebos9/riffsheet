#pragma once
#include <JuceHeader.h>

/**
    Records the track's own audio straight off the audio thread, so a player can
    transcribe what they just played without bouncing a file first.

    Audio-thread discipline: processBlock() never allocates or blocks. It takes
    a non-blocking try-lock before touching capture storage and drops that block
    if the message thread is resizing/retiring the buffer. Publication through
    `mode` alone is not enough: an audio callback may already have observed the
    old mode when reset() begins. Positions are plain atomics.

    Alongside the samples it records the host's musical timeline - tempo, time
    signature and bar positions from the playhead - because the bars in the
    finished score have to line up with the bars in the DAW. Tempo changes mid
    take are recorded as a list rather than assumed away.

    Capture is linear, not a ring: it keeps the FIRST maxSeconds and then stops.
    Someone hitting record and playing a riff wants the beginning, not the tail.
*/
class TrackCapture
{
public:
    TrackCapture();

    enum class Mode { off, armed, recording, finished };

    /** One sample of the host's musical position. */
    struct TimelineMark
    {
        int64_t frame = 0;               // offset into the capture buffer
        double  ppqPosition = 0.0;
        double  ppqOfLastBarStart = 0.0;
        double  bpm = 0.0;
        int     timeSigNumerator = 0;
        int     timeSigDenominator = 0;
        bool    hasTempo = false;
        bool    hasTimeSig = false;
        bool    hasPpq = false;
        /** Separate from hasPpq: some hosts give a musical position but no bar
            position, and "the bar starts exactly here" is a very different claim
            from "we had to fall back to the playhead". */
        bool    hasPpqOfLastBarStart = false;
    };

    //== message thread ========================================================
    void prepare (double sampleRate);
    void setMaxSeconds (double seconds);
    double getMaxSeconds() const noexcept;

    /** Allocates and arms. `armToTransport` waits for the host to roll instead
        of recording immediately. Returns false and fills `error` if the buffer
        could not be allocated. */
    bool begin (bool armToTransport, juce::String& error);

    /** Stops recording and freezes what was captured. */
    void end();

    /** Throws the take away and releases the memory. */
    void reset();

    Mode   getMode() const noexcept          { return (Mode) mode.load (std::memory_order_acquire); }
    bool   isArmedToTransport() const noexcept { return armedToTransport.load(); }
    double getSampleRate() const noexcept;
    int64_t getNumFramesCaptured() const noexcept { return writePos.load (std::memory_order_acquire); }
    double getCapturedSeconds() const noexcept;
    bool   didHitLimit() const noexcept      { return hitLimit.load(); }

    /** Moves the captured audio out. Only valid once the mode is `finished`. */
    juce::AudioBuffer<float> takeAudio();

    /** The musical timeline recorded during the take, as
        { hasHostTimeline, hostBpm, hostBpmKnown,
          hostTimeSigNumerator, hostTimeSigDenominator, hostTimeSigKnown,
          hostTimeSigInferred, hostTimeSigChanged, hostTimeSigUnusual,
          startPpq, startPpqOfLastBarStart,
          barStartsSec: [...], tempoChanges: [...],
          marksHitLimit, ambiguities: [...] }
        with nulls wherever the host told us nothing.

        The `*Known` flags and `ambiguities` exist because a null here used to be
        silently turned into 4/4 further downstream, which is how a DAW set to
        3/6 could end up drawn as 4/4. A number nobody reported is not reported. */
    juce::var buildContext() const;

    /** Every mark exactly as the playhead gave it, flags and all, for
        `hostTimelineProbe()`. Uninterpreted on purpose: this is the call that
        answers "what did REAPER actually say?" without anybody having to guess. */
    juce::var describeMarks() const;

    //== audio thread ==========================================================
    void processBlock (const juce::AudioBuffer<float>& buffer,
                       int numSamples,
                       const juce::Optional<juce::AudioPlayHead::PositionInfo>& position);

private:
    void maybeAddMark (const juce::Optional<juce::AudioPlayHead::PositionInfo>& position,
                       int64_t frame);

    static constexpr int maxMarks = 4096;

    std::atomic<int> mode { (int) Mode::off };
    std::atomic<bool> armedToTransport { false };
    std::atomic<int64_t> writePos { 0 };
    std::atomic<bool> hitLimit { false };
    std::atomic<int> markCount { 0 };
    /** True when the take had more timeline changes than there are slots. Worth
        reporting rather than silently truncating a tempo ramp. */
    std::atomic<bool> marksHitLimit { false };

    /** Serialises ownership of buffer/marks/captureRate. The audio callback
        only ever try-locks this, so UI operations cannot block the audio thread. */
    mutable juce::SpinLock dataLock;
    juce::AudioBuffer<float> buffer;      // mono, preallocated by begin()
    std::vector<TimelineMark> marks;      // preallocated, never grown on the audio thread

    double captureRate = 44100.0;
    double maxSeconds = 300.0;            // 5 minutes

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TrackCapture)
};
