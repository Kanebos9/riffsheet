/**
 * MIDI number -> note name, in scientific pitch notation (middle C = C4 = MIDI 60).
 *
 * Bass low E (MIDI 28) reads "E1"; guitar low E (MIDI 40) reads "E2". That matches
 * what a bass player sees written on a chart, which is the whole point of the row.
 */

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export type Accidentals = 'sharps' | 'flats';

/** Number of flats/sharps in the key signature -> which spelling reads better. */
export function accidentalsForKey(keySignature: number | undefined): Accidentals {
  return (keySignature ?? 0) < 0 ? 'flats' : 'sharps';
}

/** e.g. 28 -> "E1", 63 -> "D#4" (or "Eb4" with flats). */
export function midiToName(midi: number, accidentals: Accidentals = 'sharps'): string {
  const table = accidentals === 'flats' ? FLAT : SHARP;
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${table[pc]}${octave}`;
}

/** Pitch class only, no octave — for the compact variant of the names row. */
export function midiToPitchClass(midi: number, accidentals: Accidentals = 'sharps'): string {
  const table = accidentals === 'flats' ? FLAT : SHARP;
  return table[((midi % 12) + 12) % 12];
}
