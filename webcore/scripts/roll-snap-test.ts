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
 *  3. Settings v11/v12 — the Quantize default goes back to 'auto' once and never again, and the
 *     snap switch becomes the three-state Off/Grid/Beat mode without moving anybody's notes.
 *  4. G25 (§9) — SNAP TO BEAT. Nearest beat, collisions cascading onto the following
 *     subdivisions in played order, ends tidied to a cell, and the same reversibility contract
 *     Grid keeps.
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
  snapPerformanceToBeat,
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
// 7. Settings v10 … v12
// ---------------------------------------------------------------------------

assert(SETTINGS_VERSION === 12, 'this test is written against settings v12');
assert(DEFAULT_SETTINGS.grid === 'auto', "a new user's Quantize default is Auto again");
assert(DEFAULT_SETTINGS.rollSnap === 'off', 'Snap is off until asked for');
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
assert(fromV8.rollSnap === 'off', 'a migrated blob does not arrive with notes already snapped');
assert(fromV8.alignViews === true, 'v11 forces alignment on — the chip is gone (G11)');
assert(fromV8.settingsVersion === 12, 'the migrated blob is stamped v12');

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

// v11 -> v12: the switch becomes a mode, by TRANSLATION rather than by reset. The boolean said
// exactly one thing and 'grid' means exactly that, so somebody who had switched it on stays on.
assert(chosen.rollSnap === 'grid', "a stored `true` carries over as the player's own Grid choice");
assert(chosen.rollSnapToGrid === true, 'the dead boolean survives so an old blob still round-trips');
const wasOff = mergeStoredSettings({ settingsVersion: 11, rollSnapToGrid: false } as Partial<AppSettings>);
assert(wasOff.rollSnap === 'off', 'a stored `false` carries over as Off');
// NOBODY IS MIGRATED ONTO BEAT. It moves notes to places the old switch never would have, and a
// mode nobody chose must not arrive already on.
assert(
  mergeStoredSettings({ settingsVersion: 9, rollSnapToGrid: true } as Partial<AppSettings>).rollSnap !== 'beat',
  'no migration may land a profile on Beat'
);
// …and once on v12, the chosen mode is theirs, including the new one.
const onBeat = mergeStoredSettings({ settingsVersion: 12, rollSnap: 'beat' } as Partial<AppSettings>);
assert(onBeat.rollSnap === 'beat', 'after v12 a chosen Beat is never re-flipped');

// Stored JSON is untrusted: a garbage snap value must normalise rather than reach the feed.
const junk = mergeStoredSettings({ settingsVersion: 11, rollSnapToGrid: 'yes' } as unknown as Partial<AppSettings>);
assert(junk.rollSnap === 'off', 'a non-boolean legacy snap setting falls back to Off');
const junkMode = mergeStoredSettings({ settingsVersion: 12, rollSnap: 'sort-of' } as unknown as Partial<AppSettings>);
assert(junkMode.rollSnap === 'off', 'a snap mode nothing recognises falls back to Off, not to "some kind of on"');
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

// ---------------------------------------------------------------------------
// 9. SNAP TO BEAT (G25)
// ---------------------------------------------------------------------------
//
// 120 bpm in 4/4, so the beat is exactly half a second and the 1/16 cascade cell is exactly
// 0.125 — every number below is a round one, and a wrong denominator cannot hide behind a float.
// The origin is still 1s into the recording, because the one bug this arithmetic invites is
// measuring the pulse from the top of the FILE rather than from written second 0.
const BEAT = 0.5;
const CELL16 = 0.125;
const onBeatLine = (sec: number): boolean =>
  Math.abs((sec - originSec) / BEAT - Math.round((sec - originSec) / BEAT)) < 1e-9;

// --- 9a. A SPARSE TAKE: every note lands on a beat, and none of them collides --------------
//
// Human timing, a few tens of milliseconds either side of the pulse, and one note (s3) played
// LATE enough that flooring to the preceding beat would drag it back a whole half-second. The
// nearest beat is the right answer for all four.
const sparse: InputNote[] = [
  { id: 's0', startSec: 1.02, endSec: 1.44, midi: 40 },
  { id: 's1', startSec: 1.47, endSec: 1.93, midi: 43 },
  { id: 's2', startSec: 2.03, endSec: 2.4, midi: 45 },
  { id: 's3', startSec: 2.52, endSec: 2.99, midi: 47 }
];
const sparseBefore = fingerprint(sparse);
const onBeats = snapPerformanceToBeat(sparse, BEAT, CELL16, originSec, 120);

