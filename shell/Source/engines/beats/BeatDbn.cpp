#include "BeatDbn.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

namespace BeatDbn
{
namespace
{
    constexpr double kNegativeInfinity = -std::numeric_limits<double>::infinity();

    /** The tempo grid.

        Integer inter-beat intervals from round(60*fps/maxBpm) to
        round(60*fps/minBpm). When there are more of those than kNumTempi, they
        are replaced by kNumTempi log-spaced ones - and because rounding can
        collide, the count is raised until enough DISTINCT intervals survive.
        That loop is not decoration: without it a request for 60 tempi can return
        57, and the state space, the transition matrix and every beat that comes
        out of them would differ. */
    std::vector<int> buildIntervals()
    {
        const auto minInterval = 60.0 * kFps / kMaxBpm;
        const auto maxInterval = 60.0 * kFps / kMinBpm;

        std::vector<int> linear;

        for (auto i = (int) std::lround (minInterval); i <= (int) std::lround (maxInterval); ++i)
            linear.push_back (i);

        if ((int) linear.size() <= kNumTempi)
            return linear;

        const auto logMin = std::log2 (minInterval);
        const auto logMax = std::log2 (maxInterval);

        for (auto count = kNumTempi;; ++count)
        {
            std::vector<int> spaced;
            spaced.reserve ((size_t) count);

            for (int i = 0; i < count; ++i)
            {
                const auto position = count > 1 ? (double) i / (double) (count - 1) : 0.0;
                spaced.push_back ((int) std::lround (std::pow (2.0, logMin + (logMax - logMin) * position)));
            }

            std::sort (spaced.begin(), spaced.end());
            spaced.erase (std::unique (spaced.begin(), spaced.end()), spaced.end());

            if ((int) spaced.size() >= kNumTempi)
                return spaced;
        }
    }

    /** log P(next interval | this interval), rows normalised to sum to 1.
        ISMIR 2015: exp(-lambda * |ratio - 1|), with everything at or below one
        ULP of 1.0 forced to exactly zero so it becomes a forbidden transition
        rather than a denormal that survives the normalisation. */
    std::vector<double> buildTransitionLogProbabilities (const std::vector<int>& tempi)
    {
        const auto n = tempi.size();
        std::vector<double> probabilities (n * n, 0.0);

        for (size_t from = 0; from < n; ++from)
        {
            auto total = 0.0;

            for (size_t to = 0; to < n; ++to)
            {
                const auto ratio = (double) tempi[to] / (double) tempi[from];
                auto p = std::exp (-kTransitionLambda * std::abs (ratio - 1.0));

                if (p <= std::numeric_limits<double>::epsilon())
                    p = 0.0;

                probabilities[from * n + to] = p;
                total += p;
            }

            for (size_t to = 0; to < n; ++to)
            {
                auto& value = probabilities[from * n + to];
                value = (total > 0.0 && value > 0.0) ? std::log (value / total) : kNegativeInfinity;
            }
        }

        return probabilities;
    }

    /** One bar of `beats` beats over the tempo grid.

        Layout, which the Viterbi below relies on completely: beat b occupies
        [b * statesPerBeat, (b+1) * statesPerBeat), and within a beat the tempi
        follow each other in order, tempo j occupying `tempi[j]` consecutive
        states. So every state except the first of a tempo block has exactly one
        predecessor - the state before it - and only the first states need a
        search. That is what makes the back-pointer array small enough to keep. */
    struct BarSpace
    {
        int beats = 0;
        int statesPerBeat = 0;
        int numStates = 0;
        std::vector<int> firstStates;   // beats * tempi, row-major by beat
        std::vector<int> lastStates;
        std::vector<uint8_t> pointers;  // 0 = off beat, 1 = beat, 2 = downbeat

