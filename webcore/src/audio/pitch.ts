/**
 * Pitch detection — "what note is ACTUALLY in this bit of the recording?"
 *
 * WHY THIS FILE EXISTS. The transcriber hears notes that were never played (95 reported
 * where 73 were played) and goes silent on notes that were. Everything downstream of it —
 * the sheet, the tab, the piano roll — repeats whatever it said with the same confidence.
 * This file is the second opinion: it listens to the recording itself, with no model and no
 * training data, and says what pitch is in front of it. It is the only part of the app that
 * can contradict the transcriber, so its whole value is that it does not lie.
 *
 * THAT IS THE DESIGN RULE, AND IT OUTRANKS ACCURACY. A confident wrong answer is worse than
 * "I cannot tell", because a player will believe it and correct a sheet that was right. So
 * every reading carries a `clarity`, silence and noise return `null` rather than the nearest
 * plausible note, and the caller is expected to print "no clear pitch here" rather than a
 * grey guess.
 *
 * HOW: YIN (de Cheveigné & Kawahara 2002). Autocorrelation with the cumulative-mean-
 * normalised difference function. About sixty lines, no dependencies, deterministic, and
 * chosen for one specific reason — plain autocorrelation has a well-known octave trap on
 * low notes, and this app has to be right about a low B0 (30.87 Hz) and a low E1 (41.20 Hz).
 * The trap is that the difference function dips just as deeply at twice the true period as
 * at the period itself, so "pick the deepest dip" reports an octave too LOW about as often
 * as not. YIN's fix is the absolute threshold: take the FIRST dip that is deep enough, not
 * the deepest one. That is implemented here, plus a fallback for the case where nothing
 * crosses the threshold at all (see `yin()`), which is where the remaining octave errors
 * would otherwise live.
 *
 * SPEED, because this runs on a user's selection while they wait. YIN is O(window x period),
 * and a period at 27.5 Hz is 1600 samples at 44.1 kHz — 2.5 million operations per frame,
 * and a five-second selection is a hundred frames. So the SEARCH runs on a decimated copy at
 * about 16 kHz (a quarter of the work), and the answer is then REFINED against the original
 * samples over a narrow band of periods around the coarse one. The refinement costs a few
 * thousand operations and buys back all of the resolution the decimation cost. Measured
 * errors are in `selfTest()` — do not quote an accuracy figure that did not come from there.
 *
 * WHAT IT STILL COSTS, MEASURED (node 22, M-series, 44.1 kHz input, five runs): 1.2 to 3.8 ms
 * per frame, typically about 1.7. End to end that is roughly 10-30 ms for a single plucked
 * note, 25-60 ms for a bar, 85-230 ms for a three-second phrase, and 0.4-0.6 s for a whole
 * take at the `MAX_TRACK_FRAMES` cap. The spread is JIT warm-up and young-generation garbage,
 * not the arithmetic, which is why it is quoted as a range rather than as one flattering
 * number. It is not free and it is not hidden: `ui/tuner.ts` paints "listening" and analyses
 * on the next frame rather than blocking the gesture.
 *
 * The cost is dominated by the lowest note we insist on finding — it goes as (rate / FMIN)^2 —
 * and it cannot be decimated away, because the top of the range sets a floor under the working
 * rate: a period of fewer than about eight samples is not measurable. 27.5 Hz at one end and
 * 2 kHz at the other is what makes this expensive, and both ends were asked for. If it ever
 * has to be faster, the honest fix is an FFT-based autocorrelation (about six times quicker,
 * and `selfTest()` would catch a wrong one immediately), not a narrower range quietly applied.
 *
 * The frame is always 2/FMIN_HZ long — 73 ms — because YIN needs two periods of the lowest
 * note it is asked to find. A shorter buffer than that is not refused; the low end of the
 * search is raised to fit, so a 20 ms scrap can still report an A3 and honestly cannot
 * report an E1.
 *
 * ---------------------------------------------------------------------------------------
 * LINEAGE: BASAMAK's tuner (the user's own DrumSequencer / BASAMAK project).
 * ---------------------------------------------------------------------------------------
 * This detector is NOT a port. BASAMAK's tuner is `basamakDetectPitch` in
 * `Source/dsp/SpectrumTap.h` — NSDF / McLeod (MPM), C++ inside JUCE, driven by a live
 * `TunerTap` ring. It cannot run here: this file has to run in a browser inside the plugin's
 * web view, so the algorithm was written again, and YIN was chosen rather than NSDF.
 *
 * What IS taken from BASAMAK is everything that was learned by USING a tuner in anger —
 * compared by ear against ReaTune and GTune, with a real bug found and fixed in it. That
 * knowledge is portable even though the code is not:
 *
 *  - THE TEST CASES. Everything in `selfTest()` marked `source: 'basamak'` is a line-for-line
 *    port of `tests/TunerTest.cpp`, INCLUDING its synthesis — a saw plus harmonics rather
 *    than a lab sine, at 24 kHz in a 2048-sample window, which is what BASAMAK's `DECIM 4`
 *    at a 96 kHz engine rate actually hands its detector. Same signal, same rate, same window,
 *    so the comparison is like for like and not a flattering re-run on easier material.
 *
 *  - THE 3-CENT BAR. BASAMAK's test asserts `|err| < 3` cents on plain tones (and a looser
 *    5 on its harmonic-rich ones). We hold ALL the ported cases to 3, including the rich
 *    ones. See the note on `BASAMAK_RICH_TOLERANCE_CENTS` — we did not adopt the looser bar
 *    because we did not need it.
 *
 *  - THE 2026-07-19 HARMONIC-DOMINANT BUG, which is the important one. A plucked guitar or
 *    bass note whose SECOND HARMONIC IS LOUDER THAN THE FUNDAMENTAL broke BASAMAK's old
 *    peak-picking rule ("the first NSDF peak above a fixed 0.62"), because such a note puts
 *    a tall NSDF peak at the HALF period, and the fixed threshold happily stopped there —
 *    reading an octave high, found by the user comparing against GTune. BASAMAK's fix was
 *    true MPM: collect every local maximum, find the global best, and take the FIRST peak
 *    within 90% of it.
 *
 *    We did NOT port that rule, and the reason is worth writing down because it is the sort
 *    of thing that gets "fixed" back later by someone being helpful. The bug lived in the
 *    PEAK-PICKING RULE, not in NSDF, and YIN's equivalent rule is not exposed to it. For a
 *    tone with partial amplitudes a1, a2, a3..., YIN's difference function at half the period
 *    is 2*(a1^2 + a3^2 + ...) — the ODD partials — against an average of (a1^2 + a2^2 + ...).
 *    A loud second harmonic is an EVEN partial: it inflates the denominator and contributes
 *    nothing to the numerator, so the half period is a MAXIMUM of the normalised difference,
 *    not a minimum, and YIN's absolute threshold cannot stop there. The measurements agree —
 *    all three of BASAMAK's harmonic-dominant cases come back at 0.00 cents, and so does the
 *    deliberately hollow tone added below (a1=0.10, a2=0.60), whose NSDF at the half period
 *    is 0.73, i.e. genuinely above the 0.62 that broke BASAMAK. Porting MPM would have been
 *    a rewrite to fix a bug this algorithm does not have.
 *
 *    THE HONEST FOOTNOTE, because "we pass BASAMAK's cases" is not the same as "we are safe
 *    here". Push the same class further than BASAMAK's tests go — a1 = 0.04 with the third
 *    partial at 0.16, amplitudes measured off the real `public/samples/steel-guitar/E2.wav` —
 *    and YIN DOES break, an octave high, for the reason above run backwards: with every ODD
 *    partial that quiet, the half-period difference falls under `YIN_THRESHOLD` after all. That
 *    case is in `selfTest()` as a known limitation, and it is a real recording, not a
 *    contrivance. Transcribing `basamakDetectPitch` into JS and running both detectors over the
 *    65 real notes in `public/samples/` scores ours 62 and BASAMAK's 58: BASAMAK wins one of
 *    these octave cases (a real upright-piano C4), ours wins five above 1.5 kHz, where its
 *    `lagMin = fs/1500` cannot reach. Better on this corpus, not better in every way, and the
 *    one place it is worse is written down rather than quietly rounded off.
 *
 *  - THE DECIMATION LESSON, taken as a warning. BASAMAK settled on `DECIM 4` (96 kHz -> 24 kHz)
 *    because `DECIM 8` read A4 about 6 cents sharp: lag resolution runs out at the TOP of the
 *    range, not the bottom. Our `TARGET_WORK_RATE_HZ` of 16 kHz is more aggressive than that,
 *    which would be the same mistake — except that we do not measure off the decimated copy at
 *    all. `refineTau` re-measures against the original samples, which is exactly the resolution
 *    BASAMAK bought by decimating less. `selfTest()` holds that claim to A5 at three rates.
 *
 * BASAMAK is the user's own project, so this is lineage, not licensing. It is recorded here
 * the way `CREDITS.md` and `../pipeline/ATTRIBUTIONS.md` record where things came from.
 */

