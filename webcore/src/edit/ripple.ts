/**
 * THE RIPPLE RULE — a duration edit pushes or pulls the entire rest of the score.
 *
 * ===========================================================================================
 * WHY THIS IS A LAYER AND NOT A REDUCER
 * ===========================================================================================
 *
 * Every other edit in this app is a function from a note list to a note list, written back into
 * the recording by id (`edit/performanceEdit.ts`, `app/snap.ts §mergeEditedOntoRaw`). A ripple
 * cannot be one, and the reason is worth stating exactly because it is what decides the shape of
 * everything below.
 *
 * A take-wide ripple marks EVERY note after the seam as changed. `mergeEditedOntoRaw` keeps the
 * edited version of every changed note, so committing a rippled feed would promote the whole
 * snapped, cut-closed suffix into `source.detected.notes` — the recording. Two things die at once:
 *
 *   REVERSIBILITY   the snap stops being a layer. Switching Snap off would no longer restore the
 *                   take, because the take now IS the snapped positions.
 *   THE CUT         the feed does not contain notes whose attack is inside a cut, so rebuilding
 *                   the recording out of it deletes them — a non-destructive cut becomes
 *                   destructive, one duration edit later, silently.
 *
 * So the ripple is stored as an ORDERED LIST OF RATIONAL OPERATIONS and applied to the derived
 * feed, underneath nothing and on top of everything:
 *
 *     immutable audio note provenance      `source.detected.notes`, in AUDIO seconds
 *       ↓ cuts, in audio coordinates       `edit/cuts.ts` — never rippled, never moved
 *     derived performance timing
 *       ↓ snap                             `app/snap.ts`
 *     derived grid timing
 *       ↓ THESE OPERATIONS                 persisted, rational, ordered
 *     effective score timing
 *       ├─ the piano roll
 *       └─ the pipeline / the sheet
 *
 * Both consumers read the SAME result, because `App.performanceFeed()` is the one tap point and
 * the roll and the score are both drawn from it. "The roll mirrors the sheet" is therefore
 * structural rather than approximate: there is no second implementation to keep in step.
 *
 * CUTS COME FIRST AND NEVER RIPPLE. A score note is allowed to drift away from its waveform peak —
 * the waveform is a photograph and the score is the music — but it may never change whether its
 * source attack was inside a cut. Undoing a cut therefore reveals the note deterministically and
 * then applies every existing operation to it, which a materialised per-note offset could not do
 * (the hidden note was not in the feed when the offset was computed).
 *
 * ===========================================================================================
 * THE LAW
 * ===========================================================================================
 *
 * THE DOMAIN IS IR TICKS, ALWAYS. Never one `deltaSec` added to a suffix: across a tempo change
 * the seconds displacement for an equal tick displacement differs by position, so a scalar shift
 * puts the tail of a rallentando in the wrong bar. Every endpoint is converted through the
 * tick↔seconds map ABSOLUTELY — `toSec(toTick(sec) + delta)` — and the scalar helpers in
 * `edit/rollPerformance.ts` are wrong for this operation and are not used by it.
 *
 * THE LENGTH IS WRITTEN, NOT MEASURED. `deltaTick` comes from `notationIntentTicks` minus the
 * note's own ENGRAVED span (tied continuations coalesced — see `WrittenSpan`), never from
 * `endSec - startSec`, which is articulation, and never from a first tied glyph's `durationType`,
 * which is one piece of a longer note.
 *
 * THE SEAM IS THE OLD END, and "subsequent" means an attack AT OR AFTER it:
 *
 *   - the edited event is one rhythmic atom. Every notehead in it is a chord mate, they all take
 *     the new value, they all end together, and they are EXCLUDED from the shift — one ripple for
 *     the stack, not one per notehead;
 *   - every other endpoint at or after the seam moves by `deltaTick`. Both of a note's endpoints
 *     are tested separately, which is the whole of the crossing rule below;
 *   - an attack exactly at the old end moves;
 *   - a note that began before the seam does not move merely because its release is later.
 *
 * THE CROSSING RULE, adjudicated. A note SUSTAINING across the seam keeps its attack and its
 * release moves by `deltaTick` — it sustains through inserted time, and gives up removed time.
 * That falls straight out of "each endpoint moves iff it is at or after the seam" and needs no
 * special case. What DOES need one is the pathological end of it: if the shift would collapse the
 * note below one printable tick, the edit is REJECTED with a reason. There is no operation that
 * can simultaneously preserve that note, preserve its length, pull its successor by the full delta
 * and avoid an overlap; refusing is better than silently trimming, deleting, or inventing a voice.
 *
 * REPEATED RIPPLES ACCUMULATE IN THE RATIONAL TICK DOMAIN. A note's total displacement is the SUM
 * of the deltas of every operation whose seam it is past, summed as exact rationals and converted
 * to seconds exactly once. A hundred lengthenings and a hundred matching shortenings therefore
 * return the document to the tick it started on, with no residue — which adding and subtracting
 * floating-point seconds two hundred times does not.
 *
 * EACH OPERATION IS STATED IN THE COORDINATES THE ONES BEFORE IT PRODUCED. That is what makes the
 * log replayable against a feed that is re-derived from the recording on every rebuild, and it is
 * why the seam is a derived tick rather than an engraved one: an engraved tick describes the page
 * AFTER the ripple, so re-applying against it would move the same note again on every build.
 */

