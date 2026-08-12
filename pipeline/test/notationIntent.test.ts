/**
 * PER-NOTE WRITTEN-DURATION INTENT — a written value the caller DECLARES instead of the pipeline
 * measuring one (Codex point 3).
 *
 * The claim under test is narrow and load-bearing: choosing "1/32" in an editor's duration menu
 * must produce a written 1/32 on the page, at every grid setting, in both emitters — because the
 * off-time the editor would otherwise have to fake in seconds gets rounded straight back onto the
 * admitted lattice (quantize.ts, spec rule R4) and the instruction is silently undone.
 *
 * The three laws that still outrank the declaration are tested here too, since "honoured" without
 * them would mean an unengravable score: the bar (split and tied), the next attack (trimmed), and
 * the exact/symbolic path (a written source already decided every tick).
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { buildMultiPartScore } from '../src/multipart.js';
import { notationIntentTicks, DIVISIONS, type NotationIntent, type RiffsheetIR } from '../src/ir.js';
import type { GridSetting, InputNote } from '../src/types.js';
import { grid, input, settings } from './helpers.js';
import { readMusicXml } from './xmlReader.js';

const STAFF = { instrument: 'staff' as const, tuningMidi: [] };

/** A note played far too SHORT for what it declares, so a measured reading cannot pass by luck. */
function declared(intent: NotationIntent | undefined, over: Partial<InputNote> = {}): InputNote {
  return {
    id: 'd0',
    startSec: 0,
    endSec: 0.05,
    midi: 40,
    ...(intent ? { notationIntent: intent } : {}),
    ...over
  };
}

function build(notes: InputNote[], over: Partial<Parameters<typeof settings>[0]> = {}, bars = 4) {
  return buildScore(input(notes, grid(bars)), settings({ ...STAFF, ...over }));
}

interface Glyph {
  type: string;
  dots: number;
  ticks: number;
  tieStart: boolean;
  tieStop: boolean;
}

/** Every glyph this note id was written as, in printed order. A tie split is several. */
function glyphRun(ir: RiffsheetIR, id: string): Glyph[] {
  const out: Glyph[] = [];
  for (const bar of ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        const note = beat.notes.find((n) => n.id === id);
        if (!note) continue;
        out.push({
          type: beat.durationType,
          dots: beat.dots,
          ticks: beat.durTicks,
          tieStart: note.tieStart,
          tieStop: note.tieStop
        });
      }
    }
  }
  return out;
}

function totalTicks(run: Glyph[]): number {
  return run.reduce((sum, g) => sum + g.ticks, 0);
}

/** The alphaTab hand-off's own view of the same run — the screen path, read independently. */
function alphaTabRun(data: ReturnType<ReturnType<typeof buildScore>['toAlphaTabModelData']>, id: string): Glyph[] {
  const out: Glyph[] = [];
  for (const bar of data.tracks[0].staves[0].bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        const note = beat.notes.find((n) => n.id === id);
        if (!note) continue;
        out.push({
          type: beat.duration,
          dots: beat.dots,
          ticks: beat.durTicks,
          tieStart: note.isTieOrigin,
          tieStop: note.isTieDestination
        });
      }
    }
  }
  return out;
}

const ALL_GRIDS: GridSetting[] = ['auto', '1/4', '1/8', '1/16', '1/8T', 'thirtysecond', 'free'];

describe('NOTATION INTENT — the tick arithmetic', () => {
  it('every plain denominator is a whole number of ticks', () => {
    expect(notationIntentTicks({ denominator: 1, dots: 0 })).toBe(DIVISIONS * 4);
    expect(notationIntentTicks({ denominator: 2, dots: 0 })).toBe(48);
    expect(notationIntentTicks({ denominator: 4, dots: 0 })).toBe(24);
    expect(notationIntentTicks({ denominator: 8, dots: 0 })).toBe(12);
    expect(notationIntentTicks({ denominator: 16, dots: 0 })).toBe(6);
    expect(notationIntentTicks({ denominator: 32, dots: 0 })).toBe(3);
  });

  it('a dot is one and a half of the plain value, down to the dotted 16th', () => {
    expect(notationIntentTicks({ denominator: 1, dots: 1 })).toBe(144);
    expect(notationIntentTicks({ denominator: 2, dots: 1 })).toBe(72);
    expect(notationIntentTicks({ denominator: 4, dots: 1 })).toBe(36);
    expect(notationIntentTicks({ denominator: 8, dots: 1 })).toBe(18);
    expect(notationIntentTicks({ denominator: 16, dots: 1 })).toBe(9);
  });

  it('a dotted 1/32 names no printable value and is refused rather than rounded', () => {
    expect(notationIntentTicks({ denominator: 32, dots: 1 })).toBeNull();
    expect(notationIntentTicks(undefined)).toBeNull();
    // Not a member of the union, but JS callers exist and a bridge is not a type system.
    expect(notationIntentTicks({ denominator: 64 as 32, dots: 0 })).toBeNull();
  });

  it('a refused intent leaves the measured length exactly as it was', () => {
    const withIntent = build([declared({ denominator: 32, dots: 1 })]);
    const without = build([declared(undefined)]);
    expect(glyphRun(withIntent.ir, 'd0')).toEqual(glyphRun(without.ir, 'd0'));
  });
});