        BarSpace (int beatsPerBar, const std::vector<int>& tempi)
            : beats (beatsPerBar)
        {
            const auto tempoCount = (int) tempi.size();

            for (auto interval : tempi)
                statesPerBeat += interval;

            numStates = statesPerBeat * beats;
            firstStates.resize ((size_t) beats * (size_t) tempoCount);
            lastStates.resize ((size_t) beats * (size_t) tempoCount);
            pointers.assign ((size_t) numStates, 0);

            const auto border = 1.0 / (double) kObservationLambda;
            auto state = 0;

            for (int beat = 0; beat < beats; ++beat)
            {
                for (int tempo = 0; tempo < tempoCount; ++tempo)
                {
                    const auto interval = tempi[(size_t) tempo];
                    firstStates[(size_t) beat * (size_t) tempoCount + (size_t) tempo] = state;
                    lastStates[(size_t) beat * (size_t) tempoCount + (size_t) tempo] = state + interval - 1;

                    for (int step = 0; step < interval; ++step, ++state)
                    {
                        // The position WITHIN the beat. madmom stores b + step/interval
                        // and takes it modulo 1 here; the modulo is exact for an
                        // integer b, so this is the same number without the round
                        // trip. Both 1/16 and the step/interval values that could
                        // tie with it (interval a multiple of 16) are exact in
                        // binary, so `<` never lands on a coin flip.
                        const auto position = (double) step / (double) interval;

                        if (position < border)
                            pointers[(size_t) state] = beat == 0 ? 2 : 1;
                    }
                }
            }
        }
    };

    struct Decoded
    {
        std::vector<int> beatNumbers;   // per frame
        std::vector<uint8_t> pointers;  // per frame, from the observation model
        double logProbability = kNegativeInfinity;
        int beatsPerBar = 0;
        bool cancelled = false;
    };

