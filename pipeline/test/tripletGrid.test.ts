/**
 * TRIPLET GRID (`grid: '1/8T'`) — the quantize setting the UI spells "Triplet".
 *
 * THE REGRESSION. With Quantize = Triplet on a triplet-timed take the build died and the app
 * had no score at all. Three defects in a chain, each of which these cover directly:
 *
 *   1. the state set withheld `straight-8`, so any beat the tuplet gates rejected fell through
 *      to the whole-beat lattice — a straight eighth snapped a half beat onto its neighbour and
 *      the collision fuse deleted one of the two attacks;
 *   2. tuplet membership was read off the beat a note was PLAYED in rather than the tick it
 *      landed on, so a note that snapped forward onto a triplet downbeat sat inside a group
 *      carrying no group, and its third of a beat went to the straight splitter;
 *   3. rests inside a group went to the straight splitter unconditionally.
 *
 * (2) and (3) both end at the same crash: a third of a beat has no straight spelling, so the
 * splitter emitted its "un-notatable remainder" and a 32nd glyph claimed 2 ticks where a 32nd
 * is 3. MusicXML's <type>-vs-<duration> assertion threw, and the build with it.
 */

import { describe, expect, it } from 'vitest';

import { buildScore } from '../src/buildScore.js';
import { quantizeOnsets, type QuantNote } from '../src/quantize.js';
import { BASS4, grid, input, round, settings } from './helpers.js';
import type { IRBeat, RiffsheetIR } from '../src/ir.js';
import type { InputNote } from '../src/types.js';

/** Exactly what `toBuildSettings()` in webcore emits when Quantize = Triplet. */
const tripletSettings = settings({
  grid: '1/8T',
  instrument: 'bass4',
  tuningMidi: BASS4,
  fingeringStyle: 'low',
  clefMode: 'auto',
  capo: 0,
  showStaccato: true,
  title: 'Riff'
});

/** Eighth-note triplets: three evenly spaced attacks per beat. */
function tripletNotes(
  beats: { beat: number; midi: number[]; gate?: number }[],
  bpm = 120,
  startSec = 0
): InputNote[] {
  const period = 60 / bpm;
  const out: InputNote[] = [];
  let i = 0;
  for (const b of beats) {
    const slot = period / 3;
    b.midi.forEach((m, k) => {
      if (m < 0) return; // negative = a silent slot (rest)
      const start = startSec + b.beat * period + k * slot;
      out.push({
        id: `t${i++}`,
        startSec: round(start),
        endSec: round(start + slot * (b.gate ?? 0.9)),
        midi: m,
        velocity: 96
      });
    });
  }
  return out;
}

function allBeats(ir: RiffsheetIR): IRBeat[] {
  const out: IRBeat[] = [];
  for (const bar of ir.bars) for (const v of bar.voices) out.push(...v.beats);
  return out;
}

/**
 * ATTACKS on the page: one per note played, no more and — for these fixtures — no fewer.
 * A glyph that only continues a tie is the same attack still sounding, so it does not count.
 */
function attackCount(ir: RiffsheetIR): number {
  let n = 0;
  for (const b of allBeats(ir)) if (!b.isRest) n += b.notes.filter((note) => !note.tieStop).length;
  return n;
}

const tupletGlyphs = (ir: RiffsheetIR): IRBeat[] => allBeats(ir).filter((b) => b.tuplet);

/**
 * TUPLET BALANCE, per group per bar: exactly one start and one stop, and the members' SOUNDING
 * ticks add up to whole written beats (three eighth-triplet units = one 24-tick beat). This is
 * the shape MusicXML's own bracket check enforces on the way out.
 */
function tupletDefects(ir: RiffsheetIR): string[] {
  const bad: string[] = [];
  for (const bar of ir.bars) {
    for (const v of bar.voices) {
      const groups = new Map<string, IRBeat[]>();
      for (const b of v.beats) {
        if (!b.tuplet) continue;
        groups.set(b.tuplet.id, [...(groups.get(b.tuplet.id) ?? []), b]);
      }
      for (const [id, members] of groups) {
        const starts = members.filter((m) => m.tuplet!.start).length;
        const stops = members.filter((m) => m.tuplet!.stop).length;
        if (starts !== 1 || stops !== 1) bad.push(`bar ${bar.number} ${id}: ${starts} start / ${stops} stop`);
        const ticks = members.reduce((a, m) => a + m.durTicks, 0);
        if (ticks % 24 !== 0) bad.push(`bar ${bar.number} ${id}: ${ticks} ticks is not whole beats`);
        const contiguous = members.every(
          (m, i) => i === 0 || m.startTick === members[i - 1].startTick + members[i - 1].durTicks
        );
        if (!contiguous) bad.push(`bar ${bar.number} ${id}: members are not contiguous`);
      }
    }
  }
  return bad;
}

