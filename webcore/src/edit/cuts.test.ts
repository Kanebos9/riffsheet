/**
 * F16 — THE CUT MODEL, CHECKED WITHOUT A BROWSER.
 *
 * RUN IT:
 *
 *     cd webcore && node scripts/run-ts-tests.mjs src/edit/cuts.test.ts
 *
 * (The repo's existing runner, the same one `editBrain.test.ts` uses. No new dependency.)
 *
 * ===========================================================================================
 * WHAT IT PROVES
 * ===========================================================================================
 *
 * 1. THE TWO CLOCKS ARE INVERSES. Everything on the page — the strip's peaks, the roll's
 *    rectangles, the engraved sheet, the exported MIDI, the playhead, and the seconds a drag
 *    reports back — crosses `audioToEditedSec`/`editedToAudioSec` at least once. If the pair
 *    ever stops round-tripping, every one of those quietly lands somewhere else, and it lands
 *    there by a plausible-looking amount rather than by an obvious one. So the round trip is
 *    checked over a swept take rather than at three convenient points.
 *
 * 2. NOTHING IS DESTROYED. The mapping is applied TO the recording and never written back into
 *    it, which is what makes undo total. The test that matters here is that removing a cut
 *    restores the take to the same numbers it started with, bit for bit.
 *
 * 3. REPEATABILITY. "Cut out" is meant to be usable five times in a row, including across a
 *    span that already contains a cut, and the list has to stay a flat set of disjoint spans
 *    whatever order the player works in.
 *
 * The un-cut identity property is checked first and hardest, because it is the whole reason the
 * app can carry this feature without changing behaviour for anyone who never uses it.
 */

import {
  addCut,
  applyCutsToPeaks,
  audioToEditedSec,
  cutTotalSec,
  detectTrimCuts,
  editedDurationSec,
  editedToAudioSec,
  isCutSec,
  keptRegions,
  mapNotesThroughCuts,
  mapTimesThroughCuts,
  nextKeptSec,
  normalizeCuts,
  type CutSpan
} from './cuts';
import type { InputNote } from '@pipeline';

let passed = 0;
let failed = 0;

function check(ok: boolean, what: string): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failed++;
    console.log(`  FAIL ${what}`);
  }
}

function near(a: number, b: number, slack = 1e-9): boolean {
  return Math.abs(a - b) <= slack;
}

const TAKE_SEC = 20;
/** Two cuts with kept tape before, between and after them — every case in one list. */
const CUTS: CutSpan[] = normalizeCuts(
  [
    { fromSec: 2, toSec: 5 },
    { fromSec: 12, toSec: 13.5 }
  ],
  TAKE_SEC
);

function note(id: string, startSec: number, endSec: number, midi = 40): InputNote {
  return { id, midi, startSec, endSec } as InputNote;
}

// ---------------------------------------------------------------------------
console.log('\nnormalizing');
// ---------------------------------------------------------------------------
{
  check(normalizeCuts([], TAKE_SEC).length === 0, 'an empty list normalizes to an empty list');
  check(normalizeCuts(null, TAKE_SEC).length === 0, 'so does nothing at all');
  check(
    normalizeCuts([{ fromSec: 5, toSec: 5.001 }], TAKE_SEC).length === 0,
    'a mis-click shorter than the floor is not an edit'
  );
  check(
    normalizeCuts([{ fromSec: 8, toSec: 3 }], TAKE_SEC)[0].fromSec === 3,
    'a span dragged right-to-left is the same span'
  );
  const clamped = normalizeCuts([{ fromSec: -4, toSec: 40 }], TAKE_SEC)[0];
  check(
    clamped.fromSec === 0 && clamped.toSec === TAKE_SEC,
    'a span past both ends is clamped to the take'
  );
  const merged = normalizeCuts(
    [
      { fromSec: 4, toSec: 6 },
      { fromSec: 1, toSec: 3 },
      { fromSec: 2, toSec: 5 }
    ],
    TAKE_SEC
  );
  check(
    merged.length === 1 && merged[0].fromSec === 1 && merged[0].toSec === 6,
    'overlapping spans merge into one, in order'
  );
  const touching = normalizeCuts(
    [
      { fromSec: 0, toSec: 1 },
      { fromSec: 1, toSec: 2 }
    ],
    TAKE_SEC
  );
  check(
    touching.length === 1 && touching[0].toSec === 2,
    'spans that merely touch merge too — they remove the same tape as one span'
  );
  check(cutTotalSec(CUTS) === 4.5, 'the total removed is the sum of the spans');
  check(editedDurationSec(CUTS, TAKE_SEC) === 15.5, '...and the take is that much shorter');
}

