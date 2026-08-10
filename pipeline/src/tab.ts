/**
 * STATION 5 — TAB: legato pairs first, then string/fret assignment.
 *
 * THE ORDERING IS THE WHOLE POINT. midi-semantics-research.md §5.5 calls it "the single most
 * important sentence in this section":
 *
 *   > Detect legato candidate pairs from the MIDI FIRST, feed them as soft constraints into the
 *   > string-assignment path solver, then read HO/PO off the resulting same-string pairs.
 *
 * A pure lowest-fret assigner scatters an ascending legato run across strings and destroys
 * every hammer-on candidate before you get to look for one. None of the published algorithms
 * do this, which is exactly why none of them infers HO/PO. v1 emits NO hammer-on/pull-off
 * symbols — it just doesn't destroy them, and records the surviving pairs in the IR.
 *
 * THE ASSIGNER. §5.4 reports the finding that should temper ambition: on easy material the
 * naive lowest-fret baseline scores 98.30% and a published A* implementation scores 89.39% —
 * sophistication is not automatically an improvement, and Guitar Pro 8 loses to lowest-fret on
 * all three benchmark datasets. We ship the DAG shortest path anyway, for the reason the
 * research gives: it is ~40 lines, O(n) for a monophonic bass (at most 4-6 candidate positions
 * per pitch), and it is the only place a technique constraint can be expressed. With
 * `fingeringStyle: 'low'` its node costs dominate and it reproduces the baseline; with
 * 'minMovement' the edge costs dominate and it plays in position.
 *
 * WRITTEN, from the cost-function sketch in §5.4-5.5.
 */

import type { FingeringStyle } from './types.js';

/** §5.5: legato means no re-pluck — a gap under ~10 ms, or an actual overlap. */
export const LEGATO_GAP_SEC = 0.01;
/** §5.5: a hand-span reach. Wider on one string is more likely a slide. */
export const LEGATO_MAX_INTERVAL = 5;
const DEFAULT_MAX_FRET = 24;
/** Simultaneity window for the assigner's slots — the chord grouper's absolute floor. */
const SLOT_WINDOW_SEC = 0.035;

export interface TabNoteInput {
  id: string;
  midi: number;
  startSec: number;
  endSec: number;
  /** Honoured verbatim: the user pinned this string in the IR. */
  stringOverride?: number;
}

export interface LegatoPair {
  fromId: string;
  toId: string;
  kind: 'hammer' | 'pull';
}

export interface TabPosition {
  /** IR/alphaTab numbering: 1 = the LOWEST (fattest) string (§8.1). */
  string: number;
  fret: number;
}

export interface TabAssignment {
  id: string;
  position?: TabPosition;
  unplayable: boolean;
  /**
   * Semitones the TAB position was shifted by to bring an out-of-range pitch onto the
   * fretboard (always a whole number of octaves). The notation staff keeps the true sounding
   * pitch; only the fret number moved. 0 or absent means the position is exact.
   */
  tabOctaveShift?: number;
}

/**
 * §8.1, THE STRING-NUMBERING TRAP — and there are now THREE numbering systems in play, two of
 * which run in opposite directions. Every conversion lives in this block and nowhere else,
 * because getting one wrong produces a tab that looks plausible and is vertically mirrored.
 *
 *   IR / alphaTab       string 1 = the LOWEST (fattest) string.   <- what RiffsheetIR carries
 *   MusicXML <string>   string 1 = the HIGHEST pitched string.    <- flipped on the way out
 *   <staff-tuning line> line 1   = the LOWEST pitch (bottom line).
 *
 * The IR follows alphaTab because the renderer is the closest consumer (webcore/IR.md), so
 * `irString === staffTuningLine === tuningIndex + 1` and only the MusicXML emitter flips.
 */

/** IR/alphaTab string number from an index into the low-to-high tuning array. */
export function irStringFromTuningIndex(tuningIndex: number): number {
  return tuningIndex + 1;
}
export function tuningIndexFromIrString(irString: number): number {
  return irString - 1;
}
/** MusicXML `<string>` from an IR string number: `string = (numStrings + 1) - line`. */
export function musicXmlStringFromIrString(irString: number, stringCount: number): number {
  return stringCount + 1 - irString;
}
export function irStringFromMusicXmlString(xmlString: number, stringCount: number): number {
  return stringCount + 1 - xmlString;
}
/** `<staff-tuning line>` counts from the bottom, which is the IR's own numbering. */
export function staffTuningLineFromIrString(irString: number): number {
  return irString;
}

