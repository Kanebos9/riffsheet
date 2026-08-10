#pragma once
#include <JuceHeader.h>
#include <vector>

/**
    Posteriorgrams in, note events out. The port of NeuralNote's `Notes.cpp`.

    ATTRIBUTION. This is adapted from NeuralNote (github.com/DamRsn/NeuralNote,
    commit f979e51, `Lib/Model/Notes.cpp` and `Notes.h`), which is Apache-2.0 and
    is itself a port of spotify/basic-pitch's `note_creation.py`. The algorithm
    and the parameter names are kept so that a reader can diff this against
    either upstream; the licence text ships at `third-party/neuralnote/LICENSE`
    and the paragraph is in `NOTICE.md`.

    WHAT WAS CHANGED, and why each change was made rather than avoided:

      1. PITCH BENDS ARE GONE - `_addPitchBends`, `dropOverlappingPitchBends`,
         the `bends` vector and the whole contour posteriorgram. Riffsheet's note
         contract has no bend field (webcore/src/bridge/types.ts DetectedNoteDTO)
         and the pipeline quantises to a grid, so every cycle spent on bends
         would be spent computing a number nothing can read. Deleted rather than
         computed-and-ignored, which is what engine-architecture.md §1.5 asks
         for.
      2. NO CACHED STATE. NeuralNote keeps `mRemainingEnergy` between calls so
         its sliders can re-run the post-processor without re-running the model.
         Riffsheet exposes no such sliders, and a per-instance cache in a plugin
         that may have eight instances is memory nobody asked for. `convert()` is
         a pure function of its arguments.
      3. THE FREQUENCY BOUNDS ARE DRIVEN BY THE INSTRUMENT HINT (see
         `boundsFor()` below). NeuralNote has the same two parameters wired to UI
         sliders; Riffsheet fills them from what the player already told it.
      4. Note and frequency indices are clamped into range. Upstream trusts its
         own UI to keep `maxFrequency` sane; a bad hint here would be an
         out-of-bounds read, and "the caller is careful" is not a bounds check.

    Everything else - the inferred-onset trick, the backwards frame scan, the
    energy walk, the melodia pass and its neighbour inhibition - is upstream's,
    step for step.
*/
namespace BasicPitchNotes
{
    /** frames x bins, row-major by frame. 88 bins for notes and onsets. */
    using Posteriorgram = std::vector<std::vector<float>>;

    /** The names are NeuralNote's; the VALUES are spotify/basic-pitch's, and the
        two disagree.

        `basic_pitch.inference.predict()` ships `onset_threshold=0.5,
        frame_threshold=0.3, minimum_note_length=127.70 ms` (inference.py:417-419;
        the millisecond figure becomes 11 frames at inference.py:452). NeuralNote
        has those first two the other way round, 0.3 and 0.5, because they are
        wired to its own two sliders and it chose its own resting position.
        Riffsheet takes upstream's, because upstream's is what the on-this-Mac
        audition that these bounds come from was measured with.

        Measured here, on `aug7.wav` (29 s of real electric bass), so that a
        future tuning pass starts from numbers rather than from taste:

            thresholds        no bound      150 Hz bound
            0.5 / 0.3 (ships)  147 notes     118 notes, MIDI 28-46
            0.3 / 0.5          103 notes     100 notes, MIDI 28-46

        Both sets were checked against a Python run of upstream's own
        note_creation.py over the same posteriorgrams and agreed exactly.

        None of these is surfaced in the UI in this release; they are here so the
        next person finds them where they expect to. */
    struct Params
    {
        float onsetThreshold      = 0.5f;   // basic_pitch predict(onset_threshold)
        float frameThreshold      = 0.3f;   // basic_pitch predict(frame_threshold)
        int   minNoteLengthFrames = 11;     // basic_pitch predict(minimum_note_length=127.70 ms)
        bool  inferOnsets         = true;   // note_creation infer_onsets
        bool  melodiaTrick        = true;   // note_creation melodia_trick
        int   energyThreshold     = 11;     // note_creation energy_tol
        float maxFrequencyHz      = -1.0f;  // -1 = the model's own range (MIDI 21..108)
        float minFrequencyHz      = -1.0f;  // -1 = the model's own range
    };

    struct Event
    {
        double startTime = 0.0;   // seconds
        double endTime   = 0.0;   // seconds
        int    startFrame = 0;
        int    endFrame   = 0;
        int    pitch      = 0;    // MIDI note number
        double amplitude  = 0.0;  // mean frame probability over the note: the confidence
    };

    /** The port. `notes` and `onsets` must have the same shape. */
    std::vector<Event> convert (const Posteriorgram& notes,
                                const Posteriorgram& onsets,
                                const Params& params);

    //== the instrument hint ==================================================

    /** Frequency bounds for a transcribe() `instruments` hint.

        THE BASS BOUND IS A MEASUREMENT, NOT A GUESS. On this Mac, on a real
        electric-bass clip, clamping Basic Pitch's post-processing to a maximum
        of 150 Hz took the note count from 63 to 34 with NO loss of real notes -
        every note the unclamped run found in the played range survived, and the
        29 that vanished were octave ghosts and harmonic doubles above the
        instrument. 400 Hz was also tried and changed nothing at all, because the
        spurious notes sit between the fundamental range and there: 150 Hz is
        where the cut has to be to do any work. MIDI 50 (D3, 146.83 Hz) is the
        highest note that survives the clamp, which is comfortably above the
        highest note the audition clip actually contains (MIDI 46).

        Anything that is not a bass - including the generic "whatever it hears"
        case that the staff view sends, and the empty hint webcore sends today -
        gets the model's own full range. Guessing a ceiling for an unknown
        instrument would silently delete real notes, which is the failure this
        table exists to avoid, not to cause.

        The names are MuScriptor's 35-instrument vocabulary (shell/BRIDGE.md),
        because that is the vocabulary `transcribe({instruments})` already
        speaks; the bare "bass" spelling is accepted too so a caller using
        AppSettings.instrument is not silently ignored. */
    Params boundsFor (const juce::StringArray& instruments, Params base = {});

    /** Exposed for the unit test and for BUILDING.md: the hint names this build
        recognises as bass. */
    juce::StringArray bassInstrumentNames();
}
