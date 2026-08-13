/**
 * Z4 — THE SHEET EDITING LAW, CHECKED WITHOUT A BROWSER.
 *
 * RUN IT:
 *
 *     cd webcore && node scripts/run-ts-tests.mjs src/edit/performanceEdit.test.ts
 *
 * (The same runner `cuts.test.ts` and `editBrain.test.ts` use. No new dependency.)
 *
 * ===========================================================================================
 * WHAT IT PROVES, and why each one is a test rather than a comment
 * ===========================================================================================
 *
 * 1. TOUCHED IDS INCLUDE THE VICTIMS. The whole reason this adapter exists rather than the
 *    roll's: a trim of a note the command never named is invisible to a merge that infers ids
 *    from the command, so it appears on screen and is undone by the next rebuild. Every case
 *    below asserts the victim by name.
 *
 * 2. THE COLLISION LAW'S FOUR CASES, individually: chord, overrun, landed-inside, collapse.
 *
 * 3. NO CHAIN REACTIONS. B is trimmed because A landed on it; C, which B was overlapping, is
 *    not touched. Enforced, not assumed.
 *
 * 4. A WRITTEN VALUE THE TICK DOMAIN CANNOT HOLD is refused rather than rounded — the dotted
 *    1/32 the menu greys out, refused again at the reducer so no other road can reach it.
 *
 * 5. BAR OPERATIONS SHIFT AND CLIP in the tick domain, name everything they moved, and never
 *    take the document below one bar.
 *
 * 6. THE CUT-AWARE MERGE keeps notes hidden inside a cut. A take with a cut in it that loses
 *    notes on the first edit is the failure mode this whole road is shaped around.
 */

import type { InputNote, NotationIntent } from '@pipeline';
import {
  applyBarOp,
  applyBarOpToPartNotes,
  applySheetEditToNotes,
  durationLabel,
  mergePerformanceEditOntoCutTake,
  type SheetEditContext
} from './performanceEdit';
import type { CutSpan } from './cuts';

let checks = 0;

function assert(condition: unknown, message: string): asserts condition {
  checks++;
  if (!condition) throw new Error(message);
}

function near(actual: number, expected: number, message: string, eps = 1e-9): void {
  assert(
    Math.abs(actual - expected) <= eps,
    `${message} (got ${actual}, wanted ${expected} +/- ${eps})`
  );
}

const note = (id: string, startSec: number, endSec: number, midi = 60): InputNote => ({
  id,
  startSec,
  endSec,
  midi
});

/** 120 bpm: a quarter note is half a second, so every written value is an exact number here. */
const ctx = (): SheetEditContext => ({
  originSec: 0,
  tempoBpm: 120,
  newNoteId: () => 'add1',
  intentLengthSec: (_startSec, intent: NotationIntent) => {
    const quarters = (4 / intent.denominator) * (intent.dots ? 1.5 : 1);
    // The one value the tick domain refuses, mirrored here so the test exercises the refusal
    // rather than a convenient stand-in for it: a dotted 1/32 is 4.5 ticks at 24 divisions.
    if (intent.denominator === 32 && intent.dots) return null;
    return quarters * 0.5;
  }
});

const byId = (notes: readonly InputNote[], id: string): InputNote => {
  const found = notes.find((n) => n.id === id);
  if (!found) throw new Error(`no note ${id}`);
  return found;
};

// ---------------------------------------------------------------------------
// 1 — set duration
// ---------------------------------------------------------------------------
{
  const feed = [note('a', 0, 0.5), note('b', 2, 2.5)];
  const out = applySheetEditToNotes(feed, { kind: 'setDuration', noteId: 'a', intent: { denominator: 2, dots: 0 } }, ctx());
  assert(out !== null, 'a half note is a written value the reducer accepts');
  near(byId(out.notes, 'a').endSec, 1, 'and a half note at 120 is one second long');
  assert(byId(out.notes, 'a').notationIntent?.denominator === 2, 'the INTENT is stored, not only the seconds');
  assert(out.touchedIds.has('a') && out.touchedIds.size === 1, 'nothing else was touched');
  assert(durationLabel({ denominator: 4, dots: 1 }) === 'Dotted quarter note', 'the undo label says what was chosen');

  // EDITED-NOTE-WINS. A whole note at 120 is exactly two seconds, so it reaches B's attack and
  // stops there of its own accord — B is neither swallowed nor moved.
  const long = applySheetEditToNotes(feed, { kind: 'setDuration', noteId: 'a', intent: { denominator: 1, dots: 0 } }, ctx());
  assert(long !== null, 'a whole note is accepted');
  near(byId(long.notes, 'a').endSec, 2, 'and it is exactly as long as the value that was chosen');
  assert(byId(long.notes, 'b').startSec === 2, 'which leaves the note it reached exactly where it was');

  // The refusal, at the reducer and not only in the menu.
  const dotted32 = applySheetEditToNotes(feed, { kind: 'setDuration', noteId: 'a', intent: { denominator: 32, dots: 1 } }, ctx());
  assert(dotted32 === null, 'a dotted 1/32 has no glyph and is refused rather than rounded');

  assert(
    applySheetEditToNotes(feed, { kind: 'setDuration', noteId: 'nope', intent: { denominator: 4, dots: 0 } }, ctx()) === null,
    'and an id this take has never heard of changes nothing'
  );
}