/** Legato-pair detection. Runs BEFORE assignment; pairs become soft constraints below. */
export function detectLegatoPairs(notes: TabNoteInput[]): LegatoPair[] {
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec);
  const out: LegatoPair[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const gap = b.startSec - a.endSec;
    if (gap > LEGATO_GAP_SEC) continue;
    const interval = Math.abs(b.midi - a.midi);
    if (interval === 0 || interval > LEGATO_MAX_INTERVAL) continue;
    out.push({ fromId: a.id, toId: b.id, kind: b.midi > a.midi ? 'hammer' : 'pull' });
  }
  return out;
}

interface Candidate {
  string: number;
  fret: number;
  tuningIndex: number;
}

function candidatesFor(midi: number, tuningMidi: number[], capo: number, maxFret = DEFAULT_MAX_FRET): Candidate[] {
  const out: Candidate[] = [];
  const count = tuningMidi.length;
  for (let i = 0; i < count; i++) {
    const fret = midi - tuningMidi[i];
    if (fret < capo || fret > maxFret) continue;
    out.push({ string: irStringFromTuningIndex(i), fret, tuningIndex: i });
  }
  // lowest fret first, so ties in the DP resolve toward the baseline behaviour
  return out.sort((a, b) => a.fret - b.fret || b.string - a.string);
}

/**
 * GRACEFUL DEGRADATION FOR AN OUT-OF-RANGE PITCH — the documented rule.
 *
 * A transcribed pitch below the lowest open string (or above the last fret) has no position on
 * this instrument. Two things are unacceptable: printing nothing, which leaves a hole in the tab
 * for every such note, and printing the nearest fret, which tells the player the wrong pitch.
 *
 * The rule is to shift the TAB position by whole OCTAVES until it lands on the fretboard, and to
 * record the shift. This is what a player does with a low D on a four-string, and what
 * publishers print. The interval shape of the line is preserved, the notation staff still shows
 * the true sounding pitch, and `tabOctaveShift` lets the UI mark it.
 *
 * Upward first (out-of-range on a bass is almost always below the low string), nearest octave
 * first, and never more than two octaves.
 */
function candidatesWithOctaveFold(
  midi: number,
  tuningMidi: number[],
  capo: number,
  maxFret: number
): { candidates: Candidate[]; shift: number } {
  const exact = candidatesFor(midi, tuningMidi, capo, maxFret);
  if (exact.length) return { candidates: exact, shift: 0 };
  for (const shift of [12, -12, 24, -24]) {
    const folded = candidatesFor(midi + shift, tuningMidi, capo, maxFret);
    if (folded.length) return { candidates: folded, shift };
  }
  return { candidates: [], shift: 0 };
}

interface StyleWeights {
  fretCost: number;
  highFretPenalty: number;
  openBonus: number;
  moveCost: number;
  stringChangeCost: number;
}

const WEIGHTS: Record<FingeringStyle, StyleWeights> = {
  // Node costs dominate: this reproduces the lowest-fret baseline that scores 98.30% on easy
  // material, while still leaving room for the legato discount to break ties.
  low: { fretCost: 1.0, highFretPenalty: 5, openBonus: 0.5, moveCost: 0.1, stringChangeCost: 0.1 },
  // Edge costs dominate: the hand stays in position.
  minMovement: { fretCost: 0.05, highFretPenalty: 5, openBonus: 0.2, moveCost: 1.0, stringChangeCost: 0.6 }
};

/** §5.5: the discount that keeps a detected legato pair on one string. */
const LEGATO_DISCOUNT = 3;

export interface AssignOptions {
  tuningMidi: number[];
  fingeringStyle: FingeringStyle;
  capo?: number;
  /** Highest fret the assigner may use. Default 24. */
  maxFret?: number;
  legatoPairs?: LegatoPair[];
}

