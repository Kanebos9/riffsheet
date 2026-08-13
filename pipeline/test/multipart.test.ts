/**
 * MULTI-PART SCORES — N instruments, one document.
 *
 * The two claims that matter, and everything else in this file supports one of them:
 *
 *   1. A SINGLE-PART SCORE IS UNCHANGED, BYTE FOR BYTE, on all three emitters. webcore can route
 *      every build through `buildMultiPartScore` without a part-count branch, and today's output
 *      is not a special case that has to be maintained separately — it IS the N=1 case.
 *   2. PARTS DO NOT INTERACT. One part's notes reach another part's page through exactly two
 *      channels, the shared clock and the shared key signature, and through nothing else. Pin
 *      those two from outside and a part engraves identically no matter what is printed beneath it.
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { buildMultiPartScore, alignPartBars, MAX_PARTS, type ScorePart } from '../src/multipart.js';
import { toMultiPartMusicXML } from '../src/musicxml.js';
import { GOLDEN_CASES } from './goldenCases.js';
import { grid, playedNotes, settings } from './helpers.js';
import { readMusicXml } from './xmlReader.js';
import type { BuildSettings, InputNote } from '../src/types.js';

const bytes = (data: Uint8Array): number[] => Array.from(data);

/** The `<part id="...">` block of a document, so one part can be compared across documents. */
function partBody(xml: string, id: string): string {
  const open = `  <part id="${id}">`;
  const from = xml.indexOf(open);
  if (from < 0) throw new Error(`no part ${id}`);
  const to = xml.indexOf('\n  </part>', from);
  if (to < 0) throw new Error(`unterminated part ${id}`);
  return xml.slice(from, to);
}

const GUITAR: number[] = [40, 45, 50, 55, 59, 64];

function guitarPart(over: Partial<ScorePart> = {}): ScorePart {
  return {
    name: 'Guitar',
    instrument: 'guitar6',
    tuningMidi: GUITAR,
    notes: playedNotes(
      Array.from({ length: 8 }, (_, i) => ({ beat: i * 0.5, midi: [55, 59, 62, 64, 62, 59, 57, 55][i] })),
      0.9,
      120
    ).map((note, i) => ({ ...note, id: `g${i}` })),
    ...over
  };
}

function bassPart(over: Partial<ScorePart> = {}): ScorePart {
  return {
    name: 'Bass',
    notes: [
      { id: 'b0', startSec: 0.0, endSec: 0.48, midi: 40, velocity: 90 },
      { id: 'b1', startSec: 0.5, endSec: 0.98, midi: 43, velocity: 88 },
      { id: 'b2', startSec: 1.0, endSec: 1.48, midi: 45, velocity: 90 },
      { id: 'b3', startSec: 1.5, endSec: 1.98, midi: 40, velocity: 88 }
    ],
    ...over
  };
}

const TWO_BARS = grid(2, 4, 120);

describe('MULTI-PART — one part is byte-identical to a single-part build', () => {
  for (const testCase of GOLDEN_CASES) {
    const { notes, ...sharedInput } = testCase.input;

    it(`${testCase.name}: MusicXML is unchanged`, () => {
      const single = buildScore(testCase.input, testCase.settings).toMusicXML();
      const multi = buildMultiPartScore([{ notes }], sharedInput, testCase.settings).toMusicXML();
      expect(multi).toBe(single);
    });

    it(`${testCase.name}: both MIDI variants are unchanged, byte for byte`, () => {
      const single = buildScore(testCase.input, testCase.settings);
      const multi = buildMultiPartScore([{ notes }], sharedInput, testCase.settings);
      // A one-part score is a format-0 file with one track, exactly as it always was: the
      // multi-track writer hands it straight back to `toMidi` rather than wrapping it.
      expect(bytes(multi.toMidi(true))).toEqual(bytes(single.toMidi(true)));
      expect(bytes(multi.toMidi(false))).toEqual(bytes(single.toMidi(false)));
      expect(bytes(multi.toMidi(true)).slice(8, 12)).toEqual([0, 0, 0, 1]);
    });

    it(`${testCase.name}: the alphaTab hand-off is unchanged`, () => {
      const single = buildScore(testCase.input, testCase.settings).toAlphaTabModelData();
      const multi = buildMultiPartScore([{ notes }], sharedInput, testCase.settings).toAlphaTabModelData();
      // Deep equality is not enough: the hand-off is serialised, so key ORDER is part of the
      // contract too. Comparing the JSON compares both at once.
      expect(JSON.stringify(multi)).toBe(JSON.stringify(single));
      expect(multi.tracks[0].notationOnly).toBeUndefined();
    });
  }

  it('the IR of the one part is the IR a single build produces', () => {
    const testCase = GOLDEN_CASES[0];
    const { notes, ...sharedInput } = testCase.input;
    const single = buildScore(testCase.input, testCase.settings).ir;
    const multi = buildMultiPartScore([{ notes }], sharedInput, testCase.settings).parts[0].ir;
    expect(JSON.stringify(multi)).toBe(JSON.stringify(single));
  });
});

