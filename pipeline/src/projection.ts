/**
 * STATION 9 — THE PROJECTION, and it is the only total statement the pipeline makes.
 *
 * Every other station reports in COUNTS: `pastEndDropped: 3`, `fusedAttacks: 1`,
 * `flattenedVoices: 2`. A count tells a caller that something was lost and refuses to say what,
 * which is exactly the shape of the correspondence fault the sheet/roll seam was built on: the
 * roll draws every performed rectangle, the sheet draws whatever survived engraving, and nothing
 * anywhere could answer "where did THIS note go". A note that vanished and a note that was
 * absorbed into its neighbour look identical from outside — both are simply absent — and the
 * editor guessed, wrongly, that absent meant deleted.
 *
 * THE CONTRACT IS TOTALITY. For every id in the build's input, `Projection.byId` holds exactly
 * one outcome, and the three outcomes are exhaustive and mutually exclusive:
 *
 *   engraved  it reached the page. `glyphs` lists EVERY glyph it became — a tie split across a
 *             barline is several, and they are listed in printed order, so a caller that wants
 *             "the notehead for note X" gets all of them rather than the first.
 *   merged    it is still on the page, inside another note's slot. `mergedInto` names the input
 *             id whose glyph now speaks for it. A caller must follow the pointer, not delete.
 *   dropped   it is not on the page at all, and `reason` says which rule removed it.
 *
 * `counts.engraved + counts.merged + counts.dropped === counts.input`, always. That equation is
 * the whole point and it is asserted in the property test rather than merely intended: the
 * assembly below ENDS with a sweep over the input ids that assigns `unengraved` to anything no
 * station claimed, so a future loss point added upstream cannot re-open the silent door. It
 * shows up as an honest `unengraved` count instead.
 *
 * WRITTEN for Riffsheet. Neither research doc has an equivalent — upstream engravers own their
 * input and never have to answer to a second view of the same notes.
 */

import type { IRNote, RiffsheetIR } from './ir.js';

/**
 * WHERE ONE GLYPH IS. Enough to find the notehead again without re-walking the IR, and enough to
 * tell two pieces of one tied span apart.
 */
export interface GlyphRef {
  /** Index into `ir.bars`. */
  bar: number;
  /** `IRVoice.id` — 1 or 2, NOT an index into `voices`. */
  voice: number;
  /** Index into that voice's `beats`. */
  beat: number;
  /** Index into that beat's `notes`. */
  note: number;
  /** Absolute tick of this glyph's start (bar start + beat start). */
  startTick: number;
  /** This glyph's printed length in ticks. A tie split's pieces sum to the written value. */
  durTicks: number;
  tieStart: boolean;
  tieStop: boolean;
}

/**
 * WHY A NOTE IS SPEAKING THROUGH ANOTHER NOTE'S GLYPH. Each value names one site in the pipeline
 * and nothing else, so a caller can key behaviour off it.
 */
export type MergeReason =
  /**
   * `chords.ts`: the chord admitted two notes of the same pitch. One notehead cannot be printed
   * twice, so the later arrival was absorbed into the earlier. On a detected take this is a
   * detector artefact; on a symbolic one it is a unison across voices that one editable voice
   * cannot hold.
   */
  | 'chord-duplicate-pitch'
  /**
   * `quantize.ts`: two separate chord events landed on the same grid tick. A slot sounds one
   * thing, so the event with the most duration-weighted evidence keeps it and the other's
   * members point at the winner.
   */
  | 'quantize-collision'
  /**
   * `symbolic.ts`: two written events landed on one printable slot after the 1/32 floor. Same
   * fusion, different path — a symbolic source never goes through the quantizer.
   */
  | 'symbolic-tick-collision';

/** WHY A NOTE IS NOT ON THE PAGE AT ALL. */
export type DropReason =
  /** `guards.ts`: the onset is at or past the end of the audio, so nothing played it. */
  | 'past-audio-end'
  /** `guards.ts`: shorter than `MIN_NOTE_SEC` and nothing declared it, so it is detector noise. */
  | 'below-min-duration'
  /** `buildScore.ts`: the quantized onset landed at or past the last barline. */
  | 'past-score-end'
  /** `buildScore.ts`: the overlap clamp left the span no ticks to occupy. */
  | 'zero-length-after-clamp'
  /**
   * THE BACKSTOP, and its presence in a build is a bug report rather than a normal outcome.
   *
   * An input id with no glyph, no merge pointer and no drop record means a station removed it
   * without saying so. The projection refuses to lose it silently: it is reported here, with a
   * count, so the fault surfaces as a number a test can assert on instead of as a note the user
   * notices missing. Nothing in the pipeline is known to produce one.
   */
  | 'unengraved';

