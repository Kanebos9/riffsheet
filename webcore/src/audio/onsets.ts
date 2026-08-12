/**
 * Onset detection — "was something STRUCK here?", asked of the recording itself.
 *
 * WHY THIS FILE EXISTS. The owner noticed it before anyone wrote it down: *sometimes the
 * waveform jumps and it is obvious a note was struck, and the transcription does not show it.*
 * He is right, and the reason it works is worth stating plainly, because it is the whole
 * justification for the file:
 *
 *     "SOMETHING was struck here" is a far easier question than "an A1 was struck here."
 *
 * Onset detection is decades old and reliable where full transcription is not. It needs no
 * model, no training data and no octave decision. It cannot tell you the pitch, and it is not
 * asked to. MuScriptor's own exam (design notes §3.5) measured muted-note recall at 0.24 against
 * 0.58 unmuted, and returned literally zero notes on two clips — it demonstrably misses notes.
 * An independent detector using an entirely different method therefore adds real information:
 * when it disagrees with the model, the disagreement is evidence rather than noise.
 *
 * ===========================================================================================
 * THIS MODULE NEVER DELETES ANYTHING. IT REPORTS EVIDENCE.
 * ===========================================================================================
 * Design notes §4.8: the guards may drop only what they can PROVE is wrong, and may never invent.
 * This file holds to the same rule and one step further — it does not drop anything at all. It
 * returns times, strengths and a detection curve. Whether a note is added, removed or left
 * alone is a UI question with a human in it (plan notes §2.2: *offer* to remove as a batch, with
 * preview and undo, never automatically).
 *
 * There is a specific reason the asymmetry matters, and it is the one thing to understand
 * before wiring this to anything:
 *
 *  - AN ONSET WITH NO NOTE is decent evidence that a note was missed. Something in the audio
 *    genuinely rose in energy and changed spectrum, and the score is silent about it.
 *  - A NOTE WITH NO ONSET IS NOT EVIDENCE THAT THE NOTE IS FAKE. Hammer-ons, pull-offs, slides,
 *    legato and heavy palm-mutes all produce real notes with weak or absent attacks — see the
 *    measured misses in `selfTest()`, which are not small. `unsupportedNotes` means "no attack
 *    was found behind this", which is a prompt to LOOK, never a verdict.
 *
 * Anyone who turns `unsupportedNotes` into an automatic delete has re-introduced exactly the
 * bug §4.8 exists to prevent, and will silently eat a legato passage.
 *
 * ---------------------------------------------------------------------------------------
 * METHOD: spectral flux, in two bands, on two window lengths.
 * ---------------------------------------------------------------------------------------
 * Short-time FFT; bins grouped into log-spaced bands; half-wave-rectified increase in the LOG of
 * each band's magnitude, averaged; adaptive threshold from a local moving median; peak-picking
 * with a minimum spacing. Every part of that is textbook. The parts that are specific to a bass
 * app, and why:
 *
 * 1. LOG MAGNITUDE, not linear. This is the single biggest win on bass and it is not a
 *    refinement. A linear flux is dominated by whichever bins are loudest, and on a bass take
 *    that is a ringing low fundamental. A new note plucked while an open E still rings adds a
 *    few percent to the linear sum and is invisible; in log magnitude the same new partial is a
 *    large relative rise wherever it lands. `log(1 + LOG_LAMBDA * |X|)` — Klapuri's compression,
 *    with the +1 so that empty bands sit at zero instead of at minus infinity.
 *
 *    THE LOG GOES ON BAND SUMS, NEVER ON SINGLE BINS, and getting that wrong is not a small
 *    error — the first draft compressed per bin and found 3 attacks in a take of 120. The full
 *    explanation is at `planBands`, and it is the first thing to re-read if this file ever stops
 *    working.
 *
 * 2. TWO WINDOW LENGTHS, because the requirement genuinely conflicts. A bass fundamental is
 *    30-80 Hz. Resolving 41 Hz needs a window tens of milliseconds long — at the chosen
 *    `LONG_WINDOW_SEC` of 93 ms the bin spacing is about 11 Hz, so a low E's fundamental lands
 *    in a bin of its own rather than smearing into DC. But a 93 ms window locates an attack to
 *    about 93 ms, which is useless — two sixteenths at 120 bpm are 125 ms apart. So:
 *      - a LONG window (93 ms) reads the LOW band, 20-300 Hz: *did low-frequency energy arrive?*
 *      - a SHORT window (23 ms) reads everything ABOVE 250 Hz: *when exactly did it arrive?*
 *    Both are computed on the same frame grid at the same 5.8 ms hop and summed, so the long
 *    window contributes evidence and the short window contributes timing. The measured timing
 *    error says whether that worked: the median is 3.8 ms, a small fraction of the long window,
 *    which it could not be if the long window were setting the timing.
 *
 *    Both halves earn their place, measured over the whole of `selfTest()` (24 cases, 188 struck
 *    notes). Weighting is `BAND_WEIGHT_LOW` against `BAND_WEIGHT_BROAD`:
 *
 *        low / broad     missed   false      the column that decides it
 *        0.0 / 1.0         16      141       61 phantoms on the held-note cases alone
 *        0.5 / 0.5          9        7       <- chosen
 *        1.0 / 0.0         50       32       27 of 46 on the dense line; timing median 9.4 ms
 *
 *    And the long window's LENGTH is not a free parameter either. At an 11 kHz work rate it can
 *    only be a power of two, so the choice is 512, 1024 or 2048 samples:
 *
 *        512  (46 ms)      13 missed, 225 false  — too coarse in frequency to place a bass
 *                                                  fundamental; 140 of those are on held notes
 *        1024 (93 ms)       9 missed,   7 false  <- chosen
 *        2048 (186 ms)      5 missed,  84 false  — finds MORE real notes and smears each attack
 *                                                  so far that one becomes three
 *
 * 3. THE FRAME GRID IS OFFSET BY HALF A HOP, ON PURPOSE. Flux at frame m is a DIFFERENCE
 *    between two windows, so it describes the instant BETWEEN their centres, not either centre.
 *    Frame m's window is therefore centred at `(m + 0.5) * hop`, which puts the difference
 *    flux[m] exactly at `m * hop`. Skip this and every onset comes back half a hop late, which
 *    is small, systematic, and the sort of thing that gets rediscovered as "the waveform and the
 *    sheet disagree by a hair". With a Hann window the flux of a step-like attack peaks when the
 *    attack crosses the window centre, so beyond this half-hop there is no further correction to
 *    make and none is applied — the residual bias is measured in `selfTest()` and reported, not
 *    tuned away.
 *
 * 4. NORMALISED WITHIN THE TAKE, twice over, because a fixed global threshold across different
 *    recordings is simply wrong — a quiet fingerstyle take and a slapped one differ by 30 dB.
 *      - The signal is peak-normalised before analysis (log compression is not scale-invariant,
 *        so the input scale has to be pinned to something).
 *      - Each band's flux is divided by ITS OWN mean over the whole take, so the two bands
 *        contribute comparably whatever the instrument's spectral balance is, and so the
 *        threshold constants below are in units of "times this take's average flux".
 *      - `strength` is relative to the strongest attack in the same take. It is NOT comparable
 *        between takes and the field comment says so.
 *
 * 5. DECIMATED TO ~11 kHz FIRST. Everything above is about content below about 5 kHz: a bass
 *    fundamental, its low partials, and the broadband thump of the attack. Running the STFT at
 *    44.1 kHz costs four times the arithmetic for bins that mostly carry room hiss and cymbal
 *    bleed. This is the same trade `pitch.ts` makes for the same reason, with the same caveat
 *    written down: a slap or a pick click has real content above 5.5 kHz and we are discarding
 *    it. The cost is honest and small — it is one more reason the SOFT-attack cases below are
 *    the weak ones. If a slap-heavy take ever detects badly, raise `TARGET_WORK_RATE_HZ` and
 *    re-run `selfTest()` before believing it helped.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT IT COSTS, MEASURED (node 22, M-series, six runs)
 * ---------------------------------------------------------------------------------------
 * A 30-second take at 44.1 kHz: **89 ms warm** (88.8 to 91.1 ms over five warm runs; the first,
 * cold, run was 97 ms). That is 5168 frames of two-window STFT plus the anti-alias decimation,
 * and it works out at about 340x realtime.
 *
 * So a ten-minute take is roughly 1.8 s. That is not free and it is not hidden: run it ONCE per
 * take, off the render path, and paint something while it works — the same shape `ui/tuner.ts`
 * already uses. There is no incremental mode; the whole take is analysed in one pass, and the
 * within-take normalisation means a partial analysis would not give the same answer as the full
 * one. `selfTest()` itself takes about 2.5 s, which is why it is a probe rather than a hot path.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT IT MISSES. Read this before quoting a number at anybody.
 * ---------------------------------------------------------------------------------------
 * `selfTest()` is 24 cases and 188 struck notes. At the defaults in this file it finds 179 of
 * them and reports 7 attacks that were never played. Median absolute timing error 3.8 ms, worst
 * 18.5 ms, and the errors are one-sided: the median SIGNED error is -3.8 ms, i.e. it reads a
 * little under one hop EARLY. That is the long window's leading edge and it is left uncorrected
 * rather than subtracted off, because a constant calibrated against synthetic plucks is not a
 * correction, it is a fudge that would be wrong on the first real recording.
 *
 * Those totals hide the shape of it, and the shape is the point. On material with a real attack
 * it is close to perfect: 118 of 118 on a 30-second, four-notes-a-second line, every note of a
 * B0 sixteenth run at three sample rates, every note under a -10 dB noise floor, and the five
 * palm-muted notes it was expected to lose. What it loses is attacks that are not attacks:
 *
 *  - A FAST LEGATO RUN IS THE WORST CASE BY A LONG WAY: **3 of 10**. Ten notes a quarter of a
 *    second apart with no pick attack and decays that overlap — fast fingerstyle, a hammered
 *    run — never let the low band fall between notes, so there is nothing for a rise detector to
 *    rise from. Lowering `thresholdMultiplier` to 1.4 recovers 8 of the 10 and takes the rest of
 *    the corpus from 7 phantoms to 36, so it is not a threshold problem; it is the method.
 *  - HAMMER-ONS: **1 of 2** in the dedicated case. A new partial series IS flux even at constant
 *    loudness, so this was written expecting it to work. It does not, at 39% of the note it
 *    replaces.
 *  - SLIDES: the START of the slide is found; the glide itself then INVENTS an extra onset as
 *    partials cross band edges. Wrong in both directions at once.
 *  - TWO ATTACKS CLOSER THAN `minSpacingSec` (30 ms) are reported as one, by design.
 *  - DOUBLED ATTACKS, the main source of false positives left: one attack occasionally reported
 *    twice, 40-55 ms apart, because the long window's smear can carry two local maxima that far
 *    apart. 3 of 46 on the dense line, 1 of 8 on the walking line at two of three sample rates,
 *    1 of 5 on the muted run. It cannot be fixed by raising `minSpacingSec` without also losing
 *    the two-notes-40-ms case, which is a real thing a bass player does; they are the same
 *    distance apart and this method cannot tell them apart.
 *  - AND THE MOST IMPORTANT ONE, WHICH IT GETS RIGHT: a held note with no re-attack yields
 *    exactly one onset — flat, decaying and wobbling, and clean at every threshold multiplier
 *    from 1.4 to 4.0. That is the property the suspect-notes review lane (plan notes §2.2) depends
 *    on, since a real repeated note and a phantom repeated note are identical in the note list
 *    and differ only in whether there is an attack under each repetition.
 *
 * Note how closely the legato figure tracks MuScriptor's own muted-note recall of 0.24 (§3.5).
 * On that material BOTH engines are weak, so their agreement means much less than it looks, and
 * their disagreement means almost nothing at all.
 *
 * No claim in the paragraphs above came from anywhere but `selfTest()`. Do not add one that did.
 *
 * ---------------------------------------------------------------------------------------
 * HOW THE INTERFACE SHOULD USE THIS. Written here because the numbers above decide it.
 * ---------------------------------------------------------------------------------------
 * Run `detectOnsets` ONCE per take when the audio is decoded, alongside the existing peak
 * computation in `app.ts`, and keep the result next to `pcm` / `pcmRate`. It is ~90 ms for a
 * 30-second take; it is not a per-keystroke operation and it must not sit on the render path.
 * Re-run it only when the AUDIO changes — never when the score is edited, because the audio has
 * not moved and neither have the onsets.
 *
 * Then, in rough order of how much the evidence is worth:
 *
 * 1. DRAW THE ENVELOPE UNDER THE WAVEFORM, faint, with a tick at every onset. This costs nothing
 *    and it is the thing the owner actually described: he can SEE the attack. Once the ticks are
 *    on screen, a tick with no notehead above it is self-explanatory and needs no wording at all.
 *
 * 2. FOR `missedOnsets` — the strong half — mark the position on the waveform and on the sheet's
 *    time axis, and say plainly: *"An attack here that the transcription has no note for."* The
 *    action offered is ADD A NOTE, at that time, with the pitch left to the player or to
 *    `pitch.ts` run on that stretch. Do not guess the pitch silently; §4.9's principle applies —
 *    guessing wrong is worse than not guessing. Rank them by `strength` and put the strongest
 *    first: on the corpus here everything spurious sat under 0.05 and everything real over 0.27,
 *    so a list sorted by strength is a list with the real ones at the top.
 *
 * 3. FOR `unsupportedNotes` — the weak half — the wording matters and must not overclaim.
 *    *"No attack found under this note"*, not *"this note is not real"*. It belongs in the
 *    suspect-notes review lane (plan notes §2.2) as ONE column beside the raw model output and the
 *    as-played MIDI, never as a standalone verdict, and the batch-remove action must stay behind
 *    a preview and an undo. The measured reason is at the top of this file: a fast legato run
 *    scores 3 of 10 here, so on that material "no attack found" is a statement about this
 *    detector, not about the note.
 *
 * 4. THE ONE PLACE THE EVIDENCE IS NEARLY CONCLUSIVE is the repeat-loop suspect (§3.5 failure
 *    mode 1, and `suspects.repeatLoops` in `pipeline/src/guards.ts`). For a run of N identical
 *    pitches at machine-regular spacing, count how many have an onset under them. A real pedal
 *    figure has an attack under essentially every repetition; the 871-note phantom run has one
 *    attack and then nothing for five minutes. That is a difference of a whole order of
 *    magnitude, not a judgement call, and `selfTest()`'s three held-note cases are clean at every
 *    threshold setting measured. Report it in plain words, exactly as plan notes §2.2 asks:
 *    *"3 of 12 of these notes have a real attack behind them."* Then offer, and never act.
 *
 * A DETAIL THAT WILL BITE: everything here is on the RECORDING's clock. The sheet is on the
 * score's clock. Convert with `scoreOriginSec()` (design notes §4.13) before comparing, or the
 * whole analysis will be wrong by the length of the anacrusis and look plausible while it is.
 *
 * DELIBERATELY NOT DONE. This does not reuse `pitch.ts`, and must not: plan notes §2.2 records
 * that the tuner's detector has documented cases where two real notes produce a confident third
 * phantom pitch, and a second opinion that shares a failure mode with the first is not a second
 * opinion. Onset detection needs no pitch at all, which is the point.
 *
 * Pure and offline: no DOM, no fetch, no dependencies, no `Math.random`, no clock. Same input,
 * same output, every time — including in a plugin web view, which is where it has to run.
 */

