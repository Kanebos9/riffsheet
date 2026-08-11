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
 *     checked is what comes OUT: both fragments must clear the floor. A ghost near the end of
 *     a note therefore fails by arithmetic rather than by hoping a heuristic catches it.
 *
 *  3. GAP-FILL IS STRICTER THAN SPLIT, because it invents a note rather than dividing one.
 *     Long enough, steady enough in pitch, loud enough relative to the take's own peak, and
 *     the engine has to be genuinely silent across the whole stretch. Any one of those
 *     borderline and the region becomes a highlight instead of a note.
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
import { detectPitchTrack, type PitchReading } from '../audio/pitch';

/** The minimum a caller has to supply per note. `InputNote` satisfies it. */
export interface AutoEditNote {
  id?: string;
  startSec: number;
  endSec: number;
  midi: number;
}

// ---------------------------------------------------------------------------
// The numbers. Every one of them is a decision, and each says what it costs.
// ---------------------------------------------------------------------------

/**
 * Attacks closer together than this are one attack.
 *
 * 70 ms, and it is the guardrail the player asked for by name: "it detects some narrow ones
 * just before the real attacks". A pluck's transient is not a single instant — the pick noise,
 * the string release and the body resonance arrive over a few tens of milliseconds, and the
 * detector can peak on more than one of them. 70 ms is comfortably wider than that spread and
 * comfortably narrower than the fastest thing anybody plays deliberately: 70 ms apart is 857
 * notes a minute, which is not a repeated note, it is a roll.
 *
 * The STRONGEST survives rather than the earliest, because the ghost is the weak one and
 * keeping the earliest would snap every split onto the precursor instead of onto the note.
 */
const CLUSTER_SEC = 0.07;

/**
 * The floor both halves of a split have to clear. 120 ms.
 *
 * Tuned against the reported take (`2.wav`: two ~250 ms hits inside one ~500 ms note). It has
 * to be low enough to allow that — 250 ms is comfortably over — and high enough that a ghost
 * landing near either end of a note produces a fragment that fails. The detector's own ghosts
 * sit within a few tens of milliseconds of the real attack, so anything under about 80 ms
 * would start letting them through; 120 ms is that with room, and it is still shorter than a
 * sixteenth note at 120 BPM (125 ms), so it never forbids a real subdivision the player used.
 *
 * Below this the pass declines and highlights instead. It never produces a sliver.
 */
const MIN_FRAGMENT_SEC = 0.12;

/**
 * The same floor, expressed against the roll's own grid, so the result is SANE FOR THIS TAKE
 * and not merely long enough in the abstract.
 *
 * A fragment much shorter than the cell the player is drawing into is confetti to them
 * whatever the clock says. Half a cell is the line: at the default 1/8 grid and 120 BPM that
 * is 125 ms, which is the wall-clock floor again from the other direction, so the two agree
 * where it matters and only diverge on unusual grids.
 *
 * Capped, because a coarse grid must not be able to forbid every split: at a 1/4 grid and 60
 * BPM half a cell is a whole second, and refusing to separate two real half-second notes
 * because the ruler is coarse would be the grid meddling with the transcription — exactly what
 * the two-grid split in `app/state.ts` exists to prevent.
 */
const GRID_FRACTION = 0.5;
const GRID_FLOOR_CAP_SEC = 0.25;

/** A gap-fill region has to last at least this long. Stricter than a split, by design. */
const MIN_FILL_SEC = 0.15;

/**
 * A FILL ENDS WHERE ITS EVIDENCE ENDS. There is no maximum length.
 *
 * There used to be one — two seconds — and the reasoning was that past a couple of seconds
 * "the engine heard nothing and the tracker heard one steady pitch" stops being a missed note
 * and starts being a drone, a hum or feedback. That reasoning was about the WRONG QUANTITY. A
 * cap is a guess about how long a note can be; the take itself already says how long this one
 * was, and a bass note left to ring is routinely longer than two seconds. The player's own case
 * was exactly that: a long final note, written down as a two-second note, because of a constant.
 *
 * What replaced it is a measurement. The region runs forward frame by frame and stops the first
 * time the evidence stops — either the sound falls under the same relative floor a fill has
 * always had to clear (`FILL_FLOOR_DB`, which really is where hum and room tone live), or the
 * tracker starts reporting a DIFFERENT note, which means this one is over whatever the level
 * says. A drone still fails, on the level gate; so does feedback, once it decays. A held note
 * comes out the length it was actually held.
 *
 * `EVIDENCE_HOP_SEC` is the frame. 20 ms is short enough that the end lands within a fortieth
 * of a second of the truth and long enough that the pitch tracker has something to work with.
 */
