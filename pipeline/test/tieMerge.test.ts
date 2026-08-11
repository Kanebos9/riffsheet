/**
 * ISSUE #31 — TIE AND MERGE CORRECTNESS.
 *
 * THE BUG, as the user proved it: a take of repeated A1 strikes, read at Notation 1/4, came back
 * as a row of separate restruck notes wearing EIGHTH-NOTE FLAGS. No half notes. No ties. Under a
 * quarter-note grid.
 *
 * THE CAUSE was a split lattice. `quantizeOnsets` snapped each onset to the grid the caller asked
 * for, and then snapped the off-time on a private halving ladder that ran all the way down to one
 * tick — so at `grid: '1/4'` the attack landed on the beat while the release landed on a 1/8 or
 * finer step, and every strike printed as a short flagged note followed by a rest it never
 * earned. The engraver was never given a quarter to draw.
 *
 * The rule that replaces it: A GRID IS A CONTRACT ABOUT THE FINEST VALUE THE PAGE MAY PRINT, and
 * it binds durations exactly as tightly as it binds onsets. This file pins the five invariants
 * that follow from it, as properties over every grid setting and several fixtures, because the
 * bug was only visible on one combination and a single example would not have caught it.
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { readMusicXml } from './xmlReader.js';
import { grid, playedNotes, settings } from './helpers.js';
import type { GridSetting, InputNote } from '../src/types.js';
import type { RiffsheetIR } from '../src/ir.js';

const GRIDS: GridSetting[] = ['auto', '1/4', '1/8', '1/16', '1/8T', 'thirtysecond', 'free'];

/** The finest straight step each grid may print, in ticks at divisions=24. */
const STEP: Record<string, number> = {
  auto: 6,
  '1/4': 24,
  '1/8': 12,
  '1/16': 6,
  '1/8T': 12,
  thirtysecond: 3,
  free: 3
};

/** Grids that never admit a tuplet, so every glyph must sit on the straight lattice. */
const STRAIGHT_ONLY: GridSetting[] = ['1/4', '1/8', '1/16', 'thirtysecond', 'free'];

/** Note values strictly finer than each grid's step — a page under that grid may never say them. */
const FORBIDDEN: Record<string, string[]> = {
  '1/4': ['eighth', '16th', '32nd'],
  '1/8': ['16th', '32nd'],
  '1/16': ['32nd'],
  thirtysecond: [],
  free: []
};

const period = 0.5; // 120 BPM

interface Fixture {
  id: string;
  notes: InputNote[];
  bars: number;
}

const FIXTURES: Fixture[] = [
  {
    // THE REPRO. A detector splits two real sustained strikes into five same-pitch fragments.
    // Read at 1/4 this used to print five flagged eighths; it must never print more attacks
    // than it was given, and never a value finer than the grid.
    id: 'repeated-strikes',
    notes: [0, 0.42, 0.87, 1.31, 1.72].map((t, i) => ({ id: `s${i}`, startSec: t, endSec: t + 0.19, midi: 33 })),
    bars: 2
  },
  {
    // Two real strikes, each held for two beats. The honest reading is two half notes.
    id: 'two-held-strikes',
    notes: [
      { id: 'h0', startSec: 0, endSec: 2 * period * 0.98, midi: 33 },
      { id: 'h1', startSec: 2 * period, endSec: 2 * period + 2 * period * 0.98, midi: 33 }
    ],
    bars: 2
  },
  {
    id: 'funk-eighths',
    notes: playedNotes(
      Array.from({ length: 16 }, (_, i) => ({ beat: i / 2, midi: [40, 43, 45, 47, 45, 43, 40, 38][i % 8] })),
      0.6
    ),
    bars: 3
  },
  {
    id: 'sixteenth-run',
    notes: playedNotes(
      Array.from({ length: 16 }, (_, i) => ({ beat: i / 4, midi: 40 + (i % 5), lengthBeats: 1 / 4 })),
      0.85
    ),
    bars: 2
  },
  {
    // Long values mixed with short ones and pitch changes: the case where a merge has to pick.
    id: 'mixed-lengths',
    notes: [
      { id: 'm0', startSec: 0.0, endSec: 0.95, midi: 40 },
      { id: 'm1', startSec: 1.0, endSec: 1.2, midi: 43 },
      { id: 'm2', startSec: 1.25, endSec: 1.45, midi: 45 },
      { id: 'm3', startSec: 1.5, endSec: 2.45, midi: 47 },
      { id: 'm4', startSec: 2.5, endSec: 2.7, midi: 45 },
      { id: 'm5', startSec: 3.0, endSec: 3.95, midi: 40 }
    ],
    bars: 3
  }
];

