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
// 7. Settings v10 … v13
// ---------------------------------------------------------------------------
//
// V13 SITS ON TOP OF EVERYTHING BELOW IT, and it is worth stating once here rather than at each
// assertion. H4 made `grid`, `rollGrid` and `rollSnap` TAKE-SCOPED — answers about the recording
// in front of you rather than preferences that follow you between projects — so v13 stamps their
// defaults over any blob older than itself. Several claims below were written when those three
// were global preferences and read the other way round ("a deliberate '1/4' is never touched");
// they are restated, not deleted, because the thing they were guarding — a migration that fires
// once, on a blob it can identify, and never re-fires — is unchanged and still worth pinning.

assert(SETTINGS_VERSION === 13, 'this test is written against settings v13');
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
assert(fromV8.settingsVersion === 13, 'the migrated blob is stamped v13');

// A v9 blob that had explicitly chosen 'sixteenth' is still carried across v10 — which forced
// everything to 'free' — and v11 then reads that 'free' as v10's doing rather than as a choice,
// because by then it is indistinguishable from one. The deliberate 'sixteenth' does not survive
// v10; that is v10's cost, recorded here rather than glossed over.
const fromV9 = mergeStoredSettings({ settingsVersion: 9, grid: 'sixteenth' } as Partial<AppSettings>);
assert(fromV9.grid === 'auto', 'a pre-v10 blob ends on Auto');

// THE HALF THAT MATTERED MOST, AND WHAT BECAME OF IT. A v10 profile sitting on any value except
// 'free' chose it — no v10 default could have produced it — so v11 left it exactly alone. v13
// then takes all three of these keys away from the profile entirely (H4: they describe the take,
// not the player), so an OLD blob now arrives on the take default whatever it was carrying. The
// claim is therefore about the reset being total rather than partial: no v10 or v11 value of
// Quantize survives into a new take, including the ones v11 was careful to preserve.
for (const kept of ['auto', 'quarter', 'eighth', 'sixteenth', 'thirtysecond', 'triplet', 'free'] as const) {
  for (const version of [10, 11, 12] as const) {
    const blob = mergeStoredSettings({ settingsVersion: version, grid: kept } as Partial<AppSettings>);
    assert(
      blob.grid === DEFAULT_SETTINGS.grid,
      `v13 takes Quantize away from the profile: a v${version} '${kept}' must arrive as '${DEFAULT_SETTINGS.grid}', got '${blob.grid}'`
    );
  }
}

// …and once a profile IS on v13, the value in the blob is the take's own and is never re-flipped.
// This is the half that would make the feature obnoxious if it were wrong: a migration that
// re-fires would overwrite the menu every time a document was opened.
for (const kept of ['auto', 'quarter', 'eighth', 'sixteenth', 'thirtysecond', 'triplet', 'free'] as const) {
  const blob = mergeStoredSettings({ settingsVersion: 13, grid: kept } as Partial<AppSettings>);
  assert(blob.grid === kept, `after v13 a stored '${kept}' is the take's own and stands`);
}

// v11 -> v12: the switch becomes a mode, by TRANSLATION rather than by reset. The boolean said
// exactly one thing and 'grid' means exactly that — and v13 then resets the MODE while leaving
// the translation itself intact, which is the distinction worth pinning: the old boolean is
// still read correctly, it simply no longer decides what a new take starts on.
const chosen = mergeStoredSettings({ settingsVersion: 11, grid: 'free', rollSnapToGrid: true } as Partial<AppSettings>);
assert(chosen.rollSnapToGrid === true, 'the dead boolean survives so an old blob still round-trips');
assert(chosen.rollSnap === DEFAULT_SETTINGS.rollSnap, 'v13 hands a new take the default snap mode');
const wasOff = mergeStoredSettings({ settingsVersion: 11, rollSnapToGrid: false } as Partial<AppSettings>);
assert(wasOff.rollSnap === 'off', 'a stored `false` carries over as Off');
// NOBODY IS MIGRATED ONTO BEAT. It moves notes to places the old switch never would have, and a
// mode nobody chose must not arrive already on — which is now true twice over, since v13 stamps
// the default on top of whatever v12 decided.
assert(
  mergeStoredSettings({ settingsVersion: 9, rollSnapToGrid: true } as Partial<AppSettings>).rollSnap !== 'beat',
  'no migration may land a profile on Beat'
);
// …and once on v13, the chosen mode is the take's, including the new one.
const onBeat = mergeStoredSettings({ settingsVersion: 13, rollSnap: 'beat' } as Partial<AppSettings>);
assert(onBeat.rollSnap === 'beat', 'after v13 a chosen Beat is never re-flipped');

