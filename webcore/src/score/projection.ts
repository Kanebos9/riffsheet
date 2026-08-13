/**
 * THE PROJECTION, AS THE INTERFACE CONSUMES IT — what became of every note, keyed by the revision
 * it describes.
 *
 * THE HOLE THIS FILLS. The roll draws every event in `performanceFeed`; the sheet draws whatever
 * survives guards, chord de-duplication and quantization collision fusing. Between the two there
 * was no record at all: an id the engraver dropped or merged simply was not in `ScoreIndex`, and
 * every consumer read that absence as "no such note". So selecting a 20 ms rectangle, or a
 * same-pitch duplicate inside a chord window, or the losing side of a quantization collision, lit
 * the roll and drew NOTHING on the sheet — with no way for the app to tell that apart from a bug,
 * because both look like `idToNotes.get(id) === undefined` (audit finding 5).
 *
 * THE PIPELINE NOW ANSWERS THIS DIRECTLY. `BuildResult.projection` (contract in
 * `pipeline/IR.md §Projection`) is total: one outcome per input id, three outcomes, exhaustive
 * and mutually exclusive, with `counts.engraved + merged + dropped === counts.input` asserted on
 * its own side. So this file does NOT re-derive anything and deliberately has no fallback that
 * guesses — a guess here would be a second authority, which is the disease rather than the cure.
 * What it does is two jobs the pipeline cannot do:
 *
 *   1. TURN REASON CODES INTO SENTENCES. The pipeline's `MergeReason`/`DropReason` name sites in
 *      the pipeline; a player needs English. One table, so a new code upstream surfaces as a
 *      missing entry rather than as a blank indicator.
 *   2. STAMP A REVISION ON IT. See below.
 *
 * WHY REVISIONS. `TriView.load` publishes a new score, index and model and then asks for a
 * render — but a render into a zero-width or hidden host returns early WITHOUT replacing
 * alphaTab's `boundsLookup` (audit finding 8). The bounds then still describe the PREVIOUS score,
 * so a hit test resolves a Note object from the old model, looks it up in the new index, finds
 * nothing, and reports `noteId: null` — which `onNoteClick` read as "empty space, seek there".
 * That is the intermittent dead click after an edit.
 *
 * Stamping the model, the index, the projection and the bounds with one revision turns that from
 * a silent wrong answer into a detectable one: a hit whose bounds do not carry the current
 * revision is REJECTED rather than mis-resolved. See `view/triview.ts §boundsAreCurrent`.
 */

import type { InputNote, NoteProjection, PipelineProjection } from '@pipeline';

/** The three outcomes, in this side's vocabulary. Identical to the pipeline's `NoteProjection.kind`. */
export type ProjectionStatus = NoteProjection['kind'];

export interface ProjectionEntry {
  status: ProjectionStatus;
  /**
   * For `merged`: the id whose glyphs now speak for this note.
   *
   * ALWAYS AN ENGRAVED ID and never another merged one — the pipeline resolves the pointer
   * transitively before publishing, so a consumer follows it exactly once. A chain would mean
   * every consumer needed its own loop, and one of them would forget.
   */
  mergedInto?: string;
  /** A sentence a player could read. Present for `merged` and `dropped`. */
  reason?: string;
  /**
   * Set when the build engraved this note but a stored `notationIntent` did NOT decide its
   * written value — the pipeline's `IntentIgnored.reason`, carried verbatim. See `staleIntentIds`.
   */
  intentIgnored?: string;
}

/**
 * THE PIPELINE'S REASON CODES -> English. The only place they become words.
 *
 * Exhaustive over `MergeReason | DropReason` at the time of writing. A code with no entry falls
 * through to its own raw string rather than to silence, so the failure mode of an upstream
 * addition is an ugly indicator, never an invisible one.
 */
const REASON_TEXT: Record<string, string> = {
  // MergeReason
  'chord-duplicate-pitch': 'a second detection of the same pitch in this chord',
  'quantize-collision': 'quantized onto the same beat as another note',
  'symbolic-tick-collision': 'written on the same beat as another note',
  // DropReason
  'past-audio-end': 'past the end of the recording',
  'below-min-duration': 'too short to be written',
  'past-score-end': 'past the last barline',
  'zero-length-after-clamp': 'left no room by the note before it',
  unengraved: 'not engraved'
};

/**
 * A projection published as ONE object with ONE revision.
 *
 * Nothing here is mutable after publication and nothing may be read against a different
 * revision's companion. That is the whole discipline: `{revision, model, index, bounds}` travel
 * together or they are not used.
 */
export interface Projection {
  readonly revision: number;
  readonly entries: ReadonlyMap<string, ProjectionEntry>;
  /** Every input id the build was handed, in feed order. The map is total over exactly these. */
  readonly inputIds: ReadonlyArray<string>;
}

/** An empty projection, so consumers never branch on null for a document with no notes. */
export const EMPTY_PROJECTION: Projection = { revision: 0, entries: new Map(), inputIds: [] };