const EVIDENCE_HOP_SEC = 0.02;
/**
 * How many frames in a row have to fail before the evidence is called over.
 *
 * One frame is not an ending — a pick scrape, a fret buzz or a momentary null in a beating
 * pair of strings can drop a single 20 ms window under the floor in the middle of a note that
 * is plainly still sounding. Three consecutive failures is 60 ms, which is longer than any of
 * those and far shorter than the gap between two notes anybody plays deliberately. The note
 * ends at the FIRST frame of the failing run, not the last: the run is how we know it ended,
 * and its beginning is when.
 */
const EVIDENCE_END_FRAMES = 3;

/**
 * How much the tracker is allowed to wander inside a region and still count as ONE note.
 *
 * ±50 cents is half a semitone: the point at which the reading would round to a different note
 * name. Wider than that is not a stable pitch, it is a slide or two notes.
 */
const FILL_CENTS_SPREAD = 50;
/** At least this share of the region's frames must have found that same pitch. */
const FILL_AGREEMENT = 0.6;
/** ...over at least this many frames, so a two-frame coincidence cannot qualify. */
const FILL_MIN_FRAMES = 3;

/**
 * How quiet a region may be, relative to the take's OWN peak, and still be believed.
 *
 * Relative and not absolute: a DI'd bass tracked at −18 dBFS and the same performance tracked
 * hot are the same performance, and an absolute floor would treat them differently. −40 dB
 * under the take's loudest moment is about the level of room tone, amp hiss and the tail of a
 * note three bars back. Nobody records a real note down there — and the pitch tracker will
 * happily find a confident, stable, entirely fictional pitch in hum, which is precisely the
 * failure this gate exists to stop.
 */
const FILL_FLOOR_DB = -40;

/** How close a detected attack has to be to a note's onset to count as already explained. */
const ONSET_MATCH_SEC = 0.06;
/** A gap-fill region must clear existing notes by this much at both ends. */
const SILENCE_MARGIN_SEC = 0.02;

// ---------------------------------------------------------------------------
// MUTES. Not every line the detector draws is a note starting.
// ---------------------------------------------------------------------------
//
// The detector fires on any sharp change in the spectrum, and a hand landing on the strings is
// as sharp a change as a pick hitting them. Both draw a line. Only one of them starts a note.
//
// Which is which is not a matter of opinion either, and it does not need a classifier: an
// ATTACK is followed by more energy than preceded it and a MUTE is followed by less. Measure
// the two sides and the direction answers it.
//
// Why it matters here. `clusterOnsets` collapses lines within `CLUSTER_SEC` to the strongest
// one, and a damped-then-restruck note produces exactly that shape — the hand stops the old
// note a few tens of milliseconds before the pick starts the new one. Collapsing them loses
// the mute, and the split then lands on the attack with the previous note running right up to
// it: the sheet says the old note was held until the new one began, when in fact the player
// stopped it first. Keeping both times costs one number on the proposal and makes the
// PERFORMANCE honest — the old note ends at the hand, the new one starts at the pick, and the
// real gap between them survives into the roll and the playback.
//
// It does NOT reach the sheet, because it must not: a 40 ms silence is not a rest anybody wants
// engraved, and the quantizer rounds it away exactly as it should.

/** How far either side of a line the energy is measured. */
const MUTE_WINDOW_SEC = 0.04;
/**
 * ...starting this far from the line itself.
 *
 * The line is the transient, and the transient belongs to neither side: a mute's own contact
 * noise is a burst of energy, so a window flush against the line would measure the damping as
 * a rise. 5 ms clears it.
 */
const MUTE_GUARD_SEC = 0.005;
/** After/before energy ratio at or below this is a mute. −6 dB: the sound is being stopped. */
const MUTE_FALL_RATIO = 0.5;
/** ...and at or above this is an attack. +4 dB. Between the two, nobody is claiming to know. */
const MUTE_RISE_RATIO = 1.6;

// ---------------------------------------------------------------------------
// What the pass produces
// ---------------------------------------------------------------------------

export interface SplitProposal {
  kind: 'split';
  /** The engine note to divide. */
  noteId: string;
  /** Where the SECOND piece starts — the clustered attack time, exactly. */
  atSec: number;
  /**
   * Where the FIRST piece ends.
   *
   * Equal to `atSec` for an ordinary split: one note stops where the next one starts. EARLIER
   * than `atSec` when a mute was heard inside the same cluster — the player's hand stopped the
   * ringing note before they struck the next one, and that small real silence is part of the
   * performance. See §MUTES.
   */
  endPrevSec: number;
  /** The note's own span, for the waveform tint and the roll highlight. */
  fromSec: number;
  toSec: number;
  /** The surviving attack's strength, 0..1 within this take. */
  strength: number;
  /** True when `endPrevSec < atSec`, i.e. a mute was found and honoured. */
  muted: boolean;
}

export interface FillProposal {
  kind: 'fill';
  fromSec: number;
  toSec: number;
  midi: number;
  /** How far the tracker wandered inside the region. Evidence, kept for the popover. */
  centsSpread: number;
  /** The region's peak, in dB relative to the take's peak. */
  levelDb: number;
}