// Stored JSON is untrusted: a garbage snap value must normalise rather than reach the feed.
const junk = mergeStoredSettings({ settingsVersion: 13, rollSnapToGrid: 'yes' } as unknown as Partial<AppSettings>);
assert(junk.rollSnap === 'off', 'a non-boolean legacy snap setting falls back to Off');
const junkMode = mergeStoredSettings({ settingsVersion: 13, rollSnap: 'sort-of' } as unknown as Partial<AppSettings>);
assert(junkMode.rollSnap === 'off', 'a snap mode nothing recognises falls back to Off, not to "some kind of on"');
// And a garbage roll grid falls back rather than reaching the ruler — the vocabulary grew by two
// words in G14, so the guard has to know both of them. Read at v13, where the take's own value is
// the one under test rather than one the migration would have overwritten anyway.
const goodGrid = mergeStoredSettings({ settingsVersion: 13, rollGrid: 'off' } as Partial<AppSettings>);
assert(goodGrid.rollGrid === 'off', "'off' is a real roll grid now");
const badGrid = mergeStoredSettings({ settingsVersion: 13, rollGrid: 'auto' } as unknown as Partial<AppSettings>);
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
// Ends are tidied to a cell so nothing rings a ragged 40 ms across the next beat. EVERY note keeps
// the length it rounded to — there is no longer a "last note" special case, because there is no
// longer anything that caps any of the others.
for (const note of onBeats) {
  const off = Math.abs((note.endSec - originSec) / CELL16 - Math.round((note.endSec - originSec) / CELL16));
  assert(off < 1e-9, `${note.id} must END on a subdivision line`);
  assert(note.endSec - note.startSec >= CELL16 - 1e-9, `${note.id} must be at least one cell long`);
}
/*
 * REVOKED — "a tidied end may not swallow the next attack".
 *
 * This assertion is gone, and the claim it made is quoted here so the reversal is on the record
 * rather than inferred from a diff:
 *
 *   "…and an end may not be pushed past the next attack, because the recording did not hold those
 *    two together: s0 was released at 1.44 and s1 struck at 1.47."
 *   assert(onBeats[0].endSec <= onBeats[1].startSec + 1e-9,
 *          'a tidied end may not swallow the next attack');
 *
 * s0 and s1 are at DIFFERENT PITCHES, and that is the whole problem with it: the rule it was
 * guarding could not see pitch at all, so it read "the next attack anywhere on the instrument" as
 * "the end of this note". That is a monophonic bass assumption living in a polyphonic editor, and
 * it cost an untouched note 20–50% of its painted length on the owner's own gesture. The cap is
 * deleted (`app/snap.ts` §"the next-attack cap, and why it is gone"), so a note's end is now its own
 * quantized length and nothing else.
 *
 * IT PASSED ON THIS FIXTURE EVEN AFTER THE CAP WAS DELETED — the quantized end happens not to
 * overshoot here — which is exactly why it is being removed rather than left alone. An assertion
 * that states a revoked law and happens to be satisfied is a trap for the next person to widen the
 * fixture. What replaces it is the property that is actually true.
 */
for (const note of onBeats) {
  const raw = sparse.find((r) => r.id === note.id)!;
  const want = Math.max(CELL16, Math.round((raw.endSec - raw.startSec) / CELL16) * CELL16);
  assert(
    Math.abs(note.endSec - note.startSec - want) < 1e-9,
    `${note.id} keeps its OWN measured length, quantized — no attack at another pitch may cut it`
  );
}

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

