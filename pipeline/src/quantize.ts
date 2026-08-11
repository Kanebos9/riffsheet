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
 *  - the state set is now straight-8, straight-16 and eighth-triplet ONLY. §6.4 of
 *    midi-semantics-research.md: 3-plets only in v1, confined to a single beat, and never
 *    5/7/9-plets ("a bass riff essentially never contains a genuine septuplet, but sloppy
 *    playing produces septuplet-shaped evidence constantly").
 *  - tuplet admission gained §6.4's two extra gates: FULL COVERAGE (all three positions
 *    occupied — "this single rule kills most false triplets") and a 25% relative error margin
 *    ("a triplet must beat the straight reading, not tie it").
 *  - THE DURATION HALF IS GONE. `quantizeStraightDuration` — the 78%-rule that generated the
 *    spurious rests (§0.3, §4.2) — is deleted. Off-times now snap on the SAME grid as their
 *    onset (spec rule R4) and the decision about what to print belongs to simplify.ts.
 */

import type { GridSetting } from './types.js';

export interface QuantNote {
  id: string;
  /** Fractional tick from the time skeleton (per-bar origin already applied). */
  rawStartTick: number;
  rawOffTick: number;
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
const COMPLEXITY: Record<number, number> = { 1: 0, 2: 0.05, 4: 0.1, 3: 1.0, 6: 1.2 };
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
function statesFor(grid: GridSetting, ticksPerBeat: number, compound: boolean): RhythmState[] {
  const out: RhythmState[] = [];
  const add = (name: string, division: number, tuplet: boolean): void => {
    const g = ticksPerBeat / division;
    if (!Number.isInteger(g) || g < 1) return; // not representable at this resolution
    out.push({
      name,
      division,
      grid: g,
      tuplet,
      actual: tuplet ? division : 1,
      normal: tuplet ? normalFor(division) : 1,
      complexity: COMPLEXITY[division] ?? 2
    });
  };
  // A compound beat is a dotted value: its natural divisions are 3 and 6, not 2 and 4.
  if (compound) {
    add('beat', 1, false);
    if (grid !== '1/4') add('compound-8', 3, false);
    if (grid === 'auto' || grid === '1/16') add('compound-16', 6, false);
    return out;
  }
  add('beat', 1, false);
  if (grid !== '1/4' && grid !== '1/8T') add('straight-8', 2, false);
  if (grid === 'auto' || grid === '1/16') add('straight-16', 4, false);
  if (grid === 'auto' || grid === '1/8T') add('triplet-8', 3, true);
  if (grid === 'auto') add('triplet-16', 6, true);
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
 */
function recenterWindows(windows: BeatWindow[], stateCount: number): void {
  for (let s = 0; s < stateCount; s++) {
    for (const w of windows) {
      const complement: number[] = [];
      for (const other of windows) if (other !== w) complement.push(...other.signed[s]);
      const trend = complement.length >= TREND_MIN_SUPPORT ? median(complement) : 0;
      w.recentered[s] = w.signed[s].map((v) => v - trend);
      w.recenteredSum[s] = rms(w.recentered[s]);
    }
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

export function quantizeOnsets(
  notes: QuantNote[],
  opts: { grid: GridSetting; ticksPerBeat: number; compound: boolean; totalTicks: number }
): QuantResult {
  const states = statesFor(opts.grid, opts.ticksPerBeat, opts.compound);
  const straight = states.filter((s) => !s.tuplet);
  // `basicQuant`: the finest STRAIGHT subdivision actually on offer, and therefore the step
  // an off-time is allowed to snap to.
  const finestStraight = Math.min(...straight.map((s) => s.grid));

  if (opts.grid === 'free' || !notes.length) {
    // 'free': notated = played. Positions are only rounded to the tick lattice, because
    // MusicXML has no sub-division resolution — no musical grid is imposed at all.
    //
    // Rounding to the lattice can still collide two distinct onsets onto one tick, and two
    // events sharing a startTick corrupts the bar cursor downstream. Fuse them here, exactly as
    // the quantized path does.
    const rounded = notes
      .map((n) => ({
        id: n.id,
        startTick: Math.round(n.rawStartTick),
        offTick: Math.max(Math.round(n.rawStartTick) + 1, Math.round(n.rawOffTick))
      }))
      .sort((a, b) => a.startTick - b.startTick);
    const fused: QuantResult['notes'] = [];
    for (const n of rounded) {
      const prev = fused[fused.length - 1];
      if (prev && prev.startTick === n.startTick) {
        prev.offTick = Math.max(prev.offTick, n.offTick);
        continue;
      }
      fused.push(n);
    }
    return { notes: fused, tuplets: [], basicQuantTicks: 1, jitterTicks: 0 };
  }

  // ---- beat windows -------------------------------------------------------------------------
  const byBeat = new Map<number, QuantNote[]>();
  for (const n of notes) {
    const beat = Math.floor(n.rawStartTick / opts.ticksPerBeat);
    const g = byBeat.get(beat) ?? [];
    g.push(n);
    byBeat.set(beat, g);
  }
  const beats = [...byBeat.keys()].sort((a, b) => a - b);
  const windows: BeatWindow[] = beats.map((beat) => {
    const ns = byBeat.get(beat)!;
    const origin = beat * opts.ticksPerBeat;
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
  const admitted = windows.map((w) =>
    states.map((state, s) => {
      if (!state.tuplet) return true;
      const unitsPerBeat = state.division;
      const positions = supportedPositions(w, s, state, jitter);
      // COVERAGE. §6.4 rule 3: a triplet needs all three positions occupied — "this single rule
      // kills most false triplets". A sextuplet is held to two thirds of its six, because a
      // genuine 16th-triplet figure often leaves one slot silent.
      const required = state.division === 3 ? 3 : Math.ceil((state.division * 2) / 3);
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
      startTick: beat * opts.ticksPerBeat,
      endTick: (beat + 1) * opts.ticksPerBeat,
      unitTicks: state.grid,
      actual: state.actual,
      normal: state.normal
    };
    tuplets.push(g);
    tupletByBeat.set(beat, g);
  }

  const out: QuantResult['notes'] = [];
  for (const n of notes) {
    const beat = Math.floor(n.rawStartTick / opts.ticksPerBeat);
    const state = decoded.get(beat) ?? states[0];
    const origin = beat * opts.ticksPerBeat;
    const candidate = state.tuplet ? tupletByBeat.get(beat) : undefined;
    const unit = candidate ? candidate.unitTicks : state.grid;
    const startTick = snapTo(n.rawStartTick, unit, origin);
    const rawDur = Math.max(0, n.rawOffTick - n.rawStartTick);
    // A member whose onset rounds all the way to the beat boundary has left the group on
    // position evidence alone; it is a straight note at the next beat.
    const group = candidate && startTick < candidate.endTick ? candidate : undefined;

    // SPEC RULE R4: the off-time snaps on the SAME grid as its onset, never independently.
    let offTick: number;
    if (group) {
      const units = Math.max(1, Math.round(rawDur / unit));
      offTick = Math.min(group.endTick, startTick + units * unit);
    } else {
      const q = durationQuant(rawDur, finestStraight);
      offTick = startTick + Math.max(q, Math.round(rawDur / q) * q);
    }
    if (offTick <= startTick) offTick = startTick + (group ? unit : finestStraight);
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
  const deduped: QuantResult['notes'] = [];
  for (const n of out) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.startTick === n.startTick) {
      prev.offTick = Math.max(prev.offTick, n.offTick);
      continue;
    }
    deduped.push(n);
  }

  return {
    notes: deduped,
    tuplets: tuplets.filter((t) => deduped.some((n) => n.tupletId === t.id)),
    basicQuantTicks: finestStraight,
    jitterTicks: jitter
  };
}

/**
 * The off-time's own grid, derived from the onset grid — NOT from a duration ladder.
 * A note shorter than the onset grid may still use a finer step — otherwise a staccato
 * sixteenth would round up to the grid and gain sustain it never had — but a note longer than
 * the grid never gets a finer one. This is the fix for §4.2.
 */
function durationQuant(rawDur: number, finestStraight: number): number {
  let q = finestStraight;
  while (q > rawDur && q > 1) q = Math.max(1, Math.floor(q / 2));
  return Math.max(1, q);
}
