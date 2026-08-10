#include "TrackCapture.h"

namespace
{
    juce::var makeObject (std::initializer_list<std::pair<juce::Identifier, juce::var>> properties)
    {
        auto* obj = new juce::DynamicObject();

        for (const auto& property : properties)
            obj->setProperty (property.first, property.second);

        return juce::var (obj);
    }

    /** Quarter notes in one bar of num/den. */
    double barLengthInQuarterNotes (int numerator, int denominator)
    {
        if (numerator <= 0 || denominator <= 0)
            return 4.0;

        return (double) numerator * 4.0 / (double) denominator;
    }
}

TrackCapture::TrackCapture()
{
    marks.resize (maxMarks);
}

void TrackCapture::prepare (double sampleRate)
{
    // A sample-rate change invalidates the take, and the buffer is about to be
    // resized, so park the audio thread first.
    mode.store ((int) Mode::off, std::memory_order_release);
    const juce::SpinLock::ScopedLockType sl (dataLock);
    captureRate = sampleRate > 0.0 ? sampleRate : 44100.0;
    writePos.store (0, std::memory_order_release);
    markCount.store (0, std::memory_order_release);
    marksHitLimit.store (false, std::memory_order_release);
    hitLimit = false;
    buffer.setSize (0, 0);
}

void TrackCapture::setMaxSeconds (double seconds)
{
    const juce::SpinLock::ScopedLockType sl (dataLock);
    maxSeconds = juce::jlimit (1.0, 1800.0, seconds);
}

double TrackCapture::getMaxSeconds() const noexcept
{
    const juce::SpinLock::ScopedLockType sl (dataLock);
    return maxSeconds;
}

double TrackCapture::getSampleRate() const noexcept
{
    const juce::SpinLock::ScopedLockType sl (dataLock);
    return captureRate;
}

double TrackCapture::getCapturedSeconds() const noexcept
{
    const juce::SpinLock::ScopedLockType sl (dataLock);
    return captureRate > 0.0 ? (double) writePos.load (std::memory_order_acquire) / captureRate : 0.0;
}

bool TrackCapture::begin (bool armToTransport, juce::String& error)
{
    mode.store ((int) Mode::off, std::memory_order_release);
    const juce::SpinLock::ScopedLockType sl (dataLock);

    const auto capacity = (int) std::llround (maxSeconds * captureRate);

    if (capacity <= 0)
    {
        error = "capture buffer size came out at zero - is the plugin prepared?";
        return false;
    }

    try
    {
        // Allocated here on the message thread, never on the audio thread.
        buffer.setSize (1, capacity, false, true, false);
    }
    catch (const std::bad_alloc&)
    {
        error = "not enough memory for a " + juce::String (maxSeconds / 60.0, 1) + " minute capture";
        return false;
    }

    buffer.clear();
    writePos.store (0, std::memory_order_release);
    markCount.store (0, std::memory_order_release);
    marksHitLimit.store (false, std::memory_order_release);
    hitLimit = false;
    armedToTransport = armToTransport;

    // Release-store: everything above is visible to the audio thread before it
    // can observe a non-off mode.
    mode.store ((int) (armToTransport ? Mode::armed : Mode::recording), std::memory_order_release);
    return true;
}

void TrackCapture::end()
{
    const auto current = getMode();

    if (current == Mode::armed || current == Mode::recording)
        mode.store ((int) Mode::finished, std::memory_order_release);
}

void TrackCapture::reset()
{
    mode.store ((int) Mode::off, std::memory_order_release);
    const juce::SpinLock::ScopedLockType sl (dataLock);
    writePos.store (0, std::memory_order_release);
    markCount.store (0, std::memory_order_release);
    marksHitLimit.store (false, std::memory_order_release);
    hitLimit = false;
    buffer.setSize (0, 0);
}

juce::AudioBuffer<float> TrackCapture::takeAudio()
{
    const juce::SpinLock::ScopedLockType sl (dataLock);
    const auto frames = (int) juce::jmin ((int64_t) buffer.getNumSamples(),
                                          writePos.load (std::memory_order_acquire));

    juce::AudioBuffer<float> result (1, juce::jmax (0, frames));

    if (frames > 0)
        result.copyFrom (0, 0, buffer, 0, 0, frames);

    return result;
}

