/**
 * Roll gestures -> a new performance.
 *
 * `view/pianoroll.ts` only ever ASKS (invariant 8): a drag emits a `RollEdit` in written
 * score seconds and stops there. This is the one place that turns such a request into the
 * note list the pipeline is re-run over. It lives outside `ui/app.ts` because it is pure —
 * notes in, notes out — and because that is what makes it testable without a DOM
 * (`scripts/midi-import-test.ts`).
 *
 * NOTES ARE REPLACED, NEVER MUTATED: the undo stack holds arrays of references, so mutating
 * one in place would silently rewrite history as well as the present.
 */

import type { InputNote } from '@pipeline';
import type { RollEdit } from '../view/pianoroll';

export interface RollEditContext {
  /** Written second 0 on the recording's clock — `scoreOriginSec()`. */
  originSec: number;
  /** The score's tempo. The roll snapped this gesture against the same number. */
  tempoBpm: number;
  /** A fresh id for a note the player adds. Never collides with the engine's `n<index>` ids. */
  newNoteId: () => string;
  /**
   * THE SCORE'S TICK↔SECONDS MAP, and it supersedes `tempoBpm` for every source-tick restatement
   * below (roll-purity critique §A.5).
   *
   * `ticksPerSec()` multiplies by ONE scalar BPM. That is exact for a score with one tempo and
   * wrong everywhere past a tempo change, with an error that grows with distance — the same
   * defect `edit/ripple.ts` was written to avoid and says so in its header ("the scalar helpers
   * in `edit/rollPerformance.ts` are wrong for this operation and are not used by it"). A note
   * resized after a rallentando was restated at the wrong number of source ticks, so the sheet
   * printed a length the roll did not show.
   *
   * `toTick` is FEED seconds to IR ticks; `divisions` is the IR's ticks per quarter, which is the
   * denominator of the restatement `deltaSourceTicks = deltaIRTicks × ppq / divisions`.
   *
   * OPTIONAL, and the fallback is exactly the old arithmetic: a caller with no score — the unit
   * tests, and any road that runs before the first build — keeps the scalar behaviour it had.
   */
  scoreTicks?: { toTick(sec: number): number; divisions: number };
}

export interface RollEditResult {
  notes: InputNote[];
  label: string;
  /**
   * THE IDS THE PLAYER AUTHORED, stated by the reducer rather than inferred from the command
   * (roll-purity critique §A "Authored-ID contract").
   *
   * `rollEditNoteIds(edit)` cannot answer this for an `add`: the command carries no id because
   * the id does not exist until this function mints one, so it returned `[]` and the new note was
   * never entered into `App.userTouchedIds` — the auto-edit pass went on treating a note the
   * player had drawn by hand as fair game, and the write-back merge kept it only by the accident
   * that it has no raw counterpart to be overwritten from.
   *
   * The reducer is the only thing that knows, so the reducer says. For every other variant this is
   * the same set `rollEditNoteIds` returns, minus the ids that were not actually in the take.
   */
  authoredIds: string[];
}

/**
 * A floor rather than a free-for-all: the guards drop anything under 30 ms as an artefact
 * (§4.8), so a shorter note would be deleted by the next rebuild and the player would watch
 * their own edit disappear.
 */
export const MIN_DUR_SEC = 0.04;

/** MIDI note numbers only. A drag past either end stops at the end rather than wrapping. */
export function clampMidi(midi: number): number {
  return Math.max(0, Math.min(127, Math.round(midi)));
}

export const byTimeThenPitch = (a: InputNote, b: InputNote): number =>
  a.startSec - b.startSec || a.midi - b.midi;

// ---------------------------------------------------------------------------
// Exact source timing — the edit is the new truth
// ---------------------------------------------------------------------------
//
// A symbolic import (MIDI / MusicXML / Guitar Pro) hangs `sourceTiming` — the note's written
// position in the SOURCE FILE'S OWN ticks, `{ startTick, endTick, ppq }` — on every note, and
// pipeline/src/buildScore.ts reads those ticks INSTEAD OF the seconds whenever every note has
// them: the quantizer is forced to 'free' and the gap filler is switched off, so an import is
// engraved exactly as it was written.
//
// That makes the seconds a note's edit updates invisible, and the predicate all-or-nothing:
//
//   - a move/resize that leaves the old ticks behind is simply not engraved. The player drags
//     a note and the sheet does not change.
//   - a note ADDED without ticks makes the predicate false for the WHOLE score, so one new
//     note silently requantizes every other note in the import.
//
// So a manual edit rewrites the ticks too. The user's gesture is the new exact truth, the
// predicate stays true, and no note ends up on a different quantization rule from its
// neighbours. Ticks per second come from the score's tempo — the same number `PianoRoll.snapSec`
// snapped the gesture against, so a drag onto a grid line lands on that grid line's tick.
//
// `sourceTiming` carries no pitch, so a pitch-only edit has nothing to restate here; the other
// `source*` fields (clef, staff, transposition) describe the STAFF a note was written on, which
// dragging the note does not change.