/**
 * WHY A STORED `notationIntent` DID NOT DECIDE THIS NOTE'S WRITTEN VALUE.
 *
 * See `IR.md` — "notation intent, and when it goes stale". The pipeline REPORTS; the owner of the
 * stored intent (the editing seam) is what clears it. The pipeline cannot clear it itself: it is
 * a pure function of its input and the intent lives in the caller's document.
 */
export interface IntentIgnored {
  reason:
    /**
     * The engraved span does not total the declared value, beyond one subdivision of tolerance.
     * The declaration asked for a length the note's position cannot carry — the next attack
     * trimmed it, or the last barline clipped it. THIS is the stale-intent signal: a timing edit
     * that moved the note or its neighbour changed what the span can hold, and the stored value
     * is now a claim the page contradicts.
     */
    | 'not-carried'
    /**
     * The note sits inside a tuplet group and the declared value is not a whole number of that
     * group's units, so the lattice reshaped it. Nothing else is printable there.
     */
    | 'tuplet-lattice'
    /**
     * A chord is one slot with one written value, and a longer declaration from another member of
     * the same chord won. This note's own declaration did not decide the slot.
     */
    | 'chord-superseded'
    /**
     * A symbolic source already wrote every tick, so `buildScore` never consults a declaration on
     * that path. The stored intent is inert rather than wrong.
     */
    | 'symbolic-source'
    /**
     * `notationIntentTicks` refused the value — a dotted 1/32 names no printable length. Nothing
     * was declared as far as the engraver is concerned, and the note was measured as usual.
     */
    | 'unprintable';
  /** What the intent resolved to in IR ticks, or null when it names no printable value. */
  declaredTicks: number | null;
  /** What the page actually gave it, summed over every piece of a tie split. */
  engravedTicks: number;
  /** The subdivision this note was measured against; the tolerance `not-carried` allows. */
  toleranceTicks: number;
}

/** One input note's single, total outcome. */
export type NoteProjection =
  | {
      kind: 'engraved';
      id: string;
      /** Every glyph, in printed order. Never empty. */
      glyphs: GlyphRef[];
      /** Sum of `glyphs[].durTicks` — the written value the page gave this note. */
      engravedTicks: number;
      /** Present only when a stored `notationIntent` did not decide the value. */
      intentIgnored?: IntentIgnored;
    }
  | { kind: 'merged'; id: string; mergedInto: string; reason: MergeReason }
  | { kind: 'dropped'; id: string; reason: DropReason };

/**
 * ONE CHORD, AS THE ENGRAVER DECIDED IT — the published form of the chord law.
 *
 * `chords.ts` owns the only definition of "these notes are one chord", and it is a GREEDY
 * PARTITION of the whole note list, not a pairwise predicate. That distinction is the reason this
 * has to be published as data rather than as a constant: no threshold a caller holds can
 * reproduce a partition. See `chordWindowSec` and the warning above it.
 */
export interface ChordGroupProjection {
  /** The build-local event id (`e0`, `e1`, ...). Stable within ONE build and no further. */
  id: string;
  /**
   * Every input id the chord law admitted, low pitch first — INCLUDING members that were later
   * merged away or dropped. This is the law's answer, not the page's.
   */
  memberIds: string[];
  /** The subset of `memberIds` that reached the page as this chord. */
  engravedIds: string[];
  onsetSec: number;
  endSec: number;
  /**
   * The window the group was decided with, in seconds, INCLUDING every adaptive widening it
   * earned. 0 on a written-tick group, where no window is consulted at all.
   */
  windowSec: number;
  /** Which of the two laws decided this group. See `collectChords`. */
  law: 'performance-window' | 'written-tick';
}

export interface Projection {
  /** Input id -> outcome. One entry per input note, no more and no less. */
  byId: Map<string, NoteProjection>;
  /** The chord law's own answer, in onset order. */
  chordGroups: ChordGroupProjection[];
  counts: {
    /** Input notes this build was handed, before any station touched them. */
    input: number;
    engraved: number;
    merged: number;
    dropped: number;
  };
}

/** Input ids grouped by outcome, for callers that want a set rather than a walk. */
export function projectionIds(projection: Projection, kind: NoteProjection['kind']): string[] {
  const out: string[] = [];
  for (const entry of projection.byId.values()) if (entry.kind === kind) out.push(entry.id);
  return out;
}

/**
 * EVERY GLYPH IN THE SCORE, KEYED BY THE SOURCE ID IT CAME FROM.
 *
 * One walk of the IR. `IRNote.id` is the source note's id by construction (`newNote`), and a span
 * the bar law split into tied pieces contributes one entry per piece, in printed order — bars
 * ascend, and within a bar the beat list is already in tick order.
 */
