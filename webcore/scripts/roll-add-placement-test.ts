/**
 * =========================== AN ADD LANDS WHERE IT WAS CLICKED ===========================
 *
 * THE OWNER'S REPORT (Aug 14, on the 18:09 build). Double-clicking empty space on the piano roll
 * put the new note "in a COMPLETELY DIFFERENT location than clicked". Not a pixel or two of grid
 * rounding — somewhere else in the bar.
 *
 * THE LAW THIS GATE STATES:
 *
 *     A ROLL ADD IS DERIVED WITHIN ONE SUBDIVISION OF THE SECOND IT WAS AUTHORED AT, AND ON
 *     EXACTLY THE PITCH IT WAS AUTHORED ON, UNDER EVERY SNAP MODE AND EVERY RULER — AND IT DOES
 *     THIS WITHOUT MOVING ANY NOTE IT DID NOT NAME.
 *
 * The second clause is not decoration. `roll-duration-ownership-test.ts` states the other half —
 * every pre-existing id keeps its onset, end and pitch — and the two are trivially satisfiable one
 * at a time: re-derive the whole take and the add lands beautifully while the neighbours move; nail
 * the neighbours down and the add gets pushed off to wherever there is room. They are asserted
 * TOGETHER here so that neither can be bought with the other.
 *
 * ===================== WHAT WAS ACTUALLY BROKEN, AND WHAT IT MEASURED =====================
 *
 * The fault was entirely in the incremental placement pass (`app/snap.ts` §snapIncrementally),
 * which places an authored note around the frozen ones. Three independent defects, all in the one
 * candidate search, each of them on its own enough to throw an add most of a beat:
 *
 *   1. THE SEARCH WINDOW WAS ONE-SIDED. Candidates were drawn from beats `round(t/beat)` and
 *      `round(t/beat)+1` — so an attack in the BACK half of a beat rounded up and could not see a
 *      single line at or before itself. Measured on a dense take at a 1/16 ruler, 120 bpm: a click
 *      at 0.250 s came back at 0.625 s. Over a 0–1000 ms sweep, 87 of 123 cells landed further than
 *      half a subdivision away, worst 375 ms, where a FULL derivation of the same take was never
 *      worse than 100 ms.
 *
 *   2. THE LADDER WAS WALKED COARSE-RUNG-FIRST. Every candidate at the ruler's cell was considered
 *      before any candidate at half a cell, so a beat whose cell lines were occupied sent the add a
 *      WHOLE BEAT away instead of onto the free half-cell line under the pointer — the opposite of
 *      what the full allocator's rule 2 does, which subdivides a crowded beat and spills only as a
 *      last resort. Over 7,200 random dense cells: 455 landed further than one subdivision away,
 *      worst 979 ms, against the full derivation's worst of 431 ms on the same takes.
 *
 *   3. AN OCCUPIED LINE WAS REFUSED OUTRIGHT, WITH NO CHORD RULE. Two attacks inside the chord
 *      window are ONE event to the global allocator and stand on ONE position; the incremental pass
 *      had only a set of forbidden lines and so could not say that. An add placed directly above an
 *      existing note — the gesture `edit/rollPerformance.ts` §reseatAnchoredAdd exists to make
 *      exact, by seating the new note on the anchor's OWN recorded onset — was therefore pushed a
 *      full subdivision to the right of the note it was aimed at. Section D is that case alone.
 *
 * The repair is one ranked search with a price on sharing (`app/snap.ts` §costOn): free lines and
 * genuine chords cost nothing, standing beside a stranger costs half a subdivision, and a unison is
 * refused at any price. That bounds the whole answer — nothing can land further from the attack
 * than the nearest lattice line plus half a cell — which is what makes the law above statable.
 *
 * ANTI-VACUITY. Section E re-runs section B's sweep against a derivation with NO frozen placements,
 * which is the full allocator, and reports its own worst displacement. If the incremental road ever
 * stops being exercised — a refactor that quietly always falls back — the two numbers become
 * identical and the report says so.
 */

import type { InputNote } from '../src/pipeline';
import {
  placementsOf,
  snapPerformanceToBeat,
  snapPerformanceToGrid,
  type FrozenPlacement
} from '../src/app/snap';

const BPM = 120;
const BEAT_SEC = 0.5;
const TAKE_SEC = 12;

type Mode = 'off' | 'grid' | 'beat';
const MODES: Mode[] = ['off', 'grid', 'beat'];
/** The rulers the roll actually offers, as seconds at 120 bpm. */
const RULERS = [0.5, 0.25, 0.125, 0.0625];

let failures = 0;
const fail = (what: string, detail: unknown): void => {
  failures++;
  if (failures <= 20) console.error(`  FAIL  ${what}  ${JSON.stringify(detail)}`);
};

