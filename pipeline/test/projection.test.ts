/**
 * THE TOTAL PROJECTION — the claim that no input note disappears silently.
 *
 * Every other suite here asks whether the page is right. This one asks whether the pipeline can
 * still ACCOUNT for what it was given, which is a different question and the one the sheet/roll
 * seam is built on: the roll draws every performed note, the sheet draws what survived engraving,
 * and until now nothing could say which of the two a missing note was.
 *
 * The load-bearing assertion is the property sweep at the bottom — for randomized takes across
 * every grid, `engraved + merged + dropped === input`, and every input id appears exactly once.
 * Everything above it names one loss point and proves the projection reports THAT one correctly,
 * because a total count with the wrong reasons in it would satisfy the equation and help nobody.
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { buildMultiPartScore } from '../src/multipart.js';
import { chordGroupsOf, CHORD_WINDOW_MIN_SEC } from '../src/chords.js';
import { glyphsBySourceId, type NoteProjection, type Projection } from '../src/projection.js';
import type { GridSetting, InputNote } from '../src/types.js';
import { grid, input, settings } from './helpers.js';

const STAFF = { instrument: 'staff' as const, tuningMidi: [] };
const ALL_GRIDS: GridSetting[] = ['auto', '1/4', '1/8', '1/16', '1/8T', 'thirtysecond', 'free'];

function build(notes: InputNote[], over: Partial<Parameters<typeof settings>[0]> = {}, bars = 4, inputOver = {}) {
  return buildScore(input(notes, grid(bars), inputOver), settings({ ...STAFF, ...over }));
}

function entry(projection: Projection, id: string): NoteProjection {
  const found = projection.byId.get(id);
  if (!found) throw new Error(`no projection entry for ${id} — the map is supposed to be total`);
  return found;
}

/**
 * THE INVARIANT, checked on a finished build. Everything else in this file is a special case of
 * it, so it runs on every build the suite makes rather than only in the property sweep.
 */
function assertTotal(projection: Projection, ir: Parameters<typeof glyphsBySourceId>[0], inputIds: string[]): void {
  const { counts } = projection;
  expect(counts.input).toBe(inputIds.length);
  expect(counts.engraved + counts.merged + counts.dropped).toBe(counts.input);
  expect(projection.byId.size).toBe(inputIds.length);
  for (const id of inputIds) expect(projection.byId.has(id)).toBe(true);

  // The three outcomes have to agree with the page, not merely add up: an id the IR draws must be
  // `engraved`, and an id it does not draw must not be.
  const glyphs = glyphsBySourceId(ir);
  for (const id of glyphs.keys()) {
    expect(entry(projection, id).kind, `${id} has a glyph`).toBe('engraved');
  }
  for (const record of projection.byId.values()) {
    if (record.kind === 'engraved') {
      expect(record.glyphs.length, `${record.id} engraved`).toBeGreaterThan(0);
      expect(glyphs.has(record.id)).toBe(true);
    } else {
      expect(glyphs.has(record.id), `${record.id} is ${record.kind} and must not be drawn`).toBe(false);
    }
    // A merge pointer has to lead somewhere that is not itself merged, or every consumer has to
    // walk the chain (projection.ts `resolveMergeChains`).
    if (record.kind === 'merged') {
      const target = projection.byId.get(record.mergedInto);
      expect(target?.kind, `${record.id} -> ${record.mergedInto}`).not.toBe('merged');
    }
  }
}