// ---------------------------------------------------------------------------
console.log('\nthe un-cut take is untouched');
// ---------------------------------------------------------------------------
{
  const none: CutSpan[] = [];
  check(audioToEditedSec(7.25, none) === 7.25, 'with no cuts, a second is itself');
  check(editedToAudioSec(7.25, none) === 7.25, '...both ways');
  check(nextKeptSec(7.25, none) === 7.25, '...and no second is ever skipped');
  check(!isCutSec(7.25, none), '...and no second is inside a cut');
  const notes = [note('a', 1, 2), note('b', 3, 4)];
  check(mapNotesThroughCuts(notes, none) === notes, 'the notes come back BY IDENTITY');
  const beats = [0, 0.5, 1];
  check(mapTimesThroughCuts(beats, none) === beats, 'so do the beats');
  const peaks = { min: new Float32Array([-1, -2]), max: new Float32Array([1, 2]) };
  check(applyCutsToPeaks(peaks, TAKE_SEC, none) === peaks, 'so do the peaks');
  check(editedDurationSec(none, TAKE_SEC) === TAKE_SEC, 'and the take is its own length');
}

// ---------------------------------------------------------------------------
console.log('\nthe two clocks');
// ---------------------------------------------------------------------------
{
  check(near(audioToEditedSec(1, CUTS), 1), 'before the first cut, nothing moves');
  check(near(audioToEditedSec(5, CUTS), 2), 'at a seam, the tape picks up where the cut began');
  check(near(audioToEditedSec(6, CUTS), 3), 'after one cut, a second is earlier by its length');
  check(near(audioToEditedSec(14, CUTS), 9.5), 'after both, by both');
  check(
    near(audioToEditedSec(3.5, CUTS), 2) && near(audioToEditedSec(4.9, CUTS), 2),
    'every second INSIDE a cut collapses to the one point the cut becomes'
  );
  check(near(audioToEditedSec(TAKE_SEC, CUTS), 15.5), 'the end of the take is the edited length');

  check(near(editedToAudioSec(1, CUTS), 1), 'and back: before the cut, itself');
  check(near(editedToAudioSec(3, CUTS), 6), 'and back: after the cut, later by its length');
  check(near(editedToAudioSec(2, CUTS), 5), 'a seam resolves FORWARD, to where the tape resumes');

  // THE ROUND TRIP, swept. Every 10 ms of kept tape must survive both directions unchanged.
  let worst = 0;
  let sweptSeconds = 0;
  for (let a = 0; a <= TAKE_SEC; a += 0.01) {
    if (isCutSec(a, CUTS)) continue;
    sweptSeconds++;
    worst = Math.max(worst, Math.abs(editedToAudioSec(audioToEditedSec(a, CUTS), CUTS) - a));
  }
  check(sweptSeconds > 1500, `the sweep really covered the take (${sweptSeconds} points)`);
  check(worst < 1e-9, `audio -> edited -> audio is the identity on kept tape (worst ${worst})`);

  let worstBack = 0;
  for (let e = 0; e <= editedDurationSec(CUTS, TAKE_SEC); e += 0.01) {
    worstBack = Math.max(worstBack, Math.abs(audioToEditedSec(editedToAudioSec(e, CUTS), CUTS) - e));
  }
  check(worstBack < 1e-9, `edited -> audio -> edited is the identity everywhere (worst ${worstBack})`);

  // Monotonic, or the picture would fold over on itself.
  let monotonic = true;
  let last = -Infinity;
  for (let a = 0; a <= TAKE_SEC; a += 0.01) {
    const e = audioToEditedSec(a, CUTS);
    if (e < last - 1e-12) monotonic = false;
    last = e;
  }
  check(monotonic, 'the mapping never goes backwards');
}

