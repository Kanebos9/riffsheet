/**
 * The three golden cases. Defined once and used by both `golden.test.ts` and
 * `scripts/update-golden.sh`, so the fixtures can never drift from the inputs that made them.
 *
 * Each is a hand-built note list + beat grid, chosen to pin a different part of the pipeline:
 *
 *   straight-eighths  the shape that produced the original complaint — sixteen eighths at a
 *                     60% gate, which the old converter turned into 16th/16th-rest pairs.
 *   external-grid     the host-DAW path: detected beats present but deliberately wrong, and
 *                     an `externalGrid` that must override them, including a tempo change.
 *   pickup            `startOffsetSec` anchoring bar 1, with an anacrusis before it.
 */

import type { BuildInput, BuildSettings } from '../src/types.js';
import { grid, playedNotes, settings } from './helpers.js';

export interface GoldenCase {
  name: string;
  input: BuildInput;
  settings: BuildSettings;
}

const RIFF_PITCHES = [40, 40, 43, 45, 47, 45, 43, 40];

export const GOLDEN_CASES: GoldenCase[] = [
  {
    name: 'straight-eighths',
    input: {
      ...grid(2, 4, 120),
      notes: playedNotes(
        Array.from({ length: 16 }, (_, i) => ({ beat: i / 2, midi: RIFF_PITCHES[i % 8] })),
        0.6,
        120
      )
    },
    settings: settings({ title: 'Straight Eighths' })
  },
  {
    name: 'external-grid',
    input: {
      // Detected beats are deliberately WRONG (they imply ~193 BPM); the host grid wins.
      beats: [0, 0.31, 0.62, 0.93, 1.24, 1.55, 1.86, 2.17],
      downbeats: [0, 1.24],
      externalGrid: {
        bpm: 100,
        timeSig: [4, 4],
        tempoChanges: [{ atSec: 2.4, bpm: 80 }]
      },
      notes: [
        // bar 1 at 100 BPM (0.6 s per beat), quarters at a 75% gate
        { id: 'a', startSec: 0.0, endSec: 0.45, midi: 33, velocity: 100 },
        { id: 'b', startSec: 0.6, endSec: 1.05, midi: 36, velocity: 92 },
        { id: 'c', startSec: 1.2, endSec: 1.65, midi: 38, velocity: 96 },
        { id: 'd', startSec: 1.8, endSec: 2.25, midi: 40, velocity: 92 },
        // bar 2 after the tempo change to 80 BPM (0.75 s per beat)
        { id: 'e', startSec: 2.4, endSec: 2.96, midi: 41, velocity: 100 },
        { id: 'f', startSec: 3.15, endSec: 3.71, midi: 40, velocity: 88 },
        { id: 'g', startSec: 3.9, endSec: 4.46, midi: 38, velocity: 92 },
        { id: 'h', startSec: 4.65, endSec: 5.21, midi: 36, velocity: 88 }
      ]
    },
    settings: settings({ title: 'External Grid' })
  },
  {
    name: 'pickup',
    input: {
      ...grid(4, 4, 120, 0),
      startOffsetSec: 2.0,
      notes: [
        // one anacrusis eighth before the declared origin
        { id: 'p', startSec: 1.75, endSec: 1.94, midi: 47, velocity: 84 },
        ...playedNotes(
          Array.from({ length: 8 }, (_, i) => ({ beat: i, midi: RIFF_PITCHES[i] })),
          0.8,
          120,
          2.0
        )
      ]
    },
    settings: settings({ title: 'Pickup' })
  }
];
