/**
 * SNAP — Off / Grid / Beat (#41, G25) — and the roll's view of the performance layer.
 *
 * Pure functions, in their own file for the same reason `edit/rollPerformance.ts` is in its
 * own: notes in, notes out, no DOM, so the behaviour can be exercised by
 * `scripts/roll-snap-test.ts` without standing up an app. `ui/app.ts` decides WHEN to apply
 * them (see `App.performanceFeed`, the one tap point); this file only says what they do.
 */

import type { InputNote } from '@pipeline';
import type { AppSettings } from './state';

/**
 * One rectangle's worth of performance, as the roll takes it.
 *
 * Declared here rather than imported because `view/pianoroll.ts` is gaining
 * `setPerformanceNotes` on its own schedule; this is the app's half of that contract written
 * down, so the two can land in either order.
 */
export interface RollPerformanceNote {
  id: string;
  midi: number;
  startSec: number;
  endSec: number;
  velocity?: number;
}

/**
 * The snap unit for a roll grid, in seconds. The SAME table `PianoRoll.snapSec` uses, because a
 * note that lands on a drawn column and a note the snap moved have to agree about where the
 * column is.
 *
 * 'free' returns 0, which every caller reads as "do not snap". The roll gives free a quarter/4
 * anyway, because it still needs a length for a note somebody draws; that is a different
 * question from where an existing note belongs, and answering it here would snap a take whose
 * grid the player has explicitly set to none.
 */
export function rollSnapUnitSec(grid: AppSettings['rollGrid'], tempoBpm: number): number {
  const quarter = 60 / (tempoBpm || 100);
  switch (grid) {
    case 'quarter':
      return quarter;
    case 'eighth':
      return quarter / 2;
    case 'sixteenth':
      return quarter / 4;
    case 'thirtysecond':
      return quarter / 8;
    case 'triplet':
      return quarter / 3;
    case 'free':
    // 'off' draws bar lines and nothing else, so there is no column for a note to stand on.
    // Same answer as 'free', for a different reason, and both are read as "do not snap".
    case 'off':
      return 0;
  }
}

/**
 * SNAP TO GRID (#41), as a pure derived layer.
 *
 * BOTH ENDS (G9). Every note's start moves to the nearest grid line AND so does its end, with
 * a floor of one whole cell so nothing can be snapped out of existence. That is a change from
 * the first version of this function, which moved the start and carried the played LENGTH over
 * untouched — "the rhythm of the grid and the articulation of the performance". It reads well
 * and it is not what anybody asking for a grid means: a take snapped to 1/8 came out with every
 * note starting on a line and ending 30–70 ms past one, so the sheet still had to round the
 * durations and the roll still drew ragged right edges under a switch whose whole promise was
 * that things would line up. Snapping both ends makes the rectangles the columns, which is the
 * picture the control has always implied.
 *
 * The floor is one cell rather than zero: a note played shorter than half a cell would
 * otherwise round to the same line at both ends and become a zero-length note, which is not a
 * note. It is applied AFTER both roundings, so a genuinely short note is widened to one cell
 * and a long one keeps whatever whole number of cells it rounded to.
 *
 * Nothing is mutated — notes are rebuilt, exactly as `edit/rollPerformance.ts` rebuilds them,
 * because the undo stacks hold arrays of references and an in-place move would rewrite history
 * as well as the present.
 *
 * MEASURED FROM THE RAW TAKE, ALWAYS. The caller passes the recording's own notes, never the
 * output of a previous snap, so changing the grid re-derives from the performance instead of
 * rounding an already-rounded number. That is what makes 1/8 -> 1/16 -> 1/8 return to where it
 * started rather than drifting a little further each time.
 *
 * `originSec` is written second 0 on the recording's clock, so the lines fall where the roll
 * draws them (`PianoRoll.snap` snaps written seconds) rather than at multiples of the unit from
 * the top of the file, which is a different grid whenever there is a count-in.
 *
 * `sourceTiming` is restated by the same delta. A symbolic import's written ticks are what
 * `pipeline/src/buildScore.ts` engraves when every note carries them, so leaving them behind
 * would snap the roll and leave the sheet exactly where it was — the one outcome this feature
 * may not produce, since the sheet is supposed to follow the roll.
 */
