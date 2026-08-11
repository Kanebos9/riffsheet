import { describe, it, expect } from 'vitest';
import { Rational, R, MIN_REST, MIN_DIVISION } from '../src/rational.js';
import { DIVISIONS } from '../src/ir.js';

describe('Rational — exact metric arithmetic', () => {
  it('reduces on construction and normalises sign', () => {
    expect(R(2, 4).toString()).toBe('1/2');
    expect(R(-3, -6).toString()).toBe('1/2');
    expect(R(3, -6).toString()).toBe('-1/2');
    expect(R(0, 5).toString()).toBe('0/1');
  });

  it('adds thirds and quarters without drift — the thing floats cannot do', () => {
    // 1/3 + 1/3 + 1/3 === 1 exactly. In floats this is 0.9999999999999998.
    const third = R(1, 3);
    expect(third.add(third).add(third).eq(Rational.ONE)).toBe(true);
    expect(0.1 + 0.2 === 0.3).toBe(false); // the reason this class exists
    expect(R(1, 10).add(R(2, 10)).eq(R(3, 10))).toBe(true);
  });

  it('isMultipleOf is the primitive the metric-level tests depend on', () => {
    expect(R(3, 8).isMultipleOf(R(1, 8))).toBe(true);
    expect(R(3, 8).isMultipleOf(R(1, 4))).toBe(false);
    expect(R(1, 2).isMultipleOf(R(1, 4))).toBe(true);
    expect(Rational.ZERO.isMultipleOf(R(1, 64))).toBe(true);
    // a triplet position is never on a straight grid
    expect(R(1, 12).isMultipleOf(R(1, 16))).toBe(false);
  });

  it('mod and floorDiv are exact', () => {
    expect(R(7, 8).mod(R(1, 4)).toString()).toBe('1/8');
    expect(R(7, 8).floorDiv(R(1, 4))).toBe(3);
    expect(R(1, 1).floorDiv(R(1, 4))).toBe(4);
  });

  it('converts to ticks exactly, and refuses what it cannot represent', () => {
    expect(R(1, 4).toTicksExact(DIVISIONS)).toBe(24); // quarter
    expect(R(1, 8).toTicksExact(DIVISIONS)).toBe(12); // eighth
    expect(R(1, 16).toTicksExact(DIVISIONS)).toBe(6); // sixteenth
    expect(R(1, 32).toTicksExact(DIVISIONS)).toBe(3); // thirty-second
    expect(R(3, 8).toTicksExact(DIVISIONS)).toBe(36); // dotted quarter / compound beat
    expect(R(1, 12).toTicksExact(DIVISIONS)).toBe(8); // eighth-note triplet
    expect(R(1, 24).toTicksExact(DIVISIONS)).toBe(4); // sixteenth-note triplet
    expect(() => R(1, 64).toTicksExact(DIVISIONS)).toThrow('not representable');
  });

  it('names the documented constants', () => {
    expect(MIN_REST.toString()).toBe('1/8');
    expect(MIN_DIVISION.toString()).toBe('1/64');
  });
});

describe('divisions = 24 covers the inventory exactly', () => {
  // This block used to assert divisions=12 and record that 32nds and dotted 16ths were the two
  // values it could not say ("raising DIVISIONS to 24 is the single-constant change that unlocks
  // them"). Issue #35 took that change, so both are now first-class — and the whole triplet
  // ladder had to survive it, which is the real content of the test: 24 = 12 x 2 is still
  // divisible by 3.
  const REPRESENTABLE: [string, Rational][] = [
    ['whole', R(1, 1)],
    ['dotted half', R(3, 4)],
    ['half', R(1, 2)],
    ['dotted quarter', R(3, 8)],
    ['quarter', R(1, 4)],
    ['dotted eighth', R(3, 16)],
    ['eighth', R(1, 8)],
    ['dotted 16th', R(3, 32)],
    ['16th', R(1, 16)],
    ['32nd', R(1, 32)],
    ['quarter-note triplet unit', R(1, 6)],
    ['eighth-note triplet unit', R(1, 12)],
    ['16th-note triplet unit', R(1, 24)]
  ];
  for (const [name, len] of REPRESENTABLE) {
    it(`${name} is exact at divisions=24`, () => {
      expect(Number.isInteger(len.toTicksExact(DIVISIONS))).toBe(true);
    });
  }

  it('32nds and dotted 16ths are representable at 24, and were not at 12', () => {
    expect(DIVISIONS).toBe(24);
    expect(R(1, 32).toTicksExact(DIVISIONS)).toBe(3);
    expect(R(3, 32).toTicksExact(DIVISIONS)).toBe(9);
    // The resolution this replaced could not say either value at all.
    expect(() => R(1, 32).toTicksExact(12)).toThrow();
    expect(() => R(3, 32).toTicksExact(12)).toThrow();
  });

  it('doubling the resolution did not cost the triplets — every unit is still an integer', () => {
    expect(R(1, 12).toTicksExact(DIVISIONS)).toBe(8); // eighth-note triplet
    expect(R(1, 24).toTicksExact(DIVISIONS)).toBe(4); // 16th-note triplet
    expect(R(1, 6).toTicksExact(DIVISIONS)).toBe(16); // quarter-note triplet
    expect(DIVISIONS % 3).toBe(0);
  });

  it('a 64th is still out of reach — the vocabulary stops where the research does', () => {
    expect(() => R(1, 64).toTicksExact(DIVISIONS)).toThrow();
  });
});
