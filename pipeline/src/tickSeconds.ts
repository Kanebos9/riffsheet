/**
 * THE TICK <-> SECONDS MAP — the authoritative conversion between the score's tick domain and
 * wall-clock seconds, built from `RiffsheetIR.tempo` and nothing else.
 *
 * WHY IT EXISTS. The pipeline already knew the answer twice and disagreed with itself: the
 * MIDI importer built a piecewise tick-to-seconds map, the MusicXML emitter wrote tempo
 * directions from `ir.tempo.changes`, and every consumer that had to place something in time
 * (roll grid, playhead, loop, synth) multiplied by one constant `displayBpm` instead. A score
 * with a tempo change therefore rendered its notation at one tempo and played it at another.
 *
 * This module is the single answer. It is FOUNDATION ONLY in this wave: nothing in webcore is
 * rewired to it yet (that is the next wave's job), but the map exists, it is exact, it is
 * bidirectional, and it is tested against tempo-change fixtures.
 *
 * EXACTNESS. Inside one tempo segment the relation is affine — `sec = segment.sec +
 * (tick - segment.tick) * secPerTick` — so `secToTick(tickToSec(t)) === t` up to floating point
 * for every tick, and the same the other way round for every second inside the score. Segments
 * are half-open `[tick, nextTick)`, which is what makes a tempo change land on exactly one
 * segment and never on both.
 *
 * MONOTONIC BY CONSTRUCTION. Every segment has a strictly positive BPM (a non-positive or
 * non-finite change is dropped, not clamped to zero), so seconds increase strictly with ticks
 * and the inverse is a function rather than a relation.
 */

import type { RiffsheetIR } from './ir.js';

/** Fallback when a score carries no usable tempo at all. Matches the rest of the pipeline. */
const DEFAULT_BPM = 120;

export interface TempoSegment {
  /** Absolute IR tick this segment takes effect at. The first segment always starts at 0. */
  tick: number;
  /** Wall-clock second the segment starts at, measured from tick 0. */
  sec: number;
  /** QUARTER notes per minute, the universal convention. Always > 0. */
  bpm: number;
  /** Seconds one IR tick lasts in this segment. */
  secPerTick: number;
}

export interface TickSecondsMap {
  /** Ticks per quarter note the map was built against (`ir.divisions`). */
  divisions: number;
  /** Piecewise-constant tempo segments, ascending by tick, starting at tick 0. */
  segments: readonly TempoSegment[];
  /** Absolute IR tick -> seconds from tick 0. Extrapolates linearly outside the score. */
  tickToSec(tick: number): number;
  /** Seconds from tick 0 -> absolute IR tick. The exact inverse of `tickToSec`. */
  secToTick(sec: number): number;
  /** The tempo in force at an absolute tick. */
  bpmAt(tick: number): number;
}

/** The tempo source of a map: an IR, or the same two fields on their own. */
export interface TempoSource {
  divisions: number;
  tempo: {
    displayBpm: number;
    changes?: { tick: number; bpm: number }[];
  };
}

/**
 * Build the map. `ir.tempo.changes` is authoritative when present — INCLUDING a change at tick
 * zero, which is the one every other reader of this data has historically skipped (see
 * midi.ts's conductor track, which had to be fixed for exactly that reason). When there are no
 * changes, or none at or before tick 0, `displayBpm` seeds the opening segment.
 */
export function buildTickSecondsMap(source: TempoSource | RiffsheetIR): TickSecondsMap {
  const divisions = source.divisions > 0 ? source.divisions : 24;
  const raw = (source.tempo.changes ?? [])
    .filter((change) => Number.isFinite(change.tick) && Number.isFinite(change.bpm) && change.bpm > 0)
    .map((change) => ({ tick: Math.max(0, Math.round(change.tick)), bpm: change.bpm }))
    .sort((a, b) => a.tick - b.tick);

  // One entry per tick: a later declaration at the same tick wins, which is what a reader that
  // applied them in order would end up with.
  const byTick = new Map<number, number>();
  for (const change of raw) byTick.set(change.tick, change.bpm);
  const opening = byTick.get(0)
    ?? (source.tempo.displayBpm > 0 ? source.tempo.displayBpm : DEFAULT_BPM);
  byTick.set(0, opening);

  const ordered = [...byTick].sort((a, b) => a[0] - b[0]);
  const segments: TempoSegment[] = [];
  let sec = 0;
  let previousTick = 0;
  let previousSecPerTick = 60 / (opening * divisions);
  for (const [tick, bpm] of ordered) {
    sec += (tick - previousTick) * previousSecPerTick;
    const secPerTick = 60 / (bpm * divisions);
    // A repeated tempo is not a new segment; folding it in keeps `segments` a minimal description.
    const last = segments[segments.length - 1];
    if (last && last.bpm === bpm) {
      previousTick = tick;
      previousSecPerTick = secPerTick;
      continue;
    }
    segments.push({ tick, sec, bpm, secPerTick });
    previousTick = tick;
    previousSecPerTick = secPerTick;
  }

  const segmentAtTick = (tick: number): TempoSegment => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return segments[lo];
  };
  const segmentAtSec = (sec2: number): TempoSegment => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].sec <= sec2) lo = mid;
      else hi = mid - 1;
    }
    return segments[lo];
  };

  return {
    divisions,
    segments,
    tickToSec: (tick) => {
      const segment = segmentAtTick(tick);
      return segment.sec + (tick - segment.tick) * segment.secPerTick;
    },
    secToTick: (sec2) => {
      const segment = segmentAtSec(sec2);
      return segment.tick + (sec2 - segment.sec) / segment.secPerTick;
    },
    bpmAt: (tick) => segmentAtTick(tick).bpm
  };
}
