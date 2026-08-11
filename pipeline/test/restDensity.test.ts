/**
 * THE CRITERION, AND THE ONE IT REPLACED.
 *
 * This file used to be called THE SUCCESS CRITERION and it measured rest density: 22% of glyphs
 * on the old preview export, 0.6-3% for human transcribers, "anything under ~5% is a fixed
 * sheet". The pipeline got there by lengthening every note over the silence behind it until the
 * rests stopped being printed, and the number came down to 0.49%.
 *
 * That number is gone and so is the pass that produced it. Rest density is now a DESCRIPTION of
 * the take, not a target: a stress corpus played at a 70-90% gate genuinely contains a lot of
 * short silence, and printing it is the honest answer. On this corpus the figure is ~19%, and
 * the six phrases have not changed — only what we claim about them.
 *
 * What replaces it is DURATION FIDELITY: every note is written at the length it was played,
 * snapped to the grid and to nothing else. That is checkable exactly, which the old target
 * never was.
 *
 * Measured on original deterministic stress phrases. No third-party corpus data is stored in
 * the repository.
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { SYNTHETIC_FIXTURES, SYNTHETIC_TUNING } from '../fixtures/synthetic.js';
import { readMusicXml } from './xmlReader.js';
import { settings } from './helpers.js';
import type { RiffsheetIR } from '../src/ir.js';
import type { FingeringStyle } from '../src/types.js';

interface Totals {
  notes: number;
  rests: number;
  short: number;
  tupletRests: number;
}

function build(which: 'notes' | 'notesRaw', over: Parameters<typeof settings>[0] = {}): RiffsheetIR[] {
  return SYNTHETIC_FIXTURES.map(
    (f) =>
      buildScore(
        { notes: f[which], beats: f.beats, downbeats: f.downbeats, audioDurationSec: f.audioDurationSec },
        settings({ tuningMidi: SYNTHETIC_TUNING, ...over })
      ).ir
  );
}

function measure(which: 'notes' | 'notesRaw', over: Parameters<typeof settings>[0] = {}): {
  totals: Totals;
  perTrack: Map<string, number>;
} {
  const totals: Totals = { notes: 0, rests: 0, short: 0, tupletRests: 0 };
  const perTrack = new Map<string, number>();
  build(which, over).forEach((ir, i) => {
    const s = ir.stats;
    totals.notes += s.noteGlyphs;
    totals.rests += s.restGlyphs;
    totals.short += s.restsShorterThanEighth;
    totals.tupletRests += s.tupletRests;
    perTrack.set(SYNTHETIC_FIXTURES[i].id, s.restDensity);
  });
  return { totals, perTrack };
}

/** Total written ticks per source note id, across ties and across bars. */
function writtenTicks(ir: RiffsheetIR): Map<string, number> {
  const out = new Map<string, number>();
  for (const bar of ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        for (const n of beat.notes) out.set(n.id, (out.get(n.id) ?? 0) + beat.durTicks);
      }
    }
  }
  return out;
}

