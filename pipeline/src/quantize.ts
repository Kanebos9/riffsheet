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
import { THIRTYSECOND_TICKS } from './ir.js';

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
function statesFor(grid: QuantGrid, ticksPerBeat: number, compound: boolean): RhythmState[] {
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
  const fine = grid === '1/16' || grid === 'thirtysecond';
  // A compound beat is a dotted value: its natural divisions are 3 and 6, not 2 and 4, and a
  // 1/32 inside a dotted quarter is a TWELFTH of the beat.
  if (compound) {
    add('beat', 1, false);
    if (grid !== '1/4') add('compound-8', 3, false);
    if (grid === 'auto' || fine) add('compound-16', 6, false);
    if (grid === 'thirtysecond') add('compound-32', 12, false);
    return out;
  }
  add('beat', 1, false);
  // '1/8T' IS THE TRIPLET GRID, NOT A TRIPLET-ONLY GRID. It used to withhold `straight-8`, on
  // the reading that a caller asking for triplets wants nothing else. That is not what it did.
  // The tuplet gates below are deliberately strict (all three positions occupied, a 25% margin
  // over the straight reading), so any beat they reject fell through to the ONLY other state
  // left — `beat`, a whole-beat lattice. A straight eighth then snapped a HALF BEAT onto its
  // neighbour's tick, where the collision fuse deleted one of the two attacks; a "two of three"
  // shuffle figure lost a note the same way. A grid setting chooses what the page may SAY, and
  // no setting is allowed to delete a note that was played. `1/4` collapses on purpose because
  // the quarter IS its finest word; the triplet grid's finest straight word is the eighth, which
  // is what tieMerge.test.ts's STEP table has always declared it to be.
  if (grid !== '1/4') add('straight-8', 2, false);
  if (grid === 'auto' || fine) add('straight-16', 4, false);
  // 1/32 IS OPT-IN, never offered by 'auto'. FiloBass's 46,281 human glyphs are 0.009% 32nds
  // (§0.1); handing the Viterbi a 1/32 lattice by default buys nothing and gives sloppy playing
  // somewhere finer to hide. The caller has to ask for it by name.
  if (grid === 'thirtysecond') add('straight-32', 8, false);
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
    let startTick = Math.round(n.rawStartTick / unit) * unit;
    if (startTick <= occupied) startTick = occupied + unit;
    occupied = startTick;
    const rawDur = Math.max(0, n.rawOffTick - n.rawStartTick);
    const units = Math.max(1, Math.round(rawDur / unit));
    out.push({ id: n.id, startTick, offTick: startTick + units * unit });
  }
  return { notes: out, tuplets: [], basicQuantTicks: unit, jitterTicks: 0 };
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

export function quantizeOnsets(
  notes: QuantNote[],
  opts: { grid: QuantGrid; ticksPerBeat: number; compound: boolean; totalTicks: number }
): QuantResult {
  if (opts.grid === 'free') return quantizeFree(notes);
  if (opts.grid === 'exact' || !notes.length) return quantizeExact(notes);

  const states = statesFor(opts.grid, opts.ticksPerBeat, opts.compound);
  const straight = states.filter((s) => !s.tuplet);
  // `basicQuant`: the finest STRAIGHT subdivision actually on offer, and therefore the step
  // BOTH an onset and its off-time snap to.
  const finestStraight = Math.min(...straight.map((s) => s.grid));

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
    const landed = tupletByBeat.get(Math.floor(startTick / opts.ticksPerBeat));
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
    let offTick = startTick + units * durUnit;
    if (group) offTick = Math.min(group.endTick, offTick);
    if (offTick <= startTick) offTick = startTick + durUnit;
    // EVERY TICK A NOTE CONTRIBUTES LIES ON THE LATTICE OF WHATEVER GROUP CONTAINS IT — the
    // off-time as much as the onset. A straight note ringing on into a later triplet beat used
    // to stop wherever its own 1/8 step happened to fall, e.g. tick 36 inside a group whose
    // units are 24/32/40. Nothing downstream can print the 4-tick gap that leaves: it is not a
    // straight value and not a whole tuplet unit either, so the rest splitter fell off the
    // vocabulary. Ending it on the group's own lattice keeps the sounding length within half a
    // unit and keeps every span on the page notatable.
    if (!group) {
      const host = tupletByBeat.get(Math.floor(offTick / opts.ticksPerBeat));
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
  const deduped: QuantResult['notes'] = [];
  for (const n of out) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.startTick === n.startTick) {
      prev.offTick = Math.max(prev.offTick, n.offTick);
      if ((rawDurById.get(n.id) ?? 0) > (rawDurById.get(prev.id) ?? 0)) {
        prev.id = n.id;
        if (n.tupletId === undefined) delete prev.tupletId;
        else prev.tupletId = n.tupletId;
      }
      continue;
    }
    deduped.push({ ...n });
  }

  return {
    notes: deduped,
    tuplets: tuplets.filter((t) => deduped.some((n) => n.tupletId === t.id)),
    basicQuantTicks: finestStraight,
    jitterTicks: jitter
  };
}
