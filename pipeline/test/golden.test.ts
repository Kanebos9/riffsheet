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
  it('straight-eighths: sixteen eighths at a 60% gate print as eighths, no rests', () => {
    const read = readMusicXml(straightEighths);
    const staff1 = read.notes.filter((n) => n.staff === 1);
    expect(staff1.filter((n) => n.isRest)).toHaveLength(0);
    expect(staff1.filter((n) => !n.isRest)).toHaveLength(16);
    for (const n of staff1) expect(n.type).toBe('eighth');
    // and the beams group by beat: two eighths per beam group in 4/4
    expect(straightEighths).toContain('<beam number="1">begin</beam>');
    expect(straightEighths).toContain('<beam number="1">end</beam>');
  });

  it('external-grid: the host BPM wins over the (deliberately wrong) detected beats', () => {
    const read = readMusicXml(externalGrid);
    expect(read.tempo).toBe(100);
    expect(read.divisions).toBe(12);
    expect(read.timeSig).toEqual([4, 4]);
    // eight quarter notes across two bars, despite a mid-score tempo change to 80 BPM
    const staff1 = read.notes.filter((n) => n.staff === 1 && !n.isRest);
    expect(staff1).toHaveLength(8);
    for (const n of staff1) expect(n.type).toBe('quarter');
    for (const m of read.measureLengths) expect(m.length).toBe(48);
  });

  it('pickup: startOffsetSec produces measure 0, implicit, one beat long', () => {
    const read = readMusicXml(pickup);
    expect(read.measureLengths[0]).toEqual({ number: 0, implicit: true, length: 12 });
    expect(read.measureLengths[1].number).toBe(1);
    expect(read.measureLengths[1].length).toBe(48);
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
      for (const n of read.notes) {
        if (!n.isRest) expect(n.type, `${name}: every pitched note needs a <type>`).not.toBe('');
        else expect(n.duration, `${name}: no rest shorter than an eighth`).toBeGreaterThanOrEqual(6);
      }
    }
  });
});