/** A moment where the recording says something was struck. */
export interface Onset {
  /**
   * Seconds on the RECORDING's clock — the same clock as the waveform, the transport and
   * `app.ts`'s `pcm`. Design notes §4.13: the score's clock is a different one, offset by
   * `scoreOriginSec()`. Convert before comparing with anything engraved.
   */
  timeSec: number;
  /**
   * 0..1, how strong the attack is relative to the others in THIS take. The strongest onset in
   * a take is always 1. It is NOT comparable between takes and it is not decibels — it is the
   * peak's excess over its own local threshold, scaled by the largest such excess found.
   */
  strength: number;
}

export interface OnsetResult {
  onsets: Onset[];
  /**
   * The detection function itself, scaled so its maximum is 1, for drawing under the waveform.
   * `envelope[i]` is the value at exactly `i * envelopeHopSec` seconds (see the half-hop note in
   * the header — the offset is already in it). `envelope[0]` is always 0: the first frame has
   * nothing to be a difference from.
   */
  envelope: Float32Array;
  envelopeHopSec: number;
  /** Every number that shaped the result, so a bug report can say what it ran with. */
  params: Record<string, number>;
}

export interface OnsetOptions {
  /**
   * How far above the local moving median a peak must sit. Higher means fewer, surer onsets.
   * The dominant knob; see the sensitivity table in `selfTest()`'s comment before moving it.
   */
  thresholdMultiplier?: number;
  /**
   * An absolute floor under the threshold, in units of the take's mean flux (which is 1 by
   * construction). Without it, a silent passage has a near-zero moving median and any numerical
   * wobble clears `multiplier * 0`.
   */
  thresholdFloor?: number;
  /** Two attacks closer together than this are reported as one. */
  minSpacingSec?: number;
  /** Drop onsets weaker than this after normalisation. 0 reports everything above threshold. */
  minStrength?: number;
  /** Width of the moving-median window used for the adaptive threshold. */
  medianWindowSec?: number;
  /**
   * How far through the spectral pass we are, 0..1. THE ONLY REASON THIS EXISTS is that the
   * detector runs off the main thread now (`audio/engineWorker.ts`), and a job that takes
   * seconds and says nothing is indistinguishable from a job that has hung.
   *
   * Called from the frame loop and nowhere else, at most a few dozen times per pass, so it costs
   * nothing measurable and cannot change what the detector reports. Every existing caller omits
   * it and gets exactly the function it always had.
   */
  onProgress?: (fraction: number) => void;
}

/** The minimal shape `matchOnsets` needs from a note. Extra fields are preserved. */
export interface NoteRef {
  id?: string;
  /** Seconds on the RECORDING's clock. See the note on `Onset.timeSec`. */
  startSec: number;
  midi: number;
}

/**
 * Detected attacks lined up against the notes the model reported.
 *
 * Deliberately NOT a one-to-one assignment. One attack can support several notes (a chord, a
 * double-stop) and several attacks can fall inside one note's tolerance (a fast trill). Forcing
 * a bijection would manufacture "unsupported" notes out of chords, which is precisely the kind
 * of invented evidence §4.8 forbids.
 */
export interface OnsetMatch<T extends NoteRef = NoteRef> {
  /**
   * Onsets with no note within the tolerance — the app probably MISSED a note here. This is the
   * strong half of the result and the one worth putting in front of the player.
   */
  missedOnsets: Onset[];
  /**
   * Notes with no onset behind them. Suspicious, NOT proven wrong: legato, hammer-ons, slides
   * and mutes all live here legitimately, and so does the second half of a tied note. Never
   * delete on this alone.
   */
  unsupportedNotes: T[];
  /** Notes that line up with a real attack. */
  confirmed: number;
  toleranceSec: number;
}

// --- constants, all of them measured or reasoned, none of them arbitrary -----

/**
 * The STFT runs near this rate. 11 kHz keeps everything to 5.5 kHz, which is all of a bass
 * fundamental, its useful partials and the body of the attack transient. See header point 5.
 */
const TARGET_WORK_RATE_HZ = 11025;
/** 93 ms at the work rate: ~11 Hz bins, enough to separate a low B0 (30.87 Hz) from DC. */
const LONG_WINDOW_SEC = 0.093;
/** 23 ms: too coarse to resolve a bass fundamental, fast enough to time the attack. */
const SHORT_WINDOW_SEC = 0.023;
/** One detection-function sample every 5.8 ms. Sets the resolution of everything downstream. */
const HOP_SEC = 0.0058;
/**
 * The low band, read on the long window. From 20 Hz because a 5-string's B0 is 30.87 Hz and the
 * Hann skirt around it reaches down; up to 300 Hz to catch the second and third partials of the
 * bottom octave, which is where a palm-muted note keeps what energy it has.
 * DC and the first bin are always excluded — that is rumble and offset drift, not music.
 */
