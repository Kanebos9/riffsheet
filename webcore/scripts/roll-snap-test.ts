/**
 * The snap layer, the settings that switch it, and the promise the roll now makes.
 *
 * Three claims are under test here, and they are the three that would be expensive to discover
 * from a screenshot:
 *
 *  1. #36 — the Quantize menu writes the SHEET and only the sheet. The performance layer the
 *     roll draws is the same object whatever `grid` says, and the sheet built from it is not.
 *  2. #41 — Snap to grid is REVERSIBLE. Switching it off restores the recording exactly, and
 *     re-deriving at a different size measures from the recording rather than from the last
 *     snap, so a round trip through three grid sizes lands back on the original numbers.
 *  3. Settings v11 — the Quantize default goes back to 'auto', once, and never again.
 *
 * Everything under test is a pure function or a pure migration, which is why this runs in node
 * with no DOM. The one part it cannot reach is the wiring inside `ui/app.ts`; that is what
 * `__RIFFSHEET_SNAPFEED__` and its check in `scripts/verify.mjs` are for.
 */

import { buildScore, type BuildSettings } from '../../pipeline/src/index';
import type { InputNote } from '../src/pipeline';
import { straightRiff, tripletRiff } from '../src/score/fixtures';
import {
  mergeEditedOntoRaw,
  rollSnapUnitSec,
  snapPerformanceToGrid
} from '../src/app/snap';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, mergeStoredSettings, type AppSettings } from '../src/app/state';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const fingerprint = (notes: ReadonlyArray<InputNote>): string =>
  notes.map((n) => `${n.id}@${n.startSec.toFixed(9)}-${n.endSec.toFixed(9)}:${n.midi}`).join('|');

// ---------------------------------------------------------------------------
// 1. The snap unit table
// ---------------------------------------------------------------------------

// 120 bpm: a quarter is exactly half a second, so every unit is a round number and a wrong
// denominator cannot hide behind floating point.
assert(rollSnapUnitSec('quarter', 120) === 0.5, 'quarter at 120bpm is half a second');
assert(rollSnapUnitSec('eighth', 120) === 0.25, 'eighth at 120bpm is a quarter second');
assert(rollSnapUnitSec('sixteenth', 120) === 0.125, 'sixteenth at 120bpm is an eighth second');
assert(rollSnapUnitSec('thirtysecond', 120) === 0.0625, '1/32 at 120bpm is a sixteenth of a second');
assert(Math.abs(rollSnapUnitSec('triplet', 120) - 1 / 6) < 1e-12, 'triplet at 120bpm is a sixth of a second');
// The two that must return 0, because 0 is what every caller reads as "do not snap". 'free'
// draws the subdivisions and refuses to snap to them; 'off' draws no subdivision at all (G14).
assert(rollSnapUnitSec('free', 120) === 0, "'free' must report no unit at all");
assert(rollSnapUnitSec('off', 120) === 0, "'off' must report no unit at all");

// ---------------------------------------------------------------------------
// 2. Snap moves BOTH ENDS onto the grid, and never touches its input
// ---------------------------------------------------------------------------

// Deliberately human timing: every note is a few milliseconds off the grid, one of them late
// enough to round to the NEXT line rather than back to its own.
const raw: InputNote[] = [
  { id: 'n0', startSec: 1.02, endSec: 1.4, midi: 40 },
  // 0.15 past the origin, which is the one offset in this take that the two grids answer
  // DIFFERENTLY: a 1/8 line pulls it up to 0.25, a 1/16 line pulls it down to 0.125. Every other
  // note here happens to land on the same second either way, so without this one the "a finer
  // grid places notes differently" check would pass for no reason.
  { id: 'n1', startSec: 1.15, endSec: 1.37, midi: 45 },
  { id: 'n2', startSec: 1.49, endSec: 2.1, midi: 47 },
  { id: 'n3', startSec: 2.26, endSec: 2.51, midi: 40 },
  // 0.24 past the origin, chosen for §4's drift case: it rounds UP to 0.25 on a 1/8 or 1/16
  // grid and DOWN to 0 on a 1/4 one, so snapping twice and snapping once disagree about it.
  { id: 'n4', startSec: 1.24, endSec: 1.44, midi: 43 }
];
const rawBefore = fingerprint(raw);

