/**
 * SHEET GESTURES -> A NEW PERFORMANCE. The write-through road, and the only one.
 *
 * WHY THIS EXISTS RATHER THAN `commitPerformance()` CALLS FROM THE SHEET. There are three
 * representations of one take and they are not interchangeable:
 *
 *   RAW      `source.detected.notes` — the recording's own seconds, preserved underneath
 *            everything so that the snap layer and the cut list stay reversible.
 *   FEED     `App.performanceFeed()` — raw with the cuts closed up and the snap applied. This
 *            is what the roll draws and what the sheet is engraved from, so it is what the
 *            player is pointing AT.
 *   SCORE    the engraved page, where a note may be several tied glyphs.
 *
 * `commitPerformance()` is a storage and undo sink: it replaces raw wholesale. Handing it the
 * FEED — which is the obvious thing for an editing surface to do — costs the player two things
 * silently. Every snapped note's grid position is promoted into the recording, so the snap can
 * never be switched off again; and every note whose attack is inside a cut is missing from the
 * feed, so it is deleted the first time anything is dragged. `applyRollEdit()` already solves
 * this for the roll by merging back only the notes the gesture NAMED. This file is that road,
 * generalised, so the sheet uses it rather than growing a second one that is subtly different.
 *
 * THE SHAPE, and every arrow is one function here:
 *
 *   a sheet command
 *     -> pure reducer over the FEED          `applySheetEditToNotes`
 *     -> { notes, touchedIds, label }
 *     -> cut/snap-aware merge back into RAW  `mergePerformanceEdit`
 *     -> one transactional undo step         (the caller's `commitPerformance`)
 *     -> rebuild
 *
 * TOUCHED IDS ARE EXPLICIT, AND THAT IS THE POINT. The roll infers them from the command, which
 * works only because a roll gesture never changes a note it did not name. A sheet edit does: the
 * collision law trims whatever a moved note lands inside, and that victim is not in the command.
 * Inferring would send the victim's raw note back unchanged, so the trim would appear on screen
 * and then vanish on the next rebuild. Every function here returns the victims by name.
 *
 * PURE, so the whole law is testable without a DOM — see scripts/sheet-edit-test.ts.
 */

import type { InputNote, NotationIntent } from '@pipeline';
import type { CutSpan } from './cuts';
import { editedToAudioSec } from './cuts';
import {
  MIN_DUR_SEC,
  addedTiming,
  byTimeThenPitch,
  keepStructureCarriers,
  movedTiming,
  resizedTiming
} from './rollPerformance';

/** Seconds below which two times are the same instant. A chord is not a collision. */
const EPS = 1e-6;

/**
 * One edit, in the DERIVED domain the player was looking at.
 *
 * Seconds are FEED seconds (cuts closed up, snap applied), not recording seconds: the caller
 * maps them back. That is deliberate — a command written in recording seconds would have to be
 * built by a caller that already knew about cuts, which is the coupling this file removes.
 */
export type SheetEdit =
  | {
      /**
       * The written value the player picked off the duration menu.
       *
       * BOTH halves are written, and they are not the same claim. `notationIntent` tells the
       * pipeline what to PRINT (it survives the quantizer's grid, which a change to `endSec`
       * would not); `endSec` tells the roll and the sampler how long it now SOUNDS. Writing only
       * the first would leave the roll drawing the old rectangle under the new glyph.
       */
      kind: 'setDuration';
      noteId: string;
      intent: NotationIntent;
    }
  | { kind: 'deleteNote'; noteId: string }
  | {
      /** Drawn on an empty notation staff: a pitch, an onset, and a length to try for. */
      kind: 'addNote';
      midi: number;
      startSec: number;
      durationSec: number;
    }
  | {
      /** A horizontal notehead drag: the same note, attacked somewhere else. */
      kind: 'moveNote';
      noteId: string;
      startSec: number;
    };

