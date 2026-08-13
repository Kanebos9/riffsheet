/**
 * SYMBOLIC PLACEMENT — what a MusicXML / MIDI / Guitar Pro source already decided.
 *
 * A detected note has a time and nothing else; the pipeline has to infer what it MEANT. A
 * symbolic note arrives with the answer already written down, in the source's own ticks, and the
 * pipeline's only remaining job is to say it in the IR's tick domain without breaking it.
 *
 * THE BUG THIS MODULE EXISTS FOR (finding 1). The exact path converted ticks and stopped there:
 * it produced no tuplet groups at all, because `quantizeExact` returns `tuplets: []`. A legal
 * eighth-note triplet at PPQ 480 is 160 source ticks — exactly 8 IR ticks, so the CONVERSION was
 * perfect — but with no group to belong to, `buildBars` handed those 8 ticks to the straight
 * metric splitter, which can only spell them as 6 + 2 and typed the remainder `32nd`. A 32nd is
 * 3 ticks. MusicXML's type-vs-duration assertion then threw and the import produced no score at
 * all. The triplet was never lost in the arithmetic; it was lost because nobody said it WAS one.
 *
 * So the groups are reconstructed here, from the written positions themselves. Every boundary in
 * a beat — onsets and off-times alike, since a rest between two triplet members is in the triplet
 * domain just as much as the members are — is tested against three lattices in order:
 *
 *   STRAIGHT     multiples of a 1/32. The overwhelming majority of written music, and the only
 *                answer that needs no tuplet at all.
 *   TRIPLET      multiples of a third of the beat  -> <actual>3</actual><normal>2</normal>
 *   SEXTUPLET    multiples of a sixth of the beat  -> <actual>6</actual><normal>4</normal>
 *
 * THE PRINTABLE FLOOR, stated honestly. A beat that fits none of the three contains something
 * the IR cannot say: at 24 divisions per quarter the shortest representable value is a 1/32
 * (3 ticks), so a written 64th is 1.5 ticks and simply has no glyph. Those beats are snapped
 * onto the 1/32 lattice and COUNTED, and the count reaches the caller as a diagnostic. What must
 * never happen — and what used to — is a 2-tick span wearing a `32nd` label, which is a file no
 * reader can unpick and an assertion failure in the one exporter that checked.
 */

import { DIVISIONS, THIRTYSECOND_TICKS } from './ir.js';
import type { QuantResult, QuantTupletGroup } from './quantize.js';

/** One written event: the source's own ticks, at the source's own resolution. */
export interface SymbolicEvent {
  id: string;
  startTick: number;
  endTick: number;
  ppq: number;
}

export interface SymbolicPlacement extends QuantResult {
  /** Beats whose written positions were finer than a 1/32 and were snapped onto it. */
  reducedBeats: number;
  /**
   * ATTACKS THAT LANDED ON A SLOT ANOTHER ATTACK ALREADY HELD, and were therefore absorbed into
   * it. Only the printable floor above can cause this — two events written a 64th apart have one
   * 1/32 slot between them — and it is the one place a written note leaves no glyph at all, so it
   * is counted and surfaced rather than left to be discovered by comparing note counts.
   */
  fusedAttacks: number;
  /** Tuplet groups reconstructed from the source's own positions. */
  tuplets: QuantTupletGroup[];
}

/** Whole-number test that survives the float division a non-power-of-two ppq produces. */
function divides(value: number, unit: number): boolean {
  if (!(unit > 0)) return false;
  const q = value / unit;
  return Math.abs(q - Math.round(q)) < 1e-9;
}

/**
 * Place written events on the IR lattice, reconstructing the tuplet groups they imply.
 *
 * Returns null when the events do not share one resolution, which is the only case this cannot
 * reason about; the caller then falls back to plain conversion.
 */
