/**
 * The auto-split / gap-fill pass — the app arguing with the engine, in the player's favour.
 *
 * WHY THIS EXISTS. The transcription engines merge fast repeated notes. The reported case is
 * exact and small: two hits of about a quarter of a second each came back as ONE half-second
 * note, and the app's own attack detector (`audio/onsets.ts`) had already drawn a line on the
 * waveform at the join. Two parts of the app disagreed on screen at the same time, and the one
 * that was right was the one nobody was allowed to act on.
 *
 * So this pass acts on it. It runs after every transcription, entirely client-side, over
 * evidence the app already has:
 *
 *   - SPLIT   an engine note that contains a confirmed internal attack, at that attack.
 *   - FILL    a stretch where the engine wrote nothing but the detector heard an attack and
 *             the pitch tracker (`audio/pitch.ts` — the tuner's own machinery) reports one
 *             steady note through it.
 *
 * ===========================================================================================
 * WHERE THE THINKING ACTUALLY LIVES: `edit/editBrain.ts`
 * ===========================================================================================
 * Every number and every rule this pass applies is in `editBrain.ts`, and this file adds
 * nothing to them. That is not tidiness, it is the fix for a real bug: the transcriber
 * (`audio/riffsheetEngine.ts`) asks the same questions of the same audio, the two used to
 * answer them with different code, and the pass therefore found work to do on takes the app
 * itself had just transcribed — three green edits on a Riffsheet-engine take, which is the app
 * contradicting itself in front of the player. The brain's header records exactly how the two
 * diverged.
 *
 * Now the transcriber ENDS by running the brain over its own output, so this pass — the same
 * `planEdits` call — finds nothing on it, and the count on screen is a live idempotence proof
 * rather than a surprise. On takes from the OTHER engines it does exactly what it always did.
 *
 * WHAT MAKES THIS SAFE TO SHIP ON BY DEFAULT is that it refuses far more often than it acts,
 * and every refusal is still reported. The player's own warning shaped the guardrails: the
 * detector fires narrow ghost detections just before real attacks, and a pass that believed
 * them would turn a clean take into confetti. So:
 *
 *  1. NO RAW DETECTOR LINE IS EVER USED. Attacks closer than `CLUSTER_SEC` collapse to the
 *     strongest one first. A ghost 20 ms ahead of a real attack is absorbed by the attack it
 *     was a precursor to, and cannot become a split of its own.
 *
 *  2. ELIGIBILITY IS MEASURED ON THE RESULT, NOT ON THE INPUT. There is deliberately no
 *     "only split notes longer than X" rule — that is a threshold on the wrong quantity, and
 *     it would happily cut a long note into a 900 ms piece and a 15 ms sliver. What is
 *     checked is what comes OUT: both fragments must clear the floor.
 *
 *  3. GAP-FILL IS STRICTER THAN SPLIT, because it invents a note rather than dividing one.
 *     Long enough, steady enough in pitch, loud enough relative to the take's own peak, and
 *     the engine has to be genuinely silent across the whole stretch.
 *
 *  4. THE SPLIT LANDS ON THE ATTACK. Not on a grid line, not on the midpoint — on the
 *     clustered attack time, because that is the moment the evidence is about.
 *
 * PURE AND OFFLINE, like the two detectors it sits on top of: notes and samples in, proposals
 * out. It applies nothing, mutates nothing, and reads no DOM. `ui/app.ts` turns the proposals
 * into ordinary performance edits so undo, rebuild and persistence treat them exactly like
 * something the player did by hand.
 *
 * EVERY TIME IS ON THE RECORDING'S CLOCK — the same clock as `Onset.timeSec`, the waveform and
 * `source.detected.notes`. Written score seconds never appear in this file.
 */

import type { Onset } from '../audio/onsets';
import {
  CLUSTER_SEC,
  EVIDENCE_END_FRAMES,
  EVIDENCE_HOP_SEC,
  FILL_CENTS_SPREAD,
  FILL_FLOOR_DB,
  MIN_FILL_SEC,
  MUTE_FALL_RATIO,
  MUTE_RISE_RATIO,
  applyEdits,
  fragmentFloorSec,
  planEdits,
  type AppliedEdit,
  type EditNote,
  type EditApplication,
  type EditPlan
} from './editBrain';

// The brain owns the numbers, the clustering, the mute classifier and the evidence reader.
// They are re-exported here because this module's public surface is where the rest of the app
// (and every test) has always reached them, and because a second import path is how a caller
// ends up holding a stale copy of a decision.
export {
  classifyOnsetEnergy,
  clusterOnsets,
  clusterOnsetsDetailed,
  fragmentFloorSec,
  readNoteEvidence,
  takePeakOf
} from './editBrain';
export type {
  AppliedEdit as AppliedAutoEdit,
  AttentionMark,
  FillProposal,
  NoteEvidence,
  NoteEvidenceOptions,
  OnsetCluster,
  OnsetEnergy,
  OnsetEnergyKind,
  SplitProposal
} from './editBrain';