describe('PROJECTION — the ordinary case', () => {
  it('a clean take engraves every note and merges or drops none', () => {
    const notes: InputNote[] = [
      { id: 'a', startSec: 0, endSec: 0.45, midi: 40 },
      { id: 'b', startSec: 0.5, endSec: 0.95, midi: 43 },
      { id: 'c', startSec: 1.0, endSec: 1.45, midi: 45 }
    ];
    const built = build(notes);
    assertTotal(built.projection, built.ir, ['a', 'b', 'c']);
    expect(built.projection.counts).toEqual({ input: 3, engraved: 3, merged: 0, dropped: 0 });
    const a = entry(built.projection, 'a');
    expect(a.kind).toBe('engraved');
    if (a.kind !== 'engraved') return;
    expect(a.glyphs).toHaveLength(1);
    expect(a.glyphs[0].bar).toBe(0);
    expect(a.glyphs[0].startTick).toBe(0);
    expect(a.engravedTicks).toBe(a.glyphs[0].durTicks);
  });

  it('a tie split is reported as SEVERAL glyphs, in printed order, not as one', () => {
    // A declared dotted whole is 144 ticks; a 4/4 bar holds 96, so the bar law ties it across.
    const built = build([{ id: 'long', startSec: 0, endSec: 0.05, midi: 40, notationIntent: { denominator: 1, dots: 1 } }]);
    const record = entry(built.projection, 'long');
    expect(record.kind).toBe('engraved');
    if (record.kind !== 'engraved') return;
    expect(record.glyphs.map((g) => g.durTicks)).toEqual([96, 48]);
    expect(record.glyphs.map((g) => g.bar)).toEqual([0, 1]);
    expect(record.glyphs[0].tieStart).toBe(true);
    expect(record.glyphs[1].tieStop).toBe(true);
    expect(record.engravedTicks).toBe(144);
  });

  it('a glyph reference locates the notehead the IR actually holds', () => {
    const built = build([{ id: 'a', startSec: 0, endSec: 0.45, midi: 40 }]);
    const record = entry(built.projection, 'a');
    if (record.kind !== 'engraved') throw new Error('expected engraved');
    for (const ref of record.glyphs) {
      const bar = built.ir.bars[ref.bar];
      const voice = bar.voices.find((v) => v.id === ref.voice)!;
      expect(voice.beats[ref.beat].notes[ref.note].id).toBe('a');
      expect(bar.startTick + voice.beats[ref.beat].startTick).toBe(ref.startTick);
      expect(voice.beats[ref.beat].durTicks).toBe(ref.durTicks);
    }
  });
});