describe('MULTI-PART — the document', () => {
  const built = () =>
    buildMultiPartScore(
      [guitarPart({ abbreviation: 'Gtr.' }), bassPart({ abbreviation: 'Bs.' })],
      TWO_BARS,
      settings({ title: 'Duo', instrument: 'guitar6', tuningMidi: GUITAR })
    );

  it('emits one score-partwise with a real part-list, in printed order', () => {
    const xml = built().toMusicXML();
    const read = readMusicXml(xml);
    expect(read.partCount).toBe(2);
    expect(read.partList.map((p) => p.id)).toEqual(['P1', 'P2']);
    expect(read.partList[0].name).toBe('Guitar');
    expect(read.partList[1].name).toBe('Bass');
    expect(read.partList[0].abbreviation).toBe('Gtr.');
    expect(read.partList[1].abbreviation).toBe('Bs.');
    // Each part gets its own MIDI channel; nothing shares one.
    expect(read.partList.map((p) => p.channel)).toEqual([1, 2]);
    expect(new Set(read.partList.map((p) => p.channel)).size).toBe(2);
  });

  it('every part covers exactly the same bars, and each measure balances on its own cursor', () => {
    const xml = built().toMusicXML();
    const top = readMusicXml(xml, 0);
    const bottom = readMusicXml(xml, 1);
    expect(top.measureLengths).toEqual(bottom.measureLengths);
    for (const measure of [...top.measureLengths, ...bottom.measureLengths]) {
      expect(measure.length).toBe(96);
    }
  });

  it('the metronome mark is written once, on the top part only', () => {
    const xml = built().toMusicXML();
    expect(partBody(xml, 'P1')).toContain('<metronome>');
    expect(partBody(xml, 'P2')).not.toContain('<metronome>');
    // ...and a reader still finds it, because it reads the first part.
    expect(readMusicXml(xml).tempo).toBe(120);
  });

  it('hands alphaTab N tracks, one master-bar list, and flags the imported one', () => {
    const data = built().toAlphaTabModelData();
    expect(data.tracks).toHaveLength(2);
    expect(data.tracks[0].name).toBe('Guitar');
    expect(data.tracks[1].name).toBe('Bass');
    expect(data.tracks[0].notationOnly).toBeUndefined();
    expect(data.tracks[1].notationOnly).toBe(true);
    // alphaTab keys every track against ONE master-bar list, so every track's bars must match it.
    for (const track of data.tracks) {
      for (const staff of track.staves) expect(staff.bars).toHaveLength(data.masterBars.length);
    }
  });

  it('writes a format-1 MIDI file with a conductor track plus one track per part', () => {
    const midi = bytes(built().toMidi(true));
    expect(midi.slice(0, 4)).toEqual([0x4d, 0x54, 0x68, 0x64]);
    expect(midi.slice(8, 10)).toEqual([0, 1]); // format 1
    expect(midi.slice(10, 12)).toEqual([0, 3]); // conductor + 2 parts
    // Both parts really are in the file, on their own channels, even though the app never plays
    // the imported one — the format should be complete.
    let chunks = 0;
    for (let i = 0; i + 3 < midi.length; i++) {
      if (midi[i] === 0x4d && midi[i + 1] === 0x54 && midi[i + 2] === 0x72 && midi[i + 3] === 0x6b) chunks++;
    }
    expect(chunks).toBe(3);
    expect(midi).toContain(0x90); // note-on, channel 1
    expect(midi).toContain(0x91); // note-on, channel 2
    expect(bytes(built().toMidi(false)).slice(10, 12)).toEqual([0, 3]);
  });

  it('reports each part with a stable id, role and name', () => {
    const result = built();
    expect(result.parts.map((p) => p.id)).toEqual(['P1', 'P2']);
    expect(result.parts.map((p) => p.role)).toEqual(['live', 'imported']);
    expect(result.parts.map((p) => p.name)).toEqual(['Guitar', 'Bass']);
    expect(result.parts.map((p) => p.idPrefix)).toEqual(['', 'p2-']);
    expect(result.liveIndex).toBe(0);
  });

  it('gives every note in the SCORE a unique id — two parts cannot both own "n0"', () => {
    const result = buildMultiPartScore(
      // Both parts deliberately number their own notes from scratch.
      [
        { name: 'A', notes: playedNotes([{ beat: 0, midi: 60 }, { beat: 1, midi: 62 }], 0.9, 120) },
        { name: 'B', notes: playedNotes([{ beat: 0, midi: 48 }, { beat: 1, midi: 50 }], 0.9, 120) }
      ],
      TWO_BARS,
      settings({ title: 'Ids' })
    );
    const ids = result.parts.flatMap((part) =>
      part.ir.bars.flatMap((bar) => bar.voices.flatMap((v) => v.beats.flatMap((b) => b.notes.map((n) => n.id))))
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.startsWith('p2-'))).toBe(true);
  });
});

