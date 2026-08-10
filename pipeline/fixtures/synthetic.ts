/**
 * Original deterministic stress fixtures for notation and tablature tests.
 *
 * These phrases are generated entirely by Riffsheet. They deliberately combine an early
 * 70-90% note gate with a regular beat grid: without gap filling that creates the short rests
 * the pipeline is meant to suppress. Alternating pitches near string boundaries also exercise
 * the difference between lowest-fret and minimum-movement tablature assignment.
 */

export interface SyntheticFixture {
  id: string;
  beats: number[];
  downbeats: number[];
  audioDurationSec: number;
  notes: { startSec: number; endSec: number; midi: number; velocity: number }[];
  notesRaw: { startSec: number; endSec: number; midi: number; velocity: number }[];
}

export const SYNTHETIC_TUNING = [28, 33, 38, 43];

const PITCH_PATTERNS = [
  [42, 43, 42, 43, 45, 43, 42, 43],
  [37, 38, 37, 38, 40, 38, 37, 38],
  [32, 33, 32, 33, 35, 33, 32, 33],
  [40, 43, 45, 43, 42, 43, 47, 43],
  [35, 38, 40, 38, 37, 38, 42, 38],
  [30, 33, 35, 33, 32, 33, 37, 33]
] as const;

function makeFixture(pattern: readonly number[], fixtureIndex: number): SyntheticFixture {
  const eighthSeconds = 0.25;
  const noteCount = 128;
  const beats = Array.from({ length: noteCount / 2 }, (_, i) => i * 0.5);
  const downbeats = Array.from({ length: noteCount / 8 }, (_, i) => i * 2);
  const notes = Array.from({ length: noteCount }, (_, i) => {
    const startSec = i * eighthSeconds;
    const gate = 0.7 + (((i * 37 + fixtureIndex * 11) % 21) / 100);
    return {
      startSec,
      endSec: startSec + eighthSeconds * gate,
      midi: pattern[(i + fixtureIndex) % pattern.length],
      velocity: 76 + ((i * 13 + fixtureIndex * 7) % 34)
    };
  });
  const notesRaw = notes.map((note, i) => ({
    ...note,
    endSec: note.startSec + eighthSeconds * (0.92 + ((i + fixtureIndex) % 5) * 0.01),
    velocity: 96
  }));
  return {
    id: `synthetic-${fixtureIndex + 1}`,
    beats,
    downbeats,
    audioDurationSec: noteCount * eighthSeconds,
    notes,
    notesRaw
  };
}

export const SYNTHETIC_FIXTURES: SyntheticFixture[] = PITCH_PATTERNS.map(makeFixture);
