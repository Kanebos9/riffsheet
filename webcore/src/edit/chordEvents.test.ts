/**
 * CHORD MEMBERSHIP — one law, and the two directions the old one got it wrong in.
 *
 * The editor used to answer "which notes change with this one" by asking whether anything was
 * within 35 ms of the note that was clicked. The engraver answers it with a GREEDY PARTITION of
 * the whole note list, measured from each group's first onset, with an adaptive widening and a
 * separate written-tick law for symbolic sources. Those are different RELATIONS, not different
 * tolerances, and the audit produced counterexamples in both directions.
 *
 * Every case below is one of those counterexamples, run against the real `collectChords` through
 * `collectChordEvents`. Each fails if the membership authority is ever moved back to a window.
 */

import { chordMemberIds, collectChordEvents, eventFor, sameEvent } from './chordEvents';
import type { InputNote } from '@pipeline';

let checks = 0;
function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) throw new Error(message);
}

const note = (id: string, startSec: number, midi: number, endSec = startSec + 0.2): InputNote =>
  ({ id, startSec, endSec, midi }) as InputNote;

/** 120 BPM: a half-second beat, so the chord window is its 35 ms floor. */
const FAST = 0.5;
/** 60 BPM: a one-second beat, so the window widens to beatPeriod/16 = 62.5 ms. */
const SLOW = 1.0;

// ---------------------------------------------------------------------------
// 1 — OVER-MERGING BY CHAINING. The audit's headline counterexample.
// ---------------------------------------------------------------------------
{
  /*
   * Onsets at 0, 34 and 68 ms with a 35 ms base window.
   *
   * THE ENGRAVER takes 0 and 34 (34 falls in the last quarter of the window, so it widens to
   * 52.5), then finds 68 - 0 = 68 > 52.5 and starts a NEW group. Two chords.
   *
   * THE OLD EDITOR, asked about the middle note, found 0 within 35 ms and 68 within 35 ms and
   * called all three one chord — so a duration pick on the middle note rewrote a note the page
   * plainly draws as a separate event. That is "changing one duration changes another note".
   */
  const feed = [note('a', 0, 40), note('b', 0.034, 44), note('c', 0.068, 47)];
  const table = collectChordEvents(feed, FAST);

  assert(table.events.length === 2, 'the page draws TWO events here, not one');
  assert(sameEvent(table, 'a', 'b'), 'a and b are one chord');
  assert(!sameEvent(table, 'b', 'c'), 'b and c are NOT — the window widened past b and stopped');
  assert(!sameEvent(table, 'a', 'c'), 'and a and c certainly are not');

  const mates = chordMemberIds(table, 'b');
  assert(mates.length === 2, 'a duration pick on b touches two notes');
  assert(
    mates.includes('a') && mates.includes('b') && !mates.includes('c'),
    'exactly its own group — the old ±35 ms answer included c and was wrong'
  );
}

// ---------------------------------------------------------------------------
// 2 — UNDER-MERGING AT A SLOW TEMPO. The same fault in the other direction.
// ---------------------------------------------------------------------------
{
  /*
   * At 60 BPM the engraver's window is max(35 ms, 1000/16) = 62.5 ms, so attacks at 0 and 50 ms
   * are ONE engraved chord. A caller holding the 35 ms floor calls them two separate notes and
   * refuses to change them together — so picking a value for one member of a visible stack left
   * the other member at its old length, which is the tie-arc mess in the owner's screenshot.
   */
  const feed = [note('lo', 0, 36), note('hi', 0.05, 48)];
  const table = collectChordEvents(feed, SLOW);

  assert(table.events.length === 1, 'at 60 BPM these two are one engraved chord');
  assert(sameEvent(table, 'lo', 'hi'), 'and the editor agrees, because it reads the page');
  assert(
    chordMemberIds(table, 'lo').length === 2,
    'a duration pick on either member changes both — one stem, one length'
  );

  // ...and the SAME two notes at 120 BPM are two events. The relation depends on the tempo the
  // page was engraved at, which is precisely what a constant cannot encode.
  const fast = collectChordEvents(feed, FAST);
  assert(fast.events.length === 2, 'the same two onsets at 120 BPM are two events');
  assert(!sameEvent(fast, 'lo', 'hi'), 'so they are not mates there');
}