describe('MULTI-PART — what parts share, and what they do not', () => {
  it('shares one clock: every part has the same bars, bar 1 aligned', () => {
    const result = buildMultiPartScore(
      [
        guitarPart(),
        // comes in a whole bar late, and would have numbered its own first bar 1 on its own
        bassPart({
          notes: [
            { id: 'b0', startSec: 2.0, endSec: 2.4, midi: 40 },
            { id: 'b1', startSec: 2.5, endSec: 2.9, midi: 43 }
          ]
        })
      ],
      TWO_BARS,
      settings({ title: 'Late Entry', instrument: 'guitar6', tuningMidi: GUITAR })
    );
    const [top, bottom] = result.parts.map((p) => p.ir);
    expect(bottom.bars).toHaveLength(top.bars.length);
    expect(bottom.bars.map((b) => [b.number, b.startTick, b.durTicks])).toEqual(
      top.bars.map((b) => [b.number, b.startTick, b.durTicks])
    );
    expect(bottom.timeSig).toEqual(top.timeSig);
    expect(bottom.tempo.displayBpm).toBe(top.tempo.displayBpm);
    // The bass really is silent for the first bar rather than starting there.
    const firstBarNotes = bottom.bars[0].voices[0].beats.filter((b) => !b.isRest);
    expect(firstBarNotes).toHaveLength(0);
  });

  it('shares one key signature — a score prints one, not N', () => {
    const result = buildMultiPartScore(
      [guitarPart(), bassPart()],
      TWO_BARS,
      settings({ title: 'Key', instrument: 'guitar6', tuningMidi: GUITAR })
    );
    const [top, bottom] = result.parts.map((p) => p.ir);
    expect(bottom.key.fifths).toBe(top.key.fifths);
    for (const bar of bottom.bars) expect(bar.keyFifths).toBe(top.key.fifths);
  });

  it('shares NOTHING else: a part engraves identically whatever is printed beneath it', () => {
    // The clock and the key are pinned from outside, so the two channels through which parts can
    // legitimately reach each other are closed. Anything left is interference.
    const shared = { externalGrid: { bpm: 120, timeSig: [4, 4] as [number, number] } };
    const set: BuildSettings = settings({ title: 'Isolated', instrument: 'guitar6', tuningMidi: GUITAR, keyFifths: 0 });
    const guitar = guitarPart();
    const solo = buildMultiPartScore([guitar], shared, set).toMusicXML();
    const withQuietBass = buildMultiPartScore([guitar, bassPart()], shared, set).toMusicXML();
    const withBusyBass = buildMultiPartScore(
      [
        guitar,
        bassPart({
          notes: playedNotes(
            Array.from({ length: 16 }, (_, i) => ({ beat: i * 0.25, midi: 28 + (i % 5) })),
            0.5,
            120
          ).map((note, i) => ({ ...note, id: `x${i}` }))
        })
      ],
      shared,
      set
    ).toMusicXML();

    expect(partBody(withQuietBass, 'P1')).toBe(partBody(solo, 'P1'));
    expect(partBody(withBusyBass, 'P1')).toBe(partBody(solo, 'P1'));
    // ...and the busy bass really did change ITS part, so the comparison above is not vacuous.
    expect(partBody(withBusyBass, 'P2')).not.toBe(partBody(withQuietBass, 'P2'));
  });

  it('keeps the live part fretted and gives an imported part a plain notation staff', () => {
    const result = buildMultiPartScore(
      [guitarPart(), bassPart()],
      TWO_BARS,
      settings({ title: 'Tab', instrument: 'guitar6', tuningMidi: GUITAR })
    );
    const [top, bottom] = result.parts.map((p) => p.ir);
    expect(top.instrument.stringCount).toBe(6);
    // The bass tuning from the shared settings must NOT leak onto a part that did not ask for an
    // instrument: that is how an imported part grows a tablature staff nobody wanted.
    expect(bottom.instrument.kind).toBe('staff');
    expect(bottom.instrument.stringCount).toBe(0);
    const xml = result.toMusicXML();
    expect(partBody(xml, 'P1')).toContain('<sign>TAB</sign>');
    expect(partBody(xml, 'P2')).not.toContain('<sign>TAB</sign>');
    // ...but tab is not hard-blocked: name an instrument and an imported part gets one.
    const fretted = buildMultiPartScore(
      [guitarPart(), bassPart({ instrument: 'bass4' })],
      TWO_BARS,
      settings({ title: 'Tab', instrument: 'guitar6', tuningMidi: GUITAR })
    );
    expect(fretted.parts[1].ir.instrument.stringCount).toBe(4);
    expect(partBody(fretted.toMusicXML(), 'P2')).toContain('<sign>TAB</sign>');
  });

  it('scopes the §8.3 octave rule to each part, so one may transpose and another may not', () => {
    // The guard used to read the WHOLE document: a neighbour's <transpose> looked like this
    // part's, and a mixed score could not be written at all.
    const result = buildMultiPartScore(
      [guitarPart({ octaveTransposition: 'conventional' }), bassPart()],
      TWO_BARS,
      settings({ title: 'Octaves', instrument: 'guitar6', tuningMidi: GUITAR })
    );
    const xml = result.toMusicXML();
    expect(readMusicXml(xml, 0).hasTranspose).toBe(true);
    expect(readMusicXml(xml, 1).hasTranspose).toBe(false);
    expect(readMusicXml(xml, 0).hasClefOctaveChange).toBe(false);
  });

  it('lets each part choose its own clef from its own pitches', () => {
    const result = buildMultiPartScore(
      [guitarPart(), bassPart()],
      TWO_BARS,
      settings({ title: 'Clefs', instrument: 'guitar6', tuningMidi: GUITAR })
    );
    expect(result.parts[0].ir.bars[0].clef.sign).toBe('G');
    expect(result.parts[1].ir.bars[0].clef.sign).toBe('F');
  });
});

