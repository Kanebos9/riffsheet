/**
 * STATION 3a — KEY SIGNATURE.
 *
 * WRITTEN (~60 lines plus one table of numbers), per midi-semantics-research.md §1.7: there is
 * no maintained JS/TS symbolic key-detection library, and the profile tables are just numbers.
 * The Bellman-Budge vectors are transcribed from music21's `analysis/discrete.py` (BSD-3),
 * which ships the same five sets Humdrum `keycor` documents.
 *
 * THREE DECISIONS FROM THE RESEARCH, ALL OF WHICH MATTER MORE THAN THE ALGORITHM:
 *
 * 1. BELLMAN-BUDGE, not Krumhansl-Kessler and not music21's AardenEssen default (§1.2). It is
 *    the only classic profile set whose documented bias is "no particular tendencies for
 *    confusions with neighbouring keys". KK's documented bias is "dominant as tonic", which is
 *    precisely the error a root-and-fifth-heavy bass line provokes.
 *
 * 2. FIFTEEN-WAY, not 24-way (§1.3). Notation needs a key SIGNATURE, not a key, and relative
 *    major and minor share one. Collapsing removes the largest documented error class for free.
 *
 * 3. A WRONG SIGNATURE IS FAR WORSE THAN NONE (§1.4). Riffs are short, modal and root-heavy —
 *    the three conditions key detection handles worst. Two independent estimators must AGREE
 *    (§1.6) and clear a confidence gate, or the answer is `<fifths>0</fifths>` open key, which
 *    is a normal publishable choice for rock/pop and is never *wrong*, only occasionally verbose.
 */

import type { IRKeySignature } from './ir.js';

/** music21 `BellmanBudge`, duration-weighted (§1.2). */
const BB_MAJOR = [16.8, 0.86, 12.95, 1.41, 13.49, 11.93, 1.25, 20.28, 1.8, 8.04, 0.62, 10.57];
const BB_MINOR = [18.16, 0.69, 12.99, 13.34, 1.07, 11.15, 1.38, 21.07, 7.49, 1.53, 0.92, 10.21];

/** §1.4: the gate. */
// The score is the mean of the relative major/minor correlations, not either raw profile.
// On that collapsed scale, real duration-weighted diatonic takes cluster around 0.59; keeping
// the old single-profile 0.75 threshold made the agreement and margin gates unreachable.
export const KEY_MIN_CORRELATION = 0.55;
export const KEY_MIN_MARGIN = 0.05;
export const KEY_MIN_BARS = 8;
export const KEY_MIN_SECONDS = 15;
/** Our own number: below this major/minor margin we omit <mode> entirely (it is optional). */
const MODE_MARGIN = 0.1;

const FIFTHS_LABEL: Record<number, string> = {
  [-7]: 'Cb / Ab minor',
  [-6]: 'Gb / Eb minor',
  [-5]: 'Db / Bb minor',
  [-4]: 'Ab / F minor',
  [-3]: 'Eb / C minor',
  [-2]: 'Bb / G minor',
  [-1]: 'F / D minor',
  0: 'C / A minor',
  1: 'G / E minor',
  2: 'D / B minor',
  3: 'A / F# minor',
  4: 'E / C# minor',
  5: 'B / G# minor',
  6: 'F# / D# minor',
  7: 'C# / A# minor'
};