const originSec = 1; // written second 0 sits one second into the recording — a count-in
const snapped = snapPerformanceToGrid(raw, rollSnapUnitSec('eighth', 120), originSec, 120);

assert(fingerprint(raw) === rawBefore, 'snap must not mutate the performance it was handed');
assert(snapped.length === raw.length, 'snap must not add or drop notes');

for (const note of snapped) {
  const offGrid = Math.abs((note.startSec - originSec) / 0.25 - Math.round((note.startSec - originSec) / 0.25));
  assert(offGrid < 1e-9, `snapped note ${note.id} must start on a grid line`);
}
// BOTH ENDS (G9). The first version of this function moved the start and carried the played
// length over, which left every note ending a few tens of milliseconds past a line — grid-true
// starts and ragged right edges, under a switch whose whole promise is that things line up. The
// end is on a line now, and a note can never come out shorter than one cell.
for (const before of raw) {
  const after = snapped.find((n) => n.id === before.id)!;
  const offGrid = Math.abs((after.endSec - originSec) / 0.25 - Math.round((after.endSec - originSec) / 0.25));
  assert(offGrid < 1e-9, `snapped note ${before.id} must END on a grid line`);
  assert(
    after.endSec - after.startSec >= 0.25 - 1e-9,
    `snapped note ${before.id} must be at least one whole cell long`
  );
}
// The floor, exercised rather than merely asserted about. n1 was played 1.15 -> 1.37: both ends
// round to the same 1.25 line, so without the floor it would come out as a note of no length at
// all. It is widened to one cell instead.
{
  const n1 = snapped.find((n) => n.id === 'n1')!;
  assert(Math.abs(n1.startSec - 1.25) < 1e-9 && Math.abs(n1.endSec - 1.5) < 1e-9, 'n1 is floored to one cell');
}
// And a note whose two ends round to DIFFERENT lines keeps the number of cells it rounded to,
// rather than being flattened to the minimum: n2 was played 1.49 -> 2.1 and comes out 1.5 -> 2.0.
{
  const n2 = snapped.find((n) => n.id === 'n2')!;
  assert(Math.abs(n2.startSec - 1.5) < 1e-9 && Math.abs(n2.endSec - 2.0) < 1e-9, 'n2 keeps its two cells');
}
// The grid lines are measured from the ORIGIN, not from the top of the file: with a 1s count-in
// and a 0.25s unit, 1.02 belongs on 1.00 and not on 1.25.
assert(Math.abs(snapped.find((n) => n.id === 'n0')!.startSec - 1.0) < 1e-9, 'n0 snaps back to the origin line');
assert(Math.abs(snapped.find((n) => n.id === 'n1')!.startSec - 1.25) < 1e-9, 'n1 snaps to the nearest line');
assert(Math.abs(snapped.find((n) => n.id === 'n2')!.startSec - 1.5) < 1e-9, 'n2 rounds forward to the next line');

// ---------------------------------------------------------------------------
// 3. THE REVERSIBILITY CLAIM: on -> off restores the recording exactly
// ---------------------------------------------------------------------------
//
// The layer is derived from `raw` every time rather than applied to the previous answer, so
// "switching it off" is simply not calling it. What this proves is the property that makes that
// safe: nothing anywhere in the snap wrote back into the array it was given.
assert(fingerprint(raw) === rawBefore, 'switching the snap off must return the recording untouched');

// ---------------------------------------------------------------------------
// 4. RE-SNAP FROM RAW: changing the grid cannot accumulate drift
// ---------------------------------------------------------------------------