describe('MULTI-PART — every part carries its OWN instrument profile', () => {
  /** Frets in printed order, so one part's fingering can be compared across two builds. */
  const frets = (ir: { bars: { voices: { beats: { notes: { fret?: number }[] }[] }[] }[] }): number[] =>
    ir.bars.flatMap((bar) =>
      bar.voices.flatMap((v) => v.beats.flatMap((b) => b.notes.map((n) => n.fret ?? -1)))
    );

  /** A live bass under an imported guitar, each fretted, each asking for its own tablature. */
  const twoTabbedParts = (over: Partial<BuildSettings> = {}, guitarOver: Partial<ScorePart> = {}) =>
    buildMultiPartScore(
      [
        bassPart({ role: 'live' }),
        guitarPart({ role: 'imported', tab: 'two-staves', ...guitarOver })
      ],
      TWO_BARS,
      settings({ title: 'Two Fretboards', ...over })
    );

  it('prints BOTH parts a tablature staff — a live bass and an imported guitar with its own tab', () => {
    const result = twoTabbedParts();
    // The IR is where the decision lives: it is not an emit-time flag on top of a part built
    // without one, which is how `ir.tab` and the page came to disagree.
    expect(result.parts.map((p) => p.ir.instrument.kind)).toEqual(['bass4', 'guitar6']);
    expect(result.parts.map((p) => p.ir.instrument.stringCount)).toEqual([4, 6]);
    expect(result.parts.every((p) => p.ir.tab === undefined)).toBe(true);
    expect(result.parts.flatMap((p) => p.notices)).toEqual([]);

    const xml = result.toMusicXML();
    expect(partBody(xml, 'P1')).toContain('<sign>TAB</sign>');
    expect(partBody(xml, 'P2')).toContain('<sign>TAB</sign>');
    expect(readMusicXml(xml, 0).staffTuning).toHaveLength(4);
    expect(readMusicXml(xml, 1).staffTuning).toHaveLength(6);
    // Two staves each — notation over tablature — and the two parts still share the bar list.
    expect(readMusicXml(xml, 0).measureLengths).toEqual(readMusicXml(xml, 1).measureLengths);

    const data = result.toAlphaTabModelData();
    expect(data.tracks.map((t) => t.staves.some((s) => s.showTablature))).toEqual([true, true]);
    expect(data.tracks.map((t) => t.staves[0].tuningsHighToLow.length)).toEqual([4, 6]);
    // ...and the imported one is still engraved-only, tab or no tab.
    expect(data.tracks[1].notationOnly).toBe(true);
  });

  it("the live take's Tab Off cannot erase an imported part's tablature", () => {
    // `tab: 'omit'` in the SHARED settings is how webcore expresses the live Tab switch. It used
    // to be spread into every part's build, so switching the live staff's tab off silently took
    // the imported guitar's tab with it.
    const result = twoTabbedParts({ tab: 'omit' });
    expect(result.parts[0].ir.tab).toBe('omit');
    expect(result.parts[1].ir.tab).toBeUndefined();
    const xml = result.toMusicXML();
    expect(partBody(xml, 'P1')).not.toContain('<sign>TAB</sign>');
    expect(partBody(xml, 'P2')).toContain('<sign>TAB</sign>');
    const data = result.toAlphaTabModelData();
    expect(data.tracks.map((t) => t.staves.some((s) => s.showTablature))).toEqual([false, true]);
  });

  it("one part's tab:'omit' hides that part only, and the IR says so too", () => {
    const result = twoTabbedParts({}, { tab: 'omit' });
    expect(result.parts[0].ir.tab).toBeUndefined();
    // THE BUILD KNOWS. Forwarding `tab` to the emitters alone left this undefined, so every IR
    // reader believed the guitar still had a tablature staff the document does not contain.
    expect(result.parts[1].ir.tab).toBe('omit');
    const xml = result.toMusicXML();
    expect(partBody(xml, 'P1')).toContain('<sign>TAB</sign>');
    expect(partBody(xml, 'P2')).not.toContain('<sign>TAB</sign>');
    expect(result.toAlphaTabModelData().tracks.map((t) => t.staves.some((s) => s.showTablature))).toEqual([
      true,
      false
    ]);
    // Hiding the tab is not a change of instrument: the guitar keeps its six strings (X1).
    expect(result.parts[1].ir.instrument.stringCount).toBe(6);
  });

  it('keeps capo, fret limit and fingering inside the part that asked for them', () => {
    const result = twoTabbedParts({ capo: 3, maxFret: 5 }, { capo: 7, maxFret: 19 });
    expect(result.parts[0].ir.instrument.capo).toBe(3);
    expect(result.parts[1].ir.instrument.capo).toBe(7);
    const data = result.toAlphaTabModelData();
    expect(data.tracks.map((t) => t.staves[t.staves.length - 1].capo)).toEqual([3, 7]);

    // A part with its own instrument does not inherit the live take's fretboard at all: the same
    // shared capo/fret limit, with nothing declared on the guitar, leaves the guitar unchanged.
    const bare = twoTabbedParts({ capo: 3, maxFret: 5 }, {});
    expect(bare.parts[0].ir.instrument.capo).toBe(3);
    expect(bare.parts[1].ir.instrument.capo).toBe(0);
    expect(frets(bare.parts[1].ir)).toEqual(frets(twoTabbedParts().parts[1].ir));
  });

  it("one part's fingering style cannot re-finger another part", () => {
    const low = twoTabbedParts({ fingeringStyle: 'low' });
    const anchored = twoTabbedParts({ fingeringStyle: 'aroundFret', anchorFret: 12 });
    // The live bass follows the shared settings and really does move...
    expect(frets(anchored.parts[0].ir)).not.toEqual(frets(low.parts[0].ir));
    // ...while the imported guitar, which brought its own instrument, does not.
    expect(frets(anchored.parts[1].ir)).toEqual(frets(low.parts[1].ir));
    // ...and it moves when ITS OWN style is set.
    const guitarAnchored = twoTabbedParts({}, { fingeringStyle: 'aroundFret', anchorFret: 12 });
    expect(frets(guitarAnchored.parts[1].ir)).not.toEqual(frets(low.parts[1].ir));
    expect(frets(guitarAnchored.parts[0].ir)).toEqual(frets(low.parts[0].ir));
  });

  it('folds octaveTransposition into the build, so the IR and both emitters agree', () => {
    const result = twoTabbedParts({}, { octaveTransposition: 'conventional' });
    // +12: the staff reads an octave above what sounds. The bass never asked, so it keeps none.
    expect(result.parts[1].ir.displayPitchOffset).toBe(12);
    expect(result.parts[0].ir.displayPitchOffset).toBeUndefined();
    const xml = result.toMusicXML();
    expect(readMusicXml(xml, 1).hasTranspose).toBe(true);
    expect(readMusicXml(xml, 0).hasTranspose).toBe(false);
    const data = result.toAlphaTabModelData();
    expect(data.tracks[1].staves[0].displayTranspositionPitch).toBe(-12);

    const atPitch = twoTabbedParts({}, { octaveTransposition: 'none' });
    expect(atPitch.parts[1].ir.displayPitchOffset).toBe(0);
    expect(atPitch.toAlphaTabModelData().tracks[1].staves[0].displayTranspositionPitch).toBe(0);
  });

  it('REPORTS a tab staff asked for on a part with no fretboard, and engraves the score anyway', () => {
    const result = buildMultiPartScore(
      [guitarPart(), bassPart({ tab: 'two-staves' })],
      TWO_BARS,
      settings({ title: 'No Fretboard', instrument: 'guitar6', tuningMidi: GUITAR })
    );
    expect(result.parts[0].notices).toEqual([]);
    expect(result.parts[1].notices).toHaveLength(1);
    expect(result.parts[1].notices[0]).toMatch(/tablature requested/);
    expect(result.parts[1].notices[0]).toMatch(/no fretted profile/);
    // The same sentence reaches the channel a surface already prints.
    expect(result.parts[1].ir.diagnostics).toContain(result.parts[1].notices[0]);
    // ...and the document is a document: notation for the part that cannot have tab, tab for the
    // part that can. Nothing threw.
    const xml = result.toMusicXML();
    expect(partBody(xml, 'P1')).toContain('<sign>TAB</sign>');
    expect(partBody(xml, 'P2')).not.toContain('<sign>TAB</sign>');
    expect(readMusicXml(xml, 1).notes.filter((n) => !n.isRest)).toHaveLength(4);
  });
});

