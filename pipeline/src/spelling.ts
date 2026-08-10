/**
 * STATION 3b — ENHARMONIC SPELLING, then ACCIDENTAL DISPLAY.
 *
 * These are TWO decisions and the research is emphatic that they are separate (§2.6):
 * choosing F# over Gb is not the same problem as deciding whether to print the sharp sign, and
 * getting the second one wrong is more visible — a missing accidental makes the note read as
 * the wrong pitch.
 *
 * PART 1 — SPELLING. Re-implemented from MuseScore's `Score::spellNotelist()`
 * (`src/engraving/dom/pitchspelling.cpp`, GPL-3.0), which implements Cambouropoulos,
 * "Automatic Pitch Spelling: From Numbers to Sharps and Flats" (§2.3):
 *   - WINDOW = 9 notes, sliding with a stride of 3, middle window's verdict kept;
 *   - brute-force all 512 (= 2^9) sharp/flat combinations, lowest penalty wins;
 *   - penalty = 4 x (key-signature table) + interval penalty over ALL pairs in the window.
 *
 * TWO DELIBERATE DEPARTURES:
 *   - The 15 x 34 `enharmonicSpelling` table is replaced by a line-of-fifths distance rule
 *     computed FROM the detected key signature. MuseScore's own users' standing complaint is
 *     that it "doesn't consistently consider circle-of-fifths relationships to the key
 *     signature" (§2.3); the research says to fix that on the way in.
 *   - Double sharps and flats are not candidates at all. "A bass part with an F## is a bug
 *     report" (§2.4).
 * Plus §2.4's directional rule (sharps ascending, flats descending) as a tiebreak.
 *
 * PART 2 — DISPLAY. Ported from music21's `Pitch.updateAccidentalDisplay` cascade (BSD-3,
 * §2.6), keeping the documented defaults `cautionaryPitchClass=true` and
 * `cautionaryNotImmediateRepeat=true`: erring toward MORE courtesy accidentals is the right
 * bias for a chart a player reads at a music stand.
 */

import type { AccidentalName, StepName } from './ir.js';

const LOF_LETTERS: StepName[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];

/** Line-of-fifths position ("tonal pitch class"). C = 0, G = 1, F = -1, F# = 6, Bb = -2. */
export type Tpc = number;

export function tpcToStep(tpc: Tpc): StepName {
  return LOF_LETTERS[(((tpc + 1) % 7) + 7) % 7];
}
export function tpcToAlter(tpc: Tpc): number {
  return Math.floor((tpc + 1) / 7);
}
export function tpcToPitchClass(tpc: Tpc): number {
  return (((tpc * 7) % 12) + 12) % 12;
}
export function tpcToOctave(tpc: Tpc, midi: number): number {
  // A natural-letter reference keeps Cb4 (sounding B3) and B#3 (sounding C4) correct.
  return Math.floor((midi - tpcToAlter(tpc)) / 12) - 1;
}

/**
 * The at-most-two sensible spellings of each pitch class: the sharp-side and the flat-side
 * candidate, with no double accidentals. Keeping it to two per note is what makes
 * Cambouropoulos's 2^9 = 512 search exact rather than approximate.
 */
const CANDIDATES: Tpc[][] = [
  [0, 12], // C  / B#
  [7, -5], // C# / Db
  [2, 2], // D
  [9, -3], // D# / Eb
  [4, -8], // E  / Fb
  [-1, 11], // F  / E#
  [6, -6], // F# / Gb
  [1, 1], // G
  [8, -4], // G# / Ab
  [3, 3], // A
  [10, -2], // A# / Bb
  [5, -7] // B  / Cb
];

/** `int intervalPenalty[13] = { 0,0,0,0,0,0,1,3,1,1,1,3,3 };` — rare intervals are punished. */
const INTERVAL_PENALTY = [0, 0, 0, 0, 0, 0, 1, 3, 1, 1, 1, 3, 3];

/** MuseScore weights the key-signature table x4 against the interval term. */
const KEY_WEIGHT = 4;
/** Cambouropoulos's second principle: notational parsimony (minimise printed accidentals). */
const PARSIMONY_WEIGHT = 0.5;
/** §2.4 directional rule, applied as a tiebreak rather than a hard constraint. */
const DIRECTION_WEIGHT = 0.25;

const WINDOW = 9;
const STRIDE = 3;

function keyPenalty(tpc: Tpc, fifths: number): number {
  if (Math.abs(tpcToAlter(tpc)) >= 2) return 100;
  // the seven diatonic degrees of this signature occupy [fifths-1, fifths+5] on the line
  if (tpc >= fifths - 1 && tpc <= fifths + 5) return 0;
  if (tpc >= fifths - 6 && tpc <= fifths + 10) return 1;
  return 100;
}

function windowPenalty(tpcs: Tpc[], midis: number[], fifths: number): number {
  let p = 0;
  for (let i = 0; i < tpcs.length; i++) {
    p += KEY_WEIGHT * keyPenalty(tpcs[i], fifths);
    if (tpcToAlter(tpcs[i]) !== 0) p += PARSIMONY_WEIGHT;
  }
  // all pairs, contiguous and non-contiguous (Cambouropoulos is explicit about this)
  for (let i = 0; i < tpcs.length; i++) {
    for (let j = i + 1; j < tpcs.length; j++) {
      p += INTERVAL_PENALTY[Math.min(12, Math.abs(tpcs[i] - tpcs[j]))];
    }
  }
  // directional tiebreak: chromatic notes are sharp ascending, flat descending
  for (let i = 0; i + 1 < tpcs.length; i++) {
    if (Math.abs(midis[i + 1] - midis[i]) !== 1) continue;
    const ascending = midis[i + 1] > midis[i];
    for (const idx of [i, i + 1]) {
      const alter = tpcToAlter(tpcs[idx]);
      if (alter === 0) continue;
      if (ascending && alter < 0) p += DIRECTION_WEIGHT;
      if (!ascending && alter > 0) p += DIRECTION_WEIGHT;
    }
  }
  return p;
}