const atEighth = snapPerformanceToGrid(raw, rollSnapUnitSec('eighth', 120), originSec, 120);
const atSixteenth = snapPerformanceToGrid(raw, rollSnapUnitSec('sixteenth', 120), originSec, 120);
const backToEighth = snapPerformanceToGrid(raw, rollSnapUnitSec('eighth', 120), originSec, 120);
assert(
  fingerprint(atEighth) === fingerprint(backToEighth),
  '1/8 -> 1/16 -> 1/8 must land exactly where the first 1/8 did'
);
assert(fingerprint(atEighth) !== fingerprint(atSixteenth), 'a finer grid must actually place notes differently');

// And the failure this is guarding against, made explicit rather than asserted about in the
// abstract. Snapping an ALREADY snapped take at a coarser size is NOT the same as snapping the
// recording at that size: n4 sits 0.24 past the origin, which a 1/16 grid pulls up to 0.25 and a
// 1/4 grid then pulls up again to 0.5 — while the recording itself would have rounded down to 0.
// One note, two answers, and the wrong one is the one a naive implementation gives.
const cumulative = snapPerformanceToGrid(atSixteenth, rollSnapUnitSec('quarter', 120), originSec, 120);
const fromRaw = snapPerformanceToGrid(raw, rollSnapUnitSec('quarter', 120), originSec, 120);
const drifted = cumulative.find((n) => n.id === 'n4')!;
const honest = fromRaw.find((n) => n.id === 'n4')!;
assert(Math.abs(drifted.startSec - 1.5) < 1e-9, 'snapping a snapped take walks n4 up to 1.5');
assert(Math.abs(honest.startSec - 1.0) < 1e-9, 'snapping the recording puts n4 at 1.0');
assert(
  fingerprint(cumulative) !== fingerprint(fromRaw),
  'the two chains must differ — otherwise this test proves nothing about measuring from raw'
);

// ---------------------------------------------------------------------------
// 5. Hand edits store the dragged position as the new raw — and only those notes
// ---------------------------------------------------------------------------

// The player dragged n1 while the snap was on. Everything else must come back from the
// recording, or one drag would silently promote every snapped position into the take.
const draggedFeed = atEighth.map((n) => (n.id === 'n1' ? { ...n, startSec: 1.75, endSec: 1.97 } : n));
const merged = mergeEditedOntoRaw(raw, draggedFeed, new Set(['n1']));

assert(merged.length === raw.length, 'a move must not change the note count');
const mergedN1 = merged.find((n) => n.id === 'n1')!;
assert(mergedN1.startSec === 1.75, 'the dragged note keeps exactly where it was dropped');
for (const id of ['n0', 'n2', 'n3']) {
  const after = merged.find((n) => n.id === id)!;
  const before = raw.find((n) => n.id === id)!;
  assert(
    after.startSec === before.startSec && after.endSec === before.endSec,
    `untouched note ${id} must come back from the recording, not from the grid`
  );
}

// A note the gesture ADDED has nothing behind it and is kept as it came.
const withAdded = mergeEditedOntoRaw(raw, [...atEighth, { id: 'add1', startSec: 3, endSec: 3.25, midi: 52 }], new Set());
assert(withAdded.some((n) => n.id === 'add1' && n.startSec === 3), 'an added note survives the merge');

// ---------------------------------------------------------------------------
// 6. #36: the sheet follows Quantize, the performance does not
// ---------------------------------------------------------------------------
//
// The app hands the SAME notes to the pipeline whatever `grid` says, so this asserts the other
// half: that the pipeline's answer really does depend on the setting. If these came out equal,
// #36 would be trivially true for the wrong reason and the menu would be doing nothing at all.
const beats = [1, 1.5, 2, 2.5, 3];
const buildAt = (grid: BuildSettings['grid']): string => {
  const built = buildScore(
    { notes: raw, beats, startOffsetSec: originSec },
    { grid, instrument: 'staff', tuningMidi: [], fingeringStyle: 'low', clefMode: 'auto' }
  );
  const ir = built.ir;
  return ir.bars
    .flatMap((b) => b.voices.flatMap((v) => v.beats.map((x) => `${b.index}:${x.startTick}:${x.durTicks}:${x.isRest ? 'r' : 'n'}`)))
    .join('|');
};

