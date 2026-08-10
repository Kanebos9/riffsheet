/**
 * STATION 2b — THE REST KILLER.
 *
 * PORTED (re-implemented in TypeScript from documented behaviour and constants of)
 * MuseScore 4 `importmidi_simplify.cpp` — `Simplify::lengthenNote` and
 * `Simplify::minimizeNumberOfRests` — plus `quantForLen`/`reduceQuantIfDottedNote` from
 * `importmidi_quant.cpp`. GPL-3.0-only. midi-to-notation-research.md §1.2, §1.3, §1.5, §3.1.
 *
 * THE DESIGN POINT: rests are never removed, they are PREVENTED. Off-times are pushed forward
 * before any rest object exists. By the time anything constructs a rest, the gaps are gone.
 *
 * THE HEURISTIC HAS NO THRESHOLD. Try every off-time from the current one up to `endTime` in
 * steps of the note's own quant; keep the one that minimises (note glyphs + rest glyphs), where
 * a dotted value counts 1.5. A gap is absorbed exactly when swallowing it prints fewer glyphs
 * than writing it. That answers "is the page more readable with or without this rest?" directly
 * instead of proxying it with a gap ratio.
 *
 * HUMAN MODE IS PERMANENT (§3.1 rule 5). Riffsheet's input is always a performance, so both
 * machine-mode brakes are off: the `noteDurationCount <= 1.5` restriction that forbids
 * extending into a tie chain, and the `hasLossOfAccuracy` veto that refuses to absorb when only
 * one glyph is saved. MuseScore's own detector would classify our input as human anyway.
 */

import { Rational, MIN_REST } from './rational.js';
import { durationCount, nextBeatAfter, toDurationList, type BarMetric } from './meter.js';

/** `Simplify::lengthenNote`: >= 30% invented padding means the note really was short. */
export const STACCATO_TOL = 0.3;
/**
 * Sibelius's published Flexi-time / MIDI-import threshold: notate staccato when the note sounds
 * for less than 35% of its value. §5.1 says to prefer this over MuseScore's effective 70%,
 * because MuseScore's is "deliberately loose because it is trading against rest count, and its
 * forums are full of spurious-staccato complaints". Measured against the INTER-ONSET INTERVAL,
 * which is available before quantization and is robust to quantization error.
 */
export const STACCATO_SOUNDING_RATIO = 0.35;

export interface SimplifyBar {
  startTick: number;
  ticks: number;
  metric: BarMetric;
}

export interface SimplifyEvent {
  startTick: number;
  offTick: number;
  tupletId?: string;
  /**
   * sounding seconds / inter-onset seconds, measured BEFORE quantization. Used only by the
   * staccato gate. Omit and staccato falls back to MuseScore's padding test alone.
   */
  soundingRatio?: number;
}

export interface SimplifyTuplet {
  startTick: number;
  endTick: number;
  unitTicks: number;
}

export interface SimplifyResult {
  offTick: number;
  staccato: boolean;
  /** Ticks of silence this note swallowed. */
  absorbedTicks: number;
}

export interface SimplifyOptions {
  divisions: number;
  bars: SimplifyBar[];
  /** MuseScore `basicQuant`, in ticks. Default is a 16th (`PREF_IO_MIDI_SHORTESTNOTE`). */
  basicQuantTicks: number;
  compound: boolean;
  tuplets: Map<string, SimplifyTuplet>;
  /** false -> the raw pass: measured off-times survive and every gap becomes a rest. */
  fillGaps: boolean;
  showStaccato: boolean;
}

const SIMPLE_LADDER = [12, 6, 3, 1];
const COMPOUND_LADDER = [18, 6, 3, 1];

/**
 * `quantForLen` + `reduceQuantIfDottedNote`. The grid adapts PER NOTE: halve `basicQuant`
 * while it exceeds the note length, then halve once more when `len/quant` lands in the dotted
 * neighbourhood (1.45, 1.55).
 */
export function quantForLen(lenTicks: number, basicQuantTicks: number, compound = false): number {
  const full = compound ? COMPOUND_LADDER : SIMPLE_LADDER;
  const ladder = full.filter((v) => v <= basicQuantTicks);
  if (!ladder.length) return 1;
  let i = 0;
  while (ladder[i] > lenTicks && i < ladder.length - 1) i++;
  const ratio = lenTicks / ladder[i];
  if (ratio > 1.45 && ratio < 1.55 && i < ladder.length - 1) i++;
  return ladder[i];
}

function barIndexFor(bars: SimplifyBar[], tick: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  if (tick <= bars[0].startTick) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].startTick <= tick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * `Simplify::minimizeNumberOfRests`. Events must be sorted by `startTick` and belong to one
 * voice. Returns one result per event, in the same order.
 */