const LOW_BAND_LO_HZ = 20;
const LOW_BAND_HI_HZ = 300;
/** The broad band, read on the short window: everything above the long window's territory. */
const BROAD_BAND_LO_HZ = 250;
/**
 * How finely each band is divided. Log-spaced, so the resolution is where a bass needs it: at
 * the bottom a quarter-octave is a few Hz and each band is a single FFT bin, at the top it is
 * hundreds of Hz and each band averages twenty bins' worth of noise down. See `planBands` for
 * what happened without this.
 */
const BANDS_PER_OCTAVE = 4;
/**
 * Log compression, applied to BAND sums. Large enough that a band 60 dB under the take's peak
 * still contributes — which is the point: a quiet note struck under a loud ringing one is a
 * large RELATIVE rise in some band and a negligible absolute one.
 */
const LOG_LAMBDA = 1000;
/**
 * Nothing below this band magnitude is believed: -60 dBFS, against a peak-normalised take.
 *
 * WHY THIS EXISTS, because it looks like a needless clamp. Log compression is extremely generous
 * to very small numbers BY DESIGN — that is how a quiet note struck under a loud one becomes
 * visible — and it cannot tell a quiet note from the Hann window's LEAKAGE out of a loud one
 * three hundred Hz away. On a dark, harmonic-poor take (a rolled-off DI, and in the limit a pure
 * tone) the upper bands hold nothing but that leakage; its level wobbles as the tone's phase
 * drifts against the window, and the within-take normalisation then scales the wobble up until it
 * IS the detection function. Measured, at 48 and 96 kHz: a pure 41 Hz tone plucked eight times
 * produced 48 onsets. With the clamp it produces eight.
 *
 * WHERE THE VALUE COMES FROM, because it is a real trade and not a safety margin. Too low and it
 * does nothing; too high and it starts clipping quiet REAL notes. Measured over `selfTest()`:
 *
 *     floor    missed   false   median timing   the soft note
 *     1e-5       10       7        5.3 ms       found     (and the pure tone still gives 47)
 *     1e-3        9       7        3.8 ms       found     <- chosen
 *     2e-3       10       5        2.8 ms       LOST
 *     4e-3        9       2        1.8 ms       LOST
 *
 * The higher floors look better on every aggregate and are wrong: what they are buying is the
 * quietest real note in the take, which is exactly the note this module exists to find. 1e-3 is
 * the last value that keeps it. The timing improves as a side effect — clamping the leakage stops
 * it contributing a smear of flux ahead of each attack — and that is a bonus, not the reason.
 */
const MAGNITUDE_FLOOR = 1e-3;
/**
 * How the two bands are mixed. Even, and not by default — measured. Neither band alone is close:
 * broad-only reports 141 phantoms over the self-test (61 of them on held notes with no
 * re-attack, which is the one thing this must never do), and low-only misses 50 of 188 real
 * attacks and doubles the timing error. The full table is in the header under point 2.
 */
const BAND_WEIGHT_LOW = 0.5;
const BAND_WEIGHT_BROAD = 0.5;
/**
 * A band group whose mean per-band log-flux over the whole take is under this holds nothing — a
 * DI'd bass with no top end, a high-passed take, a channel that is silent above 250 Hz. Its
 * weight goes to the other group rather than being normalised up into pure amplified noise,
 * which is exactly what dividing by a near-zero mean would do.
 */
const BAND_SILENT_FLOOR = 1e-4;
/**
 * Defaults for `OnsetOptions`. The two thresholds carry a measured sensitivity table in the
 * comment on `selfTest()`; do not move either one without re-running it and reading BOTH columns.
 */
const THRESHOLD_MULTIPLIER = 2.2;
const THRESHOLD_FLOOR = 0.45;
/**
 * 300 ms of moving median. This started at 100 ms, which looked fine on every short test case and
 * cost real notes on a long one: an attack's hump on the long window is nearly 100 ms wide, so a
 * 100 ms median window is dominated by the attack it is supposed to be the background FOR, and
 * the threshold rises exactly where the note is. On a 30-second line at four notes a second that
 * was the difference between 114 and 118 of 118. The cases that catch this have to be seconds
 * long, which is why `dense-line-12s` exists.
 */
const MEDIAN_WINDOW_SEC = 0.3;
/** 30 ms, matching `MIN_NOTE_SEC` in `pipeline/src/guards.ts` — one cycle of a low E is 24 ms. */
const MIN_SPACING_SEC = 0.03;
/**
 * Drop onsets under 5% of the take's strongest attack.
 *
 * Not a fudge and not free: it is the line under which every false positive in the self-test
 * measured (all at or below 0.046) while every real attack in the same takes measured at or
 * above 0.27. Beating between two ringing notes, the spectral splatter of an abrupt note-off,
 * and the ripple after a transient all land in that gap. The price is that a note played very
 * much quieter than everything else in the same take is dropped with them — which is why
 * `one-soft-note-among-loud` exists, and why 0.12 and above is measurably too high.
 */
const MIN_STRENGTH = 0.05;
/** A peak must beat its neighbours within this many frames (±2 frames = ±11.6 ms). */
const LOCAL_MAX_HALF_FRAMES = 2;
/** Below this peak sample value the buffer is silence and normalising it would amplify dither. */
const SILENCE_PEAK = 1e-5;
/** Default window for `matchOnsets`; see the comment there for why it is this wide. */
const DEFAULT_MATCH_TOLERANCE_SEC = 0.05;

/**
 * Find the attacks in a take.
 *
 * One pass over the whole recording. Deterministic. Returns evidence and deletes nothing.
 */
