/**
 * STATION 3c — one stable generated clef for the whole part.
 *
 * WRITTEN from MuseScore's verified constants (`importmidi_clef.cpp`, §8.4): `midPitch = 60`,
 * `dx = 5`, giving thresholds 50 / 55 / 60 / 65 / 70 (D3 / G3 / C4 / F4 / Bb4), with
 * `clefChangePenalty = 1000` making the DP strongly hysteretic. We keep the thresholds and the
 * hysteresis but decide per BAR GROUP instead of running the DP — for a 4-string bass
 * (E1 = 28 ... ~G3 = 55) every note scores `veryFarPitchPenalty` in treble anyway, so the DP
 * has nothing to decide (§8.4: "hard-code bass clef; defer the DP to when guitar/piano parts
 * arrive").
 *
 * THE OCTAVE TRAP (§8.3), which is the bug most likely to ship: bass guitar sounds an octave
 * below written pitch, and there are TWO mechanisms for saying so — part-level `<transpose>`
 * and clef-level `<clef-octave-change>`. Using both double-applies, and MuseScore has itself
 * shipped this as a bug. Riffsheet's rule is to use NEITHER: plain `<clef><sign>F</sign>
 * <line>4</line></clef>`, sounding pitches, no transpose. Every reader handles that
 * identically. This module therefore never emits an octave change, and the MusicXML emitter
 * asserts that it doesn't.
 */

import type { ClefSign, IRClef, IRNote } from './ir.js';
import type { ClefMode, Instrument } from './types.js';

/** MuseScore `importmidi_clef.cpp`: midPitch 60, dx 5. */
export const CLEF_LOW_THRESHOLD = 55; // G3 and below -> bass
export const CLEF_HIGH_THRESHOLD = 60; // C4 and above -> treble

/** Middle C. A generated grand staff splits here: at or above it prints on the upper staff. */
export const GRAND_SPLIT_MIDI = 60;

export interface ClefDecision {
  /**
   * One entry per bar, in bar order. This is the SINGLE-STAFF clef and it is what a non-grand
   * score prints. A grand score keeps it as the fallback the tab staff and any single-staff
   * consumer reads; the two notation staves come from `pair`.
   */
  perBar: IRClef[];
  grandStaff: boolean;
  /**
   * The clef of each notation staff when `grandStaff` is true, upper first. Undefined otherwise:
   * the single-clef choice above only applies when the grand staff is NOT active.
   */
  pair?: [IRClef, IRClef];
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const BASS: { sign: ClefSign; line: number } = { sign: 'F', line: 4 };
const TREBLE: { sign: ClefSign; line: number } = { sign: 'G', line: 2 };

/**
 * The clefs of a grand staff, upper first: treble over bass. Both emitters take the pair from
 * here (via `RiffsheetIR.grandStaffClefs`) rather than each hard-coding G2/F4 of its own.
 */
export function grandClefPair(): [IRClef, IRClef] {
  return [{ ...TREBLE, changed: true }, { ...BASS, changed: true }];
}

export function chooseClefs(
  barPitches: number[][],
  instrument: Instrument,
  mode: ClefMode = 'auto'
): ClefDecision {
  const n = barPitches.length;
  const pitches = barPitches.flat().filter(Number.isFinite);
  const med = median(pitches);
  const automatic = instrument === 'guitar6' || (!Number.isNaN(med) && med >= CLEF_HIGH_THRESHOLD)
    ? TREBLE
    : BASS;
  const chosen = mode === 'treble' ? TREBLE : mode === 'bass' ? BASS : automatic;
  // Iterative, never `Math.min(...pitches)`: a spread of a million arguments throws `RangeError`
  // in JavaScriptCore long before it computes anything (finding 12).
  let min = Infinity;
  let max = -Infinity;
  for (const p of pitches) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  if (!pitches.length) {
    min = NaN;
    max = NaN;
  }
  // A grand staff is a layout request, never permission to flip clefs every few bars: the two
  // staves are simultaneous and each keeps its own clef for the whole part. 'grand' asks for the
  // pair outright; 'auto' still promotes to it when the part is genuinely too wide for one staff.
  const genuinelyWide = pitches.length > 1 && min <= CLEF_LOW_THRESHOLD && max >= 72 && max - min >= 24;
  const grandStaff = mode === 'grand' || (mode === 'auto' && genuinelyWide);
  return {
    perBar: Array.from({ length: n }, (_, i) => ({ ...chosen, changed: i === 0 })),
    grandStaff,
    ...(grandStaff ? { pair: grandClefPair() } : {})
  };
}

/**
 * THE ONE PLACE THE GRAND-STAFF SPLIT IS DECIDED — 0 is the upper (treble) staff, 1 the lower.
 *
 * It used to live twice, once in each emitter, which is two chances to disagree about the same
 * note. Both now read `IRNote.staffIndex`, which buildScore fills in from this.
 *
 * A symbolic import that carried exactly two source staves already knows the answer, and its
 * answer wins: an engraver's left-hand C5 stays in the left hand. Everything else splits at
 * middle C on SOUNDING pitch (the IR's only pitch domain), which is the conventional piano split.
 */
export function grandStaffSplitter(notes: readonly IRNote[]): (note: IRNote) => 0 | 1 {
  const sourceIndexes = [
    ...new Set(notes.map((note) => note.sourceStaffIndex).filter((index): index is number => index !== undefined))
  ].sort((a, b) => a - b);
  const upperSource = sourceIndexes.length === 2 ? sourceIndexes[0] : undefined;
  return (note) =>
    upperSource !== undefined
      ? note.sourceStaffIndex === upperSource
        ? 0
        : 1
      : note.midi >= GRAND_SPLIT_MIDI
        ? 0
        : 1;
}
