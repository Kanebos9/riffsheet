/**
 * ================================ A NOTE BELONGS TO ITSELF ================================
 *
 * THE OWNER'S REPORT (Aug 14, on the 13:18 build). A roll with several notes on it. A new note is
 * added at a DIFFERENT TIME and a DIFFERENT PITCH from an existing one. The existing note — never
 * pointed at, never selected, never edited, its recording untouched — comes back VISIBLY SHORTER.
 * Measured off the screenshot: a low-row note lost about 30% of its painted width when a mid-pitch
 * note was added later in time.
 *
 * THE LAW THIS GATE STATES, in the stronger form adjudicated after Codex's review:
 *
 *     FOR ANY NON-SHEET TRANSACTION WITH AUTHORED IDS A, EVERY PRE-EXISTING ID OUTSIDE A KEEPS
 *     IDENTICAL startSec, endSec AND midi.
 *
 * ONSET IS IN THE LAW NOW, and that is the change from the previous round. The earlier form
 * asserted duration and pitch only, and exempted onset under Beat on the grounds that a global
 * allocator may legitimately re-slot a neighbour ("the Beat exemption", `ui/app.ts`). That exemption
 * is withdrawn for EDITS. Re-magnetising the whole take is something the user REQUESTS — by
 * switching the mode, or by changing the ruler — and between those requests the derived layer is a
 * stable picture that edits change one note at a time. An add is not a request to re-magnetise
 * anything. So a FULL derivation may move any onset it likes, and an INCREMENTAL one may move
 * nothing it was not handed.
 *
 * WHAT THIS REVOKES. Law (a2) in `scripts/soak-probe.mjs` carried an explicit exemption — a note was
 * permitted to be "squeezed by its own successor's attack" — on the reasoning that a snapped end
 * must not invent an overlap the player never played. That reasoning is a MONOPHONIC BASS
 * assumption: one note ends when the next begins. It is false in a polyphonic editor, where the
 * "successor" is routinely a different string on a different row.
 *
 * ============================== WHAT WAS MEASURED, AND WHAT WAS NOT ==============================
 *
 * TWO MECHANISMS WERE PUT TO THIS GATE. Both are recorded because the second one is a negative
 * result, and a negative result that goes unwritten gets rediscovered.
 *
 *   1. THE CROSS-PITCH NEXT-ATTACK CAP (`app/snap.ts`, deleted). Reproduced exactly, at the unit
 *      level, in section A: on HEAD 58e6e7e this sweep failed 500 of 5252 Beat cells, taking 20–50%
 *      off an untouched note's length, and a sweep of midi 21–100 against a midi-40 note found ALL
 *      EIGHTY pitches cutting it. Pitch-blind, exactly as the conviction said.
 *
 *   2. THE OCCUPANCY RE-QUANTIZATION (`app/snap.ts` §2, the per-bucket `step`). The theory: an add
 *      that crowds a beat halves that beat's step, and every untouched member's duration is then
 *      re-quantized on the finer lattice. IT COULD NOT BE REPRODUCED. Swept deliberately — occupancy
 *      2–8 notes on one beat, spacings 25/30/35/40/45 ms, durations chosen to quantize DIFFERENTLY
 *      at the cell and at half the cell (0.20 s is 0.25 at a 1/16 and 0.1875 at a 1/32), and
 *      separately across 4000 random dense takes — and found ZERO untouched durations changed by a
 *      full derivation once the cap was gone (section C reports the live count every run). The
 *      cascade spills crowded events onto later cells rather than subdividing in the cases reached
 *      here. The freezing below makes the question moot either way, which is why it is still the
 *      right design; but this gate does not claim to have caught mechanism 2, because it did not.
 *
 * SO WHAT IS THE FREEZING ACTUALLY BUYING? The ONSET half of the law, and it is not a small half:
 * section C measures it live, and a full derivation moves an untouched neighbour's onset in roughly
 * one dense take in eight. That is the "(a2) fires on almost every add" the soak rig documented, and
 * it is what an incremental derivation has to stop for the adopted law to hold at all.
 */