/**
 * Something the detector heard that produced no edit — either because the toggle is off, or
 * because a gate refused it.
 *
 * These are NOT failures to be hidden. The whole point of the feature is that the app stops
 * quietly disagreeing with itself, and "the detector heard something here the engine did not,
 * and I did not act on it" is exactly as much use to the player as an edit would have been.
 */
export interface AttentionMark {
  kind: 'split' | 'fill';
  /** Plain language, shown in a tooltip. Never jargon and never a number on its own. */
  reason: string;
  atSec: number;
  fromSec: number;
  toSec: number;
  /** Present for a split: the note the attack landed inside. */
  noteId?: string;
}

export interface AutoEditPlan {
  splits: SplitProposal[];
  fills: FillProposal[];
  attention: AttentionMark[];
  /** The attacks the pass actually reasoned with — after clustering, never the raw list. */
  clusteredOnsets: Onset[];
  /** Every number that shaped the result, so a bug report can say what it ran with. */
  params: Record<string, number>;
}

export interface AutoEditInput {
  /** The performance as the engine reported it (plus any edits already made). */
  notes: ReadonlyArray<AutoEditNote>;
  /** Raw detector output. Clustered here — a caller never has to remember to do it. */
  onsets: ReadonlyArray<Onset>;
  /** The decoded mono take. Without it, gap-fill cannot run and only splits are proposed. */
  pcm: Float32Array | null;
  sampleRate: number;
  /** The roll's current cell, in seconds. See `GRID_FRACTION`. */
  snapSec: number;
  /**
   * Notes the player has edited by hand. Exempt: an automatic pass must never argue with
   * somebody who has already looked at that note and decided.
   */
  userTouchedIds?: ReadonlySet<string>;
  /** How long the recording is, so a region cannot run off the end of it. */
  durationSec: number;
}

/** One cluster: the line the pass reasons with, and every line that collapsed into it. */
export interface OnsetCluster {
  /** The strongest member. This is the time a split lands on. */
  winner: Onset;
  /** Every raw line in the cluster, in time order, including the winner. */
  members: Onset[];
}

/**
 * Collapse attacks that are really one attack, KEEPING what was collapsed.
 *
 * Greedy over the take in time order, keeping the strongest member of each cluster. The members
 * are kept rather than discarded because a cluster is not always one event seen twice: a
 * damped-and-restruck note puts a mute and an attack inside one `CLUSTER_SEC` window, and the
 * mute is the only record of when the previous note actually stopped. See §MUTES.
 */
export function clusterOnsetsDetailed(
  onsets: ReadonlyArray<Onset>,
  windowSec = CLUSTER_SEC
): OnsetCluster[] {
  if (onsets.length === 0) return [];
  const sorted = [...onsets].sort((a, b) => a.timeSec - b.timeSec);
  const out: OnsetCluster[] = [];
  let best = sorted[0];
  let members: Onset[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const o = sorted[i];
    // Measured against the cluster's CURRENT winner, not against the previous raw line: a
    // drizzle of detections 40 ms apart is one attack, and chaining off each neighbour in turn
    // would let a cluster grow without limit.
    if (o.timeSec - best.timeSec < windowSec) {
      members.push(o);
      if (o.strength > best.strength) best = o;
      continue;
    }
    out.push({ winner: best, members });
    best = o;
    members = [o];
  }
  out.push({ winner: best, members });
  return out;
}

/**
 * Collapse attacks that are really one attack.
 *
 * Exported because it is the guardrail most worth testing directly, and because the waveform
 * would rather draw what the pass believed than what the detector said.
 */
export function clusterOnsets(onsets: ReadonlyArray<Onset>, windowSec = CLUSTER_SEC): Onset[] {
  return clusterOnsetsDetailed(onsets, windowSec).map((c) => c.winner);
}

/** Which way the energy went across a line. `'unknown'` when it barely moved either way. */
export type OnsetEnergyKind = 'attack' | 'mute' | 'unknown';

export interface OnsetEnergy {
  kind: OnsetEnergyKind;
  /** RMS in the window before the line. */
  beforeRms: number;
  /** RMS in the window after it. */
  afterRms: number;
  /** `afterRms / beforeRms`, in dB. Negative means the sound was being stopped. */
  changeDb: number;
}

/**
 * Which way the energy went across a detected line — the whole of "is this a note or a hand".
 *
 * Pure arithmetic on the take, no model and no threshold on absolute level: the comparison is
 * the line against ITSELF a few tens of milliseconds either side, so a quiet passage and a loud
 * one are judged the same way. Silence before a line (`beforeRms` at zero) is an attack by
 * definition — there was nothing there to stop.
 */
