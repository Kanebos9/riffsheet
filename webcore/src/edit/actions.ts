/**
 * Light editing: the command/undo layer.
 *
 * Adapted from Escala (MIT, Copyright (c) 2022 Gabriel Allegretti) — see CREDITS.md. What
 * we kept: the do/undo action pair, the previous-value memento stored on the action event,
 * and the "actions report what they need, one place performs it" split (requiresRerender /
 * requiresMidiUpdate). Three deliberate departures:
 *
 *  1. THEIR UNDO STACK HAS A BUG. `doAction` truncated with
 *     `actions.slice(actionsIndex + 1)`, which keeps the undone tail and discards the real
 *     history: do A, do B, undo, do C left ['B','C'] instead of ['A','C']. Fixed below with
 *     `slice(0, index + 1)`.
 *
 *  2. Their stack holds live alphaTab object references, so any reload silently
 *     invalidates it and they clear the history on open/new. We key on our stable IR note
 *     ids and resolve to live objects at apply time, so the stack survives a score rebuild
 *     (which happens whenever the pipeline re-runs — e.g. dragging the bar-1 marker).
 *
 *  3. Multi-part edits are one undo entry (CompositeAction). Escala pushes N entries for
 *     what the user experienced as one gesture.
 */

import * as alphaTab from '@coderline/alphatab';
import type { ScoreIndex } from '../score/fromPipeline';
import { soundingMidi } from '../score/fromPipeline';
import { assignFret } from '../score/tuning';

export interface EditContext {
  index: ScoreIndex;
  tuningLowToHigh: number[];
  maxFret: number;
  capo: number;
}

export interface ActionResult {
  requiresRerender: boolean;
  requiresMidiUpdate: boolean;
  /** Lowest master bar index touched — used for scroll/telemetry, not as a render hint. */
  firstChangedMasterBar?: number;
}

export const NO_CHANGE: ActionResult = { requiresRerender: false, requiresMidiUpdate: false };

/**
 * An action, written down.
 *
 * Actions hold live alphaTab references in their mementos, so they cannot be serialised
 * themselves — but they do not need to be. Every one of them is a pure function of a stable
 * IR note id and a direction, and replaying the list against a freshly built score
 * reproduces the edited score exactly. That is what lets the user's edits survive the
 * plugin editor being destroyed: the SCORE is rebuilt from the detected notes (cheap, no
 * re-transcription) and then this list is replayed on top. See app/persist.ts.
 */
export type EditSpec =
  | { kind: 'pitch'; noteId: string; semitones: number }
  | { kind: 'string'; noteId: string; direction: 1 | -1 }
  | { kind: 'nudge'; noteId: string; direction: 1 | -1 }
  | { kind: 'delete'; noteId: string }
  | { kind: 'composite'; label: string; parts: EditSpec[] };

export interface EditAction {
  readonly label: string;
  /** How to write this action down. See EditSpec. */
  readonly spec: EditSpec;
  do(ctx: EditContext): ActionResult;
  undo(ctx: EditContext): ActionResult;
}

function merge(a: ActionResult, b: ActionResult): ActionResult {
  return {
    requiresRerender: a.requiresRerender || b.requiresRerender,
    requiresMidiUpdate: a.requiresMidiUpdate || b.requiresMidiUpdate,
    firstChangedMasterBar:
      a.firstChangedMasterBar === undefined
        ? b.firstChangedMasterBar
        : b.firstChangedMasterBar === undefined
          ? a.firstChangedMasterBar
          : Math.min(a.firstChangedMasterBar, b.firstChangedMasterBar)
  };
}

function resolve(ctx: EditContext, noteId: string): alphaTab.model.Note | null {
  return ctx.index.idToNote.get(noteId) ?? null;
}

/**
 * Every notehead that belongs to this note.
 *
 * A note held across a bar line is engraved as several noteheads joined by ties, and they all
 * share one id because they are one note that was played once. An edit therefore has to touch
 * ALL of them: changing the pitch of one half of a tie and not the other produced a sheet that
 * disagreed with itself — and since only the first half carries a fret digit, the tab looked as
 * though it had ignored the edit entirely. That was a real, reported bug.
 *
 * Falls back to the single resolved note, so a score built before `idToNotes` existed still
 * edits rather than silently doing nothing.
 */
