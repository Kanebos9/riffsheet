/**
 * ISSUE #36 — HONEST FREE.
 *
 * `grid: 'free'` is not a looser quantizer. It is a READ-ONLY VIEW of the performance, and the
 * promise is content-level: never merge, never drop, never fill, never reorder — exactly one
 * attack group on the page per event that was played, in the order it was played.
 *
 * WHAT WAS WRONG. Free rounded onto the raw tick lattice, which is finer than anything notation
 * can print, and then asked the METRIC rulebook to engrave the result. Both halves misfired:
 *
 *   - a span of 1 tick reached the engraver and came out as a 16th, so `<type>` and `<duration>`
 *     contradicted each other in the emitted file;
 *   - the metric splitter answers "where must this be cut so the reader still sees the beat?",
 *     which is the right question for metrical music and the wrong one for a free view. It
 *     produced maximal-precision tie chains — a quarter tied to a leftover fragment, repeatedly —
 *     and a tie chain reads as a restruck note to anyone not counting tie arcs.
 *
 * WHAT IT IS NOW. The resolution limit is a 1/32, because that is the finest thing the printable
 * vocabulary can say; the rounding error is therefore bounded by half a 1/32 at the take's tempo.
 * Inside that tolerance the engraver picks the SIMPLEST symbol combination — fewest glyphs that
 * add up exactly — instead of the most precise one.
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { buildBarMetric, simplestDurationList, toDurationList } from '../src/meter.js';
import { Rational, R } from '../src/rational.js';
import { grid, settings } from './helpers.js';
import type { InputNote } from '../src/types.js';
import type { RiffsheetIR } from '../src/ir.js';

const TICK = 0.5 / 24; // one tick in seconds at 120 BPM, divisions 24
const THIRTYSECOND = 3; // ticks

/** Ids in the order they are first STRUCK on the page (tie continuations are not strikes). */
function attackOrder(ir: RiffsheetIR): string[] {
  const out: string[] = [];
  for (const bar of ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        for (const n of beat.notes) if (!n.tieStop) out.push(n.id);
      }
    }
  }
  return out;
}

function soundingBeats(ir: RiffsheetIR): { startTick: number; durTicks: number; type: string; dots: number; ids: string[] }[] {
  const out: { startTick: number; durTicks: number; type: string; dots: number; ids: string[] }[] = [];
  for (const bar of ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest) continue;
        out.push({
          startTick: bar.startTick + beat.startTick,
          durTicks: beat.durTicks,
          type: beat.durationType,
          dots: beat.dots,
          ids: beat.notes.map((n) => n.id)
        });
      }
    }
  }
  return out;
}

/** Six events, every gap wider than the 35 ms chord window, so events and notes are 1:1. */
const PHRASE: InputNote[] = [
  { id: 'a', startSec: 0.0, endSec: 0.47, midi: 40 },
  { id: 'b', startSec: 0.5, endSec: 0.62, midi: 43 },
  { id: 'c', startSec: 0.73, endSec: 1.19, midi: 45 },
  { id: 'd', startSec: 1.25, endSec: 1.31, midi: 47 },
  { id: 'e', startSec: 1.5, endSec: 2.42, midi: 45 },
  { id: 'f', startSec: 2.5, endSec: 2.68, midi: 40 }
];

const free = (notes: InputNote[], bars = 3): RiffsheetIR =>
  buildScore({ notes, ...grid(bars) }, settings({ grid: 'free' })).ir;

describe('#36 — free is 1:1 with its input', () => {
  const ir = free(PHRASE);

  it('exactly one attack group per played event — nothing merged, nothing invented', () => {
    expect(attackOrder(ir)).toHaveLength(PHRASE.length);
  });

  it('nothing dropped: every id reaches the page', () => {
    const struck = new Set(attackOrder(ir));
    for (const n of PHRASE) expect(struck.has(n.id!), `${n.id} is missing`).toBe(true);
  });

  it('nothing reordered: the page order is the played order', () => {
    expect(attackOrder(ir)).toEqual(PHRASE.map((n) => n.id));
  });

  it('the IR reports itself as unquantized', () => {
    expect(ir.quantized).toBe(false);
  });

  it('two events too close to separate are still two attacks, never fused', () => {
    // 45 ms apart: past the chord window, so they are two events, and inside one 1/32 slot,
    // so the old free path rounded them onto the same tick and fused them into one.
    const collide: InputNote[] = [
      { id: 'first', startSec: 0.04, endSec: 0.24, midi: 40 },
      { id: 'second', startSec: 0.085, endSec: 0.285, midi: 45 }
    ];
    const c = free(collide, 2);
    expect(attackOrder(c)).toEqual(['first', 'second']);
    const sounding = soundingBeats(c);
    expect(sounding).toHaveLength(2);
    // The later one moved to the next free 1/32 rather than being merged away. (The earlier one
    // sits on the barline because `snapLeadingOnset` pulls a sub-eighth FIRST onset back to it —
    // an attack-time artefact rule that predates this issue and moves no other note.)
    expect(sounding[0].startTick).toBe(0);
    expect(sounding[1].startTick).toBe(6);
    expect(sounding[0].startTick).toBeLessThan(sounding[1].startTick);
  });

  it('a genuine chord is still ONE attack group carrying both pitches', () => {
    const chord: InputNote[] = [
      { id: 'lo', startSec: 0.5, endSec: 1.0, midi: 40 },
      { id: 'hi', startSec: 0.508, endSec: 1.0, midi: 47 }
    ];
    const c = free(chord, 2);
    const sounding = soundingBeats(c);
    expect(sounding).toHaveLength(1);
    expect(sounding[0].ids.sort()).toEqual(['hi', 'lo']);
  });
});