export function detectOnsets(
  pcm: Float32Array,
  sampleRate: number,
  opts: OnsetOptions = {}
): OnsetResult {
  const thresholdMultiplier = opts.thresholdMultiplier ?? THRESHOLD_MULTIPLIER;
  const thresholdFloor = opts.thresholdFloor ?? THRESHOLD_FLOOR;
  const minSpacingSec = opts.minSpacingSec ?? MIN_SPACING_SEC;
  const minStrength = opts.minStrength ?? MIN_STRENGTH;
  const medianWindowSec = opts.medianWindowSec ?? MEDIAN_WINDOW_SEC;

  const baseParams: Record<string, number> = {
    sampleRate,
    samples: pcm ? pcm.length : 0,
    thresholdMultiplier,
    thresholdFloor,
    minSpacingSec,
    minStrength,
    medianWindowSec
  };
  const nothing = (): OnsetResult => ({
    onsets: [],
    envelope: new Float32Array(0),
    envelopeHopSec: 0,
    params: { ...baseParams, frames: 0, onsetCount: 0 }
  });

  if (!pcm || pcm.length === 0 || !(sampleRate > 0)) return nothing();

  const factor = decimationFactor(sampleRate);
  const workRate = sampleRate / factor;
  const work = toWorkSignal(pcm, factor);
  // Silence, or a buffer so short there is nothing to difference against.
  if (!work) return nothing();

  const longN = nearestPowerOfTwo(workRate * LONG_WINDOW_SEC);
  const shortN = nearestPowerOfTwo(workRate * SHORT_WINDOW_SEC);
  const hop = Math.max(1, nearestPowerOfTwo(workRate * HOP_SEC));
  const hopSec = hop / workRate;
  const frames = Math.floor(work.length / hop) + 1;
  if (frames < 3) return nothing();

  const longFft = new RealFft(longN);
  const shortFft = new RealFft(shortN);

  // Band edges. `max(2, ...)` on the low edge drops DC and bin 1 unconditionally — that is
  // rumble and offset drift, not music.
  const longBinHz = workRate / longN;
  const shortBinHz = workRate / shortN;
  const lowPlan = planBands(
    LOW_BAND_LO_HZ,
    LOW_BAND_HI_HZ,
    longBinHz,
    2,
    Math.min(longN >> 1, Math.floor(LOW_BAND_HI_HZ / longBinHz)),
    BANDS_PER_OCTAVE
  );
  const broadPlan = planBands(
    BROAD_BAND_LO_HZ,
    workRate / 2,
    shortBinHz,
    2,
    shortN >> 1,
    BANDS_PER_OCTAVE
  );
  if (lowPlan.count === 0 && broadPlan.count === 0) return nothing();

  const magLong = new Float64Array(longFft.bins);
  const magShort = new Float64Array(shortFft.bins);
  const bandLow = new Float64Array(Math.max(1, lowPlan.count));
  const prevLow = new Float64Array(Math.max(1, lowPlan.count));
  const bandBroad = new Float64Array(Math.max(1, broadPlan.count));
  const prevBroad = new Float64Array(Math.max(1, broadPlan.count));
  const fluxLow = new Float64Array(frames);
  const fluxBroad = new Float64Array(frames);

  // Report about forty times over the whole pass, whatever its length: often enough that a
  // progress bar moves on a two-second riff, rare enough that a ten-minute take does not spend
  // its time posting messages. See `onProgress`.
  const progressEvery = Math.max(1, Math.floor(frames / 40));
  for (let m = 0; m < frames; m++) {
    if (opts.onProgress && m % progressEvery === 0) opts.onProgress(m / frames);
    // The window is centred half a hop LATE so that the difference below lands on `m * hop`.
    const centre = (m + 0.5) * hop;
    longFft.magnitudes(work, centre, magLong);
    shortFft.magnitudes(work, centre, magShort);
    bandEnergies(magLong, lowPlan, bandLow);
    bandEnergies(magShort, broadPlan, bandBroad);

    if (m > 0) {
      let lo = 0;
      for (let b = 0; b < lowPlan.count; b++) {
        const d = bandLow[b] - prevLow[b];
        if (d > 0) lo += d;
      }
      let br = 0;
      for (let b = 0; b < broadPlan.count; b++) {
        const d = bandBroad[b] - prevBroad[b];
        if (d > 0) br += d;
      }
      // Per-BAND averages, not sums, so the two bands are on comparable scales before weighting
      // and so `BAND_SILENT_FLOOR` means the same thing whatever the band counts are.
      fluxLow[m] = lowPlan.count > 0 ? lo / lowPlan.count : 0;
      fluxBroad[m] = broadPlan.count > 0 ? br / broadPlan.count : 0;
    }
    prevLow.set(bandLow);
    prevBroad.set(bandBroad);
  }

  const meanLow = meanOf(fluxLow, 1);
  const meanBroad = meanOf(fluxBroad, 1);
  const useLow = meanLow > BAND_SILENT_FLOOR;
  const useBroad = meanBroad > BAND_SILENT_FLOOR;
  if (!useLow && !useBroad) return nothing();
  let wLow = useLow ? BAND_WEIGHT_LOW : 0;
  let wBroad = useBroad ? BAND_WEIGHT_BROAD : 0;
  const wSum = wLow + wBroad;
  wLow /= wSum;
  wBroad /= wSum;

  // After this the detection function has a mean of 1 over the take by construction, which is
  // what makes `thresholdFloor` a number anyone can reason about.
  const df = new Float64Array(frames);
  for (let m = 0; m < frames; m++) {
    df[m] =
      (useLow ? (wLow * fluxLow[m]) / meanLow : 0) +
      (useBroad ? (wBroad * fluxBroad[m]) / meanBroad : 0);
  }

  const medianHalf = Math.max(1, Math.round(medianWindowSec / hopSec / 2));
  const threshold = movingMedianThreshold(df, medianHalf, thresholdMultiplier, thresholdFloor);

  // --- peak picking -------------------------------------------------------
  //
  // The last usable frame, and why there is one. When the analysis window slides off the END of
  // the buffer the signal inside it is a TRUNCATED note, and a truncated sinusoid has a wider
  // main lobe than a whole one — so energy leaks sideways into neighbouring bands, which the
  // half-wave rectifier reads as a rise, which reads as an onset. It is not one. Every take in
  // the first draft of `selfTest()` reported a phantom attack in its final frames because of
  // this. Frames whose long window is not wholly inside the buffer are therefore not eligible.
  // The cost is real and small: a note struck in the last 46 ms of a recording is not reported.
  // The START of the buffer is NOT excluded — silence turning into signal is a genuine onset,
  // and a take that opens mid-note should say so.
  const lastUsable = Math.floor((work.length - longN / 2) / hop - 0.5);
  const minSpacingFrames = Math.max(1, minSpacingSec / hopSec);
  const candidates: Array<{ frame: number; excess: number }> = [];
  for (let m = 1; m < Math.min(frames - 1, lastUsable); m++) {
    const v = df[m];
    if (v <= 0 || v < threshold[m]) continue;
    if (!isLocalMax(df, m, LOCAL_MAX_HALF_FRAMES)) continue;
    candidates.push({ frame: m, excess: v - threshold[m] });
  }

  // Non-maximum suppression by STRENGTH, not by time. An attack does not produce one clean bump:
  // the long window smears its leading edge over tens of milliseconds and the result can carry
  // two or three local maxima. Taking the earliest of them — which the first draft did, on the
  // reasoning that an attack begins at its first rise — systematically reported notes about
  // 30 ms EARLY, because the earliest bump is the long window's pre-echo rather than the note.
  // Strongest-first suppression lands on the body of the transient instead, and the measured
  // bias fell from -31 ms to single figures. Ties break toward the earlier frame.
  candidates.sort((a, b) => b.excess - a.excess || a.frame - b.frame);
  const accepted: Array<{ frame: number; excess: number }> = [];
  for (const c of candidates) {
    let clash = false;
    for (const a of accepted) {
      if (Math.abs(c.frame - a.frame) < minSpacingFrames) {
        clash = true;
        break;
      }
    }
    if (!clash) accepted.push(c);
  }
  accepted.sort((a, b) => a.frame - b.frame);

  let maxExcess = 0;
  for (const p of accepted) if (p.excess > maxExcess) maxExcess = p.excess;
  const onsets: Onset[] = [];
  for (const p of accepted) {
    const strength = maxExcess > 0 ? p.excess / maxExcess : 1;
    if (strength < minStrength) continue;
    onsets.push({ timeSec: (p.frame + parabolicOffset(df, p.frame)) * hopSec, strength });
  }

  // The envelope is for drawing, so it is scaled to its own maximum rather than left in the
  // "mean 1" units above — a curve that mostly sits at 0.02 draws as a flat line.
  let dfMax = 0;
  for (let m = 0; m < frames; m++) if (df[m] > dfMax) dfMax = df[m];
  const envelope = new Float32Array(frames);
  if (dfMax > 0) for (let m = 0; m < frames; m++) envelope[m] = df[m] / dfMax;

  return {
    onsets,
    envelope,
    envelopeHopSec: hopSec,
    params: {
      ...baseParams,
      decimation: factor,
      workRate,
      longWindow: longN,
      longWindowSec: longN / workRate,
      shortWindow: shortN,
      shortWindowSec: shortN / workRate,
      hopSamples: hop,
      hopSec,
      frames,
      lowBands: lowPlan.count,
      lowBandLoHz: lowPlan.count > 0 ? lowPlan.starts[0] * longBinHz : 0,
      lowBandHiHz: lowPlan.count > 0 ? lowPlan.ends[lowPlan.count - 1] * longBinHz : 0,
      broadBands: broadPlan.count,
      broadBandLoHz: broadPlan.count > 0 ? broadPlan.starts[0] * shortBinHz : 0,
      broadBandHiHz: broadPlan.count > 0 ? broadPlan.ends[broadPlan.count - 1] * shortBinHz : 0,
      weightLow: wLow,
      weightBroad: wBroad,
      meanFluxLow: meanLow,
      meanFluxBroad: meanBroad,
      peakDetectionFunction: dfMax,
      onsetCount: onsets.length
    }
  };
}

/**
 * Line detected onsets up against the notes the model reported.
 *
 * The tolerance is generous on purpose. Two independent errors stack: MuScriptor's own note
 * timing, and this detector's (measured at a few milliseconds median but with a long tail on
 * soft attacks). 50 ms is under a sixteenth note at 300 bpm, so it does not merge adjacent
 * notes at any tempo a bass player will reach, and it is wide enough that an honest disagreement
 * about where the attack sits does not turn a confirmed note into a suspect one.
 *
 * Both arguments must be on the RECORDING's clock (design notes §4.13). Handing this
 * score-clock times produces a confident, wrong, whole-anacrusis-wide disagreement.
 */
export function matchOnsets<T extends NoteRef>(
  onsets: readonly Onset[],
  notes: readonly T[],
  opts: { toleranceSec?: number } = {}
): OnsetMatch<T> {
  const toleranceSec = opts.toleranceSec ?? DEFAULT_MATCH_TOLERANCE_SEC;
  const onsetTimes = onsets.map((o) => o.timeSec).sort((a, b) => a - b);
  const noteTimes = notes.map((n) => n.startSec).sort((a, b) => a - b);

  const unsupportedNotes: T[] = [];
  let confirmed = 0;
  for (const n of notes) {
    if (nearestDistance(onsetTimes, n.startSec) <= toleranceSec) confirmed++;
    else unsupportedNotes.push(n);
  }

  const missedOnsets: Onset[] = [];
  for (const o of onsets) {
    if (nearestDistance(noteTimes, o.timeSec) > toleranceSec) missedOnsets.push(o);
  }

  return { missedOnsets, unsupportedNotes, confirmed, toleranceSec };
}

/** Distance from `x` to the nearest value in a SORTED array. Infinity when the array is empty. */
function nearestDistance(sorted: readonly number[], x: number): number {
  if (sorted.length === 0) return Infinity;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  let best = Math.abs(sorted[lo] - x);
  if (lo > 0) best = Math.min(best, Math.abs(sorted[lo - 1] - x));
  return best;
}

// --- the detection function's plumbing --------------------------------------

/** How much to thin the samples by. Never below 1, never past the work rate we asked for. */
function decimationFactor(sampleRate: number): number {
  return Math.max(1, Math.floor(sampleRate / TARGET_WORK_RATE_HZ));
}

function nearestPowerOfTwo(x: number): number {
  return 1 << Math.max(1, Math.round(Math.log2(Math.max(2, x))));
}

/**
 * Anti-alias, decimate and peak-normalise in one pass.
 *
 * The normalisation is not cosmetic: `log(1 + LAMBDA * |X|)` is not scale-invariant, so without
 * pinning the input level the compression curve would sit in a different place for a quiet take
 * than a loud one and the thresholds would mean different things. Peak rather than RMS because a
 * peak is one number, cannot be gamed by a long silence, and only ever makes the compression
 * gentler — a stray click costs a little sensitivity, never a false onset.
 *
 * Returns null for silence, which is the only correct answer for a buffer with nothing in it.
 */
function toWorkSignal(pcm: Float32Array, factor: number): Float32Array | null {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = pcm[i] < 0 ? -pcm[i] : pcm[i];
    if (a > peak) peak = a;
  }
  if (!(peak > SILENCE_PEAK)) return null;
  const gain = 1 / peak;

  if (factor === 1) {
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * gain;
    return out;
  }

  const h = lowpassTaps(factor);
  const taps = h.length;
  const centre = (taps - 1) >> 1;
  const outLen = Math.floor(pcm.length / factor);
  if (outLen < 4) return null;
  const out = new Float32Array(outLen);
  for (let m = 0; m < outLen; m++) {
    const base = m * factor - centre;
    let acc = 0;
    if (base >= 0 && base + taps <= pcm.length) {
      // Interior: no bounds test in the inner loop, which is where all the time goes.
      for (let i = 0; i < taps; i++) acc += h[i] * pcm[base + i];
    } else {
      for (let i = 0; i < taps; i++) {
        const j = base + i;
        if (j >= 0 && j < pcm.length) acc += h[i] * pcm[j];
      }
    }
    out[m] = acc * gain;
  }
  return out;
}

/**
 * A windowed-sinc low-pass for the decimator, cut at 0.45 of the new Nyquist and Hamming
 * windowed. Length grows with the factor because a narrower cutoff needs a longer kernel; at the
 * usual factor of 4 that is 33 taps, which is enough that whatever folds back sits well under
 * the flux of a real attack. Normalised to unit DC gain so decimating does not change the level.
 */