// --- 9b-bis. THE LEADER AND ITS FOLLOWERS: rhythm across a beat midpoint -------------------
//
// THE DEFECT. Every event used to run `Math.round((raw - origin) / beatSec)` on its own, and the
// cascade could only rearrange events that had already claimed the SAME beat. A pair played a
// sixteenth apart either side of a midpoint was therefore torn in half — 2.01 back to 2.00, 2.26
// forward to 2.50 — and an interval of 0.25 s came out as 0.50 s. Both notes moved a defensible
// distance; the RHYTHM BETWEEN THEM doubled, and nothing could see it because the two never met.
//
// The fix is a fixed cluster leader (`app/snap.ts` §"THE LEADER AND ITS FOLLOWERS"). These are the
// cases that pin it down, one row of the table per block.
{
  const at = (starts: ReadonlyArray<number>): InputNote[] =>
    starts.map((s, i) => ({ id: `f${i}`, startSec: s, endSec: s + 0.08, midi: 40 + i }));
  const where = (notes: ReadonlyArray<InputNote>): string =>
    notes.map((n) => `${n.id}@${Number(n.startSec.toFixed(6))}`).join(' ');

  // THE OWNER'S REPRO. Beat 0.5, ruler 1/16, origin 0.
  assert(
    where(snapPerformanceToBeat(at([2.01, 2.26]), BEAT, CELL16, 0, 120)) === 'f0@2 f1@2.25',
    `the pair must keep its sixteenth: ${where(snapPerformanceToBeat(at([2.01, 2.26]), BEAT, CELL16, 0, 120))}`
  );
  // …AND ON A RULER THAT HAS NO SIXTEENTH ON IT. The candidate ladder is the cascade's own — cell,
  // cell/2, … down to `finestStepSec` — so a 1/4 ruler still finds the 1/16 the playing implies.
  assert(
    where(snapPerformanceToBeat(at([2.01, 2.26]), BEAT, rollSnapUnitSec('quarter', 120), 0, 120)) === 'f0@2 f1@2.25',
    'a coarse ruler subdivides for a follower exactly as it subdivides for a collision'
  );
  // GRID IS THE CONTROL and is not touched by any of this: it rounds both ends to the ruler, full
  // stop, which is what the two switches mean by their own names.
  assert(
    where(snapPerformanceToGrid(at([2.01, 2.26]), rollSnapUnitSec('eighth', 120), 0, 120)) === 'f0@2 f1@2.25',
    'Grid rounds to its own ruler and knows nothing about leaders'
  );
  assert(
    where(snapPerformanceToGrid(at([2.01, 2.26]), rollSnapUnitSec('quarter', 120), 0, 120)) === 'f0@2 f1@2.5',
    'Grid on a 1/4 ruler still has only 1/4 lines to offer — the control the Beat case is measured against'
  );

  // SPACING, NOT PACKING. Three notes with a hole between the second and third: the follower rule
  // preserves the played gap instead of compacting them onto consecutive cells.
  assert(
    where(snapPerformanceToBeat(at([2.01, 2.14, 2.39]), BEAT, CELL16, 0, 120)) === 'f0@2 f1@2.125 f2@2.375',
    `played spacing must survive: ${where(snapPerformanceToBeat(at([2.01, 2.14, 2.39]), BEAT, CELL16, 0, 120))}`
  );

  // THE BEAT WINS AND RE-PHASES. 2.50 is exactly on a beat, so it beats every relative candidate
  // and becomes the next leader; 2.76 is then measured from IT, not from 2.24.
  assert(
    where(snapPerformanceToBeat(at([2.24, 2.5, 2.76]), BEAT, CELL16, 0, 120)) === 'f0@2 f1@2.5 f2@2.75',
    `a genuine beat onset must reset the phase: ${where(snapPerformanceToBeat(at([2.24, 2.5, 2.76]), BEAT, CELL16, 0, 120))}`
  );

  // A FOLLOWER MAY BE A CHORD. Membership is decided before any of this, so both noteheads take
  // the one position their event was placed at.
  assert(
    where(snapPerformanceToBeat(at([2.01, 2.26, 2.27]), BEAT, CELL16, 0, 120)) === 'f0@2 f1@2.25 f2@2.25',
    'a follower chord is one event and stands on one position'
  );

  // TWO FOLLOWERS WANTING ONE CELL. Separation outranks the preference: the later one takes the
  // next free slot, exactly as an ordinary collision claimant does.
  assert(
    where(snapPerformanceToBeat(at([2.01, 2.26, 2.301]), BEAT, CELL16, 0, 120)) === 'f0@2 f1@2.25 f2@2.375',
    `a relative collision cascades: ${where(snapPerformanceToBeat(at([2.01, 2.26, 2.301]), BEAT, CELL16, 0, 120))}`
  );

  // NO LEGATO CHAIN. Every comparison is against the FIXED leader and the cluster spans strictly
  // less than one beat, so a run of short gaps cannot drag the take: the fifth note here is a whole
  // beat past the leader and starts a cluster of its own.
  const chain = snapPerformanceToBeat(at([2.01, 2.13, 2.26, 2.39, 2.51, 2.63]), BEAT, CELL16, 0, 120);
  assert(
    where(chain) === 'f0@2 f1@2.125 f2@2.25 f3@2.375 f4@2.5 f5@2.625',
    `a legato chain may not accumulate: ${where(chain)}`
  );
  for (let i = 0; i < chain.length; i++) {
    assert(
      Math.abs(chain[i].startSec - at([2.01, 2.13, 2.26, 2.39, 2.51, 2.63])[i].startSec) <= BEAT / 2 + 1e-9,
      'no event may be moved further than half a pulse — the bound plain nearest-beat already had'
    );
  }

  // THE CHORD WINDOW, at min(20 ms, cell/2), and the float fix on its comparison: an exactly-20 ms
  // gap written as decimal seconds is 0.020000000000000018, and without `+ EPS` the float
  // representation rather than the performance decided whether a strum was one chord.
  const twoAt = (gap: number, cellSec: number) =>
    new Set(snapPerformanceToBeat(at([2.0, 2.0 + gap]), BEAT, cellSec, 0, 120).map((n) => n.startSec)).size;
  assert(twoAt(0.019, CELL16) === 1, 'just inside the window is one chord');
  assert(twoAt(2.02 - 2.0, CELL16) === 1, 'EXACTLY at the window is one chord — the float fix');
  assert(twoAt(0.021, CELL16) === 2, 'just outside the window is two events');
  // …and on an unusually fine ruler the cap is cell/2 rather than 20 ms, so the window can never
  // swallow a subdivision the player can see on the roll.
  assert(twoAt(0.019, 0.02) === 2, 'on a 20 ms cell the window is capped at 10 ms');

  // A FOLLOWER'S `sourceTiming` FOLLOWS IT. The symbolic path engraves written ticks, so a follower
  // whose rectangle moved and whose ticks did not would snap the roll and leave the sheet put.
  const symbolic: InputNote[] = [
    { id: 'y0', startSec: 2.01, endSec: 2.2, midi: 40, sourceTiming: { startTick: 1929, endTick: 2112, ppq: 480 } },
    { id: 'y1', startSec: 2.26, endSec: 2.45, midi: 43, sourceTiming: { startTick: 2169, endTick: 2352, ppq: 480 } }
  ];
  const snappedSymbolic = snapPerformanceToBeat(symbolic, BEAT, CELL16, 0, 120);
  assert(
    // 2169 written ticks, moved by the snap's own delta of -0.01 s at 960 ticks/s -> 2159.
    snappedSymbolic[1].startSec === 2.25 && snappedSymbolic[1].sourceTiming!.startTick === 2159,
    `a follower's written ticks move with it: ${JSON.stringify(snappedSymbolic[1].sourceTiming)}`
  );

  // ENDS ARE STILL THE RELEASE PASS'S BUSINESS. A pair that does not overlap keeps its own ends…
  const apart = snapPerformanceToBeat(
    [
      { id: 'g0', startSec: 2.01, endSec: 2.2, midi: 40 },
      { id: 'g1', startSec: 2.26, endSec: 2.45, midi: 43 }
    ],
    BEAT,
    CELL16,
    0,
    120
  );
  /*
   * REVOKED — "a tidied end may not swallow the follower after it".
   *
   * The claim that was here, quoted so the reversal is on the record:
   *
   *   assert(apart[0].endSec <= apart[1].startSec + 1e-9,
   *          'a tidied end may not swallow the follower after it');
   *
   * g0 is midi 40 and g1 is midi 43 — a fourth apart, two different strings, sounding one after the
   * other. Nothing about a bass guitar stops both ringing, and the rule that enforced this could not
   * tell that pair from the same string struck twice. See `app/snap.ts` §"the next-attack cap, and
   * why it is gone" and `scripts/roll-duration-ownership-test.ts`.
   *
   * WHAT IS ASSERTED INSTEAD is the property that replaced it: each of the two keeps its own
   * measured length, quantized, whatever the other one does.
   */
  for (const [i, raw] of [
    { id: 'g0', startSec: 2.01, endSec: 2.2 },
    { id: 'g1', startSec: 2.26, endSec: 2.45 }
  ].entries()) {
    const want = Math.max(CELL16, Math.round((raw.endSec - raw.startSec) / CELL16) * CELL16);
    assert(
      Math.abs(apart[i].endSec - apart[i].startSec - want) < 1e-9,
      `${raw.id} keeps its own quantized length; the note after it has no say in the matter`
    );
  }

  /*
   * …AND THE SUSTAIN CASE STAYS, because it was always asserting the RIGHT thing — it just used to
   * be true for the wrong reason. It passed because the old cap exempted pairs the recording itself
   * held together; it passes now because nothing caps anything. Keeping it means the day somebody
   * reintroduces a cap "only where the take had no overlap", this still fails.
   */
  const held = snapPerformanceToBeat(
    [
      { id: 'h0', startSec: 2.01, endSec: 2.9, midi: 40 },
      { id: 'h1', startSec: 2.26, endSec: 2.45, midi: 43 }
    ],
    BEAT,
    CELL16,
    0,
    120
  );
  assert(held[0].endSec > held[1].startSec + 1e-9, 'a bass note sustained under a follower keeps sustaining');

  // THE BOUND IS THE DOCUMENT'S, NOT THE AUDIO FILE'S. Passing an obsolete audio length is what
  // pulls a detached tail back onto the last line inside the recording — see `snap.ts` §the tape.
  const late: InputNote[] = [{ id: 'z0', startSec: 4.51, endSec: 4.7, midi: 40 }];
  assert(
    snapPerformanceToBeat(late, BEAT, CELL16, 0, 120, 5.0)[0].startSec === 4.5,
    'with the document extent the late attack keeps its own beat'
  );
  assert(
    snapPerformanceToBeat(late, BEAT, CELL16, 0, 120, 4.0)[0].startSec < 4.0,
    'with a stale audio extent it is dragged back inside it — which is why the caller must pass the document'
  );
}

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
/*
 * ONE ASSERTION CHANGED HERE, INTENTIONALLY, and the old one is quoted so the change is legible:
 *
 *   const beatCumulative = snapPerformanceToBeat(beatRaw, BEAT, CELL16, originSec, 120);
 *   assert(
 *     fingerprint(beatCumulative) !== fingerprint(beatRaw),
 *     'snapping an already-snapped take must differ — otherwise this proves nothing about
 *      measuring from raw'
 *   );
 *
 * WHY IT IS NOW FALSE, AND WHY THAT IS AN IMPROVEMENT. Under independent nearest-beat rounding a
 * cascade position was an artefact — the second note of a crowded beat stood a cell past a beat it
 * had never claimed — so feeding the output back in re-classified it and it walked. The
 * leader-follower rule places every event on `leaderBeat + k * step`, which is a lattice position
 * the rule itself will reproduce: BEAT SNAP IS NOW A PROJECTION. Snapping its own output at the
 * same ruler is a fixed point, which is a property worth asserting rather than a gap.
 *
 * WHAT THE OLD ASSERTION WAS GUARDING is still guarded, one line down: that CHAINING rulers is not
 * the same as re-deriving from the take. It just needs a case where the two genuinely differ,
 * because `beatRaw` no longer is one.
 */
