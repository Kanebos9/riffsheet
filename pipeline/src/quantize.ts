/**
 * STATION 1b — ONSET PLACEMENT AND TUPLET DECISION.
 *
 * KEPT (ported forward) from the old app's `src/renderer/src/engine/quantize.ts`. The research
 * explicitly rules this the part worth keeping: "our own onset decoder in quantize.ts — the DP
 * with de-trending and strict tuplet admission is well-tuned for bass and arguably better than
 * MuseScore's for this instrument. Only the *duration* half is wrong."
 * (midi-to-notation-research.md §5, "Keep, do not replace".)
 *
 * What came across unchanged:
 *  - one rhythm state per occupied beat, chosen by a Viterbi with a state-change cost;
 *  - signed residuals DE-TRENDED against the rest of the take, so a groove that sits uniformly
 *    behind the grid competes on its shape, not its offset;
 *  - robust jitter = median + 1.4826 x MAD of the de-trended residuals, as the cost unit;
 *  - tuplet admission strictly harder than the DP objective.
 *
 * What changed, and why:
 *  - the state set is now straight-8, straight-16, straight-32 (opt-in only) and
 *    eighth-triplet. §6.4 of midi-semantics-research.md: 3-plets only in v1, confined to a
 *    single beat, and never 5/7/9-plets ("a bass riff essentially never contains a genuine
 *    septuplet, but sloppy playing produces septuplet-shaped evidence constantly").
 *  - tuplet admission gained §6.4's two extra gates: FULL COVERAGE (all three positions
 *    occupied — "this single rule kills most false triplets") and a 25% relative error margin
 *    ("a triplet must beat the straight reading, not tie it").
 *  - THE DURATION HALF IS GONE. `quantizeStraightDuration` — the 78%-rule that generated the
 *    spurious rests (§0.3, §4.2) — is deleted. Off-times now snap on the SAME grid as their
 *    onset (spec rule R4) and the decision about what to print belongs to simplify.ts.
 *  - AND "THE SAME GRID" MEANS IT (issue #31). The off-time used to keep a private halving
 *    ladder for notes shorter than the grid, which put attacks and releases on different
 *    lattices and printed eighth-note flags under a quarter-note grid. There is no escape
 *    hatch left: a grid is a ceiling on what the page may say, in both directions.
 */

import type { GridSetting } from './types.js';
import { DIVISIONS, THIRTYSECOND_TICKS } from './ir.js';

/**
 * `'exact'` is INTERNAL and never reachable from `BuildSettings.grid`. It is the symbolic-import
 * path: a MusicXML/MIDI source already carries written ticks, so there is nothing to decide and
 * the numbers are converted verbatim. It used to share the `'free'` arm, which is why free could
 * not be given honest notation semantics until the two were separated — a symbolic eighth-triplet
 * is 8 ticks, not a multiple of a 1/32, and snapping it would corrupt an exact import.
 */
export type QuantGrid = GridSetting | 'exact';

export interface QuantNote {
  id: string;
  /** Fractional tick from the time skeleton (per-bar origin already applied). */
  rawStartTick: number;
  rawOffTick: number;
  /** Explicit editor-authored onset in IR ticks; only this note bypasses onset snapping. */
  fixedStartTick?: number;
  /**
   * THE WRITTEN LENGTH THE CALLER DECLARED for this event, in IR ticks — the resolved form of
   * `InputNote.notationIntent` (see ir.ts `notationIntentTicks`). Absent on every note a detector
   * produced, which is why nothing below changes shape when it is not there.
   *
   * A duration declaration says nothing about where the note sits. `fixedStartTick`, when present,
   * is the separate and explicit onset authority.
   */
  intentTicks?: number;
}

export interface QuantTupletGroup {
  id: string;
  startTick: number;
  endTick: number;
  unitTicks: number;
  actual: number;
  normal: number;
}

export interface QuantResult {
  notes: { id: string; startTick: number; offTick: number; tupletId?: string }[];
  tuplets: QuantTupletGroup[];
  /** The finest straight grid actually offered, in ticks — simplify.ts's `basicQuant`. */
  basicQuantTicks: number;
  /** Robust timing jitter of the take, in ticks. Diagnostic. */
  jitterTicks: number;
  /**
   * EVENTS THAT LOST A COLLISION, and the event id that kept the slot.
   *
   * The fusion below is the one place quantization removes an attack outright, and the removal
   * used to leave no trace at all: `notes` simply came back shorter than it went in. `intoId` is
   * the survivor AFTER the pitch pick, so it is the id whose chord the caller should follow — not
   * necessarily the earlier arrival.
   */
  fused: { id: string; intoId: string }[];
}