export type SourceTiming = NonNullable<InputNote['sourceTiming']>;

export function ticksPerSec(tempoBpm: number, ppq: number): number {
  return ((tempoBpm || 100) / 60) * ppq;
}

/**
 * A SPAN OF FEED SECONDS, IN ONE PART'S OWN SOURCE TICKS — tempo-map aware when it can be.
 *
 * `[fromSec, toSec)` goes into the IR's tick domain ABSOLUTELY, so a span that crosses a tempo
 * change is measured on both sides of it rather than at one average rate, and the result is
 * restated in the part's ppq by the same ratio `edit/ripple.ts §shiftedTiming` uses. Without the
 * map it degrades to the scalar product this file always computed.
 */
function spanSourceTicks(
  fromSec: number,
  toSec: number,
  ppq: number,
  tempoBpm: number,
  scoreTicks: RollEditContext['scoreTicks']
): number {
  if (scoreTicks && scoreTicks.divisions > 0) {
    const irTicks = scoreTicks.toTick(toSec) - scoreTicks.toTick(fromSec);
    if (Number.isFinite(irTicks)) return (irTicks * ppq) / scoreTicks.divisions;
  }
  return (toSec - fromSec) * ticksPerSec(tempoBpm, ppq);
}

/**
 * The same note, later or earlier by `deltaSec`, in its own ticks.
 *
 * `atSec` is the note's own onset in FEED seconds — the tempo map has to be asked WHERE the shift
 * happens, not merely how big it is.
 */
export function movedTiming(
  timing: SourceTiming | undefined,
  deltaSec: number,
  tempoBpm: number,
  atSec?: number,
  scoreTicks?: RollEditContext['scoreTicks']
): SourceTiming | null {
  if (!timing || !Number.isFinite(timing.ppq) || timing.ppq <= 0) return null;
  const shift =
    atSec === undefined
      ? deltaSec * ticksPerSec(tempoBpm, timing.ppq)
      : spanSourceTicks(atSec, atSec + deltaSec, timing.ppq, tempoBpm, scoreTicks);
  const startTick = Math.max(0, Math.round(timing.startTick + shift));
  return { startTick, endTick: startTick + Math.max(1, timing.endTick - timing.startTick), ppq: timing.ppq };
}

/** The same onset, held for `durationSec` instead. */
export function resizedTiming(
  timing: SourceTiming | undefined,
  durationSec: number,
  tempoBpm: number,
  startSec?: number,
  scoreTicks?: RollEditContext['scoreTicks']
): SourceTiming | null {
  if (!timing || !Number.isFinite(timing.ppq) || timing.ppq <= 0) return null;
  const raw =
    startSec === undefined
      ? durationSec * ticksPerSec(tempoBpm, timing.ppq)
      : spanSourceTicks(startSec, startSec + durationSec, timing.ppq, tempoBpm, scoreTicks);
  const ticks = Math.max(1, Math.round(raw));
  return { startTick: timing.startTick, endTick: timing.startTick + ticks, ppq: timing.ppq };
}

/**
 * Ticks for a note the player DREW, measured off the nearest note that already has some.
 *
 * Anchored to a neighbour rather than to tick 0 because written second 0 and tick 0 are only
 * the same instant when the score has no pickup; the nearest anchor also keeps the arithmetic
 * local, so a tempo change elsewhere in the file cannot skew it.
 *
 * Null unless EVERY existing note carries ticks: below that the score is already on the
 * quantized path, and giving one note exact ticks would not put it back on the exact one.
 */