/** The minimum a caller has to supply per note. `InputNote` satisfies it. */
export type AutoEditNote = EditNote;

export interface AutoEditPlan extends EditPlan {
  /** Every number that shaped the result, so a bug report can say what it ran with. */
  params: Record<string, number>;
}

export interface AutoEditInput {
  /** The performance as the engine reported it (plus any edits already made). */
  notes: ReadonlyArray<AutoEditNote>;
  /** Raw detector output. Clustered by the brain — a caller never has to remember to do it. */
  onsets: ReadonlyArray<Onset>;
  /** The decoded mono take. Without it, gap-fill cannot run and only splits are proposed. */
  pcm: Float32Array | null;
  sampleRate: number;
  /** The roll's current cell, in seconds. See `GRID_FRACTION` in the brain. */
  snapSec: number;
  /**
   * Notes the player has edited by hand. Exempt: an automatic pass must never argue with
   * somebody who has already looked at that note and decided.
   */
  userTouchedIds?: ReadonlySet<string>;
  /** How long the recording is, so a region cannot run off the end of it. */
  durationSec: number;
}

/**
 * Work out what the pass would do. Decides nothing about whether to do it.
 *
 * Called on every fresh transcription, with the toggle ON or OFF: the difference is what the
 * caller does with the result, not whether the thinking happens. That is what makes the
 * switched-off state useful rather than merely quiet.
 *
 * The ROLL'S GRID is the one thing this pass knows that the brain's other caller does not, and
 * the only thing added here: it turns the live cell size into the floor a split fragment has to
 * clear. See `fragmentFloorSec`.
 */
export function planAutoEdits(input: AutoEditInput): AutoEditPlan {
  const floorSec = fragmentFloorSec(input.snapSec);
  const plan = planEdits({
    notes: input.notes,
    onsets: input.onsets,
    pcm: input.pcm,
    sampleRate: input.sampleRate,
    floorSec,
    userTouchedIds: input.userTouchedIds,
    durationSec: input.durationSec
  });

  return {
    ...plan,
    params: {
      clusterSec: CLUSTER_SEC,
      fragmentFloorSec: floorSec,
      minFillSec: MIN_FILL_SEC,
      // No maxFillSec. A fill's length is measured, not capped — see the brain's §EVIDENCE.
      evidenceHopSec: EVIDENCE_HOP_SEC,
      evidenceEndFrames: EVIDENCE_END_FRAMES,
      fillCentsSpread: FILL_CENTS_SPREAD,
      fillFloorDb: FILL_FLOOR_DB,
      muteFallRatio: MUTE_FALL_RATIO,
      muteRiseRatio: MUTE_RISE_RATIO,
      mutedClusters: plan.mutedClusters,
      snapSec: input.snapSec,
      rawOnsets: input.onsets.length,
      clusteredOnsetCount: plan.clusteredOnsets.length
    }
  };
}

export type AutoEditApplication<T extends AutoEditNote> = EditApplication<T>;

/**
 * Turn accepted proposals into a new performance. The brain applies them; this is the arity
 * `ui/app.ts` calls with, kept so the call site says what it means and nothing else.
 */
export function applyAutoEdits<T extends AutoEditNote>(
  notes: ReadonlyArray<T>,
  plan: AutoEditPlan,
  newId: () => string
): AutoEditApplication<T> {
  return applyEdits(notes, plan, { newId });
}

/**
 * Undo one applied edit, without disturbing anything else.
 *
 * A split merges its fragments back into one note carrying the FIRST fragment's id — which is
 * the original engine note's id, so reverting really does put the performance back rather than
 * leaving a note that merely looks like the old one. A fill removes the note it added.
 *
 * Returns null when the edit's notes are no longer there to revert, which is a normal state:
 * the player may have deleted one by hand in the meantime.
 *
 * Stays here rather than in the brain because it is not a decision about audio: it is the UI's
 * undo, and nothing in the transcriber has anything to revert.
 */
export function revertAutoEdit<T extends AutoEditNote>(
  notes: ReadonlyArray<T>,
  edit: AppliedEdit
): T[] | null {
  const wanted = new Set(edit.noteIds);
  const involved = notes.filter((n) => n.id && wanted.has(n.id));
  if (involved.length === 0) return null;

  if (edit.kind === 'fill') {
    return notes.filter((n) => !(n.id && wanted.has(n.id)));
  }

  if (involved.length < 2) return null;
  const ordered = [...involved].sort((a, b) => a.startSec - b.startSec);
  const head = ordered[0];
  const merged: T = { ...head, startSec: ordered[0].startSec, endSec: ordered[ordered.length - 1].endSec };
  const out = notes.filter((n) => !(n.id && wanted.has(n.id)));
  out.push(merged);
  out.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  return out;
}
