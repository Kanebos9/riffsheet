/**
 * SYMBOLIC IMPORT, PHASE 1 — a written score arrives with the answers already in it.
 *
 * Every case below is a defect Codex reproduced against HEAD, written down as the behaviour that
 * replaces it. The through-line: a detected note has a time and nothing else, so the pipeline has
 * to infer what it MEANT; a symbolic note was written by a human in a score editor, and the only
 * remaining job is to say it in the IR's tick domain without breaking it.
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { buildMultiPartScore, type ScorePart } from '../src/multipart.js';
import { buildTickSecondsMap } from '../src/tickSeconds.js';
import { validateIR } from '../src/validate.js';
import { utf8Bytes } from '../src/midi.js';
import { settings } from './helpers.js';
import type { BuildSettings, InputNote } from '../src/types.js';

const PPQ = 480;

/** A bar map in the source's own ticks, `count` bars of one signature. */
function bars(count: number, timeSig: [number, number], ppq = PPQ): NonNullable<InputNote['sourceBars']> {
  const ticks = (timeSig[0] * 4 * ppq) / timeSig[1];
  return Array.from({ length: count }, (_, index) => ({
    startTick: index * ticks,
    durationTicks: ticks,
    ppq,
    timeSig,
    number: index + 1,
    implicit: false
  }));
}

/** One written note. Seconds are deliberately sloppy: the ticks are what the source stated. */
function written(
  id: string,
  startTick: number,
  endTick: number,
  midi: number,
  extra: Partial<InputNote> = {},
  ppq = PPQ
): InputNote {
  return {
    id,
    // A nominal 120 BPM reading, so a caller looking at seconds sees something sane. Nothing in
    // the symbolic path reads these.
    startSec: (startTick / ppq) * 0.5,
    endSec: (endTick / ppq) * 0.5,
    midi,
    sourceTiming: { startTick, endTick, ppq },
    ...extra
  };
}

function symbolic(notes: InputNote[], over: Partial<BuildSettings> = {}) {
  return buildScore({ notes }, settings({ instrument: 'staff', tuningMidi: [], bpmOverride: 120, ...over }));
}

/** Every glyph in the score, in reading order. */
function glyphs(ir: ReturnType<typeof buildScore>['ir']) {
  return ir.bars.flatMap((bar) =>
    bar.voices.flatMap((voice) =>
      voice.beats.map((beat) => ({
        bar: bar.number,
        startTick: beat.startTick,
        durTicks: beat.durTicks,
        type: beat.durationType,
        dots: beat.dots,
        tuplet: beat.tuplet ? `${beat.tuplet.actual}/${beat.tuplet.normal}` : null,
        ids: beat.notes.map((note) => note.id)
      }))
    )
  );
}

