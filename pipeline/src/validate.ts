/**
 * IR VALIDATION — the invariants, checked once, where the IR is produced.
 *
 * They used to be checked in ONE EXPORTER. `assertTypeMatchesDuration` lives in musicxml.ts and
 * is the reason a broken tuplet showed up as "the MusicXML export throws" rather than as "this
 * score is not engravable": the same IR went to the screen renderer and to the MIDI writer
 * without complaint, so the app displayed a bar it could not export and the user found out at
 * save time. Worse, an IR that violated the invariant only crashed if you exported — the bug in
 * finding 1 was reported as "MusicXML export throws" when what had actually happened was that a
 * legal eighth-note triplet had been turned into a 16th and a two-tick 32nd several stations
 * earlier.
 *
 * So the checks belong here, at the boundary, and `buildScore` runs them before returning. The
 * arithmetic is deliberately identical to the emitter's — this is the same statement, made
 * earlier, not a second opinion.
 *
 * WHAT IS CHECKED, and each one is a rule some real defect broke:
 *   1. TYPE vs DURATION. `type x dots x normal/actual` must equal `durTicks` exactly.
 *   2. MEASURE LENGTH. Every voice must fill its bar exactly — no more, no less.
 *   3. TUPLET BALANCE. Every run of beats in one tuplet group opens with `start` and closes with
 *      `stop`, and the members agree on their actual/normal pair.
 *   4. TIE TERMINATION. No tie may start with nothing to tie to.
 */

import type { DurationType, IRBeat, RiffsheetIR } from './ir.js';

const TYPE_DENOMINATOR: Record<DurationType, number> = {
  whole: 1,
  half: 2,
  quarter: 4,
  eighth: 8,
  '16th': 16,
  '32nd': 32
};

/** Written ticks a glyph claims, or null when the claim is not a whole number of ticks. */
export function writtenTicks(beat: IRBeat, divisions: number): number | null {
  const denominator = TYPE_DENOMINATOR[beat.durationType];
  if (!denominator) return null;
  // A dotted value is `(2^(d+1) - 1) / 2^d` of the plain one: 1, 3/2, 7/4.
  const numerator = divisions * 4 * ((1 << (beat.dots + 1)) - 1) * (beat.tuplet ? beat.tuplet.normal : 1);
  const divisor = denominator * (1 << beat.dots) * (beat.tuplet ? beat.tuplet.actual : 1);
  return numerator % divisor === 0 ? numerator / divisor : null;
}

/**
 * Every way this IR is not engravable, in reading order. Empty means the score is sound.
 * Returned rather than thrown so a caller can decide (`buildScore` throws; a tool might report).
 */
export function validateIR(ir: RiffsheetIR): string[] {
  const problems: string[] = [];
  const divisions = ir.divisions;

  for (const bar of ir.bars) {
    for (const voice of bar.voices) {
      let filled = 0;
      for (const beat of voice.beats) {
        filled += beat.durTicks;
        if (beat.durTicks <= 0) {
          problems.push(`bar ${bar.number} voice ${voice.id}: a glyph of ${beat.durTicks} ticks`);
        }
        // A measure rest deliberately carries no printed type; it is exempt by construction.
        if (beat.measureRest) continue;
        const written = writtenTicks(beat, divisions);
        if (written === null || written !== beat.durTicks) {
          problems.push(
            `bar ${bar.number} voice ${voice.id}: <type>${beat.durationType}</type>${'<dot/>'.repeat(beat.dots)}` +
              `${beat.tuplet ? ` x ${beat.tuplet.normal}/${beat.tuplet.actual}` : ''} is ` +
              `${written === null ? 'not a whole number of ticks' : `${written} ticks`} but the glyph lasts ${beat.durTicks}`
          );
        }
      }
      if (filled !== bar.durTicks) {
        problems.push(
          `bar ${bar.number} voice ${voice.id}: the glyphs add up to ${filled} ticks, the bar is ${bar.durTicks}`
        );
      }

      // ---- tuplet balance, per run ---------------------------------------------------------
      let runId: string | null = null;
      let runStart = 0;
      const closeRun = (endExclusive: number): void => {
        if (runId === null) return;
        const first = voice.beats[runStart];
        const last = voice.beats[endExclusive - 1];
        if (!first.tuplet?.start) {
          problems.push(`bar ${bar.number}: tuplet ${runId} does not open with a start marker`);
        }
        if (!last.tuplet?.stop) {
          problems.push(`bar ${bar.number}: tuplet ${runId} does not close with a stop marker`);
        }
        for (let i = runStart; i < endExclusive; i++) {
          const t = voice.beats[i].tuplet!;
          if (t.actual !== first.tuplet!.actual || t.normal !== first.tuplet!.normal) {
            problems.push(
              `bar ${bar.number}: tuplet ${runId} members disagree — ${first.tuplet!.actual}/${first.tuplet!.normal} vs ${t.actual}/${t.normal}`
            );
          }
        }
        runId = null;
      };
      voice.beats.forEach((beat, index) => {
        const id = beat.tuplet?.id ?? null;
        if (id === runId) return;
        closeRun(index);
        if (id !== null) {
          runId = id;
          runStart = index;
        }
      });
      closeRun(voice.beats.length);
    }
  }

  // ---- ties have somewhere to land -----------------------------------------------------------
  const lastBar = ir.bars[ir.bars.length - 1];
  for (const voice of lastBar?.voices ?? []) {
    const lastBeat = voice.beats[voice.beats.length - 1];
    for (const note of lastBeat?.notes ?? []) {
      if (note.tieStart) {
        problems.push(`bar ${lastBar.number}: note ${note.id} starts a tie at the end of the score`);
      }
    }
  }

  return problems;
}