import type { InputNote } from '../src/pipeline';
import {
  placementsOf,
  snapPerformanceToBeat,
  snapPerformanceToGrid,
  type FrozenPlacement
} from '../src/app/snap';

const BPM = 120;
const BEAT_SEC = 0.5;      // a quarter at 120 bpm
const CELL_SEC = 0.125;    // the roll's ruler cell, a 1/16
const TAKE_SEC = 8;
const GRID_UNIT_SEC = 0.25;

type Mode = 'off' | 'grid' | 'beat';
const MODES: Mode[] = ['off', 'grid', 'beat'];

const n = (id: string, startSec: number, endSec: number, midi: number): InputNote => ({
  id, startSec, endSec, midi
});

/**
 * The derived layer, exactly as `ui/app.ts` derives it per mode. 'off' is the recording itself —
 * the app calls neither function — so it is the identity, and it is included precisely so that the
 * claim "Off is uncoupled" is asserted rather than assumed.
 *
 * `incremental` is the transaction: the ids this edit authored, and what the PREVIOUS derivation
 * placed everything at. Passing it is what `App.snappedFeed()` does on a roll edit; leaving it off
 * is what it does on a mode or ruler change. The gate must model the first — the law is about
 * transactions, and a pair of full derivations is not one.
 */
function derive(
  notes: ReadonlyArray<InputNote>,
  mode: Mode,
  incremental?: { authored: ReadonlySet<string>; previous: ReadonlyMap<string, FrozenPlacement> }
): InputNote[] {
  const list = notes.slice().sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  if (mode === 'off') return list;
  if (mode === 'grid') return snapPerformanceToGrid(list, GRID_UNIT_SEC, 0, BPM, TAKE_SEC);
  return snapPerformanceToBeat(list, BEAT_SEC, CELL_SEC, 0, BPM, TAKE_SEC, incremental);
}

/** One transaction, derived the way the app derives one: incrementally, freezing the unauthored. */
function transact(
  base: ReadonlyArray<InputNote>,
  added: InputNote,
  mode: Mode
): { before: InputNote[]; after: InputNote[] } {
  const before = derive(base, mode);
  const after = derive([...base, added], mode, {
    authored: new Set([added.id!]),
    previous: placementsOf(base, before, CELL_SEC)
  });
  return { before, after };
}

const rowById = (list: ReadonlyArray<InputNote>): Map<string, { start: number; end: number; midi: number }> =>
  new Map(list.map((x) => [x.id!, { start: x.startSec, end: x.endSec, midi: x.midi }]));

interface Failure {
  mode: Mode;
  cell: string;
  id: string;
  was: { start: number; end: number; midi: number };
  now: { start: number; end: number; midi: number } | null;
  why: string;
}

const failures: Failure[] = [];

/**
 * The law, applied to one transaction. Returns true if the cell broke it.
 *
 * EXACT, to 1e-9, on all three numbers, and there is deliberately no slack: these are the same
 * floats the previous derivation produced, carried across by a Map, so "identical" is a claim about
 * identity rather than about rounding.
 */