describe('SYMBOLIC — written rhythm survives the trip (finding 1)', () => {
  it('an eighth-note triplet is engraved as a triplet, not as a 16th plus a two-tick "32nd"', () => {
    // The exact reproduction: three notes filling one quarter at PPQ 480. 480/3 = 160 source
    // ticks each, which is exactly 8 IR ticks — the CONVERSION was always right. What was wrong
    // is that nothing said the beat was a triplet, so the straight metric splitter spelled 8
    // ticks as 6 + 2 and typed the remainder `32nd`, a glyph that lasts 3.
    const notes = [
      written('t0', 0, 160, 60),
      written('t1', 160, 320, 62),
      written('t2', 320, 480, 64),
      written('q', 480, 960, 65, { sourceBars: bars(1, [4, 4]) })
    ];
    const built = symbolic(notes);

    const triplets = glyphs(built.ir).filter((glyph) => glyph.tuplet);
    expect(triplets).toHaveLength(3);
    for (const glyph of triplets) {
      expect(glyph.tuplet).toBe('3/2');
      expect(glyph.type).toBe('eighth');
      expect(glyph.durTicks).toBe(8);
    }
    // ...and the whole score is engravable, which is the claim MusicXML used to be the only
    // station to check.
    expect(validateIR(built.ir)).toEqual([]);
    expect(() => built.toMusicXML()).not.toThrow();
    expect(built.toMusicXML()).toContain('<actual-notes>3</actual-notes>');
  });

  it('a sextuplet reaches the page as 6/4, not as six mis-typed straight glyphs', () => {
    const notes = [
      ...Array.from({ length: 6 }, (_, i) => written(`s${i}`, i * 80, (i + 1) * 80, 60 + i)),
      written('rest-of-bar', 480, 1920, 67, { sourceBars: bars(1, [4, 4]) })
    ];
    const built = symbolic(notes);
    const sextuplets = glyphs(built.ir).filter((glyph) => glyph.tuplet === '6/4');
    expect(sextuplets).toHaveLength(6);
    for (const glyph of sextuplets) expect(glyph.durTicks).toBe(4);
    expect(validateIR(built.ir)).toEqual([]);
  });

  it('a 64th at 140 BPM is not deleted by the detector\'s 30 ms guard', () => {
    // A written 64th lasts 27 ms at 140 BPM. `applyGuards` dropped it outright, because
    // MIN_NOTE_SEC is a statement about a DECODER that never stopped — and no decoder was
    // involved here. The note survives; at 24 divisions per quarter its printable floor is a
    // 1/32, which is reported rather than silently applied.
    const notes = [
      written('sixtyfourth', 0, 30, 60),
      written('after', 30, 480, 62, { sourceBars: bars(1, [4, 4]) })
    ];
    const built = buildScore(
      { notes },
      settings({ instrument: 'staff', tuningMidi: [], bpmOverride: 140 })
    );
    const ids = glyphs(built.ir).flatMap((glyph) => glyph.ids);
    expect(ids).toContain('sixtyfourth');
    expect(built.ir.suspects.tooShortDropped).toBe(0);
    expect(built.diagnostics.reducedSymbolicBeats).toBeGreaterThan(0);
    expect(built.ir.diagnostics.some((line) => line.includes('finer than a 1/32'))).toBe(true);
    expect(validateIR(built.ir)).toEqual([]);
  });

  it('fast consecutive notes are not fused into a chord by the 35 ms window', () => {
    // The window is a model of a HUMAN HAND, so it applies to a performance and to nothing else.
    // At 240 BPM three written 32nds are 31 ms apart — inside the window — so the old path fused
    // them into one dyad-plus-note the source does not contain. They are perfectly printable
    // 32nds and must stay three separate attacks on three separate pitches.
    const notes = [
      written('a', 0, 60, 60),
      written('b', 60, 120, 67),
      written('c', 120, 1920, 72, { sourceBars: bars(1, [4, 4]) })
    ];
    const built = buildScore({ notes }, settings({ instrument: 'staff', tuningMidi: [], bpmOverride: 240 }));
    const all = glyphs(built.ir).filter((glyph) => glyph.ids.length);
    expect(all.some((glyph) => glyph.ids.length > 1)).toBe(false);
    expect([...new Set(all.flatMap((glyph) => glyph.ids))].sort()).toEqual(['a', 'b', 'c']);
  });

  it('an attack the printable floor absorbs is counted, not silently lost', () => {
    // Two notes a written 64th apart have one 1/32 slot between them at 24 divisions per quarter.
    // One of them cannot be printed; what must not happen is nobody being told.
    const notes = [
      written('a', 0, 30, 60),
      written('b', 30, 60, 67),
      written('c', 60, 1920, 72, { sourceBars: bars(1, [4, 4]) })
    ];
    const built = buildScore({ notes }, settings({ instrument: 'staff', tuningMidi: [], bpmOverride: 140 }));
    expect(built.ir.diagnostics.some((line) => line.includes('absorbed into their neighbour'))).toBe(true);
    expect(validateIR(built.ir)).toEqual([]);
  });

  it('round-trips: source ticks -> IR -> MusicXML durations agree with the printed types', () => {
    // A bar of straight sixteenths, a bar of triplets, a bar of held values. Nothing here may
    // reach MusicXML with a <type> its <duration> contradicts.
    const notes: InputNote[] = [];
    for (let i = 0; i < 16; i++) notes.push(written(`x${i}`, i * 120, (i + 1) * 120, 60));
    for (let i = 0; i < 12; i++) notes.push(written(`t${i}`, 1920 + i * 160, 1920 + (i + 1) * 160, 62));
    notes.push(written('h', 3840, 4800, 64));
    notes.push(written('q', 4800, 5760, 65, { sourceBars: bars(3, [4, 4]) }));

    const built = symbolic(notes);
    expect(validateIR(built.ir)).toEqual([]);
    const xml = built.toMusicXML();
    expect(() => built.toMusicXML()).not.toThrow();
    expect(xml).toContain('<actual-notes>3</actual-notes>');
    // Every written attack is still on the page under its own id.
    const ids = new Set(glyphs(built.ir).flatMap((glyph) => glyph.ids));
    for (const note of notes) expect(ids.has(note.id!)).toBe(true);
  });

  it('flattening several source voices into one is COUNTED, never silent', () => {
    // A half note in voice 1 under a voice-2 quarter. v1 engraves one voice, which is the
    // sanctioned phase-1 behaviour; what is not sanctioned is nobody being able to tell.
    const notes = [
      written('v1-half', 0, 960, 60, { sourceVoiceIndex: 0 }),
      written('v2-quarter', 480, 960, 67, { sourceVoiceIndex: 1 }),
      written('v1-rest-of-bar', 960, 1920, 62, { sourceVoiceIndex: 0, sourceBars: bars(1, [4, 4]) })
    ];
    const built = symbolic(notes);
    expect(built.diagnostics.flattenedVoices).toBe(2);
    expect(built.ir.diagnostics.some((line) => line.includes('flattened 2 voices'))).toBe(true);
    // The identity survives to the IR rather than evaporating at the importer.
    const voices = new Set(
      built.ir.bars.flatMap((bar) =>
        bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => note.sourceVoiceIndex)))
      )
    );
    expect(voices.has(0)).toBe(true);
    expect(voices.has(1)).toBe(true);
  });

  it('a single-voice source reports no flattening', () => {
    const notes = [
      written('a', 0, 480, 60, { sourceVoiceIndex: 0 }),
      written('b', 480, 1920, 62, { sourceVoiceIndex: 0, sourceBars: bars(1, [4, 4]) })
    ];
    expect(symbolic(notes).diagnostics.flattenedVoices).toBe(0);
  });
});

