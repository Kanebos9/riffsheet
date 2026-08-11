/**
 * ISSUE #38 — A REAL GRAND STAFF, INCLUDING ONE WITH TABLATURE UNDER IT.
 *
 * THE BUG: `grandStaff` was honoured only when the part had NO strings. Both emitters carried
 * their own copy of the condition (`ir.grandStaff && isStaffOnly`), so asking a bass or guitar
 * for a grand staff produced a flag nobody acted on and a single bass clef buried in ledger
 * lines. Each emitter also carried its own copy of the middle-C split rule, which is two places
 * for the same note to be assigned to different staves.
 *
 * WHAT IS PINNED HERE:
 *   - the four layouts and their staff counts: plain, tab, grand, grand + tab;
 *   - the split decided once in the IR (`IRNote.staffIndex`) and obeyed by both emitters;
 *   - the N-staff <backup> bookkeeping — every staff of every measure lands on the barline;
 *   - staff 2 of a three-staff part is a NOTATION staff, not the tab staff wearing its number,
 *     which is exactly what the old `o.staff === 2` inference would have made of it;
 *   - the tie and attack-count invariants of #31, now per staff.
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { readMusicXml, parseXml, findAll, type ReadScore } from './xmlReader.js';
import { grid, playedNotes, settings } from './helpers.js';
import type { BuildSettings, GridSetting, InputNote } from '../src/types.js';
import type { RiffsheetIR } from '../src/ir.js';

const BASS6 = [23, 28, 33, 38, 43, 48];

/**
 * A part too wide for one staff: E2 up to E5. Min 40 <= 55, max 76 >= 72, span 36 >= 24, so
 * `clefMode: 'auto'` promotes it to a grand staff on its own.
 */
const WIDE = playedNotes(
  [
    { beat: 0, midi: 40 },
    { beat: 1, midi: 45 },
    { beat: 2, midi: 62 },
    { beat: 3, midi: 76 },
    { beat: 4, midi: 36 },
    { beat: 5, midi: 60 },
    { beat: 6, midi: 59 },
    { beat: 7, midi: 72 }
  ],
  0.8
);

function build(notes: InputNote[], over: Partial<BuildSettings>, bars = 2) {
  return buildScore({ notes, ...grid(bars) }, settings(over));
}

/** Ticks each staff of each measure actually advanced. Chord members do not move the cursor. */
function staffAdvance(read: ReadScore): Map<string, number> {
  const out = new Map<string, number>();
  for (const note of read.notes) {
    if (note.chord) continue;
    const key = `m${note.measure}/s${note.staff}`;
    out.set(key, (out.get(key) ?? 0) + note.duration);
  }
  return out;
}

/** Every staff of every measure must reach the barline — the N-staff form of assertion G.4. */
function expectBalanced(read: ReadScore, ir: RiffsheetIR, staves: number, label: string): void {
  const advance = staffAdvance(read);
  expect(advance.size, `${label}: ${staves} staves x ${ir.bars.length} measures`).toBe(staves * ir.bars.length);
  for (const bar of ir.bars) {
    for (let staff = 1; staff <= staves; staff++) {
      expect(advance.get(`m${bar.number}/s${staff}`), `${label}: measure ${bar.number} staff ${staff}`).toBe(
        bar.durTicks
      );
    }
  }
}

/** Ties must open and close within one staff, and never dangle at the end of it. */
function tieErrorsPerStaff(read: ReadScore): string[] {
  const errors: string[] = [];
  const staves = [...new Set(read.notes.map((note) => note.staff))];
  for (const staff of staves) {
    const open = new Map<number, boolean>();
    for (const note of read.notes.filter((n) => n.staff === staff && !n.isRest)) {
      if (note.tieStop && !open.get(note.midi!)) errors.push(`staff ${staff}: tie stop on ${note.midi} with nothing open`);
      if (note.tieStop) open.set(note.midi!, false);
      if (note.tieStart) open.set(note.midi!, true);
    }
    for (const [midi, isOpen] of open) if (isOpen) errors.push(`staff ${staff}: dangling tie start on ${midi}`);
  }
  return errors;
}