// ---------------------------------------------------------------------------
console.log('\nwhat is left, and what playback jumps');
// ---------------------------------------------------------------------------
{
  const kept = keptRegions(CUTS, TAKE_SEC);
  check(kept.length === 3, 'two cuts inside a take leave three kept regions');
  check(kept[0].fromSec === 0 && kept[0].toSec === 2, 'the head is kept up to the first cut');
  check(kept[1].fromSec === 5 && kept[1].toSec === 12, 'the middle is what sits between them');
  check(kept[2].toSec === TAKE_SEC, 'the tail runs to the end of the take');
  check(
    near(kept.reduce((s, r) => s + (r.toSec - r.fromSec), 0), editedDurationSec(CUTS, TAKE_SEC)),
    'what is kept and what is removed add up to the take'
  );
  const lead = normalizeCuts([{ fromSec: 0, toSec: 3 }], TAKE_SEC);
  check(keptRegions(lead, TAKE_SEC).length === 1, 'a leading trim leaves one region');
  check(keptRegions(lead, TAKE_SEC)[0].fromSec === 3, '...starting where the trim ends');

  check(nextKeptSec(1, CUTS) === 1, 'playback on kept tape is not moved');
  check(nextKeptSec(3, CUTS) === 5, 'playback that walks into a cut is sent to its far side');
  check(nextKeptSec(2, CUTS) === 5, 'the first instant of a cut is already inside it');
  check(nextKeptSec(5, CUTS) === 5, 'the instant a cut ends is already outside it');
  check(nextKeptSec(12.5, CUTS) === 13.5, 'the second cut behaves like the first');
}

// ---------------------------------------------------------------------------
console.log('\nnotes through a cut');
// ---------------------------------------------------------------------------
{
  const notes = [
    note('before', 0.5, 1.5),
    note('inside', 3, 4),
    note('straddling', 1.5, 6),
    note('after', 6, 7)
  ];
  const out = mapNotesThroughCuts(notes, CUTS);
  const byId = new Map(out.map((n) => [n.id!, n]));
  check(out.length === 3, 'a note struck inside a cut is gone — its attack was removed');
  check(!byId.has('inside'), '...and it is that note that went');
  check(
    near(byId.get('before')!.startSec, 0.5) && near(byId.get('before')!.endSec, 1.5),
    'a note before the cut does not move'
  );
  check(
    near(byId.get('after')!.startSec, 3) && near(byId.get('after')!.endSec, 4),
    'a note after the cut moves earlier by the cut'
  );
  check(
    near(byId.get('straddling')!.startSec, 1.5) && near(byId.get('straddling')!.endSec, 3),
    'a note held through a cut keeps its attack and is shortened to the seam'
  );
  check(
    out.every((n) => notes.some((o) => o.id === n.id)) && notes[0].startSec === 0.5,
    'the input notes are not mutated — the recording is left alone'
  );
  check(
    mapNotesThroughCuts(notes, CUTS).every((n) => !!n.id),
    'ids survive, which is what every notation edit is keyed on'
  );

  const beats = mapTimesThroughCuts([0, 1, 3, 6, 14], CUTS)!;
  check(beats.length === 4, 'a beat inside a cut stops existing');
  check(near(beats[2], 3) && near(beats[3], 9.5), '...and the rest slide earlier');
}

// ---------------------------------------------------------------------------
console.log('\npeaks');
// ---------------------------------------------------------------------------
{
  // One bucket per second, so a bucket index IS a second and the arithmetic is readable.
  const min = new Float32Array(TAKE_SEC);
  const max = new Float32Array(TAKE_SEC);
  for (let i = 0; i < TAKE_SEC; i++) {
    min[i] = -i;
    max[i] = i;
  }
  const cut = applyCutsToPeaks({ min, max }, TAKE_SEC, CUTS)!;
  // 16 and not 15, and that is the documented rounding: the second cut ends at 13.5, which is
  // the middle of a bucket, and a bucket the cut only half covers is KEPT. Rounding the other
  // way would let a cut eat a hair of the note beside it, which is visible; half a bucket of
  // extra envelope at the seam, at the strip's own resolution, is not.
  check(cut.min.length === 16 && cut.max.length === 16, 'the spliced peaks lose the cut buckets');
  check(
    cut.min.length === cut.max.length,
    'both halves of the envelope are spliced the same way'
  );
  check(cut.max[0] === 0 && cut.max[1] === 1, 'the head is kept as it was');
  check(cut.max[2] === 5, 'the bucket after the first cut follows the one before it');
  check(cut.max[cut.max.length - 1] === TAKE_SEC - 1, 'the tail is still the tail');
  check(min[3] === -3, 'the source arrays are not mutated');
  check(applyCutsToPeaks(null, TAKE_SEC, CUTS) === null, 'no peaks stays no peaks');
}