describe('SYMBOLIC — the source\'s meter is the clock, not a label (finding 2)', () => {
  /** Seconds of each downbeat, which is the number the reproduction got wrong. */
  const downbeats = (built: ReturnType<typeof buildScore>) => built.skeleton.downbeatTimesSec.map((s) => +s.toFixed(6));

  it('6/8 at 120 BPM puts the second downbeat at 1.5 s, not 1.0 s', () => {
    // Two bars of 6/8. A 6/8 bar is three quarters long, so at a quarter-note tempo of 120 it
    // lasts 1.5 s. The old path replaced the bar list AFTER the conversion closures had captured
    // a 4/4 quarter pulse, so the bars said 6/8 and the clock said 4/4.
    const notes = [
      written('a', 0, 1440, 60),
      written('b', 1440, 2880, 62, { sourceBars: bars(2, [6, 8]) })
    ];
    const built = symbolic(notes);
    expect(built.ir.timeSig).toEqual([6, 8]);
    expect(built.ir.compound).toBe(true);
    expect(downbeats(built)[0]).toBeCloseTo(0, 6);
    expect(downbeats(built)[1]).toBeCloseTo(1.5, 6);
  });

  it('3/8 puts the second downbeat at 0.75 s', () => {
    const notes = [
      written('a', 0, 720, 60),
      written('b', 720, 1440, 62, { sourceBars: bars(2, [3, 8]) })
    ];
    const built = symbolic(notes);
    expect(built.ir.timeSig).toEqual([3, 8]);
    expect(downbeats(built)[1]).toBeCloseTo(0.75, 6);
  });

  it('5/4 puts the second downbeat at 2.5 s', () => {
    const notes = [
      written('a', 0, 2400, 60),
      written('b', 2400, 4800, 62, { sourceBars: bars(2, [5, 4]) })
    ];
    const built = symbolic(notes);
    expect(built.ir.timeSig).toEqual([5, 4]);
    expect(downbeats(built)[1]).toBeCloseTo(2.5, 6);
  });

  it('7/8 puts the second downbeat at 1.75 s', () => {
    const notes = [
      written('a', 0, 1680, 60),
      written('b', 1680, 3360, 62, { sourceBars: bars(2, [7, 8]) })
    ];
    const built = symbolic(notes);
    expect(built.ir.timeSig).toEqual([7, 8]);
    expect(downbeats(built)[1]).toBeCloseTo(1.75, 6);
  });

  it('the bars and the seconds map agree — tickToSeconds of a downbeat IS its downbeat time', () => {
    const notes = [
      written('a', 0, 1440, 60),
      written('b', 1440, 2880, 62, { sourceBars: bars(2, [6, 8]) })
    ];
    const built = symbolic(notes);
    built.skeleton.bars.forEach((bar, index) => {
      expect(built.skeleton.tickToSeconds(bar.startTick)).toBeCloseTo(built.skeleton.downbeatTimesSec[index], 6);
    });
  });

  it('a meter change mid-piece is out of scope and SAYS SO', () => {
    const mixed: NonNullable<InputNote['sourceBars']> = [
      { startTick: 0, durationTicks: 1920, ppq: PPQ, timeSig: [4, 4], number: 1, implicit: false },
      { startTick: 1920, durationTicks: 1440, ppq: PPQ, timeSig: [3, 4], number: 2, implicit: false }
    ];
    const notes = [
      written('a', 0, 1920, 60),
      written('b', 1920, 3360, 62, { sourceBars: mixed })
    ];
    const built = symbolic(notes);
    expect(built.diagnostics.mixedMeter).toBe(true);
    expect(built.ir.bars.map((bar) => bar.timeSig)).toEqual([[4, 4], [3, 4]]);
    expect(built.ir.diagnostics.some((line) => line.includes('meter changes mid-piece'))).toBe(true);
  });
});