describe('NOTATION INTENT — each denominator and dot survives to BOTH emitters', () => {
  const CASES: { intent: NotationIntent; type: string; alphaTab: string; ticks: number }[] = [
    { intent: { denominator: 1, dots: 0 }, type: 'whole', alphaTab: 'Whole', ticks: 96 },
    { intent: { denominator: 2, dots: 0 }, type: 'half', alphaTab: 'Half', ticks: 48 },
    { intent: { denominator: 4, dots: 0 }, type: 'quarter', alphaTab: 'Quarter', ticks: 24 },
    { intent: { denominator: 8, dots: 0 }, type: 'eighth', alphaTab: 'Eighth', ticks: 12 },
    { intent: { denominator: 16, dots: 0 }, type: '16th', alphaTab: 'Sixteenth', ticks: 6 },
    { intent: { denominator: 32, dots: 0 }, type: '32nd', alphaTab: 'ThirtySecond', ticks: 3 },
    { intent: { denominator: 2, dots: 1 }, type: 'half', alphaTab: 'Half', ticks: 72 },
    { intent: { denominator: 4, dots: 1 }, type: 'quarter', alphaTab: 'Quarter', ticks: 36 },
    { intent: { denominator: 8, dots: 1 }, type: 'eighth', alphaTab: 'Eighth', ticks: 18 },
    { intent: { denominator: 16, dots: 1 }, type: '16th', alphaTab: 'Sixteenth', ticks: 9 }
  ];

  for (const testCase of CASES) {
    const label = `${testCase.intent.denominator}${testCase.intent.dots ? ' dotted' : ''}`;
    it(`a declared ${label} is written as one ${testCase.type}${testCase.intent.dots ? ' with a dot' : ''}`, () => {
      const built = build([declared(testCase.intent)]);

      // ---- the IR ----------------------------------------------------------------------------
      expect(glyphRun(built.ir, 'd0')).toEqual([
        { type: testCase.type, dots: testCase.intent.dots, ticks: testCase.ticks, tieStart: false, tieStop: false }
      ]);

      // ---- MusicXML --------------------------------------------------------------------------
      const read = readMusicXml(built.toMusicXML());
      const sounded = read.notes.filter((n) => !n.isRest);
      expect(sounded).toHaveLength(1);
      expect(sounded[0].type).toBe(testCase.type);
      expect(sounded[0].dots).toBe(testCase.intent.dots);
      expect(sounded[0].duration).toBe(testCase.ticks);

      // ---- alphaTab --------------------------------------------------------------------------
      expect(alphaTabRun(built.toAlphaTabModelData(), 'd0')).toEqual([
        { type: testCase.alphaTab, dots: testCase.intent.dots, ticks: testCase.ticks, tieStart: false, tieStop: false }
      ]);
    });
  }

  it('a declared dotted whole is longer than a 4/4 bar, so the bar law ties it across', () => {
    const built = build([declared({ denominator: 1, dots: 1 })]);
    const run = glyphRun(built.ir, 'd0');
    expect(totalTicks(run)).toBe(144);
    expect(run.map((g) => `${g.type}${g.dots ? '.' : ''}`)).toEqual(['whole', 'half']);
    expect(run[0].tieStart).toBe(true);
    expect(run[1].tieStop).toBe(true);
    // Both emitters agree about the split, which is what "survives to both emitters" means for a
    // value the bar reshaped.
    expect(alphaTabRun(built.toAlphaTabModelData(), 'd0').map((g) => g.ticks)).toEqual([96, 48]);
    const read = readMusicXml(built.toMusicXML());
    const sounded = read.notes.filter((n) => !n.isRest);
    expect(sounded.map((n) => n.type)).toEqual(['whole', 'half']);
    expect(sounded[0].tieStart).toBe(true);
    expect(sounded[1].tieStop).toBe(true);
  });
});

