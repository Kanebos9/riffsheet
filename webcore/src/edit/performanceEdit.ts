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

import { CHORD_WINDOW_MIN_SEC, type InputNote, type NotationIntent } from '@pipeline';
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

/**
 * Seconds below which two times are literally the same number — a no-op guard, nothing more.
 *
 * NOT the chord test any more, and the distinction is the whole of P1. This one answers "did
 * anything actually change" (a drag that landed where it started, an end that is already where
 * the menu wants it); it is arithmetic noise, so it stays at the float's own scale.
 */
const EPS = 1e-6;

/**
 * SECONDS WITHIN WHICH TWO ATTACKS ARE ONE CHORD. The engraver's own number (see @pipeline).
 *
 * Every simultaneity question in this file asks it: chord membership for the duration command,
 * and "same onset, so not a collision" in the settling pass. Both used to ask `EPS`, which meant
 * the reducer disagreed with the page it was editing about what a chord is — see the note on the
 * re-export in `src/pipeline/index.ts` for the fault that produced.
 */
const CHORD_SEC = CHORD_WINDOW_MIN_SEC;

/** The notes struck with this one, itself included, in the engraver's own grouping. */
function chordMates(feed: ReadonlyArray<InputNote>, at: InputNote): InputNote[] {
  return feed.filter((n) => Math.abs(n.startSec - at.startSec) <= CHORD_SEC);
}

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
 * SAME ONSET IS A CHORD, and it is now the ENGRAVER's definition of "same" (`CHORD_SEC`) rather
 * than a float epsilon. That one change is the whole of the P1 shrink loop: a double stop played
 * three milliseconds apart is one chord on the page and was two colliding notes here, so the
 * duration command clipped the note the player had just chosen a value for against its own chord
 * mate and the roll rectangle collapsed to `MIN_DUR_SEC`. Every simultaneity question in this
 * file now asks the page's own number.
 *
 * The other cases, spelled out because "the existing collision rule" is an engraving-time clamp
 * (pipeline/src/simplify.ts) that never touches the performance list, so nothing here can be
 * inherited:
 *
 *   RANG INTO IT   a note already sounding when the active one attacks is trimmed AT that
 *                  attack, and NAMED — that is the whole reason `touchedIds` is explicit.
 *   COLLAPSE       a victim is never deleted by a TRIM. It keeps `MIN_DUR_SEC`, the floor
 *                  pipeline/src/guards.ts drops notes below; shortening it further would remove
 *                  a note the player never asked to remove.
 *
 * ...and then the two commands part company, because they mean opposite things:
 *
 *   `editedWins: false` — ADD and MOVE. The active note's own end stops at the next later
 *   attack. A note DRAWN in front of an existing one becomes as long as the room it was given,
 *   which is what a player means by putting a note there; a note DRAGGED somewhere keeps its
 *   length only as far as the next thing along. Neither gesture named a length, so neither one
 *   gets to overrule one.
 *
 *   `editedWins: true` — THE DURATION MENU (P1), which named a length explicitly. The chosen
 *   value is the value the note gets and the page rearranges itself around it:
 *
 *       SWALLOWED   a neighbour that begins AND ends inside the new span is gone — there is
 *                   nothing left of it to hear. Deleted, and NAMED, so one undo brings it back
 *                   with everything else the command did.
 *       OVERLAPPED  a neighbour that begins inside the span but outlives it keeps its END and
 *                   loses its head: it attacks where the active note stops. Trimmed rather than
 *                   deleted, because there is still something of it left to play.
 *
 *   That branch is IDEMPOTENT by construction, which the unit tests and the live probe both
 *   assert: afterwards every survivor either ends at or before the active note's start or
 *   begins at or after its end, so running the same command again moves nothing.
 *
 * NO CHAIN REACTIONS, enforced rather than assumed: a victim is never itself treated as active,
 * so trimming B cannot go on to trim C.
 */