/**
 * DAG shortest path over candidate (string, fret) positions. Monophonic path; chord members are
 * placed greedily around the path note (nearest free string, span <= 5 frets).
 *
 * THE BUG THIS FUNCTION USED TO HAVE, recorded because it was subtle and expensive:
 * a single pitch with no fretboard position (a transcribed D#1 on a bass whose lowest string is
 * E1) left one lattice slot empty. The Viterbi seeds only slot 0, so once a slot had no nodes
 * every later slot stayed at Infinity, the backtrack found no finite endpoint, and EVERY note in
 * the score came back unplaced — 63 of 92 on the integration clip, with the surviving 29 being
 * only the chord members, which are placed greedily and bypass the path. One unplayable note
 * silently destroyed the whole tab.
 *
 * Two independent defences now:
 *   1. SEGMENTATION — an empty slot ends a segment and the next non-empty slot starts a fresh
 *      one, seeded again. A hole can never propagate past itself.
 *   2. OCTAVE FOLD — an out-of-range pitch is given a real position an octave away rather than
 *      no position at all, so in practice slots are almost never empty in the first place.
 */
export function assignStrings(notes: TabNoteInput[], opts: AssignOptions): TabAssignment[] {
  const capo = opts.capo ?? 0;
  const maxFret = opts.maxFret ?? DEFAULT_MAX_FRET;
  const count = opts.tuningMidi.length;
  const w = WEIGHTS[opts.fingeringStyle];
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);

  // Simultaneity grouping for reachability. The window matches the chord grouper's absolute
  // floor, so the assigner sees the same double-stops the rest of the pipeline does; exact
  // equality used to split a strummed octave into two slots.
  const slots: TabNoteInput[][] = [];
  for (const n of sorted) {
    const last = slots[slots.length - 1];
    if (last && Math.abs(last[0].startSec - n.startSec) <= SLOT_WINDOW_SEC) last.push(n);
    else slots.push([n]);
  }

  const legatoNext = new Map<string, LegatoPair>();
  for (const p of opts.legatoPairs ?? []) legatoNext.set(p.fromId, p);

  // Lattice over slots, keyed by the LEAD note (the lowest-pitched member, which carries a bass
  // line). A pinned string from an IR edit collapses the slot to that one candidate.
  const shifts: number[] = [];
  const lattice: Candidate[][] = slots.map((slot) => {
    const lead = slot[0];
    if (lead.stringOverride !== undefined) {
      const ti = tuningIndexFromIrString(lead.stringOverride);
      if (ti >= 0 && ti < count) {
        const fret = lead.midi - opts.tuningMidi[ti];
        if (fret >= capo && fret <= maxFret) {
          shifts.push(0);
          return [{ string: lead.stringOverride, fret, tuningIndex: ti }];
        }
      }
    }
    const { candidates, shift } = candidatesWithOctaveFold(lead.midi, opts.tuningMidi, capo, maxFret);
    shifts.push(shift);
    return candidates;
  });

  const nodeCost = (c: Candidate): number =>
    c.fret * w.fretCost + (c.fret > 12 ? w.highFretPenalty : 0) - (c.fret === 0 ? w.openBonus : 0);

  const edgeCost = (a: Candidate, b: Candidate, fromId: string, toId: string): number => {
    let cost = Math.abs(a.fret - b.fret) * w.moveCost;
    if (a.string !== b.string) cost += w.stringChangeCost * Math.abs(a.string - b.string);
    const pair = legatoNext.get(fromId);
    if (pair && pair.toId === toId && a.string === b.string && Math.abs(a.fret - b.fret) <= 5) {
      cost -= LEGATO_DISCOUNT;
    }
    return cost;
  };

  const chosen: number[] = new Array(lattice.length).fill(-1);

  // ---- solve each segment of consecutive placeable slots independently ------------------------
  const solveSegment = (from: number, to: number): void => {
    const cost: number[][] = [];
    const back: number[][] = [];
    for (let i = from; i <= to; i++) {
      cost.push(lattice[i].map(() => Infinity));
      back.push(lattice[i].map(() => -1));
    }
    for (let j = 0; j < lattice[from].length; j++) cost[0][j] = nodeCost(lattice[from][j]);
    for (let i = from + 1; i <= to; i++) {
      const r = i - from;
      for (let j = 0; j < lattice[i].length; j++) {
        const local = nodeCost(lattice[i][j]);
        for (let k = 0; k < lattice[i - 1].length; k++) {
          if (cost[r - 1][k] === Infinity) continue;
          const c =
            cost[r - 1][k] + local + edgeCost(lattice[i - 1][k], lattice[i][j], slots[i - 1][0].id, slots[i][0].id);
          if (c < cost[r][j]) {
            cost[r][j] = c;
            back[r][j] = k;
          }
        }
      }
    }
    let best = -1;
    let bestCost = Infinity;
    const lastRow = to - from;
    for (let j = 0; j < lattice[to].length; j++) {
      if (cost[lastRow][j] < bestCost) {
        bestCost = cost[lastRow][j];
        best = j;
      }
    }
    // Belt and braces: a segment is non-empty by construction, so this cannot fire — but if it
    // ever did, degrade to the cheapest node per slot rather than to no position at all.
    if (best < 0) {
      for (let i = from; i <= to; i++) chosen[i] = lattice[i].length ? 0 : -1;
      return;
    }
    for (let i = to; i >= from; i--) {
      chosen[i] = best;
      const r = i - from;
      best = best >= 0 ? back[r][best] : -1;
      if (best < 0 && i > from) best = 0; // segment boundary reached early; keep a valid node
    }
  };

  let i = 0;
  while (i < lattice.length) {
    if (!lattice[i].length) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < lattice.length && lattice[j + 1].length) j++;
    solveSegment(i, j);
    i = j + 1;
  }

  // ---- write out, placing chord members around each path note ---------------------------------
  const out = new Map<string, TabAssignment>();
  slots.forEach((slot, si) => {
    const leadCandidate = chosen[si] >= 0 ? lattice[si][chosen[si]] : undefined;
    const used = new Set<number>();
    const lead = slot[0];
    if (leadCandidate) {
      used.add(leadCandidate.string);
      out.set(lead.id, {
        id: lead.id,
        position: { string: leadCandidate.string, fret: leadCandidate.fret },
        unplayable: false,
        ...(shifts[si] ? { tabOctaveShift: shifts[si] } : {})
      });
    } else {
      out.set(lead.id, { id: lead.id, unplayable: true });
    }
    for (let m = 1; m < slot.length; m++) {
      const n = slot[m];
      // Folding a member onto a pitch another member already occupies would print a bogus
      // unison in the tab, so that one stays unplaced rather than lying.
      const occupied = slot.some((other, oi) => oi !== m && other.midi === n.midi);
      const { candidates, shift } = occupied
        ? { candidates: candidatesFor(n.midi, opts.tuningMidi, capo, maxFret), shift: 0 }
        : candidatesWithOctaveFold(n.midi, opts.tuningMidi, capo, maxFret);
      const free = candidates.filter((c) => !used.has(c.string));
      let pick: Candidate | undefined;
      if (leadCandidate) {
        const reachable = free.filter((c) => Math.abs(c.fret - leadCandidate.fret) <= 5);
        pick = reachable[0] ?? free[0];
      } else {
        pick = free[0];
      }
      if (pick) {
        used.add(pick.string);
        out.set(n.id, {
          id: n.id,
          position: { string: pick.string, fret: pick.fret },
          unplayable: false,
          ...(shift ? { tabOctaveShift: shift } : {})
        });
      } else {
        out.set(n.id, { id: n.id, unplayable: true });
      }
    }
  });

  return notes.map((n) => out.get(n.id) ?? { id: n.id, unplayable: true });
}

/** The regression baseline §5.3 (E.3) demands we keep measuring the DP against. */
export function assignStringsLowestFret(notes: TabNoteInput[], tuningMidi: number[], capo = 0, maxFret = DEFAULT_MAX_FRET): TabAssignment[] {
  return notes.map((n) => {
    const c = candidatesFor(n.midi, tuningMidi, capo, maxFret)[0];
    return c ? { id: n.id, position: { string: c.string, fret: c.fret }, unplayable: false } : { id: n.id, unplayable: true };
  });
}

/**
 * Read hammer-ons/pull-offs off the assignment. v1 does not print them; the IR records them so
 * a later version can, without re-deriving anything.
 */
export function survivingLegato(
  pairs: LegatoPair[],
  assignments: TabAssignment[]
): LegatoPair[] {
  const byId = new Map(assignments.map((a) => [a.id, a]));
  return pairs.filter((p) => {
    const a = byId.get(p.fromId)?.position;
    const b = byId.get(p.toId)?.position;
    return !!a && !!b && a.string === b.string && Math.abs(a.fret - b.fret) <= LEGATO_MAX_INTERVAL;
  });
}
