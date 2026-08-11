/**
 * STATION 2b — OVERLAP CLAMP.
 *
 * THIS FILE USED TO BE "THE REST KILLER". It is not any more, and the deletion is the point.
 *
 * The old station was a port of MuseScore 4 `Simplify::lengthenNote` /
 * `Simplify::minimizeNumberOfRests` (`importmidi_simplify.cpp`): a glyph-count search that
 * pushed every note's off-time forward until swallowing the following silence printed fewer
 * symbols than writing a rest. It worked — rest density fell from 26.8% to 0.49% — and it was
 * still the wrong product. Riffsheet transcribes a PERFORMANCE. A note that sounded for 60% of
 * its slot and was printed at 100% with a staccato dot is not a tidier transcription of what was
 * played; it is a different rhythm with a dot apologising for it. Two consequences the user hit
 * directly:
 *
 *   1. STACCATO BECAME A LIE. The dot was emitted precisely BECAUSE the note had been stretched,
 *      so the page said "play this long, but short" about material that was simply short.
 *   2. FABRICATED SUSTAIN. Lengthening ran per note against the next onset, so dense material
 *      came back with long notes that overlapped their neighbours' attacks — polyphony that was
 *      never played, invented by the engraver.
 *
 * So the lengthening pass, its adaptive `quantForLen` off-time grid, its sub-eighth gap absorber
 * and the staccato inference that hung off them are all deleted, not disabled. Gaps that were
 * played are printed. `BuildSettings.fillGaps` survives as an accepted-and-ignored field for
 * compatibility only (see types.ts); there is no code path left for it to switch on.
 *
 * WHAT REMAINS, and why each piece is not the filler coming back:
 *
 *   - the OVERLAP CLAMP, below. Snapping an off-time to the tick lattice can round it past the
 *     next onset. One voice cannot hold two notes at once, so the earlier note is cut back to
 *     the next attack. That SHORTENS notes; it can never lengthen one.
 *   - `snapLeadingOnset`. Moves a sub-eighth lead-in at the very start of the score onto the
 *     barline, because it is an attack-time artefact with nothing to its left. It moves an
 *     ONSET and never touches a duration.
 *
 * midi-to-notation-research.md §1.2/§1.3/§1.5 describe the deleted pass; they are kept in
 * ATTRIBUTIONS.md as provenance for the code that used to be here.
 */

import { MIN_REST } from './rational.js';

export interface SimplifyEvent {
  startTick: number;
  offTick: number;
  /** Tuplet group id, when the onset decoder put this event inside one. */
  tupletId?: string;
}

export interface SimplifyResult {
  offTick: number;
}

/**
 * Events must be sorted by `startTick` and belong to one voice. Returns one result per event,
 * in the same order, with each off-time clamped into `(startTick, nextStartTick]`.
 *
 * A zero- or negative-length event is given exactly one tick rather than being dropped: the
 * caller pairs results positionally, and a note that survived the guards has to reach the page.
 */
export function clampEventOverlaps(events: SimplifyEvent[]): SimplifyResult[] {
  const results: SimplifyResult[] = events.map((e) => ({ offTick: e.offTick }));
  for (let i = 0; i < events.length; i++) {
    const nextStart = i + 1 < events.length ? events[i + 1].startTick : Infinity;
    if (results[i].offTick > nextStart) results[i].offTick = nextStart;
    if (results[i].offTick <= events[i].startTick) results[i].offTick = events[i].startTick + 1;
  }
  return results;
}

/**
 * The one gap nothing else can reach: a sub-eighth silence before the FIRST note, which has no
 * earlier material and no bar to sit in. It is an attack-time artefact, so the onset moves to
 * the bar start rather than printing a sixteenth rest in front of the piece. Returns the
 * corrected start tick.
 */
export function snapLeadingOnset(firstStartTick: number, barStartTick: number, divisions: number): number {
  const minRestTicks = MIN_REST.toTicksExact(divisions);
  const lead = firstStartTick - barStartTick;
  return lead > 0 && lead < minRestTicks ? barStartTick : firstStartTick;
}