export interface SheetEditContext {
  /** Written second 0 on the take's clock — `App.scoreOriginSec()`. */
  originSec: number;
  /** The score's tempo. Only used for the tick restatement a symbolic import needs. */
  tempoBpm: number;
  /** A fresh id for an added note. Never collides with the engine's `n<index>` ids. */
  newNoteId: () => string;
  /**
   * How long `intent` lasts if it starts at `startSec`, in feed seconds — or null when the
   * intent names nothing printable (a dotted 1/32; see `notationIntentTicks`).
   *
   * A FUNCTION rather than a BPM, because the answer is not a scalar: past a tempo change a
   * written quarter is a different number of seconds, and `tickToSeconds`/`secondsToTick` in
   * ui/app.ts already walk the score's tempo map. Passing a bpm would reintroduce exactly the
   * error `edit/rollPerformance.ts` still has on `sourceTiming`.
   */
  intentLengthSec: (startSec: number, intent: NotationIntent) => number | null;
}

export interface SheetEditResult {
  notes: InputNote[];
  /**
   * EVERY id whose raw note must be replaced by the edited one — the notes the command named
   * AND every collision victim. See the file note: this is the field the roll's road lacks.
   */
  touchedIds: Set<string>;
  label: string;
}

/**
 * THE COLLISION LAW, applied once and named. One voice cannot hold two notes at once.
 *
 * Four cases, spelled out because "the existing collision rule" is an engraving-time clamp
 * (pipeline/src/simplify.ts) that never touches the performance list, so nothing here can be
 * inherited:
 *
 *   SAME ONSET      a chord, not a collision. Two notes attacked at the same instant are how a
 *                   double stop is written; trimming one of them would delete the chord.
 *   ACTIVE OVERRUNS the moved/lengthened note's own end stops at the next LATER attack. This is
 *                   the same rule the engraver would apply anyway, applied here as well so the
 *                   roll's rectangle and the printed glyph agree before the rebuild rather than
 *                   after it.
 *   LANDED INSIDE   a note already sounding when the active one attacks is trimmed AT that
 *                   attack, and NAMED — that is the whole reason `touchedIds` is explicit.
 *   COLLAPSE        a victim is never deleted by a trim. It keeps `MIN_DUR_SEC`, which is the
 *                   floor pipeline/src/guards.ts drops notes below; shortening it further would
 *                   make the next rebuild remove a note the player never asked to remove.
 *
 * NO CHAIN REACTIONS, enforced rather than assumed: victims are computed against the note list
 * as it stood BEFORE this edit, and a victim is never itself treated as active, so trimming B
 * cannot go on to trim C.
 */
function settleCollisions(
  after: InputNote[],
  activeIds: ReadonlySet<string>,
  touched: Set<string>,
  tempoBpm: number
): InputNote[] {
  const out = after.slice();
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    if (!a.id || !activeIds.has(a.id)) continue;

    // ACTIVE OVERRUNS: the next attack that is genuinely later, chords excepted.
    let end = a.endSec;
    for (const b of out) {
      if (b === a || (b.id && activeIds.has(b.id))) continue;
      if (b.startSec > a.startSec + EPS && b.startSec < end - EPS) end = b.startSec;
    }
    if (Math.abs(end - a.endSec) > EPS) {
      out[i] = resize(a, Math.max(MIN_DUR_SEC, end - a.startSec), tempoBpm);
    }

    // LANDED INSIDE: whatever was already sounding when this attacked.
    for (let j = 0; j < out.length; j++) {
      const b = out[j];
      if (j === i || !b.id || activeIds.has(b.id)) continue;
      if (b.startSec < a.startSec - EPS && b.endSec > a.startSec + EPS) {
        out[j] = resize(b, Math.max(MIN_DUR_SEC, a.startSec - b.startSec), tempoBpm);
        touched.add(b.id);
      }
    }
  }
  return out;
}

function resize(n: InputNote, durationSec: number, tempoBpm: number): InputNote {
  const timing = resizedTiming(n.sourceTiming, durationSec, tempoBpm);
  return { ...n, endSec: n.startSec + durationSec, ...(timing ? { sourceTiming: timing } : {}) };
}

