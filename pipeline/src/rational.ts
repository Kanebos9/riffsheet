/**
 * Exact rational arithmetic for metric math.
 *
 * WRITTEN (not ported). Equivalent in role to MuseScore's `ReducedFraction`
 * (`importmidi_fraction.cpp`), which every tolerance in the research docs is expressed
 * against. midi-semantics-research.md §8.5 and midi-to-notation-research.md §2(b) both make
 * this non-negotiable: "the metric-level tests depend on exactness
 * (`ratio.numerator() % ratio.denominator() == 0`). Use a small rational class in TS, not floats."
 *
 * CONVENTION: a Rational used as a musical length is a fraction **of a whole note**, exactly
 * as MuseScore does it. `Rational.of(1, 4)` is a quarter note. This is what makes
 * "1/64 whole note", "1/128 note", "min rest = 1/8" read literally in the code.
 *
 * No float ever enters a metric decision. `toNumber()` exists only for reporting, ratios
 * against user-facing tolerances and seconds<->beats interpolation, and
 * every call site that uses it is commented.
 */

function gcd(a: number, b: number): number {
  a = a < 0 ? -a : a;
  b = b < 0 ? -b : b;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** Guard rail matching MuseScore's `reduceLimit = 10000`: denominators never explode. */
const REDUCE_LIMIT = 1000000;

export class Rational {
  readonly n: number;
  readonly d: number;

  private constructor(n: number, d: number) {
    this.n = n;
    this.d = d;
  }

  static of(n: number, d = 1): Rational {
    if (d === 0) throw new Error('Rational: zero denominator');
    if (!Number.isInteger(n) || !Number.isInteger(d)) {
      throw new Error(`Rational: non-integer input ${n}/${d}`);
    }
    let sn = n;
    let sd = d;
    if (sd < 0) {
      sn = -sn;
      sd = -sd;
    }
    if (sn === 0) return new Rational(0, 1);
    const g = gcd(sn, sd);
    sn /= g;
    sd /= g;
    if (sd > REDUCE_LIMIT) throw new Error(`Rational: denominator overflow ${sn}/${sd}`);
    return new Rational(sn, sd);
  }

  static readonly ZERO = Rational.of(0, 1);
  static readonly ONE = Rational.of(1, 1);

  add(o: Rational): Rational {
    return Rational.of(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Rational): Rational {
    return Rational.of(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Rational): Rational {
    return Rational.of(this.n * o.n, this.d * o.d);
  }
  div(o: Rational): Rational {
    if (o.n === 0) throw new Error('Rational: divide by zero');
    return Rational.of(this.n * o.d, this.d * o.n);
  }
  /** Scale by an integer ratio without leaving exact arithmetic. */
  scale(num: number, den = 1): Rational {
    return Rational.of(this.n * num, this.d * den);
  }
  neg(): Rational {
    return Rational.of(-this.n, this.d);
  }
  abs(): Rational {
    return this.n < 0 ? this.neg() : this;
  }

  cmp(o: Rational): number {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  lt(o: Rational): boolean {
    return this.cmp(o) < 0;
  }
  lte(o: Rational): boolean {
    return this.cmp(o) <= 0;
  }
  gt(o: Rational): boolean {
    return this.cmp(o) > 0;
  }
  gte(o: Rational): boolean {
    return this.cmp(o) >= 0;
  }
  eq(o: Rational): boolean {
    return this.n === o.n && this.d === o.d;
  }

  isZero(): boolean {
    return this.n === 0;
  }
  isPositive(): boolean {
    return this.n > 0;
  }

  /**
   * Exact divisibility: `this` is an integer multiple of `unit`.
   * This is the primitive the metric-level tests are built on — the single reason floats
   * are banned from this file's callers.
   */
  isMultipleOf(unit: Rational): boolean {
    if (unit.n === 0) return this.n === 0;
    const q = this.div(unit);
    return q.d === 1;
  }

  /** How many whole `unit`s fit in `this` (floor, exact). */
  floorDiv(unit: Rational): number {
    const q = this.div(unit);
    return Math.floor(q.n / q.d);
  }

  /** `this` reduced modulo `unit`, exact. */
  mod(unit: Rational): Rational {
    if (unit.n === 0) return this;
    const k = this.floorDiv(unit);
    return this.sub(unit.scale(k));
  }

  min(o: Rational): Rational {
    return this.lte(o) ? this : o;
  }
  max(o: Rational): Rational {
    return this.gte(o) ? this : o;
  }

  /** Reporting / interpolation only. Never call this inside a metric decision. */
  toNumber(): number {
    return this.n / this.d;
  }

  toString(): string {
    return `${this.n}/${this.d}`;
  }

  /** Exact tick value; throws if the length is not representable at this resolution. */
  toTicksExact(divisionsPerQuarter: number): number {
    const t = this.scale(4 * divisionsPerQuarter);
    if (t.d !== 1) {
      throw new Error(
        `Rational ${this.toString()} is not representable at divisions=${divisionsPerQuarter}`
      );
    }
    return t.n;
  }

  /** Nearest tick value (rounds half away from zero). For seconds-domain input only. */
  toTicksRounded(divisionsPerQuarter: number): number {
    const t = this.scale(4 * divisionsPerQuarter);
    return Math.round(t.n / t.d);
  }

  static fromTicks(ticks: number, divisionsPerQuarter: number): Rational {
    return Rational.of(ticks, 4 * divisionsPerQuarter);
  }
}

export const R = Rational.of;

// ---- the musical constants the research docs name, as exact fractions of a whole note ------

/** MuseScore `MChord::minAllowedDuration()` = division/32 = a 1/128 note. */
export const MIN_ALLOWED_DURATION = R(1, 128);
/** The floor everything else stops at: `minAllowedDuration * 2` = 1/64. */
export const MIN_DIVISION = R(1, 64);
/** midi-to-notation-research.md §0.1: FiloBass humans never wrote a rest shorter than this. */
export const MIN_REST = R(1, 8);
/** MuseScore chord window, human coefficient: 1/64 of a whole note (§4.2). */
export const CHORD_WINDOW_FRACTION = R(1, 64);
