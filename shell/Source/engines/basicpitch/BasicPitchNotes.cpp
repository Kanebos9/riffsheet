#include "BasicPitchNotes.h"
#include "BasicPitchFrontend.h"

#include <algorithm>
#include <cmath>

namespace BasicPitchNotes
{
    namespace
    {
        constexpr int kMidiOffset  = BasicPitchFrontend::kMidiOffset;   // 21
        constexpr int kNoteBins    = BasicPitchFrontend::kNoteBins;     // 88
        constexpr int kMaxNoteIdx  = kNoteBins - 1;                     // 87

        /** NeuralNote NoteUtils::hzToMidi. */
        int hzToMidi (float hz) noexcept
        {
            return (int) std::lround (12.0f * std::log2 (hz / 440.0f) + 69.0f);
        }

        /*  _inferredOnsets, from NeuralNote Notes.h.

            Onsets the network missed are recovered from positive jumps in the
            note posteriorgram, rescaled onto the onset posteriorgram's range and
            maxed against it. The two-offset loop and the "minimum across
            offsets" are upstream's, including the quirk that the minimum is
            taken over signed diffs before clamping - the comment upstream leaves
            on that is preserved because it is a description of basic-pitch's
            behaviour, not of a bug we could fix here without diverging. */
        Posteriorgram inferredOnsets (const Posteriorgram& onsetsPg,
                                      const Posteriorgram& notesPg,
                                      int numDiffs = 2)
        {
            const auto frameCount = notesPg.size();
            const auto noteCount  = notesPg.empty() ? size_t (0) : notesPg[0].size();

            Posteriorgram notesDiff (frameCount, std::vector<float> (noteCount, 1.0f));

            float maxMinNotesDiff = 0.0f;
            float maxOnset = 0.0f;

            for (int n = 0; n < numDiffs; ++n)
            {
                const auto offset = n + 1;

                for (size_t i = 0; i < frameCount; ++i)
                {
                    const auto behind = (int) i - offset;

                    for (size_t j = 0; j < noteCount; ++j)
                    {
                        auto diff = notesPg[i][j] - (behind >= 0 ? notesPg[(size_t) behind][j] : 0.0f);
                        auto& minimum = notesDiff[i][j];

                        if (diff < minimum)
                        {
                            diff = diff < 0.0f ? 0.0f : diff;
                            minimum = ((int) i >= numDiffs) ? diff : 0.0f;
                        }

                        if (offset == numDiffs)
                        {
                            maxOnset = juce::jmax (maxOnset, onsetsPg[i][j]);
                            maxMinNotesDiff = juce::jmax (maxMinNotesDiff, minimum);
                        }
                    }
                }
            }

            // A silent clip makes every diff zero; upstream would divide by zero
            // here and hand NaNs to the peak picker, which then accepts every
            // frame. Answering "no inferred onsets" is the honest result.
            if (maxMinNotesDiff <= 0.0f)
                return onsetsPg;

            for (size_t i = 0; i < frameCount; ++i)
            {
                for (size_t j = 0; j < noteCount; ++j)
                {
                    auto& inferred = notesDiff[i][j];
                    inferred = maxOnset * inferred / maxMinNotesDiff;
                    inferred = juce::jmax (inferred, onsetsPg[i][j]);
                }
            }

            return notesDiff;
        }
    }

    //==========================================================================
    juce::StringArray bassInstrumentNames()
    {
        // MuScriptor's vocabulary (shell/BRIDGE.md "Valid instruments values"),
        // plus the bare spelling AppSettings.instrument uses.
        return { "electric_bass", "acoustic_bass", "contrabass", "bass" };
    }

    Params boundsFor (const juce::StringArray& instruments, Params base)
    {
        /*  THE TABLE. One row per instrument family that has a measured bound;
            everything absent from it keeps the model's full range on purpose.

            | hint                                     | max Hz | source              |
            |------------------------------------------|--------|---------------------|
            | electric_bass / acoustic_bass /          |   150  | audition, this Mac  |
            | contrabass / bass                        |        | 63 -> 34 notes,     |
            |                                          |        | zero recall loss    |
            | anything else, including "" and 'staff'  |  none  | model default       |
        */
        constexpr float kBassMaxFrequencyHz = 150.0f;

        const auto bassNames = bassInstrumentNames();

        for (const auto& hint : instruments)
        {
            const auto name = hint.trim().toLowerCase();

            if (bassNames.contains (name))
            {
                base.maxFrequencyHz = kBassMaxFrequencyHz;
                return base;
            }
        }

        return base;
    }

