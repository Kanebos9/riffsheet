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
  /**
   * MEMBERS THE GROUP ADMITTED AND THEN COULD NOT PRINT — the same-pitch dedup below, named.
   *
   * `notes` is what reaches the page; this is what the LAW admitted. The two differ by exactly
   * the duplicate pitches, and the difference used to be invisible: a note simply stopped
   * existing between the roll and the sheet with nothing anywhere saying it had been absorbed
   * rather than deleted. `ofId` is the member whose notehead now speaks for it.
   */
  duplicates: { id: string; ofId: string }[];
  /** The window this group was decided with, widenings included. 0 on a written-tick group. */
  windowSec: number;
  /** Which law decided the group. See the two branches in `collectChords`. */
  law: 'performance-window' | 'written-tick';
}

/**
 * The chord window in seconds at a given beat period: max(35 ms, 1/64 whole note).
 * One whole note = 4 beats at the tracked pulse, so 1/64 whole = beatPeriod/16.
 *
 * THIS IS THE BASE WINDOW, NOT THE EFFECTIVE ONE, and a caller that treats the two as
 * interchangeable will disagree with the page. Two things happen to it below:
 *
 *   it WIDENS.  Every arrival in the last quarter of the current window pushes the window out by
 *               half a base window again, with no ceiling. A rolled chord can therefore span
 *               several times this number and still be one chord.
 *   it VANISHES. A symbolic source is grouped by written tick and never consults a window at all.
 *
 * And the law is a GREEDY PARTITION measured from each group's FIRST note, which is not a
 * property any threshold can encode. The claim that grouping on the floor "can merge fewer pairs
 * than the pipeline does but never more" — i.e. that a caller holding this constant is safely
 * stricter than the engraver — is FALSE IN BOTH DIRECTIONS, and here are the two counterexamples:
 *
 *   OVER-MERGING BY CHAINING. Onsets at 0, 34 and 68 ms with a 35 ms base. The engraver takes
 *   0 and 34 (34 > 35 - 8.75, so the window widens to 52.5), then finds 68 - 0 = 68 > 52.5 and
 *   starts a new group: TWO chords. A caller asking "is anything within 35 ms of this note" says
 *   34 and 68 are one chord. It merged a pair the page splits — the exact direction the comment
 *   claimed was impossible.
 *
 *   OVER-MERGING ON A WRITTEN SOURCE. Two imported notes 3 ms apart on different written ticks
 *   are two events here and one chord to anything holding a 35 ms threshold.
 *
 * The only correct way to ask this question is to ask the partition. Use `chordGroupsOf`, or read
 * `BuildResult.projection.chordGroups`, which is the answer the engraved page was made from.
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
    // The loser is RECORDED rather than merely filtered: it is still audible inside the winner's
    // slot, so a caller must be able to follow it there instead of concluding it was deleted.
    const firstByMidi = new Map<number, InputNote>();
    const unique: InputNote[] = [];
    const duplicates: ChordEvent['duplicates'] = [];
    for (const m of members) {
      const winner = firstByMidi.get(m.midi);
      if (winner) {
        if (m.id !== undefined && winner.id !== undefined) duplicates.push({ id: m.id, ofId: winner.id });
        continue;
      }
      firstByMidi.set(m.midi, m);
      unique.push(m);
    }
    let endSec = -Infinity;
    for (const m of unique) if (m.endSec > endSec) endSec = m.endSec;
    out.push({
      onsetSec: first.startSec,
      endSec,
      notes: unique.sort((a, b) => a.midi - b.midi),
      duplicates,
      // The window as it stood when the group closed, so the published law reports what actually
      // decided this group rather than the number it started from.
      windowSec: exact !== null ? 0 : window,
      law: exact !== null ? 'written-tick' : 'performance-window'
    });
    i = j;
  }
  return out;
}

/**
 * THE CHORD LAW, PUBLISHED — "which of these notes are one chord", answered by the engraver.
 *
 * A thin projection of `collectChords` onto ids, for a caller that has notes and a beat period
 * and needs the same partition the page was engraved from WITHOUT running a build. It is the only
 * correct way to ask the question from outside: see the warning on `chordWindowSec` for why no
 * threshold a caller holds can reproduce this, and `BuildResult.projection.chordGroups` for the
 * answer a specific build actually used.
 *
 * `ids` is low pitch first and includes duplicate-pitch members, which are in the chord as far as
 * the LAW is concerned even though only one of them gets a notehead.
 */
export function chordGroupsOf(
  notes: InputNote[],
  beatPeriodSec: number
): { ids: string[]; onsetSec: number; endSec: number; windowSec: number; law: ChordEvent['law'] }[] {
  return collectChords(notes, beatPeriodSec).map((event) => {
    const ids = event.notes.map((n) => n.id).filter((id): id is string => id !== undefined);
    for (const duplicate of event.duplicates) ids.push(duplicate.id);
    return {
      ids,
      onsetSec: event.onsetSec,
      endSec: event.endSec,
      windowSec: event.windowSec,
      law: event.law
    };
  });
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