function settleCollisions(
  after: InputNote[],
  activeIds: ReadonlySet<string>,
  touched: Set<string>,
  tempoBpm: number,
  editedWins = false
): InputNote[] {
  const out = after.slice();
  const deleted = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    if (!a.id || !activeIds.has(a.id)) continue;

    if (!editedWins) {
      // ACTIVE OVERRUNS: the next attack that is genuinely later, chords excepted.
      let end = a.endSec;
      for (const b of out) {
        if (b === a || (b.id && activeIds.has(b.id))) continue;
        if (b.startSec > a.startSec + CHORD_SEC && b.startSec < end - EPS) end = b.startSec;
      }
      if (Math.abs(end - a.endSec) > EPS) {
        out[i] = resize(a, Math.max(MIN_DUR_SEC, end - a.startSec), tempoBpm);
      }
    }
    const active = out[i];

    for (let j = 0; j < out.length; j++) {
      const b = out[j];
      if (j === i || !b.id || activeIds.has(b.id) || deleted.has(b.id)) continue;

      // SAME ONSET: a chord mate of the active note, and nobody's collision.
      if (Math.abs(b.startSec - active.startSec) <= CHORD_SEC) continue;

      if (b.startSec < active.startSec) {
        // RANG INTO IT.
        if (b.endSec > active.startSec + EPS) {
          out[j] = resize(b, Math.max(MIN_DUR_SEC, active.startSec - b.startSec), tempoBpm);
          touched.add(b.id);
        }
        continue;
      }

      // Attacks at or after the active note's own end: untouched, and the reason the
      // edited-wins pass converges.
      if (!editedWins || b.startSec >= active.endSec - EPS) continue;

      if (b.endSec <= active.endSec + EPS) {
        // SWALLOWED.
        deleted.add(b.id);
        touched.add(b.id);
        continue;
      }
      // OVERLAPPED: keeps its end, attacks where the active note stops.
      out[j] = movedTo(b, active.endSec, tempoBpm);
      touched.add(b.id);
    }
  }
  return deleted.size ? out.filter((n) => !(n.id && deleted.has(n.id))) : out;
}

