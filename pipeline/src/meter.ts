/**
 * STATION 2a — METER: `metricDivisionsOfBar` + `toDurationList`.
 *
 * PORTED (re-implemented in TypeScript from the documented behaviour and constants of)
 * MuseScore 4 `src/importexport/midi/internal/midiimport/importmidi_meter.cpp`, GPL-3.0-only.
 * Described in midi-to-notation-research.md §1.4 and §3.1 rule 4. See ATTRIBUTIONS.md.
 *
 * WHAT THIS FILE IS FOR. Deciding *that* a rest exists is station 2b's job (simplify.ts).
 * This file decides how a span — note or rest — is CUT INTO GLYPHS, and it is where the
 * single most important asymmetry in the whole rest problem lives:
 *
 *     const int tol = (durationType == DurationType::NOTE) ? 1 : 0;
 *
 * Notes may cross one metric level to avoid a tie; rests may never merge across any level.
 * That one line is why MuseScore's rests are correctly fragmented while its notes stay whole.
 *
 * Everything is exact rational arithmetic over fractions of a WHOLE NOTE. The level tests are
 * `pos % divLength == 0` and they are only meaningful when exact (§8.5).
 */

import { Rational, R, MIN_DIVISION, MIN_REST } from './rational.js';
import type { DurationType } from './ir.js';

export type DurationKind = 'note' | 'rest';

export interface Glyph {
  len: Rational;
  type: DurationType;
  dots: 0 | 1;
}

/**
 * The printable vocabulary at divisions=24 per quarter, LONGEST FIRST.
 *
 * Single dots only (`maxDots = 1`, §1.4). The bottom two entries are new at divisions=24:
 * a dotted 16th (9 ticks) and a 32nd (3 ticks) were 4.5 and 1.5 ticks at the old resolution,
 * so neither was representable and neither could be in the vocabulary. FiloBass's 46,281 human
 * glyphs contain only 0.009% 32nds and ZERO 32nd rests (§0.1), so this is not a licence to
 * print them freely — `MIN_REST` still keeps every rest at an eighth or longer, and the
 * quantizer only offers a 1/32 lattice when the caller asks for `grid: 'thirtysecond'`.
 * What changed is that a 32nd is now sayable at all, instead of being rounded into a glyph
 * whose printed <type> disagreed with its own <duration>.
 */
export const VOCABULARY: Glyph[] = [
  { len: R(1, 1), type: 'whole', dots: 0 },
  { len: R(3, 4), type: 'half', dots: 1 },
  { len: R(1, 2), type: 'half', dots: 0 },
  { len: R(3, 8), type: 'quarter', dots: 1 },
  { len: R(1, 4), type: 'quarter', dots: 0 },
  { len: R(3, 16), type: 'eighth', dots: 1 },
  { len: R(1, 8), type: 'eighth', dots: 0 },
  { len: R(3, 32), type: '16th', dots: 1 },
  { len: R(1, 16), type: '16th', dots: 0 },
  { len: R(1, 32), type: '32nd', dots: 0 }
];

export function glyphFor(len: Rational): Glyph | null {
  for (const g of VOCABULARY) if (g.len.eq(len)) return g;
  return null;
}

/**
 * `MidiDuration::durationCount`: a dotted duration counts as 1.5 glyphs.
 *
 * PUBLIC API ONLY. Its one internal caller was the deleted lengthening search, which scored
 * candidate off-times by glyph count. Kept exported because "how many symbols does this span
 * cost?" is the question any engraving decision above this module asks.
 */
export function durationCount(list: Rational[]): number {
  let n = 0;
  for (const len of list) {
    const g = glyphFor(len);
    n += g && g.dots ? 1.5 : 1;
  }
  return n;
}

export interface BarMetric {
  /** Bar length as a fraction of a whole note. */
  barLen: Rational;
  num: number;
  den: number;
  compound: boolean;
  /** Descending division lengths; index = metric depth (0 = whole bar, larger = weaker). */
  divLengths: Rational[];
  /** `Meter::beatLength(barFraction)`: the beat of the meter, dotted in compound time. */
  beatLen: Rational;
  /** Bar-relative positions of every beat boundary, ascending, including 0 and barLen. */
  beatPositions: Rational[];
}