//==============================================================================
void TrackCapture::processBlock (const juce::AudioBuffer<float>& input,
                                 int numSamples,
                                 const juce::Optional<juce::AudioPlayHead::PositionInfo>& position)
{
    auto current = (Mode) mode.load (std::memory_order_acquire);

    if (current == Mode::off || current == Mode::finished)
        return;

    // A release-store to mode cannot recall a callback that already read the
    // old value. Participate in buffer retirement with a try-lock instead: if
    // reset/begin/prepare owns it, dropping one capture block is safe and the
    // audio thread never waits.
    const juce::SpinLock::ScopedTryLockType sl (dataLock);

    if (! sl.isLocked())
        return;

    current = (Mode) mode.load (std::memory_order_acquire);

    if (current == Mode::off || current == Mode::finished)
        return;

    const auto hostRolling = position.hasValue() && position->getIsPlaying();

    if (current == Mode::armed)
    {
        if (! hostRolling)
            return;

        // The transport just rolled - start the take here.
        writePos.store (0, std::memory_order_relaxed);
        markCount.store (0, std::memory_order_relaxed);
        marksHitLimit.store (false, std::memory_order_relaxed);
        mode.store ((int) Mode::recording, std::memory_order_release);
        current = Mode::recording;
    }

    const auto start = writePos.load (std::memory_order_relaxed);

    if (current == Mode::recording && armedToTransport.load() && ! hostRolling && start > 0)
    {
        // Transport stopped: that is the end of the take.
        mode.store ((int) Mode::finished, std::memory_order_release);
        return;
    }

    const auto capacity = (int64_t) buffer.getNumSamples();

    if (capacity <= 0)
        return;

    const auto room = capacity - start;

    if (room <= 0)
    {
        hitLimit = true;
        mode.store ((int) Mode::finished, std::memory_order_release);
        return;
    }

    const auto toCopy = (int) juce::jmin ((int64_t) numSamples, room);
    const auto numInputChannels = input.getNumChannels();

    maybeAddMark (position, start);

    auto* dest = buffer.getWritePointer (0);

    if (numInputChannels <= 0)
    {
        juce::FloatVectorOperations::clear (dest + start, toCopy);
    }
    else
    {
        juce::FloatVectorOperations::copy (dest + start, input.getReadPointer (0), toCopy);

        for (int ch = 1; ch < numInputChannels; ++ch)
            juce::FloatVectorOperations::add (dest + start, input.getReadPointer (ch), toCopy);

        if (numInputChannels > 1)
            juce::FloatVectorOperations::multiply (dest + start, 1.0f / (float) numInputChannels, toCopy);
    }

    const auto newPos = start + toCopy;
    writePos.store (newPos, std::memory_order_release);

    if (newPos >= capacity)
    {
        hitLimit = true;
        mode.store ((int) Mode::finished, std::memory_order_release);
    }
}

void TrackCapture::maybeAddMark (const juce::Optional<juce::AudioPlayHead::PositionInfo>& position,
                                 int64_t frame)
{
    if (! position.hasValue())
        return;

    const auto count = markCount.load (std::memory_order_relaxed);

    if (count >= maxMarks)
    {
        marksHitLimit.store (true, std::memory_order_relaxed);
        return;
    }

    TimelineMark mark;
    mark.frame = frame;

    if (const auto bpm = position->getBpm())
    {
        mark.hasTempo = true;
        mark.bpm = *bpm;
    }

    if (const auto sig = position->getTimeSignature())
    {
        mark.hasTimeSig = true;
        mark.timeSigNumerator = sig->numerator;
        mark.timeSigDenominator = sig->denominator;
    }

    if (const auto ppq = position->getPpqPosition())
    {
        mark.hasPpq = true;
        mark.ppqPosition = *ppq;

        if (const auto barStart = position->getPpqPositionOfLastBarStart())
        {
            mark.hasPpqOfLastBarStart = true;
            mark.ppqOfLastBarStart = *barStart;
        }
        else
        {
            // JUCE never synthesises this - it is strictly whatever the host
            // put in kBarPositionValid / outCurrentMeasureDownBeat. Falling back
            // to the playhead means "assume this instant is a bar line", which
            // is only defensible because it is recorded as NOT reported.
            mark.ppqOfLastBarStart = *ppq;
        }
    }

    if (count > 0)
    {
        // Only record a mark when the timeline actually moved somewhere we could
        // not have predicted - otherwise a 5 minute take would burn all 4096
        // slots in the first few seconds.
        const auto& previous = marks[(size_t) count - 1];

        const auto tempoSame = previous.hasTempo == mark.hasTempo
                            && std::abs (previous.bpm - mark.bpm) < 1.0e-6;
        const auto sigSame = previous.hasTimeSig == mark.hasTimeSig
                          && previous.timeSigNumerator == mark.timeSigNumerator
                          && previous.timeSigDenominator == mark.timeSigDenominator;

        auto ppqContinuous = true;

        if (previous.hasPpq && mark.hasPpq && previous.hasTempo && captureRate > 0.0)
        {
            const auto elapsedSec = (double) (frame - previous.frame) / captureRate;
            const auto predicted = previous.ppqPosition + elapsedSec * previous.bpm / 60.0;
            ppqContinuous = std::abs (predicted - mark.ppqPosition) < 1.0e-3;
        }

        if (tempoSame && sigSame && ppqContinuous)
            return;
    }

    marks[(size_t) count] = mark;
    markCount.store (count + 1, std::memory_order_release);
}