function lowpassTaps(factor: number): Float64Array {
  const taps = 8 * factor + 1;
  const centre = (taps - 1) >> 1;
  const fc = 0.45 / factor;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - centre;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

function meanOf(xs: Float64Array, from: number): number {
  let s = 0;
  let n = 0;
  for (let i = from; i < xs.length; i++) {
    s += xs[i];
    n++;
  }
  return n > 0 ? s / n : 0;
}

/**
 * The adaptive threshold: `multiplier * localMedian + floor`.
 *
 * A median rather than a mean, because the thing we are trying to exceed is the BACKGROUND, and
 * a mean over a 100 ms window that contains an attack is dragged up by that attack — which makes
 * the detector least sensitive exactly where the notes are. A median of a window with a few big
 * frames in it is unmoved by them.
 */
function movingMedianThreshold(
  df: Float64Array,
  half: number,
  multiplier: number,
  floor: number
): Float64Array {
  const n = df.length;
  const out = new Float64Array(n);
  const buf = new Float64Array(2 * half + 1);
  for (let m = 0; m < n; m++) {
    const a = Math.max(0, m - half);
    const b = Math.min(n - 1, m + half);
    const count = b - a + 1;
    for (let i = 0; i < count; i++) buf[i] = df[a + i];
    const slice = buf.subarray(0, count);
    slice.sort();
    out[m] = multiplier * slice[count >> 1] + floor;
  }
  return out;
}

/**
 * Is frame `m` the peak of its neighbourhood?
 *
 * Strictly greater looking backwards and greater-or-equal looking forwards, so a flat top
 * reports its FIRST frame. An attack's evidence starts at the first rise; picking the middle of
 * a plateau would report a note late by a hop or two for no reason.
 */
function isLocalMax(df: Float64Array, m: number, half: number): boolean {
  const a = Math.max(0, m - half);
  const b = Math.min(df.length - 1, m + half);
  for (let j = a; j < m; j++) if (df[j] >= df[m]) return false;
  for (let j = m + 1; j <= b; j++) if (df[j] > df[m]) return false;
  return true;
}

/**
 * Sub-frame position of a peak by fitting a parabola to it and its two neighbours.
 *
 * The hop is 5.8 ms and a note's timing is worth more than that, so this buys back most of the
 * quantisation for three multiplications. Clamped to half a frame: a fit that wants to place the
 * peak outside its own bracket is a fit that has failed, and 0 is the honest answer then.
 */
function parabolicOffset(df: Float64Array, m: number): number {
  if (m <= 0 || m >= df.length - 1) return 0;
  const a = df[m - 1];
  const b = df[m];
  const c = df[m + 1];
  const denom = a - 2 * b + c;
  if (denom === 0) return 0;
  const delta = (0.5 * (a - c)) / denom;
  if (!(delta > -0.5 && delta < 0.5)) return 0;
  return delta;
}

// --- FFT, written here because this must not add a dependency ---------------

/**
 * Iterative in-place radix-2 Cooley-Tukey, decimation in time.
 *
 * Nothing clever and nothing to be clever about. Bit-reversal permutation, then log2(n) stages
 * of butterflies against precomputed twiddles. It exists because this module ships inside a
 * plugin's web view and a new npm dependency for sixty lines of arithmetic is not a trade worth
 * making. `selfTest()` would catch a wrong one instantly — a broken FFT cannot find a pluck.
 */
class Fft {
  readonly n: number;
  private readonly cosT: Float64Array;
  private readonly sinT: Float64Array;
  private readonly rev: Uint32Array;

  constructor(n: number) {
    this.n = n;
    const half = n >> 1;
    this.cosT = new Float64Array(half);
    this.sinT = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      this.cosT[k] = Math.cos((-2 * Math.PI * k) / n);
      this.sinT[k] = Math.sin((-2 * Math.PI * k) / n);
    }
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  run(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const wr = this.cosT[k];
          const wi = this.sinT[k];
          const l = j + half;
          const tr = re[l] * wr - im[l] * wi;
          const ti = re[l] * wi + im[l] * wr;
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
  }
}

/**
 * A real-input FFT of size N built on a complex FFT of size N/2, plus the framing and the
 * windowing and the log compression, because those always happen together here.
 *
 * The packing trick halves the work: the even samples go in the real part and the odd samples in
 * the imaginary part of a half-length complex sequence, and the two interleaved transforms are
 * separated afterwards by conjugate symmetry. Worth the twenty lines — the STFT is the whole
 * cost of this module and this is a straight factor of two off it.
 */
class RealFft {
  /** Length of the real window this transforms. */
  readonly size: number;
  /** Number of magnitude bins produced: N/2 + 1, DC to Nyquist inclusive. */
  readonly bins: number;
  private readonly fft: Fft;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly win: Float64Array;
  private readonly twr: Float64Array;
  private readonly twi: Float64Array;
  private readonly scale: number;

  constructor(size: number) {
    this.size = size;
    this.bins = (size >> 1) + 1;
    const m = size >> 1;
    this.fft = new Fft(m);
    this.re = new Float64Array(m);
    this.im = new Float64Array(m);
    this.win = new Float64Array(size);
    // Hann. Chosen over Hamming because its sidelobes fall away far faster, and a low
    // fundamental's leakage into the neighbouring bins is exactly what would blur the low band.
    for (let i = 0; i < size; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    this.twr = new Float64Array(m);
    this.twi = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      const ang = (-Math.PI * k) / m;
      this.twr[k] = Math.cos(ang);
      this.twi[k] = Math.sin(ang);
    }
    // A Hann window sums to N/2, so this puts a full-scale sine at about 0.5 in its own bin
    // whatever the window length is — which is what lets one LOG_LAMBDA serve both sizes.
    this.scale = 2 / size;
  }

  /**
   * Window the frame centred on `centre` (in samples), transform it, and write `|X[k]|` into
   * `out`. Samples outside the buffer read as zero, so the first and last frames of a take taper
   * instead of wrapping. Raw magnitudes, not compressed — the log happens after the bins have
   * been grouped into bands, and doing it here instead is the bug described at `planBands`.
   */
  magnitudes(src: Float32Array, centre: number, out: Float64Array): void {
    const n = this.size;
    const m = n >> 1;
    const re = this.re;
    const im = this.im;
    const win = this.win;
    const start = Math.round(centre) - m;
    const len = src.length;
    for (let i = 0; i < m; i++) {
      const a = start + 2 * i;
      const b = a + 1;
      re[i] = (a >= 0 && a < len ? src[a] : 0) * win[2 * i];
      im[i] = (b >= 0 && b < len ? src[b] : 0) * win[2 * i + 1];
    }
    this.fft.run(re, im);

    const twr = this.twr;
    const twi = this.twi;
    const scale = this.scale;
    for (let k = 0; k < m; k++) {
      const k2 = (m - k) % m;
      // Split the interleaved transforms apart: the even-sample spectrum is the conjugate-even
      // half of Z, the odd-sample spectrum the conjugate-odd half, then one twiddle recombines.
      const er = 0.5 * (re[k] + re[k2]);
      const ei = 0.5 * (im[k] - im[k2]);
      const or = 0.5 * (im[k] + im[k2]);
      const oi = -0.5 * (re[k] - re[k2]);
      const tr = or * twr[k] - oi * twi[k];
      const ti = or * twi[k] + oi * twr[k];
      const xr = er + tr;
      const xi = ei + ti;
      out[k] = Math.sqrt(xr * xr + xi * xi) * scale;
    }
    // Nyquist: X[N/2] = sum of x[n] * (-1)^n, which falls straight out of the packed DC bin.
    out[m] = Math.abs(re[0] - im[0]) * scale;
  }
}

/**
 * Which FFT bins belong to which band. `starts[b] .. ends[b]` inclusive.
 *
 * WHY BANDS AT ALL, because this was got wrong first and the failure is instructive. The obvious
 * implementation compresses each BIN — `log(1 + λ|X[k]|)` — and sums the rises. It does not work,
 * and it fails in the direction that matters: on a synthetic 30-second take of 120 plucks it
 * found THREE. The reason is that log compression is exactly as generous to a bin holding
 * nothing but the noise floor as to a bin holding a partial. A Rayleigh-distributed noise bin
 * swings by about 100% frame to frame, which in the log domain is a rise of ~0.7 every other
 * frame, and there are a hundred-odd such bins in the upper band against maybe five that carry
 * the note. The detection function came out with a peak-to-mean ratio of 4, and no threshold
 * separates anything at 4.
 *
 * Grouping bins into bands before the log is the standard fix and it works for a standard
 * reason: summing B independent noise bins cuts their RELATIVE fluctuation by sqrt(B), while a
 * partial's energy is concentrated and survives the sum intact. Log-spaced bands put the fine
 * resolution at the bottom, where a bass fundamental needs it, and the wide noise-averaging
 * bands at the top, where nothing needs resolving.
 */
interface BandPlan {
  starts: Int32Array;
  ends: Int32Array;
  count: number;
}

function planBands(
  loHz: number,
  hiHz: number,
  binHz: number,
  minBin: number,
  maxBin: number,
  perOctave: number
): BandPlan {
  const edges: number[] = [];
  for (let f = loHz; f <= hiHz * 1.0001; f *= Math.pow(2, 1 / perOctave)) {
    const k = Math.max(minBin, Math.min(maxBin + 1, Math.round(f / binHz)));
    // Monotone by at least one bin, so no band is empty and no bin is counted twice.
    if (edges.length === 0 || k > edges[edges.length - 1]) edges.push(k);
    else edges.push(edges[edges.length - 1] + 1);
  }
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i];
    const b = Math.min(maxBin, edges[i + 1] - 1);
    if (a > maxBin || b < a) break;
    starts.push(a);
    ends.push(b);
  }
  // The last band always runs to the top of the range rather than stopping short of it.
  if (ends.length > 0) ends[ends.length - 1] = maxBin;
  return {
    starts: Int32Array.from(starts),
    ends: Int32Array.from(ends),
    count: starts.length
  };
}

/**
 * Sum the magnitudes in each band and compress: `log(1 + LOG_LAMBDA * bandMagnitude)`.
 *
 * The compression is what makes a quiet new note visible under a loud ringing one — a rise from
 * 0.001 to 0.002 in a band counts the same as 0.1 to 0.2, which is right, because a note either
 * arrived or it did not and its loudness is a separate question.
 */