describe('NOTATION INTENT — the quantizer stops fighting it', () => {
  it('a declared 1/32 under a 1/4 grid is a 1/32, where a measured one is a quarter', () => {
    const measured = build([declared(undefined)], { grid: '1/4' });
    expect(glyphRun(measured.ir, 'd0')).toEqual([
      { type: 'quarter', dots: 0, ticks: 24, tieStart: false, tieStop: false }
    ]);

    const intended = build([declared({ denominator: 32, dots: 0 })], { grid: '1/4' });
    expect(glyphRun(intended.ir, 'd0')).toEqual([
      { type: '32nd', dots: 0, ticks: 3, tieStart: false, tieStop: false }
    ]);
  });

  it('a declared value survives every grid setting, including free', () => {
    for (const gridSetting of ALL_GRIDS) {
      const built = build([declared({ denominator: 4, dots: 1 })], { grid: gridSetting });
      const run = glyphRun(built.ir, 'd0');
      expect(totalTicks(run), `grid ${gridSetting}`).toBe(36);
      expect(run.map((g) => `${g.type}${g.dots}`), `grid ${gridSetting}`).toEqual(['quarter1']);
    }
  });

  it('every denominator survives every grid setting', () => {
    for (const gridSetting of ALL_GRIDS) {
      for (const denominator of [1, 2, 4, 8, 16, 32] as const) {
        for (const dots of [0, 1] as const) {
          const ticks = notationIntentTicks({ denominator, dots });
          if (ticks === null) continue;
          const built = build([declared({ denominator, dots })], { grid: gridSetting });
          expect(totalTicks(glyphRun(built.ir, 'd0')), `${denominator}/${dots} at grid ${gridSetting}`).toBe(ticks);
        }
      }
    }
  });

  it('a declared value in a triplet beat lands on the tuplet lattice rather than corrupting it', () => {
    // Three eighth-triplets in beat 1 admit a real tuplet group; the FIRST of them then declares a
    // quarter, which is not a whole number of triplet units. The group's lattice wins (it is the
    // only thing printable there), the next attack trims it, and the score still engraves — the
    // point being that buildScore does not throw an unengravable-score error.
    const third = 0.5 / 3;
    const notes: InputNote[] = [
      { id: 't0', startSec: 0, endSec: third * 0.8, midi: 40, notationIntent: { denominator: 4, dots: 0 } },
      { id: 't1', startSec: third, endSec: third * 1.8, midi: 43 },
      { id: 't2', startSec: third * 2, endSec: third * 2.8, midi: 45 },
      { id: 't3', startSec: 0.5, endSec: 0.9, midi: 40 }
    ];
    const built = buildScore(input(notes, grid(2)), settings({ ...STAFF, grid: '1/8T' }));
    const run = glyphRun(built.ir, 't0');
    expect(run.length).toBeGreaterThan(0);
    // Every piece is a whole number of the group's 8-tick units, which is what keeps it printable.
    for (const glyph of run) expect(glyph.ticks % 8).toBe(0);
    expect(built.ir.bars[0].voices[0].beats.some((beat) => beat.tuplet)).toBe(true);
  });
});

