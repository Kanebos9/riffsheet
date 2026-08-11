import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { GOLDEN_CASES } from './goldenCases.js';
import { readMusicXml } from './xmlReader.js';
import straightEighths from './golden/straight-eighths.js';
import externalGrid from './golden/external-grid.js';
import pickup from './golden/pickup.js';

const EXPECTED: Record<string, string> = {
  'straight-eighths': straightEighths,
  'external-grid': externalGrid,
  pickup
};

describe('GOLDEN FILES — notes + beats in, MusicXML out', () => {
  for (const testCase of GOLDEN_CASES) {
    it(`${testCase.name} matches its committed fixture`, () => {
      const actual = buildScore(testCase.input, testCase.settings).toMusicXML();
      const expected = EXPECTED[testCase.name];
      if (actual !== expected) {
        // Point at the first differing line rather than dumping 300 lines of XML.
        const a = actual.split('\n');
        const b = expected.split('\n');
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        throw new Error(
          `golden "${testCase.name}" diverges at line ${i + 1}\n` +
            `  expected: ${b[i] ?? '<eof>'}\n` +
            `  actual:   ${a[i] ?? '<eof>'}\n` +
            `  (regenerate deliberately with scripts/update-golden.sh ${testCase.name})`
        );
      }
      expect(actual).toBe(expected);
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

  it('all three round-trip through the reader with balanced measures', () => {
    for (const [name, xml] of Object.entries(EXPECTED)) {
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