/**
 * A per-beat WHOLE-DIVISION hypothesis. The beat is divided into `division` equal parts and
 * every onset in the beat is scored against that lattice — never per-onset nearest-grid
 * rounding, which is measured to turn clean triplets into garbage and to collapse evenly
 * spaced 32nds onto coincident onsets.
 */
interface RhythmState {
  name: string;
  /** Parts the beat is divided into. */
  division: number;
  grid: number;
  tuplet: boolean;
  /** For a tuplet: the MusicXML <actual-notes>/<normal-notes> pair. */
  actual: number;
  normal: number;
  complexity: number;
}

/**
 * COMPLEXITY PENALTY, and it is not optional: removing it collapses agreement with human
 * transcribers from 59% to 4% (Cemgil, measured). Three independent systems converge on the
 * same ordering of division classes: 1 < 2 < 4 < 3 < 6 < 5 < 8.
 */
const COMPLEXITY: Record<number, number> = { 1: 0, 2: 0.05, 4: 0.1, 3: 1.0, 6: 1.2, 8: 1.5, 12: 1.7 };
const STATE_CHANGE_COST = 0.5;
const TUPLET_START_COST = 1;
const TREND_MIN_SUPPORT = 4;
/** §6.4 rule 2: a triplet must beat the straight reading by this relative margin. */
const TUPLET_ERROR_MARGIN = 0.25;
/** Largest power of two strictly below n — MusicXML's <normal-notes> for an n-tuplet. */
function normalFor(n: number): number {
  let p = 1;
  while (p * 2 < n) p *= 2;
  return p;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * TUPLET INVENTORY, v1: straight down to 16ths, eighth-triplets, sixteenth-triplets
 * (sextuplets). NO 5/7/9-plets and nothing nested — every production system excludes them, and
 * a bass riff essentially never contains a genuine septuplet while sloppy playing produces
 * septuplet-shaped evidence constantly.
 *
 * KNOWN LIMITATION (recorded in IR.md): quarter- and half-note triplets span more than one
 * beat and are out of scope for v1. They emerge as tied eighth-triplets, which is correct
 * arithmetic and slightly verbose notation.
 */
/**
 * A GRID NAME IS AN ABSOLUTE NOTE VALUE, NOT A FRACTION OF THE TRACKED BEAT.
 *
 * This used to be `ticksPerBeat / division`, which silently redefined every grid name by the
 * meter's denominator. In 3/8 the tracked beat is an EIGHTH, so `'1/8'`'s `straight-8` (half a
 * beat) was a SIXTEENTH and `'1/16'` reached a 32nd — the caller asked for eighths and the page
 * was allowed to print 16ths, off-times included, because `basicQuant` is read off the same
 * ladder. `'auto'` was worse: in x/8 meters it offered a 1/32 lattice, which the documented
 * policy says only `grid: 'thirtysecond'` may ever see.
 *
 * The ladder is therefore stated in ticks at `DIVISIONS` per quarter and is the same ladder in
 * every meter. In 4/4 and in compound meters, where the tracked beat is a quarter or a dotted
 * quarter, this reproduces the old state sets exactly.
 */
const QUARTER_TICKS = DIVISIONS;
const STRAIGHT_LADDER = [QUARTER_TICKS, QUARTER_TICKS / 2, QUARTER_TICKS / 4, QUARTER_TICKS / 8];

/** The FINEST absolute value each grid setting permits. Nothing shorter may be offered. */
const GRID_FLOOR_TICKS: Record<string, number> = {
  '1/4': QUARTER_TICKS,
  '1/8': QUARTER_TICKS / 2,
  '1/16': QUARTER_TICKS / 4,
  thirtysecond: QUARTER_TICKS / 8,
  // 'auto' offers straight values down to a 1/16 and no further (see the 1/32 note below).
  auto: QUARTER_TICKS / 4,
  // The triplet grid's finest STRAIGHT word is the eighth; the triplet itself is added below.
  '1/8T': QUARTER_TICKS / 2
};

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

/**
 * The span one rhythm decision covers. Normally the tracked beat — but a grid name COARSER than
 * the beat cannot be a whole division of it (a quarter inside a 3/8 eighth-beat), so the window
 * widens to the least common multiple and the quarter becomes expressible. Every meter whose
 * beat is at least as long as the requested value keeps a one-beat window, which is every case
 * that existed before this change.
 */
export function quantWindowTicks(grid: QuantGrid, ticksPerBeat: number): number {
  const floor = GRID_FLOOR_TICKS[grid];
  if (!floor || floor <= ticksPerBeat) return ticksPerBeat;
  return (ticksPerBeat * floor) / gcd(ticksPerBeat, floor);
}

function statesFor(
  grid: QuantGrid,
  ticksPerBeat: number,
  compound: boolean,
  windowTicks: number
): RhythmState[] {
  const out: RhythmState[] = [];
  const addLattice = (name: string, gridTicks: number, tuplet: boolean): void => {
    // Not representable in this window, or finer than notation's own floor.
    if (!(gridTicks >= 1) || !Number.isInteger(windowTicks / gridTicks)) return;
    if (out.some((state) => state.grid === gridTicks && state.tuplet === tuplet)) return;
    const division = windowTicks / gridTicks;
    const normal = tuplet ? normalFor(division) : 1;
    // A TUPLET UNIT HAS TO BE SAYABLE ON THE WRITTEN SIDE TOO. The glyph printed for one unit of
    // an actual:normal group is the sounding length scaled by actual/normal (`tupletWrittenLen`
    // in meter.ts), so its written value is `windowTicks / normal` ticks. The sounding floor is
    // checked above; without this one, a x/16 meter offered a sextuplet whose unit is ONE tick
    // and whose written value is a 1/64 — a value the vocabulary has no symbol for, so `typeOf`
    // fell back to the nearest thing it could name and the page claimed a 32nd for a 1-tick
    // glyph. A grid the engraver cannot spell is not a grid; it is never offered.
    if (tuplet) {
      const writtenUnitTicks = windowTicks / normal;
      if (!Number.isInteger(writtenUnitTicks) || writtenUnitTicks < THIRTYSECOND_TICKS) return;
    }
    out.push({
      name,
      division,
      grid: gridTicks,
      tuplet,
      actual: tuplet ? division : 1,
      normal,
      complexity: COMPLEXITY[division] ?? 2
    });
  };

  const floor = GRID_FLOOR_TICKS[grid] ?? QUARTER_TICKS / 4;
  // The tracked beat is always a legal lattice — it is the pulse the take is measured against —
  // unless it is FINER than the caller's grid, in which case offering it would let the page say
  // something shorter than the caller allowed. `1/4` collapses to the quarter on purpose.
  if (ticksPerBeat >= floor) addLattice('beat', ticksPerBeat, false);
  for (const ticks of STRAIGHT_LADDER) {
    // 1/32 IS OPT-IN, never offered by 'auto'. FiloBass's 46,281 human glyphs are 0.009% 32nds
    // (§0.1); handing the Viterbi a 1/32 lattice by default buys nothing and gives sloppy playing
    // somewhere finer to hide. The caller has to ask for it by name — which the floor enforces.
    if (ticks < floor) continue;
    addLattice(`straight-${QUARTER_TICKS * 4 / ticks}`, ticks, false);
  }
  out.sort((a, b) => b.grid - a.grid);

  // A compound beat is a dotted value and its natural divisions are 3 and 6; the straight ladder
  // above already supplies the eighth and the sixteenth inside it. No tuplet states: a triplet
  // inside a dotted beat is the beat's ordinary subdivision, not a tuplet.
  if (compound) return out;
  // Tuplets are defined against the TRACKED BEAT and are only meaningful when a decision covers
  // exactly one of them; a widened window (a grid coarser than the beat) never has any.
  if (windowTicks !== ticksPerBeat) return out;
  // '1/8T' IS THE TRIPLET GRID, NOT A TRIPLET-ONLY GRID. It used to withhold `straight-8`, on
  // the reading that a caller asking for triplets wants nothing else. That is not what it did.
  // The tuplet gates below are deliberately strict (all three positions occupied, a 25% margin
  // over the straight reading), so any beat they reject fell through to the ONLY other state
  // left — `beat`, a whole-beat lattice. A straight eighth then snapped a HALF BEAT onto its
  // neighbour's tick, where the collision fuse deleted one of the two attacks; a "two of three"
  // shuffle figure lost a note the same way. A grid setting chooses what the page may SAY, and
  // no setting is allowed to delete a note that was played.
  if (grid === 'auto' || grid === '1/8T') addLattice('triplet-8', ticksPerBeat / 3, true);
  if (grid === 'auto') addLattice('triplet-16', ticksPerBeat / 6, true);
  return out;
}

const snapTo = (tick: number, grid: number, origin = 0): number =>
  origin + Math.round((tick - origin) / grid) * grid;

interface BeatWindow {
  beat: number;
  origin: number;
  notes: QuantNote[];
  residuals: number[];
  signed: number[][];
  recentered: number[][];
  recenteredSum: number[];
}

/**
 * De-trend consistent displacement. A take played uniformly ahead of or behind the grid is an
 * offset, not noise; measuring it as jitter would veto the very reading it supports. Each
 * window is recentered by the median displacement of the REST of the take, so no window can
 * shift its own measurement frame.
 *
 * O(N log N), and it used to be quadratic in occupied beats: the complement was REBUILT for
 * every window ("for each window, concatenate every other window's residuals, then sort them"),
 * which is O(W x N log N) — a five-minute sixteenth-note import spent minutes here and a large
 * one exhausted memory rebuilding million-element arrays W times.
 *
 * The same numbers come out. All residuals are ranked once per state; a Fenwick tree over those
 * ranks then answers "median of everything except this window's values" by removing the window's
 * own entries, querying two order statistics and putting them back — exactly the leave-one-out
 * median the loop computed, including the even-length mean-of-two-middles rule.
 */
function recenterWindows(windows: BeatWindow[], stateCount: number): void {
  for (let s = 0; s < stateCount; s++) {
    const values: number[] = [];
    const windowOf: number[] = [];
    windows.forEach((w, wi) => {
      for (const v of w.signed[s]) {
        values.push(v);
        windowOf.push(wi);
      }
    });
    const n = values.length;
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
    const sorted = order.map((i) => values[i]);
    const rankOf = new Int32Array(n);
    order.forEach((valueIndex, rank) => {
      rankOf[valueIndex] = rank;
    });

    const tree = new Int32Array(n + 1);
    const add = (rank: number, delta: number): void => {
      for (let p = rank + 1; p <= n; p += p & -p) tree[p] += delta;
    };
    /** 0-based rank of the `k`-th smallest (k is 1-based) among the entries currently present. */
    const kth = (k: number): number => {
      let pos = 0;
      let rest = k;
      let step = 1;
      while (step * 2 <= n) step *= 2;
      for (; step > 0; step >>= 1) {
        if (pos + step <= n && tree[pos + step] < rest) {
          pos += step;
          rest -= tree[pos];
        }
      }
      return pos;
    };
    for (let i = 0; i < n; i++) add(rankOf[i], 1);

    const indexesOf: number[][] = windows.map(() => []);
    windowOf.forEach((wi, i) => indexesOf[wi].push(i));

    windows.forEach((w, wi) => {
      const own = indexesOf[wi];
      for (const i of own) add(rankOf[i], -1);
      const m = n - own.length;
      let trend = 0;
      if (m >= TREND_MIN_SUPPORT) {
        trend = m % 2
          ? sorted[kth((m + 1) >> 1)]
          : (sorted[kth(m >> 1)] + sorted[kth((m >> 1) + 1)]) / 2;
      }
      w.recentered[s] = w.signed[s].map((v) => v - trend);
      w.recenteredSum[s] = rms(w.recentered[s]);
      for (const i of own) add(rankOf[i], 1);
    });
  }
}

/** RMS onset error — the scoring term all three converging systems use. */
function rms(xs: number[]): number {
  if (!xs.length) return 0;
  let acc = 0;
  for (const x of xs) acc += x * x;
  return Math.sqrt(acc / xs.length);
}

function robustJitter(windows: BeatWindow[], stateCount: number): number {
  const residuals: number[] = [];
  for (const w of windows) {
    w.notes.forEach((_, i) => {
      let best = Infinity;
      for (let s = 0; s < stateCount; s++) best = Math.min(best, Math.abs(w.recentered[s][i]));
      residuals.push(best);
    });
  }
  const center = median(residuals);
  const mad = median(residuals.map((v) => Math.abs(v - center)));
  return Math.max(0.25, center + 1.4826 * mad);
}

function supportedPositions(w: BeatWindow, s: number, state: RhythmState, jitter: number): Set<number> {
  const tolerance = Math.max(jitter, state.grid / 4);
  const positions = new Set<number>();
  w.notes.forEach((n, i) => {
    if (Math.abs(w.recentered[s][i]) <= tolerance) {
      positions.add(Math.round((snapTo(n.rawStartTick, state.grid, w.origin) - w.origin) / state.grid));
    }
  });
  return positions;
}

function transitionCost(prev: RhythmState, next: RhythmState, adjacent: boolean): number {
  if (!adjacent || prev.name === next.name) return 0;
  let cost = STATE_CHANGE_COST;
  if (!prev.tuplet && next.tuplet) cost += TUPLET_START_COST;
  return cost;
}

/**
 * HONEST FREE (issue #36). `grid: 'free'` is not a looser quantizer, it is a READ-ONLY VIEW of
 * the input: never merge, never drop, never fill, never reorder — exactly one attack group on
 * the page per input event, in the order they were played.
 *
 * It still lands on a lattice, and that is not a contradiction. The old free path rounded to the
 * raw tick lattice, which at any `divisions` is finer than the printable vocabulary, so spans
 * like "1 tick" reached the engraver and were printed as a 16th — a glyph whose <type> flatly
 * contradicted its own <duration>. Notation cannot say anything finer than a 1/32, so THAT is
 * free's resolution limit and the rounding error is bounded by half a 1/32 at the take's tempo.
 * Inside that tolerance the engraver is then free to pick the SIMPLEST symbol combination rather
 * than the most precise one.
 *
 * COLLISIONS ARE PUSHED, NOT FUSED. Two events that round onto the same slot are distinct
 * attacks that the player actually played; the quantized path may fuse them, free may not. The
 * later one moves to the next free slot, which costs it one 1/32 of position and keeps the
 * one-attack-per-note contract and the play order intact.
 */
function quantizeFree(notes: QuantNote[]): QuantResult {
  const unit = THIRTYSECOND_TICKS;
  const ordered = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.rawStartTick - b.n.rawStartTick || a.i - b.i);

  const out: QuantResult['notes'] = [];
  let occupied = -Infinity;
  for (const { n } of ordered) {
    let startTick = n.fixedStartTick ?? Math.round(n.rawStartTick / unit) * unit;
    if (n.fixedStartTick === undefined && startTick <= occupied) startTick = occupied + unit;
    occupied = Math.max(occupied, startTick);
    const rawDur = Math.max(0, n.rawOffTick - n.rawStartTick);
    const units = Math.max(1, Math.round(rawDur / unit));
    // A DECLARED WRITTEN VALUE IS HONOURED HERE TOO. Free is a view of the input at notation's
    // finest honest resolution, and a value the user typed is not a measurement to be re-rounded:
    // every intent length is a whole number of 1/32s by construction (ir.ts rejects the one that
    // is not), so it already lies on free's own lattice.
    out.push({ id: n.id, startTick, offTick: startTick + (n.intentTicks ?? units * unit) });
  }
  // `fused` is empty and always will be: this path PUSHES collisions to the next free slot
  // rather than absorbing them, so free is the one grid on which no attack is ever lost.
  return { notes: out, tuplets: [], basicQuantTicks: unit, jitterTicks: 0, fused: [] };
}