export function classifyOnsetEnergy(
  pcm: Float32Array,
  sampleRate: number,
  atSec: number,
  windowSec = MUTE_WINDOW_SEC
): OnsetEnergy {
  const unknown: OnsetEnergy = { kind: 'unknown', beforeRms: 0, afterRms: 0, changeDb: 0 };
  if (!pcm || !(sampleRate > 0) || pcm.length === 0) return unknown;
  const at = atSec * sampleRate;
  const guard = MUTE_GUARD_SEC * sampleRate;
  const width = Math.max(1, Math.round(windowSec * sampleRate));
  const beforeEnd = Math.round(at - guard);
  const afterStart = Math.round(at + guard);
  const beforeRms = rmsOf(pcm, beforeEnd - width, beforeEnd);
  const afterRms = rmsOf(pcm, afterStart, afterStart + width);
  if (beforeRms <= 0 && afterRms <= 0) return unknown;
  // Nothing before it: this is a note beginning out of silence, and no ratio is needed to say so.
  if (beforeRms <= 0) return { kind: 'attack', beforeRms, afterRms, changeDb: Infinity };
  const ratio = afterRms / beforeRms;
  const changeDb = Number((20 * Math.log10(Math.max(ratio, 1e-9))).toFixed(2));
  if (ratio >= MUTE_RISE_RATIO) return { kind: 'attack', beforeRms, afterRms, changeDb };
  if (ratio <= MUTE_FALL_RATIO) return { kind: 'mute', beforeRms, afterRms, changeDb };
  return { kind: 'unknown', beforeRms, afterRms, changeDb };
}

function rmsOf(pcm: Float32Array, from: number, to: number): number {
  const a = Math.max(0, Math.min(pcm.length, Math.round(from)));
  const b = Math.max(a, Math.min(pcm.length, Math.round(to)));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / (b - a));
}

/** The floor a split fragment must clear, for this take's grid. See `GRID_FRACTION`. */
export function fragmentFloorSec(snapSec: number): number {
  const grid = Number.isFinite(snapSec) && snapSec > 0 ? snapSec * GRID_FRACTION : 0;
  return Math.max(MIN_FRAGMENT_SEC, Math.min(GRID_FLOOR_CAP_SEC, grid));
}

/**
 * Work out what the pass would do. Decides nothing about whether to do it.
 *
 * Called on every fresh transcription, with the toggle ON or OFF: the difference is what the
 * caller does with the result, not whether the thinking happens. That is what makes the
 * switched-off state useful rather than merely quiet.
 */