import { midiToName } from '../score/notes';

export interface PitchReading {
  /** Frequency in Hz, or null when nothing pitched was found. */
  hz: number | null;
  /** Nearest MIDI note number, or null when `hz` is null. */
  midi: number | null;
  /** Distance from that note in cents, -50..+50. Zero when there is no pitch. */
  cents: number;
  /** 0..1. Below `CLARITY_FLOOR` this reading reports null rather than a guess. */
  clarity: number;
  /** e.g. "A#2". Null when there is no pitch. */
  noteName: string | null;
}

/** The lowest note we will look for: A0. Below this is not a bass note, it is rumble. */
const FMIN_HZ = 27.5;
/** The highest. Well past a guitar's 24th fret; above it we are chasing harmonics. */
const FMAX_HZ = 2000;
/**
 * YIN's absolute threshold. A dip this deep is "periodic enough" and the search stops at the
 * first one rather than hunting for a deeper dip at twice the period. 0.15 is the value from
 * the paper and it is the single line that keeps low notes off by an octave.
 */
const YIN_THRESHOLD = 0.15;
/**
 * When nothing crosses the threshold we fall back to the deepest dip — and that is exactly
 * the octave trap again. So before accepting it, we take the FIRST dip that is within this
 * factor of the deepest one, which is the same idea as the threshold applied relatively.
 */
const OCTAVE_TOLERANCE = 1.1;
/** Below this we say "I cannot tell" instead of naming a note. The caller must respect it. */
const CLARITY_FLOOR = 0.6;
/**
 * ===========================================================================================
 * WHAT WAS TRIED HERE AND IS DELIBERATELY NOT IN THE FILE. Read this before adding a guard.
 * ===========================================================================================
 * Two mitigations for the two known wrong answers (see `selfTest`'s known-limitation cases)
 * were built, measured, and thrown away. Both looked excellent against synthetic tones and both
 * were falsified by the real recordings sitting in `public/samples/`. They are written down
 * because each cost an afternoon and each will look like an obvious idea again.
 *
 * 1. A PHANTOM-FUNDAMENTAL GUARD. Two notes ringing together — A2 at 110 Hz under D3 at
 *    146.83 Hz — share a real common period at 110/3 = 36.7 Hz, and the composite genuinely
 *    repeats there, so the detector reports D1 at a clarity of 0.999. The proposed test: a real
 *    note puts energy on 1x and 2x of its fundamental, a phantom puts none there, so require
 *    the first two partials together to carry some fraction of the loudest partial (measured by
 *    Goertzel on the decimated frame). Against every tone in `selfTest()` the separation looked
 *    decisive — real tones 1.00 to 1.80, the phantom 0.07.
 *
 *    Real instruments live in between, and low ones live below. A correctly-read electric
 *    guitar B4 scores 0.14, E4 0.18, E2 0.29 — a bridge pickup rolls the low end off until the
 *    fourth partial is the loudest thing in the note, and the first version of this guard
 *    silenced a real B4 outright. Confining it to fundamentals below C2, where phantoms
 *    actually live, fixed that and survived all 60 lab cases and all 19 guitar and bass
 *    samples. Then the pianos: a real upright-piano C1 scores a MEDIAN of 0.092 and a minimum
 *    of 0.029, BELOW the phantom's 0.072, because a piano's bottom octave is almost all 2nd to
 *    6th partial and the ear supplies the fundamental. The guard turned that note from "a
 *    semitone sharp" into "two and a half octaves out". No threshold separates the two
 *    populations. The statistic is not a discriminator and no amount of tuning makes it one.
 *
 * 2. LOWERING `YIN_THRESHOLD` to stop the octave-UP error. A tone whose odd partials are all
 *    tiny makes the normalised difference dip below 0.15 at HALF the period, and YIN's absolute
 *    threshold stops there; raising the bar for stopping early should fix it, and it does — at
 *    0.10 the real steel-guitar E2 still fails but the count improves. It also breaks the thing
 *    this whole file is built to protect. Measured over the 65 real notes and all 80 self-test
 *    cases: 0.15 -> 62/65 real, no self-test failures. 0.10 -> 63/65 real, but two self-test
 *    cases fall an OCTAVE LOW. 0.08 -> three. 0.05 -> four, including BASAMAK's own A4. 0.03 ->
 *    59/65 real and five failures. The trade is one octave-up error for a cascade of octave-DOWN
 *    ones, which are the more common and more damaging kind. 0.15 is the paper's value, it is
 *    the best value measured here, and it stays.
 *
 * The general lesson, which is the expensive part: SYNTHETIC TONES ARE NOT EVIDENCE ABOUT WHAT
 * REAL INSTRUMENTS RADIATE. Anything added to this file that decides whether to believe a
 * reading must be measured against `public/samples/` — 65 real notes across six instruments —
 * before it is believed. `selfTest()` alone will wave it through.
 */

