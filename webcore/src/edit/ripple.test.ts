/**
 * THE RIPPLE RULE, as a law rather than as a screenshot.
 *
 * Everything under test is pure: ticks in, ticks out, no DOM, no score, no app. The wiring —
 * which layer applies the log, what one undo step contains, whether the roll and the sheet see the
 * same result — is `scripts/ripple-probe.mjs`, which drives the real app.
 *
 * Run by `npm run test:edit-units`.
 */

import type { InputNote } from '@pipeline';
import {
  applyRippleOps,
  planDurationRipple,
  rational,
  ratAdd,
  ratCmp,
  ratFromTick,
  ratValue,
  rippleEndTick,
  rippleMovedIds,
  spliceSourceBars,
  unrippleNotes,
  type RippleOp,
  type RippleTickMap
} from './ripple';

let checks = 0;
function assert(condition: unknown, message: string): asserts condition {
  checks++;
  if (!condition) throw new Error(`ripple.test: ${message}`);
}
const close = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// The maps. One flat, one with a tempo change, so "never one deltaSec" is testable.
// ---------------------------------------------------------------------------

/** 120 bpm, 24 divisions to a quarter: one IR tick is 1/48 s. */
const DIVISIONS = 24;
const flat: RippleTickMap = {
  toTick: (sec) => sec * 48,
  toSec: (tick) => tick / 48
};

/**
 * HALF SPEED FROM TICK 96 (bar 2 at 4/4). Before it a tick is 1/48 s, after it 1/24 s — so an
 * equal TICK displacement is a different SECONDS displacement depending on where you are, which is
 * the entire reason the law is stated in ticks.
 */
const CHANGE_TICK = 96;
const CHANGE_SEC = CHANGE_TICK / 48;
const ramped: RippleTickMap = {
  toTick: (sec) => (sec <= CHANGE_SEC ? sec * 48 : CHANGE_TICK + (sec - CHANGE_SEC) * 24),
  toSec: (tick) => (tick <= CHANGE_TICK ? tick / 48 : CHANGE_SEC + (tick - CHANGE_TICK) / 24)
};

const note = (id: string, startTick: number, endTick: number, map = flat, extra: Partial<InputNote> = {}): InputNote => ({
  id,
  midi: 60,
  startSec: map.toSec(startTick),
  endSec: map.toSec(endTick),
  ...extra
});

const at = (n: InputNote | undefined, map = flat): [number, number] =>
  n ? [Math.round(map.toTick(n.startSec) * 1e6) / 1e6, Math.round(map.toTick(n.endSec) * 1e6) / 1e6] : [NaN, NaN];

// ---------------------------------------------------------------------------
// 1. Rationals
// ---------------------------------------------------------------------------

assert(ratValue(rational(6, 4)) === 1.5, 'rationals normalise');
assert(rational(6, 4).n === 3 && rational(6, 4).d === 2, '6/4 is stored as 3/2');
assert(ratCmp(rational(1, 3), rational(2, 6)) === 0, 'equal rationals compare equal');
assert(ratCmp(rational(1, 3), rational(1, 4)) === 1, '1/3 > 1/4');
// THE POINT OF EXACTNESS: a hundred thirds added and a hundred subtracted is EXACTLY zero, which
// float seconds are not.
{
  let acc = rational(0);
  for (let i = 0; i < 100; i++) acc = ratAdd(acc, rational(1, 3));
  for (let i = 0; i < 100; i++) acc = ratAdd(acc, rational(-1, 3));
  assert(acc.n === 0, 'a hundred thirds up and down is exactly zero in the rational domain');
  let float = 0;
  for (let i = 0; i < 100; i++) float += 1 / 3;
  for (let i = 0; i < 100; i++) float -= 1 / 3;
  assert(float !== 0, 'the same sum in floats is NOT zero — which is why this domain exists');
}
// A derived seam is quantised to thousandths of a tick — a millionth of a quarter note, which
// nothing in a document can be inside of — and then normalised like any other rational.
assert(ratValue(ratFromTick(12.3456789)) === 12.346, 'a derived seam is stored at sub-tick precision');