export function planAutoEdits(input: AutoEditInput): AutoEditPlan {
  const floor = fragmentFloorSec(input.snapSec);
  const clusters = clusterOnsetsDetailed(input.onsets);
  const clustered = clusters.map((c) => c.winner);
  const notes = [...input.notes].sort((a, b) => a.startSec - b.startSec);
  const touched = input.userTouchedIds ?? new Set<string>();

  const splits: SplitProposal[] = [];
  const fills: FillProposal[] = [];
  const attention: AttentionMark[] = [];

  // Where the previous note really stopped, per cluster winner. See §MUTES. Computed once for
  // the whole take rather than per candidate split: a cluster is classified the same way
  // whichever note it happens to fall inside, and the RMS walk is the expensive part.
  const muteBefore = mutesBeforeWinners(clusters, input.pcm, input.sampleRate);
  let mutedLines = 0;
  for (const c of clusters) if (muteBefore.has(c.winner.timeSec)) mutedLines++;

  // --- splits ------------------------------------------------------------------------
  for (const note of notes) {
    if (!note.id || touched.has(note.id)) continue;
    const span = note.endSec - note.startSec;
    if (!(span > 0)) continue;

    // Every attack strictly inside the note, in time order. "Inside" is not a matter of
    // opinion: an attack at the note's own onset is the note starting, not a second note.
    const inside = clustered.filter((o) => o.timeSec > note.startSec + 1e-6 && o.timeSec < note.endSec - 1e-6);
    if (inside.length === 0) continue;

    // Walk them, keeping a running left edge, so several attacks inside one long note produce
    // several fragments and each boundary is checked against the piece it actually creates.
    let left = note.startSec;
    let accepted = 0;
    for (let i = 0; i < inside.length; i++) {
      const onset = inside[i];
      // The mute, when there was one, is where the FIRST piece ends. It is never later than the
      // attack and never earlier than the left edge — a mute outside the note is not this
      // note's ending.
      const mute = muteBefore.get(onset.timeSec);
      const endPrev =
        mute !== undefined && mute > left + 1e-6 && mute < onset.timeSec ? mute : onset.timeSec;
      // THE FRAGMENT FLOOR IS MEASURED ON WHAT COMES OUT, mute included: honouring a mute makes
      // the first piece SHORTER, so a mute must not be able to smuggle a sliver past the floor
      // that the plain split would have been refused for.
      const before = endPrev - left;
      // The piece AFTER this cut runs to the next accepted cut, or to the note's end. Measured
      // against the note's end rather than the next candidate, because the next candidate may
      // itself be refused — and then this fragment really does run to the end.
      const after = note.endSec - onset.timeSec;
      if (before < floor || after < floor) {
        attention.push({
          kind: 'split',
          noteId: note.id,
          atSec: onset.timeSec,
          fromSec: note.startSec,
          toSec: note.endSec,
          reason:
            before < after
              ? 'An attack was heard here, but splitting would leave a piece too short to be a note.'
              : 'An attack was heard near the end of this note — too near to divide it safely.'
        });
        continue;
      }
      splits.push({
        kind: 'split',
        noteId: note.id,
        atSec: onset.timeSec,
        endPrevSec: endPrev,
        fromSec: note.startSec,
        toSec: note.endSec,
        strength: onset.strength,
        muted: endPrev < onset.timeSec
      });
      left = onset.timeSec;
      accepted++;
    }
    void accepted;
  }

  // --- gap fills ---------------------------------------------------------------------
  const pcm = input.pcm;
  const rate = input.sampleRate;
  const takePeak = pcm && rate > 0 ? peakOf(pcm) : 0;

  for (const onset of clustered) {
    // Does the engine already explain this attack? Either a note starts on it, or one is
    // sounding across it. Both mean the engine was not silent here.
    if (notes.some((n) => Math.abs(n.startSec - onset.timeSec) <= ONSET_MATCH_SEC)) continue;
    if (notes.some((n) => onset.timeSec >= n.startSec - SILENCE_MARGIN_SEC && onset.timeSec < n.endSec)) continue;

    const region = regionAfter(onset.timeSec, clustered, notes, input.durationSec);
    if (!region) continue;
    const span = region.toSec - region.fromSec;

    if (span < MIN_FILL_SEC) {
      attention.push({
        kind: 'fill',
        atSec: onset.timeSec,
        fromSec: region.fromSec,
        toSec: Math.max(region.toSec, region.fromSec + 0.03),
        reason: 'Something was struck here that the engine missed, but it is too short to write down safely.'
      });
      continue;
    }

    if (!pcm || !(rate > 0) || takePeak <= 0) {
      attention.push({
        kind: 'fill',
        atSec: onset.timeSec,
        fromSec: region.fromSec,
        toSec: region.toSec,
        reason: 'Something was struck here that the engine missed. The recording is not loaded, so its pitch could not be checked.'
      });
      continue;
    }

    // The region is now only an UPPER BOUND — the next thing the engine or the detector knows
    // about. Where the note really ends is a question for the recording, asked frame by frame.
    const evidence = fillFromEvidence(pcm, rate, takePeak, region.fromSec, region.toSec);
    if (!evidence.ok) {
      attention.push({
        kind: 'fill',
        atSec: onset.timeSec,
        fromSec: region.fromSec,
        toSec: region.toSec,
        reason:
          evidence.why === 'quiet'
            ? 'Something was heard here, but it is too quiet to be a note somebody meant to play.'
            : evidence.why === 'short'
              ? 'Something was struck here that the engine missed, but it is too short to write down safely.'
              : 'Something was struck here that the engine missed, but there is no one steady pitch in it to write down.'
      });
      continue;
    }

    fills.push({
      kind: 'fill',
      fromSec: region.fromSec,
      toSec: evidence.toSec,
      midi: evidence.midi,
      centsSpread: evidence.centsSpread,
      levelDb: evidence.levelDb
    });
  }

  return {
    splits,
    fills,
    attention,
    clusteredOnsets: clustered,
    params: {
      clusterSec: CLUSTER_SEC,
      fragmentFloorSec: floor,
      minFillSec: MIN_FILL_SEC,
      // No maxFillSec. A fill's length is measured, not capped — see §EVIDENCE_HOP_SEC.
      evidenceHopSec: EVIDENCE_HOP_SEC,
      evidenceEndFrames: EVIDENCE_END_FRAMES,
      fillCentsSpread: FILL_CENTS_SPREAD,
      fillFloorDb: FILL_FLOOR_DB,
      muteFallRatio: MUTE_FALL_RATIO,
      muteRiseRatio: MUTE_RISE_RATIO,
      mutedClusters: mutedLines,
      snapSec: input.snapSec,
      rawOnsets: input.onsets.length,
      clusteredOnsetCount: clustered.length
    }
  };
}

/**
 * The mute that ended the previous note, per cluster winner.
 *
 * Only clusters with more than one line can hold one — a single line is the event, and there is
 * nothing else in the window to be the hand. Within such a cluster the mute has to come BEFORE
 * the winner (a damp after the new attack is that note being stopped, not the old one) and the
 * winner itself has to read as an attack, because two mutes in a row is a hand settling and not
 * a note being restruck.
 *
 * The EARLIEST qualifying mute wins: the hand lands once, and any later line in the same
 * cluster is part of the same contact.
 */