describe('TICK <-> SECONDS — one map, exact both ways (finding 2)', () => {
  const ir = (changes?: { tick: number; bpm: number }[]) => ({
    divisions: 24,
    tempo: { displayBpm: 120, ...(changes ? { changes } : {}) }
  });

  it('a constant tempo is a straight line', () => {
    const map = buildTickSecondsMap(ir());
    expect(map.segments).toHaveLength(1);
    expect(map.tickToSec(0)).toBe(0);
    expect(map.tickToSec(24)).toBeCloseTo(0.5, 12);
    expect(map.tickToSec(96)).toBeCloseTo(2, 12);
    expect(map.secToTick(2)).toBeCloseTo(96, 9);
  });

  it('a tempo change bends the line at exactly its own tick', () => {
    // 120 for one bar (96 ticks = 2 s), then 60: a quarter now lasts 1 s.
    const map = buildTickSecondsMap(ir([{ tick: 0, bpm: 120 }, { tick: 96, bpm: 60 }]));
    expect(map.segments.map((segment) => [segment.tick, segment.bpm])).toEqual([[0, 120], [96, 60]]);
    expect(map.tickToSec(96)).toBeCloseTo(2, 12);
    expect(map.tickToSec(120)).toBeCloseTo(3, 12);
    expect(map.bpmAt(95)).toBe(120);
    expect(map.bpmAt(96)).toBe(60);
  });

  it('a tempo change at tick zero is honoured, not skipped', () => {
    // The one entry every other reader of this data historically dropped.
    const map = buildTickSecondsMap(ir([{ tick: 0, bpm: 90 }]));
    expect(map.bpmAt(0)).toBe(90);
    expect(map.tickToSec(24)).toBeCloseTo(60 / 90, 12);
  });

  it('secToTick is the exact inverse of tickToSec across every segment', () => {
    const map = buildTickSecondsMap(ir([{ tick: 0, bpm: 132 }, { tick: 96, bpm: 60 }, { tick: 240, bpm: 176 }]));
    for (const tick of [0, 1, 47, 95, 96, 97, 239, 240, 241, 1000]) {
      expect(map.secToTick(map.tickToSec(tick))).toBeCloseTo(tick, 6);
    }
    for (const sec of [0, 0.01, 1.9, 2.0, 2.1, 5, 12.5]) {
      expect(map.tickToSec(map.secToTick(sec))).toBeCloseTo(sec, 9);
    }
  });

  it('seconds increase strictly with ticks, whatever the tempo list contains', () => {
    // Unsorted, duplicated, and carrying entries no reader could use.
    const map = buildTickSecondsMap(
      ir([
        { tick: 240, bpm: 176 },
        { tick: 96, bpm: 0 },
        { tick: 96, bpm: -4 },
        { tick: 0, bpm: 100 },
        { tick: 48, bpm: Number.NaN }
      ])
    );
    let previous = -Infinity;
    for (let tick = 0; tick <= 480; tick += 7) {
      const sec = map.tickToSec(tick);
      expect(sec).toBeGreaterThan(previous);
      previous = sec;
    }
    expect(map.segments.every((segment) => segment.bpm > 0)).toBe(true);
  });

  it('a repeated tempo is not a new segment', () => {
    const map = buildTickSecondsMap(ir([{ tick: 0, bpm: 120 }, { tick: 96, bpm: 120 }, { tick: 192, bpm: 60 }]));
    expect(map.segments.map((segment) => segment.bpm)).toEqual([120, 60]);
  });

  it('is built straight off a real symbolic build and matches its skeleton', () => {
    const notes = [
      written('a', 0, 1920, 60),
      written('b', 1920, 3840, 62, {
        sourceBars: bars(2, [4, 4]),
        sourceTempoChanges: [{ tick: 0, ppq: PPQ, bpm: 120 }, { tick: 1920, ppq: PPQ, bpm: 60 }]
      })
    ];
    const built = symbolic(notes);
    const map = buildTickSecondsMap(built.ir);
    expect(map.bpmAt(0)).toBe(120);
    expect(map.bpmAt(96)).toBe(60);
    expect(map.tickToSec(96)).toBeCloseTo(2, 6);
    // Bar 2's downbeat is at 2 s by both routes.
    expect(built.skeleton.downbeatTimesSec[1]).toBeCloseTo(map.tickToSec(96), 4);
  });
});