const beatCumulative = snapPerformanceToBeat(beatRaw, BEAT, CELL16, originSec, 120);
assert(
  fingerprint(beatCumulative) === fingerprint(beatRaw),
  'Beat is a projection: snapping its own output at the same ruler may not move anything'
);
// RE-DERIVE, NEVER CHAIN — the claim the old assertion above was really making. A take whose 1/32
// answer sits on lines the 1/16 lattice does not have: chaining lands p3 on 2.375 where re-deriving
// from the recording puts it on 2.25. `App.performanceFeed()` re-derives, always.
{
  const chainable: InputNote[] = [
    { id: 'p0', startSec: 1.2077, endSec: 1.5796, midi: 40 },
    { id: 'p1', startSec: 1.6234, endSec: 1.7277, midi: 41 },
    { id: 'p2', startSec: 2.0573, endSec: 2.352, midi: 42 },
    { id: 'p3', startSec: 2.3467, endSec: 2.6881, midi: 43 }
  ];
  const direct = snapPerformanceToBeat(chainable, BEAT, CELL16, originSec, 120);
  const chained = snapPerformanceToBeat(
    snapPerformanceToBeat(chainable, BEAT, rollSnapUnitSec('thirtysecond', 120), originSec, 120),
    BEAT,
    CELL16,
    originSec,
    120
  );
  assert(
    direct.map((n) => `${n.id}@${n.startSec}`).join(' ') === 'p0@1 p1@1.5 p2@2 p3@2.25',
    `re-deriving from the take: ${direct.map((n) => `${n.id}@${n.startSec}`).join(' ')}`
  );
  assert(
    fingerprint(chained) !== fingerprint(direct),
    'chaining one ruler onto another must differ from re-deriving — otherwise "measured from the raw take" proves nothing'
  );
}
// And a hand edit through the Beat layer stores the dragged position as the new raw, exactly as
// it does through Grid: one shared merge, so there is one answer.
const beatDrag = mergeEditedOntoRaw(raw, beatRaw.map((n) => (n.id === 'n2' ? { ...n, startSec: 1.75, endSec: 1.97 } : n)), new Set(['n2']));
assert(beatDrag.find((n) => n.id === 'n2')!.startSec === 1.75, 'the dragged note keeps where it was dropped');
assert(
  beatDrag.find((n) => n.id === 'n0')!.startSec === raw.find((n) => n.id === 'n0')!.startSec,
  'every note the gesture did not name comes back from the recording'
);