/**
 * Frames quieter than this are silence, not pitch. About -56 dBFS. Without a level gate a
 * room-tone frame produces a perfectly periodic-looking hum reading, which is the worst kind
 * of wrong: confident, stable, and about nothing.
 */
const SILENCE_RMS = 0.0016;
/** The search runs at roughly this rate. See the speed note in the header. */
const TARGET_WORK_RATE_HZ = 16000;
/** One reading per this many seconds, unless the caller says otherwise. */
const DEFAULT_HOP_SEC = 0.05;
/**
 * A selection can be minutes long and the answer has to arrive while a finger is still on
 * the mouse. Past this many frames the hop is stretched instead — a coarser picture of a
 * long stretch, rather than a precise picture that arrives too late to be a readout.
 *
 * 200 frames is about half a second of arithmetic, which is the longest this file is ever
 * allowed to take. A whole take selected end to end therefore comes back as 200 evenly
 * spread readings rather than as a frozen window.
 */
const MAX_TRACK_FRAMES = 200;

const NO_PITCH: PitchReading = { hz: null, midi: null, cents: 0, clarity: 0, noteName: null };

/** MIDI note number -> frequency. A4 = 69 = 440 Hz. */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * One answer for a whole buffer.
 *
 * Longer than one frame, it analyses the lot and reports the note that actually dominates
 * rather than whatever happened to be at the start: frames vote, the winning note's readings
 * are taken at their median frequency, and the clarity is the average of the frames that
 * agreed. A buffer holding two different notes therefore reports the longer one — which is
 * why `detectPitchTrack` exists and why the tuner shows a sequence rather than this when it
 * finds more than one.
 */
export function detectPitch(pcm: Float32Array, sampleRate: number): PitchReading {
  const readings = detectPitchTrack(pcm, sampleRate);
  if (readings.length === 0) return NO_PITCH;
  if (readings.length === 1) return readings[0];
  return summarise(readings);
}

/**
 * A reading per hop, for a whole selection — so a run of notes can be shown, not just one.
 *
 * Always at least one reading for any buffer with samples in it, so a caller never has to
 * special-case "too short to analyse"; that case comes back as a reading with `hz: null`.
 */
export function detectPitchTrack(
  pcm: Float32Array,
  sampleRate: number,
  hopSec: number = DEFAULT_HOP_SEC
): PitchReading[] {
  if (!(pcm.length > 0) || !(sampleRate > 0)) return [];

  const factor = decimationFactor(sampleRate);
  const workRate = sampleRate / factor;
  // Two periods of the lowest note we are willing to look for.
  const idealFrame = 2 * Math.ceil(workRate / FMIN_HZ) * factor;
  const frameLen = Math.min(idealFrame, pcm.length);

  const span = pcm.length - frameLen;
  let hop = Math.max(1, Math.round((hopSec > 0 ? hopSec : DEFAULT_HOP_SEC) * sampleRate));
  const wanted = Math.floor(span / hop) + 1;
  if (wanted > MAX_TRACK_FRAMES) hop = Math.max(1, Math.ceil(span / (MAX_TRACK_FRAMES - 1)));

  const out: PitchReading[] = [];
  for (let start = 0; start + frameLen <= pcm.length; start += hop) {
    out.push(analyseFrame(pcm, start, frameLen, sampleRate, factor));
    if (out.length >= MAX_TRACK_FRAMES) break;
  }
  if (out.length === 0) out.push(analyseFrame(pcm, 0, pcm.length, sampleRate, factor));
  return out;
}

// ---------------------------------------------------------------------------
// One frame
// ---------------------------------------------------------------------------

/** How much to thin the samples by before searching. Never below 1, never enough to alias. */
function decimationFactor(sampleRate: number): number {
  return Math.max(1, Math.floor(sampleRate / TARGET_WORK_RATE_HZ));
}

/**
 * Thin the samples, averaging each group first.
 *
 * The average is a crude low-pass and it is deliberately crude: it only has to stop the top
 * octave of the signal folding down into the band we search, and a musical signal's energy
 * up there is small. Nothing downstream measures anything off this copy — the frequency
 * itself is measured against the original samples in `refineTau`.
 */
function decimate(pcm: Float32Array, start: number, count: number, factor: number): Float32Array {
  if (factor <= 1) return pcm.subarray(start, start + count);
  const out = new Float32Array(Math.floor(count / factor));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    const base = start + i * factor;
    for (let k = 0; k < factor; k++) sum += pcm[base + k];
    out[i] = sum / factor;
  }
  return out;
}

function analyseFrame(
  pcm: Float32Array,
  start: number,
  count: number,
  sampleRate: number,
  factor: number
): PitchReading {
  if (count < 4) return NO_PITCH;

  // Level first: silence has no pitch and asking YIN about it wastes a millisecond to
  // produce a confident answer about room tone.
  let energy = 0;
  for (let i = start; i < start + count; i++) energy += pcm[i] * pcm[i];
  if (Math.sqrt(energy / count) < SILENCE_RMS) return NO_PITCH;

  const work = decimate(pcm, start, count, factor);
  const workRate = sampleRate / factor;
  // The integration window is half the frame, so the longest period we can see is the other
  // half. A short buffer therefore cannot see a low note, and says so by not finding one,
  // rather than by pretending the frame was longer.
  const tauMax = Math.min(Math.floor(work.length / 2), Math.ceil(workRate / FMIN_HZ));
  const tauMin = Math.max(2, Math.floor(workRate / FMAX_HZ));
  if (tauMax <= tauMin + 1) return NO_PITCH;

  const coarse = yin(work, tauMin, tauMax);
  if (coarse.tau <= 0) return NO_PITCH;

  const clarity = Math.max(0, Math.min(1, 1 - coarse.cmnd));
  if (clarity < CLARITY_FLOOR) return { ...NO_PITCH, clarity: Number(clarity.toFixed(3)) };

  const tauFull = refineTau(pcm, start, count, coarse.tau * factor, factor);
  if (!(tauFull > 0)) return { ...NO_PITCH, clarity: Number(clarity.toFixed(3)) };

  return reading(sampleRate / tauFull, clarity);
}

/**
 * YIN's cumulative-mean-normalised difference, and the period it points at.
 *
 * `cmnd` comes back with the answer because it IS the confidence: 0 is a perfectly periodic
 * frame, 1 is noise. Everything the caller decides about whether to believe the number is
 * decided from it.
 */
