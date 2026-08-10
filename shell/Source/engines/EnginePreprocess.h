#pragma once
#include <JuceHeader.h>

#include <functional>
#include <vector>

/**
    What happens to the audio between the user's file and an engine's ears.

    Two transformations, both real, both the user's to switch off:

      1. TUNING. If the recording is not at concert pitch, resample it so it is.
         A guitar a quarter-tone flat otherwise comes back a semitone wrong from
         every model in the catalog, because they were all trained on A440.
      2. LEVEL. Bring the peak to -12 dBFS, which is the level these models were
         trained near. Both directions: a hot take comes down as well.

    THREE RULES THAT ARE NOT NEGOTIABLE, and each of them is a bug somebody has
    already written somewhere else:

    - NOTHING IS EVER WRITTEN OVER THE USER'S FILE. PcmStore::ensureSourceFile()
      returns the user's own file when there is one (PcmStore.cpp:353-354), so
      "just normalise it in place" would edit a file they picked in a dialog.
      When work is needed this writes a NEW file in the temp directory and the
      caller deletes it when the job ends; when no work is needed it returns the
      caller's own juce::File and writes nothing at all.

    - PER ENGINE, NOT GLOBALLY. Each engine's manifest says whether it wants
      these (`needsGainNorm` / `needsTuningNorm`). Basic Pitch normalises
      internally and is measurably gain-invariant, so it is handed the file
      untouched; MuScriptor does neither and wants both.

    - CORRECTING PITCH BY RESAMPLING ALSO CHANGES TIME, and every time the
      engine reports afterwards is in the RESAMPLED timebase. `pitchRatio` is
      the map back and applyTimebase() is the only correct way to spend it.
      Twenty cents is 1.16% - two seconds of drift over a three-minute take,
      which reads as a beat grid that slowly falls apart rather than as a bug.

    THREADING. Everything here blocks: it decodes a whole file, runs an STFT
    over it and may write a WAV. Worker threads only - never the message thread,
    never the audio thread.
*/
namespace EnginePreprocess
{
    //== the numbers, in one place so the tests can assert them ===============

    /** The analysis rate for the tuning estimate. Everything musical this looks
        at is under 2 kHz, so half of CD rate is twice what is needed and it
        halves the number of FFTs. */
    inline constexpr double kAnalysisRate = 22050.0;

    inline constexpr int kFftSize = 4096;   // 5.4 Hz bins at kAnalysisRate
    inline constexpr int kHop     = 1024;

    /** Below 80 Hz the bins are too coarse to say anything about tuning; above
        2 kHz the partials of everything else drown the fundamentals. */
    inline constexpr double kMinPeakHz = 80.0;
    inline constexpr double kMaxPeakHz = 2000.0;

    /** A peak has to stand this far above the frame's median magnitude to be
        counted as a partial rather than as noise. */
    inline constexpr double kPeakOverMedian = 8.0;

    //-- when the estimate is allowed to be acted on ---------------------------
    // A confident-looking correction from an unconfident estimate is worse than
    // no correction, so all three of these have to hold.

    inline constexpr double kMinCents         = 8.0;    // below this, not worth the resample
    inline constexpr double kMinConcentration = 0.25;   // 0 = the peaks disagree, 1 = they agree
    inline constexpr int    kMinPeaks         = 200;    // too little evidence otherwise

    /** The estimator is circular over one semitone, so +50 and -50 cents are the
        same answer and it cannot tell which. An estimate this close to the wrap
        is reported and REFUSED rather than guessed. */
    inline constexpr double kAmbiguousCents = 49.0;

    //-- level ----------------------------------------------------------------

    inline constexpr double kTargetPeakDbfs = -12.0;
    inline constexpr double kSilenceDbfs    = -60.0;  // below this, amplifying only amplifies noise
    inline constexpr double kMaxBoostDb     = 30.0;
    inline constexpr double kGainDeadbandDb = 0.02;   // already there; do not rewrite the file for this

    /** Refuse to decode more than this into memory. Same spirit as PcmStore's
        1 GB decode ceiling: a preprocessing step must not be the thing that
        kills the host. */
    inline constexpr juce::int64 kMaxDecodeBytes = 512ll * 1024 * 1024;