describe('NOTATION INTENT — the laws that outrank it', () => {
  it('the next attack trims a declared span that would swallow it', () => {
    const notes: InputNote[] = [
      declared({ denominator: 1, dots: 0 }),
      { id: 'next', startSec: 1.0, endSec: 1.4, midi: 43 }
    ];
    const built = build(notes);
    // A whole note was declared at tick 0; the next attack is on tick 48, so 48 ticks is what the
    // page can honestly give it — the same trim a rounded off-time gets (simplify.ts).
    expect(totalTicks(glyphRun(built.ir, 'd0'))).toBe(48);
    expect(glyphRun(built.ir, 'next').length).toBeGreaterThan(0);
    // and no chain reaction: the trim did not disturb the note that caused it, which is still the
    // dotted eighth its own 0.4 s measures to.
    expect(glyphRun(built.ir, 'next')[0].ticks).toBe(18);
  });

  it('a declared half at bar end ties across the barline', () => {
    // Beat 4 of bar 1 (tick 72) + a declared half (48) reaches 24 ticks into bar 2.
    const built = build([declared({ denominator: 2, dots: 0 }, { id: 'end', startSec: 1.5, endSec: 1.55 })]);
    const run = glyphRun(built.ir, 'end');
    expect(totalTicks(run)).toBe(48);
    expect(run.map((g) => g.ticks)).toEqual([24, 24]);
    expect(run[0].tieStart).toBe(true);
    expect(run[1].tieStop).toBe(true);
    // The bar the tie lands in exists because the DECLARATION earned it.
    expect(built.ir.bars).toHaveLength(2);
  });

  it('the sub-30ms guard does not delete a declared note that is legitimately that short', () => {
    // A 1/32 at 300 BPM lasts 25 ms. Measured, that is a decoder artefact; declared, it is what
    // the user asked for, and dropping it would answer the request by removing the note.
    const fast = grid(2, 4, 300);
    const notes: InputNote[] = [
      { id: 'tiny', startSec: 0, endSec: 0.025, midi: 40, notationIntent: { denominator: 32, dots: 0 } }
    ];
    const built = buildScore(input(notes, fast), settings(STAFF));
    expect(built.ir.suspects.tooShortDropped).toBe(0);
    expect(glyphRun(built.ir, 'tiny')).toEqual([
      { type: '32nd', dots: 0, ticks: 3, tieStart: false, tieStop: false }
    ]);
    // Without a declaration the same fragment is still dropped, exactly as before.
    const measured = buildScore(input([{ ...notes[0], notationIntent: undefined }], fast), settings(STAFF));
    expect(measured.ir.suspects.tooShortDropped).toBe(1);
  });

  it('the exact symbolic path ignores a declaration — the source already decided', () => {
    const sourceBars: NonNullable<InputNote['sourceBars']> = [
      { startTick: 0, durationTicks: 1920, ppq: 480, timeSig: [4, 4], number: 1, implicit: false }
    ];
    const notes: InputNote[] = [
      {
        id: 's0',
        startSec: 0,
        endSec: 0.5,
        midi: 40,
        sourceTiming: { startTick: 0, endTick: 480, ppq: 480 },
        sourceBars,
        // A declared whole note, on a source that says quarter. The source wins.
        notationIntent: { denominator: 1, dots: 0 }
      },
      {
        id: 's1',
        startSec: 1.0,
        endSec: 1.5,
        midi: 43,
        sourceTiming: { startTick: 960, endTick: 1440, ppq: 480 }
      }
    ];
    const built = buildScore({ notes }, settings(STAFF));
    expect(glyphRun(built.ir, 's0')).toEqual([
      { type: 'quarter', dots: 0, ticks: 24, tieStart: false, tieStop: false }
    ]);
  });
});

describe('NOTATION INTENT — a declaration can never produce an unengravable score', () => {
  /**
   * The sweep that matters most: a declared value deliberately steps OUTSIDE the grid's lattice,
   * which is the one thing `validateIR` exists to catch (a `<type>` that contradicts its own
   * `<duration>`, a bar that does not add up, a tie with nowhere to land). `buildScore` throws on
   * any of them, so "does not throw" is the whole assertion — and both emitters are run, because
   * MusicXML asserts its own measure cursor and tuplet balance on the way out.
   */
  it('every grid, every meter, every declared value, at every sub-beat offset', () => {
    let seed = 20260812;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const meters: ([number, number] | undefined)[] = [undefined, [3, 4], [6, 8], [5, 4]];
    let built = 0;
    for (const gridSetting of ALL_GRIDS) {
      for (const timeSigOverride of meters) {
        const notes: InputNote[] = [];
        for (let i = 0; i < 12; i++) {
          const denominator = ([1, 2, 4, 8, 16, 32] as const)[Math.floor(next() * 6)];
          const dots = next() < 0.4 ? 1 : 0;
          const startSec = Math.round((i * 0.37 + next() * 0.19) * 1000) / 1000;
          notes.push({
            id: `s${i}`,
            startSec,
            endSec: startSec + 0.04 + next() * 0.5,
            midi: 36 + Math.floor(next() * 24),
            ...(next() < 0.75 ? { notationIntent: { denominator, dots } } : {})
          });
        }
        const score = buildScore(
          input(notes, grid(6)),
          settings({ ...STAFF, grid: gridSetting, ...(timeSigOverride ? { timeSigOverride } : {}) })
        );
        score.toMusicXML();
        score.toAlphaTabModelData();
        score.toMidi(true);
        built++;
      }
    }
    expect(built).toBe(ALL_GRIDS.length * meters.length);
  });

  it('declared chords, unisons and back-to-back declarations still engrave', () => {
    const notes: InputNote[] = [
      // a declared chord: three notes, one slot, one written value
      { id: 'c0', startSec: 0, endSec: 0.05, midi: 40, notationIntent: { denominator: 2, dots: 1 } },
      { id: 'c1', startSec: 0.002, endSec: 0.05, midi: 44, notationIntent: { denominator: 2, dots: 1 } },
      // a member that disagrees: the LONGEST declaration wins rather than splitting the chord
      { id: 'c2', startSec: 0.004, endSec: 0.05, midi: 47, notationIntent: { denominator: 16, dots: 0 } },
      { id: 'c3', startSec: 1.0, endSec: 1.05, midi: 40, notationIntent: { denominator: 32, dots: 0 } },
      { id: 'c4', startSec: 1.0625, endSec: 1.1, midi: 40, notationIntent: { denominator: 32, dots: 0 } }
    ];
    const built = build(notes);
    const chord = built.ir.bars[0].voices[0].beats.find((beat) => beat.notes.length === 3);
    expect(chord).toBeDefined();
    // The longest declaration (a dotted half, 72) governs the whole slot, so the chord is ONE beat
    // rather than being split by its disagreeing member — and the next attack at tick 48 then trims
    // it there, exactly as it trims a single declared note.
    expect(chord!.durTicks).toBe(48);
    expect(chord!.notes.map((n) => n.id)).toEqual(['c0', 'c1', 'c2']);
    built.toMusicXML();
    built.toAlphaTabModelData();
  });
});