function bandEnergies(mag: Float64Array, plan: BandPlan, out: Float64Array): void {
  for (let b = 0; b < plan.count; b++) {
    let s = 0;
    const end = plan.ends[b];
    for (let k = plan.starts[b]; k <= end; k++) s += mag[k];
    out[b] = Math.log(1 + LOG_LAMBDA * (s > MAGNITUDE_FLOOR ? s : MAGNITUDE_FLOOR));
  }
}

// ============================================================================
// SELF TEST
// ============================================================================

export interface OnsetSelfTestCase {
  name: string;
  /** What was synthesised, in words, so a number in a report can be traced to a signal. */
  material: string;
  sampleRate: number;
  /** Where a note was actually struck, in seconds. */
  expectedSec: number[];
  /** Where the detector said one was. */
  gotSec: number[];
  matched: number;
  missed: number;
  falsePositives: number;
  /** Signed timing error in milliseconds for each matched onset: detected minus true. */
  errorsMs: number[];
  medianErrorMs: number | null;
  worstErrorMs: number | null;
  /**
   * The measured limitation this case is allowed to keep exhibiting.
   *
   * A BUDGET IS A RECORD, NOT A TARGET. Zero is the default and most cases hold it. A non-zero
   * budget means the detector deterministically gets this many wrong on this material for a
   * reason written in `note`, and the case exists so that the wrongness is reproducible and
   * visible instead of being rediscovered with a bass in someone's hands. The real counts stay
   * in `missed` and `falsePositives` and in the totals, so nothing is hidden by a budget — it
   * only decides whether the case goes red. Anything that drifts PAST its budget still fails.
   *
   * The alternative was a permanently red self-test, and a permanently red test teaches people
   * to stop reading the red.
   */
  allowedMissed: number;
  allowedFalse: number;
  /** True when the case is exactly right — no misses and nothing invented, budget or not. */
  perfect: boolean;
  pass: boolean;
  note?: string;
}

export interface OnsetSelfTestResult {
  cases: OnsetSelfTestCase[];
  /** Struck notes the detector did not find, over every case. */
  missed: number;
  /** Onsets reported where nothing was struck, over every case. */
  falsePositives: number;
  /** Struck notes it did find. */
  matched: number;
  /** Absolute timing error over every matched onset, in milliseconds. */
  medianErrorMs: number;
  worstErrorMs: number;
  /** Median SIGNED error — the systematic bias, which is a different question from the spread. */
  biasMs: number;
  failed: number;
  failures: string[];
  limitations: string[];
}

/** How close a detection has to be to count as the same event as an expected attack. */
const SELF_TEST_MATCH_SEC = 0.05;

/**
 * Synthesise signals whose attacks are known to the sample, and see what comes back.
 *
 * Deterministic — the noise comes from a fixed-seed generator, never `Math.random` — needs no
 * files and no audio device, and takes about 2.5 s on an idle machine (24 cases, 188 struck
 * notes, two of them over ten seconds long). Every accuracy number quoted anywhere about this
 * module should come from here.
 *
 * AT THE DEFAULTS: 179 of 188 found, 7 reported that were never played, median absolute timing
 * error 3.8 ms, worst 18.5 ms, median signed error -3.8 ms. The header says which cases those
 * nine misses are and why.
 *
 * WHAT WAS TUNED AND WHAT IT COST. Two knobs matter and both trade the failure directions
 * against each other. Measured over the whole set, all other constants at their defaults:
 *
 *     thresholdMultiplier   missed   false     legato run     soft note
 *            1.4               3       36       8 of 10        found
 *            1.8               7       17       5 of 10        found
 *            2.2               9        7       3 of 10        found      <- default
 *            2.6              12        1       1 of 10        LOST
 *            3.0              15        1       1 of 10        LOST
 *            4.0              18        0       1 of 10        LOST
 *
 *     minStrength           missed   false     held notes     soft note
 *            0                 6       31       3 phantoms     found
 *            0.03              9       12       0              found
 *            0.05              9        7       0              found      <- default
 *            0.08             10        1       0              LOST
 *            0.12             12        1       0              LOST
 *            0.20             14        0       0              LOST
 *
 * Read the two right-hand columns and the tuning stops being a free choice. Everything below the
 * default fills the corpus with phantoms — including on held notes, which is the one failure this
 * module cannot afford. Everything above it buys that cleanliness with the QUIETEST REAL NOTE in
 * the take, which is the note the whole module exists to find. Both defaults sit on the last rung
 * before that happens, and `minStrength` in particular was not hunted for: every false positive
 * in the corpus measured at or under 0.046 and every true attack in the same takes at or over
 * 0.27, so 0.05 is a gap, not a fitted parameter.
 *
 * The knob NOT worth touching is the one that looks most promising: `BANDS_PER_OCTAVE`. Coarser
 * bands (2 per octave) recover the legato run to 6 of 10 — and take false positives from 7 to 27.
 * The legato material is reachable; it is just not reachable without inventing notes elsewhere,
 * and inventing notes is the one thing this module must not do.
 *
 * WHAT THIS CANNOT TEST. All of it is synthesised, because `selfTest()` has to run in a browser
 * with no files. `pitch.ts` learned the expensive version of this lesson — a guard that passed
 * all sixty synthetic cases silenced a real recorded guitar note — and the same warning applies
 * here twice over, because a real palm mute is a far messier thing than the soft attacks below.
 * There are 65 real notes in `webcore/public/samples/`; anyone changing a constant in this file
 * should run it over those by hand before believing an improvement. This file already caught
 * itself out once in the other direction: two of the early "detector" failures — eight phantom
 * onsets in a held note, and a phantom at the end of every take — turned out to be a broken
 * vibrato in the TEST and an untrimmed analysis window. Disbelieve the detector, then disbelieve
 * the test.
 */
export function selfTest(): OnsetSelfTestResult {
  const cases: OnsetSelfTestCase[] = [];
  for (const c of pluckCases()) cases.push(c);
  for (const c of pedalCases()) cases.push(c);
  for (const c of hardCases()) cases.push(c);

  const errs: number[] = [];
  for (const c of cases) for (const e of c.errorsMs) errs.push(e);
  const abs = errs.map((e) => Math.abs(e)).sort((a, b) => a - b);
  const signed = errs.slice().sort((a, b) => a - b);
  const failures = cases
    .filter((c) => !c.pass)
    .map(
      (c) =>
        `${c.name}: ${c.missed} missed (allowed ${c.allowedMissed}), ` +
        `${c.falsePositives} false (allowed ${c.allowedFalse}) — ${c.material}`
    );
  const limitations = cases
    .filter((c) => !c.perfect)
    .map(
      (c) =>
        `${c.name}: ${c.matched}/${c.expectedSec.length} found, ${c.falsePositives} false — ${c.note ?? ''}`
    );

  return {
    cases,
    missed: cases.reduce((a, c) => a + c.missed, 0),
    falsePositives: cases.reduce((a, c) => a + c.falsePositives, 0),
    matched: cases.reduce((a, c) => a + c.matched, 0),
    medianErrorMs: abs.length ? round2(abs[(abs.length - 1) >> 1]) : 0,
    worstErrorMs: abs.length ? round2(abs[abs.length - 1]) : 0,
    biasMs: signed.length ? round2(signed[(signed.length - 1) >> 1]) : 0,
    failed: failures.length,
    failures,
    limitations
  };
}

/**
 * Run one signal and score it.
 *
 * Matching is one-to-one and globally greedy — every (expected, detected) pair inside the
 * tolerance is sorted by error and assigned nearest-first — rather than "nearest for each
 * expected in turn". With two attacks 40 ms apart and a 50 ms window, the naive version lets one
 * detection satisfy both expectations and reports a perfect score for a detector that heard one
 * note. That is exactly the case this file has to get right, so the scoring is not allowed to be
 * sloppy about it.
 */
function score(spec: {
  name: string;
  material: string;
  pcm: Float32Array;
  sampleRate: number;
  expectedSec: number[];
  allowedMissed?: number;
  allowedFalse?: number;
  opts?: OnsetOptions;
  note?: string;
}): OnsetSelfTestCase {
  const allowedMissed = spec.allowedMissed ?? 0;
  const allowedFalse = spec.allowedFalse ?? 0;
  const got = detectOnsets(spec.pcm, spec.sampleRate, spec.opts).onsets.map((o) => o.timeSec);

  const pairs: Array<{ e: number; g: number; err: number }> = [];
  for (let i = 0; i < spec.expectedSec.length; i++) {
    for (let j = 0; j < got.length; j++) {
      const err = got[j] - spec.expectedSec[i];
      if (Math.abs(err) <= SELF_TEST_MATCH_SEC) pairs.push({ e: i, g: j, err });
    }
  }
  pairs.sort((a, b) => Math.abs(a.err) - Math.abs(b.err));
  const usedE = new Set<number>();
  const usedG = new Set<number>();
  const errorsMs: number[] = [];
  for (const p of pairs) {
    if (usedE.has(p.e) || usedG.has(p.g)) continue;
    usedE.add(p.e);
    usedG.add(p.g);
    errorsMs.push(round2(p.err * 1000));
  }

  const matched = usedE.size;
  const missed = spec.expectedSec.length - matched;
  const falsePositives = got.length - usedG.size;
  const absSorted = errorsMs.map((e) => Math.abs(e)).sort((a, b) => a - b);

  return {
    name: spec.name,
    material: spec.material,
    sampleRate: spec.sampleRate,
    expectedSec: spec.expectedSec.map((s) => round3(s)),
    gotSec: got.map((s) => round3(s)),
    matched,
    missed,
    falsePositives,
    errorsMs,
    medianErrorMs: absSorted.length ? absSorted[(absSorted.length - 1) >> 1] : null,
    worstErrorMs: absSorted.length ? absSorted[absSorted.length - 1] : null,
    allowedMissed,
    allowedFalse,
    perfect: missed === 0 && falsePositives === 0,
    pass: missed <= allowedMissed && falsePositives <= allowedFalse,
    note: spec.note
  };
}

