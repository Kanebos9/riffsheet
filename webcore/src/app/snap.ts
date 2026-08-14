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
  tempoBpm: number,
  takeDurationSec?: number
): InputNote[] {
  if (!(unitSec > 0) || notes.length === 0) return notes as InputNote[];
  // THE END OF THE TAPE. See `lastLineBefore`: without it a note played inside the last cell of a
  // take rounds forward onto a line at or past `audioDurationSec`, and `applyGuards` then drops
  // it outright — the snap makes a note the player can hear disappear from the sheet.
  const lastLine = lastLineBefore(takeDurationSec, originSec, unitSec);
  const out = notes.map((n) => {
    const rawStart = originSec + Math.round((n.startSec - originSec) / unitSec) * unitSec;
    // Clamped before the length is measured off it, so a note snapped backwards past the top of
    // the file cannot end up describing a negative span, and never past the last line that is
    // still inside the recording.
    const startSec = Math.max(0, lastLine === null ? rawStart : Math.min(rawStart, lastLine));
    // The END, on the same lines as the start, then floored at one whole cell. `Math.round` on
    // the end rather than `Math.ceil`: a note played a hair past a line belongs on that line,
    // exactly as its start does, and ceiling would lengthen every note in the take by up to a
    // cell for no reason anybody could see.
    const rawEnd = originSec + Math.round((n.endSec - originSec) / unitSec) * unitSec;
    const endSec = boundEnd(Math.max(startSec + unitSec, rawEnd), startSec, takeDurationSec);
    return restate(n, startSec, endSec, tempoBpm);
  });
  // Snapping can legitimately reorder two notes that were played a hair apart and landed on
  // different lines. Everything downstream reads a performance in time order.
  out.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  return out;
}

/**
 * ===================== THE END OF THE TAPE, AND WHY IT IS A PARAMETER =====================
 *
 * Both snap modes round attacks FORWARD as readily as backward, and neither of them used to know
 * how long the recording was. A note played 30 ms before the end of a take therefore rounded onto
 * the next line — which is at or past `audioDurationSec` — and `pipeline/src/guards.ts` drops any
 * note whose onset is at or past the end of the audio. The last note of a take vanished from the
 * sheet, silently, because a VIEW LAYER moved it off the end of the recording it is a view of.
 *
 * The randomized property test hid this for as long as it existed by handing the builder a take
 * one second longer than the notes it generated (`scripts/roll-snap-test.ts`), which is exactly
 * the padding a real recording does not have.
 *
 * `takeDurationSec` is optional because both functions are also used to answer "where would this
 * land", with no take behind the question; when it is absent nothing below does anything.
 *
 * IT IS THE DOCUMENT'S END, NOT THE AUDIO FILE'S, and the caller is the one who knows the
 * difference. On every ordinary take they are the same number. After a bar insert they are not
 * (`SourceAudio.timelineDetached`): the score legitimately outlives the recording, the pipeline's
 * past-end guard has been lifted for exactly that reason, and clamping here to the tape would go
 * on doing what the guard has stopped doing — piling every note the insert pushed past the old
 * end back onto the last line inside the recording. `App.documentDurationSec()` is what the
 * caller passes, and it is `max(audio, score)` once the two have parted company.
 */
const END_EPS = 1e-6;

/**
 * The last lattice line strictly inside the take, or null when there is no take to be inside of.
 *
 * STRICTLY inside: `guards.ts` drops `startSec >= audioDurationSec`, so a line exactly at the end
 * is not a place a note may stand.
 */
function lastLineBefore(
  takeDurationSec: number | undefined,
  originSec: number,
  stepSec: number
): number | null {
  if (!(takeDurationSec !== undefined && takeDurationSec > 0 && stepSec > 0)) return null;
  const steps = Math.floor((takeDurationSec - END_EPS - originSec) / stepSec);
  const line = originSec + steps * stepSec;
  // A take shorter than the distance from the origin to its first line has no usable line at all;
  // the caller's own `Math.max(0, …)` is then the only bound, which is the pre-existing behaviour.
  return line >= 0 ? line : null;
}

/**
 * A release, never past the end of the recording.
 *
 * The pipeline clamps `endSec` to the take's length anyway, so this changes nothing on the page —
 * but the ROLL sizes its own time axis from the longest note it is given (`setPerformanceNotes`),
 * so a snapped end hanging past the end of the tape stretches the picture of the performance.
 */