/**
 * One sheet command against the feed. Null when it names nothing this take has.
 *
 * Notes are REPLACED, never mutated: the undo stack holds arrays of references, so mutating one
 * in place would rewrite history as well as the present.
 */
export function applySheetEditToNotes(
  feed: ReadonlyArray<InputNote>,
  edit: SheetEdit,
  ctx: SheetEditContext
): SheetEditResult | null {
  const touched = new Set<string>();

  switch (edit.kind) {
    case 'setDuration': {
      const at = feed.find((n) => n.id === edit.noteId);
      if (!at) return null;
      const length = ctx.intentLengthSec(at.startSec, edit.intent);
      // Null is `notationIntentTicks` refusing the value — a dotted 1/32 has no glyph. The menu
      // greys that item out; refusing here as well means a keyboard or a probe cannot get past it.
      if (length === null || !(length > 0)) return null;
      touched.add(edit.noteId);
      const next = feed.map((n) =>
        n.id === edit.noteId
          ? { ...resize(n, Math.max(MIN_DUR_SEC, length), ctx.tempoBpm), notationIntent: edit.intent }
          : n
      );
      return {
        notes: settleCollisions(next, new Set(touched), touched, ctx.tempoBpm),
        touchedIds: touched,
        label: durationLabel(edit.intent)
      };
    }

    case 'deleteNote': {
      const next = feed.filter((n) => n.id !== edit.noteId);
      if (next.length === feed.length) return null;
      touched.add(edit.noteId);
      // A deleted note may have been the one carrying a symbolic import's bar and tempo map —
      // the importers hang those on the first note of each track only. See rollPerformance.ts.
      return { notes: keepStructureCarriers([...feed], next), touchedIds: touched, label: 'Delete note' };
    }

    case 'addNote': {
      const startSec = Math.max(0, edit.startSec);
      const durationSec = Math.max(MIN_DUR_SEC, edit.durationSec);
      const timing = addedTiming([...feed], startSec, durationSec, ctx.tempoBpm);
      const id = ctx.newNoteId();
      const added: InputNote = {
        id,
        startSec,
        endSec: startSec + durationSec,
        midi: Math.max(0, Math.min(127, Math.round(edit.midi))),
        ...(timing ? { sourceTiming: timing } : {})
      };
      touched.add(id);
      const next = [...feed, added].sort(byTimeThenPitch);
      return {
        notes: settleCollisions(next, new Set(touched), touched, ctx.tempoBpm),
        touchedIds: touched,
        label: 'Add note'
      };
    }

    case 'moveNote': {
      const at = feed.find((n) => n.id === edit.noteId);
      if (!at) return null;
      const startSec = Math.max(0, edit.startSec);
      if (Math.abs(startSec - at.startSec) <= EPS) return null;
      const deltaSec = startSec - at.startSec;
      const timing = movedTiming(at.sourceTiming, deltaSec, ctx.tempoBpm);
      touched.add(edit.noteId);
      const next = feed
        .map((n) =>
          n.id === edit.noteId
            ? {
                ...n,
                startSec,
                endSec: startSec + (n.endSec - n.startSec),
                ...(timing ? { sourceTiming: timing } : {})
              }
            : n
        )
        .sort(byTimeThenPitch);
      return {
        notes: settleCollisions(next, new Set(touched), touched, ctx.tempoBpm),
        touchedIds: touched,
        label: 'Move note'
      };
    }

    default:
      return null;
  }
}

const DURATION_NAMES: Readonly<Record<NotationIntent['denominator'], string>> = {
  1: 'whole',
  2: 'half',
  4: 'quarter',
  8: 'eighth',
  16: 'sixteenth',
  32: 'thirty-second'
};

/** "Dotted quarter note", for the undo tooltip. `undoTitle` lower-cases it, so the case is its. */
export function durationLabel(intent: NotationIntent): string {
  return `${intent.dots ? 'Dotted ' : ''}${DURATION_NAMES[intent.denominator]} note`;
}