describe('TAB VISIBILITY IS NOT INSTRUMENT IDENTITY (X1)', () => {
  const BASS = [28, 33, 38, 43];
  const phrase: InputNote[] = [
    { id: 'n0', startSec: 0, endSec: 0.5, midi: 40 },
    { id: 'n1', startSec: 0.5, endSec: 1, midi: 45 },
    { id: 'n2', startSec: 1, endSec: 1.5, midi: 43 },
    { id: 'n3', startSec: 1.5, endSec: 2, midi: 38 }
  ];
  const base: Partial<BuildSettings> = { instrument: 'bass4', tuningMidi: BASS, bpmOverride: 120 };

  const on = buildScore({ notes: phrase }, settings(base));
  const off = buildScore({ notes: phrase }, settings({ ...base, tab: 'omit' }));

  it('written pitches are identical with the tab on and off', () => {
    const spelled = (built: ReturnType<typeof buildScore>) =>
      built.ir.bars.flatMap((bar) =>
        bar.voices.flatMap((voice) =>
          voice.beats.flatMap((beat) => beat.notes.map((note) => `${note.step}${note.alter}/${note.octave}`))
        )
      );
    expect(spelled(off)).toEqual(spelled(on));
  });

  it('the written octave stays the fretted convention with the tab off', () => {
    // The bug: `tab: off` used to be expressed as `instrument: 'staff'` with an empty tuning, and
    // the -12 display transposition rides on having strings. The notation dropped an octave.
    const octaveOf = (built: ReturnType<typeof buildScore>) =>
      built.toAlphaTabModelData().tracks[0].staves[0].displayTranspositionPitch;
    expect(octaveOf(off)).toBe(-12);
    expect(octaveOf(off)).toBe(octaveOf(on));
    expect(off.ir.instrument.kind).toBe('bass4');
    expect(off.ir.instrument.stringCount).toBe(4);
  });

  it('only the tablature staff disappears', () => {
    const staves = (built: ReturnType<typeof buildScore>) =>
      built.toAlphaTabModelData().tracks[0].staves.map((staff) => staff.showTablature);
    expect(staves(on)).toEqual([true]);
    expect(staves(off)).toEqual([false]);
    expect(off.toMusicXML()).not.toContain('<staff-details');
    expect(on.toMusicXML()).toContain('<staff-details');
  });

  it('the exported MusicXML pitches are identical too', () => {
    const pitches = (xml: string) => xml.match(/<pitch>[\s\S]*?<\/pitch>/g) ?? [];
    const onPitches = pitches(on.toMusicXML());
    const offPitches = pitches(off.toMusicXML());
    // With the tab printed, every note appears twice — once on the notation staff, once on the
    // TAB staff. Hiding the tab removes the second copy and touches nothing about the first.
    expect(offPitches.length).toBeGreaterThan(0);
    expect(onPitches.length).toBe(offPitches.length * 2);
    expect(onPitches.slice(0, offPitches.length)).toEqual(offPitches);
  });
});