function boundEnd(endSec: number, startSec: number, takeDurationSec: number | undefined): number {
  if (!(takeDurationSec !== undefined && takeDurationSec > startSec)) return endSec;
  return Math.min(endSec, takeDurationSec);
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
 * ==================== WHAT ONE NOTE'S DERIVATION CAME OUT AS, LAST TIME ====================
 *
 * The derived placement of a single note, kept so the next edit can carry it over VERBATIM rather
 * than working it out again. `rawStartSec`/`rawEndSec` are the RECORDING this placement was derived
 * from, and they are the licence to reuse it: a placement is only carried over while the recording
 * underneath it is unchanged, which is what makes undo, redo, ripple write-back and every other
 * road that rewrites the take without "authoring" anything re-derive correctly instead of freezing
 * at a stale answer.
 */
export interface FrozenPlacement {
  startSec: number;
  endSec: number;
  stepSec: number;
  rawStartSec: number;
  rawEndSec: number;
}

/**
 * ======================= INCREMENTAL EDITS FREEZE UNTOUCHED PLACEMENTS =======================
 *
 * THE FAULT THIS EXISTS TO KILL, and it is the one a next-attack fix on its own would have missed.
 *
 * Beat is a GLOBAL allocator. Every beat gets a `step` chosen by how crowded that beat is — the
 * ruler's cell, halved until everything standing on the beat fits (§2). That step is then written
 * to every member of the bucket (`stepOf[m] = step`) and the release pass rounds each note's own
 * measured length onto it. So adding ONE note to a beat can halve that beat's step, and every
 * untouched note sharing the beat has its DURATION RE-QUANTIZED at the finer step — a note nobody
 * named, whose recording never changed, comes back a different length. The next-attack cap and this
 * are two independent roads to the same owner-visible symptom, and removing only the first would
 * have left the second live.
 *
 * THE RULE NOW. A derivation is one of two things, and which one it is depends on what the user
 * just did rather than on anything inside this file:
 *
 *   A FULL DERIVATION happens on an explicit MODE or RULER change, and on TAKE LOAD. Those are the
 *     moments the user has asked for the whole take to be magnetised, so the global allocator runs
 *     exactly as it always has and every note is placed against every other. Nothing below is used.
 *
 *   AN INCREMENTAL DERIVATION happens on a roll EDIT — add, move, resize, delete. Every note the
 *     transaction did not author keeps the placement it already had, to the bit: same onset, same
 *     end, same step. Only the authored notes are allocated, and they are fitted AROUND the frozen
 *     ones — spilling to a free subdivision when the line they wanted is taken, NEVER displacing a
 *     neighbour to make room.
 *
 * WHY THAT IS THE RIGHT SHAPE AND NOT A PATCH. "Adding a note re-magnetises the notes around it" is
 * not a behaviour anybody asked for; it is an artefact of re-running a whole-take algorithm to
 * answer a one-note question. The magnetisation is a thing the user REQUESTS (by turning the mode
 * on, or by changing the ruler), and between requests the derived layer is a stable picture that
 * edits change one note at a time. That is also what makes the law in `scripts/soak-probe.mjs`
 * statable at all: for any non-sheet transaction with authored ids A, every pre-existing id outside
 * A keeps identical startSec, endSec and midi.
 *
 * Returns null when the incremental road cannot be taken honestly — no previous derivation to build
 * on, or a note with no id, in which case the caller falls back to the full allocator.
 */
export interface IncrementalSnap {
  /** The ids this transaction authored. Only these are allowed to be (re)allocated. */
  authored: ReadonlySet<string>;
  /** What the previous derivation produced, by id. */
  previous: ReadonlyMap<string, FrozenPlacement>;
}

function snapIncrementally(
  notes: ReadonlyArray<InputNote>,
  beatSec: number,
  subdivisionSec: number,
  originSec: number,
  tempoBpm: number,
  takeDurationSec: number | undefined,
  { authored, previous }: IncrementalSnap
): InputNote[] | null {
  if (previous.size === 0) return null;
  const quarterSec = 60 / (tempoBpm || 100);
  const cell = Math.min(subdivisionSec > 0 ? subdivisionSec : quarterSec / 4, beatSec);
  const finest = finestStepSec(cell, beatSec);
  const chordWindow = Math.min(CHORD_WINDOW_SEC, cell / 2);
  const EPS = 1e-9;
  const lastLine = lastLineBefore(takeDurationSec, originSec, finest);

  const order = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.startSec - b.n.startSec || a.n.midi - b.n.midi || a.i - b.i);

  /*
   * WHO IS FROZEN. A note is carried over verbatim only when all three hold: it has an id, this
   * transaction did not author it, and its RECORDING is byte-identical to the one its cached
   * placement was derived from. The third is what keeps undo honest.
   */
  const frozen = new Map<number, FrozenPlacement>();
  const loose: { n: InputNote; i: number }[] = [];
  for (const entry of order) {
    const id = entry.n.id;
    const was = id ? previous.get(id) : undefined;
    if (
      id &&
      was &&
      !authored.has(id) &&
      Math.abs(was.rawStartSec - entry.n.startSec) < EPS &&
      Math.abs(was.rawEndSec - entry.n.endSec) < EPS
    ) {
      frozen.set(entry.i, was);
    } else {
      loose.push(entry);
    }
  }
  // Nothing carried over means this is not an incremental edit at all — let the allocator run.
  if (frozen.size === 0) return null;

  /*
   * THE LINES THAT ARE TAKEN. Two events on one position are ONE event to the engraver, so an
   * authored note may not be placed where a frozen one already stands. Keyed on the finest lattice
   * the cascade can reach, which is the resolution at which "the same line" is a meaningful claim.
   */
  const keyOf = (sec: number): number => Math.round(sec / finest);
  const taken = new Set<number>();
  for (const p of frozen.values()) taken.add(keyOf(p.startSec));

  const out = new Array<InputNote>(notes.length);
  for (const [i, p] of frozen) out[i] = restate(notes[i], p.startSec, p.endSec, tempoBpm);

  /*
   * THE AUTHORED NOTES, FITTED AROUND THEM. A chord is one event here exactly as it is in the full
   * allocator, so a strummed triad claims one position and keeps it.
   */
  const events: { members: number[]; rawStart: number }[] = [];
  for (const { n, i } of loose) {
    const open = events[events.length - 1];
    if (open && n.startSec - open.rawStart <= chordWindow + EPS) {
      open.members.push(i);
      continue;
    }
    events.push({ members: [i], rawStart: n.startSec });
  }

  for (const ev of events) {
    /*
     * WHERE IT WANTS TO BE: its own nearest beat, exactly as rule 1 places a leader. Then, if that
     * line is taken, the nearest FREE line on the halving ladder — the same ladder the cascade
     * uses, so an authored note lands on a subdivision the player can already see. It searches
     * outward from the beat it belongs to and never writes over a frozen neighbour.
     */
    const beatIdx = Math.round((ev.rawStart - originSec) / beatSec);
    let pos: number | null = null;
    for (let step = cell; step >= finest - EPS && pos === null; step /= 2) {
      const slots = Math.max(1, Math.round(beatSec / step));
      // Nearest-first within the beat, then the beats either side, so a spill is short.
      const candidates: number[] = [];
      for (let b = beatIdx; b <= beatIdx + 1; b++) {
        for (let k = 0; k < slots; k++) candidates.push(originSec + b * beatSec + k * step);
      }
      candidates.sort((a, b) => Math.abs(a - ev.rawStart) - Math.abs(b - ev.rawStart));
      for (const c of candidates) {
        if (c < 0) continue;
        if (lastLine !== null && c > lastLine + EPS) continue;
        if (taken.has(keyOf(c))) continue;
        pos = c;
        break;
      }
    }
    // Every line this take can express is occupied — refuse the incremental road rather than
    // stacking two events on one position, and let the full allocator subdivide properly.
    if (pos === null) return null;
    taken.add(keyOf(pos));
    const stepSec = cell;
    for (const m of ev.members) {
      const n = notes[m];
      // ITS OWN LENGTH, quantized on its own step, floored at one step. Identical to the release
      // pass of the full allocator, and with no cap of any kind — see §"the next-attack cap".
      const endSec = pos + Math.max(stepSec, Math.round((n.endSec - n.startSec) / stepSec) * stepSec);
      out[m] = restate(n, pos, boundEnd(endSec, pos, takeDurationSec), tempoBpm);
    }
  }

  for (let i = 0; i < out.length; i++) if (!out[i]) return null;
  out.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  return out;
}

