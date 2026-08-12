/**
 * STATION 4 — CHORDS AND VOICES.
 *
 * ORDERING IS LOAD-BEARING. midi-semantics-research.md §4.1 calls this "the single most
 * load-bearing structural fact in this document": chord grouping runs BEFORE quantization.
 * Group second and two near-simultaneous notes that straddle a grid line snap apart into two
 * chords a 32nd apart instead of one double-stop, and nothing downstream can undo it.
 *
 * WINDOW. §4.2 gives MuseScore's "quickthresh": a 1/64-whole-note window (human coefficient
 * x2 on `minAllowedDuration`), widened by half a window whenever a note lands in the last
 * quarter of the current one — so a strum keeps extending and stays one chord. §4.3b then
 * notes the two literatures disagree (MuseScore: note fraction, MIR: absolute ms) and rules
 * `max(35 ms, 1/64 whole note)`. That is what is implemented.
 *
 * VOICES. v1 keeps a single voice (bass riffs), per the brief. Double-stops become chords.
 * The overlap clamp is `noOverlap`: a note ringing into the next attack is truncated there
 * (Kilian & Hoos state the same resolution outright — "such overlaps are ultimately eliminated
 * by shortening the duration of the earlier note").
 *
 * WRITTEN from the documented constants.
 */

import type { InputNote } from './types.js';
import { CHORD_WINDOW_FRACTION } from './rational.js';
import { isSymbolic } from './guards.js';

/** §4.3b: absolute floor for human motor slop; a strum is ~35 ms wide at any tempo. */
export const CHORD_WINDOW_MIN_SEC = 0.035;

export interface ChordEvent {
  onsetSec: number;
  /** Longest member's end; individual members keep their own endSec. */
  endSec: number;
  notes: InputNote[];
}

/**
 * The chord window in seconds at a given beat period: max(35 ms, 1/64 whole note).
 * One whole note = 4 beats at the tracked pulse, so 1/64 whole = beatPeriod/16.
 */
export function chordWindowSec(beatPeriodSec: number): number {
  const fraction = beatPeriodSec * 4 * CHORD_WINDOW_FRACTION.toNumber();
  return Math.max(CHORD_WINDOW_MIN_SEC, fraction);
}

/**
 * Group near-simultaneous onsets into chords with MuseScore's adaptive fudge extension:
 * any note arriving in the last quarter of the current window pushes the window out by
 * another half-window.
 */
/**
 * Written position in QUARTER notes, for a note that carries one. Exact for every ppq that is a
 * power of two (480, 960 and every other value a score editor emits), so two notes written on the
 * same beat compare equal even when their sources declared different resolutions.
 */
function writtenQuarters(note: InputNote): number | null {
  const timing = note.sourceTiming;
  return timing && timing.ppq > 0 ? timing.startTick / timing.ppq : null;
}

/**
 * Group near-simultaneous onsets into chords with MuseScore's adaptive fudge extension:
 * any note arriving in the last quarter of the current window pushes the window out by
 * another half-window.
 *
 * THE WINDOW IS A MODEL OF A HUMAN HAND, so it applies to a performance and to nothing else. A
 * symbolic source already stated which notes are simultaneous, exactly, in written ticks; asking
 * "did these arrive within 35 ms of each other" of a written score answers a question nobody
 * posed and answers it wrongly at speed — at 140 BPM a written 64th is 27 ms, so consecutive
 * 64ths fell inside one window and were fused into a chord that the source does not contain.
 * A symbolic event therefore admits exactly the notes written on its own tick.
 */
export function collectChords(notes: InputNote[], beatPeriodSec: number): ChordEvent[] {
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  const base = chordWindowSec(beatPeriodSec);
  const out: ChordEvent[] = [];

  let i = 0;
  while (i < sorted.length) {
    const first = sorted[i];
    const exact = isSymbolic(first) ? writtenQuarters(first) : null;
    let window = base;
    const members: InputNote[] = [first];
    let j = i + 1;
    while (j < sorted.length) {
      if (exact !== null) {
        // Written simultaneity, not motor slop: same tick or a different event.
        if (!isSymbolic(sorted[j]) || writtenQuarters(sorted[j]) !== exact) break;
        members.push(sorted[j]);
        j++;
        continue;
      }
      const delta = sorted[j].startSec - first.startSec;
      if (delta > window) break;
      members.push(sorted[j]);
      // fudge zone = last quarter of the window
      if (delta > window - base / 4) window += base / 2;
      j++;
    }
    // A chord may not contain the same pitch twice — a duplicate is a detector artefact, and on
    // a symbolic source it is a unison across voices that one editable voice cannot print.
    const seen = new Set<number>();
    const unique = members.filter((m) => (seen.has(m.midi) ? false : (seen.add(m.midi), true)));
    let endSec = -Infinity;
    for (const m of unique) if (m.endSec > endSec) endSec = m.endSec;
    out.push({
      onsetSec: first.startSec,
      endSec,
      notes: unique.sort((a, b) => a.midi - b.midi)
    });
    i = j;
  }
  return out;
}

/**
 * `noOverlap`: a ring-out is truncated at the next attack. Runs in the SECONDS domain, before
 * quantization, so a detector overlap never reaches the page as invented polyphony.
 * A member whose truncated length would fall below `minSec` keeps `minSec` — the note existed,
 * the detector just overlapped it, and it is written at whatever length survives.
 */
export function clampOverlaps(events: ChordEvent[], minSec = 0.02): ChordEvent[] {
  const out = events.map((e) => ({ ...e, notes: e.notes.map((n) => ({ ...n })) }));
  for (let i = 0; i + 1 < out.length; i++) {
    const limit = out[i + 1].onsetSec;
    for (const n of out[i].notes) {
      if (n.endSec > limit) n.endSec = Math.max(n.startSec + minSec, limit);
    }
    let longest = -Infinity;
    for (const n of out[i].notes) if (n.endSec > longest) longest = n.endSec;
    out[i].endSec = longest;
  }
  return out;
}