function resolveAll(ctx: EditContext, noteId: string): alphaTab.model.Note[] {
  const chain = ctx.index.idToNotes?.get(noteId);
  if (chain && chain.length > 0) return chain;
  const one = resolve(ctx, noteId);
  return one ? [one] : [];
}

function barOf(note: alphaTab.model.Note): number {
  return note.beat.voice.bar.index;
}

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------

/**
 * Transpose a note by semitones, re-fretting it.
 *
 * Pitch is the intent; string/fret is the presentation. We re-run the fret assignment so
 * a note pushed past the end of its string moves to the next one instead of growing an
 * impossible fret number.
 */
export class ChangePitchAction implements EditAction {
  readonly label: string;
  readonly spec: EditSpec;
  private previous: Array<{
    note: alphaTab.model.Note;
    string: number;
    fret: number;
    octave: number;
    tone: number;
  }> = [];
  private previousMidi: number | null = null;

  constructor(
    private noteId: string,
    private semitones: number
  ) {
    this.label = semitones > 0 ? 'Pitch up' : 'Pitch down';
    this.spec = { kind: 'pitch', noteId, semitones };
  }

  do(ctx: EditContext): ActionResult {
    // EVERY notehead, not just the first. A tied note is one note; moving half of it would
    // produce a sheet that contradicts itself. See `resolveAll`.
    const notes = resolveAll(ctx, this.noteId);
    if (notes.length === 0) return NO_CHANGE;

    const head = notes[0];
    this.previousMidi = soundingMidi(ctx.index, head);
    const target = this.previousMidi + this.semitones;

    if (target < 0 || target > 127) return NO_CHANGE;

    // A universal/standard-notation staff deliberately has no tuning. Requiring a fret here
    // made every pitch drag on imported MusicXML, Guitar Pro and score images look selectable
    // but silently refuse to commit. On a plain staff alphaTab stores the pitch directly as
    // octave/tone; only a tablature staff needs to be re-fretted.
    const placed =
      ctx.tuningLowToHigh.length > 0
        ? assignFret(target, ctx.tuningLowToHigh, {
            maxFret: ctx.maxFret,
            capo: ctx.capo,
            style: 'minimize-movement',
            previousFret: head.fret
          })
        : null;
    if (ctx.tuningLowToHigh.length > 0 && !placed) return NO_CHANGE;

    // Recorded per glyph: the pieces of a tie can legitimately sit on different strings if a
    // previous edit moved one, so undo cannot assume they all started the same.
    this.previous = notes.map((n) => ({
      note: n,
      string: n.string,
      fret: n.fret,
      octave: n.octave,
      tone: n.tone
    }));
    for (const n of notes) {
      if (placed) {
        n.string = placed.string;
        n.fret = placed.fret;
      } else {
        // alphaTab's `Note.octave` is an internal MIDI bucket, not the scientific
        // octave printed in a note name. Its invariant is
        // `realValue === octave * 12 + tone`, so MIDI 60 must be { octave: 5,
        // tone: 0 }. Subtracting one here silently moved every edited plain-staff
        // note down an octave inside alphaTab even though Riffsheet's canonical
        // sounding MIDI stayed correct.
        n.octave = Math.floor(target / 12);
        n.tone = target % 12;
      }
      // The index caches the pipeline's sounding pitch; an edit invalidates it, so keep it
      // in step or the names row and the popover would keep showing the old letter.
      const info = ctx.index.noteToInfo.get(n);
      if (info) ctx.index.noteToInfo.set(n, { ...info, midi: target });
    }
    return { requiresRerender: true, requiresMidiUpdate: true, firstChangedMasterBar: barOf(head) };
  }