describe('NOTATION INTENT — what the IR and the multi-part surface carry', () => {
  it('the declaration rides on every piece of a split span, for the editor to read back', () => {
    const built = build([declared({ denominator: 1, dots: 1 })]);
    const carried = built.ir.bars.flatMap((bar) =>
      bar.voices.flatMap((v) => v.beats.flatMap((beat) => beat.notes.filter((n) => n.id === 'd0')))
    );
    expect(carried).toHaveLength(2);
    for (const note of carried) expect(note.notationIntent).toEqual({ denominator: 1, dots: 1 });
  });

  it('a note without a declaration carries no field at all', () => {
    const built = build([declared(undefined)]);
    const note = built.ir.bars[0].voices[0].beats.flatMap((beat) => beat.notes)[0];
    expect(note.notationIntent).toBeUndefined();
    expect('notationIntent' in note).toBe(false);
  });

  it('ScorePart notes reach both emitters with the declaration honoured, and are not mutated', () => {
    const liveNotes: InputNote[] = [
      { id: 'L0', startSec: 0, endSec: 0.05, midi: 40, notationIntent: { denominator: 2, dots: 0 } }
    ];
    const importedNotes: InputNote[] = [
      {
        id: 'I0',
        startSec: 0,
        endSec: 0.5,
        midi: 64,
        sourceTiming: { startTick: 0, endTick: 480, ppq: 480 },
        sourceBars: [{ startTick: 0, durationTicks: 1920, ppq: 480, timeSig: [4, 4], number: 1, implicit: false }]
      }
    ];
    const before = JSON.stringify([liveNotes, importedNotes]);

    const built = buildMultiPartScore(
      [
        { notes: liveNotes, name: 'Bass', instrument: 'staff', tuningMidi: [] },
        { notes: importedNotes, name: 'Guitar', role: 'imported' }
      ],
      {},
      settings(STAFF)
    );

    // The caller's arrays are inputs, not scratch space.
    expect(JSON.stringify([liveNotes, importedNotes])).toBe(before);

    const live = built.parts[0].ir;
    expect(glyphRun(live, 'L0')).toEqual([
      { type: 'half', dots: 0, ticks: 48, tieStart: false, tieStop: false }
    ]);
    const data = built.toAlphaTabModelData();
    const beats = data.tracks[0].staves[0].bars.flatMap((bar) => bar.voices.flatMap((v) => v.beats));
    const declaredBeat = beats.find((beat) => beat.notes.some((n) => n.id === 'L0'))!;
    expect([declaredBeat.duration, declaredBeat.durTicks]).toEqual(['Half', 48]);
    const read = readMusicXml(built.toMusicXML(), 0);
    expect(read.notes.filter((n) => !n.isRest)[0].type).toBe('half');
  });
});