export function addedTiming(
  notes: InputNote[],
  startSec: number,
  durationSec: number,
  tempoBpm: number,
  scoreTicks?: RollEditContext['scoreTicks']
): SourceTiming | null {
  if (notes.length === 0) return null;
  let anchor: InputNote | null = null;
  for (const n of notes) {
    if (!n.sourceTiming || !Number.isFinite(n.sourceTiming.ppq) || n.sourceTiming.ppq <= 0) return null;
    if (!anchor || Math.abs(n.startSec - startSec) < Math.abs(anchor.startSec - startSec)) anchor = n;
  }
  const timing = anchor!.sourceTiming!;
  const ppq = timing.ppq;
  const startTick = Math.max(
    0,
    Math.round(timing.startTick + spanSourceTicks(anchor!.startSec, startSec, ppq, tempoBpm, scoreTicks))
  );
  const length = Math.max(1, Math.round(spanSourceTicks(startSec, startSec + durationSec, ppq, tempoBpm, scoreTicks)));
  return { startTick, endTick: startTick + length, ppq };
}

/**
 * Keep the symbolic bar/meter/tempo map alive across a delete.
 *
 * The importers hang `sourceBars` / `sourceTempoChanges` on the FIRST note of each track only
 * (one shared array, not a copy per note), and buildScore reads whichever note it finds them
 * on. Deleting that one note therefore handed the whole score back to meter detection — a
 * 3/4 import printed as 4/4 because the player removed its first note.
 */
export function keepStructureCarriers(before: InputNote[], after: InputNote[]): InputNote[] {
  const carriers = new Map<number, InputNote>();
  for (const n of before) {
    const track = n.sourceTrackIndex ?? 0;
    if ((n.sourceBars?.length || n.sourceTempoChanges?.length) && !carriers.has(track)) carriers.set(track, n);
  }
  if (carriers.size === 0) return after;

  const survivors = new Set(after);
  let out: InputNote[] | null = null;
  for (const [track, carrier] of carriers) {
    if (survivors.has(carrier)) continue;
    const list: InputNote[] = out ?? after;
    const at = list.findIndex((n) => (n.sourceTrackIndex ?? 0) === track);
    if (at < 0) continue;
    out = [...list];
    out[at] = {
      ...list[at],
      ...(carrier.sourceBars ? { sourceBars: carrier.sourceBars } : {}),
      ...(carrier.sourceTempoChanges ? { sourceTempoChanges: carrier.sourceTempoChanges } : {})
    };
  }
  return out ?? after;
}

function moved(n: InputNote, deltaSec: number, deltaSemitones: number, ctx: RollEditContext): InputNote {
  const timing = movedTiming(n.sourceTiming, deltaSec, ctx.tempoBpm, n.startSec, ctx.scoreTicks);
  return {
    ...n,
    startSec: Math.max(0, n.startSec + deltaSec),
    endSec: Math.max(0, n.endSec + deltaSec),
    midi: clampMidi(n.midi + deltaSemitones),
    ...(timing ? { sourceTiming: timing } : {})
  };
}

/**
 * The same onset, held for `durationSec` — AND WITH ANY WRITTEN-VALUE DECLARATION DROPPED.
 *
 * `notationIntent` IS CLEARED HERE, IN THE SAME TRANSACTION (roll-purity critique §A).
 *
 * The declaration means "print this note as a quarter, whatever it measures". A resize is the
 * player restating the measurement, so the two are now in contradiction and the newer one is the
 * gesture that was just made. This used to spread the note and preserve the property, so setting
 * a note to Quarter from the sheet and then dragging its rectangle to an eighth left the roll, the
 * sampler and the exported audio saying eighth while the page printed a quarter.
 *
 * WHY HERE AND NOT IN THE POST-BUILD CLEANER (`ui/app.ts §staleIntentIds`). That pass clears a
 * declaration the PIPELINE reports it could not honour, and it does so OUTSIDE history — so the
 * clearing is not part of the undo step that caused it, and it only fires when the engraved span
 * happens to disagree. An explicitly resized note should not have to wait for a heuristic to
 * notice; the reducer runs inside `commitPerformance`, so the drop travels with the resize and
 * ⌘Z puts the declaration back with the length it belonged to.
 *
 * MOVES ARE NOT TOUCHED, deliberately. Sliding a note later or transposing it changes neither its
 * written value nor the claim about it; only a length edit contradicts a length declaration.
 */