assert(fingerprint(sparse) === sparseBefore, 'beat snap must not mutate the performance it was handed');
assert(onBeats.length === sparse.length, 'beat snap must not add or drop notes');
for (const note of onBeats) assert(onBeatLine(note.startSec), `${note.id} must start on a beat`);
assert(
  new Set(onBeats.map((n) => n.startSec)).size === onBeats.length,
  'a sparse take needs no cascade at all — four attacks, four beats'
);
assert(
  onBeats.map((n) => `${n.id}@${n.startSec}`).join(' ') === 's0@1 s1@1.5 s2@2 s3@2.5',
  'each note goes to its NEAREST beat, counted from the origin'
);
// Ends are tidied to a cell so nothing rings a ragged 40 ms across the next beat, and the last
// note — which has nothing after it to be capped by — keeps the length it rounded to.
for (const note of onBeats) {
  const off = Math.abs((note.endSec - originSec) / CELL16 - Math.round((note.endSec - originSec) / CELL16));
  assert(off < 1e-9, `${note.id} must END on a subdivision line`);
  assert(note.endSec - note.startSec >= CELL16 - 1e-9, `${note.id} must be at least one cell long`);
}
// …and an end may not be pushed past the next attack, because the recording did not hold those
// two together: s0 was released at 1.44 and s1 struck at 1.47.
assert(onBeats[0].endSec <= onBeats[1].startSec + 1e-9, 'a tidied end may not swallow the next attack');

// A note played shorter than a cell is widened to one rather than rounded out of existence.
const stub = snapPerformanceToBeat([{ id: 'x', startSec: 1.02, endSec: 1.05, midi: 40 }], BEAT, CELL16, originSec, 120);
assert(
  Math.abs(stub[0].startSec - 1) < 1e-9 && Math.abs(stub[0].endSec - 1.125) < 1e-9,
  'a note shorter than a cell is floored at one cell, not flattened to nothing'
);

// --- 9b. A CROWDED BEAT: the cascade ------------------------------------------------------
//
// Four 1/16s of a fast run, all four of them nearest to the beat at 2.0. Stacking them there
// would delete the run; the earliest takes the beat and the rest step onto the following
// subdivisions, which is what "fast runs keep their subdivisions" means.
const run: InputNote[] = [
  { id: 'r0', startSec: 1.98, endSec: 2.05, midi: 60 },
  { id: 'r1', startSec: 2.06, endSec: 2.13, midi: 62 },
  { id: 'r2', startSec: 2.13, endSec: 2.2, midi: 64 },
  { id: 'r3', startSec: 2.19, endSec: 2.3, midi: 65 }
];
const cascaded = snapPerformanceToBeat(run, BEAT, CELL16, originSec, 120);
assert(
  cascaded.map((n) => `${n.id}@${n.startSec}`).join(' ') === 'r0@2 r1@2.125 r2@2.25 r3@2.375',
  'the earliest note takes the beat and the rest cascade onto the following 1/16s'
);
assert(new Set(cascaded.map((n) => n.startSec)).size === 4, 'no two notes may share a position');
// THE CELL IS THE SELECTED GRID'S. At 1/32 the same four notes pack twice as tightly, which is
// the whole reason changing the roll grid has to re-derive the feed in Beat mode too.
const cascaded32 = snapPerformanceToBeat(run, BEAT, rollSnapUnitSec('thirtysecond', 120), originSec, 120);
assert(
  cascaded32.map((n) => n.startSec).join(' ') === '2 2.0625 2.125 2.1875',
  'the cascade steps by the SELECTED grid cell'
);
// …and with no ruler at all (Free or Off report no unit) it falls back to a 1/16, so Beat still
// works under a grid that draws bar lines only.
const cascadedNoRuler = snapPerformanceToBeat(run, BEAT, rollSnapUnitSec('off', 120), originSec, 120);
assert(
  fingerprint(cascadedNoRuler) === fingerprint(cascaded),
  'with no ruler the cascade falls back to a 1/16 rather than refusing to run'
);

// A CHORD IS ONE EVENT. Three notes struck together are not a collision to be cascaded — doing
// so would arpeggiate every chord in the take — so they share the beat they were aimed at.
const chord: InputNote[] = [
  { id: 'c0', startSec: 1.03, endSec: 1.48, midi: 40 },
  { id: 'c1', startSec: 1.035, endSec: 1.49, midi: 47 },
  { id: 'c2', startSec: 1.04, endSec: 1.47, midi: 52 }
];
const chorded = snapPerformanceToBeat(chord, BEAT, CELL16, originSec, 120);
assert(
  chorded.every((n) => Math.abs(n.startSec - 1) < 1e-9),
  'a strummed chord stays a chord — one attack, one position'
);