function mutesBeforeWinners(
  clusters: ReadonlyArray<OnsetCluster>,
  pcm: Float32Array | null,
  sampleRate: number
): Map<number, number> {
  const out = new Map<number, number>();
  if (!pcm || !(sampleRate > 0)) return out;
  for (const cluster of clusters) {
    if (cluster.members.length < 2) continue;
    const winner = cluster.winner;
    if (classifyOnsetEnergy(pcm, sampleRate, winner.timeSec).kind !== 'attack') continue;
    for (const member of cluster.members) {
      if (member.timeSec >= winner.timeSec - 1e-6) continue;
      if (classifyOnsetEnergy(pcm, sampleRate, member.timeSec).kind !== 'mute') continue;
      out.set(winner.timeSec, member.timeSec);
      break;
    }
  }
  return out;
}

/**
 * What the frame-by-frame walk found, plus the frames it walked.
 *
 * The readings are handed back rather than thrown away because the SECOND reader of this
 * machinery — `audio/riffsheetEngine.ts` — needs to ask two more questions of exactly the same
 * frames: *did the tracker keep flipping octaves here* and *were two different notes sounding
 * at once*. Re-running `detectPitchTrack` to ask them would double the cost of the expensive
 * half of the pass for evidence that was already computed and discarded.
 *
 * `readings` covers the whole CANDIDATE span (`fromSec` to `limitSec`), not the span that
 * survived: `keptFrames` says where the note ended, and the frames after it are still evidence
 * about what was going on. `hopSec` is the lattice, so frame *i* starts at `fromSec + i*hopSec`.
 */
export type NoteEvidence = { readings: PitchReading[]; keptFrames: number; hopSec: number } & (
  | { ok: true; toSec: number; midi: number; centsSpread: number; levelDb: number }
  | { ok: false; why: 'quiet' | 'unpitched' | 'short' }
);

/** How the caller may move the two length constants. Defaults are the gap-fill values. */
export interface NoteEvidenceOptions {
  /**
   * Shortest span worth reporting. A gap-fill uses `MIN_FILL_SEC` (150 ms) because a fill that
   * short is not worth an automatic edit; a TRANSCRIBER cannot use that number, because a
   * sixteenth at 200 BPM is 75 ms and refusing to write it down would be a bug, not caution.
   */
  minSec?: number;
  /**
   * How much of the region's opening decides WHICH note this is. Same reasoning: a fill votes
   * over its own minimum length, an engine over a window short enough to fit a fast note.
   */
  leadSec?: number;
}

type FillEvidence = NoteEvidence;

/**
 * How long the note that starts at `fromSec` actually lasted, and what it was.
 *
 * THE FUNCTION THAT REPLACED A CONSTANT. It walks the take in `EVIDENCE_HOP_SEC` frames from
 * the attack up to `limitSec` (the next attack, the next engine note, or the end of the file)
 * and stops at the first `EVIDENCE_END_FRAMES` consecutive frames that fail either test:
 *
 *   LEVEL — the frame is below `FILL_FLOOR_DB` under the take's own peak. This is what ends a
 *           ringing note: it ends where it decays into the room, which is where a listener
 *           would say it ended too.
 *   PITCH — the frame is confidently a DIFFERENT note. A frame with no clear pitch never fails
 *           this test, because the tracker losing the thread is not the same as hearing
 *           something else, and a note's own attack transient is routinely unpitched.
 *
 * The two gates a fill has always had to clear are then applied to the span that survived, not
 * to the candidate: `FILL_AGREEMENT` of the frames must be the note, and they must sit inside
 * `FILL_CENTS_SPREAD` of each other. So a longer note is held to exactly the same standard as
 * a short one — it just is not forbidden for being long.
 */