  undo(ctx: EditContext): ActionResult {
    if (this.previous.length === 0) return NO_CHANGE;
    for (const p of this.previous) {
      p.note.string = p.string;
      p.note.fret = p.fret;
      p.note.octave = p.octave;
      p.note.tone = p.tone;
      const info = ctx.index.noteToInfo.get(p.note);
      if (info && this.previousMidi !== null) {
        ctx.index.noteToInfo.set(p.note, { ...info, midi: this.previousMidi });
      }
    }
    return {
      requiresRerender: true,
      requiresMidiUpdate: true,
      firstChangedMasterBar: barOf(this.previous[0].note)
    };
  }
}

/**
 * Move a note to an adjacent string, keeping the pitch.
 *
 * Refrets by the tuning difference: same sounding note, different place on the neck. If
 * the new fret would be negative or past maxFret, the move is refused.
 */
export class ChangeStringAction implements EditAction {
  readonly label = 'Change string';
  readonly spec: EditSpec;
  private previous: Array<{ note: alphaTab.model.Note; string: number; fret: number }> = [];

  constructor(
    private noteId: string,
    private direction: 1 | -1
  ) {
    this.spec = { kind: 'string', noteId, direction };
  }

  do(ctx: EditContext): ActionResult {
    // The whole tie again: one note, one string. Half a held note on the A string and half on
    // the E string is not a thing a player can do.
    const notes = resolveAll(ctx, this.noteId);
    if (notes.length === 0) return NO_CHANGE;
    const head = notes[0];

    const targetString = head.string + this.direction;
    if (targetString < 1 || targetString > ctx.tuningLowToHigh.length) return NO_CHANGE;

    const sounding = soundingMidi(ctx.index, head);
    const openOfTarget = ctx.tuningLowToHigh[targetString - 1] + ctx.capo;
    const newFret = sounding - openOfTarget;
    if (newFret < 0 || newFret > ctx.maxFret) return NO_CHANGE;

    this.previous = notes.map((n) => ({ note: n, string: n.string, fret: n.fret }));
    for (const n of notes) {
      n.string = targetString;
      n.fret = newFret;
    }
    // Pitch is unchanged, so the MIDI does not need regenerating — only the tab redraws.
    return { requiresRerender: true, requiresMidiUpdate: false, firstChangedMasterBar: barOf(head) };
  }