//==============================================================================
/**
    The host's musical timeline for this take, with the ambiguities left in.

    THE BUG THIS IS WRITTEN AGAINST. The user set REAPER to 222 BPM and 3/6 and
    Riffsheet drew 102 BPM and 4/4. Only one place in this file could ever have
    turned a real meter into 4/4: `hostTimeSigNumerator` used to be read from
    marks[0] alone, and marks[0] is the first block of the take. A host that
    raises kTimeSigValid a block or two late - or not at all - left it null, and
    null was silently read as 4 downstream. The old bar-line walk did the same
    thing twice over, defaulting to 4/4 when laying bars down, which puts every
    bar line in the wrong place while looking perfectly confident.

    So now:

      - the meter is taken from the first mark that ACTUALLY carries one, and it
        says whether that was the first block (`hostTimeSigInferred`);
      - when no mark carries one, the numbers stay null, `hostTimeSigKnown` is
        false, and a plain sentence goes in `ambiguities` for the UI to show;
      - and NO bar lines are emitted at all in that case, because bar lines drawn
        on an assumed 4/4 are invented musical information (design notes §4.8) and a
        bar line in the wrong place is worse than no bar line.
*/
juce::var TrackCapture::buildContext() const
{
    int count = 0;
    int64_t frames = 0;
    double sampleRate = 0.0;
    std::vector<TimelineMark> marksSnapshot;

    {
        // Copy a coherent snapshot, then do the relatively expensive JSON/bar
        // construction without making the audio callback drop more blocks.
        const juce::SpinLock::ScopedLockType sl (dataLock);
        count = juce::jlimit (0, maxMarks, markCount.load (std::memory_order_acquire));
        frames = writePos.load (std::memory_order_acquire);
        sampleRate = captureRate;
        marksSnapshot.assign (marks.begin(), marks.begin() + count);
    }

    const auto durationSec = sampleRate > 0.0 ? (double) frames / sampleRate : 0.0;
    const auto frameToSec = [sampleRate] (int64_t frame)
    {
        return sampleRate > 0.0 ? (double) frame / sampleRate : 0.0;
    };

    juce::Array<juce::var> ambiguities;

    if (count <= 0)
    {
        // Standalone, or a host that reports no position at all.
        ambiguities.add ("The host did not report a playhead during this take, so there is no DAW "
                         "tempo or time signature to sync to.");

        return makeObject ({ { "hasHostTimeline", false },
                             { "hostBpm", juce::var() },
                             { "hostBpmKnown", false },
                             { "hostTimeSigNumerator", juce::var() },
                             { "hostTimeSigDenominator", juce::var() },
                             { "hostTimeSigKnown", false },
                             { "hostTimeSigInferred", false },
                             { "hostTimeSigChanged", false },
                             { "hostTimeSigUnusual", false },
                             { "startPpq", juce::var() },
                             { "startPpqOfLastBarStart", juce::var() },
                             { "marksHitLimit", false },
                             { "barStartsSec", juce::var (juce::Array<juce::var>{}) },
                             { "tempoChanges", juce::var (juce::Array<juce::var>{}) },
                             { "ambiguities", ambiguities } });
    }

    const auto& first = marksSnapshot[0];

    // ---- what the host told us about the meter, and when ---------------------
    auto firstSigIndex = -1;
    auto sigChanged = false;

    for (int i = 0; i < count; ++i)
    {
        const auto& mark = marksSnapshot[(size_t) i];

        if (! mark.hasTimeSig)
            continue;

        if (firstSigIndex < 0)
        {
            firstSigIndex = i;
            continue;
        }

        const auto& known = marksSnapshot[(size_t) firstSigIndex];

        if (mark.timeSigNumerator != known.timeSigNumerator
            || mark.timeSigDenominator != known.timeSigDenominator)
            sigChanged = true;
    }

    const auto sigKnown = firstSigIndex >= 0;
    const auto sigInferred = sigKnown && firstSigIndex > 0;
    const auto sigNumerator = sigKnown ? marksSnapshot[(size_t) firstSigIndex].timeSigNumerator : 0;
    const auto sigDenominator = sigKnown ? marksSnapshot[(size_t) firstSigIndex].timeSigDenominator : 0;

    // A denominator that is not a power of two (REAPER will happily give you
    // 3/6) is legal on the wire and JUCE passes it through untouched, but almost
    // nothing downstream expects it. Flagged rather than corrected.
    const auto sigUnusual = sigKnown
                         && (sigDenominator <= 0 || (sigDenominator & (sigDenominator - 1)) != 0);

    if (! sigKnown)
        ambiguities.add ("The DAW never reported a time signature during this take, so Riffsheet "
                         "does not know the meter and has not guessed one.");
    else if (sigInferred)
        ambiguities.add ("The DAW did not report a time signature until "
                         + juce::String (frameToSec (marksSnapshot[(size_t) firstSigIndex].frame), 2)
                         + "s into the take; " + juce::String (sigNumerator) + "/"
                         + juce::String (sigDenominator) + " has been used from the start.");

    if (sigChanged)
        ambiguities.add ("The time signature changed during this take. Riffsheet writes one meter "
                         "for the whole riff and has used the first one.");

    if (sigUnusual)
        ambiguities.add ("The DAW reported an unusual time signature (" + juce::String (sigNumerator)
                         + "/" + juce::String (sigDenominator) + "). It is passed on exactly as "
                         "given, but most notation - including Riffsheet's own meter menu - only "
                         "handles denominators of 2, 4, 8 or 16.");

    if (! first.hasTempo)
        ambiguities.add ("The DAW did not report a tempo at the start of this take.");

    if (marksHitLimit.load (std::memory_order_acquire))
        ambiguities.add ("This take had more tempo changes than Riffsheet records, so the later "
                         "ones are missing from the grid.");

    // ---- every mark, as given ------------------------------------------------
    juce::Array<juce::var> tempoChanges;

    for (int i = 0; i < count; ++i)
    {
        const auto& mark = marksSnapshot[(size_t) i];

        tempoChanges.add (makeObject ({
            { "timeSec", frameToSec (mark.frame) },
            { "bpm", mark.hasTempo ? juce::var (mark.bpm) : juce::var() },
            { "timeSigNumerator", mark.hasTimeSig ? juce::var (mark.timeSigNumerator) : juce::var() },
            { "timeSigDenominator", mark.hasTimeSig ? juce::var (mark.timeSigDenominator) : juce::var() },
            { "ppqPosition", mark.hasPpq ? juce::var (mark.ppqPosition) : juce::var() } }));
    }

    // ---- bar starts ---------------------------------------------------------
    // Walk the marks as tempo segments and lay bars down across them, so a take
    // that crosses a tempo change still gets bar lines in the right places.
    //
    // Requires a KNOWN meter. Without one the bar length is unknowable and the
    // old 4/4 assumption produced confident, wrong bar lines.
    juce::Array<juce::var> barStarts;

    if (first.hasPpq && first.hasTempo && first.bpm > 0.0 && sigKnown)
    {
        constexpr int barLimit = 20000;

        // Musical position of the first bar line at or before the capture start.
        auto barPpq = first.ppqOfLastBarStart;
        auto segment = 0;

        for (int guard = 0; guard < barLimit; ++guard)
        {
            // Advance to the segment that governs this musical position.
            while (segment + 1 < count
                   && marksSnapshot[(size_t) segment + 1].hasPpq
                   && marksSnapshot[(size_t) segment + 1].ppqPosition <= barPpq)
                ++segment;

            const auto& active = marksSnapshot[(size_t) segment];

            if (! active.hasTempo || active.bpm <= 0.0 || ! active.hasPpq)
                break;

            const auto timeSec = frameToSec (active.frame)
                               + (barPpq - active.ppqPosition) * 60.0 / active.bpm;

            if (timeSec > durationSec)
                break;

            // Bars before the take started are not part of this capture, but the
            // first one that lands inside it is.
            if (timeSec >= -1.0e-9)
                barStarts.add (timeSec);

            // The meter in force in this segment if it reported one, otherwise
            // the one we do know about - never a silent 4/4.
            const auto barQn = barLengthInQuarterNotes (
                active.hasTimeSig ? active.timeSigNumerator : sigNumerator,
                active.hasTimeSig ? active.timeSigDenominator : sigDenominator);

            if (barQn <= 0.0)
                break;

            barPpq += barQn;
        }
    }

    if (barStarts.isEmpty())
        ambiguities.add ("No bar lines could be worked out from what the DAW reported, so the "
                         "sheet uses the tempo Riffsheet heard in the audio instead.");

    return makeObject ({
        // The host gave a playhead AND something musical on it. A playhead that
        // only carries a sample count is not a timeline.
        { "hasHostTimeline", first.hasTempo || first.hasPpq },
        { "hostBpm", first.hasTempo ? juce::var (first.bpm) : juce::var() },
        { "hostBpmKnown", first.hasTempo },
        { "hostTimeSigNumerator", sigKnown ? juce::var (sigNumerator) : juce::var() },
        { "hostTimeSigDenominator", sigKnown ? juce::var (sigDenominator) : juce::var() },
        { "hostTimeSigKnown", sigKnown },
        { "hostTimeSigInferred", sigInferred },
        { "hostTimeSigChanged", sigChanged },
        { "hostTimeSigUnusual", sigUnusual },
        { "startPpq", first.hasPpq ? juce::var (first.ppqPosition) : juce::var() },
        { "startPpqOfLastBarStart", first.hasPpqOfLastBarStart ? juce::var (first.ppqOfLastBarStart)
                                                               : juce::var() },
        { "marksHitLimit", marksHitLimit.load (std::memory_order_acquire) },
        { "barStartsSec", barStarts },
        { "tempoChanges", tempoChanges },
        { "ambiguities", ambiguities } });
}