export function readNoteEvidence(
  pcm: Float32Array,
  sampleRate: number,
  takePeak: number,
  fromSec: number,
  limitSec: number,
  opts: NoteEvidenceOptions = {}
): NoteEvidence {
  const hop = EVIDENCE_HOP_SEC;
  const minSec = opts.minSec ?? MIN_FILL_SEC;
  const leadSec = opts.leadSec ?? MIN_FILL_SEC;
  const a = Math.max(0, Math.min(pcm.length, Math.round(fromSec * sampleRate)));
  const b = Math.max(a, Math.min(pcm.length, Math.round(limitSec * sampleRate)));
  const slice = pcm.subarray(a, b);
  if (slice.length === 0) return { ok: false, why: 'short', readings: [], keptFrames: 0, hopSec: hop };

  // One pitch pass over the whole candidate. `detectPitchTrack` reports a reading per hop, so
  // frame i is the hop starting at fromSec + i*hop — the same lattice the level walk uses.
  const readings = detectPitchTrack(slice, sampleRate, hop);
  if (readings.length === 0) return { ok: false, why: 'unpitched', readings, keptFrames: 0, hopSec: hop };
  /** Everything below reports the same three fields, so the caller never has to special-case. */
  const frames = (keptFrames: number) => ({ readings, keptFrames, hopSec: hop });

  const frameSamples = Math.max(1, Math.round(hop * sampleRate));
  const levels: number[] = [];
  for (let i = 0; i < readings.length; i++) {
    const from = i * frameSamples;
    levels.push(dbBelow(peakOf(slice.subarray(from, from + frameSamples)), takePeak));
  }

  // What note this IS, decided on the opening of the region only — the part every accepted fill
  // has always had to be steady through. Deciding it over the whole candidate would let a
  // second note later in a long window outvote the one that was actually struck here.
  const leadFrames = Math.max(2, Math.min(readings.length, Math.ceil(leadSec / hop)));
  const lead = readings.slice(0, leadFrames).filter((r) => r.midi !== null);
  if (lead.length === 0) return { ok: false, why: 'unpitched', ...frames(0) };
  const votes = new Map<number, number>();
  for (const r of lead) votes.set(r.midi!, (votes.get(r.midi!) ?? 0) + 1);
  let midi = lead[0].midi!;
  let best = 0;
  for (const [note, count] of votes) {
    if (count > best) {
      best = count;
      midi = note;
    }
  }

  // The walk. `end` is the first frame of the failing run, i.e. the last frame that counts is
  // `end - 1`.
  let end = readings.length;
  let failing = 0;
  let firstFail = -1;
  let quietFail = false;
  for (let i = 0; i < readings.length; i++) {
    const quiet = levels[i] < FILL_FLOOR_DB;
    const wrongNote = readings[i].midi !== null && readings[i].midi !== midi;
    if (quiet || wrongNote) {
      if (failing === 0) {
        firstFail = i;
        quietFail = quiet;
      }
      if (++failing >= EVIDENCE_END_FRAMES) {
        end = firstFail;
        break;
      }
      continue;
    }
    failing = 0;
    firstFail = -1;
  }

  const toSec = Math.min(limitSec, fromSec + end * hop);
  if (toSec - fromSec < minSec) {
    // A region that dies inside the floor is the same "too short to write down" answer as a
    // region that was never longer than that — but say WHY it was short when it was the level.
    return { ok: false, why: end === 0 && quietFail ? 'quiet' : 'short', ...frames(end) };
  }

  const kept = readings.slice(0, end);
  const agreeing = kept.filter((r) => r.midi === midi);
  if (agreeing.length < FILL_MIN_FRAMES) return { ok: false, why: 'unpitched', ...frames(end) };
  if (agreeing.length / kept.length < FILL_AGREEMENT) return { ok: false, why: 'unpitched', ...frames(end) };
  const cents = agreeing.map((r) => r.cents);
  const spread = Math.max(...cents) - Math.min(...cents);
  if (!(spread <= FILL_CENTS_SPREAD)) return { ok: false, why: 'unpitched', ...frames(end) };

  const levelDb = dbBelow(
    peakOf(slice.subarray(0, Math.min(slice.length, Math.round((toSec - fromSec) * sampleRate)))),
    takePeak
  );
  if (levelDb < FILL_FLOOR_DB) return { ok: false, why: 'quiet', ...frames(end) };

  return { ok: true, toSec, midi, centsSpread: Number(spread.toFixed(1)), levelDb, ...frames(end) };
}

/**
 * The gap-fill reader: `readNoteEvidence` at the constants a FILL has always used.
 *
 * Kept as a named wrapper rather than folded into the call site so that "what a fill requires"
 * stays one decision in one place, and so the transcriber's different floor is visibly a
 * different caller's choice rather than a change to this pass.
 */
function fillFromEvidence(
  pcm: Float32Array,
  sampleRate: number,
  takePeak: number,
  fromSec: number,
  limitSec: number
): FillEvidence {
  return readNoteEvidence(pcm, sampleRate, takePeak, fromSec, limitSec);
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

/**
 * How far a missed attack's region MAY run: to the next attack, to the next note, or to the end
 * of the recording — whichever comes first — and never into a note the engine did write.
 *
 * An upper bound and nothing more. There is no length cap here any more; where the note really
 * ends is `fillFromEvidence`'s question, and it is answered from the audio.
 */
function regionAfter(
  atSec: number,
  clustered: ReadonlyArray<Onset>,
  notes: ReadonlyArray<AutoEditNote>,
  durationSec: number
): { fromSec: number; toSec: number } | null {
  let end = durationSec > 0 ? durationSec : Infinity;
  for (const o of clustered) {
    if (o.timeSec > atSec + 1e-6 && o.timeSec < end) end = o.timeSec;
  }
  for (const n of notes) {
    if (n.startSec > atSec && n.startSec - SILENCE_MARGIN_SEC < end) end = n.startSec - SILENCE_MARGIN_SEC;
  }
  if (!(end > atSec) || !Number.isFinite(end)) return null;
  // And the engine must be silent across ALL of it, not merely at its two ends.
  for (const n of notes) {
    if (n.endSec > atSec && n.startSec < end) return null;
  }
  return { fromSec: atSec, toSec: end };
}

/**
 * The take's own loudest sample — the reference `FILL_FLOOR_DB` is measured against.
 *
 * Exported so the transcriber measures its floor against exactly the same number this pass
 * does. Two definitions of "the take's peak" would put the two passes' silence gates in
 * different places, and they are supposed to agree about what is too quiet to be a note.
 */
export function takePeakOf(pcm: Float32Array): number {
  return peakOf(pcm);
}

function peakOf(pcm: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
    if (v > peak) peak = v;
  }
  return peak;
}

