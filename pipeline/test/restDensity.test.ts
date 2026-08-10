/**
 * THE SUCCESS CRITERION.
 *
 * midi-to-notation-research.md §5: "Rest density on the corpora, measured the same way as §0.2.
 * Today: 22% of glyphs on our own preview export. Human target: 0.6-3%. Anything under ~5%,
 * with no rest shorter than an eighth and no tuplet rests, is a fixed sheet."
 *
 * Measured on original deterministic stress phrases with a realistic 70-90% gate — i.e. every
 * single note ends early, which is exactly the input that used to produce a rest after every
 * note. No third-party corpus data is stored in the repository.
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { SYNTHETIC_FIXTURES, SYNTHETIC_TUNING } from '../fixtures/synthetic.js';
import { readMusicXml } from './xmlReader.js';
import { settings } from './helpers.js';

interface Totals {
  notes: number;
  rests: number;
  short: number;
  tupletRests: number;
}

function measure(which: 'notes' | 'notesRaw', fillGaps = true): { totals: Totals; perTrack: Map<string, number> } {
  const totals: Totals = { notes: 0, rests: 0, short: 0, tupletRests: 0 };
  const perTrack = new Map<string, number>();
  for (const f of SYNTHETIC_FIXTURES) {
    const r = buildScore(
      {
        notes: f[which],
        beats: f.beats,
        downbeats: f.downbeats,
        audioDurationSec: f.audioDurationSec
      },
      settings({ tuningMidi: SYNTHETIC_TUNING, fillGaps })
    );
    const s = r.ir.stats;
    totals.notes += s.noteGlyphs;
    totals.rests += s.restGlyphs;
    totals.short += s.restsShorterThanEighth;
    totals.tupletRests += s.tupletRests;
    perTrack.set(f.id, s.restDensity);
  }
  return { totals, perTrack };
}

describe('REST DENSITY — the hard criterion', () => {
  const { totals, perTrack } = measure('notes');
  const density = totals.rests / (totals.notes + totals.rests);

  it('the stress set is actually loaded (six phrases, 768 notes)', () => {
    expect(SYNTHETIC_FIXTURES).toHaveLength(6);
    expect(SYNTHETIC_FIXTURES.reduce((a, f) => a + f.notes.length, 0)).toBe(768);
    expect(totals.notes).toBeGreaterThan(700);
  });

  it('rest density is under 5% across the corpus', () => {
    expect(density).toBeLessThan(0.05);
  });

  it('rest density is in the human band measured on FiloBass (0.6% of glyphs)', () => {
    expect(density).toBeLessThan(0.03);
  });

  it('ZERO rests shorter than an eighth — the FiloBass vocabulary rule', () => {
    expect(totals.short).toBe(0);
  });

  it('ZERO tuplet rests', () => {
    expect(totals.tupletRests).toBe(0);
  });

  it('no single track is above 10%', () => {
    for (const [id, d] of perTrack) {
      expect(d, `track ${id}`).toBeLessThan(0.1);
    }
  });

  it('holds on the corpus RAW offsets too, not just the synthetic gate', () => {
    const raw = measure('notesRaw');
    const rawDensity = raw.totals.rests / (raw.totals.notes + raw.totals.rests);
    expect(rawDensity).toBeLessThan(0.05);
    expect(raw.totals.short).toBe(0);
  });

  it('fillGaps:false is measurably worse — proving the rest killer is what is doing the work', () => {
    const off = measure('notes', false);
    const offDensity = off.totals.rests / (off.totals.notes + off.totals.rests);
    expect(offDensity).toBeGreaterThan(density * 2);
  });
});

describe('REST DENSITY — the same numbers survive serialization', () => {
  it('counting rests in the emitted MusicXML agrees with the IR stats', () => {
    let xmlNotes = 0;
    let xmlRests = 0;
    for (const f of SYNTHETIC_FIXTURES) {
      const r = buildScore(
        { notes: f.notes, beats: f.beats, downbeats: f.downbeats, audioDurationSec: f.audioDurationSec },
        settings({ tuningMidi: SYNTHETIC_TUNING })
      );
      const read = readMusicXml(r.toMusicXML());
      for (const n of read.notes) {
        if (n.staff !== 1) continue;
        if (n.chord) continue;
        if (n.isRest) xmlRests++;
        else xmlNotes++;
      }
    }
    const xmlDensity = xmlRests / (xmlNotes + xmlRests);
    expect(xmlDensity).toBeLessThan(0.05);
  });
});

function tabMovement(style: 'low' | 'minMovement'): number {
  let movement = 0;
  for (const f of SYNTHETIC_FIXTURES) {
    const r = buildScore(
      { notes: f.notes, beats: f.beats, downbeats: f.downbeats, audioDurationSec: f.audioDurationSec },
      settings({ tuningMidi: SYNTHETIC_TUNING, fingeringStyle: style })
    );
    const assigned = new Map<string, { string: number; fret: number }>();
    for (const bar of r.ir.bars) {
      for (const beat of bar.voices[0].beats) {
        for (const n of beat.notes) {
          if (n.string !== undefined && n.fret !== undefined && !assigned.has(n.id)) {
            assigned.set(n.id, { string: n.string, fret: n.fret });
          }
        }
      }
    }
    const positions = f.notes
      .map((_, i) => assigned.get(`n${i}`))
      .filter((position): position is { string: number; fret: number } => position !== undefined);
    for (let i = 1; i < positions.length; i++) {
      movement += Math.abs(positions[i].fret - positions[i - 1].fret);
      movement += Math.abs(positions[i].string - positions[i - 1].string) * 2;
    }
  }
  return movement;
}

describe('TAB — original position-playing stress phrases', () => {
  it("'low' produces a valid non-zero movement baseline", () => {
    expect(tabMovement('low')).toBeGreaterThan(0);
  });

  it("'minMovement' moves less than 'low' across string-boundary alternations", () => {
    expect(tabMovement('minMovement')).toBeLessThan(tabMovement('low'));
  });

  it('every assigned position actually produces the sounding pitch', () => {
    let checked = 0;
    for (const f of SYNTHETIC_FIXTURES) {
      const r = buildScore(
        { notes: f.notes, beats: f.beats, downbeats: f.downbeats, audioDurationSec: f.audioDurationSec },
        settings({ tuningMidi: SYNTHETIC_TUNING, fingeringStyle: 'low' })
      );
      for (const bar of r.ir.bars) {
        for (const beat of bar.voices[0].beats) {
          for (const n of beat.notes) {
            if (n.string === undefined || n.fret === undefined) continue;
            // IR string 1 = lowest, so the tuning index is string - 1.
            expect(SYNTHETIC_TUNING[n.string - 1] + n.fret).toBe(n.midi);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(700);
  });
});