/**
 * `metricDivisionsOfBar`. Duple -> /2; triple -> /3; quadruple -> /2 then /4 (the "additional
 * central accent"); compound -> the dotted beat, then /3. Then keep halving down to
 * `minAllowedDuration * 2` = 1/64.
 */
export function buildBarMetric(num: number, den: number, compound = false): BarMetric {
  const barLen = R(num, den);
  const divLengths: Rational[] = [barLen];
  const push = (r: Rational): void => {
    if (r.isPositive() && !divLengths.some((x) => x.eq(r))) divLengths.push(r);
  };

  let beatLen: Rational;
  if (compound && num % 3 === 0) {
    beatLen = R(3, den);
    const beatsInBar = num / 3;
    if (beatsInBar >= 2) push(barLen.scale(1, beatsInBar));
    push(beatLen);
    push(beatLen.scale(1, 3)); // the eighth inside the dotted beat
  } else {
    beatLen = R(1, den);
    if (num % 4 === 0) {
      push(barLen.scale(1, 2));
      push(barLen.scale(1, 4));
    } else if (num % 3 === 0) {
      push(barLen.scale(1, 3));
    } else if (num % 2 === 0) {
      push(barLen.scale(1, 2));
    }
    push(beatLen);
  }

  let last = divLengths[divLengths.length - 1];
  while (last.gt(MIN_DIVISION)) {
    last = last.scale(1, 2);
    divLengths.push(last);
  }

  const beatPositions: Rational[] = [];
  for (let p = Rational.ZERO; p.lte(barLen); p = p.add(beatLen)) beatPositions.push(p);
  if (!beatPositions[beatPositions.length - 1].eq(barLen)) beatPositions.push(barLen);

  return { barLen, num, den, compound, divLengths, beatLen, beatPositions };
}

/** Metric depth of a bar-relative position: 0 = bar boundary, larger = weaker. */
export function depthAt(m: BarMetric, pos: Rational): number {
  for (let i = 0; i < m.divLengths.length; i++) {
    if (pos.isMultipleOf(m.divLengths[i])) return i;
  }
  return m.divLengths.length;
}

/**
 * The strongest metric boundary strictly inside (s, e); earliest wins on a tie.
 * `minSide`, when given, additionally requires both halves to be at least that long — the
 * mechanism behind the "no rest shorter than an eighth" vocabulary cap.
 */
function strongestInterior(m: BarMetric, s: Rational, e: Rational, minSide?: Rational): Rational | null {
  for (let i = 0; i < m.divLengths.length; i++) {
    const dl = m.divLengths[i];
    const from = s.floorDiv(dl) + 1;
    const to = e.floorDiv(dl);
    for (let k = from; k <= to; k++) {
      const p = dl.scale(k);
      if (!p.gt(s) || !p.lt(e)) continue;
      if (minSide && (p.sub(s).lt(minSide) || e.sub(p).lt(minSide))) continue;
      return p;
    }
  }
  return null;
}

/**
 * Next beat boundary strictly after `pos` (bar end if none). PUBLIC API ONLY — it was rule 3 of
 * the deleted lengthening pass's endTime clamp, and is kept because it is the natural way for a
 * caller to ask "where does this beat end?" without rebuilding the metric tree.
 */
export function nextBeatAfter(m: BarMetric, pos: Rational): Rational {
  for (const b of m.beatPositions) if (b.gt(pos)) return b;
  return m.barLen;
}

interface SplitOptions {
  kind: DurationKind;
  useDots: boolean;
}

/**
 * `Meter::toDurationList`. Split [start, start+len) into printable glyphs.
 *
 * `badLevelCondition(a, b, tol) -> a > tol || b > tol`: a span may stay whole only when both
 * of its endpoints are at least as strong as the interior accent it crosses, relaxed by `tol`
 * metric levels. tol = 1 for notes, 0 for rests.
 */
export function toDurationList(
  m: BarMetric,
  start: Rational,
  len: Rational,
  kind: DurationKind,
  useDots = true
): Rational[] {
  if (!len.isPositive()) return [];
  const opts: SplitOptions = { kind, useDots };
  return splitSpan(m, start, start.add(len), opts);
}