// ---------------------------------------------------------------------------
// 9e. THE REPORTED BUG: a crowded bar SUBDIVIDES, it does not push the take forward
// ---------------------------------------------------------------------------
//
// From a screenshot, and it is worth restating exactly because the shape of the failure is the
// whole point. A bass take, Snap on Beat, the ruler on 1/4: the SHEET's bar 2 was missing a G2
// and an F2 that Grid mode showed in the same bar, while an A1 of the same length beside them
// survived. The notes had not been merged or filtered — they had been PUSHED. The cascade
// stepped by a fixed cell, the 1/4 ruler's cell IS the beat, so the second note of every crowded
// beat was thrown a whole beat forward and every note after it inherited that debt: bar 2's last
// two notes were sitting in bar 3, bar 3's in bar 4, and by the end of an eight-bar take the
// drift was 5.4 seconds and the overflow was falling off the end of the last bar, where
// `buildScore`'s past-the-end filter deleted it outright.
//
// The owner's own words are the fix: "beat snap must never lose a note — can't you use 8 eighths
// instead of 4 quarters?" A beat holding more notes than the ruler has cells halves the cell
// until they fit, and they all stay in the beat they were aiming at.
const riff: InputNote[] = [
  // bar 1, four on the pulse
  { id: 'b0', startSec: 0.01, endSec: 0.23, midi: 33 },
  { id: 'b1', startSec: 0.52, endSec: 0.72, midi: 33 },
  { id: 'b2', startSec: 0.99, endSec: 1.24, midi: 40 },
  { id: 'b3', startSec: 1.51, endSec: 1.7, midi: 33 },
  // bar 2, SIX notes of similar length over four beats — the bar from the screenshot
  { id: 'b4', startSec: 2.0, endSec: 2.19, midi: 33 }, // A1
  { id: 'b5', startSec: 2.19, endSec: 2.39, midi: 43 }, // G2
  { id: 'b6', startSec: 2.41, endSec: 2.6, midi: 41 }, // F2
  { id: 'b7', startSec: 2.62, endSec: 2.83, midi: 33 }, // A1
  { id: 'b8', startSec: 2.98, endSec: 3.19, midi: 43 }, // G2
  { id: 'b9', startSec: 3.44, endSec: 3.65, midi: 41 }, // F2
  // bar 3
  { id: 'b10', startSec: 4.0, endSec: 4.22, midi: 33 },
  { id: 'b11', startSec: 4.5, endSec: 4.7, midi: 40 },
  { id: 'b12', startSec: 5.0, endSec: 5.2, midi: 33 },
  { id: 'b13', startSec: 5.5, endSec: 5.72, midi: 43 }
];
const riffBeats: number[] = [];
for (let i = 0; i <= 4 * 4; i++) riffBeats.push(i * BEAT);

/** Every input note that reached the page, by id, and which bar it reached. */
const engraved = (notes: ReadonlyArray<InputNote>, grid: BuildSettings['grid'] = 'auto') => {
  const built = buildScore(
    { notes: [...notes], beats: riffBeats, startOffsetSec: 0, audioDurationSec: 4 * 4 * BEAT + 1 },
    { grid, instrument: 'staff', tuningMidi: [], fingeringStyle: 'low', clefMode: 'auto' }
  );
  const barOf = new Map<string, number>();
  for (const bar of built.ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        for (const note of beat.notes) if (!barOf.has(note.id)) barOf.set(note.id, bar.index);
      }
    }
  }
  return barOf;
};

