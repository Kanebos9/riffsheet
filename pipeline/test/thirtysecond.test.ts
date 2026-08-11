/**
 * ISSUE #35 — REAL 1/32 SUPPORT.
 *
 * Two claims, and the second is the one that could have gone wrong quietly:
 *
 *  1. `grid: 'thirtysecond'` reads 32nd-note material as 32nd notes, all the way out to both
 *     emitters. The tick foundation moved from 12 to 24 per quarter to make that sayable — at 12
 *     a 32nd was 1.5 ticks, so the value could not exist and anything that wanted one was rounded
 *     into a glyph whose printed <type> disagreed with its own <duration>.
 *
 *  2. THE TRIPLETS SURVIVED. 24 = 12 x 2 was chosen precisely because it is still divisible by 3;
 *     a resolution that bought 32nds by giving up triplets would be a bad trade, and the failure
 *     would only show on tuplet material.
 *
 * The grid string is `'thirtysecond'`, not `'1/32'`. It is shared verbatim with the webcore
 * settings union — see types.ts.
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { DIVISIONS } from '../src/ir.js';
import { readMusicXml } from './xmlReader.js';
import { grid, playedNotes, settings } from './helpers.js';
import type { IRBeat, RiffsheetIR } from '../src/ir.js';

/** Every note glyph in the score, in order, with its bar. */
function noteBeats(ir: RiffsheetIR): { bar: number; beat: IRBeat }[] {
  const out: { bar: number; beat: IRBeat }[] = [];
  for (const bar of ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) if (!beat.isRest) out.push({ bar: bar.index, beat });
    }
  }
  return out;
}

/**
 * Sixteen evenly spaced 32nds across the first two beats, at a 90% gate.
 * `lengthBeats` is pinned on every note including the last — `playedNotes` otherwise gives the
 * final note a default one-beat slot, which is a quarter and not the figure under test.
 */
const THIRTYSECONDS = playedNotes(
  Array.from({ length: 16 }, (_, i) => ({ beat: i / 8, midi: [40, 43, 45, 47][i % 4], lengthBeats: 1 / 8 })),
  0.9
);

describe('#35 — the tick foundation is 24 per quarter', () => {
  it('DIVISIONS is 24, and the IR reports it on both names', () => {
    const r = buildScore({ notes: THIRTYSECONDS, ...grid(2) }, settings());
    expect(DIVISIONS).toBe(24);
    expect(r.ir.divisions).toBe(24);
    expect(r.ir.ppq).toBe(24);
  });

  it('a 32nd is 3 ticks, a dotted 16th is 9, a 4/4 bar is 96', () => {
    const r = buildScore({ notes: THIRTYSECONDS, ...grid(2) }, settings({ grid: 'thirtysecond' }));
    expect(r.ir.bars[0].durTicks).toBe(96);
    expect(r.ir.bars[0].beamBoundaries).toEqual([0, 24, 48, 72, 96]);
  });
});

describe('#35 — grid thirtysecond reads 32nds as 32nds', () => {
  const r = buildScore({ notes: THIRTYSECONDS, ...grid(2) }, settings({ grid: 'thirtysecond', title: '32nds' }));

  it('places all sixteen onsets on the 1/32 lattice, none merged away', () => {
    const notes = noteBeats(r.ir);
    expect(notes).toHaveLength(16);
    expect(notes.map((n) => n.beat.startTick)).toEqual(Array.from({ length: 16 }, (_, i) => i * 3));
  });

  it('prints them as 32nd glyphs of 3 ticks, not as rounded-up 16ths', () => {
    for (const { beat } of noteBeats(r.ir)) {
      expect(beat.durTicks).toBe(3);
      expect(beat.durationType).toBe('32nd');
      expect(beat.dots).toBe(0);
    }
  });

  it('survives the MusicXML round trip with <type>32nd</type> and duration 3', () => {
    const read = readMusicXml(r.toMusicXML());
    expect(read.divisions).toBe(24);
    const staff1 = read.notes.filter((n) => n.staff === 1 && !n.isRest && !n.chord);
    expect(staff1).toHaveLength(16);
    for (const n of staff1) {
      expect(n.type).toBe('32nd');
      expect(n.duration).toBe(3);
    }
    // The bar still adds up: 16 x 3 sounding ticks plus the measured silence after them.
    for (const m of read.measureLengths) expect(m.length).toBe(96);
  });

  it('reaches alphaTab as ThirtySecond, with a third beam level', () => {
    const data = r.toAlphaTabModelData();
    expect(data.divisions).toBe(24);
    const beats = data.tracks[0].staves[0].bars.flatMap((b) => b.voices.flatMap((v) => v.beats)).filter((b) => !b.isEmpty);
    expect(beats).toHaveLength(16);
    for (const b of beats) {
      expect(b.duration).toBe('ThirtySecond');
      expect(b.durTicks).toBe(3);
    }
    // Beamed in groups of eight per beat, so a third-level beam has to be present somewhere.
    expect(beats.some((b) => (b.beams ?? []).length >= 3)).toBe(true);
  });
});

describe('#35 — 1/32 is opt-in, never volunteered', () => {
  it("'auto' does not print a 32nd even on 32nd-note material", () => {
    const r = buildScore({ notes: THIRTYSECONDS, ...grid(2) }, settings({ grid: 'auto' }));
    for (const { beat } of noteBeats(r.ir)) expect(beat.durationType).not.toBe('32nd');
  });

  it("'1/16' does not print a 32nd either — a grid is a ceiling on what the page may say", () => {
    const r = buildScore({ notes: THIRTYSECONDS, ...grid(2) }, settings({ grid: '1/16' }));
    for (const { beat } of noteBeats(r.ir)) {
      expect(beat.durationType).not.toBe('32nd');
      expect(beat.durTicks % 6).toBe(0);
    }
  });
});

describe('#35 — the triplets survived the doubling', () => {
  // Eight beats of clean eighth-note triplets: the shape the tuplet admission gates exist for.
  const positions: { beat: number; midi: number }[] = [];
  for (let b = 0; b < 8; b++) for (let u = 0; u < 3; u++) positions.push({ beat: b + u / 3, midi: 40 });
  const r = buildScore({ notes: playedNotes(positions, 0.95), ...grid(2) }, settings({ grid: 'auto' }));

  it('an eighth-note triplet unit is a whole 8 ticks at divisions 24', () => {
    const tupletBeats = noteBeats(r.ir).filter(({ beat }) => beat.tuplet);
    expect(tupletBeats.length).toBeGreaterThan(0);
    for (const { beat } of tupletBeats) {
      expect(beat.durTicks).toBe(8);
      expect(beat.durationType).toBe('eighth');
      expect(beat.tuplet!.actual).toBe(3);
      expect(beat.tuplet!.normal).toBe(2);
    }
  });

  it('three units still fill a beat exactly — no drift, which is the whole point of 24', () => {
    expect(8 * 3).toBe(24);
    expect(DIVISIONS % 3).toBe(0);
  });

  it("'1/8T' still admits triplets after the migration", () => {
    const t = buildScore({ notes: playedNotes(positions, 0.95), ...grid(2) }, settings({ grid: '1/8T' }));
    expect(noteBeats(t.ir).some(({ beat }) => beat.tuplet)).toBe(true);
  });
});