// ---------------------------------------------------------------------------
// 1b — THE DURATION COMMAND IS CHORD-WIDE, AND THE EDITED NOTE WINS (P1)
// ---------------------------------------------------------------------------
//
// THE REPORTED FAULT, reproduced first as a regression: a stacked C2/C3 whose members were
// struck three milliseconds apart — one chord on the page, because the engraver groups attacks
// inside 35 ms — used to be two colliding notes here. The chosen value was clipped against the
// note's OWN chord mate, so picking a length made the roll rectangle collapse to MIN_DUR_SEC and
// picking it again made nothing happen. Both halves are asserted: the fault is gone, and the
// rule that replaced it is the owner's.
{
  // C2 at 36 and C3 at 48, struck 3 ms apart: one engraved chord.
  const chordFeed = [note('c2', 0, 1.4, 36), note('c3', 0.003, 0.06, 48)];
  const half = applySheetEditToNotes(
    chordFeed,
    { kind: 'setDuration', noteId: 'c2', intent: { denominator: 2, dots: 0 } },
    ctx()
  );
  assert(half !== null, 'the duration applies to a chord');
  near(byId(half.notes, 'c2').endSec, 1, 'the note that was clicked gets exactly the chosen value');
  near(byId(half.notes, 'c3').endSec, 1, 'AND SO DOES ITS CHORD MATE — one stem, one length');
  assert(
    byId(half.notes, 'c3').notationIntent?.denominator === 2,
    'the written intent is on the mate too, or the engraver would print two opinions'
  );
  assert(half.touchedIds.has('c2') && half.touchedIds.has('c3'), 'both members are named');

  // IDEMPOTENT: the same pick again is a no-op, not another shortening. This is the loop.
  const again = applySheetEditToNotes(
    half.notes,
    { kind: 'setDuration', noteId: 'c2', intent: { denominator: 2, dots: 0 } },
    ctx()
  );
  assert(again !== null, 'applying the same value again still applies');
  near(byId(again.notes, 'c2').endSec, 1, 'and changes nothing: no successive shortening');
  near(byId(again.notes, 'c3').endSec, 1, 'for either member');

  // SWALLOWED AND OVERLAPPED, named victims, one command.
  const victims = [
    note('a', 0, 0.25, 40),
    note('inside', 0.6, 0.8, 42),
    note('crossing', 1.4, 3, 44)
  ];
  const wins = applySheetEditToNotes(
    victims,
    { kind: 'setDuration', noteId: 'a', intent: { denominator: 1, dots: 0 } },
    ctx()
  );
  assert(wins !== null, 'the command applies');
  near(byId(wins.notes, 'a').endSec, 2, 'the edited note gets the whole two seconds it asked for');
  assert(!wins.notes.some((n) => n.id === 'inside'), 'a neighbour entirely inside the new span is deleted');
  assert(wins.touchedIds.has('inside'), 'and NAMED, so one undo brings it back');
  near(byId(wins.notes, 'crossing').startSec, 2, 'a neighbour that outlives the span attacks where it stops');
  near(byId(wins.notes, 'crossing').endSec, 3, 'and keeps its own end');
  assert(wins.touchedIds.has('crossing'), 'named as well');

  // And that outcome is a fixed point too.
  const winsAgain = applySheetEditToNotes(
    wins.notes,
    { kind: 'setDuration', noteId: 'a', intent: { denominator: 1, dots: 0 } },
    ctx()
  );
  assert(winsAgain !== null, 're-applying applies');
  near(byId(winsAgain.notes, 'a').endSec, 2, 'the edited note is unchanged');
  near(byId(winsAgain.notes, 'crossing').startSec, 2, 'and so is the trimmed neighbour');
  assert(winsAgain.notes.length === wins.notes.length, 'nothing else is deleted on a repeat');
}