function yin(x: Float32Array, tauMin: number, tauMax: number): { tau: number; cmnd: number } {
  const w = tauMax;
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < w; j++) {
      const diff = x[j] - x[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // Normalise by the running mean, which is what turns "how different" into "how periodic"
  // and removes the downward slope plain autocorrelation has.
  const cm = new Float32Array(tauMax + 1);
  cm[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cm[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }

  // The absolute threshold: the FIRST dip deep enough, walked down to its own bottom. This
  // is the octave fix — the deepest dip is very often at twice the true period.
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cm[tau] < YIN_THRESHOLD) {
      let at = tau;
      while (at + 1 <= tauMax && cm[at + 1] < cm[at]) at++;
      return { tau: at, cmnd: cm[at] };
    }
  }

  // Nothing was that periodic. Take the deepest dip — but first look for an earlier one that
  // is nearly as deep, because "nearly as deep and half the period" is the octave trap
  // wearing a different hat.
  let bestTau = -1;
  let best = Infinity;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cm[tau] < best) {
      best = cm[tau];
      bestTau = tau;
    }
  }
  if (bestTau < 0) return { tau: -1, cmnd: 1 };
  const tolerated = best * OCTAVE_TOLERANCE;
  for (let tau = tauMin + 1; tau < bestTau; tau++) {
    if (cm[tau] <= tolerated && cm[tau] < cm[tau - 1] && cm[tau] <= cm[tau + 1]) {
      return { tau, cmnd: cm[tau] };
    }
  }
  return { tau: bestTau, cmnd: best };
}

/**
 * Measure the period again, against the ORIGINAL samples, in a narrow band around the coarse
 * answer — then interpolate between whole samples.
 *
 * Two separate errors are being removed here. The decimation threw away resolution: at 16 kHz
 * one sample of period is 68 cents at A4, which would make the meter useless. And whole
 * samples are quantised even at full rate — 34 cents at A4 at 44.1 kHz — so the minimum is
 * fitted with a parabola through its two neighbours, which is YIN's own step 5.
 *
 * The band is +/- two coarse samples. The coarse estimate is a local minimum of a smooth
 * function, so it is never off by more than about one; two is the margin.
 */
function refineTau(
  pcm: Float32Array,
  start: number,
  count: number,
  tauGuess: number,
  factor: number
): number {
  const margin = Math.max(2, 2 * factor);
  const lo = Math.max(2, Math.round(tauGuess) - margin);
  const hi = Math.round(tauGuess) + margin;
  // Whatever is left of the frame after the longest lag we are about to try.
  const w = Math.min(Math.floor(count / 2), count - hi);
  if (w < 8 || hi <= lo) return tauGuess;

  const n = hi - lo + 1;
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const tau = lo + i;
    let sum = 0;
    for (let j = 0; j < w; j++) {
      const diff = pcm[start + j] - pcm[start + j + tau];
      sum += diff * diff;
    }
    d[i] = sum;
  }

  let at = 0;
  for (let i = 1; i < n; i++) if (d[i] < d[at]) at = i;
  if (at === 0 || at === n - 1) return lo + at;

  const a = d[at - 1];
  const b = d[at];
  const c = d[at + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return lo + at + Math.max(-1, Math.min(1, shift));
}

// ---------------------------------------------------------------------------
// Turning a frequency into a note, and many frames into one answer
// ---------------------------------------------------------------------------

function reading(hz: number, clarity: number): PitchReading {
  if (!Number.isFinite(hz) || hz < FMIN_HZ * 0.5 || hz > FMAX_HZ * 1.5) {
    return { ...NO_PITCH, clarity: Number(clarity.toFixed(3)) };
  }
  const exact = 69 + 12 * Math.log2(hz / 440);
  const midi = Math.round(exact);
  if (midi < 0 || midi > 127) return { ...NO_PITCH, clarity: Number(clarity.toFixed(3)) };
  return {
    hz: Number(hz.toFixed(3)),
    midi,
    cents: Number(((exact - midi) * 100).toFixed(1)),
    clarity: Number(clarity.toFixed(3)),
    noteName: midiToName(midi)
  };
}

/**
 * Many frames, one answer.
 *
 * Frames vote for a note, weighted by how sure each one was; the winner's frequency is the
 * MEDIAN of the frames that named it, not the mean, so one bad frame at the attack cannot
 * drag the reading sharp. If nothing was clear enough to name, the answer is "no pitch" with
 * the best clarity we saw — which is information, not a failure: it says how close we came.
 */