// ---- the four layouts ------------------------------------------------------------------------

describe('#38 — staff count is a function of (grand staff, strings), not of one or the other', () => {
  it('plain: one staff, no <staves>, no <staff> on any note', () => {
    const built = build(playedNotes([{ beat: 0, midi: 62 }, { beat: 1, midi: 64 }], 0.8), {
      instrument: 'staff',
      tuningMidi: []
    });
    expect(built.ir.grandStaff).toBe(false);
    expect(built.toAlphaTabModelData().tracks[0].staves).toHaveLength(1);
    const xml = built.toMusicXML();
    expect(xml).not.toContain('<staves>');
    expect(xml).not.toContain('<staff>');
    expectBalanced(readMusicXml(xml), built.ir, 1, 'plain');
  });

  it('TAB only: notation + tab, unchanged — one alphaTab staff showing both', () => {
    const built = build(playedNotes([{ beat: 0, midi: 40 }, { beat: 1, midi: 43 }], 0.8), {});
    expect(built.ir.grandStaff).toBe(false);
    const staves = built.toAlphaTabModelData().tracks[0].staves;
    expect(staves).toHaveLength(1);
    expect(staves[0].showStandardNotation).toBe(true);
    expect(staves[0].showTablature).toBe(true);
    const xml = built.toMusicXML();
    expect(xml).toContain('<staves>2</staves>');
    expect(xml).toContain('<clef number="2"><sign>TAB</sign><line>4</line></clef>');
    expect(xml).toContain('<staff-details number="2" show-frets="numbers">');
    expectBalanced(readMusicXml(xml), built.ir, 2, 'tab-only');
  });

  it('grand, no strings: two notation staves', () => {
    const built = build(WIDE, { instrument: 'staff', tuningMidi: [], clefMode: 'grand' });
    expect(built.ir.grandStaff).toBe(true);
    const staves = built.toAlphaTabModelData().tracks[0].staves;
    expect(staves).toHaveLength(2);
    expect(staves.map((staff) => staff.bars[0].clef)).toEqual(['G2', 'F4']);
    expect(staves.every((staff) => !staff.showTablature)).toBe(true);
    const xml = built.toMusicXML();
    expect(xml).toContain('<staves>2</staves>');
    expect(xml).toContain('<clef number="1"><sign>G</sign><line>2</line></clef>');
    expect(xml).toContain('<clef number="2"><sign>F</sign><line>4</line></clef>');
    expect(xml).not.toContain('TAB');
    expectBalanced(readMusicXml(xml), built.ir, 2, 'grand');
  });

  it('THE FIX: grand + strings is THREE staves — treble, bass, TAB', () => {
    const built = build(WIDE, { instrument: 'bass6', tuningMidi: BASS6, clefMode: 'grand' });
    expect(built.ir.grandStaff).toBe(true);

    const staves = built.toAlphaTabModelData().tracks[0].staves;
    expect(staves).toHaveLength(3);
    expect(staves.map((staff) => staff.showStandardNotation)).toEqual([true, true, false]);
    expect(staves.map((staff) => staff.showTablature)).toEqual([false, false, true]);
    expect(staves.map((staff) => staff.bars[0].clef).slice(0, 2)).toEqual(['G2', 'F4']);
    // The TAB staff is LAST and is the only one holding a tuning: a consumer that remembers the
    // last staff's tuning (webcore's ScoreIndex does exactly that) must not remember an empty one.
    expect(staves[2].tuningsHighToLow).toEqual([48, 43, 38, 33, 28, 23]);
    expect(staves[0].tuningsHighToLow).toEqual([]);

    const xml = built.toMusicXML();
    expect(xml).toContain('<staves>3</staves>');
    expect(xml).toContain('<clef number="1"><sign>G</sign><line>2</line></clef>');
    expect(xml).toContain('<clef number="2"><sign>F</sign><line>4</line></clef>');
    expect(xml).toContain('<clef number="3"><sign>TAB</sign><line>6</line></clef>');
    expect(xml).toContain('<staff-details number="3" show-frets="numbers">');
    expect(() => parseXml(xml)).not.toThrow();
    expectBalanced(readMusicXml(xml), built.ir, 3, 'grand+tab');
  });

  it("clefMode 'auto' still promotes a genuinely wide part, and takes the tab staff with it", () => {
    const built = build(WIDE, { instrument: 'bass6', tuningMidi: BASS6 });
    expect(built.ir.grandStaff).toBe(true);
    expect(built.toAlphaTabModelData().tracks[0].staves).toHaveLength(3);
    expect(built.toMusicXML()).toContain('<staves>3</staves>');
  });

  it('a narrow fretted part is untouched: no grand staff, two MusicXML staves', () => {
    const built = build(playedNotes([{ beat: 0, midi: 40 }, { beat: 1, midi: 47 }], 0.8), {
      instrument: 'bass6',
      tuningMidi: BASS6
    });
    expect(built.ir.grandStaff).toBe(false);
    expect(built.toAlphaTabModelData().tracks[0].staves).toHaveLength(1);
    expect(built.toMusicXML()).toContain('<staves>2</staves>');
  });
});

