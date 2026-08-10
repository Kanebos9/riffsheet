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

import type { ClefSign, IRClef } from './ir.js';
import type { ClefMode, Instrument } from './types.js';

/** MuseScore `importmidi_clef.cpp`: midPitch 60, dx 5. */
export const CLEF_LOW_THRESHOLD = 55; // G3 and below -> bass
export const CLEF_HIGH_THRESHOLD = 60; // C4 and above -> treble

export interface ClefDecision {
  /** One entry per bar, in bar order. */
  perBar: IRClef[];
  grandStaff: boolean;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const BASS: { sign: ClefSign; line: number } = { sign: 'F', line: 4 };
const TREBLE: { sign: ClefSign; line: number } = { sign: 'G', line: 2 };

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
  const min = pitches.length ? Math.min(...pitches) : NaN;
  const max = pitches.length ? Math.max(...pitches) : NaN;
  // A grand staff is a layout request, never permission to flip clefs every few bars. The
  // renderer currently consumes the flag; the base staff remains stable until it can safely
  // render two simultaneous staves.
  const genuinelyWide = pitches.length > 1 && min <= CLEF_LOW_THRESHOLD && max >= 72 && max - min >= 24;
  return {
    perBar: Array.from({ length: n }, (_, i) => ({ ...chosen, changed: i === 0 })),
    grandStaff: mode === 'grand' || (mode === 'auto' && genuinelyWide)
  };
}