//==============================================================================
juce::var TrackCapture::describeMarks() const
{
    int count = 0;
    int64_t frames = 0;
    double sampleRate = 0.0;
    std::vector<TimelineMark> marksSnapshot;

    {
        const juce::SpinLock::ScopedLockType sl (dataLock);
        count = juce::jlimit (0, maxMarks, markCount.load (std::memory_order_acquire));
        frames = writePos.load (std::memory_order_acquire);
        sampleRate = captureRate;
        marksSnapshot.assign (marks.begin(), marks.begin() + count);
    }

    juce::Array<juce::var> list;

    for (int i = 0; i < count; ++i)
    {
        const auto& mark = marksSnapshot[(size_t) i];

        // Raw. Every value paired with whether the host actually reported it,
        // and nothing derived - the point of this call is to be believable.
        list.add (makeObject ({
            { "index", i },
            { "frame", (double) mark.frame },
            { "timeSec", sampleRate > 0.0 ? (double) mark.frame / sampleRate : 0.0 },
            { "hasTempo", mark.hasTempo },
            { "bpm", mark.hasTempo ? juce::var (mark.bpm) : juce::var() },
            { "hasTimeSig", mark.hasTimeSig },
            { "timeSigNumerator", mark.hasTimeSig ? juce::var (mark.timeSigNumerator) : juce::var() },
            { "timeSigDenominator", mark.hasTimeSig ? juce::var (mark.timeSigDenominator) : juce::var() },
            { "hasPpq", mark.hasPpq },
            { "ppqPosition", mark.hasPpq ? juce::var (mark.ppqPosition) : juce::var() },
            { "hasPpqOfLastBarStart", mark.hasPpqOfLastBarStart },
            { "ppqOfLastBarStart", mark.hasPpqOfLastBarStart ? juce::var (mark.ppqOfLastBarStart)
                                                             : juce::var() } }));
    }

    return makeObject ({ { "count", count },
                         { "capacity", maxMarks },
                         { "hitLimit", marksHitLimit.load (std::memory_order_acquire) },
                         { "sampleRate", sampleRate },
                         { "framesCaptured", (double) frames },
                         { "marks", list } });
}