// ---------------------------------------------------------------------------
// 2 — the collision law, one case at a time
// ---------------------------------------------------------------------------
{
  // LANDED INSIDE: moving A into B's span trims B AT A's new attack, and NAMES B.
  const feed = [note('b', 0, 2, 60), note('a', 3, 3.5, 64)];
  const out = applySheetEditToNotes(feed, { kind: 'moveNote', noteId: 'a', startSec: 1 }, ctx());
  assert(out !== null, 'the move applies');
  near(byId(out.notes, 'b').endSec, 1, 'the note that was sounding is trimmed at the new attack');
  assert(out.touchedIds.has('b'), 'AND IT IS NAMED — this is the field the roll adapter lacks');
  assert(out.touchedIds.has('a') && out.touchedIds.size === 2, 'exactly the two notes that changed');
  near(byId(out.notes, 'a').endSec - byId(out.notes, 'a').startSec, 0.5, 'the moved note keeps its length');

  // SAME ONSET IS A CHORD. Nothing is trimmed and nothing but the mover is named.
  const chord = applySheetEditToNotes(feed, { kind: 'moveNote', noteId: 'a', startSec: 0 }, ctx());
  assert(chord !== null, 'landing on the same onset applies');
  near(byId(chord.notes, 'b').endSec, 2, 'a double stop is not a collision: the other note is untouched');
  assert(!chord.touchedIds.has('b'), 'and it is not named either');

  // THE CHORD WINDOW IS THE ENGRAVER'S, NOT AN EPSILON (P1). A note dropped a millisecond after
  // another attack has joined that chord as far as the page is concerned, so it is not a
  // collision and the other note is not trimmed. This used to trim it to MIN_DUR_SEC.
  const tight = applySheetEditToNotes(
    [note('b', 0, 2, 60), note('a', 5, 5.5, 64)],
    { kind: 'moveNote', noteId: 'a', startSec: 0.001 },
    ctx()
  );
  assert(tight !== null, 'a move that lands a millisecond after another attack applies');
  near(byId(tight.notes, 'b').endSec, 2, 'a 1 ms difference is one chord, so nothing is trimmed');
  assert(!tight.touchedIds.has('b'), 'and nothing but the mover is named');

  // COLLAPSE: past the chord window it IS a collision, and the victim keeps the minimum
  // surviving length rather than being trimmed out of existence.
  const collapse = applySheetEditToNotes(
    [note('b', 0, 2, 60), note('a', 5, 5.5, 64)],
    { kind: 'moveNote', noteId: 'a', startSec: 0.05 },
    ctx()
  );
  assert(collapse !== null, 'a move 50 ms after another attack applies');
  assert(
    byId(collapse.notes, 'b').endSec - byId(collapse.notes, 'b').startSec >= 0.04 - 1e-9,
    'and the victim keeps MIN_DUR_SEC rather than being trimmed out of existence'
  );
  assert(collapse.touchedIds.has('b'), 'named, because it really was trimmed');

  // TWO NOTES SOUNDING AT ONE NEW ATTACK are two direct victims, not a chain: both were
  // holding when A struck, so both stop. Asserted so the difference from a cascade is on record.
  const both = applySheetEditToNotes(
    [note('b', 0, 4, 60), note('c', 1, 4, 62), note('a', 9, 9.5, 64)],
    { kind: 'moveNote', noteId: 'a', startSec: 2 },
    ctx()
  );
  assert(both !== null, 'the move applies');
  near(byId(both.notes, 'b').endSec, 2, 'every note sounding at the new attack is trimmed to it');
  near(byId(both.notes, 'c').endSec, 2, 'both of them, because both were holding');
  assert(both.touchedIds.has('b') && both.touchedIds.has('c'), 'and both are named');

  // NO CHAIN REACTIONS. A trims B; the note that started where B used to END is not disturbed
  // by B having got shorter — a cascade would move or lengthen it into the room that opened up.
  const chain = applySheetEditToNotes(
    [note('b', 0, 4, 60), note('c', 4, 5, 62), note('a', 9, 9.5, 64)],
    { kind: 'moveNote', noteId: 'a', startSec: 2 },
    ctx()
  );
  assert(chain !== null, 'the move applies');
  near(byId(chain.notes, 'b').endSec, 2, 'B, which A landed inside, is trimmed');
  near(byId(chain.notes, 'c').startSec, 4, 'and C, which followed B, does not move into the gap');
  near(byId(chain.notes, 'c').endSec, 5, 'nor grow into it');
  assert(!chain.touchedIds.has('c'), 'so C is not named either');

  assert(
    applySheetEditToNotes(feed, { kind: 'moveNote', noteId: 'a', startSec: 3 }, ctx()) === null,
    'a move to where the note already is is not an edit'
  );
}