const sheets = new Map<string, string>();
for (const grid of ['auto', '1/4', 'free', 'thirtysecond'] as const) sheets.set(grid, buildAt(grid));
assert(new Set(sheets.values()).size > 1, 'changing Quantize must change what the sheet writes');
// The performance the roll would draw is untouched by all of that — it never went near the build.
assert(fingerprint(raw) === rawBefore, 'building at four grids must leave the performance layer alone');

// ---------------------------------------------------------------------------
// 7. Settings v10
// ---------------------------------------------------------------------------

assert(SETTINGS_VERSION === 11, 'this test is written against settings v11');
assert(DEFAULT_SETTINGS.grid === 'auto', "a new user's Quantize default is Auto again");
assert(DEFAULT_SETTINGS.rollSnapToGrid === false, 'Snap to grid is off until asked for');
assert(DEFAULT_SETTINGS.alignViews === true, 'alignment is on and is not a choice');

// The v8 -> … -> v11 chain, in one hop, which is how a real blob arrives. v10 moves this blob's
// 'auto' to 'free' and v11 moves it straight back, which is exactly right: it was the DEFAULT
// both times and the player never touched the menu.
const fromV8 = mergeStoredSettings({
  settingsVersion: 8,
  grid: 'auto',
  rollAllNoteNames: false,
  rollEditing: false,
  preciseBeats: true,
  alignViews: false
} as Partial<AppSettings>);
assert(fromV8.grid === 'auto', 'a v8 blob lands on Auto after the v10/v11 pair');
assert(fromV8.rollAllNoteNames === true && fromV8.rollEditing === true, 'v9 still forces the two roll switches');
assert(fromV8.preciseBeats === false, 'v9 still forces the drifting-tempo pass off');
assert(fromV8.rollSnapToGrid === false, 'a migrated blob does not arrive with notes already snapped');
assert(fromV8.alignViews === true, 'v11 forces alignment on — the chip is gone (G11)');
assert(fromV8.settingsVersion === 11, 'the migrated blob is stamped v11');

// A v9 blob that had explicitly chosen 'sixteenth' is still carried across v10 — which forced
// everything to 'free' — and v11 then reads that 'free' as v10's doing rather than as a choice,
// because by then it is indistinguishable from one. The deliberate 'sixteenth' does not survive
// v10; that is v10's cost, recorded here rather than glossed over.
const fromV9 = mergeStoredSettings({ settingsVersion: 9, grid: 'sixteenth' } as Partial<AppSettings>);
assert(fromV9.grid === 'auto', 'a pre-v10 blob ends on Auto');

// THE HALF THAT MATTERS MOST. A v10 profile sitting on any value except 'free' chose it — no
// v10 default could have produced it — so v11 leaves it exactly alone.
for (const kept of ['auto', 'quarter', 'eighth', 'sixteenth', 'thirtysecond', 'triplet'] as const) {
  const blob = mergeStoredSettings({ settingsVersion: 10, grid: kept } as Partial<AppSettings>);
  assert(blob.grid === kept, `v11 must not touch a deliberate '${kept}'`);
}

// …and the one that is NOT distinguishable. A v10 'free' may be the migration's or the
// player's; the two are written identically, so everybody on it lands on Auto once.
const wasFree = mergeStoredSettings({ settingsVersion: 10, grid: 'free' } as Partial<AppSettings>);
assert(wasFree.grid === 'auto', "v11 moves every v10 'free' to Auto exactly once");

// …and once they are on v11, their choice is theirs, INCLUDING 'free'. This is the half that
// would make the feature obnoxious if it were wrong: a migration that re-fires would overwrite
// the menu every time the app started.
const chosen = mergeStoredSettings({ settingsVersion: 11, grid: 'free', rollSnapToGrid: true } as Partial<AppSettings>);
assert(chosen.grid === 'free', "after v11 the player's own Quantize choice is never re-flipped");
assert(chosen.rollSnapToGrid === true, 'after v11 a chosen snap setting survives');