describe('PROJECTION — every loss point is named', () => {
  it('guards: a note past the end of the audio is dropped, and says so', () => {
    const notes: InputNote[] = [
      { id: 'inside', startSec: 0, endSec: 0.4, midi: 40 },
      { id: 'after', startSec: 3.0, endSec: 3.4, midi: 43 }
    ];
    const built = build(notes, {}, 4, { audioDurationSec: 1.0 });
    assertTotal(built.projection, built.ir, ['inside', 'after']);
    expect(entry(built.projection, 'after')).toEqual({ kind: 'dropped', id: 'after', reason: 'past-audio-end' });
    expect(built.projection.counts.dropped).toBe(1);
  });

  it('guards: a sub-30 ms detection is dropped, and says so', () => {
    const notes: InputNote[] = [
      { id: 'real', startSec: 0, endSec: 0.4, midi: 40 },
      { id: 'blip', startSec: 1.0, endSec: 1.01, midi: 43 }
    ];
    const built = build(notes);
    assertTotal(built.projection, built.ir, ['real', 'blip']);
    expect(entry(built.projection, 'blip')).toEqual({ kind: 'dropped', id: 'blip', reason: 'below-min-duration' });
  });

  it('chords: a duplicate pitch inside one chord is MERGED into its twin, not deleted', () => {
    const notes: InputNote[] = [
      { id: 'low', startSec: 0, endSec: 0.4, midi: 40 },
      { id: 'twin', startSec: 0.004, endSec: 0.4, midi: 40 },
      { id: 'high', startSec: 0.008, endSec: 0.4, midi: 47 }
    ];
    const built = build(notes);
    assertTotal(built.projection, built.ir, ['low', 'twin', 'high']);
    expect(entry(built.projection, 'twin')).toEqual({
      kind: 'merged',
      id: 'twin',
      mergedInto: 'low',
      reason: 'chord-duplicate-pitch'
    });
    expect(entry(built.projection, 'low').kind).toBe('engraved');
    expect(entry(built.projection, 'high').kind).toBe('engraved');
  });

  it('quantize: two events that land on one grid tick report the collision and the survivor', () => {
    // 0.20 s is well outside the 35 ms chord window, so these are two chord events; at a 1/4 grid
    // (0.5 s per beat) they both round onto beat 0 and one slot has to take both.
    const notes: InputNote[] = [
      { id: 'early', startSec: 0, endSec: 0.1, midi: 40 },
      { id: 'late', startSec: 0.2, endSec: 0.65, midi: 47 }
    ];
    const built = build(notes, { grid: '1/4' });
    assertTotal(built.projection, built.ir, ['early', 'late']);
    const merged = [...built.projection.byId.values()].filter((r) => r.kind === 'merged');
    expect(merged).toHaveLength(1);
    if (merged[0].kind !== 'merged') return;
    expect(merged[0].reason).toBe('quantize-collision');
    // The pitch pick keeps the event with the most duration-weighted evidence, so the LONGER of
    // the two survives and the shorter points at it — not the earlier arrival.
    expect(merged[0].id).toBe('early');
    expect(merged[0].mergedInto).toBe('late');
  });

  it('symbolic: two written events on one printable slot report the fusion', () => {
    // MIXED RESOLUTIONS, which is the path that fuses: the symbolic placer declines when two
    // events disagree about ppq, so the `exact` quantizer takes over and rounds both onto the IR
    // lattice. `s1` is written one 960th-of-a-quarter after the downbeat — a different written
    // tick, so it is a separate event, and the same IR tick, so it leaves no glyph of its own.
    const notes: InputNote[] = [
      { id: 's0', startSec: 0, endSec: 0.5, midi: 40, sourceTiming: { ppq: 480, startTick: 0, endTick: 480 } },
      { id: 's1', startSec: 0.001, endSec: 0.5, midi: 47, sourceTiming: { ppq: 960, startTick: 1, endTick: 961 } },
      { id: 's2', startSec: 0.5, endSec: 1.0, midi: 45, sourceTiming: { ppq: 480, startTick: 480, endTick: 960 } }
    ];
    const built = build(notes);
    assertTotal(built.projection, built.ir, ['s0', 's1', 's2']);
    expect(entry(built.projection, 's1')).toEqual({
      kind: 'merged',
      id: 's1',
      mergedInto: 's0',
      reason: 'symbolic-tick-collision'
    });
    expect(entry(built.projection, 's0').kind).toBe('engraved');
    expect(entry(built.projection, 's2').kind).toBe('engraved');
  });

  it('a chord absorbed by a collision takes its duplicate-pitch member with it, resolved', () => {
    // 'twin' merges into 'low' (same pitch, same chord); that whole event then loses the grid
    // collision to the longer one. The pointer must end at a note that has a glyph.
    const notes: InputNote[] = [
      { id: 'low', startSec: 0, endSec: 0.1, midi: 40 },
      { id: 'twin', startSec: 0.004, endSec: 0.1, midi: 40 },
      { id: 'late', startSec: 0.2, endSec: 0.65, midi: 47 }
    ];
    const built = build(notes, { grid: '1/4' });
    assertTotal(built.projection, built.ir, ['low', 'twin', 'late']);
    const twin = entry(built.projection, 'twin');
    expect(twin.kind).toBe('merged');
    if (twin.kind !== 'merged') return;
    // Its OWN reason is the pitch duplication; the id it names is the one still on the page.
    expect(twin.reason).toBe('chord-duplicate-pitch');
    expect(entry(built.projection, twin.mergedInto).kind).toBe('engraved');
  });
});