function build(f: Fixture, g: GridSetting): RiffsheetIR {
  return buildScore({ notes: f.notes, ...grid(f.bars) }, settings({ grid: g })).ir;
}

/**
 * Attack groups per pitch. A TIED CHAIN IS ONE ATTACK: only the head of a chain (`tieStop`
 * false) is a struck note; every continuation is the same note still ringing.
 */
function attacksByPitch(ir: RiffsheetIR): Map<number, number> {
  const out = new Map<number, number>();
  for (const bar of ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        for (const n of beat.notes) {
          if (!n.tieStop) out.set(n.midi, (out.get(n.midi) ?? 0) + 1);
        }
      }
    }
  }
  return out;
}

function inputByPitch(notes: InputNote[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const n of notes) out.set(n.midi, (out.get(n.midi) ?? 0) + 1);
  return out;
}

/** Every tie must open before it closes and close before the score ends. */
function tieErrors(ir: RiffsheetIR): string[] {
  const open = new Map<number, boolean>();
  const errors: string[] = [];
  for (const bar of ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        for (const n of beat.notes) {
          if (n.tieStop && !open.get(n.midi)) errors.push(`bar ${bar.number}: tie stop on midi ${n.midi} with nothing open`);
          if (n.tieStop) open.set(n.midi, false);
          if (n.tieStart) open.set(n.midi, true);
        }
      }
    }
  }
  for (const [midi, isOpen] of open) if (isOpen) errors.push(`dangling tie start on midi ${midi}`);
  return errors;
}

function noteGlyphs(ir: RiffsheetIR): { bar: number; startTick: number; durTicks: number; type: string; dots: number }[] {
  const out: { bar: number; startTick: number; durTicks: number; type: string; dots: number }[] = [];
  for (const bar of ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest || beat.tuplet) continue;
        out.push({ bar: bar.number, startTick: beat.startTick, durTicks: beat.durTicks, type: beat.durationType, dots: beat.dots });
      }
    }
  }
  return out;
}

// ---- (a) ATTACK COUNT ---------------------------------------------------------------------

describe('#31 (a) — a coarse grid may merge, but it may never fabricate a restrike', () => {
  for (const f of FIXTURES) {
    for (const g of GRIDS) {
      it(`${f.id} @ ${g}: attacks per pitch never exceed the notes played`, () => {
        const attacks = attacksByPitch(build(f, g));
        const played = inputByPitch(f.notes);
        for (const [midi, count] of attacks) {
          expect(count, `${f.id} @ ${g}: midi ${midi} was struck ${count}x on the page`).toBeLessThanOrEqual(
            played.get(midi) ?? 0
          );
        }
      });
    }
  }
});

// ---- (b) DURATIONS QUANTIZE WITH STARTS ----------------------------------------------------

describe('#31 (b) — a duration is bound by the grid exactly as tightly as an onset', () => {
  for (const f of FIXTURES) {
    for (const g of STRAIGHT_ONLY) {
      it(`${f.id} @ ${g}: every note glyph sits on the ${STEP[g]}-tick lattice`, () => {
        for (const glyph of noteGlyphs(build(f, g))) {
          expect(glyph.durTicks % STEP[g], `${f.id} @ ${g}: ${glyph.durTicks}-tick glyph`).toBe(0);
          expect(glyph.startTick % STEP[g], `${f.id} @ ${g}: onset at ${glyph.startTick}`).toBe(0);
        }
      });

      it(`${f.id} @ ${g}: prints no value finer than the grid`, () => {
        for (const glyph of noteGlyphs(build(f, g))) {
          expect(FORBIDDEN[g], `${f.id} @ ${g}: a ${glyph.type} under a ${g} grid`).not.toContain(glyph.type);
        }
      });
    }
  }

  it('THE REGRESSION: repeated strikes at 1/4 are quarters, not flagged eighths', () => {
    const ir = build(FIXTURES[0], '1/4');
    const glyphs = noteGlyphs(ir);
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) {
      expect(glyph.type, 'the exact symptom of #31').not.toBe('eighth');
      expect(glyph.durTicks % 24).toBe(0);
    }
    // Five detected fragments, and never more attacks on the page than that.
    expect([...attacksByPitch(ir).values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5);
  });
});

