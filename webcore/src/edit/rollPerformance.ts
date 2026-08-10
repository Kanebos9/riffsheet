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
}

export interface RollEditResult {
  notes: InputNote[];
  label: string;
}

/**
 * A floor rather than a free-for-all: the guards drop anything under 30 ms as an artefact
 * (§4.8), so a shorter note would be deleted by the next rebuild and the player would watch
 * their own edit disappear.
 */
const MIN_DUR_SEC = 0.04;

/** MIDI note numbers only. A drag past either end stops at the end rather than wrapping. */
export function clampMidi(midi: number): number {
  return Math.max(0, Math.min(127, Math.round(midi)));
}

const byTimeThenPitch = (a: InputNote, b: InputNote): number =>
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

type SourceTiming = NonNullable<InputNote['sourceTiming']>;

function ticksPerSec(tempoBpm: number, ppq: number): number {
  return ((tempoBpm || 100) / 60) * ppq;
}

/** The same note, later or earlier by `deltaSec`, in its own ticks. */
function movedTiming(timing: SourceTiming | undefined, deltaSec: number, tempoBpm: number): SourceTiming | null {
  if (!timing || !Number.isFinite(timing.ppq) || timing.ppq <= 0) return null;
  const startTick = Math.max(0, Math.round(timing.startTick + deltaSec * ticksPerSec(tempoBpm, timing.ppq)));
  return { startTick, endTick: startTick + Math.max(1, timing.endTick - timing.startTick), ppq: timing.ppq };
}

/** The same onset, held for `durationSec` instead. */
function resizedTiming(timing: SourceTiming | undefined, durationSec: number, tempoBpm: number): SourceTiming | null {
  if (!timing || !Number.isFinite(timing.ppq) || timing.ppq <= 0) return null;
  const ticks = Math.max(1, Math.round(durationSec * ticksPerSec(tempoBpm, timing.ppq)));
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
function addedTiming(
  notes: InputNote[],
  startSec: number,
  durationSec: number,
  tempoBpm: number
): SourceTiming | null {
  if (notes.length === 0) return null;
  let anchor: InputNote | null = null;
  for (const n of notes) {
    if (!n.sourceTiming || !Number.isFinite(n.sourceTiming.ppq) || n.sourceTiming.ppq <= 0) return null;
    if (!anchor || Math.abs(n.startSec - startSec) < Math.abs(anchor.startSec - startSec)) anchor = n;
  }
  const timing = anchor!.sourceTiming!;
  const perSec = ticksPerSec(tempoBpm, timing.ppq);
  const startTick = Math.max(0, Math.round(timing.startTick + (startSec - anchor!.startSec) * perSec));
  return { startTick, endTick: startTick + Math.max(1, Math.round(durationSec * perSec)), ppq: timing.ppq };
}

/**
 * Keep the symbolic bar/meter/tempo map alive across a delete.
 *
 * The importers hang `sourceBars` / `sourceTempoChanges` on the FIRST note of each track only
 * (one shared array, not a copy per note), and buildScore reads whichever note it finds them
 * on. Deleting that one note therefore handed the whole score back to meter detection — a
 * 3/4 import printed as 4/4 because the player removed its first note.
 */
function keepStructureCarriers(before: InputNote[], after: InputNote[]): InputNote[] {
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

function moved(n: InputNote, deltaSec: number, deltaSemitones: number, tempoBpm: number): InputNote {
  const timing = movedTiming(n.sourceTiming, deltaSec, tempoBpm);
  return {
    ...n,
    startSec: Math.max(0, n.startSec + deltaSec),
    endSec: Math.max(0, n.endSec + deltaSec),
    midi: clampMidi(n.midi + deltaSemitones),
    ...(timing ? { sourceTiming: timing } : {})
  };
}

function resized(n: InputNote, durationSec: number, tempoBpm: number): InputNote {
  const timing = resizedTiming(n.sourceTiming, durationSec, tempoBpm);
  return {
    ...n,
    endSec: n.startSec + durationSec,
    ...(timing ? { sourceTiming: timing } : {})
  };
}

export function applyRollEditToNotes(
  notes: InputNote[],
  edit: RollEdit,
  ctx: RollEditContext
): RollEditResult | null {
  switch (edit.kind) {
    case 'move': {
      const next = notes.map((n) =>
        n.id === edit.noteId ? moved(n, edit.deltaSec, edit.deltaSemitones, ctx.tempoBpm) : n
      );
      return { notes: next, label: edit.deltaSemitones !== 0 ? 'Move note' : 'Nudge note' };
    }
    case 'resize': {
      const next = notes.map((n) =>
        n.id === edit.noteId
          ? resized(n, Math.max(MIN_DUR_SEC, edit.newDurationSec), ctx.tempoBpm)
          : n
      );
      return { notes: next, label: 'Change length' };
    }
    case 'add': {
      const startSec = Math.max(0, edit.startSec + ctx.originSec);
      const durationSec = Math.max(MIN_DUR_SEC, edit.durationSec);
      const timing = addedTiming(notes, startSec, durationSec, ctx.tempoBpm);
      const added: InputNote = {
        id: ctx.newNoteId(),
        startSec,
        endSec: startSec + durationSec,
        midi: clampMidi(edit.midi),
        ...(timing ? { sourceTiming: timing } : {})
      };
      return { notes: [...notes, added].sort(byTimeThenPitch), label: 'Add note' };
    }
    case 'delete': {
      const next = notes.filter((n) => n.id !== edit.noteId);
      if (next.length === notes.length) return null;
      return { notes: keepStructureCarriers(notes, next), label: 'Delete note' };
    }

    // --- the same three, for a whole selection -------------------------------------------
    // One gesture, one entry in the history. The roll emits ONE of these rather than N
    // single-note edits precisely so that ⌘Z undoes what the player did, not one seventh of it.
    case 'moveMany': {
      const ids = new Set(edit.noteIds);
      const next = notes
        .map((n) => (ids.has(n.id ?? '') ? moved(n, edit.deltaSec, edit.deltaSemitones, ctx.tempoBpm) : n))
        // A group move can reorder the list — the notes it moved may now start after ones it
        // did not. Everything downstream assumes this array is in time order.
        .sort(byTimeThenPitch);
      return {
        notes: next,
        label:
          edit.deltaSemitones !== 0
            ? `Move ${edit.noteIds.length} notes`
            : `Nudge ${edit.noteIds.length} notes`
      };
    }
    case 'resizeMany': {
      // A DELTA, not a length: the notes in a selection are different lengths and the player
      // dragged one edge by an amount, not to a value.
      const ids = new Set(edit.noteIds);
      const next = notes.map((n) =>
        ids.has(n.id ?? '')
          ? resized(n, Math.max(MIN_DUR_SEC, n.endSec - n.startSec + edit.deltaSec), ctx.tempoBpm)
          : n
      );
      return { notes: next, label: `Change ${edit.noteIds.length} lengths` };
    }
    case 'deleteMany': {
      const ids = new Set(edit.noteIds);
      const next = notes.filter((n) => !ids.has(n.id ?? ''));
      if (next.length === notes.length) return null;
      return { notes: keepStructureCarriers(notes, next), label: `Delete ${notes.length - next.length} notes` };
    }
    default:
      return null;
  }
}