// THE RULER IS ON 1/4, which is the setting that produced the screenshot: its cell is exactly a
// beat, so under the old cascade every collision cost a whole beat.
const riffSnapped = snapPerformanceToBeat(riff, BEAT, rollSnapUnitSec('quarter', 120), 0, 120);
assert(riffSnapped.length === riff.length, 'the snap itself may not drop a note');
// SIX NOTES, FOUR BEATS, ONE BAR. Bar 2 is written seconds 2.0 to 4.0; every note that was
// played in it must still be in it. Under the old cascade b8 landed at 4.0 and b9 at 4.5 —
// squarely in bar 3, which is precisely "bar 2 is missing a G2 and an F2".
for (const id of ['b4', 'b5', 'b6', 'b7', 'b8', 'b9']) {
  const note = riffSnapped.find((n) => n.id === id)!;
  assert(
    note.startSec >= 2 - 1e-9 && note.startSec < 4 - 1e-9,
    `${id} was played in bar 2 and must be snapped inside bar 2, not to ${note.startSec}`
  );
}
/*
 * …and they subdivide rather than stack: six distinct positions, all inside bar 2.
 *
 * THIS EXACT STRING CHANGED WITH THE LEADER-FOLLOWER RULE, INTENTIONALLY. The old claim, quoted:
 *
 *   assert(
 *     riffSnapped.map((n) => `${n.id}@${n.startSec}`).join(' ')
 *       .includes('b4@2 b5@2.25 b6@2.5 b7@2.75 b8@3 b9@3.5'),
 *     `bar 2 must subdivide onto eighths: …`
 *   );
 *
 * WHY IT MOVED. `b6` is played at 2.41 — 0.41 s after `b4` at 2.00, so it is inside `b4`'s cluster
 * window and its nearest 1/16 relative to `b4`'s snapped beat is 2.375, which is 35 ms from where
 * it was played. Independent bucketing sent it to 2.50, 90 ms away, and then `b7` (2.62) had to
 * cascade off it to 2.75. Under the new rule `b6` is a legitimate relative follower at 2.375 and
 * `b7` keeps its own beat at 2.50 — both notes end up CLOSER to where the player put them.
 * `b5` moves 2.25 → 2.125 as a consequence: it is an ordinary claimant on `b4`'s beat, and the
 * bucket's lattice is now the 1/16 that `b6`'s preference requires (2.19 is 60 ms from 2.25 and
 * 65 ms from 2.125, so the cost of that is a quarter of one screen pixel's worth of timing).
 *
 * What is NOT negotiable and is asserted above and below unchanged: all six stay inside bar 2, all
 * six are distinct, and every one of them reaches the page.
 */
assert(
  riffSnapped.map((n) => `${n.id}@${n.startSec}`).join(' ').includes('b4@2 b5@2.125 b6@2.375 b7@2.5 b8@3 b9@3.5'),
  `bar 2 must subdivide onto eighths: ${riffSnapped.map((n) => `${n.id}@${n.startSec}`).join(' ')}`
);
// EVERY ONE OF THEM IS CLOSER TO WHERE IT WAS PLAYED, or no further — the property the string
// above is an instance of, stated so a future change to the rule cannot quietly get worse.
{
  const old = new Map([['b4', 2], ['b5', 2.25], ['b6', 2.5], ['b7', 2.75], ['b8', 3], ['b9', 3.5]]);
  let improved = 0;
  for (const [id, was] of old) {
    const played = riff.find((n) => n.id === id)!.startSec;
    const now = riffSnapped.find((n) => n.id === id)!.startSec;
    const better = Math.abs(now - played) - Math.abs(was - played);
    assert(better < 0.006, `${id} may not be moved further from where it was played (${was} -> ${now})`);
    if (better < -1e-9) improved++;
  }
  assert(improved >= 2, 'the leader-follower rule must actually pull notes closer to the performance');
}
// THE SHEET, which is where the notes were actually going missing. Every played note reaches the
// page, and it reaches the bar it was played in.
const riffPage = engraved(riffSnapped);
for (const note of riff) {
  assert(riffPage.has(note.id!), `${note.id} must reach the sheet — beat snap may never lose a note`);
}
for (const id of ['b4', 'b5', 'b6', 'b7', 'b8', 'b9']) {
  assert(riffPage.get(id) === 1, `${id} must be engraved in bar 2 (index 1), not bar ${riffPage.get(id)}`);
}
// GRID MODE IS THE CONTROL. The screenshot compared the two, so the test does too: whatever Beat
// does, it may not write fewer notes than Grid does on the same take.
const riffGridPage = engraved(snapPerformanceToGrid(riff, rollSnapUnitSec('eighth', 120), 0, 120));
assert(
  riffPage.size >= riffGridPage.size,
  `Beat wrote ${riffPage.size} of ${riff.length} notes where Grid wrote ${riffGridPage.size}`
);

