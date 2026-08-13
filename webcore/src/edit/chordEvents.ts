/**
 * CHORD MEMBERSHIP, DECIDED ONCE.
 *
 * THE FAULT THIS ENDS. Three layers each answered "are these two notes one chord?" with a
 * different law, and every one of them acted on its answer:
 *
 *   the ENGRAVER   `pipeline/src/chords.ts` — `max(35 ms, beatPeriod/16)`, greedy partitioning
 *                  from each group's FIRST onset, an adaptive extension that widens the window
 *                  when a note lands late in it, same-pitch de-duplication, and — for a symbolic
 *                  source — exact written ticks instead of any window at all.
 *   the EDITOR     `edit/performanceEdit.ts` §chordMates — a flat symmetric ±35 ms around the
 *                  note that was clicked, with no partitioning, no extension, no part filter, no
 *                  voice filter and no notion of symbolic time.
 *   BEAT SNAP      `app/snap.ts` — a third window, 20 ms, for deciding what counts as one event
 *                  when the magnet moves attacks.
 *
 * Symmetric-window-around-the-clicked-note is not a slightly different approximation of greedy
 * partitioning; it is a different relation. Partitioning is not symmetric and it is not
 * transitive-by-proximity. With attacks at 0, 34 and 68 ms the engraver draws {0, 34} and {68}:
 * the group starts at 0 and 68 is 68 ms from it. Click the 34 ms note and the editor's ±35 ms
 * window reaches both 0 and 68 and rewrites all three — including a note the page draws as a
 * separate event. The audit found the reverse too: at 60 BPM the engraver's window is 62.5 ms so
 * attacks at 0 and 50 ms are ONE chord the editor refuses to treat as one, and at 140 BPM two
 * adjacent written 64ths are separate notes the editor fuses.
 *
 * THE RULE NOW: membership is computed ONCE, by the same code the engraver runs, and published as
 * explicit events with explicit member ids. The editor and the snap layer READ that. They do not
 * re-derive, and there is no window constant in either of them any more.
 *
 * WHY THIS IMPORTS THE IMPLEMENTATION DIRECTLY. `collectChords` is the engraver's own function.
 * Restating it here — even faithfully — would recreate the exact class of fault this file exists
 * to remove, because the copy would then have to be kept in step by hand. `score/parts.ts`
 * establishes the precedent for a second `@pipeline-impl` entry point where the alternative is a
 * second copy of pipeline logic; this is that case, and it is the strongest instance of it.
 */

import { chordWindowSec, collectChords } from '@pipeline-impl';
import type { InputNote } from '@pipeline';

/**
 * One struck event, with the ids of everything struck in it.
 *
 * `memberIds` is the whole contract. It is the engraver's grouping, so a caller acting on it acts
 * on the stack the player is looking at — no more and no less.
 */
export interface ChordEventRecord {
  id: string;
  onsetSec: number;
  /** The longest member's end, which is what one written value means for the stack. */
  endSec: number;
  /**
   * Every id THE LAW admitted, including members it could not print.
   *
   * The distinction is the pipeline's own (`ChordEvent.duplicates`): a second detection of a
   * pitch already in the stack is in the chord as far as grouping is concerned, and simply has
   * no notehead of its own because one notehead cannot be printed twice. It must still be a
   * member here, because it still has a RECTANGLE on the roll — leaving it out would set the
   * chord's new length on every member except that one, and the roll would keep drawing the
   * stale span underneath the changed glyph.
   */
  memberIds: string[];
  /**
   * The window this group was decided with, widenings included; 0 on a written-tick group.
   * Carried through so a probe can show WHY two notes are or are not mates.
   */
  windowSec: number;
  law: 'performance-window' | 'written-tick';
}

/**
 * The event table for a feed: every event, and a note-id -> event index for O(1) lookup.
 *
 * Built once per feed revision and handed to the reducer. Every id in the feed that the chord law
 * admitted appears in exactly one event — including the duplicate-pitch members the page could
 * not give a notehead to, which are still notes the player can see and drag on the roll. What
 * happened to a member ON THE PAGE is a separate question with a separate answer, and it is
 * `score/projection.ts` that holds it (`merged`, naming the notehead that speaks for it).
 *
 * `eventFor` returns null only for an id the feed does not contain at all.
 */
export interface ChordEventTable {
  events: ChordEventRecord[];
  byNoteId: Map<string, number>;
}

/** An empty table — for a feed with nothing in it, so callers never special-case null. */
export const EMPTY_CHORD_EVENTS: ChordEventTable = { events: [], byNoteId: new Map() };

/**
 * Compute the event table with the engraver's own law.
 *
 * `beatPeriodSec` must be the same number the build was handed, or the window this produces is
 * not the window the page was drawn with. Callers get it from the score's tempo — see
 * `App.chordEvents()`, which is the single site that builds this.
 */
export function collectChordEvents(
  feed: ReadonlyArray<InputNote>,
  beatPeriodSec: number
): ChordEventTable {
  if (!feed.length) return EMPTY_CHORD_EVENTS;
  // `collectChords` sorts and partitions; it does not mutate what it is given, but it does take a
  // mutable array, so the spread is required rather than defensive.
  const groups = collectChords([...feed], beatPeriodSec);
  const events: ChordEventRecord[] = [];
  const byNoteId = new Map<string, number>();
  for (const g of groups) {
    const memberIds = g.notes.map((n) => n.id).filter((id): id is string => !!id);
    // ...plus the ones the law admitted and the page could not print. See `memberIds`.
    for (const d of g.duplicates) memberIds.push(d.id);
    if (!memberIds.length) continue;
    // The event's name is its first member's id. Stable for as long as that note exists, which is
    // as long as the event does — a chord whose first member is deleted is a different event.
    const index = events.length;
    events.push({
      id: memberIds[0],
      onsetSec: g.onsetSec,
      endSec: g.endSec,
      memberIds,
      windowSec: g.windowSec,
      law: g.law
    });
    for (const id of memberIds) byNoteId.set(id, index);
  }
  return { events, byNoteId };
}

/** The event this note is written in, or null when the page does not write it as itself. */
export function eventFor(table: ChordEventTable, noteId: string): ChordEventRecord | null {
  const i = table.byNoteId.get(noteId);
  return i === undefined ? null : table.events[i];
}

/**
 * The ids that must change together when this one does.
 *
 * The answer the duration command needs, and the ONLY place it may get it. A note with no event —
 * a same-pitch duplicate the engraver folded away — answers with itself alone, so the command is
 * still well defined and still touches nothing else.
 */
export function chordMemberIds(table: ChordEventTable, noteId: string): string[] {
  return eventFor(table, noteId)?.memberIds ?? [noteId];
}

/**
 * Are these two ids written as one event?
 *
 * The relation the settling pass needs when it asks "is this a collision or a chord mate?".
 * Membership, not proximity: two notes 3 ms apart that the engraver put in different events
 * (because a group boundary fell between them) are a collision, and two notes 60 ms apart that it
 * put in the same event are not.
 */
export function sameEvent(table: ChordEventTable, a: string, b: string): boolean {
  if (a === b) return true;
  const ia = table.byNoteId.get(a);
  if (ia === undefined) return false;
  return ia === table.byNoteId.get(b);
}

/**
 * The chord window at a beat period — the engraver's, re-exported.
 *
 * For the one caller that legitimately needs a WINDOW rather than a membership answer: the
 * projection index, which must guess which lossy transformation ate a note it cannot find on the
 * page and therefore asks "was there an engraved note struck at the same moment?". That is a
 * question about proximity, not about membership, so a window is the right instrument.
 */
export { chordWindowSec };