describe('PROJECTION — the chord law is published as data', () => {
  it('a build reports the groups the page was engraved from', () => {
    const notes: InputNote[] = [
      { id: 'root', startSec: 0, endSec: 0.4, midi: 40 },
      { id: 'fifth', startSec: 0.006, endSec: 0.4, midi: 47 },
      { id: 'apart', startSec: 0.5, endSec: 0.9, midi: 45 }
    ];
    const built = build(notes);
    const groups = built.projection.chordGroups;
    expect(groups.map((g) => g.memberIds)).toEqual([['root', 'fifth'], ['apart']]);
    expect(groups.map((g) => g.engravedIds)).toEqual([['root', 'fifth'], ['apart']]);
    expect(groups.every((g) => g.law === 'performance-window')).toBe(true);
    // The window is reported as it stood when the group closed, so a caller sees the real number.
    expect(groups[0].windowSec).toBeGreaterThanOrEqual(CHORD_WINDOW_MIN_SEC);
  });

  it('a group reports members that never reached the page', () => {
    const notes: InputNote[] = [
      { id: 'low', startSec: 0, endSec: 0.4, midi: 40 },
      { id: 'twin', startSec: 0.004, endSec: 0.4, midi: 40 }
    ];
    const built = build(notes);
    const group = built.projection.chordGroups[0];
    expect(group.memberIds).toEqual(['low', 'twin']);
    expect(group.engravedIds).toEqual(['low']);
  });

  it('a written source groups by written tick and consults no window at all', () => {
    const timing = (startTick: number, endTick: number) => ({ ppq: 480, startTick, endTick });
    const notes: InputNote[] = [
      { id: 'a', startSec: 0, endSec: 0.5, midi: 40, sourceTiming: timing(0, 480) },
      { id: 'b', startSec: 0, endSec: 0.5, midi: 47, sourceTiming: timing(0, 480) },
      { id: 'c', startSec: 0.5, endSec: 1.0, midi: 45, sourceTiming: timing(480, 960) }
    ];
    const built = build(notes);
    const groups = built.projection.chordGroups;
    expect(groups.map((g) => g.memberIds)).toEqual([['a', 'b'], ['c']]);
    expect(groups.map((g) => g.law)).toEqual(['written-tick', 'written-tick']);
    expect(groups.map((g) => g.windowSec)).toEqual([0, 0]);
  });

  it('THE FLOOR IS NOT A SAFE APPROXIMATION OF THE LAW — chaining over-merges', () => {
    // The webcore facade claimed that grouping on `CHORD_WINDOW_MIN_SEC` "can merge fewer pairs
    // than the pipeline does but never more", i.e. that a caller holding the floor is safely
    // stricter than the engraver. It is not, because the law is a greedy partition measured from
    // each group's FIRST note and the floor is a pairwise threshold. Onsets 34 ms apart in a
    // chain: the engraver closes the first group and starts a second; a floor test says the last
    // two are one chord. It merged a pair the page splits.
    const notes: InputNote[] = [
      { id: 'n0', startSec: 0, endSec: 0.4, midi: 40 },
      { id: 'n1', startSec: 0.034, endSec: 0.4, midi: 44 },
      { id: 'n2', startSec: 0.068, endSec: 0.4, midi: 47 }
    ];
    expect(chordGroupsOf(notes, 0.5).map((g) => g.ids)).toEqual([['n0', 'n1'], ['n2']]);
    // and the floor, applied pairwise, disagrees in the direction the comment ruled out:
    expect(notes[2].startSec - notes[1].startSec).toBeLessThanOrEqual(CHORD_WINDOW_MIN_SEC);
  });

  it('THE FLOOR IS NOT A SAFE APPROXIMATION OF THE LAW — a written source ignores it', () => {
    // Two imported notes 3 ms apart on DIFFERENT written ticks are two events to the engraver and
    // one chord to anything holding a 35 ms threshold. No number can fix this: the law on this
    // path is not a window.
    const timing = (startTick: number) => ({ ppq: 480, startTick, endTick: startTick + 480 });
    const notes: InputNote[] = [
      { id: 'a', startSec: 0, endSec: 0.5, midi: 40, sourceTiming: timing(0) },
      { id: 'b', startSec: 0.003, endSec: 0.5, midi: 47, sourceTiming: timing(60) }
    ];
    expect(chordGroupsOf(notes, 0.5).map((g) => g.ids)).toEqual([['a'], ['b']]);
    expect(notes[1].startSec - notes[0].startSec).toBeLessThan(CHORD_WINDOW_MIN_SEC);
  });

  it('`chordGroupsOf` gives the same partition a build does', () => {
    const notes: InputNote[] = [
      { id: 'root', startSec: 0, endSec: 0.4, midi: 40 },
      { id: 'fifth', startSec: 0.006, endSec: 0.4, midi: 47 },
      { id: 'apart', startSec: 0.5, endSec: 0.9, midi: 45 }
    ];
    const built = build(notes);
    // 120 bpm from `grid()`, so the beat period the build measured is 0.5 s.
    expect(chordGroupsOf(notes, 0.5).map((g) => g.ids)).toEqual(
      built.projection.chordGroups.map((g) => g.memberIds)
    );
  });
});