/**
 * The symbolic-import path. The source already decided every written tick, so positions are
 * only rounded onto the integer lattice and coincident events are fused (two events sharing a
 * startTick corrupts the bar cursor downstream).
 */
function quantizeExact(notes: QuantNote[]): QuantResult {
  const rounded = notes
    .map((n) => ({
      id: n.id,
      startTick: Math.round(n.rawStartTick),
      offTick: Math.max(Math.round(n.rawStartTick) + 1, Math.round(n.rawOffTick))
    }))
    .sort((a, b) => a.startTick - b.startTick);
  const fused: QuantResult['notes'] = [];
  const fusedInto: QuantResult['fused'] = [];
  for (const n of rounded) {
    const prev = fused[fused.length - 1];
    if (prev && prev.startTick === n.startTick) {
      prev.offTick = Math.max(prev.offTick, n.offTick);
      // The first arrival keeps the slot on this path and nothing re-picks it afterwards, so the
      // survivor is known here. Recorded because a written note leaving no glyph is precisely the
      // loss the projection exists to name.
      fusedInto.push({ id: n.id, intoId: prev.id });
      continue;
    }
    fused.push(n);
  }
  return { notes: fused, tuplets: [], basicQuantTicks: 1, jitterTicks: 0, fused: fusedInto };
}