// ---------------------------------------------------------------------------
// 2. The law: what shifts, what does not, and the crossing rule
// ---------------------------------------------------------------------------

const chordId = 'a';
const feed: InputNote[] = [
  note('a', 0, 24), // the edited quarter
  note('b', 24, 48), // attacks exactly at the seam — SHIFTS
  note('c', 48, 72),
  note('d', 12, 60) // began before the seam and is still sounding at it — CROSSES
];

const lengthen = planDurationRipple({
  feed,
  chordIds: [chordId],
  newLengthTicks: 48, // a half
  written: { startTick: 0, endTick: 24 },
  map: flat,
  opId: 'op1',
  label: 'Half note'
});
assert(lengthen.rejected === null && lengthen.op, 'lengthening a quarter to a half is expressible');
assert(ratValue(lengthen.op!.deltaTick) === 24, 'the delta is the WRITTEN difference, in IR ticks');
assert(ratValue(lengthen.op!.seamTick) === 24, 'the seam is the old release');

{
  const after = applyRippleOps(feed, [lengthen.op!], { map: flat, divisions: DIVISIONS });
  const by = (id: string) => after.find((n) => n.id === id);
  assert(String(at(by('a'))) === String([0, 48]), 'the edited chord keeps its attack and takes the new value');
  assert(String(at(by('b'))) === String([48, 72]), 'an attack exactly at the old end moves by the delta');
  assert(String(at(by('c'))) === String([72, 96]), 'everything after it moves by the same delta');
  assert(String(at(by('d'))) === String([12, 84]), 'a note sustaining across the seam keeps its attack and moves its release');
  assert(after.length === feed.length, 'a duration ripple neither adds nor drops a note');
}

// A NOTE THAT BEGAN BEFORE THE SEAM AND ENDED BEFORE IT DOES NOT MOVE AT ALL.
{
  const withEarly = [...feed, note('e', 2, 10)];
  const after = applyRippleOps(withEarly, [lengthen.op!], { map: flat, divisions: DIVISIONS });
  assert(String(at(after.find((n) => n.id === 'e'))) === String([2, 10]), 'material before the seam is untouched');
  assert(after.find((n) => n.id === 'e') === withEarly[withEarly.length - 1], '…and comes back by reference');
}

// SHORTENING PULLS. The same law with a negative delta.
{
  const shorten = planDurationRipple({
    feed,
    chordIds: [chordId],
    newLengthTicks: 12,
    written: { startTick: 0, endTick: 24 },
    map: flat,
    opId: 'op1'
  });
  assert(ratValue(shorten.op!.deltaTick) === -12, 'shortening produces a negative delta');
  const after = applyRippleOps(feed, [shorten.op!], { map: flat, divisions: DIVISIONS });
  const by = (id: string) => after.find((n) => n.id === id);
  assert(String(at(by('a'))) === String([0, 12]), 'the chord takes the shorter value');
  assert(String(at(by('b'))) === String([12, 36]), 'the rest of the score is PULLED');
  assert(String(at(by('d'))) === String([12, 48]), 'the crossing note keeps its attack and gives up the delta');
}

// THE REJECTION, adjudicated. A note crossing the seam that the pull would flatten.
{
  const tight: InputNote[] = [note('a', 0, 24), note('x', 23, 25)];
  const refused = planDurationRipple({
    feed: tight,
    chordIds: ['a'],
    newLengthTicks: 1,
    written: { startTick: 0, endTick: 24 },
    map: flat,
    opId: 'op1'
  });
  assert(refused.op === null, 'the edit is refused rather than silently trimming');
  assert(!!refused.rejected && refused.rejected.includes('still sounding'), 'and it says why, in a sentence');
  // …and the SAME take with a shorter pull is fine, so the refusal is about the arithmetic and not
  // about the note existing.
  const allowed = planDurationRipple({
    feed: tight,
    chordIds: ['a'],
    newLengthTicks: 23,
    written: { startTick: 0, endTick: 24 },
    map: flat,
    opId: 'op1'
  });
  assert(allowed.op !== null && allowed.rejected === null, 'a pull that leaves a printable tick is allowed');
}