    //==========================================================================
    std::vector<Event> convert (const Posteriorgram& notesPg,
                                const Posteriorgram& onsetsPg,
                                const Params& params)
    {
        std::vector<Event> events;

        const auto frameCount = (int) notesPg.size();

        if (frameCount == 0 || notesPg[0].empty())
            return events;

        const auto noteCount = (int) notesPg[0].size();

        if ((int) onsetsPg.size() != frameCount || (int) onsetsPg[0].size() != noteCount)
        {
            jassertfalse;   // the two stacks came out of one model run; they cannot disagree
            return events;
        }

        events.reserve (1024);

        /*  THE FREQUENCY BOUND IS APPLIED FIRST, BY ZEROING COLUMNS - which is
            spotify/basic-pitch's `constrain_frequency()` (note_creation.py:306),
            NOT NeuralNote's version.

            NeuralNote instead narrows the loop bounds of its first pass only, so
            its melodia pass can still put notes back above the ceiling. The 150
            Hz number in boundsFor() was measured against upstream's semantics
            (`predict(..., maximum_frequency=150)`), and a bound that the second
            pass ignores is not the bound that was measured. Upstream also treats
            the index as an EXCLUSIVE upper limit, so the highest surviving note
            for 150 Hz is MIDI 49 rather than 50; that is one semitone, and it is
            upstream's semitone. */
        auto notesWork = notesPg;
        auto onsetsWork = onsetsPg;

        const auto zeroColumnsFrom = [&] (int firstBin)
        {
            for (auto& row : notesWork)
                std::fill (row.begin() + firstBin, row.end(), 0.0f);

            for (auto& row : onsetsWork)
                std::fill (row.begin() + firstBin, row.end(), 0.0f);
        };

        const auto zeroColumnsBefore = [&] (int endBin)
        {
            for (auto& row : notesWork)
                std::fill (row.begin(), row.begin() + endBin, 0.0f);

            for (auto& row : onsetsWork)
                std::fill (row.begin(), row.begin() + endBin, 0.0f);
        };

        if (params.maxFrequencyHz > 0.0f)
            zeroColumnsFrom (juce::jlimit (0, noteCount, hzToMidi (params.maxFrequencyHz) - kMidiOffset));

        if (params.minFrequencyHz > 0.0f)
            zeroColumnsBefore (juce::jlimit (0, noteCount, hzToMidi (params.minFrequencyHz) - kMidiOffset));

        Posteriorgram inferred;

        if (params.inferOnsets)
            inferred = inferredOnsets (onsetsWork, notesWork);

        const Posteriorgram& onsets = params.inferOnsets ? inferred : onsetsWork;

        // The working copy the two passes consume as they claim frames.
        auto remainingEnergy = notesWork;

        const auto frameThreshold = params.frameThreshold;

        // Every bin is walked; the ones outside the bound are already zero, so
        // they can never clear onsetThreshold or frameThreshold.
        const auto maxNoteIdx = noteCount - 1;
        const auto minNoteIdx = 0;

        // Stop one frame early: upstream's note_creation.py does the same, to
        // avoid an edge case at the very last frame.
        const int lastFrame = frameCount - 1;

        /*  PASS 1: thresholded, peak-picked onsets, scanned backwards in time.

            The peak test is scipy.signal.argrelmax's, which is what upstream
            uses: STRICTLY greater than both neighbours, and the first and last
            frames are never peaks because argrelmax's default mode='clip'
            compares them against themselves. NeuralNote's port relaxes both -
            it accepts ties, and it makes frame 0 its own left neighbour so a
            take that starts loud always gets a note at time zero. That is one
            spurious note per take, and it is exactly the kind of difference a
            golden captured from upstream catches and a smoke test does not. */
        for (int frameIdx = lastFrame - 1; frameIdx >= 1; --frameIdx)
        {
            for (int noteIdx = maxNoteIdx; noteIdx >= minNoteIdx; --noteIdx)
            {
                const auto onset = onsets[(size_t) frameIdx][(size_t) noteIdx];
                const auto previous = onsets[(size_t) frameIdx - 1][(size_t) noteIdx];
                const auto next = onsets[(size_t) frameIdx + 1][(size_t) noteIdx];

                if (onset < params.onsetThreshold || onset <= previous || onset <= next)
                    continue;

                // Walk forward while there is energy at this pitch.
                int i = frameIdx + 1;
                int k = 0;

                while (i < lastFrame && k < params.energyThreshold)
                {
                    if (remainingEnergy[(size_t) i][(size_t) noteIdx] < frameThreshold)
                        ++k;
                    else
                        k = 0;

                    ++i;
                }

                i -= k;   // back to the last frame that was above threshold

                if (i - frameIdx <= params.minNoteLengthFrames)
                    continue;

                // The confidence is the mean of the ORIGINAL frame probabilities
                // over the note, which is spotify/basic-pitch's
                // `np.mean(frames[start:i, freq_idx])`. NeuralNote reads the
                // working copy instead, so a note whose neighbour was claimed
                // first reports a confidence diluted by zeros that have nothing
                // to do with it. Upstream's is the number that means something.
                double amplitude = 0.0;

                for (int f = frameIdx; f < i; ++f)
                {
                    amplitude += notesWork[(size_t) f][(size_t) noteIdx];
                    remainingEnergy[(size_t) f][(size_t) noteIdx] = 0.0f;

                    // Claim the neighbours too, so one note is not also reported
                    // a semitone up and a semitone down.
                    if (noteIdx < kMaxNoteIdx && noteIdx + 1 < noteCount)
                        remainingEnergy[(size_t) f][(size_t) noteIdx + 1] = 0.0f;

                    if (noteIdx > 0)
                        remainingEnergy[(size_t) f][(size_t) noteIdx - 1] = 0.0f;
                }

                amplitude /= (double) (i - frameIdx);

                events.push_back ({ BasicPitchFrontend::frameToSeconds (frameIdx),
                                    BasicPitchFrontend::frameToSeconds (i),
                                    frameIdx, i,
                                    noteIdx + kMidiOffset,
                                    amplitude });
            }
        }

        //== pass 2: the melodia trick - notes with energy but no onset
        if (params.melodiaTrick)
        {
            struct Cell { float value; int frameIdx; int noteIdx; };

            std::vector<Cell> byEnergy;
            byEnergy.reserve ((size_t) frameCount * (size_t) noteCount);

            for (int frameIdx = 0; frameIdx < frameCount; ++frameIdx)
                for (int noteIdx = 0; noteIdx < noteCount; ++noteIdx)
                    byEnergy.push_back ({ remainingEnergy[(size_t) frameIdx][(size_t) noteIdx], frameIdx, noteIdx });

            std::sort (byEnergy.begin(), byEnergy.end(),
                       [] (const Cell& a, const Cell& b) { return a.value > b.value; });

            const auto inhibit = [frameThreshold, noteCount] (Posteriorgram& pg, int frame, int note, int k)
            {
                if (pg[(size_t) frame][(size_t) note] < frameThreshold)
                    ++k;
                else
                    k = 0;

                pg[(size_t) frame][(size_t) note] = 0.0f;

                if (note < kMaxNoteIdx && note + 1 < noteCount)
                    pg[(size_t) frame][(size_t) note + 1] = 0.0f;

                if (note > 0)
                    pg[(size_t) frame][(size_t) note - 1] = 0.0f;

                return k;
            };

            for (const auto& cell : byEnergy)
            {
                // The snapshot in `byEnergy` is the pre-pass value; the live cell
                // may already have been claimed by a note found since.
                auto& energy = remainingEnergy[(size_t) cell.frameIdx][(size_t) cell.noteIdx];

                if (energy == 0.0f)
                    continue;

                if (energy <= frameThreshold)
                    break;      // sorted descending: nothing after this can qualify

                energy = 0.0f;

                int i = cell.frameIdx + 1;
                int k = 0;

                while (i < lastFrame && k < params.energyThreshold)
                {
                    k = inhibit (remainingEnergy, i, cell.noteIdx, k);
                    ++i;
                }

                const auto iEnd = i - 1 - k;

                i = cell.frameIdx - 1;
                k = 0;

                while (i > 0 && k < params.energyThreshold)
                {
                    k = inhibit (remainingEnergy, i, cell.noteIdx, k);
                    --i;
                }

                const auto iStart = i + 1 + k;

                if (iEnd - iStart <= params.minNoteLengthFrames)
                    continue;

                double amplitude = 0.0;

                for (int f = iStart; f < iEnd; ++f)
                    amplitude += notesWork[(size_t) f][(size_t) cell.noteIdx];

                amplitude /= (double) (iEnd - iStart);

                events.push_back ({ BasicPitchFrontend::frameToSeconds (iStart),
                                    BasicPitchFrontend::frameToSeconds (iEnd),
                                    iStart, iEnd,
                                    cell.noteIdx + kMidiOffset,
                                    amplitude });
            }
        }

        std::sort (events.begin(), events.end(), [] (const Event& a, const Event& b)
        {
            return a.startFrame < b.startFrame
                     || (a.startFrame == b.startFrame && a.endFrame < b.endFrame);
        });

        return events;
    }
}