function dbBelow(value: number, reference: number): number {
  if (!(value > 0) || !(reference > 0)) return -Infinity;
  return 20 * Math.log10(value / reference);
}

// `steadyPitch` used to live here: one pitch verdict over a whole fixed-length candidate. It is
// gone with the two-second cap it served, and `fillFromEvidence` does its job frame by frame —
// which is what makes a fill's LENGTH a measurement rather than a constant. The gates it applied
// (`FILL_AGREEMENT`, `FILL_MIN_FRAMES`, `FILL_CENTS_SPREAD`) all survive, applied to the span
// the evidence actually supports instead of to the span somebody guessed at.

// ---------------------------------------------------------------------------
// Applying it — still pure. The caller commits the result.
// ---------------------------------------------------------------------------

export interface AppliedAutoEdit {
  kind: 'split' | 'fill';
  /** The notes this produced, in time order. A split makes two; a fill makes one. */
  noteIds: string[];
  atSec: number;
  fromSec: number;
  toSec: number;
  /** What the popover says. */
  title: string;
}

export interface AutoEditApplication<T extends AutoEditNote> {
  notes: T[];
  applied: AppliedAutoEdit[];
}

/**
 * Turn accepted proposals into a new performance.
 *
 * NOTES ARE REPLACED, NEVER MUTATED — the same rule `edit/rollPerformance.ts` states and for
 * the same reason: the undo stack holds arrays of references, so mutating one in place would
 * rewrite history as well as the present.
 *
 * The first fragment of a split KEEPS THE ORIGINAL ID. Notation edits are keyed by note id and
 * replayed over every rebuild, so an id that vanished would silently drop a pitch change the
 * player had already made on that note.
 */
export function applyAutoEdits<T extends AutoEditNote>(
  notes: ReadonlyArray<T>,
  plan: AutoEditPlan,
  newId: () => string
): AutoEditApplication<T> {
  const applied: AppliedAutoEdit[] = [];

  // Group the splits by note, so a note cut in two places is handled once and in order.
  const byNote = new Map<string, SplitProposal[]>();
  for (const s of plan.splits) {
    const list = byNote.get(s.noteId);
    if (list) list.push(s);
    else byNote.set(s.noteId, [s]);
  }
  for (const list of byNote.values()) list.sort((a, b) => a.atSec - b.atSec);

  const out: T[] = [];
  for (const note of notes) {
    const cuts = note.id ? byNote.get(note.id) : undefined;
    if (!cuts || cuts.length === 0) {
      out.push(note);
      continue;
    }
    let left = note.startSec;
    const pieces: T[] = [];
    const ids: string[] = [];
    for (const cut of cuts) {
      const id = pieces.length === 0 ? note.id! : newId();
      // `endPrevSec`, not `atSec`: when a mute was heard the previous note really did stop
      // before the next one started, and that gap is the performance. Equal to `atSec` for an
      // ordinary split, so the abutting case is unchanged. See §MUTES.
      pieces.push({ ...note, id, startSec: left, endSec: Math.max(left, cut.endPrevSec) });
      ids.push(id);
      left = cut.atSec;
    }
    const tailId = newId();
    pieces.push({ ...note, id: tailId, startSec: left, endSec: note.endSec });
    ids.push(tailId);
    out.push(...pieces);
    applied.push({
      kind: 'split',
      noteIds: ids,
      atSec: cuts[0].atSec,
      fromSec: note.startSec,
      toSec: note.endSec,
      title: 'Split by Riffsheet'
    });
  }

  for (const fill of plan.fills) {
    const id = newId();
    out.push({
      // `as unknown as T` and not a cast on the object: T may carry importer fields (source
      // ticks, staff, bar) and an invented note has none of them — it belongs to the audio,
      // not to a symbolic source.
      id,
      startSec: fill.fromSec,
      endSec: fill.toSec,
      midi: fill.midi
    } as unknown as T);
    applied.push({
      kind: 'fill',
      noteIds: [id],
      atSec: fill.fromSec,
      fromSec: fill.fromSec,
      toSec: fill.toSec,
      title: 'Added by Riffsheet'
    });
  }

  out.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  return { notes: out, applied };
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
 */
export function revertAutoEdit<T extends AutoEditNote>(
  notes: ReadonlyArray<T>,
  edit: AppliedAutoEdit
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