/**
 * "Quarter" / "Dotted quarter", for the menu.
 *
 * Its own function rather than a `replace` on the label above, because the two differ in case as
 * well as in the trailing word: a menu item is a sentence start and a tooltip fragment is not.
 * Deriving one from the other by string surgery is how "Half" and "half" ended up in one list.
 */
export function durationMenuLabel(intent: NotationIntent): string {
  const name = DURATION_NAMES[intent.denominator];
  return intent.dots ? `Dotted ${name}` : `${name[0].toUpperCase()}${name.slice(1)}`;
}

// ---------------------------------------------------------------------------
// The merge back into the recording
// ---------------------------------------------------------------------------

/**
 * A performance edit, written back into a take that has cuts in it (F16).
 *
 * Moved here whole from ui/app.ts (`mergeRollEditOntoCutTake`) so that the roll's road and the
 * sheet's are the same road. The reasoning is unchanged and is worth restating, because it is
 * what stops a cut from becoming destructive:
 *
 * `mergeEditedOntoRaw` rebuilds the take out of the FEED, keeping the edited position of the
 * named notes and taking every other note from the recording. On an un-cut take the two lists
 * hold the same notes and that is exactly right. On a cut take the feed is missing every note
 * whose attack the player removed, so rebuilding from it would delete them — turning a
 * non-destructive cut into a destructive one, one gesture later, silently.
 *
 * So this walks the RECORDING instead and writes into it:
 *
 *   - a note the gesture NAMED takes the gesture's times, mapped back to audio seconds;
 *   - a named note the gesture no longer has is one it deleted, and it goes;
 *   - everything else — including every note under a cut — is left exactly as recorded;
 *   - a note the gesture INVENTED is appended, on the audio clock like the rest.
 *
 * Mapping a time back through `editedToAudioSec` resolves a seam FORWARD, so a note dragged to
 * end exactly where a cut begins is recorded as ending where the cut ENDS. That is the answer
 * that survives the cut being undone — the note comes back whole — and the alternative would
 * have the note shrink permanently the moment the player restored the tape it was pinned to.
 */
export function mergePerformanceEditOntoCutTake(
  raw: ReadonlyArray<InputNote>,
  edited: ReadonlyArray<InputNote>,
  touched: ReadonlySet<string>,
  cuts: ReadonlyArray<CutSpan>
): InputNote[] {
  const editedById = new Map<string, InputNote>();
  for (const n of edited) if (n.id) editedById.set(n.id, n);
  const toAudio = (n: InputNote): InputNote => ({
    ...n,
    startSec: editedToAudioSec(n.startSec, cuts),
    endSec: editedToAudioSec(n.endSec, cuts)
  });

  const out: InputNote[] = [];
  const kept = new Set<string>();
  for (const n of raw) {
    const id = n.id;
    if (id && touched.has(id)) {
      const e = editedById.get(id);
      kept.add(id);
      if (e) out.push(toAudio(e));
      continue;
    }
    out.push(n);
    if (id) kept.add(id);
  }
  for (const n of edited) {
    if (n.id && !kept.has(n.id)) out.push(toAudio(n));
  }
  out.sort(byTimeThenPitch);
  return out;
}

// ---------------------------------------------------------------------------
// Bar operations — blank, audio-free documents only
// ---------------------------------------------------------------------------