describe('#36 — free lands on the 1/32, and never lies about a glyph', () => {
  const ir = free(PHRASE);

  it('every onset and every duration is a whole number of 1/32 notes', () => {
    for (const beat of soundingBeats(ir)) {
      expect(beat.startTick % THIRTYSECOND, `onset ${beat.startTick}`).toBe(0);
      expect(beat.durTicks % THIRTYSECOND, `duration ${beat.durTicks}`).toBe(0);
    }
  });

  it('no glyph is printed shorter than the vocabulary can say', () => {
    // The old failure was a 1-tick span emitted as <type>16th</type>. Nothing may be under 3.
    for (const beat of soundingBeats(ir)) expect(beat.durTicks).toBeGreaterThanOrEqual(THIRTYSECOND);
  });

  it('written length matches played length to within half a 1/32', () => {
    const tolerance = (THIRTYSECOND / 2) * TICK;
    const written = new Map<string, number>();
    for (const beat of soundingBeats(ir)) {
      for (const id of beat.ids) written.set(id, (written.get(id) ?? 0) + beat.durTicks);
    }
    for (const n of PHRASE) {
      // The phrase is monophonic and gapped, so no off-time is clamped by a following onset.
      const playedSec = n.endSec - n.startSec;
      const writtenSec = written.get(n.id!)! * TICK;
      expect(Math.abs(writtenSec - playedSec), `${n.id}: wrote ${writtenSec}s for ${playedSec}s`).toBeLessThanOrEqual(
        tolerance + 1e-9
      );
    }
  });
});

describe('#36 — free prints the SIMPLEST symbol combination, not the most precise one', () => {
  it('a quarter played a 1/32 late is ONE quarter, where the metric rulebook wants several', () => {
    // Starts one 1/32 after beat 2 and lasts exactly a quarter. (Deliberately not the first beat
    // of the bar: `snapLeadingOnset` would pull a sub-eighth opening onset onto the barline and
    // the span under test would never form.)
    const late: InputNote[] = [{ id: 'q', startSec: 27 * TICK, endSec: 27 * TICK + 24 * TICK, midi: 40 }];

    // What the metric splitter would say about the same span, for contrast: it cuts at every
    // accent the span straddles, because its job is beat visibility.
    const metric = buildBarMetric(4, 4);
    const metricPieces = toDurationList(metric, R(9, 32), R(1, 4), 'note');
    expect(metricPieces.length).toBeGreaterThan(1);

    // Free asks the other question and gets one glyph.
    expect(simplestDurationList(R(1, 4))).toHaveLength(1);
    const sounding = soundingBeats(free(late, 2));
    expect(sounding).toHaveLength(1);
    expect(sounding[0].durTicks).toBe(24);
    expect(sounding[0].type).toBe('quarter');
    expect(sounding[0].dots).toBe(0);
  });

  it('simplestDurationList returns the fewest glyphs that add up exactly', () => {
    const total = (pieces: Rational[]): string => pieces.reduce((a, b) => a.add(b), Rational.ZERO).toString();

    // Single glyphs stay single.
    expect(simplestDurationList(R(1, 2))).toHaveLength(1);
    expect(simplestDurationList(R(3, 8))).toHaveLength(1);
    expect(simplestDurationList(R(1, 32))).toHaveLength(1);

    // 9/32 is not a glyph; two is the minimum and the sum is exact.
    const nine = simplestDurationList(R(9, 32));
    expect(nine).toHaveLength(2);
    expect(total(nine)).toBe('9/32');

    // 7/32 likewise: a dotted eighth plus a 32nd, not four separate 32nds.
    const seven = simplestDurationList(R(7, 32));
    expect(seven).toHaveLength(2);
    expect(total(seven)).toBe('7/32');
  });

  it('never emits a tie chain where one glyph would do, across the whole phrase', () => {
    for (const beat of soundingBeats(free(PHRASE))) {
      // Each printed glyph is a real vocabulary value, so no chain exists to shorten.
      const nominal: Record<string, number> = { whole: 96, half: 48, quarter: 24, eighth: 12, '16th': 6, '32nd': 3 };
      expect(nominal[beat.type] * (beat.dots ? 1.5 : 1)).toBe(beat.durTicks);
    }
  });
});

describe('#36 — free is a pure read-only view of its input', () => {
  const snapshot = JSON.stringify(PHRASE);

  it('does not mutate the input notes or the arrays holding them, even when frozen', () => {
    const notes = PHRASE.map((n) => Object.freeze({ ...n }));
    Object.freeze(notes);
    const g = grid(3);
    Object.freeze(g.beats);
    Object.freeze(g.downbeats);

    // A write to any frozen object throws in strict mode, which every ES module is.
    expect(() => buildScore({ notes, beats: g.beats, downbeats: g.downbeats }, settings({ grid: 'free' }))).not.toThrow();
    expect(JSON.stringify(notes)).toBe(snapshot);
  });

  it('the quantized grids do not mutate their input either', () => {
    for (const g of ['auto', '1/4', '1/16', 'thirtysecond'] as const) {
      const notes = PHRASE.map((n) => Object.freeze({ ...n }));
      Object.freeze(notes);
      expect(() => buildScore({ notes, ...grid(3) }, settings({ grid: g })), `grid ${g}`).not.toThrow();
      expect(JSON.stringify(notes), `grid ${g}`).toBe(snapshot);
    }
  });

  it('building twice from the same input gives the same score', () => {
    expect(JSON.stringify(free(PHRASE).bars)).toBe(JSON.stringify(free(PHRASE).bars));
  });
});
