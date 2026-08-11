/**
 * BEAM GROUPING, TUPLET BRACKETING, AND THE PER-STAFF PROJECTION THEY BOTH DEPEND ON.
 *
 * These three used to live in three places: `applyBeams` in buildScore.ts, the tuplet start/stop
 * marker pass inlined in `buildBars`, and a `projectedBeats` helper in musicxml.ts that did the
 * grand-staff split. That arrangement shipped a malformed file.
 *
 * THE BUG IT SHIPPED. A grand staff is built as ONE merged single-voice rhythm and only then
 * split by `IRNote.staffIndex`. Beam states (`begin`/`continue`/`end`) and tuplet edges
 * (`start`/`stop`) are computed over that merged rhythm — but they are properties of ONE STAFF'S
 * sequence, not of the merge. Split a beamed group or a triplet across the middle-C boundary and
 * the treble staff inherits a `<beam>continue` whose `begin` went to the bass staff, or a
 * `<tuplet type="stop"/>` whose `start` did. Both are malformed MusicXML: readers either drop
 * the group or throw.
 *
 * THE RULE. Project first, then compute. `projectStaffBeats` returns a staff's own copy of the
 * bar — notes that belong elsewhere removed, the beats they emptied turned into rests — with
 * beams and tuplet edges recomputed over THAT sequence and nothing inherited from the merge. The
 * copies are deep enough that the two staves (and the IR itself) can never share a mutable
 * `beams` array or `tuplet` record.
 */

import type { BeamState, DurationType, IRBar, IRBeat, IRNote } from './ir.js';

const BEAM_LEVEL: Partial<Record<DurationType, number>> = { eighth: 1, '16th': 2, '32nd': 3 };

/**
 * §3.6: beam grouping is "which partition of the beam MeterSequence does this note's offset
 * fall into". Since v1 supports {4/4, 3/4, 2/4} plus overrides, the partition collapses to one
 * group per beat. THE RULE READERS ACTUALLY RELY ON: never beam across a beat boundary in 4/4.
 * A rest, a quarter-or-longer value, a boundary straddle, or a tuplet-group change all break an
 * open group; singletons keep their flag.
 *
 * IT DOES NOT ADD TO WHAT IS ALREADY THERE. Every beat is cleared first, so running this a
 * second time over a projected copy of a bar replaces the merged rhythm's states instead of
 * layering a second set of beams on top of them.
 */
export function applyBeams(beats: IRBeat[], boundaries: number[]): void {
  for (const b of beats) delete b.beams;

  const windowOf = (b: IRBeat): number => {
    for (let w = 0; w + 1 < boundaries.length; w++) {
      if (b.startTick >= boundaries[w] && b.startTick + b.durTicks <= boundaries[w + 1]) return w;
    }
    return -1;
  };
  let group: IRBeat[] = [];
  let groupWindow = -1;
  let groupTuplet: string | undefined;

  const flush = (): void => {
    if (group.length >= 2) {
      group.forEach((b, i) => {
        const state: BeamState = i === 0 ? 'begin' : i === group.length - 1 ? 'end' : 'continue';
        b.beams = [state];
      });
      for (let lvl = 2; lvl <= 3; lvl++) {
        let runStart = -1;
        for (let i = 0; i <= group.length; i++) {
          const has = i < group.length && (BEAM_LEVEL[group[i].durationType] ?? 0) >= lvl;
          if (has && runStart < 0) runStart = i;
          if (!has && runStart >= 0) {
            if (i - runStart === 1) {
              const hook: BeamState = runStart === 0 ? 'forward hook' : 'backward hook';
              group[runStart].beams!.push(hook);
            } else {
              for (let k = runStart; k < i; k++) {
                const state: BeamState = k === runStart ? 'begin' : k === i - 1 ? 'end' : 'continue';
                group[k].beams!.push(state);
              }
            }
            runStart = -1;
          }
        }
      }
    }
    group = [];
    groupWindow = -1;
    groupTuplet = undefined;
  };

  for (const b of beats) {
    const level = b.isRest ? 0 : BEAM_LEVEL[b.durationType] ?? 0;
    if (level < 1) {
      flush();
      continue;
    }
    const w = windowOf(b);
    if (w < 0) {
      flush();
      continue;
    }
    if (group.length && (w !== groupWindow || b.tuplet?.id !== groupTuplet)) flush();
    if (!group.length) {
      groupWindow = w;
      groupTuplet = b.tuplet?.id;
    }
    group.push(b);
  }
  flush();
}

/**
 * The bracket edges of every tuplet group present in `beats`: first member starts it, last member
 * stops it. Rest members count — a tuplet that begins or ends with a rest still needs its bracket
 * to span it, and a bracket that opens on a note it does not own is how the balance assertion
 * fails.
 *
 * Like `applyBeams`, this CLEARS before it marks, so it is safe on a projected copy.
 */
export function markTupletEdges(beats: IRBeat[]): void {
  const groups = new Map<string, IRBeat[]>();
  for (const b of beats) {
    if (!b.tuplet) continue;
    b.tuplet.start = false;
    b.tuplet.stop = false;
    const g = groups.get(b.tuplet.id) ?? [];
    g.push(b);
    groups.set(b.tuplet.id, g);
  }
  for (const group of groups.values()) {
    group[0].tuplet!.start = true;
    group[group.length - 1].tuplet!.stop = true;
  }
}

/**
 * ONE STAFF'S VIEW of a merged single-voice bar, ready to emit.
 *
 * `include` says which notes this staff prints (the grand-staff split, decided once in the IR by
 * `clef.ts grandStaffSplitter` and read here). A beat whose notes all belong to the other staff
 * becomes a REST, so both staves keep the full rhythm of the bar and the measure cursor lands on
 * the barline on each of them.
 *
 * Everything downstream of the split is then recomputed for this staff alone — see the module
 * header for why inheriting it from the merge is a malformed file rather than a cosmetic flaw.
 * The returned beats share no mutable state with the input: `notes` is a new array, `tuplet` a
 * new record, `beams` freshly built.
 */
export function projectStaffBeats(beats: IRBeat[], bar: IRBar, include: (note: IRNote) => boolean): IRBeat[] {
  const projected = beats.map((beat): IRBeat => {
    const notes = beat.notes.filter(include);
    const copy: IRBeat = { ...beat, notes };
    delete copy.beams;
    // A shared tuplet record would let one staff's bracket edges overwrite the other's.
    if (beat.tuplet) copy.tuplet = { ...beat.tuplet, start: false, stop: false };
    // The beat is still there, and still as long: only its noteheads moved to the other staff.
    if (!beat.isRest && notes.length === 0) copy.isRest = true;
    return copy;
  });
  markTupletEdges(projected);
  applyBeams(projected, bar.beamBoundaries);
  return projected;
}