/**
 * VOCABULARY CAP (§3.1 rule 4): never print a rest shorter than an eighth — zero of FiloBass's
 * 274 human rests are. Enforced by CONSTRAINING THE SPLIT rather than by merging afterwards:
 * a boundary that would leave a sub-eighth fragment is skipped in favour of the next-strongest
 * boundary that does not. Merging after the fact produces values like 5/16 that no glyph can
 * print; constraining the split keeps every piece both printable and metrically placed.
 */
function splitSpan(m: BarMetric, s: Rational, e: Rational, opts: SplitOptions): Rational[] {
  const len = e.sub(s);
  if (!len.isPositive()) return [];

  const isRest = opts.kind === 'rest';
  const tol = isRest ? 0 : 1;
  const minSide = isRest ? MIN_REST : undefined;
  const glyph = glyphFor(len);
  const printable = !!glyph && (glyph.dots === 0 || opts.useDots);

  // The level test uses the strongest interior accent, constrained or not — a rest is only
  // "crossing" an accent it could legally have split at.
  const interior = strongestInterior(m, s, e, minSide);

  if (printable) {
    if (!interior) return [len];
    const dm = depthAt(m, interior);
    const ds = depthAt(m, s);
    const de = depthAt(m, e);
    if (ds <= dm + tol && de <= dm + tol && !hardSplitOverride(m, s, e, opts.kind)) {
      return [len];
    }
  }

  if (!interior) return printable ? [len] : greedyDecompose(len, minSide);
  return [...splitSpan(m, s, interior, opts), ...splitSpan(m, interior, e, opts)];
}

/**
 * The two conventions §1.4 records as overriding the level test. BOTH ARE REST RULES, and that
 * qualifier is load-bearing — see below.
 *  (a) a 2/3-bar REST at bar start or bar end in TRIPLE meter always splits;
 *  (b) the last 2/3 of a beat in COMPOUND meter, when it is a REST, splits into two rests.
 *
 * WHY (a) IS REST-ONLY. Gould, *Behind Bars* p.161: "In 3/4 use two crotchet rests, not a minim
 * rest" — the half rest is banned in triple meter because it hides the third beat. The half
 * NOTE is not: beats 1-2 and beats 2-3 of a 3/4 bar are written as a half note by every
 * publisher (any waltz shows both). Applying (a) to notes as well printed a 3/4 half note as
 * two tied quarters, which is the largest-legal-symbol bug this rule used to cause — and it was
 * self-evidently a bug even without the textbook, because the SAME half note starting an eighth
 * later (off the barline, so the override missed it) came out as one half note.
 */
function hardSplitOverride(m: BarMetric, s: Rational, e: Rational, kind: DurationKind): boolean {
  const len = e.sub(s);
  if (kind === 'rest' && !m.compound && m.num % 3 === 0 && m.num > 1) {
    const twoThirds = m.barLen.scale(2, 3);
    if (len.eq(twoThirds) && (s.isZero() || e.eq(m.barLen))) return true;
  }
  if (m.compound && kind === 'rest') {
    const twoThirdsBeat = m.beatLen.scale(2, 3);
    const offsetInBeat = s.mod(m.beatLen);
    if (len.eq(twoThirdsBeat) && offsetInBeat.eq(m.beatLen.scale(1, 3))) return true;
  }
  return false;
}

/**
 * SIMPLEST SYMBOL COMBINATION for a span — `grid: 'free'`'s engraving rule (issue #36).
 *
 * `toDurationList` answers a different question: "where must this span be cut so the reader can
 * still see the beat?". That is the right question for metrical music and the wrong one for a
 * free view, where the whole promise is that the page shows what was played and nothing more.
 * Asking the metric rulebook for a free span produced maximal-precision tie chains — a quarter
 * tied to a leftover fragment, over and over — which reads as a restruck note to anyone who is
 * not counting tie arcs.
 *
 * So free asks for the FEWEST GLYPHS that add up exactly, longest-first inside a tie. The span
 * is already a multiple of a 1/32 (the quantizer guarantees it), so an exact answer always
 * exists and no glyph ever has to lie about its length.
 */
export function simplestDurationList(len: Rational): Rational[] {
  if (!len.isPositive()) return [];
  if (glyphFor(len)) return [len];
  return greedyDecompose(len);
}

/**
 * Minimum-count decomposition over the printable vocabulary, optionally restricted to values
 * at or above `minPiece`. Only reachable for a span with no usable interior boundary — a
 * greedy largest-first walk is not enough there (5/16 needs 3/16 + 1/8, which greedy misses).
 */