import type { InputNote } from '@pipeline';

// ---------------------------------------------------------------------------
// Rationals — small, exact, and only as much of them as this needs
// ---------------------------------------------------------------------------

/**
 * An exact tick value: `n / d`, always normalised, `d > 0`.
 *
 * NOT A GENERAL NUMERIC TOWER. Three things need exactness here and nothing else does:
 *   - the accumulated displacement of a note across many operations (float seconds drift);
 *   - the source-tick restatement `delta × sourcePPQ / divisions`, which is fractional whenever
 *     an imported part's PPQ is not a multiple of the IR's divisions;
 *   - the document's structural end, which an integer bar count cannot represent (a quarter-note
 *     growth inside 4/4 is not a bar).
 */
export interface Rational {
  readonly n: number;
  readonly d: number;
}

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

/** `n / d`, normalised. Non-finite input collapses to zero rather than poisoning a document. */
export function rational(n: number, d = 1): Rational {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return RAT_ZERO;
  let num = Math.round(n);
  let den = Math.round(d);
  if (den < 0) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return { n: num / g, d: den / g };
}

export const RAT_ZERO: Rational = { n: 0, d: 1 };

/**
 * SUB-TICK PRECISION FOR A DERIVED SEAM.
 *
 * A seam is where a note's release landed after cuts and snap, so it is a float in the IR's tick
 * domain rather than a written tick. Quantising it to thousandths of a tick makes it storable and
 * comparable exactly, at a resolution — a millionth of a quarter note — that nothing in the
 * document can be inside of.
 */
const SEAM_DEN = 1000;

/** A derived (floating) tick, as an exact rational. See `SEAM_DEN`. */
export function ratFromTick(tick: number): Rational {
  if (!Number.isFinite(tick)) return RAT_ZERO;
  return rational(Math.round(tick * SEAM_DEN), SEAM_DEN);
}

export function ratAdd(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function ratSub(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d - b.n * a.d, a.d * b.d);
}

/** `a × (n / d)` — the shape the source-tick restatement needs. */
export function ratScale(a: Rational, n: number, d: number): Rational {
  return rational(a.n * n, a.d * d);
}