// ---------------------------------------------------------------------------
// 9e-bis. THE END OF THE TAKE (codex-critique §6.1)
// ---------------------------------------------------------------------------
//
// THE BUG. Neither snap mode knew how long the recording was, and both round FORWARD as readily
// as backward. A note played inside the last cell of a take therefore snapped onto the next line
// — at or past `audioDurationSec` — and `pipeline/src/guards.ts` drops any note whose onset is at
// or past the end of the audio. Switching Snap on deleted the last note of the take.
//
// It was invisible because the property test below used to hand the builder a take a whole second
// longer than the notes it generated, so every note thrown past the end landed in a second of
// tape that does not exist on a real recording. That padding is gone (see `takeDurationSec`), and
// this is the same failure stated directly, as the smallest case that shows it.
{
  const END = 8.0; // a take of exactly four bars at 120 bpm
  const endBeats: number[] = [];
  for (let i = 0; i <= 16; i++) endBeats.push(i * BEAT);
  // Played 40 ms before the end of the tape — nearer to the downbeat that does not exist than to
  // the one that does, which is exactly what makes it round the wrong way.
  const atTheEnd: InputNote[] = [
    { id: 'e0', startSec: 0.02, endSec: 0.4, midi: 40 },
    { id: 'e1', startSec: 7.51, endSec: 7.8, midi: 43 },
    { id: 'e2', startSec: END - 0.04, endSec: END - 0.005, midi: 45 }
  ];

  for (const [label, snapped] of [
    ['beat', snapPerformanceToBeat(atTheEnd, BEAT, rollSnapUnitSec('eighth', 120), 0, 120, END)],
    ['grid', snapPerformanceToGrid(atTheEnd, rollSnapUnitSec('eighth', 120), 0, 120, END)]
  ] as const) {
    assert(snapped.length === atTheEnd.length, `${label}: the snap itself may not drop a note`);
    for (const note of snapped) {
      assert(
        note.startSec < END,
        `${label}: ${note.id} was snapped to ${note.startSec}, at or past the end of a ${END}s take`
      );
      // The roll sizes its own time axis off the longest note it is handed, so an end past the
      // end of the tape stretches the picture of the performance as well.
      assert(note.endSec <= END + 1e-9, `${label}: ${note.id} rings past the end of the take`);
    }
    const built = buildScore(
      { notes: [...snapped], beats: endBeats, startOffsetSec: 0, audioDurationSec: END },
      { grid: 'auto', instrument: 'staff', tuningMidi: [], fingeringStyle: 'low', clefMode: 'auto' }
    );
    const onPage = new Set<string>();
    for (const bar of built.ir.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) for (const note of beat.notes) onPage.add(note.id);
      }
    }
    for (const note of atTheEnd) {
      assert(onPage.has(note.id!), `${label}: ${note.id} must still reach the sheet at the boundary`);
    }
  }

  // AND THE OLD BEHAVIOUR, so the check above is not a tautology: with no take length supplied
  // the final attack still rounds onto the downbeat that is the end of the recording.
  const unbounded = snapPerformanceToBeat(atTheEnd, BEAT, rollSnapUnitSec('eighth', 120), 0, 120);
  assert(
    unbounded.find((n) => n.id === 'e2')!.startSec >= END,
    'without a take length the last attack still rounds off the end — the bound is what fixes it'
  );
}

// ---------------------------------------------------------------------------
// 9f. THE INVARIANT, AS A PROPERTY: every input note survives to the sheet
// ---------------------------------------------------------------------------
//
// One scenario proves the reported bug is gone; it does not prove the class is. These are
// randomised dense takes — three to eight notes a bar, human timing, every roll grid the ruler
// offers — checked on three claims at once:
//
//   1. the snap is a bijection: as many events out as in, at strictly increasing positions at
//      least one subdivision apart, so no two attacks can ever occupy one slot;
//   2. no note moves further than a beat, which is what stops the drift that caused the bug;
//   3. and the number that actually matters — every one of them is still on the SHEET.
//
// `'auto'` is the Quantize setting because it is the default and because it is the one with an
// opinion: it offers straight-8 and straight-16 and never a 1/32, so a cascade that subdivided
// past a 1/16 of the beat would have its extra notes fused onto one tick by the quantizer's
// collision rule. That is why `finestStepSec` stops where it does, and this is the check that
// would catch it moving.
const TRIALS = 240;
const TRIAL_BARS = 8;
const trialBeats: number[] = [];
for (let i = 0; i <= TRIAL_BARS * 4; i++) trialBeats.push(i * BEAT);

let seed = 20260812;
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const RULERS = ['quarter', 'eighth', 'sixteenth', 'thirtysecond', 'triplet', 'off'] as const;
let checkedNotes = 0;
let widestMove = 0;

