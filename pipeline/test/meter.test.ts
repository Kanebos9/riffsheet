import { describe, it, expect } from 'vitest';
import { R } from '../src/rational.js';
import { buildBarMetric, depthAt, durationCount, glyphFor, nextBeatAfter, toDurationList, tupletWrittenLen } from '../src/meter.js';

const FOUR_FOUR = buildBarMetric(4, 4);
const THREE_FOUR = buildBarMetric(3, 4);
const SIX_EIGHT = buildBarMetric(6, 8, true);

const strs = (rs: ReturnType<typeof toDurationList>): string[] => rs.map((r) => r.toString());

describe('metricDivisionsOfBar', () => {
  it('4/4 subdivides /2 then /4 — the "additional central accent"', () => {
    expect(FOUR_FOUR.divLengths.slice(0, 4).map((r) => r.toString())).toEqual(['1/1', '1/2', '1/4', '1/8']);
    expect(FOUR_FOUR.beatLen.toString()).toBe('1/4');
  });

  it('3/4 subdivides /3', () => {
    expect(THREE_FOUR.divLengths.slice(0, 3).map((r) => r.toString())).toEqual(['3/4', '1/4', '1/8']);
  });

  it('6/8 gets the dotted beat then /3', () => {
    expect(SIX_EIGHT.beatLen.toString()).toBe('3/8');
    expect(SIX_EIGHT.divLengths.slice(0, 3).map((r) => r.toString())).toEqual(['3/4', '3/8', '1/8']);
  });

  it('metric depth: bar start strongest, offbeats weakest', () => {
    expect(depthAt(FOUR_FOUR, R(0, 1))).toBe(0);
    expect(depthAt(FOUR_FOUR, R(1, 2))).toBe(1); // beat 3
    expect(depthAt(FOUR_FOUR, R(1, 4))).toBe(2); // beat 2
    expect(depthAt(FOUR_FOUR, R(3, 4))).toBe(2); // beat 4
    expect(depthAt(FOUR_FOUR, R(1, 8))).toBe(3); // "and of 1"
    expect(depthAt(FOUR_FOUR, R(1, 16))).toBe(4); // "e of 1"
  });

  it('nextBeatAfter is the growth cap rule 3 of the endTime clamp', () => {
    expect(nextBeatAfter(FOUR_FOUR, R(0, 1)).toString()).toBe('1/4');
    expect(nextBeatAfter(FOUR_FOUR, R(1, 8)).toString()).toBe('1/4');
    expect(nextBeatAfter(FOUR_FOUR, R(3, 4)).toString()).toBe('1/1');
  });
});

describe('toDurationList — THE note/rest tol asymmetry (tol=1 vs tol=0)', () => {
  it('a syncopated quarter NOTE on the "and of 1" stays one glyph', () => {
    expect(strs(toDurationList(FOUR_FOUR, R(1, 8), R(1, 4), 'note'))).toEqual(['1/4']);
  });

  it('the SAME span as a REST splits at the beat — the engraving error the old code shipped', () => {
    // §3.2: "a 960-tick gap starting on the 'and of 1' becomes a single quarter rest
    // straddling beat 2 — a plain engraving error."
    expect(strs(toDurationList(FOUR_FOUR, R(1, 8), R(1, 4), 'rest'))).toEqual(['1/8', '1/8']);
  });

  it('a half NOTE on beat 2 crosses the middle of the bar; a half REST does not', () => {
    expect(strs(toDurationList(FOUR_FOUR, R(1, 4), R(1, 2), 'note'))).toEqual(['1/2']);
    expect(strs(toDurationList(FOUR_FOUR, R(1, 4), R(1, 2), 'rest'))).toEqual(['1/4', '1/4']);
  });

  it('rests that ARE metrically legal stay whole', () => {
    expect(strs(toDurationList(FOUR_FOUR, R(0, 1), R(1, 1), 'rest'))).toEqual(['1/1']);
    expect(strs(toDurationList(FOUR_FOUR, R(0, 1), R(1, 2), 'rest'))).toEqual(['1/2']);
    expect(strs(toDurationList(FOUR_FOUR, R(1, 2), R(1, 4), 'rest'))).toEqual(['1/4']);
  });

  it('a dotted-quarter NOTE from beat 1 stays whole; the rest splits', () => {
    expect(strs(toDurationList(FOUR_FOUR, R(0, 1), R(3, 8), 'note'))).toEqual(['3/8']);
    expect(strs(toDurationList(FOUR_FOUR, R(0, 1), R(3, 8), 'rest'))).toEqual(['1/4', '1/8']);
  });

  it('triple meter: a 2/3-bar span at the bar start always splits', () => {
    expect(strs(toDurationList(THREE_FOUR, R(0, 1), R(1, 2), 'note'))).toEqual(['1/4', '1/4']);
  });

  it('never produces a rest shorter than an eighth', () => {
    // An eighth-long gap starting on the second sixteenth would split tol=0 into two 16th
    // rests; the vocabulary cap merges it back.
    const pieces = toDurationList(FOUR_FOUR, R(1, 16), R(1, 8), 'rest');
    for (const p of pieces) expect(p.gte(R(1, 8))).toBe(true);
  });

  it('never emits more than one dot', () => {
    for (const g of [R(7, 16), R(7, 8), R(15, 16)]) {
      for (const piece of toDurationList(FOUR_FOUR, R(0, 1), g, 'note')) {
        const found = glyphFor(piece);
        if (found) expect(found.dots).toBeLessThanOrEqual(1);
      }
    }
  });

  it('every produced piece is printable', () => {
    for (let startTick = 0; startTick < 48; startTick += 3) {
      for (let lenTick = 3; startTick + lenTick <= 48; lenTick += 3) {
        for (const kind of ['note', 'rest'] as const) {
          const pieces = toDurationList(FOUR_FOUR, R(startTick, 48), R(lenTick, 48), kind);
          const sum = pieces.reduce((a, b) => a.add(b), R(0, 1));
          expect(sum.eq(R(lenTick, 48))).toBe(true);
          for (const p of pieces) expect(glyphFor(p)).toBeTruthy();
        }
      }
    }
  });
});

describe('durationCount — a dotted value counts 1.5', () => {
  it('counts glyphs the way lengthenNote scores them', () => {
    expect(durationCount([R(1, 4)])).toBe(1);
    expect(durationCount([R(3, 8)])).toBe(1.5);
    expect(durationCount([R(1, 4), R(1, 8)])).toBe(2);
  });
});

describe('tuplet written lengths', () => {
  it('an eighth-triplet unit is written as an eighth', () => {
    expect(tupletWrittenLen(R(1, 4), 1, 2).toString()).toBe('1/8');
    expect(tupletWrittenLen(R(1, 4), 2, 2).toString()).toBe('1/4');
    expect(tupletWrittenLen(R(1, 4), 3, 2).toString()).toBe('3/8');
  });
  it('a sixteenth-triplet (sextuplet) unit is written as a sixteenth', () => {
    expect(tupletWrittenLen(R(1, 4), 1, 4).toString()).toBe('1/16');
  });
});