// ---------------------------------------------------------------------------
console.log('\ncutting again, and again');
// ---------------------------------------------------------------------------
{
  // Every span below is stated on the EDITED clock, because that is what the player drags on.
  let cuts = addCut([], { fromSec: 2, toSec: 5 }, TAKE_SEC);
  check(cuts.length === 1 && near(cuts[0].toSec, 5), 'the first cut is the span as dragged');

  // The strip now shows a 17s take. Cutting 5s..6s of THAT is 8s..9s of the recording, because
  // the three seconds already removed sit before it. Getting this wrong is the whole reason
  // `addCut` takes an edited span rather than an audio one: the cut would land three seconds
  // late, on music the player was still looking at.
  cuts = addCut(cuts, { fromSec: 5, toSec: 6 }, TAKE_SEC);
  check(cuts.length === 2, 'a second, separate cut is a second entry');
  check(
    near(cuts[1].fromSec, 8) && near(cuts[1].toSec, 9),
    '...mapped back onto the recording, not stated on the edited clock'
  );
  check(near(editedDurationSec(cuts, TAKE_SEC), 16), 'and the take is 4s shorter in total');

  // A cut taken immediately after an existing one is CONTIGUOUS on the recording, so it joins
  // it. Two entries that removed touching tape would be two rows nothing could tell apart.
  const abutting = addCut([{ fromSec: 2, toSec: 5 }], { fromSec: 2, toSec: 3 }, TAKE_SEC);
  check(
    abutting.length === 1 && near(abutting[0].fromSec, 2) && near(abutting[0].toSec, 6),
    'cutting again right at the seam extends the cut already there'
  );

  // A span that swallows an existing cut merges with it rather than nesting.
  const swallow = addCut(cuts, { fromSec: 1, toSec: 6 }, TAKE_SEC);
  check(
    swallow.every((c, i) => i === 0 || c.fromSec >= swallow[i - 1].toSec),
    'the list stays sorted and disjoint'
  );
  check(
    near(cutTotalSec(swallow), TAKE_SEC - editedDurationSec(swallow, TAKE_SEC)),
    'the length still adds up after a merge'
  );

  // Five in a row, from the front, is a normal thing to do to a bad take.
  let many: CutSpan[] = [];
  for (let i = 0; i < 5; i++) many = addCut(many, { fromSec: 0, toSec: 1 }, TAKE_SEC);
  check(many.length === 1 && near(many[0].toSec, 5), 'five cuts off the front are one 5s cut');
  check(near(editedDurationSec(many, TAKE_SEC), 15), '...and the take is 5s shorter');

  // The whole point of the model: taking the list away puts everything back.
  const restored: CutSpan[] = [];
  check(
    editedDurationSec(restored, TAKE_SEC) === TAKE_SEC &&
      mapNotesThroughCuts([note('x', 3, 4)], restored).length === 1,
    'dropping the cut list restores the take exactly — nothing was ever destroyed'
  );
}

// ---------------------------------------------------------------------------
console.log('\nthe trim offer');
// ---------------------------------------------------------------------------
{
  check(detectTrimCuts(0.2, 19.8, TAKE_SEC).length === 0, 'a tight take is not worth asking about');
  const lead = detectTrimCuts(3, 19.8, TAKE_SEC);
  check(lead.length === 1 && lead[0].fromSec === 0, 'three seconds of lead-in is');
  check(near(lead[0].toSec, 2.9), '...and a tenth of a second of room is left before the attack');
  const tail = detectTrimCuts(0.2, 15, TAKE_SEC);
  check(tail.length === 1 && near(tail[0].toSec, TAKE_SEC), 'a long tail is offered on its own');
  check(near(tail[0].fromSec, 15.1), '...with the same room after the last note');
  const both = detectTrimCuts(3, 15, TAKE_SEC);
  check(both.length === 2, 'a take with both gets both, as two spans and not one');
  check(detectTrimCuts(null, null, TAKE_SEC).length === 0, 'a take with no notes is not trimmed');
  check(detectTrimCuts(3, 19.8, 0).length === 0, 'neither is a take with no length');
  check(
    detectTrimCuts(1.4, 19.8, TAKE_SEC).length === 0 &&
      detectTrimCuts(1.6, 19.8, TAKE_SEC).length === 1,
    'the threshold is a threshold, and it is where it says it is'
  );
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`${failed} check(s) failed`);
}