function summarise(readings: PitchReading[]): PitchReading {
  const votes = new Map<number, { weight: number; hz: number[]; clarity: number[] }>();
  let bestClarity = 0;
  for (const r of readings) {
    if (r.clarity > bestClarity) bestClarity = r.clarity;
    if (r.midi === null || r.hz === null) continue;
    const bucket = votes.get(r.midi) ?? { weight: 0, hz: [], clarity: [] };
    bucket.weight += r.clarity;
    bucket.hz.push(r.hz);
    bucket.clarity.push(r.clarity);
    votes.set(r.midi, bucket);
  }
  if (votes.size === 0) return { ...NO_PITCH, clarity: Number(bestClarity.toFixed(3)) };

  let winner = -1;
  let winnerWeight = -1;
  for (const [midi, bucket] of votes) {
    if (bucket.weight > winnerWeight) {
      winnerWeight = bucket.weight;
      winner = midi;
    }
  }
  const bucket = votes.get(winner)!;
  const sorted = [...bucket.hz].sort((a, b) => a - b);
  const median = sorted[(sorted.length - 1) >> 1];
  const clarity = bucket.clarity.reduce((a, b) => a + b, 0) / bucket.clarity.length;
  return reading(median, clarity);
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * What was synthesised for a case.
 *
 * `sine` and `saw` mean exactly what they always meant — the two lab tones this file started
 * with. The rest arrived with the BASAMAK port and the recording cases, and are named so that
 * anyone reading the JSON can tell a lab tone from a plucked note without reading this file:
 *
 *  - `basamak-saw`  BASAMAK's own `testTone`: 0.6 * saw + 0.2 * a second harmonic.
 *  - `harmonics`    a sum of sinusoids with chosen partial amplitudes — BASAMAK's `testRich`,
 *                   and the hollow-fundamental tone that reproduces its 2026-07-19 bug.
 *  - `pluck`        harmonics under an exponential decay: a struck string, not a steady tone.
 *  - `two-notes`    two plucks at once — one still ringing under the other.
 *  - `silence`      an empty buffer, which must produce no note at all.
 */
export type PitchSelfTestWave =
  | 'sine'
  | 'saw'
  | 'basamak-saw'
  | 'harmonics'
  | 'pluck'
  | 'two-notes'
  | 'silence';

/**
 * What a case is allowed to answer.
 *
 * `pitch` is the ordinary contract and the only one the original cases use: a note must come
 * back and it must be right. The other two exist because two of the recording cases have no
 * single right answer, and pretending they do would be the dishonest way to keep a test green:
 *
 *  - `pitch-or-refusal` — "I cannot tell" is a correct answer here, but naming a note is a
 *    claim, and the claim is still graded against the material.
 *  - `refusal` — silence. Naming anything is a failure.
 *  - `known-limitation` — this detector gets this one WRONG today, deterministically, and the
 *    case is here so that the wrongness is on the record and reproducible rather than a thing
 *    someone rediscovers with a guitar. It is reported in `limitations`, never in `failures`,
 *    and never in `worstCents` — a permanently red case trains people to stop reading the red.
 *    If a future change makes one of these read correctly, DELETE the expectation and let it be
 *    an ordinary graded case; do not add new ones lightly.
 */
export type PitchSelfTestExpectation = 'pitch' | 'pitch-or-refusal' | 'refusal' | 'known-limitation';

export interface PitchSelfTestCase {
  name: string;
  wave: PitchSelfTestWave;
  hz: number;
  sampleRate: number;
  /** What came back, or null when the detector refused to name a note. */
  gotHz: number | null;
  noteName: string | null;
  clarity: number;
  /** Signed error against the note that was synthesised. Null when nothing was reported. */
  errorCents: number | null;
  /**
   * Where the case came from. `basamak` cases are ports of `tests/TunerTest.cpp`, signal and
   * all — see the lineage note in this file's header.
   */
  source: 'riffsheet' | 'basamak';
  /** The pass mark for THIS case, in cents. BASAMAK's cases carry BASAMAK's 3. */
  toleranceCents: number;
  expect: PitchSelfTestExpectation;
  /**
   * Whether this case's error feeds `worstCents` / `medianCents`.
   *
   * False only where a cents error is not a meaningful number: silence, and the two-notes case
   * whose "reference" is whichever of two real notes the detector named. Both are still in
   * `cases` with everything they measured, and both still set `pass`, so nothing is hidden —
   * they are kept out of the AVERAGES, not out of the report.
   */
  graded: boolean;
  pass: boolean;
  /** Why the case exists, or what limitation it documents. */
  note?: string;
}

export interface PitchSelfTestResult {
  cases: PitchSelfTestCase[];
  /**
   * Cases that were required to name a note and did not — a failure of a different kind from
   * being wrong.
   *
   * Cases whose `expect` allows a refusal do not count here, and that is not a loophole: there
   * are exactly two of them, both documented, and both still fail loudly if they name the
   * WRONG note. Every case that existed before this field did is `expect: 'pitch'`, so the
   * number means what it always meant.
   */
  missed: number;
  /** Worst absolute error over the graded cases that named a note. */
  worstCents: number;
  /** Median absolute error over the same. */
  medianCents: number;
  /** How many cases fed `worstCents` / `medianCents`. */
  graded: number;
  /** Cases that answered "I cannot tell" — correct for silence and for a dyad. */
  refusals: number;
  /**
   * Cases that missed their own tolerance, or answered something they were not allowed to.
   * Known limitations are NOT counted here — they are in `limitations`.
   */
  failed: number;
  /** One line per failure, so a red build says what broke without a debugger. */
  failures: string[];
  /**
   * The answers this detector is known to get wrong, with what it actually said. Always
   * populated; not a regression signal. See the `known-limitation` expectation.
   */
  limitations: string[];
  /**
   * BASAMAK's own accuracy lock, scored on its own terms — its signal, its rate, its window,
   * its 3-cent bar. This is the number to quote when asked "is ours as good as BASAMAK's".
   */
  basamak: { cases: number; passed: number; worstCents: number };
}

/**
 * Synthesise tones we know the frequency of and see what comes back.
 *
 * This exists so that nobody — including whoever wrote it — has to take the accuracy of this
 * file on trust. It is deterministic, it needs no files and no audio device, and it runs in
 * about 0.4 s on an idle machine (node 22, M-series; it was 0.26 s at 60 cases and is 81 now).
 * Wire it to a probe or bundle it and run it under node; either way the numbers in any claim
 * about this detector should come from here.
 *
 * Three families, in `labTones`, `basamakTones` and `recordingTones`:
 *
 *  1. The lab sweep — sines and sawtooths across the whole range at three sample rates. A
 *     sawtooth is what a plucked string looks like to this algorithm (all the harmonics
 *     present), which is the material that makes plain autocorrelation report an octave low.
 *  2. BASAMAK's accuracy lock, ported whole. Its signal, its rate, its window, its 3-cent bar.
 *  3. The cases only a RECORDING has: a decaying pluck, a note ringing under another, and a
 *     selection that starts in the middle of a note.
 *
 * Every case carries its own tolerance and its own `pass`, and `failures` names anything that
 * missed. The aggregate `worstCents` / `medianCents` are over the graded cases only — see the
 * `graded` field for exactly which two are not, and why keeping them out of an AVERAGE is not
 * the same as keeping them out of the report.
 *
 * WHAT THIS FILE CANNOT TEST, and where to go when that matters. Every case here is
 * synthesised, because `selfTest()` has to run in a browser on every build with no files and no
 * audio device. Synthetic tones are not evidence about what real instruments radiate — the
 * "WHAT WAS TRIED HERE" block above `SILENCE_RMS` records a guard that passed all 60 cases
 * here and silenced a real
 * recorded guitar B4, and it was only caught by running the detector over the 19 real notes
 * already in the repo (`public/samples/finger-bass/`, `public/samples/electric-guitar/`). That
 * is a ten-line node script, it is not deterministic enough to assert on (the samples carry
 * their own tuning: the guitar set reads a consistent +8 to +15 cents sharp), and it should be
 * run by hand before anyone changes a threshold in this file.
 */
export function selfTest(): PitchSelfTestResult {
  const cases: PitchSelfTestCase[] = [];
  for (const c of labTones()) cases.push(c);
  for (const c of basamakTones()) cases.push(c);
  for (const c of recordingTones()) cases.push(c);

  const errors = cases
    .filter((c) => c.graded && c.errorCents !== null)
    .map((c) => Math.abs(c.errorCents as number))
    .sort((a, b) => a - b);
  const failures = cases
    .filter((c) => !c.pass && c.expect !== 'known-limitation')
    .map((c) => describeFailure(c));
  const limitations = cases
    .filter((c) => c.expect === 'known-limitation')
    .map((c) => `${c.name}: reads ${c.noteName ?? 'nothing'} (${c.errorCents ?? '-'} cents) — ${c.note ?? ''}`);
  const basamakCases = cases.filter((c) => c.source === 'basamak');
  const basamakErrors = basamakCases
    .filter((c) => c.errorCents !== null)
    .map((c) => Math.abs(c.errorCents as number));

  return {
    cases,
    missed: cases.filter((c) => c.expect === 'pitch' && c.gotHz === null).length,
    worstCents: errors.length ? Number(errors[errors.length - 1].toFixed(2)) : 0,
    medianCents: errors.length ? Number(errors[(errors.length - 1) >> 1].toFixed(2)) : 0,
    graded: errors.length,
    refusals: cases.filter((c) => c.gotHz === null).length,
    failed: failures.length,
    failures,
    limitations,
    basamak: {
      cases: basamakCases.length,
      passed: basamakCases.filter((c) => c.pass).length,
      worstCents: basamakErrors.length ? Number(Math.max(...basamakErrors).toFixed(2)) : 0
    }
  };
}

function describeFailure(c: PitchSelfTestCase): string {
  if (c.expect === 'refusal') return `${c.name}: named ${c.noteName ?? '?'} where there is no note`;
  if (c.gotHz === null) return `${c.name}: no note found`;
  return `${c.name}: ${c.errorCents} cents, over its ${c.toleranceCents}-cent bar`;
}

// --- scoring ---------------------------------------------------------------

/**
 * Run one buffer and score it.
 *
 * `refs` is every frequency the case considers a correct answer — one for an ordinary tone,
 * two for the case where a second note is ringing underneath. The error is measured against
 * the NEAREST of them, because with two real notes in the buffer "wrong by a fourth" is not a
 * meaningful error but "wrong by an octave and a fifth, to a note nobody played" is, and this
 * is the way to keep the second one visible in `worstCents` where it belongs.
 */
function score(spec: {
  name: string;
  wave: PitchSelfTestWave;
  pcm: Float32Array;
  sampleRate: number;
  refs: number[];
  toleranceCents: number;
  expect?: PitchSelfTestExpectation;
  graded?: boolean;
  source?: 'riffsheet' | 'basamak';
  note?: string;
}): PitchSelfTestCase {
  const expect = spec.expect ?? 'pitch';
  const got = detectPitch(spec.pcm, spec.sampleRate);
  let errorCents: number | null = null;
  if (got.hz !== null) {
    for (const ref of spec.refs) {
      const e = Number((1200 * Math.log2(got.hz / ref)).toFixed(2));
      if (errorCents === null || Math.abs(e) < Math.abs(errorCents)) errorCents = e;
    }
  }

  let pass: boolean;
  if (expect === 'refusal') pass = got.hz === null;
  else if (got.hz === null) pass = expect === 'pitch-or-refusal';
  else pass = errorCents !== null && Math.abs(errorCents) <= spec.toleranceCents;
  // A known limitation records what it does; `pass` still says whether it did the right thing,
  // so the day it starts passing is visible in the case even though it never went red.

  return {
    name: spec.name,
    wave: spec.wave,
    hz: spec.refs[0] ?? 0,
    sampleRate: spec.sampleRate,
    gotHz: got.hz,
    noteName: got.noteName,
    clarity: got.clarity,
    errorCents,
    source: spec.source ?? 'riffsheet',
    toleranceCents: spec.toleranceCents,
    expect,
    graded: spec.graded ?? true,
    pass,
    note: spec.note
  };
}

// --- the three families of case --------------------------------------------

/**
 * The original lab sweep: ten notes from B0 to A5, sine and saw, at three sample rates.
 *
 * Sawtooths as well as sines because a sawtooth is what a plucked string looks like to this
 * algorithm: all the harmonics present, which is precisely the material that makes plain
 * autocorrelation report an octave too low.
 *
 * The 10-cent bar here is the same deliberately loose tripwire the build harness uses; the
 * real standard these hold to is the median, which is two hundredths of a cent.
 */
function labTones(): PitchSelfTestCase[] {
  const tones: Array<{ name: string; hz: number }> = [
    { name: 'B0', hz: midiToHz(23) },
    { name: 'E1', hz: midiToHz(28) },
    { name: 'A1', hz: midiToHz(33) },
    { name: 'E2', hz: midiToHz(40) },
    { name: 'A2', hz: midiToHz(45) },
    { name: 'D3', hz: midiToHz(50) },
    { name: 'A3', hz: midiToHz(57) },
    { name: 'A4', hz: midiToHz(69) },
    { name: 'E5', hz: midiToHz(76) },
    { name: 'A5', hz: midiToHz(81) }
  ];
  const out: PitchSelfTestCase[] = [];
  for (const rate of [22050, 44100, 48000]) {
    for (const tone of tones) {
      for (const wave of ['sine', 'saw'] as const) {
        out.push(
          score({
            name: `${tone.name} ${wave} @${rate}`,
            wave,
            pcm: synth(wave, tone.hz, rate, 0.35),
            sampleRate: rate,
            refs: [tone.hz],
            toleranceCents: 10
          })
        );
      }
    }
  }
  return out;
}

/** BASAMAK's window: 2048 samples at 24 kHz, which is `DECIM 4` off a 96 kHz engine. */
const BASAMAK_RATE = 24000;
const BASAMAK_WINDOW = 2048;
/** BASAMAK's own bar on its plain tones, and the one we hold ALL of its cases to. */
const BASAMAK_TOLERANCE_CENTS = 3;
/**
 * BASAMAK's test is looser on its three harmonic-rich cases — `< 5.0` rather than `< 3.0` —
 * presumably because it did not need the margin proved. We hold them to 3 anyway, because we
 * measure 0.00 on all three and adopting a slacker bar we do not need would only hide a future
 * regression. Recorded here so that nobody later reads "3" as a claim about BASAMAK's code.
 */
const BASAMAK_RICH_TOLERANCE_CENTS = 5;

/**
 * `tests/TunerTest.cpp`, ported case for case.
 *
 * The synthesis is BASAMAK's, not ours, and that is the point: same saw-plus-harmonics
 * material, same 24 kHz, same 2048-sample buffer. Our detector reads a 1746-sample frame out of
 * that buffer (2 / FMIN_HZ at 24 kHz) rather than all 2048, which if anything gives it less to
 * work with than BASAMAK had.
 */
function basamakTones(): PitchSelfTestCase[] {
  const rate = BASAMAK_RATE;
  const n = BASAMAK_WINDOW;
  const plain = (hz: number, name: string, note?: string) =>
    score({
      name,
      wave: 'basamak-saw',
      pcm: basamakSaw(hz, rate, n),
      sampleRate: rate,
      refs: [hz],
      toleranceCents: BASAMAK_TOLERANCE_CENTS,
      source: 'basamak',
      note
    });
  const rich = (hz: number, h2: number, h3: number, name: string, note: string) =>
    score({
      name,
      wave: 'harmonics',
      pcm: basamakRich(hz, h2, h3, rate, n),
      sampleRate: rate,
      refs: [hz],
      toleranceCents: BASAMAK_TOLERANCE_CENTS,
      source: 'basamak',
      note: `${note} (BASAMAK's own test allows ${BASAMAK_RICH_TOLERANCE_CENTS} cents here; we hold 3)`
    });

  const out: PitchSelfTestCase[] = [
    plain(110, 'BASAMAK A2 (bass)'),
    plain(261.626, 'BASAMAK C4 (middle C)'),
    plain(261.626 * Math.pow(2, 0.3 / 12), 'BASAMAK C4 +30 cents', 'a detuned tone must read as detuned, not snap to the note'),
    plain(440, 'BASAMAK A4'),
    plain(65.406, 'BASAMAK C2 (low bass)'),
    // The 2026-07-19 cases. A second harmonic LOUDER than the fundamental is what a plucked
    // guitar or bass actually is, and it is what broke BASAMAK's old fixed-threshold peak rule
    // into reading an octave high. See the lineage note in this file's header.
    rich(110, 0.55, 0.3, 'BASAMAK A2 loud 2nd', '2nd harmonic louder than the root'),
    rich(82.407, 0.5, 0.45, 'BASAMAK E2 gtr-like', 'low guitar E, rich stack'),
    rich(41.203, 0.55, 0.35, 'BASAMAK E1 bass loud2', 'bass low E, loud 2nd'),
    score({
      name: 'BASAMAK silence',
      wave: 'silence',
      pcm: new Float32Array(n),
      sampleRate: rate,
      refs: [],
      toleranceCents: 0,
      expect: 'refusal',
      graded: false,
      source: 'basamak',
      note: 'silence must report no pitch at all — the strip shows "-"'
    })
  ];

  // Not BASAMAK's, but the case BASAMAK's comment DESCRIBES.
  //
  // Worth writing down, because it changes what the three cases above prove: run the numbers on
  // BASAMAK's own `testRich` signals and their NSDF at the half period is about 0.03 to 0.10 —
  // nowhere near the 0.62 that its old rule tripped on. They lock the BEHAVIOUR (read the root,
  // never the octave) but they do not actually reconstruct the trap; the signal that found it
  // was a real recording, through a user's ears, against GTune.
  //
  // So here is a tone that does reconstruct it: a nearly hollow fundamental (0.10) under a
  // dominant second harmonic (0.60). Measured NSDF at the half period is 0.73 — genuinely above
  // the threshold that broke BASAMAK. It is the hardest octave case in this file and it is the
  // one to keep if any are ever dropped.
  for (const [rate2, seconds] of [
    [BASAMAK_RATE, BASAMAK_WINDOW / BASAMAK_RATE],
    [44100, 0.25]
  ] as const) {
    for (const hz of [82.407, 220]) {
      out.push(
        score({
          name: `hollow fundamental ${hz.toFixed(0)}Hz @${rate2}`,
          wave: 'harmonics',
          pcm: partials(hz, rate2, Math.round(seconds * rate2), [0.1, 0.6, 0.22, 0.12], [0, 0.7, 1.9, 2.6]),
          sampleRate: rate2,
          refs: [hz],
          toleranceCents: BASAMAK_TOLERANCE_CENTS,
          note: 'the 2026-07-19 octave trap, actually reconstructed: NSDF at the half period is 0.73'
        })
      );
    }
  }
  return out;
}

/**
 * The cases BASAMAK has no reason to have, because BASAMAK reads a LIVE input and this reads a
 * RECORDING. A player drags a box over whatever they like: a note that is dying away, a note
 * with the last one still under it, or a stretch that begins in the middle of something.
 */
function recordingTones(): PitchSelfTestCase[] {
  const rate = 44100;
  const out: PitchSelfTestCase[] = [];

  // 1. A pluck, not a steady tone: the level falls by 90% across the selection, so the late
  //    frames are quiet and the very last ones fall under the silence gate. The vote in
  //    `summarise` is what carries this — the loud early frames outvote whatever the tail does.
  const e2 = new Float32Array(Math.round(0.8 * rate));
  addPluck(e2, 82.407, rate, 0, 1, 0.45, 0);
  out.push(
    score({
      name: 'pluck E2, decaying',
      wave: 'pluck',
      pcm: e2,
      sampleRate: rate,
      refs: [82.407],
      toleranceCents: BASAMAK_TOLERANCE_CENTS,
      note: 'a struck string with an exponential decay, not a steady tone'
    })
  );

  const a3 = new Float32Array(Math.round(0.7 * rate));
  addPluck(a3, 220, rate, 0, 1, 0.25, 0);
  out.push(
    score({
      name: 'pluck A3, fast decay',
      wave: 'pluck',
      pcm: a3,
      sampleRate: rate,
      refs: [220],
      toleranceCents: BASAMAK_TOLERANCE_CENTS,
      note: 'decays to near nothing inside the selection'
    })
  );

  // 2. A new note over one that is still ringing. Two versions, because the answer changes:
  //
  //    (a) the old note has decayed — the new one dominates and is read exactly. This is the
  //        ordinary case and it must be right.
  const ringingQuiet = new Float32Array(Math.round(0.7 * rate));
  addPluck(ringingQuiet, 110, rate, 0, 1, 0.7, 0.9); // A2, struck 0.9 s ago
  addPluck(ringingQuiet, 146.832, rate, 0, 1, 0.7, 0); // D3, struck now
  out.push(
    score({
      name: 'D3 over a decayed A2',
      wave: 'two-notes',
      pcm: ringingQuiet,
      sampleRate: rate,
      refs: [146.832],
      toleranceCents: BASAMAK_TOLERANCE_CENTS,
      note: 'the ringing note is well down; the struck note must win'
    })
  );

  //    (b) both notes are comparably loud — and this one WE GET WRONG. A2 and D3 are a fourth
  //        apart: 110 and 146.83 Hz share a genuine common period at 110/3 = 36.7 Hz, and the
  //        composite waveform really does repeat there, so the reading is D1 — an octave and a
  //        fifth below anything played, at a clarity of 0.999, in every frame of the selection.
  //        It is not a coding error; it is the period of the signal it was handed, and BASAMAK's
  //        detector does the same thing on the same buffer.
  //
  //        A guard against it was built and thrown away — see the "WHAT WAS TRIED HERE" block above
  //        `SILENCE_RMS` for the measurements that killed it. Until something better exists, this
  //        is a documented limitation: a selection with two notes sounding together can name a
  //        note nobody played. `ui/tuner.ts`'s clarity display does not save the user here,
  //        because the phantom reads as CLEARER than a real note, not less clear.
  const ringingLoud = new Float32Array(Math.round(0.7 * rate));
  addPluck(ringingLoud, 110, rate, 0, 1, 0.7, 0.35);
  addPluck(ringingLoud, 146.832, rate, 0, 1, 0.7, 0);
  out.push(
    score({
      name: 'D3 over a loud ringing A2',
      wave: 'two-notes',
      pcm: ringingLoud,
      sampleRate: rate,
      refs: [146.832, 110],
      toleranceCents: 50,
      expect: 'known-limitation',
      graded: false,
      note: 'two notes a fourth apart share a real common period at 110/3 Hz, and it wins'
    })
  );

  //    (c) THE OCTAVE-UP CASE, and the most important thing in this function. These partial
  //        amplitudes are not invented: they were measured off the sustain of the real
  //        `public/samples/steel-guitar/E2.wav`, where the fundamental is 4% of the second
  //        harmonic and the third is 16%. This is BASAMAK's 2026-07-19 harmonic-dominant class
  //        taken further than BASAMAK's own test cases go, and it is where YIN finally breaks:
  //        the normalised difference at HALF the period is 2*(odd partial energy)/(total), and
  //        with every odd partial that quiet it comes to 0.075 — under `YIN_THRESHOLD`, so the
  //        absolute-threshold rule stops there and reports E3.
  //
  //        BASAMAK's MPM reads the equivalent real recording correctly on one of the two files
  //        where we do not, so this is the one place its algorithm is genuinely better. It was
  //        not worth porting for: over 65 real notes ours is right on 62 and a transcription of
  //        BASAMAK's is right on 58, and lowering `YIN_THRESHOLD` to catch this trades one
  //        octave-up error for several octave-DOWN ones (numbers in the "WHAT WAS TRIED
  //        HERE" block above `SILENCE_RMS`). Recorded, reproducible, and not swept up.
  out.push(
    score({
      name: 'harmonic-dominant E2, odd partials near zero',
      wave: 'harmonics',
      pcm: partials(82.407, rate, Math.round(0.25 * rate), [0.04, 1.0, 0.16, 0.27, 0.12, 0.05], [0, 0.7, 1.9, 2.6, 0.4, 1.3]),
      sampleRate: rate,
      refs: [82.407],
      toleranceCents: BASAMAK_TOLERANCE_CENTS,
      expect: 'known-limitation',
      graded: false,
      note: 'measured off real steel-guitar E2; reads an octave high, as BASAMAK 2026-07-19 warned'
    })
  );

  // 3. A selection that starts mid-note: no attack, no onset, just the middle of a decay. The
  //    tuner has no transient to align to and never needed one, so this is a plain read — but
  //    it is worth locking, because a detector that quietly depended on an onset would pass
  //    every other case in this file and fail every real drag a player makes.
  const long = new Float32Array(Math.round(1.2 * rate));
  addPluck(long, 220, rate, 0, 1, 0.5, 0);
  out.push(
    score({
      name: 'A3 selection starts mid-note',
      wave: 'pluck',
      pcm: long.subarray(Math.round(0.42 * rate)) as Float32Array,
      sampleRate: rate,
      refs: [220],
      toleranceCents: BASAMAK_TOLERANCE_CENTS,
      note: 'the drag began after the attack — sustain only'
    })
  );
  out.push(
    score({
      name: 'A3 short slice from mid-note',
      wave: 'pluck',
      pcm: long.subarray(Math.round(0.42 * rate), Math.round(0.54 * rate)) as Float32Array,
      sampleRate: rate,
      refs: [220],
      toleranceCents: BASAMAK_TOLERANCE_CENTS,
      note: '120 ms out of the middle of a note — about two frames'
    })
  );

  // 4. A selection that spans a note change. `detectPitch` votes, so it reports the note that
  //    takes up most of the selection; `detectPitchTrack` — which is what `ui/tuner.ts` calls —
  //    shows both, in order. The reference here is the second note, because it holds 70% of the
  //    buffer, and that is the documented contract of `detectPitch`.
  const change = new Float32Array(Math.round(1.0 * rate));
  addPluck(change, 110, rate, 0, 1, 0.5, 0.3); // tail of an A2
  addPluck(change, 164.814, rate, 0.3, 1, 0.5, 0); // E3 struck 0.3 s in
  out.push(
    score({
      name: 'A2 tail, then E3',
      wave: 'two-notes',
      pcm: change,
      sampleRate: rate,
      refs: [164.814],
      toleranceCents: BASAMAK_TOLERANCE_CENTS,
      note: 'one selection, two notes in sequence — the longer one is the headline'
    })
  );

  return out;
}

// --- synthesis, all deterministic ------------------------------------------

/**
 * A test tone. Phase starts at a fixed offset rather than zero so a frame boundary never
 * lands on a zero crossing by luck and flatters the result.
 */
function synth(wave: 'sine' | 'saw', hz: number, sampleRate: number, seconds: number): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  const step = hz / sampleRate;
  let phase = 0.137;
  for (let i = 0; i < n; i++) {
    out[i] = wave === 'sine' ? Math.sin(2 * Math.PI * phase) * 0.5 : (2 * (phase % 1) - 1) * 0.4;
    phase += step;
    if (phase >= 1e6) phase -= 1e6;
  }
  return out;
}

