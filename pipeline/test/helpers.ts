/** Shared builders for the tests. Kept deterministic — no randomness, no clock, no fs. */

import type { BuildInput, BuildSettings, InputNote } from '../src/types.js';

export const BASS4 = [28, 33, 38, 43];

export function settings(over: Partial<BuildSettings> = {}): BuildSettings {
  // No `fillGaps`: it is deprecated and ignored, so the default settings should not imply the
  // pipeline still has a mode. The tests that pass it explicitly are asserting that it is
  // accepted and inert, which is a different claim.
  return {
    grid: 'auto',
    instrument: 'bass4',
    tuningMidi: BASS4,
    fingeringStyle: 'low',
    ...over
  };
}

/** A uniform beat grid: `bars` bars of `beatsPerBar` at `bpm`, starting at `startSec`. */
export function grid(bars: number, beatsPerBar = 4, bpm = 120, startSec = 0): { beats: number[]; downbeats: number[] } {
  const period = 60 / bpm;
  const beats: number[] = [];
  const downbeats: number[] = [];
  for (let i = 0; i <= bars * beatsPerBar; i++) {
    const t = startSec + i * period;
    beats.push(round(t));
    if (i % beatsPerBar === 0) downbeats.push(round(t));
  }
  return { beats, downbeats };
}

export function round(x: number, d = 6): number {
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
}

/**
 * Notes at exact grid positions with a fixed gate — the shape that used to produce a rest after
 * every single note.
 * `positions` are in beats from the origin; `lengthBeats` is the notated length.
 */
export function playedNotes(
  positions: { beat: number; midi: number; lengthBeats?: number }[],
  gate: number,
  bpm = 120,
  startSec = 0
): InputNote[] {
  const period = 60 / bpm;
  return positions.map((p, i) => {
    const start = startSec + p.beat * period;
    const len = (p.lengthBeats ?? nextGap(positions, i)) * period;
    return {
      id: `n${i}`,
      startSec: round(start),
      endSec: round(start + len * gate),
      midi: p.midi,
      velocity: 96
    };
  });
}

function nextGap(positions: { beat: number }[], i: number): number {
  return i + 1 < positions.length ? positions[i + 1].beat - positions[i].beat : 1;
}

export function input(notes: InputNote[], g: { beats: number[]; downbeats: number[] }, over: Partial<BuildInput> = {}): BuildInput {
  return { notes, beats: g.beats, downbeats: g.downbeats, ...over };
}

/** All glyphs of a built score, flattened, for compact assertions. */
export function glyphs(ir: { bars: { voices: { beats: { isRest: boolean; durTicks: number; durationType: string; dots: number }[] }[] }[] }): string[] {
  const out: string[] = [];
  for (const bar of ir.bars) {
    for (const v of bar.voices) {
      for (const b of v.beats) out.push(`${b.isRest ? 'R' : 'N'}${b.durTicks}`);
    }
    out.push('|');
  }
  return out;
}