// A CHORD IS ONE ATOM: three noteheads, one ripple, one delta, and none of them in the suffix.
{
  const strum: InputNote[] = [
    { id: 'c0', midi: 40, startSec: 0, endSec: 0.5 },
    { id: 'c1', midi: 47, startSec: 0.004, endSec: 0.49 },
    { id: 'c2', midi: 52, startSec: 0.008, endSec: 0.52 },
    note('after', 26, 50)
  ];
  const plan = planDurationRipple({
    feed: strum,
    chordIds: ['c0', 'c1', 'c2'],
    newLengthTicks: 48,
    written: { startTick: 0, endTick: 24 },
    map: flat,
    opId: 'op1'
  });
  // The seam is the LONGEST member's release — one written value is one release for the stack.
  assert(close(ratValue(plan.op!.seamTick), 0.52 * 48), 'the seam is the event, not the notehead');
  const after = applyRippleOps(strum, [plan.op!], { map: flat, divisions: DIVISIONS });
  const ends = ['c0', 'c1', 'c2'].map((id) => after.find((n) => n.id === id)!.endSec);
  assert(new Set(ends.map((e) => e.toFixed(9))).size === 1, 'every notehead in the stack ends together');
  const starts = ['c0', 'c1', 'c2'].map((id) => after.find((n) => n.id === id)!.startSec);
  assert(
    starts.every((s, i) => s === strum[i].startSec),
    'their attacks are the performance and are not moved'
  );
  assert(after.find((n) => n.id === 'after')!.startSec > strum[3].startSec, 'and the suffix shifted once, not three times');
}

// ---------------------------------------------------------------------------
// 3. THE TEMPO MAP: absolute endpoints, never one scalar deltaSec
// ---------------------------------------------------------------------------

{
  const across: InputNote[] = [
    note('a', 0, 24, ramped),
    note('near', 48, 72, ramped), // before the tempo change
    note('far', 120, 144, ramped) // after it, where a tick is worth twice as many seconds
  ];
  const plan = planDurationRipple({
    feed: across,
    chordIds: ['a'],
    newLengthTicks: 36,
    written: { startTick: 0, endTick: 24 },
    map: ramped,
    opId: 'op1'
  });
  assert(ratValue(plan.op!.deltaTick) === 12, 'the delta is twelve ticks wherever it lands');
  const after = applyRippleOps(across, [plan.op!], { map: ramped, divisions: DIVISIONS });
  const near = after.find((n) => n.id === 'near')!;
  const far = after.find((n) => n.id === 'far')!;
  assert(close(ramped.toTick(near.startSec), 60), 'the near note moved twelve ticks');
  assert(close(ramped.toTick(far.startSec), 132), 'so did the far one');
  const nearSecs = near.startSec - across[1].startSec;
  const farSecs = far.startSec - across[2].startSec;
  assert(
    farSecs > nearSecs * 1.9,
    `an equal tick shift is a DIFFERENT seconds shift across a tempo change (${nearSecs} vs ${farSecs}) — one scalar deltaSec cannot express this`
  );
}

// ---------------------------------------------------------------------------
// 4. REPEATED RIPPLES: a hundred up, a hundred down, no residue
// ---------------------------------------------------------------------------