for (let trial = 0; trial < TRIALS; trial++) {
  const played: InputNote[] = [];
  let id = 0;
  for (let bar = 0; bar < TRIAL_BARS; bar++) {
    const count = 3 + Math.floor(rnd() * 6);
    const offsets: number[] = [];
    for (let i = 0; i < count; i++) offsets.push(rnd() * 4 * BEAT);
    offsets.sort((a, b) => a - b);
    for (const offset of offsets) {
      const startSec = bar * 4 * BEAT + offset;
      played.push({ id: `t${id++}`, startSec, endSec: startSec + 0.12 + rnd() * 0.3, midi: 33 + Math.floor(rnd() * 12) });
    }
  }
  // Two attacks inside the pipeline's own chord window are ONE event on any page, so they are
  // not what this property is about; thinned out here rather than special-cased below.
  const events = played.filter((n, i) => i === 0 || n.startSec - played[i - 1].startSec > 0.06);
  const ruler = RULERS[trial % RULERS.length];
  const cell = rollSnapUnitSec(ruler, 120);
  // THE TAKE ENDS WHERE THE MUSIC ENDS. This used to be handed a builder with a whole extra
  // second on the end of it (`audioDurationSec: … + 1`) while the snap itself was given no length
  // at all — so every attack the magnet threw past the last downbeat landed in that second of
  // imaginary tape and engraved happily. Real recordings do not come with a spare second, and the
  // bug the padding hid was the last note of a take disappearing the moment Snap was switched on.
  const takeDurationSec = TRIAL_BARS * 4 * BEAT;
  const beatSnapped = snapPerformanceToBeat(events, BEAT, cell, 0, 120, takeDurationSec);

  assert(beatSnapped.length === events.length, `trial ${trial}: the snap changed the note count`);
  const minStep = Math.min(cell > 0 ? cell : 0.125, BEAT / 4);
  for (let i = 1; i < beatSnapped.length; i++) {
    assert(
      beatSnapped[i].startSec - beatSnapped[i - 1].startSec >= minStep - 1e-9,
      `trial ${trial} (${ruler}): two attacks landed less than a subdivision apart`
    );
  }
  for (const note of beatSnapped) {
    const move = Math.abs(note.startSec - events.find((e) => e.id === note.id)!.startSec);
    widestMove = Math.max(widestMove, move);
    assert(move < BEAT + 1e-9, `trial ${trial} (${ruler}): ${note.id} moved ${move}s — further than a beat`);
  }

  // THE SHEET. Quantize on 'auto', because that is what the player is looking at.
  const built = buildScore(
    { notes: beatSnapped, beats: trialBeats, startOffsetSec: 0, audioDurationSec: takeDurationSec },
    {
      // A 1/32 ruler is an explicit request for a 1/32 lattice, and 'auto' has no word for one
      // (pipeline/src/quantize.ts §states). The player who asks the roll for 32nds is the player
      // who asks Quantize for them, so that is the pairing under test.
      grid: ruler === 'thirtysecond' ? 'thirtysecond' : 'auto',
      instrument: 'staff',
      tuningMidi: [],
      fingeringStyle: 'low',
      clefMode: 'auto'
    }
  );
  const onPage = new Set<string>();
  for (const bar of built.ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) for (const note of beat.notes) onPage.add(note.id);
    }
  }
  assert(
    onPage.size === events.length,
    `trial ${trial} (${ruler}): ${events.length} played, ${onPage.size} engraved — ` +
      `lost ${events.filter((e) => !onPage.has(e.id!)).map((e) => e.id).join(',')}`
  );
  checkedNotes += events.length;
}

// ---------------------------------------------------------------------------
// 9g. MIDPOINT-STRADDLING MOTIFS, deterministically, across pulses and rulers
// ---------------------------------------------------------------------------
//
// The 240 trials above check survival, separation and movement; they say nothing about the
// INTERVAL between two attacks, which is the whole of the leader-follower defect. These do: one
// motif, played either side of a beat midpoint, at four pulse lengths and on every ruler including
// the triplet one. The claim is the one the owner reported — a played gap of a subdivision may not
// come out as a gap of a whole beat.
let motifs = 0;
for (const beatSec of [0.4, 0.5, 0.6, 1.0]) {
  for (const ruler of RULERS) {
    const cell = rollSnapUnitSec(ruler, 60 / beatSec);
    // THE PAIR STRADDLES THE MIDPOINT: the first is 0.3 of a beat past a downbeat and rounds BACK
    // to it, the second is a quarter of a beat later at 0.55 and rounds FORWARD to the next one.
    // That is the boundary the independent round used to tear a rhythm in half across.
    const a = (4 + 0.3) * beatSec;
    const b = a + beatSec / 4;
    const pair = snapPerformanceToBeat(
      [
        { id: 'm0', startSec: a, endSec: a + beatSec / 8, midi: 40 },
        { id: 'm1', startSec: b, endSec: b + beatSec / 8, midi: 43 }
      ],
      beatSec,
      cell,
      0,
      60 / beatSec
    );
    const played = b - a;
    const written = pair[1].startSec - pair[0].startSec;
    assert(pair.length === 2, `${ruler}@${beatSec}: the motif lost a note`);
    assert(written > 1e-9, `${ruler}@${beatSec}: the motif collapsed onto one position`);
    // HALF A BEAT IS THE CEILING, on every ruler. The old rule answered a quarter-beat gap with a
    // WHOLE beat, because the two notes rounded to adjacent beats and never met.
    assert(
      written <= beatSec / 2 + 1e-9,
      `${ruler}@${beatSec}: a ${played.toFixed(3)}s gap came out as ${written.toFixed(3)}s — more than half a pulse`
    );
    // …AND EXACTLY THE PLAYED GAP wherever the ruler has a line fine enough to say it. A 1/4 ruler
    // on a 1/16 figure genuinely cannot, and answers with the finest thing the ladder admits; a
    // 1/16 or triplet ruler can, and must.
    if (cell > 0 && cell <= played + 1e-9) {
      assert(
        written <= played + 1e-9,
        `${ruler}@${beatSec}: the ruler has a ${cell.toFixed(4)}s cell and still stretched ${played.toFixed(3)}s to ${written.toFixed(3)}s`
      );
    }
    motifs++;
  }
}
assert(motifs === 24, 'every pulse/ruler pairing must be exercised');

console.log(
  `roll-snap-test: free/straight ${freeStraight.glyphs}g ${freeStraight.rests}r ${freeStraight.ties}t · ` +
    `free/triplet ${freeTriplet.glyphs}g ${freeTriplet.rests}r ${freeTriplet.ties}t · ` +
    `beat/cascade ${cascaded.map((n) => n.startSec).join('/')} · ` +
    `beat/preserved ${checkedNotes} notes over ${TRIALS} dense takes, widest move ${widestMove.toFixed(3)}s`
);
console.log('roll-snap-test: all assertions passed');