describe('PROJECTION — a stale notation intent is reported, never honoured in silence', () => {
  it('a declaration the span carries is honoured and raises nothing', () => {
    const built = build([{ id: 'd0', startSec: 0, endSec: 0.05, midi: 40, notationIntent: { denominator: 4, dots: 0 } }]);
    const record = entry(built.projection, 'd0');
    if (record.kind !== 'engraved') throw new Error('expected engraved');
    expect(record.engravedTicks).toBe(24);
    expect(record.intentIgnored).toBeUndefined();
  });

  it('a bar-split declaration is still honoured: the pieces total the declared value', () => {
    const built = build([{ id: 'd0', startSec: 0, endSec: 0.05, midi: 40, notationIntent: { denominator: 1, dots: 1 } }]);
    const record = entry(built.projection, 'd0');
    if (record.kind !== 'engraved') throw new Error('expected engraved');
    expect(record.engravedTicks).toBe(144);
    expect(record.intentIgnored).toBeUndefined();
  });

  it('THE STALE CASE: a span the next attack trimmed cannot carry the declaration', () => {
    // A whole note declared at tick 0 with the next attack on tick 48. The page gives it 48, and
    // the stored value now claims something the page contradicts — which is what a timing edit
    // that moved either note leaves behind. The seam clears it on seeing this.
    const notes: InputNote[] = [
      { id: 'd0', startSec: 0, endSec: 0.05, midi: 40, notationIntent: { denominator: 1, dots: 0 } },
      { id: 'next', startSec: 1.0, endSec: 1.4, midi: 43 }
    ];
    const built = build(notes);
    const record = entry(built.projection, 'd0');
    if (record.kind !== 'engraved') throw new Error('expected engraved');
    expect(record.engravedTicks).toBe(48);
    expect(record.intentIgnored).toEqual({
      reason: 'not-carried',
      declaredTicks: 96,
      engravedTicks: 48,
      toleranceTicks: built.diagnostics.basicQuantTicks
    });
  });

  it('the tolerance is one subdivision: a miss inside it is not a stale intent', () => {
    const built = build([{ id: 'd0', startSec: 0, endSec: 0.05, midi: 40, notationIntent: { denominator: 4, dots: 0 } }]);
    const record = entry(built.projection, 'd0');
    if (record.kind !== 'engraved') throw new Error('expected engraved');
    // The engraved value equals the declared one here; the point of the assertion is the rule the
    // verdict uses, so state it against the numbers the build reported.
    expect(Math.abs(record.engravedTicks - 24)).toBeLessThanOrEqual(built.diagnostics.basicQuantTicks);
    expect(record.intentIgnored).toBeUndefined();
  });

  it('a chord mate with a longer declaration supersedes this one', () => {
    const notes: InputNote[] = [
      { id: 'lo', startSec: 0, endSec: 0.4, midi: 40, notationIntent: { denominator: 4, dots: 0 } },
      { id: 'hi', startSec: 0.006, endSec: 0.4, midi: 47, notationIntent: { denominator: 8, dots: 0 } }
    ];
    const built = build(notes);
    const superseded = entry(built.projection, 'hi');
    if (superseded.kind !== 'engraved') throw new Error('expected engraved');
    expect(superseded.intentIgnored?.reason).toBe('chord-superseded');
    expect(superseded.intentIgnored?.declaredTicks).toBe(12);
    // The winner's own declaration decided the slot, so it raises nothing.
    expect((entry(built.projection, 'lo') as { intentIgnored?: unknown }).intentIgnored).toBeUndefined();
  });

  it('a declaration off the tuplet lattice is reported as the lattice, not as a bad length', () => {
    // Three eighth-triplets in beat 1 make a group whose unit is 8 ticks. A dotted eighth is 18,
    // which is not a whole number of them, so the lattice reshapes it.
    const third = 0.5 / 3;
    const notes: InputNote[] = [
      { id: 't0', startSec: 0, endSec: third * 0.8, midi: 40, notationIntent: { denominator: 8, dots: 1 } },
      { id: 't1', startSec: third, endSec: third * 1.8, midi: 43 },
      { id: 't2', startSec: third * 2, endSec: third * 2.8, midi: 45 },
      { id: 't3', startSec: 0.5, endSec: 0.9, midi: 40 }
    ];
    const built = buildScore(input(notes, grid(2)), settings({ ...STAFF, grid: '1/8T' }));
    const record = entry(built.projection, 't0');
    if (record.kind !== 'engraved') throw new Error('expected engraved');
    expect(record.intentIgnored?.reason).toBe('tuplet-lattice');
    expect(record.intentIgnored?.toleranceTicks).toBe(8);
  });

  it('a written source never consults a declaration, and the projection says which', () => {
    const timing = (startTick: number, endTick: number) => ({ ppq: 480, startTick, endTick });
    const notes: InputNote[] = [
      { id: 's0', startSec: 0, endSec: 0.5, midi: 40, sourceTiming: timing(0, 480), notationIntent: { denominator: 1, dots: 0 } },
      { id: 's1', startSec: 0.5, endSec: 1.0, midi: 45, sourceTiming: timing(480, 960) }
    ];
    const built = build(notes);
    const record = entry(built.projection, 's0');
    if (record.kind !== 'engraved') throw new Error('expected engraved');
    expect(record.intentIgnored?.reason).toBe('symbolic-source');
  });

  it('an unprintable declaration is reported rather than silently measured', () => {
    const built = build([{ id: 'd0', startSec: 0, endSec: 0.05, midi: 40, notationIntent: { denominator: 32, dots: 1 } }]);
    const record = entry(built.projection, 'd0');
    if (record.kind !== 'engraved') throw new Error('expected engraved');
    expect(record.intentIgnored).toMatchObject({ reason: 'unprintable', declaredTicks: null });
  });

  it('a note with no declaration never raises a verdict', () => {
    const built = build([{ id: 'plain', startSec: 0, endSec: 0.45, midi: 40 }]);
    const record = entry(built.projection, 'plain');
    if (record.kind !== 'engraved') throw new Error('expected engraved');
    expect(record.intentIgnored).toBeUndefined();
  });
});

