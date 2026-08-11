/**
 * SNAP TO GRID (#41), and the roll's view of the performance layer.
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
            // original ragged durations on the sheet, which is the one outcome this feature may
            // not produce. One tick is the floor for the same reason one cell is above.
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
  });
  // Snapping can legitimately reorder two notes that were played a hair apart and landed on
  // different lines. Everything downstream reads a performance in time order.
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