// ---- the split rule --------------------------------------------------------------------------

describe('#38 — the split is decided once, in the IR, and both emitters obey it', () => {
  const boundary: InputNote[] = playedNotes(
    [
      { beat: 0, midi: 59 }, // B3 — below middle C, lower staff
      { beat: 1, midi: 60 }, // C4 — middle C itself, upper staff
      { beat: 2, midi: 61 },
      { beat: 3, midi: 48 }
    ],
    0.8
  );

  it('IRNote.staffIndex splits at middle C, and only when the score is a grand staff', () => {
    const grandIr = build(boundary, { instrument: 'staff', tuningMidi: [], clefMode: 'grand' }).ir;
    const placed = new Map(
      grandIr.bars.flatMap((bar) =>
        bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => [note.midi, note.staffIndex] as const)))
      )
    );
    expect(placed.get(59)).toBe(1);
    expect(placed.get(60)).toBe(0);
    expect(placed.get(61)).toBe(0);
    expect(placed.get(48)).toBe(1);

    const plainIr = build(boundary, { instrument: 'staff', tuningMidi: [] }).ir;
    expect(plainIr.grandStaff).toBe(false);
    const flags = plainIr.bars.flatMap((bar) =>
      bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => note.staffIndex)))
    );
    expect(flags.every((flag) => flag === undefined)).toBe(true);
  });

  it('MusicXML <staff> and the alphaTab staff agree with it, note for note', () => {
    const built = build(boundary, { instrument: 'bass6', tuningMidi: BASS6, clefMode: 'grand' });
    const expected = new Map<string, 0 | 1>();
    for (const bar of built.ir.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) for (const note of beat.notes) expected.set(note.id, note.staffIndex!);
      }
    }
    expect(expected.size).toBeGreaterThan(0);

    const staves = built.toAlphaTabModelData().tracks[0].staves;
    staves.slice(0, 2).forEach((staff, index) => {
      const ids = staff.bars.flatMap((bar) =>
        bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => note.id)))
      );
      for (const id of ids) expect(expected.get(id), `alphaTab staff ${index}: ${id}`).toBe(index);
    });

    const read = readMusicXml(built.toMusicXML());
    const byMidi = new Map(
      built.ir.bars.flatMap((bar) =>
        bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => [note.midi, note.staffIndex] as const)))
      )
    );
    for (const note of read.notes) {
      if (note.isRest || note.staff === 3) continue;
      expect(note.staff - 1, `MusicXML staff for midi ${note.midi}`).toBe(byMidi.get(note.midi!));
    }
  });

  it('an imported two-staff source still beats the pitch rule, tab staff and all', () => {
    const timing = { startTick: 0, endTick: 960, ppq: 960 };
    const built = buildScore(
      {
        notes: [
          // Deliberately inverted: the LOW note was engraved on the upper staff.
          { id: 'upper', startSec: 0, endSec: 0.5, midi: 43, sourceTiming: timing, sourceClef: 'treble', sourceStaffIndex: 0 },
          { id: 'lower', startSec: 0, endSec: 0.5, midi: 67, sourceTiming: timing, sourceClef: 'bass', sourceStaffIndex: 1 }
        ]
      },
      settings({ instrument: 'bass6', tuningMidi: BASS6 })
    );
    expect(built.ir.grandStaff).toBe(true);
    const placement = new Map(
      built.ir.bars.flatMap((bar) =>
        bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => [note.id, note.staffIndex] as const)))
      )
    );
    expect(placement.get('upper')).toBe(0);
    expect(placement.get('lower')).toBe(1);
    const staves = built.toAlphaTabModelData().tracks[0].staves;
    expect(staves).toHaveLength(3);
    const upperIds = staves[0].bars.flatMap((bar) =>
      bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => note.id)))
    );
    expect(upperIds).toContain('upper');
    expect(upperIds).not.toContain('lower');
  });
});

