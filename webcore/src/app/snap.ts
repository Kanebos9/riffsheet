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
 * 2. COLLISION CASCADE. A fast run has several notes whose nearest beat is the same beat, and
 *    stacking them there would delete the run. The EARLIEST takes the beat and every later one
 *    steps onto the next free subdivision — `subdivisionSec`, which is the roll grid's own cell
 *    so the cascade lands on lines the player can see, or a 1/16 when the ruler is Free or Off
 *    and has no cell to offer. The result is that a 1/16 run keeps its subdivisions while its
 *    first note is pulled onto the beat, which is the promise the tip makes.
 *
 *    ORDER IS PRESERVED BY CONSTRUCTION, because each position is chosen strictly after the
 *    last one that was handed out. Two notes can never swap, and no two events can share a
 *    position — except a chord, which is one event (see `CHORD_WINDOW_SEC`).
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
  // The cascade's step. Never coarser than the beat itself: with Grid on 1/4 in a 6/8 take the
  // ruler's cell is longer than a beat, and stepping by it would throw the second note of a
  // collision a whole beat away rather than onto the next position after the first.
  const cell = Math.min(subdivisionSec > 0 ? subdivisionSec : quarterSec / 4, beatSec);
  const chordWindow = Math.min(CHORD_WINDOW_SEC, cell / 2);
  const EPS = 1e-9;

  // Played order, stably — the original index breaks a tie between two notes of the same pitch
  // at the same instant, so the answer does not depend on the sort's implementation.
  const order = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.startSec - b.n.startSec || a.n.midi - b.n.midi || a.i - b.i);

  // --- 1 and 2: where each attack lands ------------------------------------------------
  const positions = new Array<number>(notes.length);
  let lastPos = -Infinity;
  let groupRawStart = Number.NaN;
  let groupPos = 0;
  for (const { n, i } of order) {
    if (Number.isFinite(groupRawStart) && n.startSec - groupRawStart <= chordWindow) {
      positions[i] = groupPos;
      continue;
    }
    const nearest = Math.max(0, originSec + Math.round((n.startSec - originSec) / beatSec) * beatSec);
    const pos = nearest > lastPos + EPS ? nearest : lastPos + cell;
    positions[i] = pos;
    lastPos = pos;
    groupRawStart = n.startSec;
    groupPos = pos;
  }

  // --- 3: where each release lands ------------------------------------------------------
  const out = new Array<InputNote>(notes.length);
  for (let k = 0; k < order.length; k++) {
    const { n, i } = order[k];
    const startSec = positions[i];
    let endSec = Math.max(
      startSec + cell,
      originSec + Math.round((n.endSec - originSec) / cell) * cell
    );
    // `positions` is non-decreasing along `order`, so the first later note standing anywhere
    // past this one is the next attack — chords included, since they share this position.
    for (let j = k + 1; j < order.length; j++) {
      const next = order[j];
      if (positions[next.i] <= startSec + EPS) continue;
      // Only where the take itself did not hold them together.
      if (n.endSec <= next.n.startSec + EPS) endSec = Math.max(startSec + cell, Math.min(endSec, positions[next.i]));
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