function check(
  mode: Mode,
  cell: string,
  base: ReadonlyArray<InputNote>,
  t: { before: InputNote[]; after: InputNote[] }
): boolean {
  let bad = false;
  /*
   * ANTI-VACUITY. A gate that passes because the edit did nothing is not a gate. The authored note
   * must be in the result at a positive length, and the count must have gone up by exactly one — so
   * an incremental path that silently dropped the add, or handed back the cache untouched, fails
   * here rather than reporting green.
   */
  const add = t.after.find((x) => x.id === 'ADD');
  if (!add || !(add.endSec - add.startSec > 0)) {
    failures.push({
      mode, cell, id: 'ADD', was: { start: 0, end: 0, midi: 0 },
      now: add ? { start: add.startSec, end: add.endSec, midi: add.midi } : null,
      why: 'the authored note was not placed at all'
    });
    bad = true;
  }
  if (t.after.length !== base.length + 1) {
    failures.push({
      mode, cell, id: '(count)',
      was: { start: base.length + 1, end: 0, midi: 0 },
      now: { start: t.after.length, end: 0, midi: 0 },
      why: 'the transaction changed how many notes exist'
    });
    bad = true;
  }
  const before = rowById(t.before);
  const after = rowById(t.after);
  for (const b of base) {
    const was = before.get(b.id!)!;
    const now = after.get(b.id!) ?? null;
    if (!now) {
      failures.push({ mode, cell, id: b.id!, was, now, why: 'vanished' });
      bad = true;
      continue;
    }
    const onsetMoved = Math.abs(now.start - was.start) > 1e-9;
    const endMoved = Math.abs(now.end - was.end) > 1e-9;
    const why =
      now.midi !== was.midi ? 'repitched'
      : onsetMoved && endMoved ? 'onset and end moved'
      : onsetMoved ? 'onset moved'
      : endMoved ? 'end moved'
      : null;
    if (why) {
      failures.push({ mode, cell, id: b.id!, was, now, why });
      bad = true;
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------------------------
// A — the owner's own case: an add at a later time and another pitch
// ---------------------------------------------------------------------------------------------
/*
 * The anchor's recorded LENGTH is swept across a whole beat in 5 ms steps, so its quantized end
 * lands every possible distance past its raw end, and the GAP to the added note is swept with it.
 * That overshoot region is where the deleted cap used to do its damage.
 */
const cells: { mode: Mode; total: number; bad: number }[] = [];
const ADDED_PITCHES = [31, 48, 55, 72, 90];

for (const mode of MODES) {
  let total = 0;
  let bad = 0;
  for (let anchorLenMs = 100; anchorLenMs <= 600; anchorLenMs += 5) {
    for (let gapMs = 0; gapMs <= 120; gapMs += 10) {
      for (const addedMidi of ADDED_PITCHES) {
        const anchorEnd = 0.02 + anchorLenMs / 1000;
        const base: InputNote[] = [
          n('low', 0.02, anchorEnd, 40),
          n('mid', 2.02, 2.28, 55),
          n('hi', 3.03, 3.30, 67)
        ];
        // A pitch collision is a different question; skipped so the claim stays clean.
        if (base.some((b) => b.midi === addedMidi)) continue;
        const added = n('ADD', anchorEnd + gapMs / 1000, anchorEnd + gapMs / 1000 + 0.2, addedMidi);
        total++;
        if (check(mode, `anchorLen=${anchorLenMs}ms gap=${gapMs}ms addedMidi=${addedMidi}`, base, transact(base, added, mode))) bad++;
      }
    }
  }
  cells.push({ mode, total, bad });
}

// ---------------------------------------------------------------------------------------------
// B — random dense takes, which is where the ONSET half of the law is actually load-bearing
// ---------------------------------------------------------------------------------------------
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** One pseudo-random dense take plus the note to add to it. Deterministic in `seed`. */
function randomTake(seed: number): { base: InputNote[]; added: InputNote } {
  const r = rng(seed);
  const count = 4 + Math.floor(r() * 8);
  const base: InputNote[] = [];
  let t = 0.01 + r() * 0.1;
  for (let k = 0; k < count; k++) {
    const d = 0.06 + r() * 0.45;
    base.push(n(`x${k}`, Number(t.toFixed(4)), Number((t + d).toFixed(4)), 36 + Math.floor(r() * 40)));
    t += 0.04 + r() * 0.4;
    if (t > 6) break;
  }
  const at = Number((0.02 + r() * 5.5).toFixed(4));
  return { base, added: n('ADD', at, Number((at + 0.06 + r() * 0.4).toFixed(4)), 30 + Math.floor(r() * 50)) };
}

const RANDOM_TAKES = 4000;
let denseBad = 0;
for (let seed = 1; seed <= RANDOM_TAKES; seed++) {
  const { base, added } = randomTake(seed);
  if (check('beat', `random take seed=${seed}`, base, transact(base, added, 'beat'))) denseBad++;
}

// ---------------------------------------------------------------------------------------------
// C — the control: the same takes under FULL derivation must still diverge
// ---------------------------------------------------------------------------------------------
/*
 * A green gate is only evidence if a red one was reachable. The fault rode in on a FULL derivation
 * of a take that differs by one note — which is what the app did on every edit before the freezing
 * — so the control runs exactly that over the same 4000 takes and counts what it disturbs. If this
 * ever reaches zero, either the allocator has stopped being global (delete this control
 * deliberately) or the gate has stopped measuring anything, and the second is worth failing over.
 *
 * The two counts are reported separately because they say different things: ONSET is the live fault
 * the freezing exists to stop, and DURATION is the one mechanism 2 predicted and that has never been
 * observed here (see the header). Only the total is failed on.
 */
let ctlOnset = 0;
let ctlDuration = 0;
for (let seed = 1; seed <= RANDOM_TAKES; seed++) {
  const { base, added } = randomTake(seed);
  const before = rowById(derive(base, 'beat'));
  const after = rowById(derive([...base, added], 'beat'));
  let ds = false;
  let dd = false;
  for (const b of base) {
    const was = before.get(b.id!)!;
    const now = after.get(b.id!);
    if (!now) { dd = true; continue; }
    if (Math.abs(now.start - was.start) > 1e-9) ds = true;
    if (Math.abs((now.end - now.start) - (was.end - was.start)) > 1e-9) dd = true;
  }
  if (ds) ctlOnset++;
  if (dd) ctlDuration++;
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

console.log('A NOTE BELONGS TO ITSELF — incremental edit, derived layer');
console.log('  A: cross-pitch add after an existing note stops');
let total = 0;
for (const c of cells) {
  total += c.total;
  console.log(`     snap=${c.mode.padEnd(4)}  ${c.total} cells, ${c.bad} with a pre-existing note changed`);
}
console.log(`     ${total} cells in all`);
console.log(`  B: random dense takes, one add each`);
console.log(`     snap=beat  ${RANDOM_TAKES} takes, ${denseBad} with a pre-existing note changed`);
console.log(`  C: control — the same ${RANDOM_TAKES} takes under FULL derivation`);
console.log(`     untouched ONSET moved in    ${ctlOnset} takes  (what the freezing stops)`);
console.log(`     untouched DURATION moved in ${ctlDuration} takes  (mechanism 2 — never observed)`);

if (ctlOnset + ctlDuration === 0) {
  throw new Error(
    'the control no longer diverges: a full re-derivation is what the fault rode in on, so a gate ' +
    'that cannot reproduce it there has stopped measuring the thing it was built for'
  );
}

if (failures.length) {
  const byWhy = new Map<string, number>();
  for (const f of failures) byWhy.set(`${f.mode}/${f.why}`, (byWhy.get(`${f.mode}/${f.why}`) ?? 0) + 1);
  console.log('');
  console.log(`  ${failures.length} violations:`);
  for (const [w, k] of [...byWhy].sort()) console.log(`    ${w}: ${k}`);
  for (const f of failures.slice(0, 6)) {
    console.log(
      `    snap=${f.mode} ${f.cell} -> '${f.id}' ${f.why}: ` +
      `${f.was.start.toFixed(4)}-${f.was.end.toFixed(4)} => ` +
      `${f.now ? `${f.now.start.toFixed(4)}-${f.now.end.toFixed(4)}` : 'gone'}`
    );
  }
  throw new Error(
    `a note belongs to itself: ${failures.length} pre-existing notes were changed by a transaction that did not author them`
  );
}

console.log('  clean — every pre-existing id kept its exact onset, end and pitch');
