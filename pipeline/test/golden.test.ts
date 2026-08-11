import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { buildMultiPartScore } from '../src/multipart.js';
import { GOLDEN_CASES, MULTI_PART_GOLDEN_CASES } from './goldenCases.js';
import { readMusicXml } from './xmlReader.js';
import straightEighths from './golden/straight-eighths.js';
import externalGrid from './golden/external-grid.js';
import pickup from './golden/pickup.js';
import twoPart from './golden/two-part.js';
import twoPartAlphaTab from './golden/two-part-alphatab.js';

const EXPECTED: Record<string, string> = {
  'straight-eighths': straightEighths,
  'external-grid': externalGrid,
  pickup,
  'two-part': twoPart,
  'two-part-alphatab': twoPartAlphaTab
};

/** Point at the first differing line rather than dumping the whole fixture. */
function assertMatches(name: string, actual: string, expected: string): void {
  if (actual !== expected) {
    const a = actual.split('\n');
    const b = expected.split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    throw new Error(
      `golden "${name}" diverges at line ${i + 1}\n` +
        `  expected: ${b[i] ?? '<eof>'}\n` +
        `  actual:   ${a[i] ?? '<eof>'}\n` +
        `  (regenerate deliberately with scripts/update-golden.sh ${name})`
    );
  }
  expect(actual).toBe(expected);
}

describe('GOLDEN FILES — notes + beats in, MusicXML out', () => {
  for (const testCase of GOLDEN_CASES) {
    it(`${testCase.name} matches its committed fixture`, () => {
      assertMatches(testCase.name, buildScore(testCase.input, testCase.settings).toMusicXML(), EXPECTED[testCase.name]);
    });
  }
});

describe('GOLDEN FILES — two parts in, one document out', () => {
  for (const testCase of MULTI_PART_GOLDEN_CASES) {
    it(`${testCase.name} matches its committed fixture`, () => {
      const built = buildMultiPartScore(testCase.parts, testCase.input, testCase.settings);
      const actual =
        testCase.emit === 'alphatab'
          ? JSON.stringify(built.toAlphaTabModelData(), null, 1)
          : built.toMusicXML();
      assertMatches(testCase.name, actual, EXPECTED[testCase.name]);
    });
  }
});