export interface KeyInput {
  midi: number;
  /** Duration weight. Seconds or beats — only the ratios matter. */
  weight: number;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

function rotate(profile: number[], tonic: number): number[] {
  return profile.map((_, i) => profile[(i - tonic + 12 + 12) % 12]);
}

/** Major tonic pitch class for a key signature. fifths=1 -> G, fifths=-1 -> F. */
export function majorTonicOf(fifths: number): number {
  return ((fifths * 7) % 12 + 12) % 12;
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

/** The two natural semitone steps of a major scale: degrees 3-4 and 7-8. */
function naturalSemitonePairs(fifths: number): [number, number][] {
  const t = majorTonicOf(fifths);
  return [
    [(t + 4) % 12, (t + 5) % 12],
    [(t + 11) % 12, t % 12]
  ];
}

function scaleSet(fifths: number): Set<number> {
  const t = majorTonicOf(fifths);
  return new Set(MAJOR_SCALE.map((d) => (t + d) % 12));
}

/**
 * §1.6 — MuseScore's `importmidi_key.cpp` `findKey()`, crediting Kilian (2004): count SEMITONE
 * TRANSITIONS rather than pitch classes. Genuinely different evidence, and insensitive to the
 * root-heaviness that breaks a duration-weighted histogram on bass lines — a pedal E generates
 * no semitone transitions at all.
 */
export function semitoneTransitionScores(midis: number[]): Map<number, number> {
  const scores = new Map<number, number>();
  for (let f = -7; f <= 7; f++) {
    const pairs = naturalSemitonePairs(f);
    const inScale = scaleSet(f);
    let score = 0;
    for (let i = 1; i < midis.length; i++) {
      if (Math.abs(midis[i] - midis[i - 1]) !== 1) continue;
      const a = ((midis[i - 1] % 12) + 12) % 12;
      const b = ((midis[i] % 12) + 12) % 12;
      const natural = pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
      if (natural) score += 2;
      else if (inScale.has(a) && inScale.has(b)) score += 0; // impossible in a major scale
      else score -= 1; // a chromatic semitone: evidence against this signature
    }
    scores.set(f, score);
  }
  return scores;
}

export interface DetectKeyOptions {
  bars: number;
  durationSec: number;
}

export function detectKey(notes: KeyInput[], opts: DetectKeyOptions): IRKeySignature {
  const empty: IRKeySignature = {
    fifths: 0,
    confidence: 0,
    accepted: false,
    candidates: [{ fifths: 0, score: 0, label: FIFTHS_LABEL[0] }],
    reason: 'no pitched material'
  };
  if (!notes.length) return empty;

  // duration-weighted pitch-class distribution (§1.1 — the standard, not note counting)
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[((n.midi % 12) + 12) % 12] += Math.max(0, n.weight);
  if (hist.every((h) => h === 0)) return empty;

  // 15-way collapsed scoring: mean of the major correlation and its relative minor's. This
  // compressed scale is why KEY_MIN_CORRELATION is calibrated separately from a raw profile.
  const scored = [];
  for (let f = -7; f <= 7; f++) {
    const majTonic = majorTonicOf(f);
    const minTonic = (majTonic + 9) % 12;
    const cMaj = pearson(hist, rotate(BB_MAJOR, majTonic));
    const cMin = pearson(hist, rotate(BB_MINOR, minTonic));
    scored.push({ fifths: f, score: (cMaj + cMin) / 2, cMaj, cMin });
  }
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];
  const candidates = scored.slice(0, 3).map((s) => ({
    fifths: s.fifths,
    score: Number(s.score.toFixed(4)),
    label: FIFTHS_LABEL[s.fifths]
  }));

  const transitions = semitoneTransitionScores(notes.map((n) => n.midi));
  let bestTransition = -7;
  let bestTransitionScore = -Infinity;
  for (const [f, s] of transitions) {
    if (s > bestTransitionScore) {
      bestTransitionScore = s;
      bestTransition = f;
    }
  }
  // A flat transition landscape (no semitone motion at all) is not disagreement, it is silence.
  const transitionInformative = [...transitions.values()].some((v) => v !== 0);

  const reasons: string[] = [];
  if (top.score < KEY_MIN_CORRELATION) reasons.push(`top-1 ${top.score.toFixed(3)} < ${KEY_MIN_CORRELATION}`);
  if (top.score - second.score < KEY_MIN_MARGIN) {
    reasons.push(`margin ${(top.score - second.score).toFixed(3)} < ${KEY_MIN_MARGIN}`);
  }
  if (opts.bars < KEY_MIN_BARS && opts.durationSec < KEY_MIN_SECONDS) {
    reasons.push(`only ${opts.bars} bars / ${opts.durationSec.toFixed(1)}s`);
  }
  if (transitionInformative && bestTransition !== top.fifths) {
    reasons.push(`semitone-transition estimator says ${bestTransition}, correlation says ${top.fifths}`);
  }

  if (reasons.length) {
    return {
      fifths: 0,
      confidence: Number(top.score.toFixed(4)),
      accepted: false,
      candidates,
      reason: `open key: ${reasons.join('; ')}`
    };
  }

  const modeMargin = Math.abs(top.cMaj - top.cMin);
  return {
    fifths: top.fifths,
    ...(modeMargin >= MODE_MARGIN ? { mode: top.cMaj > top.cMin ? ('major' as const) : ('minor' as const) } : {}),
    confidence: Number(top.score.toFixed(4)),
    accepted: true,
    candidates
  };
}