export function snapPerformanceToGrid(
  notes: ReadonlyArray<InputNote>,
  unitSec: number,
  originSec: number,
  tempoBpm: number
): InputNote[] {
  if (!(unitSec > 0) || notes.length === 0) return notes as InputNote[];
  const out = notes.map((n) => {
    const rawStart = originSec + Math.round((n.startSec - originSec) / unitSec) * unitSec;
    // Clamped before the length is measured off it, so a note snapped backwards past the top of
    // the file cannot end up describing a negative span.
    const startSec = Math.max(0, rawStart);
    // The END, on the same lines as the start, then floored at one whole cell. `Math.round` on
    // the end rather than `Math.ceil`: a note played a hair past a line belongs on that line,
    // exactly as its start does, and ceiling would lengthen every note in the take by up to a
    // cell for no reason anybody could see.
    const rawEnd = originSec + Math.round((n.endSec - originSec) / unitSec) * unitSec;
    const endSec = Math.max(startSec + unitSec, rawEnd);
    return restate(n, startSec, endSec, tempoBpm);
  });
  // Snapping can legitimately reorder two notes that were played a hair apart and landed on
  // different lines. Everything downstream reads a performance in time order.
  out.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  return out;
}

/**
 * One note, restated at a new span — the piece both snap modes share.
 *
 * Nothing is mutated: a note that did not move comes back BY REFERENCE (so an untouched take
 * stays the array everything downstream already holds), and a note that did is rebuilt, exactly
 * as `edit/rollPerformance.ts` rebuilds them, because the undo stacks hold arrays of references
 * and an in-place move would rewrite history as well as the present.
 *
 * `sourceTiming` is restated by the same delta. A symbolic import's written ticks are what
 * `pipeline/src/buildScore.ts` engraves when every note carries them, so leaving them behind
 * would snap the roll and leave the sheet exactly where it was — the one outcome this feature
 * may not produce, since the sheet is supposed to follow the roll.
 */
function restate(n: InputNote, startSec: number, endSec: number, tempoBpm: number): InputNote {
  const deltaSec = startSec - n.startSec;
  if (deltaSec === 0 && endSec === n.endSec) return n;
  const timing = n.sourceTiming;
  const shifted =
    timing && Number.isFinite(timing.ppq) && timing.ppq > 0
      ? (() => {
          const perSec = ((tempoBpm || 100) / 60) * timing.ppq;
          const startTick = Math.max(0, Math.round(timing.startTick + deltaSec * perSec));
          // The written ticks follow the SNAPPED span, not the played one — otherwise a
          // symbolic import would show grid-aligned rectangles on the roll and engrave the
          // original ragged durations on the sheet. One tick is the floor for the same reason
          // one cell is elsewhere: a note of no length is not a note.
          const endTick = startTick + Math.max(1, Math.round((endSec - startSec) * perSec));
          return { startTick, endTick, ppq: timing.ppq };
        })()
      : null;
  return {
    ...n,
    startSec,
    endSec,
    ...(shifted ? { sourceTiming: shifted } : {})
  };
}

/**
 * How close two attacks have to be before the beat magnet reads them as ONE event.
 *
 * A chord is several notes and one attack, and the cascade below exists to stop two notes
 * landing on one POSITION — which is a statement about events, not about noteheads. Without
 * this window a strummed triad would come out as three notes a subdivision apart, which is a
 * different piece of music from the one that was played.
 *
 * 20 ms because that is about where two attacks stop being heard as separate, and capped at
 * half a cell so it can never swallow a subdivision the player can actually see on the roll.
 */
const CHORD_WINDOW_SEC = 0.02;