/** The ordinary case, at three rates: struck notes, evenly spaced, with decaying envelopes. */
function pluckCases(): OnsetSelfTestCase[] {
  const out: OnsetSelfTestCase[] = [];
  for (const rate of [44100, 48000, 22050]) {
    // Eight open-E plucks half a second apart — a slow bass line, the easiest thing there is.
    {
      const times = [0.2, 0.7, 1.2, 1.7, 2.2, 2.7, 3.2, 3.7];
      const pcm = new Float32Array(Math.round(rate * 4.2));
      for (const t of times) addPluck(pcm, rate, t, 41.2, { amp: 0.8, decaySec: 0.6 });
      out.push(
        score({
          name: `plucks-0.5s-E1@${rate}`,
          material: '8 plucked E1 (41.2 Hz), 0.5 s apart, exponential decay',
          pcm,
          sampleRate: rate,
          expectedSec: times
        })
      );
    }
    // Sixteenths at 120 bpm on a low B, which is the fastest a bass line normally goes and the
    // lowest note the app supports. 125 ms apart.
    {
      const times: number[] = [];
      for (let i = 0; i < 16; i++) times.push(0.25 + i * 0.125);
      const pcm = new Float32Array(Math.round(rate * 2.6));
      for (const t of times) addPluck(pcm, rate, t, 30.87, { amp: 0.8, decaySec: 0.25 });
      out.push(
        score({
          name: `sixteenths-B0@${rate}`,
          material: '16 plucked B0 (30.87 Hz) sixteenths at 120 bpm',
          pcm,
          sampleRate: rate,
          expectedSec: times
        })
      );
    }
    // A walking line: different pitches, uneven dynamics. Changing pitch is easier than repeating
    // one, so this is here to confirm the detector is not somehow keyed to a single fundamental.
    {
      const notes: Array<[number, number, number]> = [
        [0.2, 41.2, 0.9],
        [0.55, 46.25, 0.6],
        [0.9, 55.0, 0.85],
        [1.25, 61.74, 0.5],
        [1.6, 65.41, 0.95],
        [1.95, 55.0, 0.55],
        [2.3, 49.0, 0.8],
        [2.65, 41.2, 0.7]
      ];
      const pcm = new Float32Array(Math.round(rate * 3.4));
      for (const [t, hz, amp] of notes) addPluck(pcm, rate, t, hz, { amp, decaySec: 0.45 });
      out.push(
        score({
          name: `walking-line@${rate}`,
          material: '8 different bass pitches, uneven levels (0.5 to 0.95)',
          pcm,
          sampleRate: rate,
          expectedSec: notes.map((n) => n[0]),
          allowedFalse: 1,
          note: 'the 46 Hz note is reported twice, 54 ms apart — see the doubled-attack note'
        })
      );
    }
  }
  // A long dense line, because everything above is a few seconds long and the app runs this on a
  // whole take. The first version of this module scored 114 of 118 here while every short case
  // was perfect, and a slower moving median was what fixed it: at 0.1 s the median window is
  // narrower than one attack's hump, so the threshold rises exactly where the note is.
  {
    const rate = 44100;
    const times: number[] = [];
    const pcm = new Float32Array(Math.round(rate * 12));
    const riff = [41.2, 55.0, 49.0, 61.74, 41.2, 65.41, 55.0, 73.42];
    for (let i = 0; i < 46; i++) {
      const t = 0.2 + i * 0.25;
      times.push(t);
      addPluck(pcm, rate, t, riff[i % riff.length], { amp: 0.8, decaySec: 0.4 });
    }
    out.push(
      score({
        name: 'dense-line-12s',
        material: '46 plucked notes at 4 per second over 12 s, decays overlapping',
        pcm,
        sampleRate: rate,
        expectedSec: times,
        allowedFalse: 3,
        note: 'every note found; three of the 46 attacks are reported twice — see the doubled-attack note'
      })
    );
  }
  return out;
}

/**
 * THE CASE THAT MATTERS MOST: a held note with no re-attacks.
 *
 * Design notes §3.5 failure mode 1 is a decoder that staples 871 phantom notes of one pitch across
 * five minutes, and the reason no note-list heuristic can catch it is that a genuine pedal-note
 * passage looks identical from the note list alone. Audio is the only thing that can separate
 * them — a real repeated note has an attack under every repetition and a phantom has one attack
 * and then nothing. So the detector reporting a clean single onset on a sustained note is the
 * whole basis of that feature, and it is worth three variations rather than one.
 */
function pedalCases(): OnsetSelfTestCase[] {
  const rate = 44100;
  const out: OnsetSelfTestCase[] = [];

  {
    // One pluck, five seconds of ring-out. If anything after t=0.3 comes back, the "phantom
    // repeats" feature is unbuildable.
    const pcm = new Float32Array(Math.round(rate * 5.5));
    addPluck(pcm, rate, 0.3, 41.2, { amp: 0.95, decaySec: 2.5 });
    out.push(
      score({
        name: 'pedal-single-pluck',
        material: 'one E1 struck at 0.3 s, ringing for 5 s, no re-attack',
        pcm,
        sampleRate: rate,
        expectedSec: [0.3]
      })
    );
  }
  {
    // A bowed/sustained note that does not decay at all — no envelope cue anywhere, so any onset
    // after the first is the detector inventing one.
    const pcm = new Float32Array(Math.round(rate * 5));
    addSustain(pcm, rate, 0.4, 4.2, 41.2, 0.7, 0);
    out.push(
      score({
        name: 'pedal-flat-sustain',
        material: 'E1 held flat from 0.4 s to 4.6 s, no decay, no re-attack',
        pcm,
        sampleRate: rate,
        expectedSec: [0.4]
      })
    );
  }
  {
    // The realistic version: a held note is never perfectly steady. 4.5 Hz tremolo at ±12% and a
    // slow 5.5 Hz vibrato of ±0.3%, which is what a finger on a fretboard actually does.
    const pcm = new Float32Array(Math.round(rate * 5));
    addSustain(pcm, rate, 0.4, 4.2, 41.2, 0.7, 0.12);
    out.push(
      score({
        name: 'pedal-wobbling-sustain',
        material: 'E1 held 4.2 s with 4.5 Hz tremolo (±12%) and slow vibrato',
        pcm,
        sampleRate: rate,
        expectedSec: [0.4]
      })
    );
  }
  {
    // Silence must produce nothing at all. The one case with no possible excuse.
    const pcm = new Float32Array(Math.round(rate * 3));
    out.push(
      score({
        name: 'silence',
        material: '3 s of digital silence',
        pcm,
        sampleRate: rate,
        expectedSec: []
      })
    );
  }
  return out;
}