{
  const start: InputNote[] = [note('a', 0, 24), note('b', 24, 48), note('c', 96, 120)];
  const ops: RippleOp[] = [];
  // A THIRD OF A QUARTER each time — a triplet eighth — so the arithmetic cannot hide in binary
  // fractions the way halves and quarters do.
  for (let i = 0; i < 100; i++) {
    ops.push({ id: `up${i}`, seamTick: rational(24), deltaTick: rational(8), chordIds: ['a'], chordEndTick: rational(24) });
  }
  for (let i = 0; i < 100; i++) {
    ops.push({ id: `dn${i}`, seamTick: rational(24), deltaTick: rational(-8), chordIds: ['a'], chordEndTick: rational(24) });
  }
  const after = applyRippleOps(start, ops, { map: flat, divisions: DIVISIONS });
  for (const id of ['b', 'c']) {
    const was = start.find((n) => n.id === id)!;
    const now = after.find((n) => n.id === id)!;
    assert(now.startSec === was.startSec && now.endSec === was.endSec, `${id} is bit-identical after 200 ripples`);
  }
  // …AND ACROSS A TEMPO CHANGE, where converting to seconds on every operation would round 200
  // times through the map.
  const rampAfter = applyRippleOps([note('c', 120, 144, ramped)], ops, { map: ramped, divisions: DIVISIONS });
  assert(
    rampAfter[0].startSec === ramped.toSec(120),
    'the same, past a tempo change — one conversion at each end, not one per operation'
  );
}

// ---------------------------------------------------------------------------
// 5. Multipart: `sourceTiming` moves by an EXACT tick ratio
// ---------------------------------------------------------------------------

{
  // A part at 480 ppq against an IR at 24 divisions: 20 source ticks to one IR tick.
  const part: InputNote[] = [
    note('p0', 24, 48, flat, { sourceTiming: { startTick: 480, endTick: 960, ppq: 480 } })
  ];
  const op: RippleOp = { id: 'op1', seamTick: rational(24), deltaTick: rational(12) };
  const after = applyRippleOps(part, [op], { map: flat, divisions: DIVISIONS });
  assert(
    after[0].sourceTiming!.startTick === 480 + 240 && after[0].sourceTiming!.endTick === 960 + 240,
    `12 IR ticks x 480/24 = 240 source ticks: ${JSON.stringify(after[0].sourceTiming)}`
  );

  // A RATIO THAT DOES NOT DIVIDE. 7 IR ticks at ppq 96 against divisions 24 is 28 source ticks —
  // and the same shift applied as seven separate operations must land on the same tick, which
  // rounding each one independently would not.
  const odd: InputNote[] = [note('q0', 24, 48, flat, { sourceTiming: { startTick: 100, endTick: 200, ppq: 96 } })];
  const one = applyRippleOps(odd, [{ id: 'o', seamTick: rational(24), deltaTick: rational(7) }], {
    map: flat,
    divisions: DIVISIONS
  });
  const seven = applyRippleOps(
    odd,
    Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, seamTick: rational(24), deltaTick: rational(1) })),
    { map: flat, divisions: DIVISIONS }
  );
  assert(
    one[0].sourceTiming!.startTick === seven[0].sourceTiming!.startTick,
    `one shift of 7 and seven shifts of 1 must agree: ${one[0].sourceTiming!.startTick} vs ${seven[0].sourceTiming!.startTick}`
  );
  assert(one[0].sourceTiming!.startTick === 128, 'and the answer is the exact one: 100 + 7 x 96/24');
}

// ---------------------------------------------------------------------------
// 6. Bar operations through the same storage
// ---------------------------------------------------------------------------