describe('MULTI-PART IDENTITY — one id space, no collisions (finding 8)', () => {
  const line = (midi: number, id: string): InputNote[] => [
    { id, startSec: 0, endSec: 0.5, midi },
    { id: `${id}x`, startSec: 0.5, endSec: 1, midi: midi + 2 },
    { id: `${id}y`, startSec: 1, endSec: 1.5, midi: midi + 4 },
    { id: `${id}z`, startSec: 1.5, endSec: 2, midi: midi + 5 }
  ];
  const part = (notes: InputNote[], name: string): ScorePart => ({ name, notes, instrument: 'staff', tuningMidi: [] });

  it('four parts produce four disjoint sets of note ids', () => {
    const result = buildMultiPartScore(
      [part(line(60, 'n0'), 'A'), part(line(48, 'n0'), 'B'), part(line(55, 'n0'), 'C'), part(line(43, 'n0'), 'D')],
      { beats: undefined },
      settings({ instrument: 'staff', tuningMidi: [], bpmOverride: 120 })
    );
    const idsOf = (index: number) =>
      result.parts[index].ir.bars.flatMap((bar) =>
        bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => note.id)))
      );
    const all = [0, 1, 2, 3].flatMap(idsOf);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(0);
  });

  it('a live-part note literally named "p2-n0" does not become part two\'s note', () => {
    // The exact collision: the first part keeps its ids bare, so `p2-n0` in part one was the same
    // STRING as part two's generated `p2-` + `n0`. Score import names notes after their source
    // coordinates, so ids of that shape genuinely occur.
    const live: InputNote[] = [
      { id: 'p2-n0', startSec: 0, endSec: 0.5, midi: 60 },
      { id: 'p2-n1', startSec: 0.5, endSec: 1, midi: 62 },
      { id: 'other', startSec: 1, endSec: 2, midi: 64 }
    ];
    const second: InputNote[] = [
      { id: 'n0', startSec: 0, endSec: 0.5, midi: 48 },
      { id: 'n1', startSec: 0.5, endSec: 1, midi: 50 },
      { id: 'n2', startSec: 1, endSec: 2, midi: 52 }
    ];
    const result = buildMultiPartScore(
      [part(live, 'Live'), part(second, 'Imported')],
      { beats: undefined },
      settings({ instrument: 'staff', tuningMidi: [], bpmOverride: 120 })
    );
    const idsOf = (index: number) =>
      result.parts[index].ir.bars.flatMap((bar) =>
        bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => note.id)))
      );
    const first = new Set(idsOf(0));
    const later = new Set(idsOf(1));
    expect([...first].some((id) => later.has(id))).toBe(false);
    // The live part's own ids are untouched — webcore's selection and undo key on them.
    expect(first.has('p2-n0')).toBe(true);
    // ...and the flat id still resolves to a structured identity.
    expect(result.resolveNoteId('p2-n0')).toEqual({ partId: 'P1', partIndex: 0, noteId: 'p2-n0' });
    const secondId = [...later][0];
    expect(result.resolveNoteId(secondId)?.partId).toBe('P2');
    expect(result.resolveNoteId('nothing-like-this')).toBeNull();
  });

  it("tab:'omit' and octaveTransposition reach the alphaTab hand-off, not just MusicXML", () => {
    const GUITAR = [40, 45, 50, 55, 59, 64];
    const notes: InputNote[] = [
      { id: 'g0', startSec: 0, endSec: 0.5, midi: 55 },
      { id: 'g1', startSec: 0.5, endSec: 1, midi: 57 },
      { id: 'g2', startSec: 1, endSec: 2, midi: 59 }
    ];
    const result = buildMultiPartScore(
      [
        { name: 'Guitar', notes, instrument: 'guitar6', tuningMidi: GUITAR, tab: 'omit', octaveTransposition: 'none' },
        { name: 'Bass', notes: notes.map((n) => ({ ...n, id: `b${n.id}`, midi: n.midi - 12 })), instrument: 'bass4', tuningMidi: [28, 33, 38, 43] }
      ],
      { beats: undefined },
      settings({ instrument: 'guitar6', tuningMidi: GUITAR, bpmOverride: 120 })
    );
    const guitarTrack = result.toAlphaTabModelData().tracks[0];
    expect(guitarTrack.staves.some((staff) => staff.showTablature)).toBe(false);
    expect(guitarTrack.staves[0].displayTranspositionPitch).toBe(0);
    // The other part is untouched: it still shows its tab and its conventional octave.
    const bassTrack = result.toAlphaTabModelData().tracks[1];
    expect(bassTrack.staves.some((staff) => staff.showTablature)).toBe(true);
    expect(bassTrack.staves[0].displayTranspositionPitch).toBe(-12);
  });
});