/**
 * The floor on the cascade's step, in seconds, and it is a floor about SURVIVAL rather than
 * about taste.
 *
 * Two attacks closer together than `chords.ts`'s window (35 ms) are collected into one chord
 * event by the pipeline before anything is quantized, and a chord is one notehead group. A
 * cascade that packed two separate notes 30 ms apart would therefore hand the engraver a single
 * event and lose one of them — the exact failure this whole function exists to prevent. 40 ms
 * leaves a margin over that window at any tempo.
 */
const MIN_STEP_SEC = 0.04;

/**
 * How finely a beat may be subdivided to make room, in seconds.
 *
 * A SIXTEENTH OF THE BEAT, unless the ruler itself is finer. That number is not arbitrary: the
 * quantizer's 'auto' grid offers straight-8 and straight-16 and NEVER a straight-32 (see
 * `pipeline/src/quantize.ts` §states — "1/32 is opt-in, never offered by 'auto'"), so two
 * attacks a 1/32 apart round onto the same tick on the page and the collision fuse eats one of
 * them. Subdividing past what the sheet can read back would move the note loss one station
 * downstream instead of fixing it.
 *
 * A ruler the player has explicitly set FINER than that is honoured — they asked for a 1/32
 * lattice by name, and Quantize has a 1/32 setting to match — which is why this is the finer of
 * the two rather than a flat 1/16.
 */
function finestStepSec(cellSec: number, beatSec: number): number {
  return Math.min(beatSec, Math.max(Math.min(cellSec, beatSec / 4), MIN_STEP_SEC));
}

/**
 * ======================= SNAP TO BEAT (G25) =======================
 *
 * The third state of the Snap control: not "line every note up with the ruler" but "put every
 * note on the beat it was aiming at". Grid mode answers where the COLUMNS are; this answers
 * where the PULSE is, which is the question somebody reading a take asks first.
 *
 * `beatSec` is the beat the sheet counts in — the tempo and meter out of `App.snapBasis()`, so
 * a 6/8 take is magnetised to its eighths and a 2/2 take to its halves, and the roll and the
 * sheet cannot disagree about where beat 2 is. `originSec` is written second 0 on the
 * recording's clock, exactly as in grid mode.
 *
 * THREE RULES, in the order they are applied.
 *
 * 1. NEAREST BEAT. Every attack goes to the closest beat, not the preceding one: a note played
 *    12 ms early was aiming at the beat it is early FOR, and flooring would drag it a whole beat
 *    backwards.
 *
 * 2. SUBDIVIDE THE BEAT — never push the take forward. Several notes can want the same beat;
 *    stacking them there would delete the run, so the beat is divided into as many equal parts
 *    as the notes standing on it need. The EARLIEST takes the beat itself and the rest fill the
 *    subdivisions after it, ALL OF THEM INSIDE THAT BEAT.
 *
 *    The step starts at `subdivisionSec` — the roll grid's own cell, so the cascade lands on
 *    lines the player can see, or a 1/16 when the ruler is Free or Off and has no cell to
 *    offer — and is HALVED until the whole group fits between this beat and the next. That is
 *    the whole fix for the reported bug, and it is the answer the report itself gave: if a beat
 *    is holding more notes than the ruler has cells, use eight eighths rather than four
 *    quarters. A coarse ruler now costs a finer cascade and nothing else.
 *
 *    WHAT IT REPLACED, because the failure is worth writing down. The first version stepped by
 *    a FIXED cell — `lastPos + cell` — which is a queue, not a lattice: with the ruler on 1/4
 *    the cell IS the beat, so the second note of any crowded beat was thrown a whole beat
 *    forward, the third inherited that debt, and every later note in the take inherited it
 *    again. A bar of six notes emptied its last two into the next bar (the reported symptom:
 *    "bar 2 is missing a G2 and an F2 that Grid mode shows"), the drift grew without bound —
 *    measured at 5.4 seconds by the end of an eight-bar take — and the notes that ran off the
 *    end of the last bar were dropped outright by `buildScore`'s past-the-end filter. Notes
 *    disappeared from the SHEET because the snap had pushed them off it.
 *
 *    SPILLING IS THE LAST RESORT, not the mechanism. A beat only hands notes to the next one
 *    when it is full at the finest step allowed (`finestStepSec`), which takes more attacks on
 *    one beat than a 4/4 bar has 1/16s. Even then the spill is one beat, not a growing debt.
 *
 *    ORDER IS PRESERVED BY CONSTRUCTION: beats are filled in ascending order, a group never
 *    leaves its own beat, and within a beat the notes keep the order they were played in. Two
 *    notes can never swap, and no two events can share a position — except a chord, which is
 *    one event (see `CHORD_WINDOW_SEC`).
 *
 * 3. CLEAN ENDS. The release goes to the nearest subdivision line with a floor of one cell, so
 *    nothing rings a ragged 40 ms across the next beat. It is then capped at the next attack —
 *    but ONLY where the recording did not already hold the two together, so a bass note
 *    sustained under a melody keeps sustaining and a snapped end cannot invent an overlap the
 *    player never played. The floor wins over the cap: one cell is the minimum note.
 *
 * MEASURED FROM THE RAW TAKE, ALWAYS, and nothing is mutated — the same contract grid mode
 * keeps, which is what makes Off/Grid/Beat/Off return the recording to the bit.
 */