// ---------------------------------------------------------------------------
// 3 — add and delete
// ---------------------------------------------------------------------------
{
  const feed = [note('a', 0, 0.5, 60), note('b', 1, 2, 62)];
  const added = applySheetEditToNotes(feed, { kind: 'addNote', midi: 67, startSec: 0.5, durationSec: 0.5 }, ctx());
  assert(added !== null && added.notes.length === 3, 'a drawn note joins the performance');
  assert(added.touchedIds.has('add1'), 'and is named, because there is nothing behind it in the recording');
  near(byId(added.notes, 'add1').midi, 67, 'at the pitch the staff position named');

  // Trimmed by its neighbours: one beat long, but only as long as the room it was given.
  const squeezed = applySheetEditToNotes(feed, { kind: 'addNote', midi: 67, startSec: 0.25, durationSec: 2 }, ctx());
  assert(squeezed !== null, 'a note drawn in a gap applies');
  near(byId(squeezed.notes, 'add1').endSec, 1, 'and is trimmed at the next attack rather than covering it');

  const deleted = applySheetEditToNotes(feed, { kind: 'deleteNote', noteId: 'b' }, ctx());
  assert(deleted !== null && deleted.notes.length === 1, 'a delete removes exactly one note');
  assert(deleted.touchedIds.has('b') && deleted.label === 'Delete note', 'named, and labelled for the undo tooltip');
  assert(applySheetEditToNotes(feed, { kind: 'deleteNote', noteId: 'ghost' }, ctx()) === null, 'deleting nothing is nothing');
}