export function quantizeOnsets(
  notes: QuantNote[],
  opts: { grid: QuantGrid; ticksPerBeat: number; compound: boolean; totalTicks: number }
): QuantResult {
  if (opts.grid === 'free') return quantizeFree(notes);
  if (opts.grid === 'exact' || !notes.length) return quantizeExact(notes);

  // The span one rhythm decision covers: the tracked beat, widened only when the caller's grid
  // names a value the beat cannot divide (see `quantWindowTicks`).
  const windowTicks = quantWindowTicks(opts.grid, opts.ticksPerBeat);
  const states = statesFor(opts.grid, opts.ticksPerBeat, opts.compound, windowTicks);
  const straight = states.filter((s) => !s.tuplet);
  // `basicQuant`: the finest STRAIGHT subdivision actually on offer, and therefore the step
  // BOTH an onset and its off-time snap to. Iterative: a spread over a million-note import
  // throws `RangeError` before it ever computes anything.
  let finestStraight = Infinity;
  for (const s of straight) if (s.grid < finestStraight) finestStraight = s.grid;
  if (!Number.isFinite(finestStraight)) finestStraight = windowTicks;

  // ---- beat windows -------------------------------------------------------------------------
  const byBeat = new Map<number, QuantNote[]>();
  for (const n of notes) {
    const beat = Math.floor(n.rawStartTick / windowTicks);
    const g = byBeat.get(beat) ?? [];
    g.push(n);
    byBeat.set(beat, g);
  }
  const beats = [...byBeat.keys()].sort((a, b) => a - b);
  const windows: BeatWindow[] = beats.map((beat) => {
    const ns = byBeat.get(beat)!;
    const origin = beat * windowTicks;
    return {
      beat,
      origin,
      notes: ns,
      residuals: states.map((st) =>
        rms(ns.map((n) => n.rawStartTick - snapTo(n.rawStartTick, st.grid, origin)))
      ),
      signed: states.map((st) => ns.map((n) => n.rawStartTick - snapTo(n.rawStartTick, st.grid, origin))),
      recentered: [],
      recenteredSum: []
    };
  });
  recenterWindows(windows, states.length);
  const jitter = robustJitter(windows, states.length);

  // ---- tuplet admission (deliberately stricter than the DP objective) ------------------------
  //
  // §6.4's coverage rule exists to kill FALSE triplets — readings 'auto' proposes on its own
  // initiative and has to be talked out of. When the caller named the triplet grid, the triplet
  // is not a hypothesis under suspicion, it is the instruction; demanding all three slots there
  // refuses the commonest triplet figure of all, the shuffle that plays slots 1 and 3 and leaves
  // the middle silent. Two of three is still a floor (one lone onset is not evidence of a
  // tuplet), and every other gate below — the off-lattice uniqueness test and both RMS margins,
  // which are what actually separate a triplet from straight eighths — is unchanged.
  const tupletRequested = opts.grid === '1/8T';
  const admitted = windows.map((w) =>
    states.map((state, s) => {
      if (!state.tuplet) return true;
      const unitsPerBeat = state.division;
      const positions = supportedPositions(w, s, state, jitter);
      // COVERAGE. §6.4 rule 3: a triplet needs all three positions occupied — "this single rule
      // kills most false triplets". A sextuplet is held to two thirds of its six, because a
      // genuine 16th-triplet figure often leaves one slot silent.
      const required = tupletRequested
        ? Math.min(2, state.division)
        : state.division === 3
          ? 3
          : Math.ceil((state.division * 2) / 3);
      let covered = 0;
      for (let p = 0; p < unitsPerBeat; p++) if (positions.has(p)) covered++;
      if (covered < required) return false;
      // At least one onset must sit where NO straight grid could have put it.
      const unique = [...positions].filter((p) => (p * state.grid) % finestStraight !== 0);
      if (!unique.length) return false;
      const bestStraight = Math.min(
        ...states.map((c, ci) => (c.tuplet ? Infinity : w.recenteredSum[ci]))
      );
      const mine = w.recenteredSum[s];
      // Both gates, on RMS error: one full jitter unit of absolute improvement, AND §6.4's 25%
      // relative margin. "A triplet must beat the straight reading, not tie it."
      if (bestStraight - mine < jitter) return false;
      if (bestStraight > 0 && mine > bestStraight * (1 - TUPLET_ERROR_MARGIN)) return false;
      return true;
    })
  );

  // ---- Viterbi -------------------------------------------------------------------------------
  const cost: number[][] = windows.map(() => states.map(() => Infinity));
  const back: number[][] = windows.map(() => states.map(() => -1));
  for (let s = 0; s < states.length; s++) {
    if (!admitted[0][s]) continue;
    cost[0][s] = windows[0].recenteredSum[s] / jitter + states[s].complexity;
  }
  for (let w = 1; w < windows.length; w++) {
    const adjacent = windows[w].beat - windows[w - 1].beat === 1;
    for (let s = 0; s < states.length; s++) {
      if (!admitted[w][s]) continue;
      const local = windows[w].recenteredSum[s] / jitter + states[s].complexity;
      for (let p = 0; p < states.length; p++) {
        if (cost[w - 1][p] === Infinity) continue;
        const c = cost[w - 1][p] + local + transitionCost(states[p], states[s], adjacent);
        if (c < cost[w][s]) {
          cost[w][s] = c;
          back[w][s] = p;
        }
      }
    }
  }
  let chosen = 0;
  const last = windows.length - 1;
  for (let s = 1; s < states.length; s++) if (cost[last][s] < cost[last][chosen]) chosen = s;
  const decoded = new Map<number, RhythmState>();
  for (let w = last; w >= 0; w--) {
    decoded.set(windows[w].beat, states[chosen]);
    const prev = back[w][chosen];
    chosen = prev >= 0 ? prev : 0;
  }

  // ---- snap ------------------------------------------------------------------------------------
  const tuplets: QuantTupletGroup[] = [];
  const tupletByBeat = new Map<number, QuantTupletGroup>();
  for (const [beat, state] of decoded) {
    if (!state.tuplet) continue;
    const g: QuantTupletGroup = {
      id: `tup-${beat}`,
      startTick: beat * windowTicks,
      endTick: (beat + 1) * windowTicks,
      unitTicks: state.grid,
      actual: state.actual,
      normal: state.normal
    };
    tuplets.push(g);
    tupletByBeat.set(beat, g);
  }

  const out: QuantResult['notes'] = [];
  for (const n of notes) {
    const beat = Math.floor(n.rawStartTick / windowTicks);
    const state = decoded.get(beat) ?? states[0];
    const origin = beat * windowTicks;
    const candidate = state.tuplet ? tupletByBeat.get(beat) : undefined;
    const unit = candidate ? candidate.unitTicks : state.grid;
    // A sheet-authored attack is already a written position. Applying the inferred performance
    // grid to it again is what moved a new 1/16 onto a neighbouring eighth after every rebuild.
    const startTick = n.fixedStartTick ?? snapTo(n.rawStartTick, unit, origin);
    const rawDur = Math.max(0, n.rawOffTick - n.rawStartTick);
    // MEMBERSHIP FOLLOWS THE TICK THE NOTE LANDED ON, NOT THE BEAT IT WAS PLAYED IN.
    //
    // The state that decides the snapping unit has to come from the raw beat — there is nothing
    // else to look it up by. Where the note ENDS UP is a different question, and snapping can
    // move it across a barline of the beat grid in either direction:
    //
    //   out of a group   the last member rounds up to the beat boundary; it is a straight note
    //                    at the next beat and must not keep the group it left (the old rule,
    //                    preserved by the range test below);
    //   into a group     a note played in a straight beat rounds FORWARD onto the downbeat of a
    //                    triplet beat. It used to keep no group at all while sitting squarely
    //                    inside one, so buildScore split its 8 sounding ticks on the straight
    //                    metric into 6 + 2 and typed the remainder `32nd` — a glyph whose <type>
    //                    says 3 ticks and whose <duration> says 2. MusicXML's S2 assertion threw
    //                    on it and the whole build died with no score at all.
    //
    // A group spans exactly its beat, so the landed tick names its group unambiguously.
    const landed = tupletByBeat.get(Math.floor(startTick / windowTicks));
    const group = landed && startTick >= landed.startTick && startTick < landed.endTick ? landed : undefined;

    // SPEC RULE R4: the off-time snaps on the SAME grid as its onset, never independently —
    // and "the same grid" means the same grid, with no finer escape hatch for short notes.
    //
    // This used to fall back to a halving ladder (`durationQuant`) so that a clipped note could
    // keep a sub-grid length. That was issue #31: at `grid: '1/4'` an onset landed on the beat
    // while its off-time landed on a 1/8 or finer step, so a take of repeated strikes came back
    // as a row of eighth-note flags under a quarter-note grid — never a half note, never a tie.
    // A grid is a contract about what the page is allowed to say. If the caller asked for
    // quarters, the shortest thing the page can say is a quarter.
    //
    // The step is `finestStraight`, NOT this beat's decoded `state.grid`. The onset grid is
    // decided per beat and can be as coarse as the beat itself; charging a note the whole beat
    // because its neighbours happened to decode coarsely would invent sustain, which is the one
    // thing simplify.ts exists to prevent. Inside a tuplet the step is the tuplet's own unit.
    // `group.unitTicks`, not the snapping `unit`: after a cross-beat landing the group the note
    // is IN can differ from the group its raw beat was snapped BY, and the length has to be
    // measured in the units of the tuplet it will actually be printed inside.
    const durUnit = group ? group.unitTicks : finestStraight;
    const units = Math.max(1, Math.round(rawDur / durUnit));
    let offTick: number;
    if (n.intentTicks !== undefined) {
      // A DECLARED WRITTEN VALUE OUTRANKS THE GRID, and it has to: the grid is a ceiling on what
      // the page may say about a MEASUREMENT, and this length is not a measurement. Rounding a
      // chosen 1/32 back up to the admitted quarter is the exact failure mode that makes "set
      // this note's duration" impossible to express in seconds (Codex point 3) — the caller would
      // watch its own instruction be undone. The bar/tie law and the next-attack trim still apply
      // downstream; only this rounding is skipped.
      offTick = startTick + n.intentTicks;
      // THE TUPLET LATTICE IS NOT NEGOTIABLE, though. Inside a group every tick a note
      // contributes must be a whole number of the group's units, because the written value of a
      // tuplet piece IS its unit count scaled by normal/actual — a span of two and a half triplet
      // eighths has no symbol, and `validateIR` would (correctly) refuse the score. An end that
      // leaves the group entirely is fine: the piece inside it is then the whole remainder of the
      // group, which is a whole unit count by construction.
      if (group && offTick < group.endTick) {
        offTick = group.startTick + Math.round((offTick - group.startTick) / group.unitTicks) * group.unitTicks;
      }
    } else {
      offTick = startTick + units * durUnit;
      if (group) offTick = Math.min(group.endTick, offTick);
    }
    if (offTick <= startTick) offTick = startTick + durUnit;
    // EVERY TICK A NOTE CONTRIBUTES LIES ON THE LATTICE OF WHATEVER GROUP CONTAINS IT — the
    // off-time as much as the onset. A straight note ringing on into a later triplet beat used
    // to stop wherever its own 1/8 step happened to fall, e.g. tick 36 inside a group whose
    // units are 24/32/40. Nothing downstream can print the 4-tick gap that leaves: it is not a
    // straight value and not a whole tuplet unit either, so the rest splitter fell off the
    // vocabulary. Ending it on the group's own lattice keeps the sounding length within half a
    // unit and keeps every span on the page notatable.
    if (!group) {
      const host = tupletByBeat.get(Math.floor(offTick / windowTicks));
      // A non-member's onset is necessarily before the group, so rounding down to the group's
      // own start still leaves a positive length; no floor is needed.
      if (host && offTick > host.startTick && offTick < host.endTick) {
        offTick = host.startTick + Math.round((offTick - host.startTick) / host.unitTicks) * host.unitTicks;
      }
    }
    out.push({
      id: n.id,
      startTick,
      offTick,
      ...(group ? { tupletId: group.id } : {})
    });
  }

  out.sort((a, b) => a.startTick - b.startTick);

  // Collisions after snapping: MuseScore charges a merge penalty and fuses them; here they are
  // already-separate chord events that landed on the same grid point, so fuse them too.
  //
  // MERGE PITCH PICK (issue #31 invariant e). A merged slot can only sound one thing, and which
  // one is a real decision — the surviving `id` is what buildScore maps back to a chord, so it
  // picks the PITCHES as well as the identity. Keeping the first arrival lets a 20 ms grace note
  // silence the half note it leads into. The winner is therefore the event with the most
  // duration-weighted evidence, measured on the RAW length before any snapping rounded the
  // difference away; the earlier arrival keeps the slot on a tie.
  const rawDurById = new Map(notes.map((n) => [n.id, Math.max(0, n.rawOffTick - n.rawStartTick)]));
  const fixedIds = new Set(notes.filter((n) => n.fixedStartTick !== undefined).map((n) => n.id));
  const deduped: QuantResult['notes'] = [];
  /**
   * EVERY ID THAT PASSED THROUGH EACH SLOT, parallel to `deduped`. The losers cannot be named
   * inside the loop: the pitch pick can hand the slot to a later arrival, which turns an id that
   * was the survivor a moment ago into a loser. The list is resolved against the FINAL winner
   * once the loop has finished, which is the only point at which the survivor is settled.
   */
  const slotIds: string[][] = [];
  for (const n of out) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.startTick === n.startTick) {
      prev.offTick = Math.max(prev.offTick, n.offTick);
      slotIds[slotIds.length - 1].push(n.id);
      if (
        (fixedIds.has(n.id) && !fixedIds.has(prev.id)) ||
        (fixedIds.has(n.id) === fixedIds.has(prev.id) &&
          (rawDurById.get(n.id) ?? 0) > (rawDurById.get(prev.id) ?? 0))
      ) {
        prev.id = n.id;
        if (n.tupletId === undefined) delete prev.tupletId;
        else prev.tupletId = n.tupletId;
      }
      continue;
    }
    deduped.push({ ...n });
    slotIds.push([n.id]);
  }

  const fused: QuantResult['fused'] = [];
  for (let i = 0; i < deduped.length; i++) {
    const winner = deduped[i].id;
    for (const id of slotIds[i]) if (id !== winner) fused.push({ id, intoId: winner });
  }

  return {
    notes: deduped,
    tuplets: tuplets.filter((t) => deduped.some((n) => n.tupletId === t.id)),
    basicQuantTicks: finestStraight,
    jitterTicks: jitter,
    fused
  };
}