// ---- staff 2 is not the tab staff any more ----------------------------------------------------

describe('#38 — the third staff does not corrupt the second', () => {
  const built = build(WIDE, { instrument: 'bass6', tuningMidi: BASS6, clefMode: 'grand' });
  const xml = built.toMusicXML();
  const read = readMusicXml(xml);

  it('only the TAB staff carries <string>/<fret>', () => {
    const withTechnical = read.notes.filter((note) => note.string !== undefined);
    expect(withTechnical.length).toBeGreaterThan(0);
    for (const note of withTechnical) expect(note.staff).toBe(3);
  });

  it('the bass notation staff keeps its noteheads: print-object="no" is tab-only', () => {
    const doc = parseXml(xml);
    const hidden = findAll(doc, 'note').filter((note) => note.attrs['print-object'] === 'no');
    for (const note of hidden) {
      const staff = note.children.find((c) => c.name === 'staff');
      expect(staff?.text, 'a hidden notehead outside the tab staff').toBe('3');
    }
    const staff2 = read.notes.filter((note) => note.staff === 2 && !note.isRest);
    expect(staff2.length).toBeGreaterThan(0);
  });

  it('accidentals print on both notation staves and on neither tab note', () => {
    const sharpened = buildScore(
      { notes: playedNotes([{ beat: 0, midi: 42 }, { beat: 1, midi: 61 }], 0.8), ...grid(2) },
      settings({ instrument: 'bass6', tuningMidi: BASS6, clefMode: 'grand' })
    ).toMusicXML();
    const doc = parseXml(sharpened);
    const accidentals = findAll(doc, 'note').filter((note) => note.children.some((c) => c.name === 'accidental'));
    expect(accidentals.length).toBe(2);
    expect(accidentals.map((note) => note.children.find((c) => c.name === 'staff')?.text).sort()).toEqual(['1', '2']);
  });

  it('every note of a multi-staff part names its staff', () => {
    const doc = parseXml(xml);
    expect(findAll(doc, 'staff')).toHaveLength(findAll(doc, 'note').length);
  });

  it('the TAB staff shows the whole part, not half of it', () => {
    const notation = read.notes.filter((note) => !note.isRest && note.staff !== 3).length;
    const tab = read.notes.filter((note) => !note.isRest && note.staff === 3).length;
    expect(tab).toBe(notation);
    const staves = built.toAlphaTabModelData().tracks[0].staves;
    const count = (index: number): number =>
      staves[index].bars.flatMap((bar) => bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes))).length;
    expect(count(2)).toBe(count(0) + count(1));
  });

  it('the notation staves carry no string/fret: their tuning is empty and alphaTab would misread it', () => {
    const staves = built.toAlphaTabModelData().tracks[0].staves;
    for (const index of [0, 1]) {
      const notes = staves[index].bars.flatMap((bar) =>
        bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes))
      );
      expect(notes.length).toBeGreaterThan(0);
      for (const note of notes) {
        expect(note.string, `staff ${index} note ${note.id}`).toBeUndefined();
        expect(note.fret, `staff ${index} note ${note.id}`).toBeUndefined();
        expect(note.octave * 12 + note.tone).toBe(note.midi);
      }
    }
    const tabNotes = staves[2].bars.flatMap((bar) =>
      bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes))
    );
    expect(tabNotes.every((note) => note.string !== undefined && note.fret !== undefined)).toBe(true);
  });
});