/**
 * The derived placements a derivation produced, in the shape the NEXT one needs to freeze them.
 *
 * `raw` and `derived` are the same take before and after the snap, in the caller's own order; they
 * are matched by id, which is the only thing that survives a re-derivation.
 */
export function placementsOf(
  raw: ReadonlyArray<InputNote>,
  derived: ReadonlyArray<InputNote>,
  stepSec: number
): Map<string, FrozenPlacement> {
  const rawById = new Map<string, InputNote>();
  for (const n of raw) if (n.id) rawById.set(n.id, n);
  const out = new Map<string, FrozenPlacement>();
  for (const d of derived) {
    if (!d.id) continue;
    const r = rawById.get(d.id);
    if (!r) continue;
    out.set(d.id, {
      startSec: d.startSec,
      endSec: d.endSec,
      stepSec,
      rawStartSec: r.startSec,
      rawEndSec: r.endSec
    });
  }
  return out;
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

/** The furthest slot in a placement. Slots are non-decreasing, so this is the last one. */
function maxOf(slots: ReadonlyArray<number>): number {
  return slots.length ? slots[slots.length - 1] : 0;
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
 * 1. NEAREST BEAT — FOR THE LEADER OF A CLUSTER, and everything else is measured against it.
 *    See §"THE LEADER AND ITS FOLLOWERS" below for the whole rule; the short form is that a note
 *    played 12 ms early was aiming at the beat it is early FOR, and flooring would drag it a whole
 *    beat backwards, so the leader rounds to the closest beat.
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
 * 3. CLEAN ENDS. The note's OWN measured length is rounded to a whole number of steps, with a floor
 *    of one cell, and hung off wherever its attack landed — so nothing rings a ragged 40 ms across
 *    the next beat and the shape travels with the attack by construction. NOTHING ELSE TOUCHES IT.
 *    There is no cap at the next attack: a note's duration belongs to the note, and no attack at
 *    another pitch may cut it (see §"the next-attack cap, and why it is gone" at the release pass).
 *
 * MEASURED FROM THE RAW TAKE, ALWAYS, and nothing is mutated — the same contract grid mode
 * keeps, which is what makes Off/Grid/Beat/Off return the recording to the bit.
 *
 * ======================= THE LEADER AND ITS FOLLOWERS =======================
 *
 * WHAT WAS WRONG WITH RULE 1 ON ITS OWN. Every event ran `Math.round((raw - origin) / beatSec)`
 * INDEPENDENTLY, and the cascade could only ever rearrange events that had already claimed the
 * same beat. So a pair played a sixteenth apart across a beat midpoint — 2.01 and 2.26 against a
 * half-second pulse — was torn in half: 2.01 rounded back to 2.00, 2.26 rounded FORWARD to 2.50,
 * and an interval of 0.25 s came out as 0.50 s. Two notes, both moved by a defensible amount on
 * their own, and the RHYTHM BETWEEN THEM doubled. Nothing in the cascade could see it, because
 * the two never met in one bucket.
 *
 * THE RULE NOW: a FIXED cluster leader, and "nearest of the independent beat or a leader-relative
 * subdivision" for everything that follows it.
 *
 *   THE LEADER      the first unassigned event. It takes its own clamped nearest beat, exactly as
 *                   rule 1 always did.
 *   THE WINDOW      an event is a candidate follower only while
 *                       0 < followerRaw - leaderRaw < beatSec
 *                   measured against THE LEADER and never against the previous follower. Equality
 *                   at one whole beat starts a new cluster. That is what stops a legato chain from
 *                   growing without bound: adjacent-onset chaining refreshes the window on every
 *                   short gap and can drag a whole take, which is the suffix-wide debt rule 2
 *                   already refuses.
 *   SAME BEAT       a follower whose own nearest beat IS the leader's is left as an ordinary
 *                   collision claimant — desired offset 0 — so the cascade below reproduces
 *                   exactly what it did before for every take this rule does not touch.
 *   LATER BEAT      otherwise, candidates come off the cascade's OWN halving ladder:
 *                       step ∈ cell, cell/2, … down to `finestStepSec`
 *                       k    = max(1, round((followerRaw - leaderRaw) / step))
 *                       candidate = leaderSnappedBeat + k * step
 *                   and only candidates STRICTLY before the next beat are admissible. The nearest
 *                   admissible candidate to the raw onset is compared with the independent beat:
 *                   the relative one must be STRICTLY closer to win, the beat wins an exact tie,
 *                   and when the beat wins that event becomes the next leader — which is what
 *                   re-phases the cluster on a genuine downbeat (2.24, 2.50, 2.76 → 2.00, 2.50,
 *                   2.75 rather than a run of relative offsets from 2.24).
 *
 * MOVEMENT IS BOUNDED EXACTLY AS BEFORE. A relative candidate only wins by being strictly closer
 * to the raw onset than the independent nearest beat, and that beat is within half a pulse — so
 * no event this rule places is further from where it was played than plain rule 1 would have put
 * it. Nothing here can move a note more than the old code could.
 *
 * WHY NOT A FULL LATTICE DECODER. The notation quantizer scores every onset in an occupied beat
 * against one lattice (`pipeline/src/quantize.ts`), which is theoretically stronger — and importing
 * it here would blur Beat, Grid and the sheet's own Quantize, whose separation is the point of
 * this file.
 */
export function snapPerformanceToBeat(
  notes: ReadonlyArray<InputNote>,
  beatSec: number,
  subdivisionSec: number,
  originSec: number,
  tempoBpm: number,
  takeDurationSec?: number,
  incremental?: IncrementalSnap
): InputNote[] {
  if (!(beatSec > 0) || notes.length === 0) return notes as InputNote[];
  if (incremental) {
    const held = snapIncrementally(
      notes, beatSec, subdivisionSec, originSec, tempoBpm, takeDurationSec, incremental
    );
    if (held) return held;
  }
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
    // `+ EPS` because the window is a MUSICAL claim about two attacks, and a take whose notes were
    // written as decimal seconds can state an exactly-20 ms gap as 0.020000000000000018. Without
    // it the float representation, not the performance, decides whether a strum is one chord.
    if (open && n.startSec - open.rawStart <= chordWindow + EPS) {
      open.members.push(i);
      continue;
    }
    events.push({ members: [i], rawStart: n.startSec });
  }

  // --- 1: LEADER-FOLLOWER classification -------------------------------------------------
  // Beats are addressed by INDEX rather than by time so that two of them can never collapse
  // onto the same second at the head of the take, which is what a bare `Math.max(0, …)` on the
  // position would do to a note played before written second 0.
  const minIdx = Math.ceil((0 - originSec) / beatSec - EPS);
  // …and the LAST beat that is still inside the recording. Rounding to the nearest beat is what
  // pushed the final attack of a take onto the downbeat after the end of the tape, where the
  // pipeline's guards drop it. `null` means no take length was supplied, and then this is exactly
  // the function it always was. See §"the end of the tape".
  const lastLine = lastLineBefore(takeDurationSec, originSec, beatSec);
  const maxIdx = lastLine === null ? Number.POSITIVE_INFINITY : Math.round((lastLine - originSec) / beatSec);
  const nearestBeatIdx = (rawStart: number): number =>
    Math.min(maxIdx, Math.max(minIdx, Math.round((rawStart - originSec) / beatSec)));

  const buckets = new Map<number, number[]>();
  /**
   * How far into its bucket's beat this event WANTS to stand, in seconds. Zero for every ordinary
   * claimant, which is what makes the allocator below reproduce the old cascade exactly.
   */
  const desiredSec = new Array<number>(events.length).fill(0);
  /**
   * The COARSEST ladder step that states this event's `desiredSec` exactly, or Infinity for an
   * ordinary claimant, which has no preference to state. The bucket's own step may never be
   * coarser than this or the offset could not be represented — it would round to a slot that is
   * not the position the classification chose, and a 3/16 preference would land on the next beat.
   */
  const desiredStep = new Array<number>(events.length).fill(Number.POSITIVE_INFINITY);

  let leader = -1;
  let leaderBeatIdx = 0;
  const openCluster = (e: number, idx: number): void => {
    leader = e;
    leaderBeatIdx = idx;
    const at = buckets.get(idx);
    if (at) at.push(e);
    else buckets.set(idx, [e]);
  };
  const joinLeader = (e: number, offsetSec: number, step: number): void => {
    desiredSec[e] = offsetSec;
    desiredStep[e] = step;
    const at = buckets.get(leaderBeatIdx);
    if (at) at.push(e);
    else buckets.set(leaderBeatIdx, [e]);
  };

  for (let e = 0; e < events.length; e++) {
    const rawStart = events[e].rawStart;
    const ownIdx = nearestBeatIdx(rawStart);
    const fromLeader = leader < 0 ? Number.POSITIVE_INFINITY : rawStart - events[leader].rawStart;
    // OUTSIDE THE WINDOW — including exactly one beat away, which starts a new cluster by rule.
    if (!(fromLeader > EPS && fromLeader < beatSec - EPS)) {
      openCluster(e, ownIdx);
      continue;
    }
    // INSIDE, AND CLAIMING THE LEADER'S OWN BEAT: an ordinary collision claimant. The cascade
    // already has the right answer for these and this rule must not change it.
    if (ownIdx === leaderBeatIdx) {
      joinLeader(e, 0, Number.POSITIVE_INFINITY);
      continue;
    }
    // INSIDE, CLAIMING A LATER BEAT: the case the independent round tore in half.
    const leaderBeatSec = originSec + leaderBeatIdx * beatSec;
    const nextBeatSec = leaderBeatSec + beatSec;
    let bestPos = 0;
    let bestStep = 0;
    let bestErr = Number.POSITIVE_INFINITY;
    for (let step = cell; step >= finest - EPS; step /= 2) {
      const k = Math.max(1, Math.round(fromLeader / step));
      const pos = leaderBeatSec + k * step;
      // STRICTLY before the next beat. A candidate ON it is that beat, and the beat is the other
      // side of the comparison below rather than a relative offset from somewhere else.
      if (!(pos < nextBeatSec - EPS)) continue;
      const err = Math.abs(pos - rawStart);
      // Later position wins an exact tie; a finer step landing on a position a coarser one already
      // reached does not replace it, so the bucket keeps the coarsest lattice that can say this.
      if (err < bestErr - EPS || (Math.abs(err - bestErr) <= EPS && pos > bestPos + EPS)) {
        bestPos = pos;
        bestStep = step;
        bestErr = err;
      }
    }
    const beatErr = Math.abs(originSec + ownIdx * beatSec - rawStart);
    // THE BEAT WINS AN EXACT TIE, and winning makes this event the next leader — the re-phase.
    if (bestErr < beatErr - EPS) joinLeader(e, bestPos - leaderBeatSec, bestStep);
    else openCluster(e, ownIdx);
  }

  // --- 2: each beat subdivides itself until its own notes fit ----------------------------
  const positions = new Array<number>(notes.length);
  const stepOf = new Array<number>(notes.length);
  const anchorOf = new Array<number>(notes.length);
  const indices = [...buckets.keys()].sort((a, b) => a - b);
  const lastIdx = indices[indices.length - 1];
  let spilled: number[] = [];
  /**
   * The slot each event of `here` ends up in at a given step.
   *
   * DESIRED FIRST, THEN SEPARATION: `max(desiredSlot, previousActualSlot + 1)` — an event asks for
   * the slot its classification chose and is pushed one further only when the event before it is
   * already standing there. With every desire at 0 this degenerates to 0, 1, 2 … which IS the old
   * cascade, so the legacy path is reproduced algebraically rather than by a special case.
   */
  const slotsAt = (here: ReadonlyArray<number>, step: number): number[] => {
    const out: number[] = [];
    let prev = -1;
    for (const e of here) {
      const want = Math.round(desiredSec[e] / step);
      const actual = Math.max(want, prev + 1);
      out.push(actual);
      prev = actual;
    }
    return out;
  };
  // EVERY beat from the first occupied one onward, not only the occupied ones: a spill goes to
  // the beat AFTER the one that was full, and an empty beat is exactly where it should land.
  // The furthest position handed out so far, so a group the end of the take pushes backwards can
  // never be placed on top of the beat before it.
  let lastPos = Number.NEGATIVE_INFINITY;
  for (let idx = indices[0]; idx <= lastIdx || spilled.length; idx++) {
    const own = buckets.get(idx);
    const here = spilled.length ? [...spilled, ...(own ?? [])] : (own ?? []);
    // A SPILLED EVENT LOSES ITS PREFERENCE. Its offset was stated against a beat it is no longer
    // standing on, so carrying it here would place it by arithmetic that no longer means anything.
    // Count, ordering and separation outrank relative spacing — that is what spilling IS.
    for (const e of spilled) {
      desiredSec[e] = 0;
      desiredStep[e] = Number.POSITIVE_INFINITY;
    }
    spilled = [];
    if (!here.length) continue;
    const beatStart = originSec + idx * beatSec;
    // HOW MUCH OF THIS BEAT IS ACTUALLY THERE. A whole beat for every one of them except the
    // last, which is as long as whatever is left of the recording — a take does not politely end
    // on a downbeat, and a cascade laid out across a beat that is half past the end of the tape
    // puts its own notes where the pipeline's guards will drop them.
    const room =
      lastLine === null ? beatSec : Math.min(beatSec, Math.max(0, (takeDurationSec as number) - END_EPS - beatStart));
    // HALVE THE RULER'S CELL UNTIL THEY FIT. The LAST SLOT ACTUALLY HANDED OUT has to stand
    // strictly inside the room this beat has — the actual slot rather than `count - 1`, because a
    // follower's desired offset can be further out than its position in the queue.
    //
    // …AND NEVER COARSER THAN A PREFERENCE IN THE BUCKET. A 3/16 offset cannot be stated on a
    // quarter lattice; rounding it there would put the follower on the next beat, which is the
    // exact tear this rule exists to close.
    let step = cell;
    for (const e of here) if (desiredStep[e] < step) step = desiredStep[e];
    while (maxOf(slotsAt(here, step)) * step >= room - EPS && step / 2 >= finest - EPS) step /= 2;
    // THE LAST BEAT HAS NOWHERE TO HAND ANYTHING TO — the beat after it is off the end of the
    // recording — so it takes the one step the halving loop cannot reach. Halving is right while
    // spilling is available: it keeps the cascade on lines that are multiples of the ruler's own
    // cell. It is also why a TRIPLET ruler gets stuck at exactly the wrong place, since half a
    // triplet cell is finer than `finestStepSec` allows and the loop therefore refuses to move at
    // all; four events then "fit" a beat that holds three, and the fourth is placed at the top of
    // the next beat, which is the end of the tape. Dropping straight to the finest step the sheet
    // can read back is the answer the whole cascade is already built on.
    const atLastBeat = idx >= maxIdx;
    if (atLastBeat && maxOf(slotsAt(here, step)) * step >= room - EPS && finest < step) step = finest;
    // How many the beat can hold at the step it settled on. Anything standing past that is handed
    // to the next beat, which will subdivide for them in turn — and it is the SLOT that decides,
    // not the count, because a preferred hole means the two are no longer the same number.
    const capacity = Math.max(1, Math.floor((room - EPS) / step) + 1);
    const slots = slotsAt(here, step);
    let placed = here.length;
    if (!atLastBeat) {
      for (let j = 0; j < here.length; j++) {
        if (slots[j] >= capacity) {
          // Never hand the whole beat on: it would arrive at the next one no less crowded, and a
          // beat that places nothing cannot advance `lastPos` either.
          placed = Math.max(1, j);
          break;
        }
      }
      if (placed < here.length) spilled = here.slice(placed);
    }
    // WHERE THE GROUP STARTS. The beat itself, unless its last member would then stand past the
    // end of the take — in which case the whole group keeps its step and its order and moves back
    // just far enough to fit. Notes arriving a little early is a picture of the performance being
    // slightly wrong at the very end of the tape; notes past the end are a picture with a hole in
    // it, because `applyGuards` deletes them.
    //
    // BACK BY WHOLE STEPS, which is the difference between this working and looking like it does.
    // Moving back by the exact overshoot puts the group on a lattice of its own — positions like
    // 15.999999 — and the pipeline then QUANTIZES that onto the nearest line it can print, which
    // is 16.0, which is past the last bar, which drops the note this whole clause exists to save.
    // A whole step back keeps every position on the beat's own lattice, where the quantizer finds
    // them already where it would have put them.
    let base = beatStart;
    const overshoot = slots[placed - 1] * step - room;
    if (overshoot > 0) base = Math.max(0, beatStart - Math.ceil(overshoot / step) * step);
    // Separation wins over the end bound in the one case where they disagree — a take that ends a
    // few milliseconds into a crowded beat. Two events on one position are ONE event to the
    // engraver, so that trade loses a note as surely as running off the end does, and this way
    // the overshoot is at most one step.
    if (base <= lastPos) base = lastPos + step;
    for (let j = 0; j < placed; j++) {
      const pos = base + slots[j] * step;
      lastPos = pos;
      for (const m of events[here[j]].members) {
        positions[m] = pos;
        stepOf[m] = step;
        // The lattice the note is ACTUALLY standing on, which is `beatStart` in every case but
        // the pulled-back last beat. Releases round onto it (step 3), and rounding them onto a
        // lattice the attacks are not on would put an end between two starts.
        anchorOf[m] = base;
      }
    }
  }

  // --- 3: where each release lands ------------------------------------------------------
  const out = new Array<InputNote>(notes.length);
  for (let k = 0; k < order.length; k++) {
    const { n, i } = order[k];
    const startSec = positions[i];
    const step = stepOf[i];
    /*
     * THE RELEASE FOLLOWS THE ATTACK IT BELONGS TO (conviction C1).
     *
     * THE LENGTH IS QUANTIZED, NOT THE RELEASE. This line used to round the raw END onto the
     * beat's lattice as an ABSOLUTE — `anchor + round((rawEnd - anchor) / step) * step` — while
     * the attack was placed by the allocator. The two answers are independent, so anything that
     * moved a note's ATTACK without moving its raw release took the difference out of the note's
     * length: an event the separation rule pushed one slot along lost exactly one step, and a
     * note standing one step from its neighbour was flattened to a stub. Measured, at
     * `anchored-matrix.json` cell 52: an untouched neighbour went from 4.1727-4.4455 to
     * 4.3091-4.4455 — its onset a step later, its duration halved — with its RECORDING untouched
     * on both sides. Nobody edited that note. Rounding the note's own DURATION and hanging it off
     * wherever the attack landed makes the shape travel with the attack by construction, which is
     * the only formulation under which no re-placement can reshape anything.
     *
     * THE ENDS STAY ON THE LATTICE. `startSec` is `base + slot * step` and the duration is a whole
     * number of steps, so a release is still a lattice line — the property the old absolute
     * rounding existed for is kept, and kept for the beat the note is actually standing on rather
     * than for the one its raw release happened to fall in.
     *
     * AND IT IS A PROJECTION. Snapping this function's own output at the same ruler must not move
     * anything, which the absolute form got for free and a translation does not: a duration that
     * is already a whole number of steps rounds to itself, so the second pass reproduces the
     * first exactly.
     *
     * That is the purity distinction this file has to keep. An allocator decides where a note
     * stands, not how long it is held. Exactly TWO things may change a derived length: this
     * quantization of the note's OWN measured length, and the end of the tape (`boundEnd`).
     *
     * ================= THE NEXT-ATTACK CAP, AND WHY IT IS GONE =================
     *
     * There used to be a third. After this line, a loop walked forward to the first later attack
     * AT ANY PITCH and clamped the release to it, guarded by "only where the take itself did not
     * hold them together". Quoting the claim it was kept under, from this file's own §3:
     *
     *   "CLEAN ENDS. The release goes to the nearest subdivision line with a floor of one cell, so
     *    nothing rings a ragged 40 ms across the next beat. It is then capped at the next attack —
     *    but ONLY where the recording did not already hold the two together, so a bass note
     *    sustained under a melody keeps sustaining and a snapped end cannot invent an overlap the
     *    player never played."
     *
     * …and from the rig, law (a2), which codified the consequence as a permitted cost:
     *
     *   "A note the cap was holding short goes back to its own recorded length the moment the
     *    attack that was crowding it moves away… the note is not reshaped by an allocator, it is
     *    stopped by the note after it."
     *
     * BOTH ARE REVOKED. The reasoning is a MONOPHONIC BASS assumption — one note ends when the
     * next begins — and it was living inside a polyphonic editor, where the "next attack" is
     * routinely a different string on a different row. It does not invent an overlap the player
     * never played; it DELETES a sustain the player did play, because a note's quantized end
     * legitimately runs a little past its recorded end, and any new attack landing in that
     * overshoot cut the old note back to it. Measured on the owner's own gesture: adding a note at
     * a LATER time and a DIFFERENT pitch took 20–50% off an untouched note's painted length, and a
     * sweep of midi 21–100 against a midi-40 note found ALL EIGHTY pitches cutting it. The rule
     * could not see pitch at all.
     *
     * A note's duration belongs to the note. Nothing at another pitch may cut it. Where two notes
     * genuinely overlap, the roll paints them overlapping, which is what a piano roll is for; the
     * single-voice merge the ENGRAVING needs is the engraving's business and lives in the pipeline
     * (`chords.ts` §noOverlap, `simplify.ts`), where a staff really can only carry one note per
     * voice at a time.
     */
    const endSec = startSec + Math.max(step, Math.round((n.endSec - n.startSec) / step) * step);
    out[k] = restate(n, startSec, boundEnd(endSec, startSec, takeDurationSec), tempoBpm);
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