// ---- (c) LONG SPANS -----------------------------------------------------------------------

describe('#31 (c) — a long span takes the largest legal symbol', () => {
  it('two beats starting ON a beat is ONE half note, not two tied quarters', () => {
    const notes: InputNote[] = [{ id: 'x', startSec: 0, endSec: 2 * period, midi: 40 }];
    for (const g of ['1/4', '1/8', '1/16'] as GridSetting[]) {
      const ir = buildScore({ notes, ...grid(2) }, settings({ grid: g })).ir;
      const glyphs = noteGlyphs(ir);
      expect(glyphs, `grid ${g}`).toHaveLength(1);
      expect(glyphs[0].type, `grid ${g}`).toBe('half');
      expect(glyphs[0].durTicks, `grid ${g}`).toBe(48);
      expect(glyphs[0].dots, `grid ${g}`).toBe(0);
    }
  });

  it('four beats on the barline is ONE whole note', () => {
    const notes: InputNote[] = [{ id: 'x', startSec: 0, endSec: 4 * period, midi: 40 }];
    const glyphs = noteGlyphs(buildScore({ notes, ...grid(2) }, settings({ grid: '1/4' })).ir);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0].durTicks).toBe(96);
    expect(glyphs[0].type).toBe('whole');
  });

  it('the SAME two beats starting OFF the beat is a tied pair — beat visibility wins there', () => {
    // Half a beat late: the span now hides beat 3, so the rulebook splits it and ties it.
    const notes: InputNote[] = [{ id: 'x', startSec: period / 2, endSec: period / 2 + 2 * period, midi: 40 }];
    const ir = buildScore({ notes, ...grid(2) }, settings({ grid: '1/8' })).ir;
    const glyphs = noteGlyphs(ir);
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0].durTicks + glyphs[1].durTicks).toBe(48);
    // ...and it is a TIE, not two restrikes.
    const all = ir.bars.flatMap((b) => b.voices.flatMap((v) => v.beats.filter((x) => !x.isRest)));
    expect(all[0].notes[0].tieStart).toBe(true);
    expect(all[1].notes[0].tieStop).toBe(true);
    expect(attacksByPitch(ir).get(40)).toBe(1);
  });
});

// ---- (d) TIE PRESERVATION ------------------------------------------------------------------