function resized(n: InputNote, durationSec: number, ctx: RollEditContext): InputNote {
  const timing = resizedTiming(n.sourceTiming, durationSec, ctx.tempoBpm, n.startSec, ctx.scoreTicks);
  const next: InputNote = {
    ...n,
    endSec: n.startSec + durationSec,
    ...(timing ? { sourceTiming: timing } : {})
  };
  delete (next as { notationIntent?: unknown }).notationIntent;
  return next;
}

export function applyRollEditToNotes(
  notes: InputNote[],
  edit: RollEdit,
  ctx: RollEditContext
): RollEditResult | null {
  /** Only the ids this call actually FOUND — a command naming a note the take lost authored nothing. */
  const present = (ids: ReadonlyArray<string>): string[] => {
    const have = new Set(notes.map((n) => n.id ?? ''));
    return ids.filter((id) => have.has(id));
  };

  switch (edit.kind) {
    case 'move': {
      const next = notes.map((n) => (n.id === edit.noteId ? moved(n, edit.deltaSec, edit.deltaSemitones, ctx) : n));
      return {
        notes: next,
        label: edit.deltaSemitones !== 0 ? 'Move note' : 'Nudge note',
        authoredIds: present([edit.noteId])
      };
    }
    case 'resize': {
      const next = notes.map((n) =>
        n.id === edit.noteId ? resized(n, Math.max(MIN_DUR_SEC, edit.newDurationSec), ctx) : n
      );
      return { notes: next, label: 'Change length', authoredIds: present([edit.noteId]) };
    }
    case 'add': {
      const startSec = Math.max(0, edit.startSec + ctx.originSec);
      const durationSec = Math.max(MIN_DUR_SEC, edit.durationSec);
      const timing = addedTiming(notes, startSec, durationSec, ctx.tempoBpm, ctx.scoreTicks);
      const added: InputNote = {
        id: ctx.newNoteId(),
        startSec,
        endSec: startSec + durationSec,
        midi: clampMidi(edit.midi),
        ...(timing ? { sourceTiming: timing } : {})
      };
      // THE ONE COMMAND WHOSE ID DID NOT EXIST WHEN IT WAS ISSUED. This is why authorship is
      // reported out of the reducer rather than read off the command — see `RollEditResult`.
      return { notes: [...notes, added].sort(byTimeThenPitch), label: 'Add note', authoredIds: [added.id!] };
    }
    case 'delete': {
      const next = notes.filter((n) => n.id !== edit.noteId);
      if (next.length === notes.length) return null;
      return {
        notes: keepStructureCarriers(notes, next),
        label: 'Delete note',
        authoredIds: [edit.noteId]
      };
    }

    // --- the same three, for a whole selection -------------------------------------------
    // One gesture, one entry in the history. The roll emits ONE of these rather than N
    // single-note edits precisely so that ⌘Z undoes what the player did, not one seventh of it.
    case 'moveMany': {
      const ids = new Set(edit.noteIds);
      const next = notes
        .map((n) => (ids.has(n.id ?? '') ? moved(n, edit.deltaSec, edit.deltaSemitones, ctx) : n))
        // A group move can reorder the list — the notes it moved may now start after ones it
        // did not. Everything downstream assumes this array is in time order.
        .sort(byTimeThenPitch);
      return {
        notes: next,
        label:
          edit.deltaSemitones !== 0
            ? `Move ${edit.noteIds.length} notes`
            : `Nudge ${edit.noteIds.length} notes`,
        authoredIds: present(edit.noteIds)
      };
    }
    case 'resizeMany': {
      // A DELTA, not a length: the notes in a selection are different lengths and the player
      // dragged one edge by an amount, not to a value. EVERY member drops its `notationIntent`,
      // one at a time and in this same transaction — see `resized`.
      const ids = new Set(edit.noteIds);
      const next = notes.map((n) =>
        ids.has(n.id ?? '')
          ? resized(n, Math.max(MIN_DUR_SEC, n.endSec - n.startSec + edit.deltaSec), ctx)
          : n
      );
      return { notes: next, label: `Change ${edit.noteIds.length} lengths`, authoredIds: present(edit.noteIds) };
    }
    case 'deleteMany': {
      const ids = new Set(edit.noteIds);
      const next = notes.filter((n) => !ids.has(n.id ?? ''));
      if (next.length === notes.length) return null;
      return {
        notes: keepStructureCarriers(notes, next),
        label: `Delete ${notes.length - next.length} notes`,
        authoredIds: [...edit.noteIds]
      };
    }
    default:
      return null;
  }
}