// ---------------------------------------------------------------------------
// 4 — bar operations
// ---------------------------------------------------------------------------
{
  // 4/4 at 120: a bar is two seconds. The caller supplies the TARGET BAR's own start and length
  // (from the score's bar ticks through the tempo map), so nothing here multiplies an index by a
  // nominal bar — see `BarOpContext.barStartSec`.
  const bar = 2;
  const at = (barIndex: number, barCount = 4) => ({
    barStartSec: barIndex * bar,
    barLengthSec: bar,
    barCount,
    splitId: (id: string) => `${id}~s1`
  });
  const feed = [note('a', 0.5, 1), note('b', 2.5, 3), note('c', 4.5, 5)];

  const inserted = applyBarOp(feed, { kind: 'insertBar', barIndex: 1, where: 'before' }, at(1));
  assert(inserted !== null, 'a bar can be inserted');
  near(byId(inserted.notes, 'a').startSec, 0.5, 'notes before the seam do not move');
  near(byId(inserted.notes, 'b').startSec, 4.5, 'notes at or after it move one bar later');
  near(byId(inserted.notes, 'c').startSec, 6.5, 'all of them, by exactly one bar');
  assert(inserted.barCount === 5, 'and the document declares one more bar');
  near(inserted.durationDeltaSec, bar, 'the SCORE timeline grew by one bar (never the audio)');
  assert(
    inserted.touchedIds.has('b') && inserted.touchedIds.has('c') && !inserted.touchedIds.has('a'),
    'everything that moved is named and nothing that did not is'
  );

  const after = applyBarOp(feed, { kind: 'insertBar', barIndex: 1, where: 'after' }, at(1));
  assert(after !== null, 'insert after applies');
  near(byId(after.notes, 'b').startSec, 2.5, 'the bar it was opened on keeps its own contents');
  near(byId(after.notes, 'c').startSec, 6.5, 'and only what follows moves');

  // THE SPLICE LAW: the inserted bar is EMPTY, so a note ringing across the seam is split at it.
  // Shifting only what had not started yet left a note sounding straight through the "empty" bar.
  const split = applyBarOp([note('long', 0.5, 3.5)], { kind: 'insertBar', barIndex: 1, where: 'before' }, at(1));
  assert(split !== null, 'the insert applies to a note that crosses the seam');
  assert(split.notes.length === 2, 'and the note becomes two pieces');
  near(byId(split.notes, 'long').startSec, 0.5, 'the head keeps the attack');
  near(byId(split.notes, 'long').endSec, 2, 'and stops at the seam');
  near(byId(split.notes, 'long~s1').startSec, 4, 'the tail is re-attacked past the inserted bar');
  near(byId(split.notes, 'long~s1').endSec, 5.5, 'with exactly the length that was left');
  assert(
    split.touchedIds.has('long') && split.touchedIds.has('long~s1'),
    'both pieces are named, or the merge would restore the un-split note'
  );
  assert(
    !split.notes.some((n) => n.startSec < 4 - 1e-9 && n.endSec > 2 + 1e-9),
    'THE INSERTED BAR IS EMPTY: nothing sounds anywhere inside [2, 4)'
  );

  const removed = applyBarOp(feed, { kind: 'deleteBar', barIndex: 1 }, at(1));
  assert(removed !== null, 'a bar can be deleted');
  assert(!removed.notes.some((n) => n.id === 'b'), 'notes attacked inside it go with it');
  assert(removed.touchedIds.has('b'), 'and are named, so the merge does not restore them');
  near(byId(removed.notes, 'c').startSec, 2.5, 'what followed moves earlier by one bar');
  assert(removed.barCount === 3, 'and the document is one bar shorter');
  near(removed.durationDeltaSec, -bar, 'the score timeline shrank by one bar');

  // A note spanning the WHOLE deleted interval is STITCHED: it loses exactly the bar's seconds
  // and keeps everything it had on the far side.
  const crossing = applyBarOp([note('long', 0.5, 5)], { kind: 'deleteBar', barIndex: 1 }, at(1));
  assert(crossing !== null, 'the delete applies');
  near(byId(crossing.notes, 'long').startSec, 0.5, 'the note keeps its attack');
  near(byId(crossing.notes, 'long').endSec, 3, 'and loses exactly the two seconds that went');

  // ...and one that ends INSIDE the deleted bar is clipped at the seam, because everything it
  // had left was in the bar that went.
  const clipped = applyBarOp([note('long', 0.5, 3)], { kind: 'deleteBar', barIndex: 1 }, at(1));
  assert(clipped !== null, 'the delete applies');
  near(byId(clipped.notes, 'long').endSec, 2, 'clipped at the seam');

  // ROUND TRIP: insert then delete the same bar puts every attack back where it was.
  const back = applyBarOp(inserted.notes, { kind: 'deleteBar', barIndex: 1 }, at(1, 5));
  assert(back !== null, 'the inserted bar can be deleted again');
  near(byId(back.notes, 'b').startSec, 2.5, 'and B is back where it started');
  near(byId(back.notes, 'c').startSec, 4.5, 'and so is C');
  assert(back.barCount === 4, 'with the document back to its original length');

  // EVERY PART SHARES THE CLOCK: an imported part splices with the same arithmetic.
  const part = applyBarOpToPartNotes(
    [note('p1', 0.5, 1), note('p2', 2.5, 3)],
    { kind: 'insertBar', barIndex: 1, where: 'before' },
    at(1)
  );
  near(byId(part, 'p1').startSec, 0.5, 'an imported note before the seam does not move');
  near(byId(part, 'p2').startSec, 4.5, 'and one after it moves by the same bar the take moved by');

  assert(
    applyBarOp(feed, { kind: 'deleteBar', barIndex: 0 }, at(0, 1)) === null,
    'the last bar of a document cannot be deleted'
  );
  assert(
    applyBarOp(feed, { kind: 'insertBar', barIndex: 0 }, { ...at(0), barLengthSec: 0 }) === null,
    'and a document with no bar length is refused rather than divided by zero'
  );
}

// ---------------------------------------------------------------------------
// 5 — the cut-aware merge
// ---------------------------------------------------------------------------
{
  // The recording holds three notes; the middle one's attack is inside a cut, so the FEED the
  // player edited never contained it. A merge that rebuilt the take out of the feed would
  // delete it — which is a cut becoming destructive, one edit later.
  const cuts: CutSpan[] = [{ fromSec: 1, toSec: 2 }];
  const raw = [note('a', 0, 0.5), note('hidden', 1.2, 1.8), note('c', 3, 3.5)];
  // In edited seconds the third note sits at 2, because one second of tape was closed up.
  const edited = [note('a', 0, 0.5), note('c', 2, 2.5)];
  const movedC = edited.map((n) => (n.id === 'c' ? { ...n, startSec: 2.5, endSec: 3 } : n));

  const merged = mergePerformanceEditOntoCutTake(raw, movedC, new Set(['c']), cuts);
  assert(merged.length === 3, 'the note hidden inside the cut survives the edit');
  assert(merged.some((n) => n.id === 'hidden'), 'by name');
  near(byId(merged, 'hidden').startSec, 1.2, 'and exactly where the recording had it');
  near(byId(merged, 'c').startSec, 3.5, 'while the edited note lands back on the RECORDING clock');
  near(byId(merged, 'a').startSec, 0, 'and the untouched note is the recording"s own');
}

console.log(`performanceEdit.test: passed (${checks} checks)`);