// ---- the cursor, over everything that changes a measure length ---------------------------------

describe('#38 — the N-staff <backup> lands every staff on the barline', () => {
  // The same wide material through all four layouts. A forced single clef ('treble'/'bass') is
  // what keeps the first two at one notation staff: 'auto' would promote this range to a grand
  // staff, which is the behaviour the layouts below it pin.
  const LAYOUTS: { name: string; over: Partial<BuildSettings>; staves: number }[] = [
    { name: 'plain', over: { instrument: 'staff', tuningMidi: [], clefMode: 'treble' }, staves: 1 },
    { name: 'tab', over: { clefMode: 'bass' }, staves: 2 },
    { name: 'grand', over: { instrument: 'staff', tuningMidi: [], clefMode: 'grand' }, staves: 2 },
    { name: 'grand+tab', over: { instrument: 'bass6', tuningMidi: BASS6, clefMode: 'grand' }, staves: 3 }
  ];

  for (const layout of LAYOUTS) {
    it(`${layout.name}: a pickup measure backs up by what the staff advanced, not by a bar`, () => {
      const built = buildScore(
        {
          ...grid(3, 4, 120, 0),
          startOffsetSec: 2.0,
          notes: [
            { id: 'p', startSec: 1.75, endSec: 1.94, midi: 71 },
            ...playedNotes([{ beat: 0, midi: 40 }, { beat: 1, midi: 62 }, { beat: 2, midi: 45 }, { beat: 3, midi: 76 }], 0.8, 120, 2.0)
          ]
        },
        settings(layout.over)
      );
      const read = readMusicXml(built.toMusicXML());
      expect(read.measureLengths[0].implicit).toBe(true);
      expect(read.measureLengths[0].length).toBe(built.ir.bars[0].durTicks);
      expectBalanced(read, built.ir, layout.staves, `${layout.name} pickup`);
    });

    it(`${layout.name}: a 3/4 score with a whole-bar rest balances on every staff`, () => {
      const built = buildScore(
        {
          ...grid(3, 3, 120, 0),
          // Bar 2 (beats 3-5) is deliberately empty, and nothing rings into it: a centred
          // whole-bar rest, which every staff has to print for itself.
          notes: playedNotes(
            [
              { beat: 0, midi: 36, lengthBeats: 1 },
              { beat: 1, midi: 64, lengthBeats: 1 },
              { beat: 6, midi: 40, lengthBeats: 1 },
              { beat: 7, midi: 72, lengthBeats: 1 }
            ],
            0.8
          )
        },
        settings({ ...layout.over, timeSigOverride: [3, 4] })
      );
      const xml = built.toMusicXML();
      expect(xml).toContain('<rest measure="yes"/>');
      expectBalanced(readMusicXml(xml), built.ir, layout.staves, `${layout.name} 3/4`);
    });

    it(`${layout.name}: tuplets and ties across the whole stress corpus stay balanced`, async () => {
      const { SYNTHETIC_FIXTURES } = await import('../fixtures/synthetic.js');
      const fixture = SYNTHETIC_FIXTURES[0];
      const built = buildScore(
        {
          // Lift every third note an octave and a half so the part is wide enough to be split.
          notes: fixture.notes.slice(0, 32).map((note, i) => ({ ...note, id: `f${i}`, midi: note.midi + (i % 3 === 0 ? 30 : 0) })),
          beats: fixture.beats,
          downbeats: fixture.downbeats,
          audioDurationSec: fixture.audioDurationSec
        },
        settings(layout.over)
      );
      const read = readMusicXml(built.toMusicXML());
      expectBalanced(read, built.ir, layout.staves, `${layout.name} corpus`);
      expect(tieErrorsPerStaff(read)).toEqual([]);
    });
  }
});