/** Written value of every glyph must equal its sounding ticks, tuplet scaling included. */
const WRITTEN: Record<string, number> = { whole: 96, half: 48, quarter: 24, eighth: 12, '16th': 6, '32nd': 3 };

function durationDefects(ir: RiffsheetIR): string[] {
  const bad: string[] = [];
  for (const b of allBeats(ir)) {
    if (b.measureRest) continue;
    const dotted = b.dots ? 1.5 : 1;
    const scale = b.tuplet ? b.tuplet.normal / b.tuplet.actual : 1;
    const expected = WRITTEN[b.durationType] * dotted * scale;
    if (expected !== b.durTicks) {
      bad.push(`${b.isRest ? 'rest' : 'note'} ${b.durationType}+${b.dots} = ${expected} ticks, durTicks ${b.durTicks}`);
    }
  }
  return bad;
}

describe('triplet grid (1/8T)', () => {
  it('builds a pure eighth-triplet take', () => {
    const notes = tripletNotes([
      { beat: 0, midi: [40, 43, 45] },
      { beat: 1, midi: [40, 43, 45] },
      { beat: 2, midi: [40, 43, 45] },
      { beat: 3, midi: [40, 43, 45] }
    ]);
    const result = buildScore(input(notes, grid(1)), tripletSettings);

    expect(result.ir.bars.length).toBeGreaterThan(0);
    expect(attackCount(result.ir)).toBe(notes.length);
    expect(tupletDefects(result.ir)).toEqual([]);
    expect(durationDefects(result.ir)).toEqual([]);

    // Twelve eighth-triplets, every one of them 8 ticks written as an eighth under 3:2.
    const tuplets = tupletGlyphs(result.ir);
    expect(tuplets.length).toBe(12);
    for (const t of tuplets) {
      expect(t.durTicks).toBe(8);
      expect(t.durationType).toBe('eighth');
      expect([t.tuplet!.actual, t.tuplet!.normal]).toEqual([3, 2]);
    }

    const xml = result.toMusicXML();
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml.includes('<time-modification>')).toBe(true);
    expect(result.toMidi(true).length).toBeGreaterThan(0);
    expect(result.toAlphaTabModelData().masterBars.length).toBeGreaterThan(0);
  });

  it('builds a pure eighth-triplet take that was played by a human', () => {
    // The same bar with deterministic sub-20 ms displacement: what actually arrives from the
    // detector, and what has to survive the admission gates and the collision fuse alike.
    const drift = [0.006, -0.009, 0.004, -0.005, 0.011, -0.003, 0.008, -0.011, 0.002, 0.007, -0.006, 0.005];
    const clean = tripletNotes([
      { beat: 0, midi: [40, 43, 45] },
      { beat: 1, midi: [40, 43, 45] },
      { beat: 2, midi: [40, 43, 45] },
      { beat: 3, midi: [40, 43, 45] }
    ]);
    const notes = clean.map((n, i) => ({
      ...n,
      startSec: round(n.startSec + drift[i]),
      endSec: round(n.endSec + drift[i])
    }));

    const result = buildScore(input(notes, grid(1)), tripletSettings);
    expect(attackCount(result.ir)).toBe(notes.length);
    expect(tupletGlyphs(result.ir).length).toBe(12);
    expect(tupletDefects(result.ir)).toEqual([]);
    expect(durationDefects(result.ir)).toEqual([]);
    expect(result.toMusicXML().includes('<time-modification>')).toBe(true);
  });

  it('builds a take mixing straight eighths and triplets', () => {
    // Beats 0 and 2 are straight eighths; beats 1 and 3 are triplets. The straight halves have
    // to be representable the 1/8T state set has to offer `straight-8` for.
    const period = 0.5;
    const notes: InputNote[] = [];
    let i = 0;
    const push = (start: number, len: number, midi: number): void => {
      notes.push({ id: `m${i++}`, startSec: round(start), endSec: round(start + len * 0.9), midi, velocity: 96 });
    };
    for (const beat of [0, 2]) {
      push(beat * period, period / 2, 40);
      push(beat * period + period / 2, period / 2, 43);
    }
    for (const beat of [1, 3]) {
      for (let k = 0; k < 3; k++) push(beat * period + (k * period) / 3, period / 3, 45);
    }
    notes.sort((a, b) => a.startSec - b.startSec);

    const result = buildScore(input(notes, grid(1)), tripletSettings);
    expect(result.ir.bars.length).toBeGreaterThan(0);
    // THE ATTACK COUNT IS THE POINT. Without `straight-8` the eighths at the half beat snapped
    // onto the downbeat and were fused away: ten notes played, eight on the page.
    expect(attackCount(result.ir)).toBe(notes.length);
    expect(tupletDefects(result.ir)).toEqual([]);
    expect(durationDefects(result.ir)).toEqual([]);

    // Both readings, side by side: 12-tick straight eighths and 8-tick eighth-triplets.
    const straight = allBeats(result.ir).filter((b) => !b.isRest && !b.tuplet);
    expect(straight.length).toBe(4);
    for (const b of straight) expect(b.durTicks).toBe(12);
    expect(tupletGlyphs(result.ir).length).toBe(6);

    expect(result.toMusicXML().includes('<note')).toBe(true);
    expect(result.toAlphaTabModelData().masterBars.length).toBeGreaterThan(0);
  });

  it('builds a triplet take containing rests', () => {
    // Slot 2 of each triplet is silent — the classic shuffle/"two of three" figure.
    const notes = tripletNotes([
      { beat: 0, midi: [40, -1, 45] },
      { beat: 1, midi: [40, -1, 45] },
      { beat: 2, midi: [40, 43, 45] },
      { beat: 3, midi: [40, -1, 45] }
    ]);
    const result = buildScore(input(notes, grid(1)), tripletSettings);

    expect(result.ir.bars.length).toBeGreaterThan(0);
    expect(attackCount(result.ir)).toBe(notes.length);
    expect(tupletDefects(result.ir)).toEqual([]);
    expect(durationDefects(result.ir)).toEqual([]);

    // The silent slot is a TUPLET rest — one 8-tick unit written as an eighth under 3:2 — and
    // not a straight 6 + 2 fragment, which is the split that used to kill the build.
    const rests = allBeats(result.ir).filter((b) => b.isRest && !b.measureRest);
    expect(rests.length).toBeGreaterThan(0);
    for (const r of rests) {
      expect(r.tuplet, `rest of ${r.durTicks} ticks inside a triplet beat`).toBeTruthy();
      expect(r.durTicks).toBe(8);
      expect(r.durationType).toBe('eighth');
    }

    const xml = result.toMusicXML();
    expect(xml.includes('<rest/>')).toBe(true);
    expect(result.toAlphaTabModelData().masterBars.length).toBeGreaterThan(0);
  });

  it('builds a take whose held note rings on into a triplet beat', () => {
    // The shape the sweep below found: a note struck on beat 2 and held across beat 3, which the
    // quantizer read as an eighth-triplet. The held span crosses the group's edge, so the part
    // inside it is a tuplet glyph tied to the straight part before it — handing the whole span to
    // the straight splitter left a third of a beat it had no way to spell.
    const bpm = 80;
    const period = 60 / bpm;
    const tick = period / 24;
    const at = (startTicks: number, endTicks: number, midi: number, id: string): InputNote => ({
      id,
      startSec: round(startTicks * tick),
      endSec: round(endTicks * tick),
      midi,
      velocity: 96
    });
    const notes = [
      at(24, 51, 40, 'a'),
      at(49, 92, 43, 'held'), // struck on beat 2, still ringing inside beat 3's triplet
      at(80, 87, 45, 'c'),
      at(88, 92, 47, 'd')
    ];

    const result = buildScore(input(notes, grid(1, 4, bpm)), tripletSettings);
    expect(attackCount(result.ir)).toBe(notes.length);
    expect(durationDefects(result.ir)).toEqual([]);
    expect(tupletDefects(result.ir)).toEqual([]);

    // The held note reaches the tuplet, so it owns a glyph in the tuplet's own domain.
    const heldGlyphs = allBeats(result.ir).filter((b) => b.notes.some((n) => n.id === 'held'));
    expect(heldGlyphs.length).toBeGreaterThan(1);
    expect(heldGlyphs.some((b) => b.tuplet)).toBe(true);
    expect(result.toMusicXML().startsWith('<?xml')).toBe(true);
  });

  /**
   * THE CLASS, NOT THE THREE CASES. Every failure above was the same mistake wearing a different
   * hat — a third of a beat handed to machinery that can only spell halves and quarters of one —
   * and the last of the four was found by a sweep like this one rather than by reasoning. So the
   * sweep stays: deterministic input, every beat one of straight / triplet / gapped triplet /
   * held / silent, and the only claim is that the build survives and says nothing malformed.
   */
  it('survives a deterministic sweep of triplet-shaped takes', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    let built = 0;
    for (let trial = 0; trial < 240; trial++) {
      const bpm = [80, 100, 120, 138, 176][trial % 5];
      const period = 60 / bpm;
      const bars = 1 + (trial % 3);
      const notes: InputNote[] = [];
      let id = 0;
      for (let b = 0; b < bars * 4; b++) {
        const mode = Math.floor(rnd() * 5);
        const jitter = (): number => (rnd() - 0.5) * 0.04;
        if (mode === 4) continue; // a silent beat
        if (mode === 3) {
          // one attack held for anything up to two beats — the cross-group case
          const s = b * period + jitter();
          notes.push({
            id: `s${id++}`,
            startSec: round(s),
            endSec: round(s + period * (0.6 + rnd() * 1.6)),
            midi: 40 + Math.floor(rnd() * 8)
          });
          continue;
        }
        const slots = mode === 0 ? 2 : 3; // straight eighths, or a triplet
        for (let k = 0; k < slots; k++) {
          if (mode === 2 && rnd() < 0.4) continue; // a triplet with a slot left silent
          const s = b * period + (k * period) / slots + jitter();
          notes.push({
            id: `s${id++}`,
            startSec: round(s),
            endSec: round(s + (period / slots) * (0.3 + rnd() * 1.2)),
            midi: 40 + Math.floor(rnd() * 8)
          });
        }
      }
      if (!notes.length) continue;
      notes.sort((a, b) => a.startSec - b.startSec);

      const result = buildScore(input(notes, grid(bars, 4, bpm)), tripletSettings);
      expect(durationDefects(result.ir), `trial ${trial} @ ${bpm} BPM`).toEqual([]);
      expect(tupletDefects(result.ir), `trial ${trial} @ ${bpm} BPM`).toEqual([]);
      // Both emitters, because the assertion that caught this class lives in the XML writer.
      expect(result.toMusicXML().startsWith('<?xml')).toBe(true);
      expect(result.toAlphaTabModelData().masterBars.length).toBeGreaterThan(0);
      built++;
    }
    expect(built).toBeGreaterThan(200);
  });

  // ---- the two quantizer invariants the crash was hiding behind --------------------------------

  it('membership follows the tick a note landed on, not the beat it was played in', () => {
    // Beat 0 straight (two eighths), beat 1 an eighth-triplet. The second eighth of beat 0 is
    // played late enough to round onto tick 24 — the triplet beat's downbeat. It has to come out
    // of the quantizer AS A MEMBER of that group; carrying no group is what handed a third of a
    // beat to the straight splitter.
    const notes: QuantNote[] = [
      { id: 'a', rawStartTick: 0, rawOffTick: 11 },
      { id: 'b', rawStartTick: 22, rawOffTick: 30 }, // rounds to 24 = tup-1's downbeat
      { id: 'c', rawStartTick: 32, rawOffTick: 39 },
      { id: 'd', rawStartTick: 40, rawOffTick: 47 }
    ];
    const q = quantizeOnsets(notes, { grid: '1/8T', ticksPerBeat: 24, compound: false, totalTicks: 96 });
    const landed = q.notes.find((n) => n.startTick === 24);
    expect(landed, 'an event on the triplet downbeat').toBeTruthy();
    expect(landed!.tupletId).toBeTruthy();
    const group = q.tuplets.find((t) => t.id === landed!.tupletId)!;
    expect(group.startTick).toBe(24);
    // Its length is measured in the group's units too, so it ends on the group's lattice.
    expect((landed!.offTick - group.startTick) % group.unitTicks).toBe(0);
  });

  it('an off-time reaching into a triplet group lands on that group unit lattice', () => {
    // A straight note on beat 0 that rings on into the triplet beat. Its own 1/8 step would put
    // the release at tick 36, between the group's 32 and 40 — a 4-tick gap no vocabulary, straight
    // or tuplet, can print.
    const notes: QuantNote[] = [
      { id: 'long', rawStartTick: 12, rawOffTick: 36 },
      { id: 'x', rawStartTick: 40, rawOffTick: 47 },
      { id: 'y', rawStartTick: 48, rawOffTick: 55 },
      { id: 'z', rawStartTick: 56, rawOffTick: 63 },
      { id: 'w', rawStartTick: 64, rawOffTick: 71 }
    ];
    const q = quantizeOnsets(notes, { grid: '1/8T', ticksPerBeat: 24, compound: false, totalTicks: 96 });
    for (const n of q.notes) {
      const host = q.tuplets.find((t) => n.offTick > t.startTick && n.offTick < t.endTick);
      if (!host) continue;
      expect((n.offTick - host.startTick) % host.unitTicks, `${n.id} releases at ${n.offTick}`).toBe(0);
    }
  });
});