describe('PROJECTION — multi-part', () => {
  it('each part reports its own total projection under the namespaced ids', () => {
    const result = buildMultiPartScore(
      [
        { notes: [{ id: 'x', startSec: 0, endSec: 0.45, midi: 40 }] },
        { notes: [{ id: 'y', startSec: 0.5, endSec: 0.95, midi: 55 }], instrument: 'staff', tuningMidi: [] }
      ],
      { beats: grid(4).beats, downbeats: grid(4).downbeats },
      settings({ ...STAFF })
    );
    expect([...result.parts[0].projection.byId.keys()]).toEqual(['x']);
    expect([...result.parts[1].projection.byId.keys()]).toEqual(['p2-y']);
    for (const part of result.parts) {
      assertTotal(part.projection, part.ir, [...part.projection.byId.keys()]);
    }
  });
});

/** Deterministic PRNG — the sweep has to be reproducible or a failure cannot be investigated. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A take built to hit the loss points on purpose: tight clusters (chords, and duplicate pitches
 * inside them), near-coincident events (grid collisions), sub-30 ms blips, and notes past the
 * declared end of the audio.
 */
function randomTake(random: () => number, bars: number): InputNote[] {
  const notes: InputNote[] = [];
  const spanSec = bars * 2;
  let id = 0;
  for (let i = 0; i < 24; i++) {
    const start = random() * spanSec;
    const midi = 33 + Math.floor(random() * 24);
    const roll = random();
    const length = roll < 0.15 ? 0.005 + random() * 0.02 : 0.05 + random() * 0.5;
    notes.push({ id: `r${id++}`, startSec: start, endSec: start + length, midi });
    if (roll > 0.7) {
      // A chord mate inside the window, sometimes at the SAME pitch (the dedup path).
      const mate = random() < 0.5 ? midi : 33 + Math.floor(random() * 24);
      notes.push({ id: `r${id++}`, startSec: start + random() * 0.03, endSec: start + length, midi: mate });
    }
    if (roll > 0.85) {
      // Just outside the chord window and well inside one grid step — a collision candidate.
      notes.push({ id: `r${id++}`, startSec: start + 0.05 + random() * 0.1, endSec: start + length, midi: midi + 5 });
    }
  }
  return notes;
}