// ---- #31's invariants, now per staff ----------------------------------------------------------

describe('#38 — ties and attack counts survive the split, per staff', () => {
  const GRIDS: GridSetting[] = ['auto', '1/4', '1/8', '1/16', 'thirtysecond', 'free'];
  // Two long notes an octave and a half apart, each crossing a barline: one attack per pitch,
  // split by a tie, and the two land on different staves.
  const crossing: InputNote[] = [
    { id: 'low', startSec: 1.5, endSec: 3.5, midi: 40 },
    { id: 'high', startSec: 1.5, endSec: 3.5, midi: 72 }
  ];

  for (const gridSetting of GRIDS) {
    it(`@ ${gridSetting}: a bar-crossing chord ties on both staves and restrikes on neither`, () => {
      const built = buildScore(
        { notes: crossing, ...grid(3) },
        settings({ instrument: 'bass6', tuningMidi: BASS6, clefMode: 'grand', grid: gridSetting })
      );

      // The IR: one attack per pitch, whatever the grid.
      const attacks = new Map<number, number>();
      for (const bar of built.ir.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) if (!note.tieStop) attacks.set(note.midi, (attacks.get(note.midi) ?? 0) + 1);
          }
        }
      }
      expect(attacks.get(40), `${gridSetting}: low restruck`).toBe(1);
      expect(attacks.get(72), `${gridSetting}: high restruck`).toBe(1);

      // The file: ties open and close inside each staff, and each staff has some.
      const read = readMusicXml(built.toMusicXML());
      expect(tieErrorsPerStaff(read)).toEqual([]);
      for (const staff of [1, 2, 3]) {
        const notes = read.notes.filter((note) => note.staff === staff && !note.isRest);
        expect(notes.filter((note) => note.tieStart).length, `staff ${staff} starts`).toBe(
          notes.filter((note) => note.tieStop).length
        );
        expect(notes.some((note) => note.tieStart), `staff ${staff} has a tie`).toBe(true);
      }

      // The screen: the same, per alphaTab staff.
      const staves = built.toAlphaTabModelData().tracks[0].staves;
      for (const staff of staves) {
        const notes = staff.bars.flatMap((bar) =>
          bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes))
        );
        expect(notes.filter((note) => !note.isTieDestination).length, 'one struck note per pitch').toBe(
          staff.showTablature ? 2 : 1
        );
      }
    });
  }

  it('a note printed on one staff is never printed on the other', () => {
    const built = build(WIDE, { instrument: 'bass6', tuningMidi: BASS6, clefMode: 'grand' });
    const staves = built.toAlphaTabModelData().tracks[0].staves;
    const idsOf = (index: number): string[] =>
      staves[index].bars.flatMap((bar) =>
        bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => note.id)))
      );
    const upper = new Set(idsOf(0));
    const lower = new Set(idsOf(1));
    for (const id of upper) expect(lower.has(id), `${id} on both staves`).toBe(false);
    expect(new Set([...upper, ...lower]).size).toBe(new Set(idsOf(2)).size);
  });
});