    /** Viterbi over one BarSpace.

        MEMORY. The obvious back-pointer array is frames x numStates, which for a
        five-minute take is 15000 x 11684 x 4 bytes - 700 MB, on a machine this
        project has decided is an 8 GB M-series. It is also almost entirely
        redundant: every state except a tempo block's first has predecessor
        state-1. So only the choices made at the beat boundaries are stored -
        frames x (beats * tempi) bytes, 3.6 MB for the same take - and the rest of
        the path is rebuilt on the way back. Same path, 200x less memory. */
    Decoded viterbi (const BarSpace& space,
                     const std::vector<int>& tempi,
                     const std::vector<double>& transitions,
                     const std::vector<double>& densities,   // frames * 3
                     int frames,
                     const std::function<bool()>& shouldCancel)
    {
        Decoded decoded;
        decoded.beatsPerBar = space.beats;

        const auto tempoCount = (int) tempi.size();
        const auto boundaries = space.beats * tempoCount;

        std::vector<double> previous ((size_t) space.numStates, -std::log ((double) space.numStates));
        std::vector<double> current ((size_t) space.numStates, kNegativeInfinity);
        std::vector<uint8_t> choices ((size_t) frames * (size_t) boundaries, 0);

        for (int frame = 0; frame < frames; ++frame)
        {
            if (shouldCancel != nullptr && shouldCancel())
            {
                decoded.cancelled = true;
                return decoded;
            }

            // Inside a beat the pointer just advances: copy the whole block one
            // state along, then overwrite the first state of every tempo block.
            std::copy (previous.begin(), previous.end() - 1, current.begin() + 1);

            auto* choiceRow = choices.data() + (size_t) frame * (size_t) boundaries;

            for (int beat = 0; beat < space.beats; ++beat)
            {
                // Beat 0's predecessor is the LAST beat of the bar: that wrap is
                // the whole meaning of a bar-pointer model.
                const auto fromBeat = (beat + space.beats - 1) % space.beats;
                const auto* from = space.lastStates.data() + (size_t) fromBeat * (size_t) tempoCount;
                const auto* to = space.firstStates.data() + (size_t) beat * (size_t) tempoCount;

                for (int toTempo = 0; toTempo < tempoCount; ++toTempo)
                {
                    auto best = kNegativeInfinity;
                    auto bestTempo = 0;

                    for (int fromTempo = 0; fromTempo < tempoCount; ++fromTempo)
                    {
                        const auto logTransition = transitions[(size_t) fromTempo * (size_t) tempoCount
                                                                + (size_t) toTempo];

                        // A tempo change the exponential distribution rounded to
                        // zero: not a transition at all, and adding -inf to a
                        // running score is slower than skipping it.
                        if (std::isinf (logTransition))
                            continue;

                        const auto candidate = previous[(size_t) from[fromTempo]] + logTransition;

                        // Strictly greater, so the FIRST maximum wins - the same
                        // tie-break the reference makes, and ties are common
                        // because the initial distribution is uniform.
                        if (candidate > best)
                        {
                            best = candidate;
                            bestTempo = fromTempo;
                        }
                    }

                    current[(size_t) to[toTempo]] = best;
                    choiceRow[(size_t) beat * (size_t) tempoCount + (size_t) toTempo] = (uint8_t) bestTempo;
                }
            }

            const auto* density = densities.data() + (size_t) frame * 3;

            for (int state = 0; state < space.numStates; ++state)
                current[(size_t) state] += density[space.pointers[(size_t) state]];

            previous.swap (current);
        }

        // The best final state, then backwards.
        auto state = 0;
        auto best = kNegativeInfinity;

        for (int i = 0; i < space.numStates; ++i)
        {
            if (previous[(size_t) i] > best)
            {
                best = previous[(size_t) i];
                state = i;
            }
        }

        decoded.logProbability = best;
        decoded.beatNumbers.assign ((size_t) frames, 0);
        decoded.pointers.assign ((size_t) frames, 0);

        for (int frame = frames; --frame >= 0;)
        {
            decoded.beatNumbers[(size_t) frame] = state / space.statesPerBeat + 1;
            decoded.pointers[(size_t) frame] = space.pointers[(size_t) state];

            const auto beat = state / space.statesPerBeat;
            const auto within = state - beat * space.statesPerBeat;

            // Which tempo block is `within` in, and is it that block's first state?
            auto offset = 0;
            auto tempo = 0;

            for (; tempo < (int) tempi.size(); ++tempo)
            {
                if (within < offset + tempi[(size_t) tempo])
                    break;

                offset += tempi[(size_t) tempo];
            }

            if (within == offset)
            {
                const auto* row = choices.data() + (size_t) frame * (size_t) (space.beats * (int) tempi.size());
                const auto fromTempo = (int) row[(size_t) beat * tempi.size() + (size_t) tempo];
                const auto fromBeat = (beat + space.beats - 1) % space.beats;
                state = space.lastStates[(size_t) fromBeat * tempi.size() + (size_t) fromTempo];
            }
            else
            {
                --state;
            }
        }

        return decoded;
    }
}

//==============================================================================
const std::vector<int>& intervals()
{
    static const std::vector<int> tempi = buildIntervals();
    return tempi;
}

void activationsFromLogits (const std::vector<float>& beatLogits,
                            const std::vector<float>& downbeatLogits,
                            std::vector<float>& out)
{
    const auto frames = juce::jmin (beatLogits.size(), downbeatLogits.size());
    out.assign (frames * 2, 0.0f);

    constexpr double epsilon = 1.0e-5;

    for (size_t i = 0; i < frames; ++i)
    {
        auto beat = 1.0 / (1.0 + std::exp (-(double) beatLogits[i]));
        auto downbeat = 1.0 / (1.0 + std::exp (-(double) downbeatLogits[i]));

        beat = beat * (1.0 - epsilon) + epsilon / 2.0;
        downbeat = downbeat * (1.0 - epsilon) + epsilon / 2.0;

        out[i * 2]     = (float) juce::jmax (beat - downbeat, epsilon / 2.0);
        out[i * 2 + 1] = (float) downbeat;
    }
}

namespace
{
    /** One beat per contiguous run of in-beat frames, placed at the frame with the
        largest activation in the run. The path says WHERE the beat is to within a
        sixteenth of a period; the activation says which frame in that window the
        network actually heard something on.

        The reference takes the argmax over the FLATTENED two-column slice and
        divides by two, i.e. the largest of either column, first occurrence
        winning. Comparing the row maximum with `>` is the same thing said
        forwards. */
    std::vector<int> pickBeats (const std::vector<uint8_t>& pointers, const float* window, int frames)
    {
        std::vector<int> peaks;

        for (int frame = 0; frame < frames;)
        {
            if (pointers[(size_t) frame] == 0)
            {
                ++frame;
                continue;
            }

            auto end = frame;

            while (end < frames && pointers[(size_t) end] != 0)
                ++end;

            auto peak = frame;
            auto peakValue = -std::numeric_limits<double>::infinity();

            for (int i = frame; i < end; ++i)
            {
                const auto value = juce::jmax ((double) window[(size_t) i * 2],
                                               (double) window[(size_t) i * 2 + 1]);

                if (value > peakValue)
                {
                    peakValue = value;
                    peak = i;
                }
            }

            peaks.push_back (peak);
            frame = end;
        }

        return peaks;
    }