const n = (id: string, startSec: number, endSec: number, midi: number): InputNote => ({
  id,
  startSec,
  endSec,
  midi
});

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/**
 * The derived layer, exactly as `ui/app.ts §snappedFeed` derives it.
 *
 * 'off' is the recording itself — the app calls neither snap function — so it is the identity, and
 * it is here so that a fault common to all three modes cannot hide behind two of them.
 * `incremental` is passed only under Beat, which is the only mode with a global allocator and
 * therefore the only one that has anything to freeze.
 */
const derive = (
  mode: Mode,
  notes: InputNote[],
  unitSec: number,
  incremental?: { authored: Set<string>; previous: Map<string, FrozenPlacement> }
): InputNote[] => {
  if (mode === 'off') return notes;
  if (mode === 'grid') return snapPerformanceToGrid(notes, unitSec, 0, BPM, TAKE_SEC);
  return snapPerformanceToBeat(notes, BEAT_SEC, unitSec, 0, BPM, TAKE_SEC, incremental);
};

/** The second the ROLL emits for a click: its own grid rounding, done before anything else sees it. */
const asRollWould = (sec: number, unitSec: number): number =>
  Math.max(0, Math.round(sec / unitSec) * unitSec);

/**
 * One experiment: derive a take, add a note at `askSec` on `midi`, derive again incrementally.
 *
 * Returns the displacement of the ADD from the second it was authored at, the pitch it came back
 * on, and how many pre-existing notes moved — the two halves of the law, from one transaction.
 */
function addOnce(
  mode: Mode,
  base: InputNote[],
  unitSec: number,
  askSec: number,
  midi: number
): { driftSec: number; midi: number | null; moved: number } | null {
  const before = derive(mode, base, unitSec);
  const previous = placementsOf(base, before, unitSec);
  const added = n('ADD', askSec, askSec + unitSec, midi);
  const take = [...base, added].sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  const after = derive(mode, take, unitSec, { authored: new Set(['ADD']), previous });
  const got = after.find((x) => x.id === 'ADD');
  if (!got) return null;
  const wasById = new Map(before.map((x) => [x.id ?? '', x]));
  let moved = 0;
  for (const x of after) {
    if (x.id === 'ADD') continue;
    const was = wasById.get(x.id ?? '');
    if (!was) continue;
    if (
      Math.abs(was.startSec - x.startSec) > 1e-9 ||
      Math.abs(was.endSec - x.endSec) > 1e-9 ||
      was.midi !== x.midi
    ) {
      moved++;
    }
  }
  return { driftSec: Math.abs(got.startSec - askSec), midi: got.midi, moved };
}

// =============================================================================
// A: THE OWNER'S GESTURE, SWEPT — a click anywhere in two bars, on any row
// =============================================================================
console.log('AN ADD LANDS WHERE IT WAS CLICKED');
console.log('  A: a click swept across two bars, every mode, every ruler');

/** A take with something on most beats and a few off-beat attacks, on several strings. */
function bassTake(unitSec: number): InputNote[] {
  const out: InputNote[] = [];
  let k = 0;
  for (let b = 0; b < 20; b++) {
    const t = b * BEAT_SEC + (b % 3 === 0 ? 0.004 : 0.012);
    out.push(n(`t${k++}`, t, t + 0.28, 40 + (b % 5)));
    if (b % 2 === 0) {
      const u = b * BEAT_SEC + unitSec * 2 + 0.006;
      out.push(n(`t${k++}`, u, u + 0.18, 47 + (b % 3)));
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
}

const worstA = new Map<string, number>();
let cellsA = 0;
for (const mode of MODES) {
  for (const unitSec of RULERS) {
    const base = bassTake(unitSec);
    let worst = 0;
    for (let step = 0; step <= 40; step++) {
      const askSec = asRollWould((step / 40) * 4 * BEAT_SEC, unitSec);
      for (const midi of [38, 41, 44, 47, 52, 59]) {
        const r = addOnce(mode, base, unitSec, askSec, midi);
        cellsA++;
        if (!r) {
          fail('A/add-vanished', { mode, unitSec, askSec, midi });
          continue;
        }
        worst = Math.max(worst, r.driftSec);
        if (r.driftSec > unitSec + 1e-9) {
          fail('A/landed-elsewhere', {
            mode,
            unitSec,
            askSec: Number(askSec.toFixed(4)),
            midi,
            driftMs: Math.round(r.driftSec * 1000),
            allowedMs: Math.round(unitSec * 1000)
          });
        }
        if (r.midi !== midi) fail('A/wrong-pitch', { mode, unitSec, askSec, asked: midi, got: r.midi });
        if (r.moved !== 0) fail('A/neighbour-moved', { mode, unitSec, askSec, midi, moved: r.moved });
      }
    }
    worstA.set(`${mode}/${unitSec}`, worst);
  }
}
for (const mode of MODES) {
  const line = RULERS.map((u) => `1/${Math.round(2 / u)}:${Math.round((worstA.get(`${mode}/${u}`) ?? 0) * 1000)}ms`).join('  ');
  console.log(`     snap=${mode.padEnd(4)} worst drift  ${line}`);
}
console.log(`     ${cellsA} cells`);

// =============================================================================
// B: RANDOM DENSE TAKES — the saturated lattice, where a spill has room to run
// =============================================================================
console.log('  B: random dense takes, one add each');

type Cell = { mode: Mode; unitSec: number; base: InputNote[]; askSec: number; midi: number };
const randomCells: Cell[] = [];
for (const mode of MODES) {
  for (const unitSec of RULERS) {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 7919 + Math.round(unitSec * 1e4));
      const base: InputNote[] = [];
      const count = 6 + Math.floor(r() * 16);
      for (let i = 0; i < count; i++) {
        const s = Number((r() * 6).toFixed(4));
        base.push(n(`b${i}`, s, s + 0.05 + r() * 0.7, 36 + Math.floor(r() * 24)));
      }
      base.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
      for (let t = 0; t < 6; t++) {
        randomCells.push({
          mode,
          unitSec,
          base,
          askSec: asRollWould(r() * 6, unitSec),
          midi: 36 + Math.floor(r() * 24)
        });
      }
    }
  }
}

