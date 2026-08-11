/**
 * STATION 2b, after the rest killer was deleted.
 *
 * The tests that used to live here asserted the lengthening pass: that a 60%-gate eighth came
 * out at full length, that a sub-eighth gap was absorbed across a barline, that a stretched note
 * earned a staccato dot. They were removed with the behaviour they described — keeping them
 * green would have meant keeping the behaviour. What is asserted instead is the negative: that
 * nothing lengthens a note any more, on the exact shapes those tests used.
 */

import { describe, it, expect } from 'vitest';
import { clampEventOverlaps, snapLeadingOnset, type SimplifyEvent } from '../src/simplify.js';
import { buildScore } from '../src/buildScore.js';
import { glyphs, grid, playedNotes, settings } from './helpers.js';

const DIV = 12;

describe('STATION 2b — the overlap clamp', () => {
  it('leaves measured off-times alone: there is no lengthening path left', () => {
    const events: SimplifyEvent[] = [
      { startTick: 0, offTick: 3 },
      { startTick: 6, offTick: 9 },
      { startTick: 12, offTick: 15 }
    ];
    expect(clampEventOverlaps(events).map((r) => r.offTick)).toEqual([3, 9, 15]);
  });

  it('does not absorb a sub-eighth gap — that gap is now a printed rest', () => {
    const out = clampEventOverlaps([{ startTick: 0, offTick: 6 }, { startTick: 9, offTick: 15 }]);
    expect(out[0].offTick).toBe(6);
  });

  it('does not absorb a sub-eighth gap across a barline either', () => {
    const out = clampEventOverlaps([{ startTick: 42, offTick: 45 }, { startTick: 51, offTick: 57 }]);
    expect(out[0].offTick).toBe(45);
  });

  it('cuts an off-time back to the next attack — the one adjustment it may make', () => {
    // Tick rounding pushed the first note past the second's onset. One voice, one note at a time.
    const out = clampEventOverlaps([{ startTick: 0, offTick: 14 }, { startTick: 12, offTick: 24 }]);
    expect(out[0].offTick).toBe(12);
    expect(out[1].offTick).toBe(24);
  });

  it('never shortens an event out of existence', () => {
    const out = clampEventOverlaps([{ startTick: 12, offTick: 12 }, { startTick: 12, offTick: 20 }]);
    expect(out[0].offTick).toBe(13);
    expect(out[1].offTick).toBe(20);
  });

  it('the clamp only ever shortens, never grows', () => {
    const events: SimplifyEvent[] = Array.from({ length: 8 }, (_, i) => ({
      startTick: i * 6,
      offTick: i * 6 + 3
    }));
    const out = clampEventOverlaps(events);
    out.forEach((r, i) => expect(r.offTick).toBeLessThanOrEqual(events[i].offTick));
  });

  it('snapLeadingOnset moves a sub-eighth first onset to the bar start', () => {
    expect(snapLeadingOnset(3, 0, DIV)).toBe(0);
    expect(snapLeadingOnset(6, 0, DIV)).toBe(6);
    expect(snapLeadingOnset(0, 0, DIV)).toBe(0);
  });
});

describe('STATION 2b — end to end on the shape that produced the complaint', () => {
  const positions = Array.from({ length: 16 }, (_, i) => ({ beat: i / 2, midi: 40 + (i % 3) }));

  it('a funk line of 60%-gate eighths prints SHORT notes and the rests it was actually played with', () => {
    const notes = playedNotes(positions, 0.6);
    const r = buildScore({ notes, ...grid(4) }, settings());
    const written = glyphs(r.ir).filter((g) => g !== '|');
    // 16 notes, each written at the length it sounded: a sixteenth, not a lengthened eighth.
    // (The last is the one note the fixture plays longer, so it is a genuine eighth.)
    expect(written.filter((g) => g.startsWith('N'))).toHaveLength(16);
    expect(written.filter((g) => g === 'N3')).toHaveLength(15);
    // ...and the silence between them is on the page rather than swallowed.
    expect(written.filter((g) => g === 'R3')).toHaveLength(15);
  });

  it('the deleted flag cannot switch the behaviour back on', () => {
    const notes = playedNotes(positions, 0.6);
    const off = buildScore({ notes, ...grid(4) }, settings({ fillGaps: false }));
    const on = buildScore({ notes, ...grid(4) }, settings({ fillGaps: true }));
    expect(glyphs(on.ir)).toEqual(glyphs(off.ir));
    expect(on.ir.stats.restGlyphs).toBe(off.ir.stats.restGlyphs);
  });

  it('no articulation is invented: staccato is never inferred from a duration', () => {
    // 25% gate — the shape the old Sibelius gate marked staccato after stretching it.
    const notes = playedNotes(positions, 0.25);
    const r = buildScore({ notes, ...grid(4) }, settings());
    expect(r.ir.stats.staccatoNotes).toBe(0);
    expect(r.ir.stats.gapsAbsorbed).toBe(0);
    for (const bar of r.ir.bars) {
      for (const beat of bar.voices[0].beats) {
        for (const n of beat.notes) expect(n.staccato).toBeUndefined();
      }
    }
  });
});