    /** HOW MUCH THE DOWNBEAT COLUMN SUPPORTS A BAR OF `beatsPerBar`, in nats.

        Given the beats the tracker already found, a bar length is a claim that
        every `beatsPerBar`-th one of them is accented. Score that claim directly:
        for the best phase, the mean log downbeat activation at the beats the bar
        WOULD call downbeats, minus the mean at the beats it would not.

        WHY THIS AND NOT THE PATH PROBABILITY. The likelihood of a Viterbi path is
        not comparable across bar lengths - a longer bar is forced to spend fewer
        downbeat labels, so it scores higher on material with no downbeat
        information at all, which is the trap the first attempt at odd metres fell
        into. This statistic has that bias removed by construction: it is a
        DIFFERENCE of means over the same beats, so a bar length that lines up
        with real accents scores high whatever its length, and one that does not
        scores about zero however long it is.

        Phase is maximised over rather than assumed, because the tracker's beat 1
        is only meaningful under the bar length that produced it. */
    double downbeatEvidence (const std::vector<int>& peaks, const float* window, int beatsPerBar)
    {
        const auto count = (int) peaks.size();

        if (beatsPerBar < 2 || count < beatsPerBar)
            return 0.0;

        std::vector<double> logDownbeat ((size_t) count);

        for (int i = 0; i < count; ++i)
        {
            // Already floored off zero by activationsFromLogits, so the log is finite.
            const auto value = (double) window[(size_t) peaks[(size_t) i] * 2 + 1];
            logDownbeat[(size_t) i] = std::log (juce::jmax (value, 1.0e-9));
        }

        auto bestScore = -std::numeric_limits<double>::infinity();

        for (int phase = 0; phase < beatsPerBar; ++phase)
        {
            auto onSum = 0.0, offSum = 0.0;
            auto onCount = 0, offCount = 0;

            for (int i = 0; i < count; ++i)
            {
                if (i % beatsPerBar == phase)
                {
                    onSum += logDownbeat[(size_t) i];
                    ++onCount;
                }
                else
                {
                    offSum += logDownbeat[(size_t) i];
                    ++offCount;
                }
            }

            if (onCount == 0 || offCount == 0)
                continue;

            bestScore = juce::jmax (bestScore, onSum / onCount - offSum / offCount);
        }

        return std::isfinite (bestScore) ? bestScore : 0.0;
    }
}

Result track (const std::vector<float>& activations, const std::function<bool()>& shouldCancel)
{
    Result result;

    const auto totalFrames = (int) (activations.size() / 2);

    if (totalFrames <= 0)
        return result;

    // Trim to the span between the first and last frame that says anything at
    // all. Without it a take that starts with eight seconds of room tone gets a
    // beat grid over the room tone, because the HMM always produces SOME path.
    auto first = -1, last = -1;

    for (int frame = 0; frame < totalFrames; ++frame)
    {
        if (activations[(size_t) frame * 2] >= (float) kThreshold
            || activations[(size_t) frame * 2 + 1] >= (float) kThreshold)
        {
            if (first < 0)
                first = frame;

            last = frame;
        }
    }

    if (first < 0)
        return result;

    const auto frames = last - first + 1;
    const auto* window = activations.data() + (size_t) first * 2;

    // The observation model's three log densities per frame: off beat, beat,
    // downbeat. The "off beat" density is the leftover probability spread over
    // the observation_lambda - 1 non-beat parts of the period, which is what
    // makes a long quiet stretch cheap to sit through.
    std::vector<double> densities ((size_t) frames * 3);

    for (int frame = 0; frame < frames; ++frame)
    {
        const auto beat = (double) window[(size_t) frame * 2];
        const auto downbeat = (double) window[(size_t) frame * 2 + 1];

        densities[(size_t) frame * 3]     = std::log ((1.0 - (beat + downbeat)) / (kObservationLambda - 1.0));
        densities[(size_t) frame * 3 + 1] = std::log (beat);
        densities[(size_t) frame * 3 + 2] = std::log (downbeat);
    }

    const auto& tempi = intervals();
    const auto transitions = buildTransitionLogProbabilities (tempi);

    // One HMM per candidate bar length; among the CORE pair the one with the
    // higher path probability decides both the beats and the metre. This loop is
    // untouched, and when no odd candidate qualifies below it is the whole answer.
    Decoded best;
    auto cancelled = false;

    const auto decode = [&] (int beatsPerBar) -> Decoded
    {
        const BarSpace space (beatsPerBar, tempi);
        auto decoded = viterbi (space, tempi, transitions, densities, frames, shouldCancel);

        if (decoded.cancelled)
            cancelled = true;

        return decoded;
    };

    for (const auto beatsPerBar : kBeatsPerBarOptions)
    {
        auto decoded = decode (beatsPerBar);

        if (cancelled)
            return {};

        if (decoded.logProbability > best.logProbability)
            best = std::move (decoded);
    }

    if (best.beatsPerBar == 0)
        return result;

    auto peaks = pickBeats (best.pointers, window, frames);

    // ---- the odd metres ---------------------------------------------------
    //
    // Everything above is what this file did before odd bars existed. What
    // follows may only REPLACE that answer, never soften it: if no candidate
    // clears every gate, `best` and `peaks` go out untouched.
    {
        const auto coreEvidence = downbeatEvidence (peaks, window, best.beatsPerBar);

        auto bestExtended = 0;
        auto bestEvidence = juce::jmax (coreEvidence + kDownbeatEvidenceMargin, kDownbeatEvidenceMin);

        for (const auto beatsPerBar : kExtendedBeatsPerBarOptions)
        {
            // GATE 3 first, because it is free and it is the one that protects
            // sparse material: a take too short to show the pattern repeat
            // cannot be evidence for the pattern. This is what stops five beats
            // of a held note from "supporting" a bar of five perfectly.
            if ((int) peaks.size() < kMinBarsForEvidence * beatsPerBar)
                continue;

            // GATES 1 and 2 are both in the initial value of `bestEvidence`:
            // enough downbeat evidence in absolute terms, AND decisively more
            // than the metre we already have.
            const auto evidence = downbeatEvidence (peaks, window, beatsPerBar);

            if (evidence > bestEvidence)
            {
                bestEvidence = evidence;
                bestExtended = beatsPerBar;
            }
        }

        if (bestExtended > 0)
        {
            auto decoded = decode (bestExtended);

            if (cancelled)
                return {};

            auto candidatePeaks = pickBeats (decoded.pointers, window, frames);

            // GATE 4, and it is the one the reverted widening failed: a longer
            // bar may re-read the METRE, never lose beats. On weak evidence a
            // wider bar can always buy a higher path probability by also
            // slowing down, and a tracker that drops beats to find a metre is
            // worse than one that cannot find the metre.
            if (candidatePeaks.size() >= peaks.size())
            {
                best = std::move (decoded);
                peaks = std::move (candidatePeaks);
            }
        }
    }

    result.beatsPerBar = best.beatsPerBar;

    for (const auto peak : peaks)
    {
        result.beats.push_back ((double) (peak + first) / kFps);
        result.beatNumbers.push_back (best.beatNumbers[(size_t) peak]);

        if (best.beatNumbers[(size_t) peak] == 1)
            result.downbeats.push_back ((double) (peak + first) / kFps);
    }

    return result;
}
}