let worstB = 0;
let movedB = 0;
for (const c of randomCells) {
  const r = addOnce(c.mode, c.base, c.unitSec, c.askSec, c.midi);
  if (!r) {
    fail('B/add-vanished', { mode: c.mode, unitSec: c.unitSec, askSec: c.askSec });
    continue;
  }
  worstB = Math.max(worstB, r.driftSec);
  if (r.driftSec > c.unitSec + 1e-9) {
    fail('B/landed-elsewhere', {
      mode: c.mode,
      unitSec: c.unitSec,
      askSec: Number(c.askSec.toFixed(4)),
      midi: c.midi,
      driftMs: Math.round(r.driftSec * 1000),
      allowedMs: Math.round(c.unitSec * 1000)
    });
  }
  if (r.midi !== c.midi) fail('B/wrong-pitch', { mode: c.mode, asked: c.midi, got: r.midi });
  if (r.moved !== 0) movedB += r.moved;
}
console.log(`     ${randomCells.length} cells, worst drift ${Math.round(worstB * 1000)}ms, ${movedB} neighbour moves`);
if (movedB !== 0) fail('B/neighbour-moved', { moved: movedB });

// =============================================================================
// C: THE ADD IS AT MOST ONE SUBDIVISION FROM WHERE THE PLAYER POINTED, EVEN AT
//    THE HEAD AND THE TAIL OF THE TAKE
// =============================================================================
console.log('  C: the first and last lines of the take');
{
  const unitSec = 0.125;
  const base = bassTake(unitSec);
  for (const askSec of [0, unitSec, TAKE_SEC - unitSec * 2, TAKE_SEC - unitSec]) {
    for (const mode of MODES) {
      const r = addOnce(mode, base, unitSec, asRollWould(askSec, unitSec), 43);
      if (!r) {
        fail('C/add-vanished', { mode, askSec });
        continue;
      }
      // The end of the tape may legitimately pull an add back inside the recording, which is a
      // whole beat's worth of licence at the very last line — see `snap.ts §boundEnd/lastLine`.
      const allowed = askSec > TAKE_SEC - BEAT_SEC ? BEAT_SEC : unitSec;
      if (r.driftSec > allowed + 1e-9) {
        fail('C/landed-elsewhere', { mode, askSec, driftMs: Math.round(r.driftSec * 1000) });
      }
      if (r.midi !== 43) fail('C/wrong-pitch', { mode, askSec, got: r.midi });
    }
  }
}
console.log('     head and tail clean');

// =============================================================================
// D: AN ADD AIMED AT A NOTE'S OWN ONSET STANDS ON THAT NOTE'S OWN LINE
// =============================================================================
/*
 * THE C1 GESTURE, END TO END. `ui/app.ts §applyRollEdit` seats an anchored add on the anchor's OWN
 * recorded onset so that the two are simultaneous in the clock the allocator groups in. This asserts
 * the last step of that journey: the derivation must then put them on the SAME derived line. The
 * boolean occupancy test that used to guard the frozen placements refused exactly this — the
 * anchor's line was "taken" — and pushed the note the player had aimed at the anchor a whole
 * subdivision to the right, which is the sharpest form of the owner's report.
 */