/**
 * BASAMAK's `testTone`, transcribed exactly: `0.6 * (2t - 1) + 0.2 * sin(4*pi*ph)`.
 *
 * A saw with a second harmonic mixed on top — "guitar-ish, not a lab sine", in its words. The
 * phase is advanced BEFORE the sample is taken, as in the C++, so the first sample is not zero.
 * Do not tidy this into our own `synth`: the whole value of these cases is that the signal is
 * BASAMAK's and the comparison is like for like.
 */
function basamakSaw(hz: number, sampleRate: number, n: number): Float32Array {
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += hz / sampleRate;
    const t = ph - Math.floor(ph);
    out[i] = 0.6 * (2 * t - 1) + 0.2 * Math.sin(4 * Math.PI * ph);
  }
  return out;
}

/** BASAMAK's `testRich`: `0.4*sin(w) + h2*sin(2w + 0.7) + h3*sin(3w + 1.9)`, transcribed. */
function basamakRich(hz: number, h2: number, h3: number, sampleRate: number, n: number): Float32Array {
  return partials(hz, sampleRate, n, [0.4, h2, h3], [0, 0.7, 1.9]);
}

/** A sum of harmonics with chosen amplitudes and fixed phases. */
function partials(
  hz: number,
  sampleRate: number,
  n: number,
  amps: readonly number[],
  phases: readonly number[]
): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * hz * i) / sampleRate;
    let v = 0;
    for (let k = 0; k < amps.length; k++) v += amps[k] * Math.sin((k + 1) * w + phases[k]);
    out[i] = v;
  }
  return out;
}