describe('MULTI-PART — the nudge', () => {
  const soloNote = (over: Partial<InputNote> = {}): InputNote => ({
    id: 'a',
    startSec: 0,
    endSec: 0.4,
    midi: 60,
    ...over
  });

  const firstOnset = (part: { ir: { bars: { voices: { beats: { isRest: boolean; startTick: number }[] }[] }[] } }): number => {
    for (const bar of part.ir.bars) {
      for (const v of bar.voices) {
        for (const b of v.beats) if (!b.isRest) return b.startTick;
      }
    }
    return -1;
  };

  it('moves a played part by the offset, before quantization', () => {
    const shared = { externalGrid: { bpm: 120, timeSig: [4, 4] as [number, number] } };
    const set = settings({ title: 'Nudge' });
    const anchor: ScorePart = { name: 'Anchor', notes: [soloNote({ id: 'z', midi: 48, endSec: 1.9 })] };
    const still = buildMultiPartScore([anchor, { name: 'B', notes: [soloNote()] }], shared, set);
    // half a second at 120 BPM is exactly one quarter note = 24 ticks
    const moved = buildMultiPartScore([anchor, { name: 'B', notes: [soloNote()], nudgeSec: 0.5 }], shared, set);
    expect(firstOnset(still.parts[1])).toBe(0);
    expect(firstOnset(moved.parts[1])).toBe(24);
    expect(moved.parts[1].nudgeSec).toBe(0.5);
    // the part it was nudged against did not move
    expect(firstOnset(moved.parts[0])).toBe(firstOnset(still.parts[0]));
  });

  it('moves an imported part that carries its own written ticks, in ticks', () => {
    const shared = { externalGrid: { bpm: 120, timeSig: [4, 4] as [number, number] } };
    const set = settings({ title: 'Nudge exact' });
    const imported = (nudgeSec: number): ScorePart => ({
      name: 'Imported',
      role: 'imported',
      nudgeSec,
      notes: [
        soloNote({ id: 'i0', sourceTiming: { startTick: 0, endTick: 480, ppq: 480 } }),
        soloNote({ id: 'i1', startSec: 0.5, endSec: 0.9, midi: 62, sourceTiming: { startTick: 480, endTick: 960, ppq: 480 } })
      ]
    });
    const anchor: ScorePart = { name: 'Anchor', notes: [soloNote({ id: 'z', midi: 48, endSec: 1.9 })] };
    const still = buildMultiPartScore([anchor, imported(0)], shared, set);
    const moved = buildMultiPartScore([anchor, imported(0.5)], shared, set);
    expect(firstOnset(still.parts[1])).toBe(0);
    expect(firstOnset(moved.parts[1])).toBe(24);
    // A NUDGE IS A TRANSLATION, NOT A STRETCH: the gap between the part's own notes is untouched.
    const onsets = (result: typeof still): number[] =>
      result.parts[1].ir.bars.flatMap((bar) =>
        bar.voices.flatMap((v) => v.beats.filter((b) => !b.isRest).map((b) => bar.startTick + b.startTick))
      );
    const stillGaps = onsets(still).slice(1).map((t, i) => t - onsets(still)[i]);
    const movedGaps = onsets(moved).slice(1).map((t, i) => t - onsets(moved)[i]);
    expect(movedGaps).toEqual(stillGaps);
  });
});