/**
 * ADOPT THE BUILD'S ANSWER and stamp it with this revision.
 *
 * `input` is the feed the build was handed, and it decides `inputIds` — the order matters to
 * probes and to any UI that wants to walk losses in playing order, which `Map` insertion order
 * over `byId` would not guarantee across pipeline versions.
 *
 * Ids the published result does not mention are still given an entry, because TOTALITY is this
 * file's promise to its consumers and a partial contract must not be able to reintroduce silence.
 * The pipeline asserts the same equation on its own side, so this backstop should never fire —
 * which is exactly why it is cheap to keep.
 */
export function adoptProjection(
  revision: number,
  input: ReadonlyArray<InputNote>,
  published: PipelineProjection | null | undefined
): Projection {
  const entries = new Map<string, ProjectionEntry>();
  const inputIds: string[] = [];
  for (const n of input) {
    if (!n.id) continue;
    inputIds.push(n.id);
    const p = published?.byId.get(n.id);
    if (!p) {
      entries.set(n.id, { status: 'dropped', reason: REASON_TEXT.unengraved });
      continue;
    }
    if (p.kind === 'engraved') {
      entries.set(n.id, {
        status: 'engraved',
        ...(p.intentIgnored ? { intentIgnored: p.intentIgnored.reason } : {})
      });
      continue;
    }
    const reason = REASON_TEXT[p.reason] ?? p.reason;
    entries.set(n.id, {
      status: p.kind,
      ...(p.kind === 'merged' ? { mergedInto: p.mergedInto } : {}),
      reason
    });
  }
  return { revision, entries, inputIds };
}

/** How many of each. For probes, and for a count-loss warning that can now be exact. */
export function projectionCounts(p: Projection): {
  engraved: number;
  merged: number;
  dropped: number;
  total: number;
} {
  let engraved = 0;
  let merged = 0;
  let dropped = 0;
  for (const e of p.entries.values()) {
    if (e.status === 'engraved') engraved++;
    else if (e.status === 'merged') merged++;
    else dropped++;
  }
  return { engraved, merged, dropped, total: p.entries.size };
}

/**
 * Can this id be SELECTED?
 *
 * Yes, for every id the build was handed — and that is the point of the file. SELECTABILITY IS A
 * PROPERTY OF THE DOCUMENT, NOT OF THE ENGRAVING: a note the player can see a rectangle for is a
 * note they can point at, whatever the page decided to do with it. What changes with status is
 * whether the sheet can draw a ring, and what the app says when it cannot.
 */
export function isSelectable(p: Projection | null, id: string): boolean {
  return !!p && p.entries.has(id);
}

/**
 * The glyph that speaks for this id on the page — itself when engraved, its merge target when
 * merged, and null when the page has nothing at all.
 *
 * What the sheet highlighter should ring. Ringing the merge target is not a lie: that notehead
 * genuinely IS this note's representation on the page, which is what `merged` means as opposed to
 * `dropped`.
 */
export function sheetProxyFor(p: Projection | null, id: string): string | null {
  const e = p?.entries.get(id);
  if (!e) return null;
  if (e.status === 'engraved') return id;
  if (e.status === 'merged') return e.mergedInto ?? null;
  return null;
}

/**
 * Why the sheet is not showing this one AS ITSELF — or null when it is.
 *
 * `null` means "engraved, the ring is around its own notehead". Anything else is a sentence to
 * show instead of the silence the app used to produce.
 */
export function sheetSilenceReason(p: Projection | null, id: string): string | null {
  const e = p?.entries.get(id);
  if (!e || e.status === 'engraved') return null;
  return e.reason ?? REASON_TEXT.unengraved;
}

/**
 * THE IDS WHOSE STORED `notationIntent` THE PAGE DID NOT HONOUR.
 *
 * Audit finding 14: nothing said whether a timing mutation preserves, recomputes or clears a
 * written value, so a note set to Quarter from the sheet and then resized to an eighth on the
 * roll kept printing a quarter over an eighth-long rectangle indefinitely. The pipeline cannot
 * fix this — it is a pure function of its input and the intent lives in the document — so it
 * REPORTS via `intentIgnored`, and this seam clears what it names. The loop converges because
 * clearing makes the next build measure the note instead of honouring a claim it contradicted.
 *
 * ONLY `not-carried` CLEARS. That is the one reason that means "the span cannot hold the declared
 * value", i.e. a timing edit invalidated it. The others are not staleness and must not clear:
 *   `tuplet-lattice`    — the value is unprintable HERE, but the declaration is still what the
 *                         player asked for and becomes live again if the note leaves the tuplet.
 *   `chord-superseded`  — a longer declaration from a chord mate won this slot. The note's own
 *                         declaration is intact and correct; the chord is one slot, that is all.
 *   `symbolic-source`   — the engraver never consults a declaration on that path, so the stored
 *                         value is inert rather than wrong.
 *   `unprintable`       — `notationIntentTicks` refused it outright; there is nothing to clear
 *                         that the menu would ever have offered.
 */
export function staleIntentIds(p: Projection | null): string[] {
  if (!p) return [];
  const out: string[] = [];
  for (const [id, e] of p.entries) if (e.intentIgnored === 'not-carried') out.push(id);
  return out;
}