export function snapPerformanceToBeat(
  notes: ReadonlyArray<InputNote>,
  beatSec: number,
  subdivisionSec: number,
  originSec: number,
  tempoBpm: number
): InputNote[] {
  if (!(beatSec > 0) || notes.length === 0) return notes as InputNote[];
  const quarterSec = 60 / (tempoBpm || 100);
  // Where the subdivision STARTS — the ruler's own cell, so a beat that is not crowded puts its
  // notes on lines the player can already see. Never coarser than the beat itself: with Grid on
  // 1/4 in a 6/8 take the ruler's cell is longer than a beat, and a "subdivision" longer than
  // the thing it subdivides is not one. Where it starts is not where it ends: the loop below
  // halves it as often as the notes standing on a beat require.
  const cell = Math.min(subdivisionSec > 0 ? subdivisionSec : quarterSec / 4, beatSec);
  // …and where the halving stops.
  const finest = finestStepSec(cell, beatSec);
  const chordWindow = Math.min(CHORD_WINDOW_SEC, cell / 2);
  const EPS = 1e-9;

  // Played order, stably — the original index breaks a tie between two notes of the same pitch
  // at the same instant, so the answer does not depend on the sort's implementation.
  const order = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.startSec - b.n.startSec || a.n.midi - b.n.midi || a.i - b.i);

  // --- events: a chord is ONE event ------------------------------------------------------
  // Everything below counts EVENTS, not noteheads, because "how many notes want this beat" is
  // a question about attacks: a strummed triad needs one position, not three.
  const events: { members: number[]; rawStart: number }[] = [];
  for (const { n, i } of order) {
    const open = events[events.length - 1];
    if (open && n.startSec - open.rawStart <= chordWindow) {
      open.members.push(i);
      continue;
    }
    events.push({ members: [i], rawStart: n.startSec });
  }

  // --- 1: every event goes to its NEAREST beat -------------------------------------------
  // Beats are addressed by INDEX rather than by time so that two of them can never collapse
  // onto the same second at the head of the take, which is what a bare `Math.max(0, …)` on the
  // position would do to a note played before written second 0.
  const minIdx = Math.ceil((0 - originSec) / beatSec - EPS);
  const buckets = new Map<number, number[]>();
  for (let e = 0; e < events.length; e++) {
    const idx = Math.max(minIdx, Math.round((events[e].rawStart - originSec) / beatSec));
    const at = buckets.get(idx);
    if (at) at.push(e);
    else buckets.set(idx, [e]);
  }

  // --- 2: each beat subdivides itself until its own notes fit ----------------------------
  const positions = new Array<number>(notes.length);
  const stepOf = new Array<number>(notes.length);
  const anchorOf = new Array<number>(notes.length);
  const indices = [...buckets.keys()].sort((a, b) => a - b);
  const lastIdx = indices[indices.length - 1];
  let spilled: number[] = [];
  // EVERY beat from the first occupied one onward, not only the occupied ones: a spill goes to
  // the beat AFTER the one that was full, and an empty beat is exactly where it should land.
  for (let idx = indices[0]; idx <= lastIdx || spilled.length; idx++) {
    const own = buckets.get(idx);
    const here = spilled.length ? [...spilled, ...(own ?? [])] : (own ?? []);
    spilled = [];
    if (!here.length) continue;
    const beatStart = originSec + idx * beatSec;
    // HALVE THE RULER'S CELL UNTIL THEY FIT. The last note of the group has to stand strictly
    // inside this beat, so `(count - 1) * step` must be shorter than the beat itself.
    let step = cell;
    while ((here.length - 1) * step >= beatSec - EPS && step / 2 >= finest - EPS) step /= 2;
    // How many the beat can hold at the step it settled on. Anything past that is handed to the
    // next beat, which will subdivide for them in turn.
    const capacity = Math.max(1, Math.floor((beatSec - EPS) / step) + 1);
    if (here.length > capacity) spilled = here.slice(capacity);
    for (let j = 0; j < Math.min(here.length, capacity); j++) {
      const pos = beatStart + j * step;
      for (const m of events[here[j]].members) {
        positions[m] = pos;
        stepOf[m] = step;
        anchorOf[m] = beatStart;
      }
    }
  }

  // --- 3: where each release lands ------------------------------------------------------
  const out = new Array<InputNote>(notes.length);
  for (let k = 0; k < order.length; k++) {
    const { n, i } = order[k];
    const startSec = positions[i];
    const step = stepOf[i];
    // Rounded onto THIS BEAT's lattice rather than the origin's. They are the same lattice
    // whenever the beat divides into the step a whole number of times, which is every straight
    // ruler; where they differ — a triplet cell under a compound beat — the beat's own lines are
    // the ones the note is standing on, and an end may not land between them.
    let endSec = Math.max(
      startSec + step,
      anchorOf[i] + Math.round((n.endSec - anchorOf[i]) / step) * step
    );
    // `positions` is non-decreasing along `order`, so the first later note standing anywhere
    // past this one is the next attack — chords included, since they share this position.
    for (let j = k + 1; j < order.length; j++) {
      const next = order[j];
      if (positions[next.i] <= startSec + EPS) continue;
      // Only where the take itself did not hold them together.
      if (n.endSec <= next.n.startSec + EPS) endSec = Math.max(startSec + step, Math.min(endSec, positions[next.i]));
      break;
    }
    out[k] = restate(n, startSec, endSec, tempoBpm);
  }

  // Everything downstream reads a performance in time order, and `order` is already in it;
  // the sort only settles the pitch tie-break inside a chord.
  out.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  return out;
}

/**
 * Fold one gesture's worth of edited notes back into the RAW take.
 *
 * The snap is a layer, so an edit made through it has to land on the recording underneath —
 * but only where the player actually pointed. `touchedIds` is the gesture's own note list, so
 * a dragged note stores exactly where it was dropped as its new raw position (which is what
 * makes the edit survive switching the snap off), while every note the player did not touch is
 * restored from the recording rather than frozen at the grid line it happened to be drawn on.
 *
 * A note in `edited` with no counterpart in `raw` is one the gesture ADDED, and it is kept as
 * it came: there is nothing behind it to go back to.
 */
export function mergeEditedOntoRaw(
  raw: ReadonlyArray<InputNote>,
  edited: ReadonlyArray<InputNote>,
  touchedIds: ReadonlySet<string>
): InputNote[] {
  const rawById = new Map<string, InputNote>();
  for (const n of raw) if (n.id) rawById.set(n.id, n);
  const out = edited.map((n) => {
    if (!n.id || touchedIds.has(n.id)) return n;
    return rawById.get(n.id) ?? n;
  });
  out.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  return out;
}