export function minimizeNumberOfRests(
  events: SimplifyEvent[],
  opts: SimplifyOptions
): SimplifyResult[] {
  const results: SimplifyResult[] = events.map((e) => ({
    offTick: e.offTick,
    staccato: false,
    absorbedTicks: 0
  }));
  if (!events.length) return results;

  const { bars, divisions, tuplets } = opts;
  const minRestTicks = MIN_REST.toTicksExact(divisions);

  // ---- pass 1: clamp overlaps that survived quantization rounding -------------------------
  for (let i = 0; i < events.length; i++) {
    const nextStart = i + 1 < events.length ? events[i + 1].startTick : Infinity;
    if (results[i].offTick > nextStart) results[i].offTick = nextStart;
    if (results[i].offTick <= events[i].startTick) results[i].offTick = events[i].startTick + 1;
  }

  if (!opts.fillGaps) return results;

  // ---- pass 2: the glyph-count search, per note -------------------------------------------
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const bi = barIndexFor(bars, e.startTick);
    const bar = bars[bi];
    const barEndTick = bar.startTick + bar.ticks;
    const nextOnset = i + 1 < events.length ? events[i + 1].startTick : barEndTick;
    const off = results[i].offTick;

    // A note inside a tuplet is handled by the tuplet rule below, never by the metric search
    // (a duration may never silently cross a tuplet edge).
    if (e.tupletId) {
      const grp = tuplets.get(e.tupletId);
      const limit = Math.min(nextOnset, grp ? grp.endTick : nextOnset, barEndTick);
      if (off < limit) {
        results[i].absorbedTicks = limit - off;
        results[i].offTick = limit;
        const written = limit - e.startTick;
        if (
          opts.showStaccato &&
          written > 0 &&
          results[i].absorbedTicks / written >= STACCATO_TOL &&
          soundingGate(e)
        ) {
          results[i].staccato = true;
        }
      }
      continue;
    }

    const startR = Rational.fromTicks(e.startTick - bar.startTick, divisions);
    const offR = Rational.fromTicks(off - bar.startTick, divisions);

    // endTime, clamped by the four rules in order: bar end; tuplet boundary; the next beat
    // boundary; the next chord onset in the same voice.
    const nextBeatTick =
      bar.startTick + nextBeatAfter(bar.metric, offR).toTicksExact(divisions);
    const endTime = Math.min(nextOnset, nextBeatTick, barEndTick);
    // The rest that would follow runs to the next onset (or the bar end).
    const gapEndTick = Math.min(nextOnset, barEndTick);

    const noteLen = off - e.startTick;
    const quant = quantForLen(noteLen, opts.basicQuantTicks, opts.compound);

    const countAt = (t: number): { total: number; noteCount: number } => {
      const noteLenR = Rational.fromTicks(t - e.startTick, divisions);
      const nd = durationCount(toDurationList(bar.metric, startR, noteLenR, 'note'));
      const gap = gapEndTick - t;
      const rd =
        gap > 0
          ? durationCount(
              toDurationList(
                bar.metric,
                Rational.fromTicks(t - bar.startTick, divisions),
                Rational.fromTicks(gap, divisions),
                'rest'
              )
            )
          : 0;
      return { total: nd + rd, noteCount: nd };
    };

    let best = off;
    let bestStats = countAt(off);
    for (let t = off + quant; t <= endTime; t += quant) {
      const stats = countAt(t);
      // HUMAN MODE: no `noteDurationCount <= 1.5` restriction, so a tie chain is allowed.
      if (stats.total < bestStats.total) {
        bestStats = stats;
        best = t;
      }
    }

    const added = best - off;
    results[i].offTick = best;
    results[i].absorbedTicks = added;

    // Staccato: the fraction of the FINAL WRITTEN duration that is invented padding.
    // Guards copied verbatim in intent: never on a note tied in from earlier
    // (`noteOnTime == durationStart`), never on a tied chain (`minNoteDurationCount <= 1.5`).
    const writtenLen = best - e.startTick;
    if (
      opts.showStaccato &&
      writtenLen > 0 &&
      added / writtenLen >= STACCATO_TOL &&
      bestStats.noteCount <= 1.5 &&
      soundingGate(e)
    ) {
      results[i].staccato = true;
    }
    void offR;
  }

  // ---- pass 3: the vocabulary cap ---------------------------------------------------------
  // "Never print a rest shorter than an eighth" (§3.1 rule 4). This pass is allowed to cross a
  // barline, which the glyph-count search deliberately is not: absorbing a sixteenth of silence
  // into the previous note (as a tie) is what a human transcriber writes, and FiloBass's 274
  // human rests contain zero sixteenths.
  for (let i = 0; i < events.length; i++) {
    const gapEnd = i + 1 < events.length ? events[i + 1].startTick : lastBarEnd(bars);
    const gap = gapEnd - results[i].offTick;
    if (gap > 0 && gap < minRestTicks) {
      results[i].absorbedTicks += gap;
      results[i].offTick = gapEnd;
    }
  }
  return results;
}

/** Sibelius's gate. Absent evidence, fall through to MuseScore's padding test alone. */
function soundingGate(e: SimplifyEvent): boolean {
  return e.soundingRatio === undefined || e.soundingRatio < STACCATO_SOUNDING_RATIO;
}

function lastBarEnd(bars: SimplifyBar[]): number {
  const last = bars[bars.length - 1];
  return last.startTick + last.ticks;
}

/**
 * The one gap the lengthening pass cannot reach: a sub-eighth silence before the FIRST note,
 * which has nothing to its left to absorb it. It is an attack-time artefact, so the onset moves
 * to the bar start rather than printing a sixteenth rest. Returns the corrected start tick.
 */
export function snapLeadingOnset(firstStartTick: number, barStartTick: number, divisions: number): number {
  const minRestTicks = MIN_REST.toTicksExact(divisions);
  const lead = firstStartTick - barStartTick;
  return lead > 0 && lead < minRestTicks ? barStartTick : firstStartTick;
}