/** The material this module exists to be honest about. */
function hardCases(): OnsetSelfTestCase[] {
  const rate = 44100;
  const out: OnsetSelfTestCase[] = [];

  {
    // Two notes 40 ms apart — a grace note, or a fast double-stop rolled. Can it separate them?
    const pcm = new Float32Array(Math.round(rate * 2));
    addPluck(pcm, rate, 0.5, 41.2, { amp: 0.85, decaySec: 0.5 });
    addPluck(pcm, rate, 0.54, 55.0, { amp: 0.85, decaySec: 0.5 });
    out.push(
      score({
        name: 'two-notes-40ms',
        material: 'E1 at 0.5 s, A1 at 0.54 s — 40 ms apart',
        pcm,
        sampleRate: rate,
        expectedSec: [0.5, 0.54]
      })
    );
  }
  {
    // The same pair 25 ms apart, which is INSIDE the 30 ms minimum spacing. It must report one
    // onset, not two, and this case exists so that the limit is documented by measurement rather
    // than by a comment nobody checked.
    const pcm = new Float32Array(Math.round(rate * 2));
    addPluck(pcm, rate, 0.5, 41.2, { amp: 0.85, decaySec: 0.5 });
    addPluck(pcm, rate, 0.525, 55.0, { amp: 0.85, decaySec: 0.5 });
    out.push(
      score({
        name: 'two-notes-25ms',
        material: 'E1 and A1 25 ms apart, under the 30 ms minimum spacing',
        pcm,
        sampleRate: rate,
        expectedSec: [0.5, 0.525],
        allowedMissed: 1,
        note: 'inside minSpacingSec by design — the pair is reported as one attack'
      })
    );
  }
  {
    // Plucks under broadband noise at about -20 dB. Room, amp hiss, a noisy DI.
    const pcm = new Float32Array(Math.round(rate * 3.4));
    const times = [0.3, 0.8, 1.3, 1.8, 2.3, 2.8];
    for (const t of times) addPluck(pcm, rate, t, 41.2, { amp: 0.8, decaySec: 0.45 });
    addNoise(pcm, 0.08, 1);
    out.push(
      score({
        name: 'plucks-over-noise-20dB',
        material: '6 E1 plucks with white noise at about -20 dB',
        pcm,
        sampleRate: rate,
        expectedSec: times
      })
    );
  }
  {
    // The same at about -10 dB, which is a genuinely bad recording.
    const pcm = new Float32Array(Math.round(rate * 3.4));
    const times = [0.3, 0.8, 1.3, 1.8, 2.3, 2.8];
    for (const t of times) addPluck(pcm, rate, t, 41.2, { amp: 0.8, decaySec: 0.45 });
    addNoise(pcm, 0.25, 2);
    out.push(
      score({
        name: 'plucks-over-noise-10dB',
        material: '6 E1 plucks with white noise at about -10 dB',
        pcm,
        sampleRate: rate,
        expectedSec: times,
        note: 'all six survive a -10 dB noise floor, which was not expected when the case was written'
      })
    );
  }
  {
    // A soft attack among loud ones. The threshold is relative to the take, which is right, and
    // this is the price: a note a long way under its neighbours can fall through.
    const pcm = new Float32Array(Math.round(rate * 3));
    const times = [0.3, 0.8, 1.3, 1.8, 2.3];
    const amps = [0.9, 0.9, 0.12, 0.9, 0.9];
    for (let i = 0; i < times.length; i++) {
      addPluck(pcm, rate, times[i], 41.2, { amp: amps[i], decaySec: 0.45 });
    }
    out.push(
      score({
        name: 'one-soft-note-among-loud',
        material: '5 E1 plucks, the middle one at 13% of the others',
        pcm,
        sampleRate: rate,
        expectedSec: times
      })
    );
  }
  {
    // A palm mute: slow 25 ms attack, no pick click, gone in 120 ms. This is MuScriptor's worst
    // material too (§3.5 failure mode 2), which is the point — when both engines are weak on the
    // same passage, their agreement is worth much less than it looks.
    const pcm = new Float32Array(Math.round(rate * 3));
    const times = [0.3, 0.8, 1.3, 1.8, 2.3];
    for (const t of times) {
      addPluck(pcm, rate, t, 41.2, { amp: 0.5, decaySec: 0.12, attackSec: 0.025, click: 0 });
    }
    out.push(
      score({
        name: 'palm-muted-run',
        material: '5 muted E1: 25 ms attack, no pick click, 120 ms decay',
        pcm,
        sampleRate: rate,
        expectedSec: times,
        allowedFalse: 1,
        note: 'the last mute is reported twice, 43 ms apart — see the doubled-attack note'
      })
    );
  }
  {
    // A hammer-on: the second note arrives with no amplitude discontinuity at all, only a new set
    // of partials. Half-wave-rectified flux CAN see that in principle — a new partial series is a
    // rise wherever it lands — so this was written expecting a pass, and it does not get one. The
    // hammered note comes in at 39% of the ringing one it replaces and the rise never clears the
    // threshold. It is filed as measured, not argued away.
    const pcm = new Float32Array(Math.round(rate * 2.5));
    addPluck(pcm, rate, 0.3, 41.2, { amp: 0.9, decaySec: 1.2 });
    addSustain(pcm, rate, 0.75, 0.9, 49.0, 0.35, 0);
    out.push(
      score({
        name: 'hammer-on',
        material: 'E1 plucked at 0.3 s, hammered to G1 at 0.75 s with no new attack',
        pcm,
        sampleRate: rate,
        expectedSec: [0.3, 0.75],
        allowedMissed: 1,
        note: 'the hammered note has no attack and is missed — the pluck before it is found'
      })
    );
  }
  {
    // A LEGATO RUN, and the worst result in this file by a distance. Ten notes at four a second
    // with no pick attack at all and decays that overlap, which is what fast fingerstyle or a
    // hammered run actually looks like. The low band never gets a chance to fall between notes, so
    // there is nothing for a rise detector to rise from.
    //
    // This case is here BECAUSE it is bad. Everything else in this file is between good and
    // excellent, and quoting those numbers without this one would be a lie about what the module
    // does on real playing. It is the same material MuScriptor gives up on (§3.5 failure mode 2,
    // muted recall 0.24) and the two engines fail it together.
    const pcm = new Float32Array(Math.round(rate * 3.4));
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t = 0.3 + i * 0.25;
      times.push(t);
      addPluck(pcm, rate, t, [41.2, 49.0, 55.0, 61.74][i % 4], {
        amp: 0.8,
        decaySec: 0.4,
        attackSec: 0.025,
        click: 0
      });
    }
    out.push(
      score({
        name: 'legato-run-no-attack',
        material: '10 notes at 4 per second, no pick attack, decays overlapping',
        pcm,
        sampleRate: rate,
        expectedSec: times,
        allowedMissed: 8,
        note: 'THE WORST CASE: 3 of 10. Never report an absent onset as evidence against a note in this material'
      })
    );
  }
  {
    // A slide. Continuous glide from E1 to A1 over 300 ms: no discontinuity anywhere, so there is
    // nothing for a difference-based detector to find, and it does not find it.
    const pcm = new Float32Array(Math.round(rate * 2.5));
    addPluck(pcm, rate, 0.3, 41.2, { amp: 0.9, decaySec: 1.5 });
    addGlide(pcm, rate, 0.8, 0.3, 41.2, 55.0, 0.5);
    out.push(
      score({
        name: 'slide',
        material: 'E1 plucked, then a 300 ms continuous slide up to A1 from 0.8 s',
        pcm,
        sampleRate: rate,
        expectedSec: [0.3, 0.8],
        allowedFalse: 1,
        note: 'the START of the slide is found; the glide itself then invents an extra onset as partials cross band edges'
      })
    );
  }
  {
    // A new note struck while an older one still rings loudly. This is the case log-magnitude
    // flux exists for: in linear flux the new note is a few percent of the sum and invisible.
    const pcm = new Float32Array(Math.round(rate * 3));
    addPluck(pcm, rate, 0.2, 41.2, { amp: 1.0, decaySec: 2.5 });
    addPluck(pcm, rate, 0.9, 82.41, { amp: 0.35, decaySec: 0.6 });
    addPluck(pcm, rate, 1.5, 110.0, { amp: 0.35, decaySec: 0.6 });
    out.push(
      score({
        name: 'notes-over-ringing-open-string',
        material: 'loud E1 ringing, quieter E2 and A2 struck over it',
        pcm,
        sampleRate: rate,
        expectedSec: [0.2, 0.9, 1.5]
      })
    );
  }
  return out;
}

// --- synthesis, all deterministic -------------------------------------------

/**
 * A plucked bass string's partial amplitudes.
 *
 * Fundamental quieter than the second partial, which is what a real electric bass through a
 * bridge-ish pickup does, and the reason a naive low-band-only detector does worse than it looks
 * like it should on paper.
 */
const BASS_PARTIALS = [0.55, 0.85, 0.6, 0.4, 0.28, 0.18, 0.12, 0.08] as const;
const BASS_PHASES = [0, 0.7, 1.9, 2.6, 0.4, 1.3, 2.2, 0.9] as const;

/**
 * Add a struck note.
 *
 * `attackSec` is the rise time — a few milliseconds for a normal pluck, tens for a palm mute —
 * and `click` mixes in a short burst of broadband pick noise, which is the thing a mute removes.
 * Both are the difference between the easy cases and the hard ones.
 */
function addPluck(
  out: Float32Array,
  rate: number,
  startSec: number,
  hz: number,
  o: { amp: number; decaySec: number; attackSec?: number; click?: number }
): void {
  const attackSec = o.attackSec ?? 0.004;
  const click = o.click ?? 0.25;
  const s0 = Math.round(startSec * rate);
  const end = Math.min(out.length, s0 + Math.round((o.decaySec * 8 + attackSec) * rate));
  const rand = lcg(Math.round(hz * 1000) + s0);
  for (let i = s0; i < end; i++) {
    const t = (i - s0) / rate;
    // A one-pole rise into an exponential fall, so the peak is `attackSec` after the start
    // rather than at it — which is exactly the ambiguity a real detector has to live with.
    const env = (1 - Math.exp(-t / attackSec)) * Math.exp(-t / o.decaySec);
    let v = 0;
    for (let k = 0; k < BASS_PARTIALS.length; k++) {
      v += BASS_PARTIALS[k] * Math.sin((k + 1) * 2 * Math.PI * hz * t + BASS_PHASES[k]);
    }
    v /= 3;
    // Pick noise: broadband, gone in 8 ms.
    if (click > 0 && t < 0.02) v += click * (rand() * 2 - 1) * Math.exp(-t / 0.008);
    out[i] += o.amp * env * v;
  }
}

/**
 * Add a held note with no attack at all: it fades in over 8 ms and holds.
 *
 * `tremolo` is the depth of a 4.5 Hz amplitude wobble; a slow vibrato rides along with it,
 * because a perfectly steady synthetic tone is an easier thing to hold silent than a real one.
 */
function addSustain(
  out: Float32Array,
  rate: number,
  startSec: number,
  lengthSec: number,
  hz: number,
  amp: number,
  tremolo: number
): void {
  const s0 = Math.round(startSec * rate);
  const end = Math.min(out.length, s0 + Math.round(lengthSec * rate));
  // Phase is ACCUMULATED, not computed as `hz * t`. Writing `sin(2*pi*hz(t)*t)` for a vibrato
  // looks right and is not: differentiating it gives an instantaneous frequency that drifts
  // further from `hz` the longer the note is held, so a "0.3% vibrato" became a 40% chirp four
  // seconds in — and the detector duly found eight onsets in a note that was struck once. That
  // was a bug in the TEST, found by disbelieving the detector and looking at the signal.
  let phase = 0;
  for (let i = s0; i < end; i++) {
    const t = (i - s0) / rate;
    const fade = 1 - Math.exp(-t / 0.008);
    const tail = Math.min(1, (end - i) / (0.05 * rate));
    const trem = 1 + tremolo * Math.sin(2 * Math.PI * 4.5 * t);
    phase += (hz * (1 + 0.003 * Math.sin(2 * Math.PI * 5.5 * t))) / rate;
    let v = 0;
    for (let k = 0; k < BASS_PARTIALS.length; k++) {
      v += BASS_PARTIALS[k] * Math.sin((k + 1) * 2 * Math.PI * phase + BASS_PHASES[k]);
    }
    out[i] += amp * fade * tail * trem * (v / 3);
  }
}

/** A continuous pitch glide with no envelope discontinuity — a slide. */
function addGlide(
  out: Float32Array,
  rate: number,
  startSec: number,
  lengthSec: number,
  fromHz: number,
  toHz: number,
  amp: number
): void {
  const s0 = Math.round(startSec * rate);
  const n = Math.round(lengthSec * rate);
  const end = Math.min(out.length, s0 + n + Math.round(rate));
  let phase = 0;
  for (let i = s0; i < end; i++) {
    const t = (i - s0) / rate;
    const u = Math.min(1, t / lengthSec);
    // Glide in log frequency, which is how a finger moving at constant speed up a fretboard
    // actually sounds.
    const hz = fromHz * Math.pow(toHz / fromHz, u);
    phase += hz / rate;
    const env = Math.exp(-t / 1.2);
    let v = 0;
    for (let k = 0; k < BASS_PARTIALS.length; k++) {
      v += BASS_PARTIALS[k] * Math.sin((k + 1) * 2 * Math.PI * phase + BASS_PHASES[k]);
    }
    out[i] += amp * env * (v / 3);
  }
}

/** Broadband noise from a fixed seed. Never `Math.random` — this file has to be reproducible. */
function addNoise(out: Float32Array, amp: number, seed: number): void {
  const rand = lcg(seed);
  for (let i = 0; i < out.length; i++) out[i] += amp * (rand() * 2 - 1);
}

/** A plain 32-bit linear congruential generator. Numerical Recipes' constants. */
function lcg(seed: number): () => number {
  let s = (seed | 0) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function round2(x: number): number {
  return Number(x.toFixed(2));
}

function round3(x: number): number {
  return Number(x.toFixed(3));
}