describe('GOLDEN FILES — what each one pins', () => {
  it('straight-eighths: sixteen eighths at a 60% GATE print at the length they were gated to', () => {
    // THIS ASSERTION WAS INVERTED WITH THE REST KILLER. It used to read "print as eighths, no
    // rests", because the lengthening pass pushed every off-time forward to the next onset. The
    // fixture plays each eighth for 60% of its slot, i.e. a sixteenth, so a sixteenth followed
    // by a sixteenth rest is what was played and what is now printed.
    const read = readMusicXml(straightEighths);
    const staff1 = read.notes.filter((n) => n.staff === 1);
    expect(staff1.filter((n) => !n.isRest)).toHaveLength(16);
    expect(staff1.filter((n) => n.isRest)).toHaveLength(15);
    for (const n of staff1.slice(0, 30)) expect(n.type).toBe('16th');
    // A sixteenth with a rest on either side has nothing to beam to: it keeps its flag.
    expect(straightEighths).not.toContain('<beam');
  });

  it('external-grid: the host BPM wins over the (deliberately wrong) detected beats', () => {
    const read = readMusicXml(externalGrid);
    expect(read.tempo).toBe(100);
    expect(read.divisions).toBe(24);
    expect(read.timeSig).toEqual([4, 4]);
    // eight notes across two bars, despite a mid-score tempo change to 80 BPM. Each is played
    // for 75% of its beat, so each is a dotted eighth plus a sixteenth of measured silence.
    const staff1 = read.notes.filter((n) => n.staff === 1 && !n.isRest);
    expect(staff1).toHaveLength(8);
    for (const n of staff1) expect(n.type).toBe('eighth');
    for (const n of staff1) expect(n.duration).toBe(18);
    for (const m of read.measureLengths) expect(m.length).toBe(96);
  });

  it('pickup: startOffsetSec produces measure 0, implicit, one beat long', () => {
    const read = readMusicXml(pickup);
    expect(read.measureLengths[0]).toEqual({ number: 0, implicit: true, length: 24 });
    expect(read.measureLengths[1].number).toBe(1);
    expect(read.measureLengths[1].length).toBe(96);
    expect(read.measureLengths[1].implicit).toBe(false);
    // the anacrusis note itself survived
    const inPickup = read.notes.filter((n) => n.measure === 0 && n.staff === 1 && !n.isRest);
    expect(inPickup).toHaveLength(1);
    expect(inPickup[0].midi).toBe(47);
  });

  it('two-part: a guitar over a bass, one clock, one key, two independent engravings', () => {
    const read = readMusicXml(twoPart);
    expect(read.partCount).toBe(2);
    expect(read.partList.map((p) => p.name)).toEqual(['Guitar', 'Bass']);
    expect(read.partList.map((p) => p.channel)).toEqual([1, 2]);

    // TOP PART: the live take. Two staves — notation over its own tablature — and its own beams.
    const top = readMusicXml(twoPart, 0);
    expect(top.measureLengths.map((m) => m.length)).toEqual([96, 96]);
    expect(top.notes.filter((n) => n.staff === 1 && !n.isRest)).toHaveLength(16);
    expect(top.staffTuning).toHaveLength(6);

    // BOTTOM PART: imported, notation only. One staff, its own bass clef, no tablature.
    const bottom = readMusicXml(twoPart, 1);
    expect(bottom.measureLengths.map((m) => m.length)).toEqual([96, 96]);
    expect(bottom.staffTuning).toHaveLength(0);
    expect(bottom.notes.filter((n) => !n.isRest)).toHaveLength(4);
    // The bar it did not play in is a whole-bar rest at the same measure number, not a short bar.
    const secondBar = bottom.notes.filter((n) => n.measure === 2);
    expect(secondBar).toHaveLength(1);
    expect(secondBar[0].isRest).toBe(true);
    expect(secondBar[0].duration).toBe(96);
    // ONE CLOCK, ONE KEY: the two parts agree bar for bar.
    expect(bottom.measureLengths).toEqual(top.measureLengths);
    expect(bottom.fifths).toBe(top.fifths);
  });

  it('two-part-alphatab: two tracks against one master-bar list, the imported one flagged', () => {
    const data = JSON.parse(twoPartAlphaTab) as ReturnType<
      ReturnType<typeof buildMultiPartScore>['toAlphaTabModelData']
    >;
    expect(data.tracks).toHaveLength(2);
    expect(data.masterBars).toHaveLength(2);
    expect(data.tracks[0].staves[0].showTablature).toBe(true);
    expect(data.tracks[0].notationOnly).toBeUndefined();
    expect(data.tracks[1].staves).toHaveLength(1);
    expect(data.tracks[1].staves[0].showTablature).toBe(false);
    expect(data.tracks[1].notationOnly).toBe(true);
    for (const track of data.tracks) {
      for (const staff of track.staves) expect(staff.bars).toHaveLength(data.masterBars.length);
    }
    // The two emitters were fed the same build, so they must agree about the same notes.
    const xmlNotes = readMusicXml(twoPart, 1).notes.filter((n) => !n.isRest).map((n) => n.midi);
    const atNotes = data.tracks[1].staves[0].bars.flatMap((bar) =>
      bar.voices.flatMap((v) => v.beats.flatMap((b) => b.notes.map((n) => n.midi)))
    );
    expect(atNotes).toEqual(xmlNotes);
  });

  it('every MusicXML golden round-trips through the reader with balanced measures', () => {
    for (const [name, xml] of Object.entries(EXPECTED)) {
      if (name === 'two-part-alphatab') continue;
      const read = readMusicXml(xml);
      expect(read.hasTranspose, name).toBe(false);
      expect(read.hasClefOctaveChange, name).toBe(false);
      const printable = new Set([3, 6, 9, 12, 18, 24, 36, 48]);
      for (const n of read.notes) {
        if (!n.isRest) expect(n.type, `${name}: every pitched note needs a <type>`).not.toBe('');
        else expect(printable.has(n.duration), `${name}: every rest is a printable value`).toBe(true);
      }
    }
  });
});