describe('GRAND STAFF — accidentals are read down a staff, not across the brace (finding 9)', () => {
  it('an F# on the lower staff does not cancel the F# on the upper staff', () => {
    // Both in one measure, lower first. A reader tracking accidentals down the treble staff has
    // seen no F at all when the upper F# arrives, so it must print its own sharp.
    const notes: InputNote[] = [
      { id: 'low', startSec: 0, endSec: 0.5, midi: 42, sourceStaffIndex: 1 },
      { id: 'high', startSec: 0.5, endSec: 1, midi: 78, sourceStaffIndex: 0 },
      { id: 'tail', startSec: 1, endSec: 2, midi: 79, sourceStaffIndex: 0 }
    ];
    const built = buildScore(
      { notes },
      settings({ instrument: 'staff', tuningMidi: [], bpmOverride: 120, clefMode: 'grand' })
    );
    expect(built.ir.grandStaff).toBe(true);
    const all = built.ir.bars.flatMap((bar) =>
      bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes))
    );
    const low = all.find((note) => note.id === 'low')!;
    const high = all.find((note) => note.id === 'high')!;
    expect(low.step).toBe('F');
    expect(high.step).toBe('F');
    expect(low.staffIndex).toBe(1);
    expect(high.staffIndex).toBe(0);
    expect(low.accidentalDisplay).toBe('sharp');
    // THE ASSERTION THIS FILE EXISTS FOR: the upper staff prints its own accidental.
    expect(high.accidentalDisplay).toBe('sharp');
  });

  it('a repeat on the SAME staff still suppresses the second accidental', () => {
    // The rule is per staff, not per note: two F#s on one staff in one measure print one sharp.
    const notes: InputNote[] = [
      { id: 'a', startSec: 0, endSec: 0.5, midi: 78, sourceStaffIndex: 0 },
      { id: 'b', startSec: 0.5, endSec: 1, midi: 78, sourceStaffIndex: 0 },
      { id: 'low', startSec: 1, endSec: 2, midi: 42, sourceStaffIndex: 1 }
    ];
    const built = buildScore(
      { notes },
      settings({ instrument: 'staff', tuningMidi: [], bpmOverride: 120, clefMode: 'grand' })
    );
    const all = built.ir.bars.flatMap((bar) =>
      bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes))
    );
    expect(all.find((note) => note.id === 'a')!.accidentalDisplay).toBe('sharp');
    expect(all.find((note) => note.id === 'b')!.accidentalDisplay).toBeUndefined();
  });
});