  undo(): ActionResult {
    if (this.previous.length === 0) return NO_CHANGE;
    for (const p of this.previous) {
      p.note.string = p.string;
      p.note.fret = p.fret;
    }
    return {
      requiresRerender: true,
      requiresMidiUpdate: false,
      firstChangedMasterBar: barOf(this.previous[0].note)
    };
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Remove a note.
 *
 * Escala unlinks hammer-on/slide relationships first, otherwise the removed note leaves
 * dangling targets that crash or mis-render. We keep that, and additionally empty the beat
 * when the last note goes so it becomes a rest rather than a zero-note beat.
 */
export class DeleteNoteAction implements EditAction {
  readonly label = 'Delete note';
  readonly spec: EditSpec;
  private removed: alphaTab.model.Note | null = null;
  private beat: alphaTab.model.Beat | null = null;
  private madeEmpty = false;
  private info: { id: string; midi: number } | null = null;
  /** The tied continuations, in engraved order. Empty unless the note was held. */
  private extras: Array<{ note: alphaTab.model.Note; beat: alphaTab.model.Beat; madeEmpty: boolean }> = [];

  constructor(private noteId: string) {
    this.spec = { kind: 'delete', noteId };
  }

  do(ctx: EditContext): ActionResult {
    // A held note is several noteheads. Deleting one of them left the rest on the page — the
    // note appeared to survive its own deletion, or worse, left a tie hanging onto nothing.
    const notes = resolveAll(ctx, this.noteId);
    if (notes.length === 0) return NO_CHANGE;
    // Remove the tail first so the head is the last thing to go: `removed`/`beat` below
    // describe the head, which is what undo puts back first.
    for (const extra of notes.slice(1).reverse()) {
      const b = extra.beat;
      this.extras.unshift({ note: extra, beat: b, madeEmpty: false });
      b.removeNote(extra);
      if (b.notes.length === 0) {
        b.isEmpty = true;
        this.extras[0].madeEmpty = true;
      }
      ctx.index.noteToInfo.delete(extra);
    }

    const note = notes[0];
    const beat = note.beat;
    this.removed = note;
    this.beat = beat;

    if (note.hammerPullOrigin) {
      note.hammerPullOrigin.hammerPullDestination = null;
      note.hammerPullOrigin = null;
    }
    if (note.hammerPullDestination) {
      note.hammerPullDestination.hammerPullOrigin = null;
      note.hammerPullDestination = null;
    }
    if (note.slideOrigin) {
      note.slideOrigin.slideTarget = null;
      note.slideOrigin.slideOutType = alphaTab.model.SlideOutType.None;
      note.slideOrigin = null;
    }
    if (note.slideTarget) {
      note.slideTarget.slideOrigin = null;
      note.slideOutType = alphaTab.model.SlideOutType.None;
      note.slideTarget = null;
    }

    beat.removeNote(note);
    if (beat.notes.length === 0) {
      beat.isEmpty = true;
      this.madeEmpty = true;
    }

    // Keep the identity map honest — a deleted note must stop resolving.
    this.info = ctx.index.noteToInfo.get(note) ?? null;
    ctx.index.idToNote.delete(this.noteId);
    ctx.index.idToNotes?.delete(this.noteId);
    ctx.index.noteToInfo.delete(note);

    return { requiresRerender: true, requiresMidiUpdate: true, firstChangedMasterBar: beat.voice.bar.index };
  }

  undo(ctx: EditContext): ActionResult {
    if (!this.removed || !this.beat) return NO_CHANGE;
    // Do not resurrect onto an occupied string.
    if (this.beat.notes.some((n) => n.string === this.removed!.string)) return NO_CHANGE;

    if (this.madeEmpty) this.beat.isEmpty = false;
    this.beat.addNote(this.removed);
    this.beat.finish(null as never, new Map<string, unknown>());

    ctx.index.idToNote.set(this.noteId, this.removed);
    if (this.info) ctx.index.noteToInfo.set(this.removed, this.info);

    // ...and the rest of the held note with it, or undo would restore a note shorter than the
    // one that was deleted.
    const chain: alphaTab.model.Note[] = [this.removed];
    for (const extra of this.extras) {
      if (extra.beat.notes.some((n) => n.string === extra.note.string)) continue;
      if (extra.madeEmpty) extra.beat.isEmpty = false;
      extra.beat.addNote(extra.note);
      extra.beat.finish(null as never, new Map<string, unknown>());
      if (this.info) ctx.index.noteToInfo.set(extra.note, this.info);
      chain.push(extra.note);
    }
    ctx.index.idToNotes?.set(this.noteId, chain);

    return { requiresRerender: true, requiresMidiUpdate: true, firstChangedMasterBar: this.beat.voice.bar.index };
  }
}

// ---------------------------------------------------------------------------
// Nudge
// ---------------------------------------------------------------------------

/**
 * Move a note one grid step earlier or later, by swapping it into the neighbouring beat.
 *
 * This is the honest, structural version of "nudge": we do not fudge x-positions, we move
 * the note to the adjacent beat in the same voice. If the destination already has a note
 * on that string, the nudge is refused rather than silently stacking.
 */
export class NudgeNoteAction implements EditAction {
  readonly label = 'Nudge';
  readonly spec: EditSpec;
  private from: alphaTab.model.Beat | null = null;
  private to: alphaTab.model.Beat | null = null;
  private note: alphaTab.model.Note | null = null;

  constructor(
    private noteId: string,
    private direction: 1 | -1
  ) {
    this.spec = { kind: 'nudge', noteId, direction };
  }

  do(ctx: EditContext): ActionResult {
    const note = resolve(ctx, this.noteId);
    if (!note) return NO_CHANGE;

    const beat = note.beat;
    const voice = beat.voice;
    const target = voice.beats[beat.index + this.direction];
    if (!target) return NO_CHANGE;
    if (target.notes.some((n) => n.string === note.string)) return NO_CHANGE;

    this.note = note;
    this.from = beat;
    this.to = target;

    return this.move(beat, target, note);
  }

  undo(): ActionResult {
    if (!this.note || !this.from || !this.to) return NO_CHANGE;
    return this.move(this.to, this.from, this.note);
  }

  private move(
    from: alphaTab.model.Beat,
    to: alphaTab.model.Beat,
    note: alphaTab.model.Note
  ): ActionResult {
    from.removeNote(note);
    if (from.notes.length === 0) from.isEmpty = true;
    to.isEmpty = false;
    to.addNote(note);
    to.finish(null as never, new Map<string, unknown>());
    return {
      requiresRerender: true,
      requiresMidiUpdate: true,
      firstChangedMasterBar: Math.min(from.voice.bar.index, to.voice.bar.index)
    };
  }
}

// ---------------------------------------------------------------------------
// Composite — one gesture, one undo entry
// ---------------------------------------------------------------------------

export class CompositeAction implements EditAction {
  readonly spec: EditSpec;

  constructor(
    readonly label: string,
    private actions: EditAction[]
  ) {
    this.spec = { kind: 'composite', label, parts: actions.map((a) => a.spec) };
  }

  do(ctx: EditContext): ActionResult {
    return this.actions.reduce<ActionResult>((acc, a) => merge(acc, a.do(ctx)), NO_CHANGE);
  }

  undo(ctx: EditContext): ActionResult {
    // Reverse order, or later actions undo onto state their predecessors have not restored.
    return [...this.actions]
      .reverse()
      .reduce<ActionResult>((acc, a) => merge(acc, a.undo(ctx)), NO_CHANGE);
  }
}

// ---------------------------------------------------------------------------
// Specs -> actions, for session restore
// ---------------------------------------------------------------------------

/**
 * Rebuild an action from its written-down form.
 *
 * Returns null for anything unrecognised rather than throwing: a session blob written by a
 * newer build must not be able to stop an older one from opening. The rest of the edits
 * still replay; only the unknown one is skipped.
 */
export function createEditAction(spec: EditSpec | null | undefined): EditAction | null {
  if (!spec || typeof spec !== 'object') return null;

  switch (spec.kind) {
    case 'pitch':
      return Number.isFinite(spec.semitones) ? new ChangePitchAction(spec.noteId, spec.semitones) : null;
    case 'string':
      return new ChangeStringAction(spec.noteId, spec.direction === -1 ? -1 : 1);
    case 'nudge':
      return new NudgeNoteAction(spec.noteId, spec.direction === -1 ? -1 : 1);
    case 'delete':
      return new DeleteNoteAction(spec.noteId);
    case 'composite': {
      const parts = (spec.parts ?? []).map(createEditAction).filter((a): a is EditAction => a !== null);
      return parts.length > 0 ? new CompositeAction(spec.label, parts) : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------

export class UndoStack {
  private actions: EditAction[] = [];
  private index = -1;
  private cap: number;

  constructor(cap = 200) {
    this.cap = cap;
  }

  perform(action: EditAction, ctx: EditContext): ActionResult {
    const result = action.do(ctx);
    if (!result.requiresRerender && !result.requiresMidiUpdate) return result;

    // Drop the redo tail. (Escala's version sliced the wrong side — see the header.)
    if (this.index < this.actions.length - 1) {
      this.actions = this.actions.slice(0, this.index + 1);
    }
    this.actions.push(action);
    if (this.actions.length > this.cap) this.actions.shift();
    this.index = this.actions.length - 1;
    return result;
  }

  undo(ctx: EditContext): ActionResult {
    if (this.index < 0) return NO_CHANGE;
    const result = this.actions[this.index].undo(ctx);
    this.index--;
    return result;
  }

  redo(ctx: EditContext): ActionResult {
    if (this.index >= this.actions.length - 1) return NO_CHANGE;
    const next = this.actions[this.index + 1];
    const result = next.do(ctx);
    this.index++;
    return result;
  }

  get canUndo(): boolean {
    return this.index >= 0;
  }

  get canRedo(): boolean {
    return this.index < this.actions.length - 1;
  }

  get undoLabel(): string | null {
    return this.index >= 0 ? this.actions[this.index].label : null;
  }

  get redoLabel(): string | null {
    return this.canRedo ? this.actions[this.index + 1].label : null;
  }

  clear(): void {
    this.actions = [];
    this.index = -1;
  }
}