export interface SpelledPitch {
  step: StepName;
  alter: number;
  octave: number;
  tpc: Tpc;
}

/** Cambouropoulos: WINDOW = 9, stride 3, 2^9 brute force, middle window's verdict kept. */
export function spellNoteList(midis: number[], fifths: number): SpelledPitch[] {
  const n = midis.length;
  const chosen: Tpc[] = new Array(n).fill(0);
  const chosenDistance: number[] = new Array(n).fill(Infinity);
  if (!n) return [];

  for (let start = 0; start < n; start += STRIDE) {
    const end = Math.min(n, start + WINDOW);
    const size = end - start;
    const options = [];
    for (let i = start; i < end; i++) options.push(CANDIDATES[((midis[i] % 12) + 12) % 12]);

    let bestMask = 0;
    let bestScore = Infinity;
    const total = 1 << size;
    const buf: Tpc[] = new Array(size);
    const sub = midis.slice(start, end);
    for (let mask = 0; mask < total; mask++) {
      for (let i = 0; i < size; i++) buf[i] = options[i][(mask >> i) & 1];
      const score = windowPenalty(buf, sub, fifths);
      if (score < bestScore) {
        bestScore = score;
        bestMask = mask;
      }
    }
    const center = start + (size - 1) / 2;
    for (let i = 0; i < size; i++) {
      const idx = start + i;
      const distance = Math.abs(idx - center);
      if (distance < chosenDistance[idx]) {
        chosenDistance[idx] = distance;
        chosen[idx] = options[i][(bestMask >> i) & 1];
      }
    }
    if (end === n) break;
  }

  return midis.map((midi, i) => ({
    step: tpcToStep(chosen[i]),
    alter: tpcToAlter(chosen[i]),
    octave: tpcToOctave(chosen[i], midi),
    tpc: chosen[i]
  }));
}

// ---- accidental display ------------------------------------------------------------------

const SHARP_ORDER: StepName[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER: StepName[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

/** The alteration a key signature already applies to a letter. */
export function keySignatureAlter(step: StepName, fifths: number): number {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

export function accidentalNameFor(alter: number): AccidentalName | undefined {
  switch (alter) {
    case 2:
      return 'double-sharp';
    case 1:
      return 'sharp';
    case 0:
      return 'natural';
    case -1:
      return 'flat';
    case -2:
      return 'double-flat';
    default:
      return undefined;
  }
}

export interface DisplayNote {
  step: StepName;
  alter: number;
  octave: number;
  tieStop: boolean;
  /** Index of the rhythmic slot; notes sharing one are simultaneous. */
  slot: number;
}

/**
 * music21's cascade, in source order, restricted to the branches the research says carry
 * "nearly all the value for bass" (rules 6, 7 and the first-note-of-a-measure restatement),
 * plus the v8 chord-clarification rule (4) and the tie suppression (3).
 *
 * Call once per MEASURE — accidentals are measure-scoped.
 */
export function accidentalDisplayForMeasure(
  notes: DisplayNote[],
  fifths: number
): (AccidentalName | undefined)[] {
  const out: (AccidentalName | undefined)[] = new Array(notes.length).fill(undefined);
  // cautionaryPitchClass = true: comparisons are made regardless of register, so the map is
  // keyed by step letter only.
  const seen = new Map<StepName, { alter: number; displayed: boolean }>();

  const bySlot = new Map<number, number[]>();
  notes.forEach((n, i) => {
    const g = bySlot.get(n.slot) ?? [];
    g.push(i);
    bySlot.set(n.slot, g);
  });

  const slots = [...bySlot.keys()].sort((a, b) => a - b);
  for (const slot of slots) {
    const idxs = bySlot.get(slot)!;
    // rule 4: a simultaneous pitch with the same step but a different pitch class forces both
    const conflict = new Set<StepName>();
    for (const i of idxs) {
      for (const j of idxs) {
        if (i !== j && notes[i].step === notes[j].step && notes[i].alter !== notes[j].alter) {
          conflict.add(notes[i].step);
        }
      }
    }
    for (const i of idxs) {
      const n = notes[i];
      const inKey = keySignatureAlter(n.step, fifths);
      let display: boolean;
      if (n.tieStop) {
        display = false; // rule 3
      } else if (conflict.has(n.step)) {
        display = true; // rule 4
      } else if (!seen.has(n.step)) {
        // rule 6: no past pitches for this step in the measure.
        display = n.alter !== inKey;
      } else {
        const prev = seen.get(n.step)!;
        // rules 7/8: a different name at the same step forces display; an immediate identical
        // repeat that was already displayed is hidden.
        display = prev.alter !== n.alter ? true : false;
      }
      if (display) out[i] = accidentalNameFor(n.alter);
      seen.set(n.step, { alter: n.alter, displayed: display });
    }
  }
  return out;
}