describe('MULTI-PART — an imported part arrives the way score import already produces one', () => {
  /** Four quarters at 480 ppq, the shape a MusicXML/MIDI import attaches today. */
  const symbolicBass = (): ScorePart => ({
    name: 'Bass',
    role: 'imported',
    notes: [0, 1, 2, 3].map((i) => ({
      id: `s${i}`,
      startSec: i * 0.5,
      endSec: i * 0.5 + 0.45,
      midi: [40, 43, 45, 40][i],
      sourceTiming: { startTick: i * 480, endTick: (i + 1) * 480, ppq: 480 },
      sourceClef: 'bass' as const,
      ...(i === 0
        ? {
            sourceBars: [
              { startTick: 0, durationTicks: 1920, ppq: 480, timeSig: [4, 4] as [number, number], number: 1, implicit: false },
              { startTick: 1920, durationTicks: 1920, ppq: 480, timeSig: [4, 4] as [number, number], number: 2, implicit: false }
            ]
          }
        : {})
    }))
  });

  it('keeps the imported part on its exact written ticks while the live take is quantized', () => {
    const result = buildMultiPartScore(
      [guitarPart(), symbolicBass()],
      TWO_BARS,
      settings({ title: 'Import', instrument: 'guitar6', tuningMidi: GUITAR })
    );
    const [top, bottom] = result.parts.map((p) => p.ir);
    expect(bottom.quantized).toBe(false);
    expect(top.quantized).toBe(true);
    // 480 source ticks per quarter -> 24 IR ticks per quarter, on the barline exactly.
    const onsets = bottom.bars.flatMap((bar) =>
      bar.voices.flatMap((v) => v.beats.filter((b) => !b.isRest).map((b) => bar.startTick + b.startTick))
    );
    expect(onsets).toEqual([0, 24, 48, 72]);
    expect(bottom.bars[0].clef.sign).toBe('F');
  });

  it("applies the import's bar map to the WHOLE score, so one part cannot own the barlines", () => {
    const result = buildMultiPartScore(
      [guitarPart(), symbolicBass()],
      TWO_BARS,
      settings({ title: 'Import bars', instrument: 'guitar6', tuningMidi: GUITAR })
    );
    const [top, bottom] = result.parts.map((p) => p.ir);
    expect(top.bars.map((b) => [b.number, b.startTick, b.durTicks])).toEqual(
      bottom.bars.map((b) => [b.number, b.startTick, b.durTicks])
    );
    expect(top.bars.map((b) => b.number)).toEqual([1, 2]);
    // ...and the document it produces is still one balanced score.
    const xml = result.toMusicXML();
    expect(readMusicXml(xml, 0).measureLengths).toEqual(readMusicXml(xml, 1).measureLengths);
  });
});