/** A note re-attacked at `startSec`, keeping its END rather than its length. See OVERLAPPED. */
function movedTo(n: InputNote, startSec: number, tempoBpm: number): InputNote {
  const moved = { ...n, startSec, endSec: Math.max(startSec + MIN_DUR_SEC, n.endSec) };
  const timing = movedTiming(n.sourceTiming, startSec - n.startSec, tempoBpm);
  const resized = resizedTiming(timing ?? n.sourceTiming, moved.endSec - moved.startSec, tempoBpm);
  return resized ? { ...moved, sourceTiming: resized } : moved;
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
    /**
     * A DURATION IS A PROPERTY OF THE CHORD, NOT OF THE NOTEHEAD (P1).
     *
     * Riffsheet engraves ONE VOICE, deliberately and for this version — so a stack of noteheads
     * is one rhythmic slot with one stem and one flag, and the pipeline reproduces every member
     * across the tied pieces of that slot (`pipeline/src/buildScore.ts` §chord intent). "Make
     * this note a half and leave the one above it a 1/32" is therefore not a thing the page can
     * draw: there is no second voice to draw it in. The menu used to promise it anyway, write the
     * intent onto the one selected id, and let the engraver produce a chord whose members
     * disagreed about their own length — which is where the tie arcs in the owner's screenshot
     * come from.
     *
     * So the command is chord-wide: every member of the struck chord becomes the chosen value,
     * they all end together, and the ONE stack the player is looking at changes as one thing.
     * Membership comes from `CHORD_SEC` — the engraver's window — so the editor's idea of the
     * chord is the page's idea of the chord.
     */
    case 'setDuration': {
      const at = feed.find((n) => n.id === edit.noteId);
      if (!at) return null;
      const length = ctx.intentLengthSec(at.startSec, edit.intent);
      // Null is `notationIntentTicks` refusing the value — a dotted 1/32 has no glyph. The menu
      // greys that item out; refusing here as well means a keyboard or a probe cannot get past it.
      if (length === null || !(length > 0)) return null;
      // THE CHORD'S END, measured from the note that was clicked. Members struck a few
      // milliseconds apart keep their own attacks — that is the performance, and moving it would
      // be a second edit nobody asked for — but they stop together, which is what one written
      // value means.
      const chordEnd = at.startSec + Math.max(MIN_DUR_SEC, length);
      const mates = chordMates(feed, at);
      for (const m of mates) if (m.id) touched.add(m.id);
      const mateIds = new Set(mates.map((m) => m.id).filter((id): id is string => !!id));
      const next = feed.map((n) =>
        n.id !== undefined && mateIds.has(n.id)
          ? {
              ...resize(n, Math.max(MIN_DUR_SEC, chordEnd - n.startSec), ctx.tempoBpm),
              notationIntent: edit.intent
            }
          : n
      );
      return {
        notes: settleCollisions(next, new Set(touched), touched, ctx.tempoBpm, true),
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
// Bar operations — on EVERY document, recording or not
// ---------------------------------------------------------------------------

/**
 * A BAR OPERATION IS A NOTE-TIME EDIT, AND THE WAVEFORM NEVER CHANGES (workstream C).
 *
 * THE RULE THAT USED TO BE HERE, and why it is gone. Bar insert and delete were refused on
 * anything with a recording behind it, on the argument that inserting silence into a take would
 * slide the notes away from the audio they were transcribed from. That argument is sound and its
 * conclusion was wrong, because it assumes the sheet and the waveform must go on describing the
 * same instant forever. The owner's design says otherwise, and says it precisely:
 *
 *     THE WAVEFORM IS AN IMMUTABLE PHOTOGRAPH OF WHAT WAS PLAYED.
 *     THE SCORE IS THE MUSIC, AND THE MUSIC IS EDITABLE.
 *
 * After a bar operation those two are allowed to disagree, on purpose and visibly. Nothing in
 * this file writes an audio duration, nothing resamples, nothing moves a peak: a bar operation
 * produces new NOTE TIMES and a new declared bar count, and that is the whole of it. The
 * consequences the player has bought are real and are stated rather than hidden — Original
 * playback still plays the recording, the MIDI side plays the edited score, and past the first
 * insertion the two sides of the blend fader are auditioning different musical moments at the
 * same transport second.
 *
 * TWO CLOCKS, SPLIT WHERE THEY MEET THE REST OF THE APP. `audioDurationSec` (the recording) is
 * never touched by any of this; `scoreDurationSec` (where the notes stop) is the pipeline's own
 * note-derived `ir.stats.durationSec`, and the app reads it rather than storing a third number.
 * The moment the two can differ the document is DETACHED, which is a flag the app sets once and
 * the pipeline consumes as `BuildInput.detachedTimeline` — without it the audio-length guards
 * would answer "insert a bar" by deleting everything the insert pushed past the old end
 * (`pipeline/src/guards.ts`).
 *
 * THE SPLICE LAW, which is what makes an inserted bar genuinely EMPTY. A note still sounding at
 * the seam is SPLIT there: the head keeps its attack and stops at the seam, and a tail is
 * re-attacked on the far side of the inserted bar with the rest of the length. Shifting only the
 * notes that had not started yet — the old behaviour — leaves the "empty" bar with a note ringing
 * straight through it, which is not an empty bar and not what the menu item says.
 *
 * The two pieces engrave as two honest attacks rather than a tie, and that is correct rather
 * than a compromise: they are separated by a whole bar of rest, so there is nothing to tie
 * across. (Confirmed against the engraver: same-pitch pieces merge only on identical snapped
 * start ticks, which two pieces a bar apart can never have.)
 */
export interface BarOp {
  kind: 'insertBar' | 'deleteBar';
  /** 0-based index of the bar the menu was opened on. */
  barIndex: number;
  /** Insert only: before it, or after it. */
  where?: 'before' | 'after';
}

export interface BarOpContext {
  /**
   * Where the target bar STARTS, in feed seconds.
   *
   * Supplied by the caller from the score's own bar tick through the tempo map, NOT computed
   * here as `barIndex * barLengthSec`. That product is only right on a document with one tempo
   * and one meter for its whole length; on anything else it names a second in the wrong bar, and
   * it names it further wrong the further into the take the player right-clicked.
   */
  barStartSec: number;
  /** How long THAT bar is, in feed seconds — same provenance, same reason. */
  barLengthSec: number;
  /** How many bars the document currently declares (`SourceAudio.documentBars`). */
  barCount: number;
  /**
   * A stable id for the tail piece a splice creates. The caller owns id minting because ids must
   * not collide with the engine's `n<index>` series or with anything an earlier edit added.
   */
  splitId: (noteId: string) => string;
}

export interface BarOpResult {
  notes: InputNote[];
  touchedIds: Set<string>;
  label: string;
  /** The new declared document length, for `BuildInput.minimumBars`. */
  barCount: number;
  /** Seconds the note timeline grew (insert) or shrank (delete). Never an AUDIO duration. */
  durationDeltaSec: number;
}

/**
 * The splice itself, over one list of notes. Shared by the live take and by every imported part.
 *
 * ONE CLOCK FOR THE WHOLE DOCUMENT is why this is a separate function: a multi-part score has one
 * bar list, one meter map and one set of downbeats, so a bar inserted into the take is a bar
 * inserted into everybody. Shifting only the live part would re-bar the imported chart against
 * its own notes, which is exactly the silent corruption the old "imported parts share these bars"
 * refusal was protecting against — the fix is to shift them, not to refuse.
 *
 * `touched` collects every id whose time changed, INCLUDING the tails: on a document with the
 * snap on, the merge back into the recording restores the un-named notes from raw, so an
 * unnamed shift would appear on screen and vanish on the next rebuild.
 */
function spliceNotes(
  notes: ReadonlyArray<InputNote>,
  kind: BarOp['kind'],
  seamSec: number,
  barSec: number,
  splitId: (noteId: string) => string,
  touched: Set<string>
): InputNote[] {
  const out: InputNote[] = [];

  if (kind === 'insertBar') {
    for (const n of notes) {
      if (n.startSec >= seamSec - EPS) {
        if (n.id) touched.add(n.id);
        out.push({ ...n, startSec: n.startSec + barSec, endSec: n.endSec + barSec });
        continue;
      }
      if (n.endSec > seamSec + EPS) {
        // THE SPLICE. Head stops at the seam; tail is re-attacked past the inserted bar.
        if (n.id) touched.add(n.id);
        const head = { ...n, endSec: Math.max(n.startSec + MIN_DUR_SEC, seamSec) };
        const tailLength = Math.max(MIN_DUR_SEC, n.endSec - seamSec);
        const tail: InputNote = {
          ...n,
          ...(n.id ? { id: splitId(n.id) } : {}),
          startSec: seamSec + barSec,
          endSec: seamSec + barSec + tailLength
        };
        // The tail is a NEW note, so it carries no written-value intent from the old one: the
        // player chose that value for a note of a different length.
        delete (tail as { notationIntent?: NotationIntent }).notationIntent;
        if (tail.id) touched.add(tail.id);
        out.push(head, tail);
        continue;
      }
      out.push(n);
    }
    return out.sort(byTimeThenPitch);
  }

  const to = seamSec + barSec;
  for (const n of notes) {
    if (n.startSec >= seamSec - EPS && n.startSec < to - EPS) {
      // Attacked inside the bar that is going: it goes with it.
      if (n.id) touched.add(n.id);
      continue;
    }
    if (n.startSec >= to - EPS) {
      if (n.id) touched.add(n.id);
      out.push({ ...n, startSec: n.startSec - barSec, endSec: n.endSec - barSec });
      continue;
    }
    if (n.endSec > seamSec + EPS) {
      // Crosses the deleted interval: STITCHED, not clipped — it loses exactly the seconds the
      // bar took with it and keeps whatever it had on the far side, which is what "remove this
      // bar from the music" means for a note that was already sounding.
      if (n.id) touched.add(n.id);
      const removed = Math.min(n.endSec, to) - seamSec;
      out.push({ ...n, endSec: Math.max(n.startSec + MIN_DUR_SEC, n.endSec - removed) });
      continue;
    }
    out.push(n);
  }
  return out.sort(byTimeThenPitch);
}

/**
 * Insert or delete one bar. Works on every document; see the header above for the two clocks.
 *
 * Returns null only when the operation is not expressible — a bar of no length, or the last bar
 * of a one-bar document, which would leave a score with nothing to engrave.
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
    const seam = op.where === 'after' ? ctx.barStartSec + bar : ctx.barStartSec;
    return {
      notes: spliceNotes(feed, 'insertBar', seam, bar, ctx.splitId, touched),
      touchedIds: touched,
      label: op.where === 'after' ? 'Insert bar after' : 'Insert bar before',
      barCount: Math.min(512, ctx.barCount + 1),
      durationDeltaSec: bar
    };
  }

  if (ctx.barCount <= 1) return null;
  const notes = spliceNotes(feed, 'deleteBar', ctx.barStartSec, bar, ctx.splitId, touched);
  return {
    // A deleted bar can take the note that was carrying a symbolic import's bar and tempo map
    // with it — the importers hang those on the first note of each track only.
    notes: keepStructureCarriers([...feed], notes).sort(byTimeThenPitch),
    touchedIds: touched,
    label: 'Delete bar',
    barCount: Math.max(1, ctx.barCount - 1),
    durationDeltaSec: -bar
  };
}

/**
 * The same splice, applied to ONE IMPORTED PART's symbolic notes.
 *
 * Separate entry point rather than a flag on `applyBarOp`, because a part has no `touchedIds`
 * contract to honour: it is not merged back against a recording, it IS its own stored list, so
 * the caller replaces it wholesale. What it does share is the arithmetic, which is the point.
 */
export function applyBarOpToPartNotes(
  notes: ReadonlyArray<InputNote>,
  op: BarOp,
  ctx: BarOpContext
): InputNote[] {
  const bar = ctx.barLengthSec;
  if (!(bar > 0)) return [...notes];
  const seam =
    op.kind === 'insertBar' && op.where === 'after' ? ctx.barStartSec + bar : ctx.barStartSec;
  return spliceNotes(notes, op.kind, seam, bar, ctx.splitId, new Set<string>());
}