export function placeSymbolicEvents(
  events: readonly SymbolicEvent[],
  ticksPerBeat: number,
  compound: boolean
): SymbolicPlacement | null {
  if (!events.length) return null;
  const ppq = events[0].ppq;
  if (!(ppq > 0) || events.some((event) => event.ppq !== ppq)) return null;

  const toIr = DIVISIONS / ppq;
  // The tracked beat in SOURCE ticks. Everything below is reasoned about in the source's domain,
  // where the numbers are the ones the score editor actually wrote.
  const beatSrc = ticksPerBeat / toIr;
  const thirtySecondSrc = ppq / 8;
  // A tuplet unit has to be a whole number of IR ticks or it cannot be written at all: a third
  // of a 24-tick beat is 8, a sixth is 4. In a compound meter the beat is already a dotted value
  // whose natural divisions are 3 and 6 — those are its ordinary subdivisions, not tuplets.
  const candidates = compound
    ? []
    : ([3, 6] as const).filter((d) => Number.isInteger(ticksPerBeat / d));

  const beatOf = (tick: number): number => Math.floor(tick / beatSrc + 1e-9);

  // Boundaries per beat: an event contributes its onset to the beat it starts in and its
  // off-time to the beat that off-time falls in (or closes, when it lands on a barline).
  const boundaries = new Map<number, number[]>();
  const push = (beat: number, offset: number): void => {
    const list = boundaries.get(beat) ?? [];
    list.push(offset);
    boundaries.set(beat, list);
  };
  for (const event of events) {
    const start = beatOf(event.startTick);
    push(start, event.startTick - start * beatSrc);
    const end = Math.max(event.startTick + 1, event.endTick);
    const endBeat = divides(end, beatSrc) ? beatOf(end) - 1 : beatOf(end);
    push(endBeat, end - endBeat * beatSrc);
    // An event spanning whole beats leaves those beats' interiors untouched, which is correct:
    // nothing inside them is a boundary, so they are free to decode as straight.
  }

  const tuplets: QuantTupletGroup[] = [];
  const tupletByBeat = new Map<number, QuantTupletGroup>();
  const snappedBeats = new Set<number>();
  for (const [beat, offsets] of boundaries) {
    if (offsets.every((offset) => divides(offset, thirtySecondSrc))) continue;
    const divisor = candidates.find((d) => offsets.every((offset) => divides(offset, beatSrc / d)));
    if (divisor === undefined) {
      snappedBeats.add(beat);
      continue;
    }
    const group: QuantTupletGroup = {
      id: `sym-${beat}`,
      startTick: Math.round(beat * ticksPerBeat),
      endTick: Math.round((beat + 1) * ticksPerBeat),
      unitTicks: ticksPerBeat / divisor,
      actual: divisor,
      // MusicXML <normal-notes>: the largest power of two strictly below the actual count.
      normal: divisor === 3 ? 2 : 4
    };
    tuplets.push(group);
    tupletByBeat.set(beat, group);
  }

  /** Written source tick -> IR tick, on whatever lattice that beat decoded to. */
  const place = (tick: number, closing: boolean): number => {
    const beat = closing && divides(tick, beatSrc) ? beatOf(tick) - 1 : beatOf(tick);
    if (snappedBeats.has(beat)) {
      // The printable floor. Snapping in the IR domain keeps the result an integer tick by
      // construction, whatever the source resolution was.
      return Math.round((tick * toIr) / THIRTYSECOND_TICKS) * THIRTYSECOND_TICKS;
    }
    return Math.round(tick * toIr);
  };

  const placed = events
    .map((event) => {
      const startTick = place(event.startTick, false);
      const offTick = Math.max(startTick + 1, place(Math.max(event.startTick + 1, event.endTick), true));
      const group = tupletByBeat.get(beatOf(event.startTick));
      return {
        id: event.id,
        startTick,
        offTick,
        ...(group && startTick >= group.startTick && startTick < group.endTick ? { tupletId: group.id } : {})
      };
    })
    .sort((a, b) => a.startTick - b.startTick);

  // Two events on the same written tick are one attack group; the bar cursor downstream cannot
  // hold two. (Chord grouping upstream has already merged everything genuinely simultaneous, so
  // this only fires when the printable floor pulled two neighbours onto one slot.)
  const fused: QuantResult['notes'] = [];
  let fusedAttacks = 0;
  /** The absorbed events, named. Here the first arrival always keeps the slot, so this is exact
   * inside the loop — unlike the quantizer, nothing re-picks the winner afterwards. */
  const fusedInto: QuantResult['fused'] = [];
  for (const note of placed) {
    const previous = fused[fused.length - 1];
    if (previous && previous.startTick === note.startTick) {
      previous.offTick = Math.max(previous.offTick, note.offTick);
      fusedAttacks++;
      fusedInto.push({ id: note.id, intoId: previous.id });
      continue;
    }
    fused.push(note);
  }

  return {
    notes: fused,
    tuplets: tuplets.filter((group) => fused.some((note) => note.tupletId === group.id)),
    basicQuantTicks: 1,
    jitterTicks: 0,
    reducedBeats: snappedBeats.size,
    fusedAttacks,
    fused: fusedInto
  };
}