describe('MULTI-PART — bar alignment', () => {
  it('pads through the public API when one part really does run longer', () => {
    // The live take rings on past the last barline the shared clock laid down, which is the one
    // way a part can still come out with more bars than its neighbours.
    const result = buildMultiPartScore(
      [
        {
          name: 'Long',
          notes: [{ id: 'L', startSec: 0, endSec: 0.4, midi: 60, sourceTiming: { startTick: 0, endTick: 3840, ppq: 480 } }]
        },
        { name: 'Short', notes: [{ id: 'S', startSec: 0, endSec: 0.4, midi: 48 }] }
      ],
      { externalGrid: { bpm: 120, timeSig: [4, 4] } },
      settings({ title: 'Ragged' })
    );
    const [long, short] = result.parts.map((p) => p.ir);
    expect(long.bars.length).toBeGreaterThan(1);
    expect(short.bars).toHaveLength(long.bars.length);
    const last = short.bars[short.bars.length - 1];
    expect(last.voices[0].beats.every((b) => b.isRest)).toBe(true);
    const xml = result.toMusicXML();
    expect(readMusicXml(xml, 1).measureLengths).toEqual(readMusicXml(xml, 0).measureLengths);
  });

  it('pads a short part with whole-bar rests rather than leaving the document ragged', () => {
    // Built WITHOUT a shared clock on purpose, so the two really do disagree about bar count and
    // the alignment pass has something to do.
    const long = buildScore(
      { ...grid(3, 4, 120), notes: playedNotes(Array.from({ length: 12 }, (_, i) => ({ beat: i, midi: 40 })), 0.9, 120) },
      settings({ title: 'Long' })
    ).ir;
    const short = buildScore(
      { ...grid(1, 4, 120), notes: playedNotes([{ beat: 0, midi: 45 }], 0.9, 120) },
      settings({ title: 'Short' })
    ).ir;
    expect(short.bars.length).toBeLessThan(long.bars.length);

    alignPartBars([long, short]);
    expect(short.bars).toHaveLength(long.bars.length);
    expect(short.bars.map((b) => [b.number, b.startTick, b.durTicks])).toEqual(
      long.bars.map((b) => [b.number, b.startTick, b.durTicks])
    );
    const padded = short.bars[short.bars.length - 1];
    expect(padded.voices[0].beats).toHaveLength(1);
    expect(padded.voices[0].beats[0].measureRest).toBe(true);
    expect(padded.voices[0].beats[0].durTicks).toBe(padded.durTicks);
    expect(padded.keyChanged).toBe(false);
    expect(padded.clef.changed).toBe(false);

    // The padded part still emits: the measure cursor and tuplet assertions run on every bar.
    const xml = toMultiPartMusicXML([{ ir: long }, { ir: short }]);
    const bottom = readMusicXml(xml, 1);
    expect(bottom.measureLengths).toEqual(readMusicXml(xml, 0).measureLengths);
  });

  it('refuses to paper over a broken clock', () => {
    const four = buildScore(
      { ...grid(2, 4, 120), notes: playedNotes([{ beat: 0, midi: 40 }, { beat: 4, midi: 43 }], 0.9, 120) },
      settings({ title: 'Four' })
    ).ir;
    const three = buildScore(
      { ...grid(2, 3, 120), notes: playedNotes([{ beat: 0, midi: 40 }, { beat: 3, midi: 43 }], 0.9, 120) },
      settings({ title: 'Three', timeSigOverride: [3, 4] })
    ).ir;
    expect(() => alignPartBars([four, three])).toThrow(/shared clock is broken/);
  });
});

describe('MULTI-PART — limits', () => {
  const one = (midi: number): ScorePart => ({ notes: [{ startSec: 0, endSec: 0.4, midi }] });

  it('takes up to four parts', () => {
    const result = buildMultiPartScore(
      [one(60), one(55), one(48), one(40)],
      TWO_BARS,
      settings({ title: 'Quartet' })
    );
    expect(result.parts).toHaveLength(MAX_PARTS);
    expect(readMusicXml(result.toMusicXML()).partCount).toBe(4);
    expect(result.toAlphaTabModelData().tracks).toHaveLength(4);
    expect(bytes(result.toMidi(true)).slice(10, 12)).toEqual([0, 5]);
  });

  it('refuses a fifth part and an empty score', () => {
    expect(() => buildMultiPartScore([one(60), one(55), one(48), one(40), one(36)], TWO_BARS, settings())).toThrow(
      /at most 4 parts/
    );
    expect(() => buildMultiPartScore([], TWO_BARS, settings())).toThrow(/at least one part/);
  });
});