{
  const bar: InputNote[] = [
    note('before', 0, 24),
    note('cross', 60, 120), // sounding across the seam at 96
    note('after', 96, 120)
  ];
  const insert: RippleOp = { id: 'bar1', seamTick: rational(96), deltaTick: rational(96), split: true };
  const out = applyRippleOps(bar, [insert], { map: flat, divisions: DIVISIONS });
  const by = (id: string) => out.find((n) => n.id === id);
  assert(String(at(by('before'))) === String([0, 24]), 'an insert leaves the material before it alone');
  assert(String(at(by('after'))) === String([192, 216]), 'and pushes the material after it by a whole bar');
  assert(String(at(by('cross'))) === String([60, 96]), 'a note sounding across the seam stops AT it…');
  const tail = out.find((n) => n.id === 'rip:bar1:cross');
  assert(!!tail && String(at(tail)) === String([192, 216]), '…and is re-attacked past the inserted bar');
  assert(tail!.id === 'rip:bar1:cross', 'the tail is named deterministically, so re-deriving the feed is stable');
  // DETERMINISM IS THE POINT: apply the same log twice and the same names come out.
  const again = applyRippleOps(bar, [insert], { map: flat, divisions: DIVISIONS });
  assert(again.map((n) => n.id).join() === out.map((n) => n.id).join(), 'the same log produces the same identities');

  const remove: RippleOp = { id: 'bar2', seamTick: rational(96), deltaTick: rational(-96), dropSpan: true };
  const gone = applyRippleOps(
    [note('before', 0, 24), note('cross', 60, 240), note('inside', 100, 140), note('later', 192, 216)],
    [remove],
    { map: flat, divisions: DIVISIONS }
  );
  assert(!gone.find((n) => n.id === 'inside'), 'an attack inside the deleted bar goes with it');
  assert(!gone.find((n) => n.id === 'after'), 'an attack exactly at the seam is inside the bar that is going');
  assert(String(at(gone.find((n) => n.id === 'later'))) === String([96, 120]), 'the rest is pulled back by a whole bar');
  assert(
    String(at(gone.find((n) => n.id === 'cross'))) === String([60, 144]),
    'a note crossing the deleted bar is STITCHED — it loses exactly the time the bar took'
  );
  // …and one whose release was INSIDE the deleted bar stops at the seam rather than being pulled
  // back past its own attack.
  const stub = applyRippleOps([note('c2', 60, 140)], [remove], { map: flat, divisions: DIVISIONS });
  assert(String(at(stub[0])) === String([60, 96]), 'a release inside the deleted bar lands on the seam');
}

// THE BAR MAP an imported symbolic part is engraved against moves too.
{
  const bars = [
    { startTick: 0, durationTicks: 1920, ppq: 480, timeSig: [4, 4] as [number, number], number: 1, implicit: false },
    { startTick: 1920, durationTicks: 1920, ppq: 480, timeSig: [4, 4] as [number, number], number: 2, implicit: false },
    { startTick: 3840, durationTicks: 1920, ppq: 480, timeSig: [4, 4] as [number, number], number: 3, implicit: false }
  ];
  const inserted = spliceSourceBars(bars, 'insertBar', 1920);
  assert(inserted.length === 4, 'an insert adds a bar to the ruler, not only to the notes');
  assert(inserted.map((b) => b.startTick).join() === '0,1920,3840,5760', 'and pushes every later bar on by its length');
  assert(inserted.map((b) => b.number).join() === '1,2,3,4', 'bars are renumbered — a map with two bar 2s is not a map');
  const deleted = spliceSourceBars(bars, 'deleteBar', 1920);
  assert(deleted.length === 2 && deleted.map((b) => b.startTick).join() === '0,1920', 'a delete removes it and pulls back');
}

// ---------------------------------------------------------------------------
// 7. The structural end, and what it is a floor for
// ---------------------------------------------------------------------------

{
  const ops: RippleOp[] = [{ id: 'o', seamTick: rational(96), deltaTick: rational(24) }];
  const grown = rippleEndTick(ops, ratFromTick(192), 0);
  assert(ratValue(grown) === 216, 'a positive ripple past the end grows the document end by exactly the delta');
  const early = rippleEndTick([{ id: 'o', seamTick: rational(300), deltaTick: rational(24) }], ratFromTick(192), 0);
  assert(ratValue(early) === 192, 'a ripple past the end of the document does not move it');
  const floored = rippleEndTick([{ id: 'o', seamTick: rational(96), deltaTick: rational(-96) }], ratFromTick(192), 150);
  assert(ratValue(floored) === 150, 'a shortening may not pull the end inside the material');
}