describe('#31 (d) — ties survive into the IR and out through both emitters', () => {
  for (const f of FIXTURES) {
    for (const g of GRIDS) {
      it(`${f.id} @ ${g}: no dangling or unopened tie`, () => {
        expect(tieErrors(build(f, g))).toEqual([]);
      });
    }
  }

  // A note held across the barline has to be split, and a split must always tie.
  const acrossBar: InputNote[] = [{ id: 'long', startSec: 3 * period, endSec: 7 * period, midi: 40 }];
  const built = buildScore({ notes: acrossBar, ...grid(3) }, settings({ grid: '1/4' }));

  it('a bar-crossing note is one attack split by a tie, in the IR', () => {
    expect(attacksByPitch(built.ir).get(40)).toBe(1);
    const sounding = built.ir.bars.flatMap((b) => b.voices.flatMap((v) => v.beats.filter((x) => !x.isRest)));
    expect(sounding.length).toBeGreaterThanOrEqual(2);
    expect(sounding[0].notes[0].tieStart).toBe(true);
    expect(sounding[1].notes[0].tieStop).toBe(true);
    expect(tieErrors(built.ir)).toEqual([]);
  });

  it('MusicXML carries both <tie> (sound) and <tied> (notation)', () => {
    const xml = built.toMusicXML();
    expect(xml).toContain('<tie type="start"/>');
    expect(xml).toContain('<tie type="stop"/>');
    expect(xml).toContain('<tied type="start"/>');
    expect(xml).toContain('<tied type="stop"/>');
    const read = readMusicXml(xml);
    const staff1 = read.notes.filter((n) => n.staff === 1 && !n.isRest);
    expect(staff1.some((n) => n.tieStart)).toBe(true);
    expect(staff1.some((n) => n.tieStop)).toBe(true);
  });

  it('alphaTab carries isTieOrigin / isTieDestination', () => {
    const data = built.toAlphaTabModelData();
    const notes = data.tracks[0].staves[0].bars.flatMap((b) => b.voices.flatMap((v) => v.beats.flatMap((x) => x.notes)));
    expect(notes.some((n) => n.isTieOrigin)).toBe(true);
    expect(notes.some((n) => n.isTieDestination)).toBe(true);
    // Exactly one struck note: the rest is the same string still ringing.
    expect(notes.filter((n) => !n.isTieDestination)).toHaveLength(1);
  });
});

// ---- (e) MERGE PITCH PICK -------------------------------------------------------------------

describe('#31 (e) — a merged slot keeps the pitch with the most duration-weighted evidence', () => {
  // Two DIFFERENT pitches, 60 ms apart: past the chord window, so they stay two events, and
  // close enough that a quarter-note grid collapses them onto the same beat.
  const shortThenLong: InputNote[] = [
    { id: 'blip', startSec: 0.0, endSec: 0.05, midi: 33 },
    { id: 'held', startSec: 0.06, endSec: 0.51, midi: 45 }
  ];

  it('the long note wins even though the short one arrived first', () => {
    const ir = buildScore({ notes: shortThenLong, ...grid(2) }, settings({ grid: '1/4' })).ir;
    const sounding = ir.bars.flatMap((b) => b.voices.flatMap((v) => v.beats.filter((x) => !x.isRest)));
    expect(sounding.length).toBeGreaterThan(0);
    const pitches = new Set(sounding.flatMap((b) => b.notes.map((n) => n.midi)));
    // The 20 ms blip must not silence the note that actually sounded for most of the beat.
    expect(pitches.has(45)).toBe(true);
    expect(pitches.has(33)).toBe(false);
  });

  it('a finer grid keeps both, because nothing had to be merged', () => {
    const ir = buildScore({ notes: shortThenLong, ...grid(2) }, settings({ grid: 'thirtysecond' })).ir;
    const pitches = new Set(
      ir.bars.flatMap((b) => b.voices.flatMap((v) => v.beats.flatMap((x) => x.notes.map((n) => n.midi))))
    );
    expect(pitches.has(33)).toBe(true);
    expect(pitches.has(45)).toBe(true);
  });
});

// ---- the standing guard: a glyph may never lie about its own length ------------------------

const NOMINAL: Record<string, number> = { whole: 96, half: 48, quarter: 24, eighth: 12, '16th': 6, '32nd': 3 };

describe('#31 — every printed value equals the duration it is printed against', () => {
  for (const f of FIXTURES) {
    for (const g of GRIDS) {
      it(`${f.id} @ ${g}: <type> and <duration> agree on every glyph`, () => {
        const ir = build(f, g);
        for (const bar of ir.bars) {
          for (const voice of bar.voices) {
            for (const beat of voice.beats) {
              // A measure rest is a whole-bar symbol, not a whole note; a tuplet's written value
              // is deliberately not its sounding value.
              if (beat.measureRest || beat.tuplet) continue;
              const nominal = NOMINAL[beat.durationType] * (beat.dots ? 1.5 : 1);
              expect(beat.durTicks, `${f.id} @ ${g}: ${beat.durationType}+${beat.dots} vs ${beat.durTicks} ticks`).toBe(
                nominal
              );
            }
          }
        }
      });
    }
  }
});
