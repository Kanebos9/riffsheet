/**
 * Tuning presets and fret assignment.
 *
 * Canonical order throughout Riffsheet is LOW string first (index 0 = the fattest string).
 * alphaTab wants the opposite for `Staff.stringTuning.tunings`, and its `Note.string`
 * is 1-based from the LOW string. Both inversions are handled in exactly one place:
 * `toAlphaTabTunings()` below, and the `note.string` assignment in build.ts.
 */

/** A named tuning the user can pick. Lives here because this file is its only authority. */
export interface TuningPreset {
  id: string;
  name: string;
  instrument: 'bass' | 'guitar' | 'custom';
  /** MIDI numbers, LOWEST string first — Riffsheet's canonical order. */
  midiLowToHigh: number[];
}

export const TUNING_PRESETS: TuningPreset[] = [
  // --- bass ---------------------------------------------------------------
  { id: 'bass4-standard', name: 'Bass 4 — E A D G', instrument: 'bass', midiLowToHigh: [28, 33, 38, 43] },
  { id: 'bass4-dropd', name: 'Bass 4 — Drop D', instrument: 'bass', midiLowToHigh: [26, 33, 38, 43] },
  { id: 'bass4-eb', name: 'Bass 4 — Eb (half step down)', instrument: 'bass', midiLowToHigh: [27, 32, 37, 42] },
  { id: 'bass5-standard', name: 'Bass 5 — B E A D G', instrument: 'bass', midiLowToHigh: [23, 28, 33, 38, 43] },
  { id: 'bass6-standard', name: 'Bass 6 — B E A D G C', instrument: 'bass', midiLowToHigh: [23, 28, 33, 38, 43, 48] },
  // --- guitar -------------------------------------------------------------
  { id: 'guitar6-standard', name: 'Guitar 6 — E A D G B E', instrument: 'guitar', midiLowToHigh: [40, 45, 50, 55, 59, 64] },
  { id: 'guitar6-dropd', name: 'Guitar 6 — Drop D', instrument: 'guitar', midiLowToHigh: [38, 45, 50, 55, 59, 64] },
  { id: 'guitar7-standard', name: 'Guitar 7 — B E A D G B E', instrument: 'guitar', midiLowToHigh: [35, 40, 45, 50, 55, 59, 64] }
];

export const DEFAULT_TUNING: TuningPreset = TUNING_PRESETS[0];

export function tuningById(id: string): TuningPreset {
  return TUNING_PRESETS.find((t) => t.id === id) ?? DEFAULT_TUNING;
}

/** A player-entered tuning, represented through the same contract as a named preset. */
export function customTuning(midiLowToHigh: number[]): TuningPreset {
  const notes = midiLowToHigh
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 127)
    .slice(0, 12)
    .sort((a, b) => a - b);
  return {
    id: 'custom',
    name: `Custom ${notes.length} — ${tuningLabel(notes)}`,
    instrument: 'custom',
    midiLowToHigh: notes
  };
}

/** Compact open-string names for the toolbar and printed tuning summary. */
export function tuningLabel(midiLowToHigh: number[]): string {
  return midiLowToHigh.map(midiNoteName).join(' ');
}

export function midiNoteName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const n = Math.max(0, Math.min(127, Math.round(midi)));
  return `${names[n % 12]}${Math.floor(n / 12) - 1}`;
}

/** Parse names such as `B0 E1 A1 D2 G2` (commas are accepted too). */
export function parseTuning(text: string): number[] | null {
  const names: Record<string, number> = {
    C: 0,
    'C#': 1,
    DB: 1,
    D: 2,
    'D#': 3,
    EB: 3,
    E: 4,
    F: 5,
    'F#': 6,
    GB: 6,
    G: 7,
    'G#': 8,
    AB: 8,
    A: 9,
    'A#': 10,
    BB: 10,
    B: 11
  };
  const parts = text.trim().split(/[\s,;]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 12) return null;
  const notes: number[] = [];
  for (const part of parts) {
    const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(part);
    if (!match) return null;
    const pitch = names[`${match[1].toUpperCase()}${match[2].toUpperCase()}`];
    const midi = (Number(match[3]) + 1) * 12 + pitch;
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) return null;
    notes.push(midi);
  }
  notes.sort((a, b) => a - b);
  return notes;
}

export interface FretPosition {
  /** 1-based from the LOW string, alphaTab convention. */
  string: number;
  fret: number;
}

export interface FretOptions {
  maxFret?: number;
  capo?: number;
  /** 'low-positions' hugs the nut; 'minimize-movement' stays near the previous note. */
  style?: 'low-positions' | 'minimize-movement';
  /** Fret of the previously placed note, for 'minimize-movement'. */
  previousFret?: number;
}

/**
 * Choose a string/fret for a pitch.
 *
 * This is the fallback used when the pipeline did not assign one (mock mode, MIDI import,
 * or after an edit changes a pitch). Team C's real fingering planner is expected to do
 * better across a whole phrase; this only has to be sane note-by-note.
 */
export function assignFret(
  midi: number,
  tuningLowToHigh: number[],
  opts: FretOptions = {}
): FretPosition | null {
  const maxFret = opts.maxFret ?? 17;
  const capo = opts.capo ?? 0;
  const style = opts.style ?? 'low-positions';

  let best: FretPosition | null = null;
  let bestCost = Number.POSITIVE_INFINITY;

  for (let i = 0; i < tuningLowToHigh.length; i++) {
    const open = tuningLowToHigh[i] + capo;
    const fret = midi - open;
    if (fret < 0 || fret > maxFret) continue;

    // Prefer the thickest string that can reach the note without a silly stretch —
    // that is what a bass player actually does — then break ties by the style knob.
    let cost: number;
    if (style === 'minimize-movement' && opts.previousFret !== undefined) {
      cost = Math.abs(fret - opts.previousFret) * 2 + fret * 0.1;
    } else {
      cost = fret;
    }
    // Open strings are free and always nicer.
    if (fret === 0) cost -= 2;

    if (cost < bestCost) {
      bestCost = cost;
      best = { string: i + 1, fret };
    }
  }
  return best;
}

/** Lowest and highest pitch the tuning can produce — used for the out-of-range warning. */
export function tuningRange(tuningLowToHigh: number[], maxFret = 17): { min: number; max: number } {
  return {
    min: Math.min(...tuningLowToHigh),
    max: Math.max(...tuningLowToHigh) + maxFret
  };
}