// ---------------------------------------------------------------------------
// 8. writebackIds vs authoredIds — what a ripple may claim to have touched
// ---------------------------------------------------------------------------

{
  const moved = rippleMovedIds(feed, [lengthen.op!], flat);
  assert(moved.has('b') && moved.has('c') && moved.has('d'), 'every shifted note is a writeback id');
  assert(moved.has('a'), 'so is the chord, whose release the operation stated');
  // The AUTHORED half is the caller's: the chord alone. `ui/app.ts` is where that split is spent,
  // and `scripts/ripple-probe.mjs` is what asserts it did not dump the tail into `userTouchedIds`.
  assert(moved.size === 4, 'and nothing else is claimed');
}

// ---------------------------------------------------------------------------
// 9. THE LOG, RUN BACKWARDS — what every write-back road has to pass through
// ---------------------------------------------------------------------------
//
// A gesture is made against the FEED and stored in the RECORDING, and the ripple sits between the
// two exactly as the cut list does. Without an inverse, a note ADDED to a lengthened score is
// recorded at the second it was dropped at, the next feed derivation applies the log to it, and
// the note appears somewhere other than under the pixel that was clicked. That is not theoretical:
// it is what `scripts/sheet-edit-probe.mjs` §"add note lands on a BEAT" caught the moment the log
// went live.
{
  const ops: RippleOp[] = [
    { id: 'o1', seamTick: rational(24), deltaTick: rational(24), chordIds: ['a'], chordEndTick: rational(48) },
    { id: 'o2', seamTick: rational(120), deltaTick: rational(-12) }
  ];
  const recorded: InputNote[] = [note('a', 0, 24), note('b', 30, 54), note('c', 150, 180)];
  const shown = applyRippleOps(recorded, ops, { map: flat, divisions: DIVISIONS });
  const back = unrippleNotes(shown, ops, flat);
  for (const was of recorded) {
    // THE ATOM IS DELIBERATELY NOT A ROUND TRIP. Its attack never moved and its release was
    // STATED by the operation rather than shifted by it, so there is nothing to run backwards —
    // its recorded span is still its recorded span. See `unrippleNotes`.
    if (was.id === 'a') continue;
    const now = back.find((n) => n.id === was.id)!;
    assert(
      close(now.startSec, was.startSec) && close(now.endSec, was.endSec),
      `${was.id} must survive the round trip: ${JSON.stringify(at(now))} vs ${JSON.stringify(at(was))}`
    );
  }
  assert(
    String(at(back.find((n) => n.id === 'a'))) === String([0, 48]),
    "the atom's shown span passes through: the operation states it, so inverting it would erase the edit"
  );

  // A NOTE ADDED TO THE RIPPLED PICTURE lands where it was dropped, and STAYS there when the log
  // is applied to the recording it was stored in.
  const dropped = note('new', 200, 224);
  const stored = unrippleNotes([dropped], ops, flat)[0];
  const redrawn = applyRippleOps([stored], ops, { map: flat, divisions: DIVISIONS })[0];
  assert(
    close(redrawn.startSec, dropped.startSec) && close(redrawn.endSec, dropped.endSec),
    `a note added after a ripple must stay under the pixel it was dropped on: ${JSON.stringify(at(redrawn))}`
  );

  // INSIDE INSERTED TIME there is no pre-image — a point in a bar that did not exist — so it
  // resolves to the seam, where the material either side of it agrees.
  const inserted = unrippleNotes([note('x', 30, 40)], [{ id: 'i', seamTick: rational(24), deltaTick: rational(96), split: true }], flat)[0];
  assert(close(flat.toTick(inserted.startSec), 24), 'a point inside an inserted bar collapses onto the seam');

  // AND IT IS THE IDENTITY WITH NO LOG — an un-rippled document hands its own array straight back.
  assert(unrippleNotes(recorded, [], flat) === recorded, 'no log, no work, same array');
}

console.log(`ripple.test: passed (${checks} checks)`);
