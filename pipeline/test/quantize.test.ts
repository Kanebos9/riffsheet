import { describe, it, expect } from 'vitest';
import { quantizeOnsets, type QuantNote } from '../src/quantize.js';

const TPB = 12;

function notes(pairs: [number, number][]): QuantNote[] {
  return pairs.map(([start, off], i) => ({ id: `n${i}`, rawStartTick: start, rawOffTick: off }));
}
const opts = (grid: 'auto' | '1/4' | '1/8' | '1/16' | 'free' = 'auto') => ({
  grid,
  ticksPerBeat: TPB,
  compound: false,
  totalTicks: 480
});

describe('STATION 1b — onset placement', () => {
  it('snaps loose eighths onto the eighth grid', () => {
    const q = quantizeOnsets(notes([[0.4, 5], [5.7, 11], [12.3, 17], [17.6, 23]]), opts());
    expect(q.notes.map((n) => n.startTick)).toEqual([0, 6, 12, 18]);
  });

  it('a beat with only a downbeat onset picks the coarsest division, not a 16th grid', () => {
    const q = quantizeOnsets(notes([[0, 11], [12, 23], [24, 35], [36, 47]]), opts());
    expect(q.notes.map((n) => n.startTick)).toEqual([0, 12, 24, 36]);
  });

  it('RULE R4: the off-time snaps on the SAME grid as the onset, never independently', () => {
    // The old converter quantized duration on its own ladder: a 70%-gate eighth became a 16th
    // plus a 16th rest (the 78% rule, §0.3/§4.2). Here the off-time lands on the onset grid.
    const q = quantizeOnsets(notes([[0, 4.2], [6, 10.2], [12, 16.2], [18, 22.2]]), opts());
    for (const n of q.notes) {
      expect((n.offTick - n.startTick) % q.basicQuantTicks).toBe(0);
    }
  });

  it("grid:'free' imposes no musical grid at all — notated is played", () => {
    const q = quantizeOnsets(notes([[0.4, 5.6], [5.7, 11.2]]), opts('free'));
    expect(q.notes.map((n) => n.startTick)).toEqual([0, 6]);
    expect(q.notes[0].offTick).toBe(6);
    expect(q.tuplets).toHaveLength(0);
  });

  it("grid:'1/8' never offers a sixteenth", () => {
    // A GRID NAME IS AN ABSOLUTE NOTE VALUE. This case used to run at `ticksPerBeat: 12` — an
    // eighth-note beat, as in 3/8 — and assert `basicQuantTicks === 6`, which at 24 divisions
    // per quarter is a SIXTEENTH: the very glyph the test's own name forbids. That was finding
    // 13's bug written down as an expectation. On a quarter-note beat the eighth is 12 ticks.
    const q = quantizeOnsets(notes([[0, 6], [6, 12], [12, 18], [18, 24]]), { ...opts('1/8'), ticksPerBeat: 24 });
    expect(q.basicQuantTicks).toBe(12);
    for (const n of q.notes) expect(n.startTick % 12).toBe(0);
  });

  it("grid:'1/8' still means an EIGHTH when the tracked beat is itself an eighth (3/8)", () => {
    // ticksPerBeat 12 is an eighth-note pulse. The finest word the page may say is still an
    // eighth, not the half-of-a-beat sixteenth the relative ladder used to hand out.
    const q = quantizeOnsets(notes([[0, 3], [3, 6], [6, 9], [9, 12]]), opts('1/8'));
    expect(q.basicQuantTicks).toBe(12);
    for (const n of q.notes) expect(n.startTick % 12).toBe(0);
  });

  it("grid:'1/4' means a QUARTER in 3/8, not the eighth-note beat", () => {
    // The window widens to the least common multiple (24) so a quarter is expressible at all.
    const q = quantizeOnsets(notes([[0, 12], [24, 36], [48, 60]]), { ...opts('1/4'), ticksPerBeat: 12 });
    expect(q.basicQuantTicks).toBe(24);
    for (const n of q.notes) expect(n.startTick % 24).toBe(0);
  });

  it("grid:'auto' never reaches a 1/32 lattice in an x/8 meter", () => {
    const q = quantizeOnsets(notes([[0, 3], [3, 6], [6, 9], [9, 12]]), opts('auto'));
    expect(q.basicQuantTicks).toBeGreaterThanOrEqual(6);
  });
});

describe('STATION 1b — tuplet admission is deliberately hard to pass', () => {
  it('accepts a clean, fully covered eighth-note triplet', () => {
    // three evenly spaced onsets per beat, four beats running
    const raw: [number, number][] = [];
    for (let beat = 0; beat < 4; beat++) {
      for (let u = 0; u < 3; u++) {
        const t = beat * TPB + (u * TPB) / 3;
        raw.push([t + 0.2, t + 3.6]);
      }
    }
    const q = quantizeOnsets(notes(raw), opts());
    expect(q.tuplets.length).toBeGreaterThan(0);
    expect(q.tuplets[0].actual).toBe(3);
    expect(q.tuplets[0].normal).toBe(2);
    expect(q.tuplets[0].unitTicks).toBe(4);
  });

  it('REJECTS a two-note "triplet" — coverage must be complete (§6.4 rule 3)', () => {
    const raw: [number, number][] = [];
    for (let beat = 0; beat < 4; beat++) {
      raw.push([beat * TPB, beat * TPB + 3]);
      raw.push([beat * TPB + 8, beat * TPB + 11]); // only positions 0 and 2
    }
    const q = quantizeOnsets(notes(raw), opts());
    expect(q.tuplets).toHaveLength(0);
  });

  it('REJECTS straight eighths — a triplet must beat the straight reading, not tie it', () => {
    const raw: [number, number][] = [];
    for (let i = 0; i < 8; i++) raw.push([i * 6, i * 6 + 5]);
    const q = quantizeOnsets(notes(raw), opts());
    expect(q.tuplets).toHaveLength(0);
    expect(q.notes.map((n) => n.startTick)).toEqual([0, 6, 12, 18, 24, 30, 36, 42]);
  });

  it('never offers 5-, 7- or 9-plets', () => {
    const raw: [number, number][] = [];
    for (let beat = 0; beat < 4; beat++) {
      for (let u = 0; u < 5; u++) {
        const t = beat * TPB + (u * TPB) / 5;
        raw.push([t, t + 2]);
      }
    }
    const q = quantizeOnsets(notes(raw), opts());
    for (const t of q.tuplets) expect([3, 6]).toContain(t.actual);
  });

  it('a de-trended groove that sits behind the grid is still read as straight', () => {
    // 1.8 ticks is past the midpoint to the nearest sixteenth. The raw-error Viterbi therefore
    // chose sixteenths (3,9,...) even though every eighth is displaced by the same trend.
    const raw: [number, number][] = [];
    for (let i = 0; i < 8; i++) raw.push([i * 6 + 1.8, i * 6 + 5]);
    const q = quantizeOnsets(notes(raw), opts());
    expect(q.tuplets).toHaveLength(0);
    expect(q.notes.map((n) => n.startTick)).toEqual([0, 6, 12, 18, 24, 30, 36, 42]);
  });
});

describe('STATION 1b — collisions', () => {
  it('fuses two events that snap onto the same grid point', () => {
    const q = quantizeOnsets(notes([[0, 3], [0.4, 6]]), opts());
    expect(q.notes).toHaveLength(1);
    expect(q.notes[0].offTick).toBe(6);
  });
});