    //== the tuning estimate ==================================================

    /** Circular mean of cents-off-A440, weighted by peak magnitude - the classic
        estimator, and the same one librosa's estimate_tuning() uses. See
        estimateTuning() in the .cpp for the seven steps.

        `cents` is only meaningful when `confident` is true. */
    struct TuningEstimate
    {
        double cents = 0.0;           // wrapped into [-50, +50)
        double concentration = 0.0;   // |sum| / sum|w|: how much the partials agree
        int    peaks = 0;             // how many partials were weighed
        bool   reliable = false;      // enough agreeing partials to believe the number at all
        bool   confident = false;     // reliable AND far enough off AND not at the wrap
        bool   ambiguous = false;     // right at the wrap: sharp and flat are the same answer
    };

    /** Mono, any rate. Cheap enough to run on every transcription: one 4096-point
        FFT per 1024 samples and nothing else. */
    TuningEstimate estimateTuning (const float* mono, juce::int64 numSamples, double sampleRate);

    //== the job ==============================================================

    struct Request
    {
        bool   wantGainNorm   = false;   // manifest AND the user's setting
        bool   wantTuningNorm = false;
        double targetPeakDbfs = kTargetPeakDbfs;

        /** Resample the engine's copy to this rate. 0 = leave the source rate
            alone, which is what the bridge passes: every engine in the catalog
            already resamples its own input, so doing it here as well would be a
            second, lossier pass for nothing. */
        double outputRate = 0.0;

        /** Names the temp file, so two engines in two windows never collide. */
        juce::String engineId;

        /** Drums have no tuning to correct, so skip the estimate entirely. */
        bool drumsOnly = false;
    };

    struct Result
    {
        /** THE CALLER'S OWN FILE when nothing had to change - compare it with
            operator== to find out, or read `wroteFile`. */
        juce::File file;

        /** True only when a new file was written. The caller owns that file and
            must delete it when the job ends. */
        bool wroteFile = false;

        /** Multiply every time the engine reports by this, and divide every
            tempo by it. 1.0 whenever no resampling happened. */
        double pitchRatio = 1.0;

        double cents = 0.0;           // what the estimate said, applied or not
        double concentration = 0.0;
        int    peaks = 0;
        double gainDb = 0.0;          // what was applied, 0 when nothing was
        double sourcePeakDbfs = 0.0;  // of the mono mix, before any gain

        /** One sentence for the user, never empty. "Corrected 14 cents flat to
            A440." is a fact they should be able to see; so is "The tuning
            estimate was not confident enough to act on." */
        juce::String note;

        /** "cancelled", or a decode failure. A FAILURE IS NOT FATAL: `file` is
            still the caller's own file and the job carries on with it, because
            losing a transcription over a preprocessing hiccup would be a worse
            bug than not preprocessing. */
        juce::String error;
    };

    /** Decodes `source`, decides what (if anything) has to change, and writes a
        mono 24-bit WAV to the temp directory when something does.

        Mono is not a shortcut: every engine in the catalog downmixes its input
        anyway, and "-12 dBFS peak" has to be measured on the signal the engine
        actually hears or the number means nothing.

        Returns instantly, having decoded nothing, when both flags are false and
        `outputRate` is 0 - which is the common case and the whole reason the
        result carries the caller's own file rather than a copy. */
    Result run (const juce::File& source,
                const Request& request,
                const std::function<bool()>& shouldCancel);

    /** THE INVERSE MAP, and the easiest thing in this design to forget.

        Rewrites, in place, every time in a transcribeResult-shaped var so it is
        in the ORIGINAL recording's timebase again:

            notes[].start, notes[].end, onsetDelay,
            beatGrid.firstDownbeat, beatGrid.onsetDelay, beatGrid.beats[],
            preciseBeats.beats[], preciseBeats.downbeats[]      x  pitchRatio
            beatGrid.bpm, preciseBeats.bpm                      /  pitchRatio

        A no-op when `pitchRatio` is 1.0, which is every job that was not
        tuning-corrected. */
    void applyTimebase (juce::var& result, double pitchRatio);
}
