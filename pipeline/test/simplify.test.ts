import { describe, it, expect } from 'vitest';
import { buildBarMetric } from '../src/meter.js';
import {
  minimizeNumberOfRests,
  quantForLen,
  snapLeadingOnset,
  STACCATO_SOUNDING_RATIO,
  STACCATO_TOL,
  type SimplifyBar,
  type SimplifyEvent
} from '../src/simplify.js';
import { buildScore } from '../src/buildScore.js';
import { glyphs, grid, playedNotes, settings } from './helpers.js';

const DIV = 12;
const metric = buildBarMetric(4, 4);
const bars = (n: number): SimplifyBar[] =>
  Array.from({ length: n }, (_, i) => ({ startTick: i * 48, ticks: 48, metric }));

function run(events: SimplifyEvent[], over: Partial<Parameters<typeof minimizeNumberOfRests>[1]> = {}) {
  return minimizeNumberOfRests(events, {
    divisions: DIV,
    bars: bars(2),
    basicQuantTicks: 3,
    compound: false,
    tuplets: new Map(),
    fillGaps: true,
    showStaccato: true,
    ...over
  });
}

describe('quantForLen — the adaptive off-time grid', () => {
  it('keeps basicQuant for notes longer than it', () => {
    expect(quantForLen(12, 3)).toBe(3);
    expect(quantForLen(6, 3)).toBe(3);
  });
  it('halves while quant exceeds the note length', () => {
    expect(quantForLen(2, 3)).toBe(1);
  });
  it('reduceQuantIfDottedNote: halves again inside (1.45, 1.55)', () => {
    // 4.5 / 3 = 1.5 -> the dotted neighbourhood
    expect(quantForLen(4.5, 3)).toBe(1);
    expect(quantForLen(4.2, 3)).toBe(3); // 1.4, outside
  });
});

describe('STATION 2b — the rest killer', () => {
  it('a 60%-gate eighth is written full length instead of note + rest', () => {
    // eight eighths, each sounding 60% of its slot. This is the user complaint verbatim.
    const events: SimplifyEvent[] = Array.from({ length: 8 }, (_, i) => ({
      startTick: i * 6,
      offTick: i * 6 + 3
    }));
    const out = run(events);
    for (let i = 0; i < 7; i++) expect(out[i].offTick).toBe((i + 1) * 6);
  });

  it('DOES NOT over-correct into legato: a genuine two-beat silence survives as a rest', () => {
    // §3.1: rule 2's upper bound is the next onset AND the next beat boundary, so a real
    // silence produces fewer glyphs written as a rest than swallowed.
    const events: SimplifyEvent[] = [
      { startTick: 0, offTick: 10 },
      { startTick: 36, offTick: 46 }
    ];
    const out = run(events);
    expect(out[0].offTick).toBeLessThanOrEqual(12); // capped at the next beat boundary
    expect(36 - out[0].offTick).toBeGreaterThanOrEqual(24); // two beats of silence remain
  });

  it('the growth cap is min(next onset, next beat, bar end)', () => {
    const out = run([{ startTick: 0, offTick: 3 }, { startTick: 24, offTick: 30 }]);
    expect(out[0].offTick).toBe(12); // next beat boundary, not the next onset at 24
  });

  it('never leaves a gap shorter than an eighth', () => {
    const out = run([{ startTick: 0, offTick: 3 }, { startTick: 3, offTick: 9 }]);
    expect(out[0].offTick).toBe(3);
    // the 3-tick note is followed immediately, so nothing to absorb; the next gap is checked:
    const out2 = run([{ startTick: 0, offTick: 6 }, { startTick: 9, offTick: 15 }]);
    expect(out2[0].offTick).toBe(9); // a 3-tick (sixteenth) gap is absorbed outright
  });

  it('absorbs a sub-eighth gap ACROSS a barline — where the glyph search is not allowed to go', () => {
    const out = run([{ startTick: 42, offTick: 45 }, { startTick: 51, offTick: 57 }]);
    expect(out[0].offTick).toBe(51);
  });

  it('fillGaps:false leaves the measured off-times alone', () => {
    const events: SimplifyEvent[] = [{ startTick: 0, offTick: 3 }, { startTick: 6, offTick: 9 }];
    const out = run(events, { fillGaps: false });
    expect(out.map((o) => o.offTick)).toEqual([3, 9]);
  });

  it('snapLeadingOnset moves a sub-eighth first onset to the bar start', () => {
    expect(snapLeadingOnset(3, 0, DIV)).toBe(0);
    expect(snapLeadingOnset(6, 0, DIV)).toBe(6);
    expect(snapLeadingOnset(0, 0, DIV)).toBe(0);
  });
});

describe('STATION 2b — staccato', () => {
  it('the constants are the documented ones', () => {
    expect(STACCATO_TOL).toBe(0.3);
    expect(STACCATO_SOUNDING_RATIO).toBe(0.35);
  });

  it('a genuinely short note gets a staccato dot at full written value', () => {
    const out = run([
      { startTick: 0, offTick: 3, soundingRatio: 0.25 },
      { startTick: 12, offTick: 24 }
    ]);
    expect(out[0].offTick).toBe(12); // full quarter
    expect(out[0].staccato).toBe(true);
  });

  it('a merely early RELEASE does not: the Sibelius gate refuses to lie about articulation', () => {
    const out = run([
      { startTick: 0, offTick: 3, soundingRatio: 0.75 },
      { startTick: 12, offTick: 24 }
    ]);
    expect(out[0].offTick).toBe(12); // still lengthened
    expect(out[0].staccato).toBe(false); // but not marked short
  });

  it('never staccatos a tie chain', () => {
    // a note long enough to need two glyphs cannot be a single staccato symbol
    const out = run([{ startTick: 3, offTick: 6, soundingRatio: 0.1 }, { startTick: 45, offTick: 48 }]);
    if (out[0].staccato) expect(out[0].offTick - 3).toBeLessThanOrEqual(12);
  });
});

describe('STATION 2b — end to end on the shape that produced the complaint', () => {
  it('a funk line of 60%-gate eighths prints as eighths, with no rests', () => {
    const positions = Array.from({ length: 16 }, (_, i) => ({ beat: i / 2, midi: 40 + (i % 3) }));
    const notes = playedNotes(positions, 0.6);
    const r = buildScore({ notes, ...grid(4) }, settings());
    expect(r.ir.stats.restGlyphs).toBe(0);
    expect(glyphs(r.ir).filter((g) => g.startsWith('N'))).toHaveLength(16);
  });

  it('fillGaps:false reproduces the old behaviour, which is the point of the flag', () => {
    const positions = Array.from({ length: 16 }, (_, i) => ({ beat: i / 2, midi: 40 }));
    const notes = playedNotes(positions, 0.6);
    const off = buildScore({ notes, ...grid(4) }, settings({ fillGaps: false }));
    const on = buildScore({ notes, ...grid(4) }, settings({ fillGaps: true }));
    expect(off.ir.stats.restGlyphs).toBeGreaterThan(on.ir.stats.restGlyphs);
  });
});