/** Negative, zero or positive, exactly — no subtraction, so no cancellation. */
export function ratCmp(a: Rational, b: Rational): number {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function ratValue(a: Rational): number {
  return a.n / a.d;
}

export function ratIsZero(a: Rational): boolean {
  return a.n === 0;
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * ONE STRUCTURAL SPLICE OF THE SCORE TIMELINE.
 *
 * `seamTick` and `deltaTick` are IR ticks in the coordinate system the operations BEFORE this one
 * produced. `id` is stable and is what the split law derives its note ids from, so a re-derivation
 * of the feed produces the same names for the same pieces.
 */
export interface RippleOp {
  id: string;
  seamTick: Rational;
  deltaTick: Rational;
  /**
   * A DURATION RIPPLE'S ATOM: the chord that was edited.
   *
   * Excluded from the shift — its attack does not move — and re-ended at `chordEndTick` instead,
   * because one written value means one release for every notehead in the stack. Absent on a bar
   * operation, which has no atom.
   */
  chordIds?: string[];
  chordEndTick?: Rational;
  /**
   * BAR INSERT: a note sounding across the seam is SPLIT there rather than sustained through the
   * inserted time. That is what makes an inserted bar genuinely empty, and it is the one place the
   * crossing rule differs from the duration ripple's — see `edit/performanceEdit.ts §BarOp`.
   */
  split?: boolean;
  /**
   * BAR DELETE: an attack inside `[seamTick, seamTick − deltaTick)` goes with the bar.
   *
   * `deltaTick` is negative on a delete, so the removed span is the seam plus its magnitude.
   */
  dropSpan?: boolean;
  /** For the undo tooltip and for probes. Never parsed. */
  label?: string;
}

/**
 * ===========================================================================================
 * A NOTE'S CANONICAL PLACEMENT — the roll's answer to "raw-only is not enough"
 * ===========================================================================================
 *
 * WHY THIS EXISTS (roll-purity critique §A "Raw-only write-back is not sufficient").
 *
 * A roll edit is written back into `source.detected.notes`, in RECORDING seconds, and every later
 * derivation of the feed re-applies the whole log to it. Two things that road cannot represent:
 *
 *   THE OLD ASSERTION. A duration ripple states `chordEndTick` for its atom absolutely, and
 *     `place()` re-states it on every derivation. A roll resize of one of those notes writes a
 *     different raw end, the next feed derivation ignores it and re-asserts the old one, and the
 *     rectangle SNAPS BACK to the written value. `unrippleNotes` says so in its own header, and
 *     called it the interim.
 *   INSERTED TIME. A point inside a bar an insert created has no pre-image in the recording at
 *     all — `undoShift` collapses it onto the seam — so a note added in the middle of an inserted
 *     bar cannot be stated in raw audio seconds even in principle. It would land on the seam.
 *
 * WHAT THIS IS. For one note, its EXACT canonical span in the tick coordinates that the operations
 * up to and including `afterOpId` produce. Those operations are already materialised into these
 * numbers and are not applied again; every LATER operation still applies normally, so a subsequent
 * sheet ripple still pushes this note exactly as it pushes every other one. That is the whole law:
 *
 *   > A roll edit changes only the selected note's canonical placement; it never rewrites
 *   > neighbouring notes.
 *
 * WHY NOT `ignoredRippleIds`. A patch that merely told `place()` to skip an op for one id would
 * fix the old assertion and could still not put a note inside inserted time, because there would
 * be no coordinate in which to say where it is. The critique is explicit: do not stop there.
 *
 * STALE BY CONSTRUCTION IS SAFE. If `afterOpId` names an operation the log no longer contains —
 * the player undid the ripple — the placement describes coordinates that no longer exist, and
 * `place()` falls back to the recording. Undo restores the log and the placement map together
 * (one `PerfStructure`), so the two can only disagree on a document edited by hand.
 */
export interface RollPlacement {
  /** IR ticks, exact, in the coordinates `afterOpId` produced. */
  startTick: Rational;
  endTick: Rational;
  /** The last operation ALREADY materialised into the ticks above. `null` = the raw feed. */
  afterOpId: string | null;
}

/** Every note that has one, by id. Persisted with the document; see `app/persist.ts`. */
export type RollPlacements = Readonly<Record<string, RollPlacement>>;

/** The tick↔seconds map, in IR ticks. `ui/app.ts` wraps the score's tempo map into this. */
export interface RippleTickMap {
  /** Feed seconds -> IR ticks. */
  toTick(sec: number): number;
  /** IR ticks -> feed seconds. */
  toSec(tick: number): number;
}

export interface RippleApplyContext {
  map: RippleTickMap;
  /** The IR's ticks per quarter — the denominator of the source-tick restatement. */
  divisions: number;
  /**
   * The name a split piece gets. Deterministic in the operation and the note, so re-deriving the
   * feed produces the same identity every time and selection, undo and playback stay pinned to it.
   */
  splitId?(opId: string, noteId: string): string;
  /** Canonical overrides, by note id. See `RollPlacement`. Absent on every un-edited document. */
  placements?: RollPlacements;
}

/** The default split name. Contains a colon, which no minted or engine id can produce. */
export function defaultSplitId(opId: string, noteId: string): string {
  return `rip:${opId}:${noteId}`;
}

/**
 * The smallest span a note may be left with, in IR ticks at `divisions`.
 *
 * ONE PRINTABLE TICK. Below this there is no glyph — `notationIntentTicks` refuses the value and
 * `pipeline/src/guards.ts` drops the note — so a shortening that would take a sustained note below
 * it is refused rather than allowed to delete a note the player did not ask to delete.
 */
const MIN_SPAN_TICKS = 1;

/** Comparisons in the tick domain, where one tick is the smallest meaningful unit. */
const TICK_EPS = 1e-6;

// ---------------------------------------------------------------------------
// Planning a duration ripple
// ---------------------------------------------------------------------------

/** A note's ENGRAVED span, tied continuations coalesced. IR ticks. */
export interface WrittenSpan {
  startTick: number;
  endTick: number;
}

export interface DurationRipplePlan {
  /** The op to append, or null when the edit is refused. */
  op: RippleOp | null;
  /** Why it was refused — a sentence, for the player. Null when it was not. */
  rejected: string | null;
}

export interface DurationRippleInput {
  /** The feed the player is looking at, AFTER cuts, snap and every earlier operation. */
  feed: ReadonlyArray<InputNote>;
  /** Every id of the struck event, from the published chord table. The atom. */
  chordIds: ReadonlyArray<string>;
  /** The written value the player picked, already in IR ticks (`notationIntentTicks`). */
  newLengthTicks: number;
  /**
   * The chord's own written span — the ENGRAVED one, tied pieces coalesced. Null when the page
   * never engraved it, in which case the derived span stands in; see `oldLengthTicks` below.
   */
  written: WrittenSpan | null;
  map: RippleTickMap;
  /** A stable name for the operation. */
  opId: string;
  label?: string;
}

/**
 * WHAT THE EDIT WOULD DO, or why it will not be done.
 *
 * The whole decision is made here, before anything is committed, because a rejection has to be a
 * refusal rather than a half-applied transaction.
 */
export function planDurationRipple(input: DurationRippleInput): DurationRipplePlan {
  const { feed, map, newLengthTicks } = input;
  const chordIds = new Set(input.chordIds);
  const members = feed.filter((n) => n.id !== undefined && chordIds.has(n.id));
  if (!members.length) return { op: null, rejected: 'That note is no longer in the take.' };
  if (!(newLengthTicks >= MIN_SPAN_TICKS)) {
    return { op: null, rejected: 'That written value has no glyph.' };
  }

  // THE SEAM IS THE EVENT'S OLD RELEASE, in the coordinates this feed is stated in. Derived rather
  // than engraved, because an engraved tick describes the page AFTER every operation already in
  // the log — replaying against it would move the same note again on every rebuild.
  const oldEndSec = Math.max(...members.map((n) => n.endSec));
  const oldStartSec = Math.min(...members.map((n) => n.startSec));
  const seam = map.toTick(oldEndSec);

  /*
   * THE OLD LENGTH IS THE WRITTEN ONE. `endSec - startSec` is articulation: a quarter note played
   * staccato is a written quarter and a performed eighth, and rippling by the difference between a
   * half and that eighth would push the rest of the score by three sixteenths too far. The engraved
   * span coalesces tied continuations, so a note tied across a barline reports its whole value.
   *
   * The fallback is the derived span, for a note the page never engraved — dropped by a guard, or
   * added since the last build. It is the only number available and it is what the next build will
   * measure anyway.
   */
  const oldLengthTicks = input.written
    ? input.written.endTick - input.written.startTick
    : seam - map.toTick(oldStartSec);
  const deltaTick = rational(Math.round(newLengthTicks - oldLengthTicks));
  if (ratIsZero(deltaTick)) return { op: null, rejected: null };

  const seamTick = ratFromTick(seam);
  const chordEndTick = ratAdd(seamTick, deltaTick);

  /*
   * THE CROSSING CHECK. A note that began before the seam and is still sounding at it keeps its
   * attack and gives up (or gains) the delta at its release. If that leaves it shorter than one
   * printable tick there is no honest answer, so the edit is refused by name.
   */
  const delta = ratValue(deltaTick);
  if (delta < 0) {
    for (const n of feed) {
      if (n.id !== undefined && chordIds.has(n.id)) continue;
      const startTick = map.toTick(n.startSec);
      const endTick = map.toTick(n.endSec);
      if (!(startTick < seam - TICK_EPS && endTick >= seam - TICK_EPS)) continue;
      if (endTick + delta - startTick < MIN_SPAN_TICKS - TICK_EPS) {
        return {
          op: null,
          rejected:
            'Shortening this note would leave a note that is still sounding across it with nothing left to print. ' +
            'Shorten that one first, or pick a longer value.'
        };
      }
    }
  }

  return {
    op: {
      id: input.opId,
      seamTick,
      deltaTick,
      chordIds: [...chordIds],
      chordEndTick,
      ...(input.label ? { label: input.label } : {})
    },
    rejected: null
  };
}

// ---------------------------------------------------------------------------
// Applying the log
// ---------------------------------------------------------------------------

/**
 * A note's endpoints under the whole log, in exact ticks.
 *
 * ONE PASS, ONE CONVERSION. The endpoints go into the tick domain once, accumulate an exact
 * rational displacement across every operation, and come back out to seconds once. Converting on
 * every operation would round a float through the tempo map n times for n edits, which is the
 * drift the log exists to avoid.
 *
 * `null` means the note is GONE — an attack inside a bar that was deleted.
 */
interface Placed {
  startTick: Rational;
  endTick: Rational;
  /** Total displacement applied to the START, for the source-tick restatement. */
  startShift: Rational;
  /** …and to the END, which differs whenever the note sustained across a seam. */
  endShift: Rational;
  /** Set when an insert split this note: the tail's span, on the far side of the seam. */
  tail?: { startTick: Rational; endTick: Rational; shift: Rational; opId: string };
}

function place(
  note: InputNote,
  ops: ReadonlyArray<RippleOp>,
  map: RippleTickMap,
  placements?: RollPlacements
): Placed | null {
  const rawStart = ratFromTick(map.toTick(note.startSec));
  const rawEnd = ratFromTick(map.toTick(note.endSec));
  let startTick = rawStart;
  let endTick = rawEnd;
  let startShift = RAT_ZERO;
  let endShift = RAT_ZERO;
  let tail: Placed['tail'];
  const id = note.id;

  /*
   * THE OVERRIDE, AND WHERE IN THE LOG IT PICKS UP. See `RollPlacement`.
   *
   * `from` is the index of the first operation that has NOT yet been materialised into the
   * override's ticks. Everything before it is skipped — including any `chordEndTick` assertion,
   * which is exactly the snap-back this fixes — and everything from it on is applied normally, so
   * a later sheet ripple still moves this note with the rest of the score.
   *
   * The displacement the source-tick restatement needs is the difference between where the note
   * is being PUT and where the recording says it is, and it is seeded here so `shiftedTiming`
   * carries the roll edit into an imported part's own ticks as well.
   */
  const override = id !== undefined && placements ? placements[id] : undefined;
  let from = 0;
  if (override) {
    const at = override.afterOpId === null ? -1 : ops.findIndex((op) => op.id === override.afterOpId);
    // A named operation that is not in this log is a placement from a future the document no
    // longer has (the ripple was undone). The recording is the only coordinate system left.
    if (override.afterOpId === null || at >= 0) {
      startTick = override.startTick;
      endTick = override.endTick;
      startShift = ratSub(startTick, rawStart);
      endShift = ratSub(endTick, rawEnd);
      from = at + 1;
    }
  }

  for (let i = from; i < ops.length; i++) {
    const op = ops[i];
    const isMate = id !== undefined && !!op.chordIds && op.chordIds.includes(id);
    if (isMate) {
      // THE ATOM. Its attack does not move for its own operation and its release is stated, not
      // shifted — one written value is one release for every notehead in the stack.
      if (op.chordEndTick) {
        endShift = ratAdd(endShift, ratSub(op.chordEndTick, endTick));
        endTick = op.chordEndTick;
      }
      continue;
    }

    if (op.dropSpan) {
      // The bar that is going takes every attack inside it.
      const to = ratSub(op.seamTick, op.deltaTick);
      if (ratCmp(startTick, op.seamTick) >= 0 && ratCmp(startTick, to) < 0) return null;
    }

    const startsAfter = ratCmp(startTick, op.seamTick) >= 0;
    const endsAfter = ratCmp(endTick, op.seamTick) >= 0;

    if (!startsAfter && endsAfter && op.split) {
      /*
       * THE SPLICE. Head stops at the seam; a tail is re-attacked on the far side with the rest of
       * the length. Sustaining through would leave the "empty" bar with a note ringing across it,
       * which is not an empty bar and not what the menu item says.
       */
      const rest = ratSub(endTick, op.seamTick);
      tail = {
        startTick: ratAdd(op.seamTick, op.deltaTick),
        endTick: ratAdd(ratAdd(op.seamTick, op.deltaTick), rest),
        shift: op.deltaTick,
        opId: op.id
      };
      endTick = op.seamTick;
      continue;
    }

    if (startsAfter) {
      startTick = ratAdd(startTick, op.deltaTick);
      startShift = ratAdd(startShift, op.deltaTick);
    }
    if (endsAfter) {
      endTick = ratAdd(endTick, op.deltaTick);
      endShift = ratAdd(endShift, op.deltaTick);
      // A DELETE MAY NOT PULL A RELEASE PAST THE ATTACK IT IS STILL SOUNDING FROM. The note loses
      // exactly the time the bar took with it and keeps what it had on the far side.
      if (op.dropSpan && ratCmp(endTick, op.seamTick) < 0) {
        endShift = ratAdd(endShift, ratSub(op.seamTick, endTick));
        endTick = op.seamTick;
      }
    }
  }

  return { startTick, endTick, startShift, endShift, tail };
}

/**
 * `sourceTiming`, restated by an EXACT tick displacement.
 *
 *     deltaSourceTicks = deltaIRTicks × sourcePPQ / divisions
 *
 * Carried rationally and rounded ONCE, at the end. Rounding each operation independently
 * accumulates error and can corrupt a tuplet, which is why the displacement arrives here as a
 * rational rather than as a number.
 */
function shiftedTiming(
  timing: InputNote['sourceTiming'],
  startShift: Rational,
  endShift: Rational,
  divisions: number
): InputNote['sourceTiming'] {
  if (!timing || !(timing.ppq > 0) || !(divisions > 0)) return timing;
  if (ratIsZero(startShift) && ratIsZero(endShift)) return timing;
  const startTick = Math.max(0, timing.startTick + Math.round(ratValue(ratScale(startShift, timing.ppq, divisions))));
  const endTick = Math.max(
    startTick + 1,
    timing.endTick + Math.round(ratValue(ratScale(endShift, timing.ppq, divisions)))
  );
  return { startTick, endTick, ppq: timing.ppq };
}

/**
 * THE LOG, APPLIED. Notes in, notes out, nothing mutated.
 *
 * A note that did not move comes back BY REFERENCE, so an un-rippled document hands the very array
 * it was given straight through — which is what lets `App.performanceFeed()` keep its promise that
 * playback reads the take's own notes when nothing is in the way.
 */
export function applyRippleOps(
  notes: ReadonlyArray<InputNote>,
  ops: ReadonlyArray<RippleOp>,
  ctx: RippleApplyContext
): InputNote[] {
  if (!ops.length || !notes.length) return notes as InputNote[];
  const splitId = ctx.splitId ?? defaultSplitId;
  const out: InputNote[] = [];
  for (const note of notes) {
    const placed = place(note, ops, ctx.map, ctx.placements);
    if (!placed) continue;
    const startSec = ctx.map.toSec(ratValue(placed.startTick));
    const endSec = ctx.map.toSec(ratValue(placed.endTick));
    const moved = startSec !== note.startSec || endSec !== note.endSec;
    const timing = shiftedTiming(note.sourceTiming, placed.startShift, placed.endShift, ctx.divisions);
    out.push(
      moved || timing !== note.sourceTiming
        ? { ...note, startSec, endSec, ...(timing ? { sourceTiming: timing } : {}) }
        : note
    );
    if (placed.tail && note.id) {
      const tailTiming = shiftedTiming(note.sourceTiming, placed.tail.shift, placed.tail.shift, ctx.divisions);
      const tail: InputNote = {
        ...note,
        id: splitId(placed.tail.opId, note.id),
        startSec: ctx.map.toSec(ratValue(placed.tail.startTick)),
        endSec: ctx.map.toSec(ratValue(placed.tail.endTick)),
        ...(tailTiming ? { sourceTiming: tailTiming } : {})
      };
      // The tail is a NEW note: the written value the player chose was chosen for a note of a
      // different length, so it does not travel.
      delete (tail as { notationIntent?: unknown }).notationIntent;
      out.push(tail);
    }
  }
  out.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  return out;
}

/**
 * THE LOG, RUN BACKWARDS — a feed second, in the coordinates the RECORDING is stated in.
 *
 * WHY THIS EXISTS, and it is the same reason `editedToAudioSec` exists one layer down. Every
 * ordinary edit — add a note, drag a notehead, resize a rectangle — is made against the picture
 * the player is looking at, which is the feed, and is written back into `source.detected.notes`,
 * which is not. Cuts already had an inverse for exactly this. Without one for the ripple, a note
 * added at bar 2 of a score that has been lengthened is stored at bar 2 of the RECORDING, and the
 * next derivation of the feed applies the log to it and pushes it somewhere else — so the note
 * lands under a different pixel from the one that was clicked, one frame later.
 *
 * MONOTONE AND EXACT. Each operation maps `t < seam` to itself and `t >= seam` to `t + delta`, so
 * the inverse is that read the other way, applied in reverse order. The one place it is not a
 * bijection is INSIDE inserted time (`seam <= p < seam + delta`), which has no pre-image at all —
 * a point in a bar that did not exist. That resolves to the seam, which is where the material on
 * either side of it agrees.
 *
 * THE ATOM IS SKIPPED. A chord member's attack was never shifted by its own operation and its
 * release was STATED rather than moved, so there is nothing to run backwards for it: its recorded
 * span is still its recorded span.
 *
 * WHAT THAT COSTS, STATED RATHER THAN HIDDEN. A ROLL RESIZE of a note the log has already stated an
 * end for is overridden by the log on the next derivation — the rectangle snaps back to the written
 * value. That is the safe direction (the sheet and the roll never disagree, and nothing is lost
 * from the recording), and it is the interim: the finished answer is that a roll resize IS a
 * ripple, computed from the original state for the whole selection at once, which is a command
 * this file is shaped for and `ui/app.ts` does not route to yet.
 */
export function unrippleNotes(
  notes: ReadonlyArray<InputNote>,
  ops: ReadonlyArray<RippleOp>,
  map: RippleTickMap
): InputNote[] {
  if (!ops.length || !notes.length) return notes as InputNote[];
  return notes.map((note) => {
    const id = note.id;
    let startTick = ratFromTick(map.toTick(note.startSec));
    let endTick = ratFromTick(map.toTick(note.endSec));
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (id !== undefined && op.chordIds?.includes(id)) continue;
      startTick = undoShift(startTick, op);
      endTick = undoShift(endTick, op);
    }
    const startSec = map.toSec(ratValue(startTick));
    const endSec = map.toSec(ratValue(endTick));
    if (startSec === note.startSec && endSec === note.endSec) return note;
    return { ...note, startSec, endSec: Math.max(startSec, endSec) };
  });
}

/**
 * MINT THE OVERRIDES FOR ONE ROLL EDIT — the notes the player authored, pinned where they landed.
 *
 * Called from `App.applyRollEdit` with the notes AS THE PLAYER LEFT THEM (feed seconds, after the
 * whole log), so the ticks recorded here are exactly the ticks that were on screen. `afterOpId` is
 * the last operation in the log at the moment of the edit: everything up to it is already in these
 * numbers, everything after it has not happened yet.
 *
 * ONLY WHEN THERE IS A LOG. On an un-rippled document the recording IS the canonical coordinate
 * system, raw write-back is exact, and an override would be a second authority saying the same
 * thing — so `ops` empty returns the map unchanged and every existing document keeps the road it
 * has always taken.
 *
 * Existing entries for ids that are no longer in the feed are dropped: a placement for a note the
 * player deleted is a fact about nothing, and would come back to life if the id were ever reused.
 */
export function withRollPlacements(
  previous: RollPlacements | undefined,
  feed: ReadonlyArray<InputNote>,
  authoredIds: ReadonlyArray<string>,
  ops: ReadonlyArray<RippleOp>,
  map: RippleTickMap
): RollPlacements | undefined {
  if (!ops.length) return previous;
  const alive = new Set<string>();
  for (const n of feed) if (n.id !== undefined) alive.add(n.id);

  const next: Record<string, RollPlacement> = {};
  for (const [id, placement] of Object.entries(previous ?? {})) {
    if (alive.has(id)) next[id] = placement;
  }

  const afterOpId = ops[ops.length - 1].id;
  const byId = new Map(feed.filter((n) => n.id !== undefined).map((n) => [n.id as string, n]));
  for (const id of authoredIds) {
    const note = byId.get(id);
    if (!note) continue;
    next[id] = {
      startTick: ratFromTick(map.toTick(note.startSec)),
      endTick: ratFromTick(map.toTick(note.endSec)),
      afterOpId
    };
  }
  return Object.keys(next).length ? next : undefined;
}

function undoShift(t: Rational, op: RippleOp): Rational {
  const after = ratAdd(op.seamTick, op.deltaTick);
  if (ratCmp(t, after) >= 0) return ratSub(t, op.deltaTick);
  // Inside time an insert created: there is no pre-image, so it collapses onto the seam.
  if (ratCmp(t, op.seamTick) > 0) return op.seamTick;
  return t;
}

/**
 * EVERY ID THE LOG MOVES, for a given feed — the `writebackIds` half of the touched contract.
 *
 * Not used to write anything back into the recording (the whole point of the log is that nothing
 * is), but the roll, the selection and the probes all need to be able to say what a ripple did.
 */
export function rippleMovedIds(
  notes: ReadonlyArray<InputNote>,
  ops: ReadonlyArray<RippleOp>,
  map: RippleTickMap,
  placements?: RollPlacements
): Set<string> {
  const out = new Set<string>();
  if (!ops.length) return out;
  for (const note of notes) {
    if (!note.id) continue;
    const placed = place(note, ops, map, placements);
    if (!placed) {
      out.add(note.id);
      continue;
    }
    if (!ratIsZero(placed.startShift) || !ratIsZero(placed.endShift) || placed.tail) out.add(note.id);
  }
  return out;
}

/**
 * WHERE THE DOCUMENT NOW ENDS, in exact IR ticks.
 *
 * `documentBars` is a FLOOR and stays one — `BuildInput.minimumBars` is documented as "at least
 * this many bars", and an integer bar count cannot represent a quarter-note structural change
 * inside 4/4 anyway. This is the other half: the structural end the operations produced, which is
 * what the shared viewport and the snap bound need BEFORE a rebuild has re-measured the score.
 *
 * Growth only follows a positive delta past the end; a shortening reduces it but never below the
 * material, which the caller supplies as `contentEndTick`.
 */
export function rippleEndTick(
  ops: ReadonlyArray<RippleOp>,
  baseEndTick: Rational,
  contentEndTick: number
): Rational {
  let end = baseEndTick;
  for (const op of ops) {
    if (ratCmp(end, op.seamTick) >= 0) end = ratAdd(end, op.deltaTick);
  }
  const floor = ratFromTick(contentEndTick);
  return ratCmp(end, floor) < 0 ? floor : end;
}

// ---------------------------------------------------------------------------
// The bar map an imported symbolic part is engraved against
// ---------------------------------------------------------------------------

type SourceBars = NonNullable<InputNote['sourceBars']>;

/**
 * A BAR OPERATION MOVES THE RULER, NOT ONLY THE NOTES.
 *
 * `InputNote.sourceBars` is the exact symbolic bar map an imported score carries, and
 * `pipeline/src/buildScore.ts` engraves against it whenever every note of an event has
 * `sourceTiming`. Shifting the notes' seconds and leaving that map alone is the audit's bar-op
 * critical: the notes move, the ruler does not, and the exact-symbolic path puts every one of them
 * straight back into the bar it came from — a bar operation that visually does nothing.
 *
 * So an insert splices a bar of the same meter into the map at the seam and pushes every later
 * bar's `startTick` on by its length; a delete removes the bar the seam is in and pulls the rest
 * back. Bar NUMBERS are renumbered in sequence, because a map with two bar 4s is not a map.
 */
export function spliceSourceBars(
  bars: SourceBars,
  kind: 'insertBar' | 'deleteBar',
  seamSourceTick: number
): SourceBars {
  if (!bars.length) return bars;
  const sorted = [...bars].sort((a, b) => a.startTick - b.startTick);
  const at = sorted.findIndex((b) => b.startTick >= seamSourceTick - 0.5);
  const index = at < 0 ? sorted.length : at;

  if (kind === 'insertBar') {
    const model = sorted[Math.min(index, sorted.length - 1)];
    const inserted = {
      ...model,
      startTick: index < sorted.length ? sorted[index].startTick : model.startTick + model.durationTicks,
      implicit: false
    };
    const out = [
      ...sorted.slice(0, index),
      inserted,
      ...sorted.slice(index).map((b) => ({ ...b, startTick: b.startTick + inserted.durationTicks }))
    ];
    return renumber(out);
  }

  if (index >= sorted.length) return sorted;
  const removed = sorted[index];
  const out = [
    ...sorted.slice(0, index),
    ...sorted.slice(index + 1).map((b) => ({ ...b, startTick: b.startTick - removed.durationTicks }))
  ];
  return renumber(out.length ? out : sorted);
}

function renumber(bars: SourceBars): SourceBars {
  let number = 0;
  return bars.map((b) => (b.implicit ? b : { ...b, number: ++number }));
}