// Stored JSON is untrusted: a garbage snap value must normalise rather than reach the feed.
const junk = mergeStoredSettings({ settingsVersion: 11, rollSnapToGrid: 'yes' } as unknown as Partial<AppSettings>);
assert(junk.rollSnapToGrid === false, 'a non-boolean snap setting falls back to off');
// And a garbage roll grid falls back rather than reaching the ruler — the vocabulary grew by two
// words in G14, so the guard has to know both of them.
const goodGrid = mergeStoredSettings({ settingsVersion: 11, rollGrid: 'off' } as Partial<AppSettings>);
assert(goodGrid.rollGrid === 'off', "'off' is a real roll grid now");
const badGrid = mergeStoredSettings({ settingsVersion: 11, rollGrid: 'auto' } as unknown as Partial<AppSettings>);
assert(badGrid.rollGrid === DEFAULT_SETTINGS.rollGrid, "'auto' is still meaningless as a roll grid");

// ---------------------------------------------------------------------------
// 8. 'free' is fit to be the default
// ---------------------------------------------------------------------------
//
// The Quantize menu hid Free from audio takes for a long time, on a measurement that was true
// when it was taken: 64 played notes engraved as 192 glyphs with 192 ties — three tied noteheads
// per note — plus 64 rests nobody played. Free is offered for every take since v10 (it is no
// longer the default — see §7 — but it is one press away), so that measurement has to be
// re-taken rather than assumed stale, and it has to keep being re-taken. These are the
// numbers the comment in `ui/app.ts` §notation toolbar quotes.

const measure = (notes: ReadonlyArray<InputNote>, beatList: number[], grid: BuildSettings['grid']) => {
  const built = buildScore(
    { notes: [...notes], beats: beatList },
    { grid, instrument: 'staff', tuningMidi: [], fingeringStyle: 'low', clefMode: 'auto' }
  );
  let ties = 0;
  for (const bar of built.ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        for (const note of beat.notes) if (note.tieStart || note.tieStop) ties++;
      }
    }
  }
  return { glyphs: built.ir.stats.noteGlyphs, rests: built.ir.stats.restGlyphs, ties };
};

const straight = straightRiff(8);
const freeStraight = measure(straight.notes, straight.beats, 'free');
const autoStraight = measure(straight.notes, straight.beats, 'auto');

// THE CLAIM THAT RETIRED THE OLD GATE: on straight material, Free is indistinguishable from Auto.
assert(
  freeStraight.glyphs === straight.notes.length,
  `free must be 1:1 on straight material: ${straight.notes.length} played -> ${freeStraight.glyphs} glyphs`
);
assert(freeStraight.ties === 0, `free must not chain ties on straight material (got ${freeStraight.ties})`);
assert(freeStraight.rests === 0, `free must not invent rests on straight material (got ${freeStraight.rests})`);
assert(
  freeStraight.glyphs === autoStraight.glyphs && freeStraight.ties === autoStraight.ties,
  'free and auto must agree exactly on straight material'
);

// Triplet material is legitimately busier under Free — the rests are the real gaps and the ties
// are notes held across a beat — but it must stay ROUGHLY 1:1 in noteheads. The old failure was
// a 3x glyph explosion, so that is what is pinned: anything approaching it fails here.
const triplet = tripletRiff(8);
const freeTriplet = measure(triplet.notes, triplet.beats, 'free');
assert(
  freeTriplet.glyphs <= triplet.notes.length * 1.5,
  `free must stay near 1:1 on triplet material: ${triplet.notes.length} played -> ${freeTriplet.glyphs} glyphs`
);

console.log(
  `roll-snap-test: free/straight ${freeStraight.glyphs}g ${freeStraight.rests}r ${freeStraight.ties}t · ` +
    `free/triplet ${freeTriplet.glyphs}g ${freeTriplet.rests}r ${freeTriplet.ties}t`
);
console.log('roll-snap-test: all assertions passed');