// --- 9c. ORDER IS PRESERVED ----------------------------------------------------------------
//
// The §2 take, whose ids are deliberately not in time order. Beat mode may move every note, but
// it may never let two of them swap: the cascade hands out positions strictly after the last
// one it gave away, so this is a property of the construction rather than of the input.
const beatRaw = snapPerformanceToBeat(raw, BEAT, CELL16, originSec, 120);
const playedOrder = [...raw].sort((a, b) => a.startSec - b.startSec).map((n) => n.id);
assert(
  beatRaw.map((n) => n.id).join(',') === playedOrder.join(','),
  'the snapped take is in the order it was played'
);
for (let i = 1; i < beatRaw.length; i++) {
  assert(beatRaw[i].startSec >= beatRaw[i - 1].startSec, 'starts must be non-decreasing');
}
assert(beatRaw.length === raw.length, 'beat snap must not add or drop notes');
// n1 and n4 were both reaching for the beat at 1.0 that n0 got, so they follow it a cell apart.
assert(
  beatRaw.map((n) => `${n.id}@${n.startSec}`).join(' ') === 'n0@1 n1@1.125 n4@1.25 n2@1.5 n3@2.5',
  'a real cascade over the §2 take, note by note'
);

// --- 9d. THE SAME REVERSIBILITY CONTRACT GRID KEEPS ----------------------------------------

assert(fingerprint(raw) === rawBefore, 'beat snap leaves the recording untouched — Off restores it exactly');
// Beat is not Grid under another name…
assert(fingerprint(beatRaw) !== fingerprint(atEighth), 'Beat and Grid must place notes differently');
// …and Grid is not disturbed by Beat existing: §2's numbers, re-measured after the shared
// `restate()` refactor.
assert(
  fingerprint(snapPerformanceToGrid(raw, rollSnapUnitSec('eighth', 120), originSec, 120)) === fingerprint(atEighth),
  'grid mode is byte-identical to what it was before Beat was added'
);
// RE-DERIVE, NEVER RE-ROUND. Changing the roll grid in Beat mode measures the pulse from the
// recording again; feeding it its own output walks n4 a cell further out and n2 off its beat
// entirely, which is exactly the drift the contract forbids.
const beatAt32 = snapPerformanceToBeat(raw, BEAT, rollSnapUnitSec('thirtysecond', 120), originSec, 120);
const beatBackAt16 = snapPerformanceToBeat(raw, BEAT, CELL16, originSec, 120);
assert(fingerprint(beatAt32) !== fingerprint(beatRaw), 'a finer grid must actually pack the cascade differently');
assert(fingerprint(beatBackAt16) === fingerprint(beatRaw), 'Beat -> 1/32 -> Beat lands where the first Beat did');
const beatCumulative = snapPerformanceToBeat(beatRaw, BEAT, CELL16, originSec, 120);
assert(
  fingerprint(beatCumulative) !== fingerprint(beatRaw),
  'snapping an already-snapped take must differ — otherwise this proves nothing about measuring from raw'
);
// And a hand edit through the Beat layer stores the dragged position as the new raw, exactly as
// it does through Grid: one shared merge, so there is one answer.
const beatDrag = mergeEditedOntoRaw(raw, beatRaw.map((n) => (n.id === 'n2' ? { ...n, startSec: 1.75, endSec: 1.97 } : n)), new Set(['n2']));
assert(beatDrag.find((n) => n.id === 'n2')!.startSec === 1.75, 'the dragged note keeps where it was dropped');
assert(
  beatDrag.find((n) => n.id === 'n0')!.startSec === raw.find((n) => n.id === 'n0')!.startSec,
  'every note the gesture did not name comes back from the recording'
);

console.log(
  `roll-snap-test: free/straight ${freeStraight.glyphs}g ${freeStraight.rests}r ${freeStraight.ties}t · ` +
    `free/triplet ${freeTriplet.glyphs}g ${freeTriplet.rests}r ${freeTriplet.ties}t · ` +
    `beat/cascade ${cascaded.map((n) => n.startSec).join('/')}`
);
console.log('roll-snap-test: all assertions passed');
