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
    expect(R(1, 4).toTicksExact(DIVISIONS)).toBe(12); // quarter
    expect(R(1, 8).toTicksExact(DIVISIONS)).toBe(6); // eighth
    expect(R(1, 16).toTicksExact(DIVISIONS)).toBe(3); // sixteenth
    expect(R(3, 8).toTicksExact(DIVISIONS)).toBe(18); // dotted quarter / compound beat
    expect(R(1, 12).toTicksExact(DIVISIONS)).toBe(4); // eighth-note triplet
    expect(R(1, 24).toTicksExact(DIVISIONS)).toBe(2); // sixteenth-note triplet
    expect(() => R(1, 32).toTicksExact(DIVISIONS)).toThrow('not representable');
  });

  it('names the documented constants', () => {
    expect(MIN_REST.toString()).toBe('1/8');
    expect(MIN_DIVISION.toString()).toBe('1/64');
  });
});

describe('divisions = 12 covers the v1 inventory exactly', () => {
  // The dossier flagged a possible need for divisions=24. This test settles it: everything v1
  // emits is an exact integer at 12 per quarter, and the two things that are NOT representable
  // are both outside the v1 vocabulary.
  const REPRESENTABLE: [string, Rational][] = [
    ['whole', R(1, 1)],
    ['dotted half', R(3, 4)],
    ['half', R(1, 2)],
    ['dotted quarter', R(3, 8)],
    ['quarter', R(1, 4)],
    ['dotted eighth', R(3, 16)],
    ['eighth', R(1, 8)],
    ['16th', R(1, 16)],
    ['quarter-note triplet unit', R(1, 6)],
    ['eighth-note triplet unit', R(1, 12)],
    ['16th-note triplet unit', R(1, 24)]
  ];
  for (const [name, len] of REPRESENTABLE) {
    it(`${name} is exact at divisions=12`, () => {
      expect(Number.isInteger(len.toTicksExact(DIVISIONS))).toBe(true);
    });
  }

  it('32nds and dotted 16ths are NOT representable — and are outside the v1 vocabulary', () => {
    expect(() => R(1, 32).toTicksExact(DIVISIONS)).toThrow();
    expect(() => R(3, 32).toTicksExact(DIVISIONS)).toThrow();
    // Raising DIVISIONS to 24 is the single-constant change that unlocks them.
    expect(R(1, 32).toTicksExact(24)).toBe(3);
    expect(R(3, 32).toTicksExact(24)).toBe(9);
  });
});