function greedyDecompose(len: Rational, minPiece?: Rational): Rational[] {
  const allowed = VOCABULARY.filter((g) => !minPiece || g.len.gte(minPiece)).map((g) => g.len);
  const exact = minCountDecomposition(len, allowed);
  if (exact) return exact;
  const any = minCountDecomposition(len, VOCABULARY.map((g) => g.len));
  if (any) return any;
  // Un-notatable remainder: emit it verbatim and let the caller count it as a defect.
  const out: Rational[] = [];
  let left = len;
  for (const g of VOCABULARY) {
    while (left.gte(g.len)) {
      out.push(g.len);
      left = left.sub(g.len);
    }
  }
  if (left.isPositive()) out.push(left);
  return out;
}

/** Exact min-count change-making over rational values; longest-first inside a tie. */
function minCountDecomposition(len: Rational, values: Rational[]): Rational[] | null {
  if (!len.isPositive()) return [];
  const best = new Map<string, Rational[] | null>();
  const solve = (rem: Rational, depth: number): Rational[] | null => {
    if (rem.isZero()) return [];
    if (!rem.isPositive() || depth > 8) return null;
    const key = rem.toString();
    if (best.has(key)) return best.get(key)!;
    best.set(key, null); // cycle guard
    let found: Rational[] | null = null;
    for (const v of values) {
      if (v.gt(rem)) continue;
      const tail = solve(rem.sub(v), depth + 1);
      if (tail && (!found || tail.length + 1 < found.length)) found = [v, ...tail];
    }
    best.set(key, found);
    return found;
  };
  return solve(len, 0);
}

// ---- tuplets -------------------------------------------------------------------------------
//
// A duration may never silently cross a tuplet edge (MuseScore uses a sentinel
// TUPLET_BOUNDARY_LEVEL = 10 for this). We get the same guarantee structurally: a tuplet group
// is laid out in its own unit domain and never handed to `toDurationList`.

/**
 * Written glyph length of `units` tuplet units in a 3:2 group.
 * actual = units x (beat/3); written = actual x 3/2. For a quarter-note beat that is
 * 1 unit -> eighth, 2 units -> quarter, 3 units -> dotted quarter.
 */
export function tupletWrittenLen(beatLen: Rational, units: number, normal = 2): Rational {
  // actual = units x (beatLen/actualCount); written = actual x (actualCount/normal)
  //        = beatLen x units / normal.
  return beatLen.scale(units, normal);
}

export function tupletActualLen(beatLen: Rational, units: number, actual = 3): Rational {
  return beatLen.scale(units, actual);
}

/**
 * HOW MANY GLYPHS A `units`-UNIT SPAN INSIDE A GROUP COSTS, in reading order — the tuplet
 * domain's answer to `toDurationList`.
 *
 * A span inside a group used to be one glyph however long it was, on the reading that a tuplet
 * unit count always has a written value. Most do: at 3:2 over a quarter beat, 1, 2 and 3 units
 * are an eighth, a quarter and a dotted quarter. FIVE units of a sextuplet are not — the written
 * value is 5/16 of a whole note, which no symbol names — so `typeOf` fell back to the nearest
 * thing it could name and the beat shipped a `<type>` contradicting its own `<duration>`.
 *
 * So the span is cut into unit counts that ARE sayable, longest first, and the caller ties them
 * exactly as it ties a metric split. Every count is reachable: one unit is printable by
 * construction (quantize.ts refuses a group whose unit has no written value), so the worst case
 * is a run of single units.
 */
export function tupletUnitPieces(beatLen: Rational, units: number, normal: number): number[] {
  if (units <= 0) return [];
  const best: (number[] | null)[] = [[]];
  for (let n = 1; n <= units; n++) {
    let found: number[] | null = null;
    // Descending, so the longest printable value wins a tie on glyph count.
    for (let take = n; take >= 1; take--) {
      if (!glyphFor(tupletWrittenLen(beatLen, take, normal))) continue;
      const rest = best[n - take];
      if (rest && (!found || rest.length + 1 < found.length)) found = [take, ...rest];
    }
    best.push(found);
  }
  return best[units] ?? [units];
}