export function glyphsBySourceId(ir: RiffsheetIR): Map<string, GlyphRef[]> {
  const out = new Map<string, GlyphRef[]>();
  for (let bar = 0; bar < ir.bars.length; bar++) {
    const irBar = ir.bars[bar];
    for (const voice of irBar.voices) {
      for (let beat = 0; beat < voice.beats.length; beat++) {
        const irBeat = voice.beats[beat];
        if (irBeat.isRest) continue;
        for (let note = 0; note < irBeat.notes.length; note++) {
          const irNote: IRNote = irBeat.notes[note];
          const refs = out.get(irNote.id);
          const ref: GlyphRef = {
            bar,
            voice: voice.id,
            beat,
            note,
            startTick: irBar.startTick + irBeat.startTick,
            durTicks: irBeat.durTicks,
            tieStart: irNote.tieStart,
            tieStop: irNote.tieStop
          };
          if (refs) refs.push(ref);
          else out.set(irNote.id, [ref]);
        }
      }
    }
  }
  return out;
}

/** What the stations recorded on the way down, handed to `assembleProjection`. */
export interface ProjectionLedger {
  /** Ids in the order the build received them, after id assignment and before any filtering. */
  inputIds: string[];
  /**
   * Recorded absorptions, in the order the stations found them. Earlier records win, and
   * `mergedInto` is resolved TRANSITIVELY by the caller before it gets here: a note absorbed into
   * a note that was itself absorbed must name the id that actually holds a glyph, or every
   * consumer has to re-implement the walk.
   */
  merged: { id: string; mergedInto: string; reason: MergeReason }[];
  dropped: { id: string; reason: DropReason }[];
  /** `engravedIds` is filled in by the assembly, which is the only thing that knows the page. */
  chordGroups: Omit<ChordGroupProjection, 'engravedIds'>[];
  /**
   * ASKED ONCE PER ENGRAVED NOTE, with the ticks the page gave it. A callback rather than a map
   * because the verdict depends on the engraved length, which only exists after the IR does — and
   * the alternative is walking every glyph twice to find out.
   */
  intentVerdict?: (id: string, engravedTicks: number) => IntentIgnored | undefined;
}

/**
 * TURN THE LEDGER AND THE FINISHED IR INTO A TOTAL PROJECTION.
 *
 * PRECEDENCE IS DELIBERATE and it is: the page wins, then the ledger, then the backstop.
 *
 * An id with a glyph is `engraved` no matter what any station recorded about it, because the
 * glyph is the observable fact and a stale ledger entry is not. An id with no glyph takes its
 * recorded merge or drop. An id with neither is `unengraved` — see `DropReason`.
 */
export function assembleProjection(ir: RiffsheetIR, ledger: ProjectionLedger): Projection {
  const glyphs = glyphsBySourceId(ir);
  const byId = new Map<string, NoteProjection>();
  const mergedById = new Map<string, { mergedInto: string; reason: MergeReason }>();
  for (const record of ledger.merged) if (!mergedById.has(record.id)) mergedById.set(record.id, record);
  const droppedById = new Map<string, DropReason>();
  for (const record of ledger.dropped) if (!droppedById.has(record.id)) droppedById.set(record.id, record.reason);

  let engraved = 0;
  let merged = 0;
  let dropped = 0;

  for (const id of ledger.inputIds) {
    // A duplicate id in the input would otherwise be counted twice and break totality. Ids are
    // assigned by `buildScore` and are unique by construction; a caller that supplied its own
    // colliding ones gets one entry, which is all the map can hold anyway.
    if (byId.has(id)) continue;
    const refs = glyphs.get(id);
    if (refs && refs.length) {
      let engravedTicks = 0;
      for (const ref of refs) engravedTicks += ref.durTicks;
      const intent = ledger.intentVerdict?.(id, engravedTicks);
      byId.set(id, {
        kind: 'engraved',
        id,
        glyphs: refs,
        engravedTicks,
        ...(intent ? { intentIgnored: intent } : {})
      });
      engraved++;
      continue;
    }
    const mergeRecord = mergedById.get(id);
    if (mergeRecord) {
      byId.set(id, { kind: 'merged', id, mergedInto: mergeRecord.mergedInto, reason: mergeRecord.reason });
      merged++;
      continue;
    }
    byId.set(id, { kind: 'dropped', id, reason: droppedById.get(id) ?? 'unengraved' });
    dropped++;
  }

  const chordGroups: ChordGroupProjection[] = ledger.chordGroups.map((group) => ({
    ...group,
    engravedIds: group.memberIds.filter((id) => byId.get(id)?.kind === 'engraved')
  }));

  return {
    byId,
    chordGroups,
    counts: { input: byId.size, engraved, merged, dropped }
  };
}