console.log('  D: an add on an existing note\'s own onset joins it, it is not pushed off');
{
  let cells = 0;
  for (const unitSec of RULERS) {
    const base = bassTake(unitSec);
    const beforeBeat = derive('beat', base, unitSec);
    const previous = placementsOf(base, beforeBeat, unitSec);
    for (const anchor of base) {
      const seatSec = beforeBeat.find((x) => x.id === anchor.id)?.startSec ?? null;
      if (seatSec === null) continue;
      /*
       * WHO ELSE IS ALREADY ON THE ANCHOR'S LINE. A pitch that is already standing there cannot be
       * added to it — that is a unison, one notehead for two notes, and `snap.ts §costOn` refuses it
       * by design. Asking for it and calling the refusal a failure would be asserting the opposite
       * of the rule this file is protecting, so those pitches are skipped rather than expected.
       */
      const already = new Set(
        beforeBeat.filter((x) => Math.abs(x.startSec - seatSec) < 1e-9).map((x) => x.midi)
      );
      for (const rows of [1, -1, 3, -5, 7]) {
        const midi = anchor.midi + rows;
        if (already.has(midi)) continue;
        // The anchor's own recorded onset, which is what `reseatAnchoredAdd` writes.
        const added = n('ADD', anchor.startSec, anchor.startSec + unitSec, midi);
        const take = [...base, added].sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
        const after = snapPerformanceToBeat(take, BEAT_SEC, unitSec, 0, BPM, TAKE_SEC, {
          authored: new Set(['ADD']),
          previous
        });
        const got = after.find((x) => x.id === 'ADD');
        const seat = beforeBeat.find((x) => x.id === anchor.id);
        cells++;
        if (!got || !seat) {
          fail('D/add-vanished', { unitSec, anchor: anchor.id, rows });
          continue;
        }
        if (Math.abs(got.startSec - seat.startSec) > 1e-9) {
          fail('D/not-simultaneous', {
            unitSec,
            anchor: anchor.id,
            rows,
            anchorAt: Number(seat.startSec.toFixed(4)),
            addedAt: Number(got.startSec.toFixed(4)),
            apartMs: Math.round((got.startSec - seat.startSec) * 1000)
          });
        }
        if (got.midi !== midi) fail('D/wrong-pitch', { unitSec, anchor: anchor.id, rows, got: got.midi });
        // …and the anchor itself did not move to make room.
        const anchorAfter = after.find((x) => x.id === anchor.id);
        if (!anchorAfter || Math.abs(anchorAfter.startSec - seat.startSec) > 1e-9) {
          fail('D/anchor-moved', { unitSec, anchor: anchor.id, rows });
        }
      }
    }
  }
  console.log(`     ${cells} anchored cells`);
}

// =============================================================================
// E: THE CONTROL — the same sweep with nothing frozen, i.e. the full allocator
// =============================================================================
/*
 * ANTI-VACUITY, and a measurement worth keeping. This is the road the app takes when the user
 * asks for the take to be re-magnetised, and it is allowed to move anything it likes; what it is
 * NOT allowed to be is identical to the incremental road, because then nothing above is testing the
 * incremental road at all. The numbers are reported rather than asserted equal-or-better: a full
 * derivation legitimately puts an isolated attack on its nearest BEAT, which is further from the
 * pointer than the nearest subdivision by design.
 */
console.log('  E: control — the same random cells under FULL derivation');
{
  let worst = 0;
  let differed = 0;
  for (const c of randomCells) {
    if (c.mode !== 'beat') continue;
    const added = n('ADD', c.askSec, c.askSec + c.unitSec, c.midi);
    const take = [...c.base, added].sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
    const full = snapPerformanceToBeat(take, BEAT_SEC, c.unitSec, 0, BPM, TAKE_SEC);
    const got = full.find((x) => x.id === 'ADD');
    if (!got) continue;
    worst = Math.max(worst, Math.abs(got.startSec - c.askSec));
    const inc = addOnce('beat', c.base, c.unitSec, c.askSec, c.midi);
    if (inc && Math.abs(Math.abs(got.startSec - c.askSec) - inc.driftSec) > 1e-9) differed++;
  }
  console.log(`     full derivation worst drift ${Math.round(worst * 1000)}ms, ${differed} cells where the two roads differ`);
  if (differed === 0) fail('E/incremental-road-not-exercised', { differed });
}

if (failures) {
  console.error(`roll-add-placement-test: ${failures} FAILURES`);
  process.exit(1);
}
console.log('roll-add-placement-test: all assertions passed');