/**
 * WHY BARS CAN ONLY BE INSERTED AND REMOVED ON A DOCUMENT WITH NO RECORDING BEHIND IT.
 *
 * Inserting a bar inserts SILENCE. On a blank score that is the whole operation: the notes after
 * the seam move later by one bar and the document gets longer. On a recorded take it is not an
 * operation at all, because the waveform does not move: the notes, the sheet and the exports
 * would all slide a bar to the right of the audio they were transcribed from, and the player
 * would hear the note a bar before they saw it.
 *
 * The cut machinery cannot help. A `CutSpan` describes tape DELETED from an immutable recording
 * and maps audio seconds onto a shorter edited clock (edit/cuts.ts); there is no way to spell
 * "and here is a second of silence that was never recorded" in it. Supporting that honestly
 * needs a real arrangement map — source segments and inserted gaps, respected by the transport,
 * the waveform, the notes, the beats, the downbeats, the host grid, persistence and every
 * export. That is a feature, not a flag, so the menu items are SHOWN and DISABLED with the
 * reason on them rather than hidden: "these exist, they do not apply to a recording".
 */
export interface BarOp {
  kind: 'insertBar' | 'deleteBar';
  /** 0-based index of the bar the menu was opened on. */
  barIndex: number;
  /** Insert only: before it, or after it. */
  where?: 'before' | 'after';
}

export interface BarOpContext {
  /** How long one bar is, in seconds, at this document's tempo and meter. */
  barLengthSec: number;
  /** How many bars the document currently declares (`SourceAudio.documentBars`). */
  barCount: number;
}

export interface BarOpResult {
  notes: InputNote[];
  touchedIds: Set<string>;
  label: string;
  /** The new declared document length, for `BuildInput.minimumBars`. */
  barCount: number;
}

/**
 * Insert or delete one bar, in the tick domain, on a blank document.
 *
 * INSERT at boundary B: every note attacked at or after B moves one bar later; earlier notes
 * keep their length, including one that is still sounding across B — an inserted bar of silence
 * does not cut a note in half, it postpones what has not started yet.
 *
 * DELETE bar [B, E): notes attacked inside it are removed; notes attacked at or after E move
 * earlier by one bar; a note that crosses the seam is clipped to B. The document never goes
 * below one bar.
 *
 * Every note whose time changed is named, because on a document with the snap on the merge would
 * otherwise restore the un-shifted raw note and the bar would appear to re-collapse.
 */
export function applyBarOp(
  feed: ReadonlyArray<InputNote>,
  op: BarOp,
  ctx: BarOpContext
): BarOpResult | null {
  const bar = ctx.barLengthSec;
  if (!(bar > 0)) return null;
  const touched = new Set<string>();

  if (op.kind === 'insertBar') {
    const at = (op.where === 'after' ? op.barIndex + 1 : op.barIndex) * bar;
    const notes = feed.map((n) => {
      if (n.startSec < at - EPS) return n;
      if (n.id) touched.add(n.id);
      return { ...n, startSec: n.startSec + bar, endSec: n.endSec + bar };
    });
    return {
      notes: notes.slice().sort(byTimeThenPitch),
      touchedIds: touched,
      label: op.where === 'after' ? 'Insert bar after' : 'Insert bar before',
      barCount: Math.min(512, ctx.barCount + 1)
    };
  }

  if (ctx.barCount <= 1) return null;
  const from = op.barIndex * bar;
  const to = from + bar;
  const notes: InputNote[] = [];
  for (const n of feed) {
    if (n.startSec >= from - EPS && n.startSec < to - EPS) {
      // Attacked inside the bar that is going: it goes with it.
      if (n.id) touched.add(n.id);
      continue;
    }
    if (n.startSec >= to - EPS) {
      if (n.id) touched.add(n.id);
      notes.push({ ...n, startSec: n.startSec - bar, endSec: n.endSec - bar });
      continue;
    }
    if (n.endSec > from + EPS) {
      // Crosses the seam: clipped at it rather than dragged shorter by a whole bar, which would
      // move its END past notes it never overlapped.
      if (n.id) touched.add(n.id);
      notes.push({ ...n, endSec: Math.max(n.startSec + MIN_DUR_SEC, from) });
      continue;
    }
    notes.push(n);
  }
  return {
    notes: keepStructureCarriers([...feed], notes).sort(byTimeThenPitch),
    touchedIds: touched,
    label: 'Delete bar',
    barCount: Math.max(1, ctx.barCount - 1)
  };
}