describe('DURATION FIDELITY — the criterion that replaced rest density', () => {
  const irs = build('notes');

  it('no note is written longer than it was played, anywhere in the corpus', () => {
    let checked = 0;
    irs.forEach((ir, i) => {
      const played = new Map(SYNTHETIC_FIXTURES[i].notes.map((n, k) => [`n${k}`, n.endSec - n.startSec]));
      const secondsPerTick = 1 / ((ir.tempo.displayBpm / 60) * ir.divisions);
      for (const [id, ticks] of writtenTicks(ir)) {
        const playedSec = played.get(id);
        if (playedSec === undefined) continue;
        // One grid step of slack: the off-time is snapped, so it may round up by less than the
        // finest straight subdivision on offer. Anything beyond that is invented sustain.
        // One 1/16 is 6 ticks at divisions=24, which is the finest straight step `auto` offers.
        expect(ticks * secondsPerTick, `note ${id} of ${SYNTHETIC_FIXTURES[i].id}`).toBeLessThan(
          playedSec + 6 * secondsPerTick
        );
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(700);
  });

  it('a note is never written as zero — every played note reaches the page', () => {
    irs.forEach((ir, i) => {
      const written = writtenTicks(ir);
      const reached = SYNTHETIC_FIXTURES[i].notes.filter((_, k) => (written.get(`n${k}`) ?? 0) > 0).length;
      expect(reached, SYNTHETIC_FIXTURES[i].id).toBe(SYNTHETIC_FIXTURES[i].notes.length);
    });
  });

  it('the deleted flag changes nothing: fillGaps true and false are the same score', () => {
    const on = measure('notes', { fillGaps: true });
    const off = measure('notes', { fillGaps: false });
    expect(off.totals).toEqual(on.totals);
  });

  it('nothing is absorbed and no articulation is inferred', () => {
    for (const ir of irs) {
      expect(ir.stats.gapsAbsorbed).toBe(0);
      expect(ir.stats.staccatoNotes).toBe(0);
    }
  });
});

describe('REST DENSITY — reported, not targeted', () => {
  const { totals, perTrack } = measure('notes');
  const density = totals.rests / (totals.notes + totals.rests);

  it('the stress set is actually loaded (six phrases, 768 notes)', () => {
    expect(SYNTHETIC_FIXTURES).toHaveLength(6);
    expect(SYNTHETIC_FIXTURES.reduce((a, f) => a + f.notes.length, 0)).toBe(768);
    expect(totals.notes).toBeGreaterThan(700);
  });

  it('a gate-shortened corpus prints its silence: density is well above the old 5% target', () => {
    // Documenting the direction of the change on purpose. If this ever drops back under 5%,
    // something has started lengthening notes again.
    expect(density).toBeGreaterThan(0.1);
  });

  it('still fewer rests than notes — the page is material, not a rest field', () => {
    expect(totals.rests).toBeLessThan(totals.notes);
    for (const [id, d] of perTrack) expect(d, `track ${id}`).toBeLessThan(0.5);
  });

  it('the short rests are real measured silence, not fragmentation', () => {
    // They exist now — the "no rest shorter than an eighth" floor went with the lengthening pass
    // that enforced it, and on this corpus every gap is a sixteenth of gate, so every rest is a
    // short one. Each must still be a printable glyph: emit.test.ts checks that on the
    // serialized side.
    expect(totals.short).toBeGreaterThan(0);
    expect(totals.short).toBeLessThanOrEqual(totals.rests);
  });

  it('ZERO tuplet rests', () => {
    expect(totals.tupletRests).toBe(0);
  });

  it('holds on the corpus RAW offsets too, not just the synthetic gate', () => {
    const raw = measure('notesRaw');
    expect(raw.totals.rests).toBeLessThan(raw.totals.notes);
  });
});

describe('REST DENSITY — the same numbers survive serialization', () => {
  it('counting rests in the emitted MusicXML agrees with the IR stats', () => {
    let xmlNotes = 0;
    let xmlRests = 0;
    let irNotes = 0;
    let irRests = 0;
    for (const f of SYNTHETIC_FIXTURES) {
      const r = buildScore(
        { notes: f.notes, beats: f.beats, downbeats: f.downbeats, audioDurationSec: f.audioDurationSec },
        settings({ tuningMidi: SYNTHETIC_TUNING })
      );
      irNotes += r.ir.stats.noteGlyphs;
      irRests += r.ir.stats.restGlyphs;
      const read = readMusicXml(r.toMusicXML());
      for (const n of read.notes) {
        if (n.staff !== 1) continue;
        if (n.chord) continue;
        if (n.isRest) xmlRests++;
        else xmlNotes++;
      }
    }
    expect(xmlRests).toBe(irRests);
    expect(xmlNotes).toBe(irNotes);
  });
});

/** Total fret+string displacement over a corpus, for one fingering style. */
function tabPositions(style: FingeringStyle, over: Parameters<typeof settings>[0] = {}): {
  string: number;
  fret: number;
}[][] {
  return SYNTHETIC_FIXTURES.map((f) => {
    const r = buildScore(
      { notes: f.notes, beats: f.beats, downbeats: f.downbeats, audioDurationSec: f.audioDurationSec },
      settings({ tuningMidi: SYNTHETIC_TUNING, fingeringStyle: style, ...over })
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
    return f.notes
      .map((_, i) => assigned.get(`n${i}`))
      .filter((position): position is { string: number; fret: number } => position !== undefined);
  });
}

function tabMovement(style: FingeringStyle, over: Parameters<typeof settings>[0] = {}): number {
  let movement = 0;
  for (const positions of tabPositions(style, over)) {
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

  it("'openStrings' takes EVERY open string the corpus offers", () => {
    const open = (style: FingeringStyle, over?: Parameters<typeof settings>[0]): number =>
      tabPositions(style, over).flat().filter((p) => p.fret === 0).length;
    // The ceiling: one open string per note whose pitch IS an open string on this tuning.
    const available = SYNTHETIC_FIXTURES.reduce(
      (a, f) => a + f.notes.filter((note) => SYNTHETIC_TUNING.includes(note.midi)).length,
      0
    );
    expect(available).toBeGreaterThan(0);
    expect(open('openStrings')).toBe(available);
    // 'low' reaches the same ceiling here, because on a bass an open string is also the lowest
    // fret for its pitch. The styles that do NOT are the ones that weigh something else.
    expect(open('minMovement')).toBeLessThan(available);
    expect(open('aroundFret', { anchorFret: 9 })).toBeLessThan(available);
  });

  it("'aroundFret' keeps the fretted hand near its anchor, and follows the anchor when it moves", () => {
    const mean = (anchor: number): number => {
      const fretted = tabPositions('aroundFret', { anchorFret: anchor }).flat().filter((p) => p.fret > 0);
      return fretted.reduce((a, p) => a + p.fret, 0) / fretted.length;
    };
    const low = mean(3);
    const high = mean(9);
    expect(high).toBeGreaterThan(low);
    expect(Math.abs(low - 3)).toBeLessThan(Math.abs(low - 9));
    expect(Math.abs(high - 9)).toBeLessThan(Math.abs(high - 3));
  });

  it('every assigned position actually produces the sounding pitch, in every style', () => {
    let checked = 0;
    for (const style of ['low', 'minMovement', 'openStrings', 'aroundFret'] as const) {
      for (const f of SYNTHETIC_FIXTURES) {
        const r = buildScore(
          { notes: f.notes, beats: f.beats, downbeats: f.downbeats, audioDurationSec: f.audioDurationSec },
          settings({ tuningMidi: SYNTHETIC_TUNING, fingeringStyle: style })
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
    }
    expect(checked).toBeGreaterThan(2800);
  });
});