// ---------------------------------------------------------------------------
// 3 — A WRITTEN SOURCE IS GROUPED BY TICK, AND NEVER BY A WINDOW.
// ---------------------------------------------------------------------------
{
  /*
   * Adjacent 64ths at 140 BPM are 27 ms apart — inside any 35 ms window — and are two separate
   * written notes. The engraver never consults a window for a symbolic source: it admits exactly
   * the notes written on the same tick. The old editor fused them into a chord the source does
   * not contain.
   */
  const symbolic = (id: string, startTick: number, midi: number): InputNote =>
    ({
      id,
      startSec: (startTick / 480) * (60 / 140),
      endSec: (startTick / 480) * (60 / 140) + 0.02,
      midi,
      sourceTiming: { startTick, endTick: startTick + 30, ppq: 480 }
    }) as InputNote;

  const feed = [symbolic('s1', 0, 60), symbolic('s2', 30, 62), symbolic('stack', 0, 67)];
  const table = collectChordEvents(feed, 60 / 140);

  assert(table.events.length === 2, 'two written events: tick 0 and tick 30');
  assert(sameEvent(table, 's1', 'stack'), 'notes on the SAME tick are one chord');
  assert(
    !sameEvent(table, 's1', 's2'),
    'consecutive 64ths are two notes however few milliseconds separate them'
  );
}

// ---------------------------------------------------------------------------
// 4 — A DUPLICATE PITCH IS A MEMBER, even though the page gives it no notehead.
// ---------------------------------------------------------------------------
{
  /*
   * The chord law admits it; the engraver then cannot print one notehead twice, so it is folded
   * into the earlier arrival. It is still a note the player can see and drag ON THE ROLL, so it
   * must change with its chord — otherwise a duration pick sets every member's length except that
   * one, and the roll keeps drawing the stale rectangle under the changed glyph.
   *
   * What became of it ON THE PAGE is a different question, answered by `score/projection.ts` as
   * `merged`, naming the notehead that speaks for it.
   */
  const feed = [note('lo', 0, 40), note('dup', 0.004, 40), note('hi', 0.006, 47)];
  const table = collectChordEvents(feed, FAST);

  assert(table.events.length === 1, 'one strum');
  const members = chordMemberIds(table, 'lo');
  assert(members.length === 3, 'all three are members of the law’s answer');
  assert(members.includes('dup'), 'including the pitch the page could not print twice');
  assert(eventFor(table, 'dup') !== null, 'so it resolves to an event rather than to nothing');
}

// ---------------------------------------------------------------------------
// 5 — the degenerate cases stay well defined
// ---------------------------------------------------------------------------
{
  const empty = collectChordEvents([], FAST);
  assert(empty.events.length === 0, 'an empty feed has no events');
  assert(chordMemberIds(empty, 'nobody')[0] === 'nobody', 'an unknown id answers with itself alone');

  const single = collectChordEvents([note('only', 0, 40)], FAST);
  assert(single.events.length === 1, 'one note is one event');
  assert(chordMemberIds(single, 'only').length === 1, 'and its own only member');
  assert(sameEvent(single, 'only', 'only'), 'a note is its own mate');
}

// ---------------------------------------------------------------------------
// 6 — every event carries the window it was decided with
// ---------------------------------------------------------------------------
{
  // So a probe can show WHY two notes are or are not mates, rather than restating the law.
  const feed = [note('a', 0, 40), note('b', 0.034, 44)];
  const table = collectChordEvents(feed, FAST);
  const e = eventFor(table, 'a');
  assert(e !== null, 'the event exists');
  assert(e!.law === 'performance-window', 'a detected take is grouped by the window law');
  assert(e!.windowSec > 0.035, 'and the window really did widen past the floor for this group');

  const written = collectChordEvents(
    [
      { id: 'w', startSec: 0, endSec: 0.1, midi: 60, sourceTiming: { startTick: 0, endTick: 60, ppq: 480 } } as InputNote
    ],
    FAST
  );
  assert(eventFor(written, 'w')!.law === 'written-tick', 'a symbolic source says so');
}

console.log(`chordEvents.test: passed (${checks} checks)`);