describe('MIDI EXPORT — bytes a reader can actually parse (finding 13)', () => {
  it('track names are UTF-8, so a Turkish name survives', () => {
    // `charCodeAt(0) & 0x7f` turned ğ (U+011F) into 0x1f, a control character.
    expect(utf8Bytes('Bağlama')).toEqual([0x42, 0x61, 0xc4, 0x9f, 0x6c, 0x61, 0x6d, 0x61]);
    expect(utf8Bytes('Bass')).toEqual([0x42, 0x61, 0x73, 0x73]);
    // Astral plane: one code POINT, four bytes, not two broken sequences.
    expect(utf8Bytes('\u{1F3B8}')).toEqual([0xf0, 0x9f, 0x8e, 0xb8]);
    expect(utf8Bytes('é')).toEqual([0xc3, 0xa9]);
  });

  it('the exported file carries those bytes verbatim', () => {
    const notes: InputNote[] = [
      { id: 'n0', startSec: 0, endSec: 0.5, midi: 40 },
      { id: 'n1', startSec: 0.5, endSec: 2, midi: 45 }
    ];
    const result = buildMultiPartScore(
      [
        { name: 'Bağlama', notes, instrument: 'staff', tuningMidi: [] },
        { name: 'Gitar', notes: notes.map((n) => ({ ...n, id: `g${n.id}` })), instrument: 'staff', tuningMidi: [] }
      ],
      { beats: undefined },
      settings({ instrument: 'staff', tuningMidi: [], bpmOverride: 120 })
    );
    const bytes = Array.from(result.toMidi(true));
    const needle = utf8Bytes('Bağlama');
    const found = bytes.some((_, index) => needle.every((byte, offset) => bytes[index + offset] === byte));
    expect(found).toBe(true);
  });

  it('a tick-zero source tempo is what the header declares', () => {
    const notes = [
      written('a', 0, 1920, 60),
      written('b', 1920, 3840, 62, {
        sourceBars: bars(2, [4, 4]),
        sourceTempoChanges: [{ tick: 0, ppq: PPQ, bpm: 90 }]
      })
    ];
    const built = symbolic(notes);
    const midi = Array.from(built.toMidi(true));
    // FF 51 03 <us per quarter>: 90 BPM is 666_666 us.
    const at = midi.findIndex((byte, index) => byte === 0xff && midi[index + 1] === 0x51 && midi[index + 2] === 0x03);
    expect(at).toBeGreaterThan(-1);
    const us = (midi[at + 3] << 16) | (midi[at + 4] << 8) | midi[at + 5];
    expect(Math.round(60_000_000 / us)).toBe(90);
  });
});