/** A plucked string's partials: quiet fundamental, LOUDER second, then falling away. */
const PLUCK_AMPS = [0.4, 0.55, 0.3, 0.16, 0.09, 0.05] as const;
const PLUCK_PHASES = [0, 0.7, 1.9, 2.6, 0.4, 1.3] as const;

/**
 * Add a struck note to a buffer: the pluck partials under an exponential decay.
 *
 * `ageSec` is how long the note has ALREADY been ringing when the buffer starts, which is how
 * a note that is still sounding under a new one is built — the same synthesis, further down its
 * own decay. Adding rather than assigning is what lets two of them overlap.
 */
function addPluck(
  out: Float32Array,
  hz: number,
  sampleRate: number,
  startSec: number,
  amp: number,
  decaySec: number,
  ageSec: number
): void {
  const s0 = Math.round(startSec * sampleRate);
  for (let i = s0; i < out.length; i++) {
    const t = (i - s0) / sampleRate + ageSec;
    const env = Math.exp(-t / decaySec);
    const w = 2 * Math.PI * hz * t;
    let v = 0;
    for (let k = 0; k < PLUCK_AMPS.length; k++) v += PLUCK_AMPS[k] * Math.sin((k + 1) * w + PLUCK_PHASES[k]);
    out[i] += amp * env * v;
  }
}