describe('PROJECTION — property sweep', () => {
  it('every input id appears exactly once, on every grid, on every seed', () => {
    let sawMerged = 0;
    let sawDropped = 0;
    let sawEngraved = 0;
    let sawUnengraved = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const random = mulberry32(seed);
      const bars = 4;
      const notes = randomTake(random, bars);
      const ids = notes.map((n) => n.id!);
      for (const gridSetting of ALL_GRIDS) {
        // Every third seed declares an audio length shorter than the take, so the past-end guard
        // is exercised rather than merely present.
        const built = buildScore(
          input(notes, grid(bars), seed % 3 === 0 ? { audioDurationSec: bars * 1.5 } : {}),
          settings({ ...STAFF, grid: gridSetting })
        );
        const { counts } = built.projection;
        expect(counts.input, `seed ${seed} grid ${gridSetting}`).toBe(ids.length);
        expect(counts.engraved + counts.merged + counts.dropped, `seed ${seed} grid ${gridSetting}`).toBe(ids.length);
        assertTotal(built.projection, built.ir, ids);
        sawEngraved += counts.engraved;
        sawMerged += counts.merged;
        sawDropped += counts.dropped;
        for (const record of built.projection.byId.values()) {
          if (record.kind === 'dropped' && record.reason === 'unengraved') sawUnengraved++;
        }
      }
    }
    // The sweep has to actually exercise the loss points, or it proves only that nothing happened.
    expect(sawEngraved).toBeGreaterThan(0);
    expect(sawMerged).toBeGreaterThan(0);
    expect(sawDropped).toBeGreaterThan(0);
    // And nothing may reach the backstop: an `unengraved` verdict means a station removed a note
    // without recording it, which is the exact fault this module exists to make impossible.
    expect(sawUnengraved).toBe(0);
  });

  it('the chord partition covers every guarded note exactly once', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const notes = randomTake(mulberry32(seed), 4);
      const built = buildScore(input(notes, grid(4)), settings({ ...STAFF }));
      const members = built.projection.chordGroups.flatMap((g) => g.memberIds);
      // Guards run before chord grouping, so the partition covers the SURVIVORS, and every one of
      // them exactly once — a note in two chords would be printed twice.
      expect(new Set(members).size, `seed ${seed}`).toBe(members.length);
      expect(members.slice().sort()).toEqual(built.notes.map((n) => n.id!).sort());
    }
  });
});
