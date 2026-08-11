/**
 * THE EDIT BRAIN — one set of numbers and one set of rules about where notes begin and end.
 *
 * ===========================================================================================
 * WHY THIS FILE EXISTS, WHICH IS A BUG REPORT
 * ===========================================================================================
 * Riffsheet has two pieces of code that ask the same question of the same recording:
 *
 *   - `audio/riffsheetEngine.ts` — the transcriber. Where does a note start, how long did it
 *     last, was there anything there at all.
 *   - `edit/autoEdits.ts` — the auto-split / gap-fill pass, which runs after every
 *     transcription and argues with it in the player's favour: an attack inside a note means
 *     two notes, a steady pitch where the engine wrote nothing means a missed note.
 *
 * The pass is the app's most trusted output — the green edits are the ones the player believes,
 * and the engine was written to bake that trust in. So the pass finding work to do on the
 * ENGINE'S OWN OUTPUT is not a nice-to-have inconsistency. It is the app saying two different
 * things about the same audio at the same time, and it was observed: three auto edits on a take
 * the app itself had just transcribed.
 *
 * The cause was not a subtle numerical disagreement. The two implementations answered
 * DIFFERENT QUESTIONS with SIMILAR-LOOKING numbers:
 *
 *  1. MUTES. The engine's rule is "a hand landing on the strings ENDS a note and starts
 *     nothing". The pass has no such rule — every clustered attack it cannot account for is a
 *     candidate for a filled note, mutes included. So the engine deliberately left a stretch
 *     empty and the pass immediately filled it. (Reproduced: `two-mutes` below.)
 *  2. WHICH MUTE ENDS THE NOTE. The engine kept the LAST standalone mute after a note start
 *     instead of the FIRST, so a note ran straight through an earlier mute — and a cluster
 *     winner sitting strictly inside a note is exactly what the pass calls a split.
 *     (Reproduced: `palm-mute` below.)
 *  3. TWO PROFILES OF THE SAME READER. `readNoteEvidence` takes a minimum length and a voting
 *     lead. A fill uses 150/150 ms; the transcriber uses 60/100 ms, for the good reason that a
 *     thirty-second note at 120 BPM is 62 ms and refusing to write it down would be a bug. Two
 *     profiles is fine. Two profiles that never meet is not: a gap the engine's read rejected
 *     could still satisfy the fill's read, and then the pass wrote a note the engine had
 *     already decided against.
 *
 * ===========================================================================================
 * WHAT THIS FILE GUARANTEES
 * ===========================================================================================
 * Everything both consumers use lives here exactly once: the constants, the clustering, the
 * mute classifier, the evidence reader, and — the part that actually matters — `planEdits`,
 * the decision procedure, and `settle`, which applies that procedure to a note list until it
 * has nothing left to say.
 *
 * The transcriber ends by calling `settle`. The pass in `ui/app.ts` is the SAME `planEdits`
 * call on the same audio, so it finds nothing:
 *
 *     THE ENGINE'S OUTPUT IS A FIXED POINT OF THE PASS.
 *
 * That is a property, it is asserted in `edit/editBrain.test.ts` over constructed cases, and it
 * is what lets the pass stay in the UI flow as a cheap idempotence proof that reads 0.
 *
 * The one asymmetry, and it is deliberate: the transcriber settles against `MIN_FRAGMENT_SEC`
 * (see `floorSec`), the smallest split floor `fragmentFloorSec` can ever return. Whatever grid
 * the roll is on when the pass runs, its floor is at least that, so the pass can only ever be
 * MORE reluctant to split than the engine already was. Fewer proposals than zero is still zero.
 *
 * PURE AND OFFLINE, like everything it is built on: samples and times in, decisions out. No
 * DOM, no fetch, no clock, no `Math.random`. It runs inside a plugin's web view and it has to
 * give the same answer twice.
 *
 * EVERY TIME IS ON THE RECORDING'S CLOCK — the same clock as `Onset.timeSec`, the waveform and
 * `source.detected.notes`. Written score seconds never appear in this file.
 */

import type { Onset } from '../audio/onsets';
import { detectPitchTrack, type PitchReading } from '../audio/pitch';

/** The minimum a caller has to supply per note. `InputNote` and `RiffsheetNote` satisfy it. */
export interface EditNote {
  id?: string;
  startSec: number;
  endSec: number;
  midi: number;
}

// ---------------------------------------------------------------------------
// The numbers. Every one of them is a decision, and each says what it costs.
//
// They are exported because the two consumers must not be able to hold a private copy of one.
// A number that appears twice in this codebase is a number that will disagree with itself.
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
export const CLUSTER_SEC = 0.07;

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
export const MIN_FRAGMENT_SEC = 0.12;

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
export const GRID_FRACTION = 0.5;
export const GRID_FLOOR_CAP_SEC = 0.25;

/** A gap-fill region has to last at least this long. Stricter than a split, by design. */
export const MIN_FILL_SEC = 0.15;

/**
 * A FILL ENDS WHERE ITS EVIDENCE ENDS. There is no maximum length.
 *
 * There used to be one — two seconds — and the reasoning was that past a couple of seconds
 * "the engine heard nothing and the tracker heard one steady pitch" stops being a missed note
 * and starts being a drone, a hum or feedback. That reasoning was about the WRONG QUANTITY. A
 * cap is a guess about how long a note can be; the take itself already says how long this one
 * was, and a bass note left to ring is routinely longer than two seconds.
 *
 * What replaced it is a measurement — see `readNoteEvidence`. `EVIDENCE_HOP_SEC` is the frame.
 * 20 ms is short enough that the end lands within a fortieth of a second of the truth and long
 * enough that the pitch tracker has something to work with.
 */
export const EVIDENCE_HOP_SEC = 0.02;
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
export const EVIDENCE_END_FRAMES = 3;

/**
 * How much the tracker is allowed to wander inside a region and still count as ONE note.
 *
 * ±50 cents is half a semitone: the point at which the reading would round to a different note
 * name. Wider than that is not a stable pitch, it is a slide or two notes.
 */
export const FILL_CENTS_SPREAD = 50;
/** At least this share of the region's frames must have found that same pitch. */
export const FILL_AGREEMENT = 0.6;
/** ...over at least this many frames, so a two-frame coincidence cannot qualify. */
export const FILL_MIN_FRAMES = 3;

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
export const FILL_FLOOR_DB = -40;

/** How close a detected attack has to be to a note's onset to count as already explained. */
export const ONSET_MATCH_SEC = 0.06;
/** A gap-fill region must clear existing notes by this much at both ends. */
export const SILENCE_MARGIN_SEC = 0.02;

/**
 * The TRANSCRIBER's profile of the same two knobs `readNoteEvidence` takes.
 *
 * A fill uses `MIN_FILL_SEC` for both, because a fill that short is not worth an automatic
 * edit and a fill votes over its own minimum length. A transcriber cannot use those numbers: a
 * sixteenth at 200 BPM is 75 ms and a thirty-second at 120 is 62 ms, and refusing to write
 * those down would be a bug rather than caution. 60 ms is one hop under the shorter of them
 * and comfortably above the 30 ms `MIN_SPACING_SEC` at which the attack detector stops
 * resolving two events at all, so the floor that actually binds is the detector's — the honest
 * place for it to bind.
 *
 * TWO PROFILES ARE FINE. TWO PROFILES THAT NEVER MEET ARE NOT — see the header, cause 3. The
 * meeting point is `settle`: whatever the engine's profile declined to write, the fill profile
 * gets its own look at before the take leaves the engine, using this file's rules and nobody
 * else's.
 */
export const ENGINE_MIN_NOTE_SEC = 0.06;
/**
 * How much of a segment's opening decides which note it is: 100 ms, or the segment, whichever
 * is shorter. Long enough for five 20 ms frames to vote, short enough to fit inside a fast note
 * rather than voting across the next one.
 */
export const ENGINE_LEAD_SEC = 0.1;

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
export const MUTE_WINDOW_SEC = 0.04;
/**
 * ...starting this far from the line itself.
 *
 * The line is the transient, and the transient belongs to neither side: a mute's own contact
 * noise is a burst of energy, so a window flush against the line would measure the damping as
 * a rise. 5 ms clears it.
 */
export const MUTE_GUARD_SEC = 0.005;
/** After/before energy ratio at or below this is a mute. −6 dB: the sound is being stopped. */
export const MUTE_FALL_RATIO = 0.5;
/** ...and at or above this is an attack. +4 dB. Between the two, nobody is claiming to know. */
export const MUTE_RISE_RATIO = 1.6;

/**
 * How many times `settle` may re-ask before it accepts the answer it has.
 *
 * Two is the honest number and the third is paranoia. Round one is where everything happens.
 * Round two exists because writing a note CHANGES THE QUESTION for its neighbours — a new note
 * is a new boundary, so the region beside it is shorter, and a shorter region is judged on
 * fewer frames — so a decision made in round one can open one more in round two. Round three
 * has never fired on anything that has been put through it, and it is here so that a take that
 * somehow oscillates comes out of this function rather than staying in it.
 */
export const SETTLE_MAX_ROUNDS = 3;

// ---------------------------------------------------------------------------
// Clustering — no raw detector line is ever acted on
// ---------------------------------------------------------------------------

/** One cluster: the line the brain reasons with, and every line that collapsed into it. */
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
 * would rather draw what the brain believed than what the detector said.
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
export function mutesBeforeWinners(
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

/** The floor a split fragment must clear, for this take's grid. See `GRID_FRACTION`. */
export function fragmentFloorSec(snapSec: number): number {
  const grid = Number.isFinite(snapSec) && snapSec > 0 ? snapSec * GRID_FRACTION : 0;
  return Math.max(MIN_FRAGMENT_SEC, Math.min(GRID_FLOOR_CAP_SEC, grid));
}

// ---------------------------------------------------------------------------
// The evidence reader — the one walk both consumers do
// ---------------------------------------------------------------------------

/**
 * What the frame-by-frame walk found, plus the frames it walked.
 *
 * The readings are handed back rather than thrown away because the transcriber needs to ask two
 * more questions of exactly the same frames: *did the tracker keep flipping octaves here* and
 * *were two different notes sounding at once*. Re-running `detectPitchTrack` to ask them would
 * double the cost of the expensive half of the work for evidence already computed and discarded.
 *
 * `readings` covers the whole CANDIDATE span (`fromSec` to `limitSec`), not the span that
 * survived: `keptFrames` says where the note ended, and the frames after it are still evidence
 * about what was going on. `hopSec` is the lattice, so frame *i* starts at `fromSec + i*hopSec`.
 */
export type NoteEvidence = { readings: PitchReading[]; keptFrames: number; hopSec: number } & (
  | {
      ok: true;
      toSec: number;
      midi: number;
      centsSpread: number;
      levelDb: number;
      /**
       * The gate's own number: the share of ALL surviving frames that read this note. This is
       * what `FILL_AGREEMENT` is measured against, so it is reported rather than recomputed.
       */
      agreement: number;
      /**
       * The share of the surviving frames THAT HAD A PITCH AT ALL that read this note.
       *
       * A different question and the honest one to show a player as confidence: every frame
       * that voted had already cleared the tracker's own clarity floor, so what is left to be
       * unsure about is the disagreement between frames — not the frames where the tracker said
       * nothing, which are routine inside an attack transient.
       */
      pitchAgreement: number;
    }
  | { ok: false; why: 'quiet' | 'unpitched' | 'short' }
);

/** How the caller may move the two length constants. Defaults are the gap-fill values. */
export interface NoteEvidenceOptions {
  /** Shortest span worth reporting. See `ENGINE_MIN_NOTE_SEC` for why there are two profiles. */
  minSec?: number;
  /** How much of the region's opening decides WHICH note this is. Same reasoning. */
  leadSec?: number;
}

/** The gap-fill profile: what a FILL has always required. The default, and the strict one. */
export const FILL_PROFILE: Required<NoteEvidenceOptions> = {
  minSec: MIN_FILL_SEC,
  leadSec: MIN_FILL_SEC
};
/** The transcriber's profile. See `ENGINE_MIN_NOTE_SEC`. */
export const ENGINE_PROFILE: Required<NoteEvidenceOptions> = {
  minSec: ENGINE_MIN_NOTE_SEC,
  leadSec: ENGINE_LEAD_SEC
};

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
  const minSec = opts.minSec ?? FILL_PROFILE.minSec;
  const leadSec = opts.leadSec ?? FILL_PROFILE.leadSec;
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

  const keptPitched = kept.filter((r) => r.midi !== null).length;
  return {
    ok: true,
    toSec,
    midi,
    centsSpread: Number(spread.toFixed(1)),
    levelDb,
    agreement: agreeing.length / kept.length,
    pitchAgreement: keptPitched > 0 ? agreeing.length / keptPitched : 0,
    ...frames(end)
  };
}

/**
 * The take's own loudest sample — the reference `FILL_FLOOR_DB` is measured against.
 *
 * Exported so the transcriber measures its floor against exactly the same number the pass does.
 * Two definitions of "the take's peak" would put the two silence gates in different places, and
 * they are supposed to agree about what is too quiet to be a note.
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

// ---------------------------------------------------------------------------
// What the brain produces
// ---------------------------------------------------------------------------

export interface SplitProposal {
  kind: 'split';
  /** The note to divide. */
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
  /**
   * How much the frames agreed, 0..1, counting only frames that had a pitch.
   *
   * Here because a transcriber that writes this note down has to put a confidence on it, and
   * the only honest one is the one the evidence measured. See `NoteEvidence.pitchAgreement`.
   */
  agreement: number;
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

export interface EditPlan {
  splits: SplitProposal[];
  fills: FillProposal[];
  attention: AttentionMark[];
  /** The attacks the brain actually reasoned with — after clustering, never the raw list. */
  clusteredOnsets: Onset[];
  /** Every cluster, with what collapsed into it. The pass reports how many held a mute. */
  clusters: OnsetCluster[];
  /** Cluster winners whose cluster also held a mute before them. */
  mutedClusters: number;
  /** The split floor this plan was made with. */
  floorSec: number;
}

export interface EditPlanInput {
  /** The performance as it stands (engine output, plus any edits already made). */
  notes: ReadonlyArray<EditNote>;
  /** Raw detector output. Clustered here — a caller never has to remember to do it. */
  onsets: ReadonlyArray<Onset>;
  /** The decoded mono take. Without it, gap-fill cannot run and only splits are proposed. */
  pcm: Float32Array | null;
  sampleRate: number;
  /**
   * The floor both halves of a split must clear. `fragmentFloorSec(snapSec)` for the UI pass;
   * `MIN_FRAGMENT_SEC` for the transcriber, which has no grid — see the header.
   */
  floorSec: number;
  /**
   * Notes the player has edited by hand. Exempt: an automatic pass must never argue with
   * somebody who has already looked at that note and decided.
   */
  userTouchedIds?: ReadonlySet<string>;
  /** How long the recording is, so a region cannot run off the end of it. */
  durationSec: number;
}

// ---------------------------------------------------------------------------
// The decision procedure. This is the brain.
// ---------------------------------------------------------------------------

/**
 * Work out what the brain would do to this performance. Decides nothing about whether to do it.
 *
 * Called by the pass on every fresh transcription with the toggle ON or OFF (the difference is
 * what the caller does with the result, not whether the thinking happens), and called by the
 * TRANSCRIBER on its own output before it hands it over — which is what makes the pass's answer
 * on a Riffsheet-engine take zero.
 */
export function planEdits(input: EditPlanInput): EditPlan {
  const floor = input.floorSec;
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
  let mutedClusters = 0;
  for (const c of clusters) if (muteBefore.has(c.winner.timeSec)) mutedClusters++;

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
    }
  }

  // --- gap fills ---------------------------------------------------------------------
  const pcm = input.pcm;
  const rate = input.sampleRate;
  const takePeak = pcm && rate > 0 ? peakOf(pcm) : 0;

  for (const onset of clustered) {
    // Does the performance already explain this attack? Either a note starts on it, or one is
    // sounding across it. Both mean nothing is missing here.
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

    // The region is now only an UPPER BOUND — the next thing the performance or the detector
    // knows about. Where the note really ends is a question for the recording, asked frame by
    // frame, at the FILL profile: a written note is an invention and pays the stricter price.
    const evidence = readNoteEvidence(pcm, rate, takePeak, region.fromSec, region.toSec, FILL_PROFILE);
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
      levelDb: evidence.levelDb,
      agreement: evidence.pitchAgreement
    });
  }

  return { splits, fills, attention, clusteredOnsets: clustered, clusters, mutedClusters, floorSec: floor };
}

/**
 * How far a missed attack's region MAY run: to the next attack, to the next note, or to the end
 * of the recording — whichever comes first — and never into a note that was already written.
 *
 * An upper bound and nothing more. There is no length cap here; where the note really ends is
 * `readNoteEvidence`'s question, and it is answered from the audio.
 *
 * Exported because it is also the answer to "could an attack here ever become a note?", which
 * is a question the transcriber's own segmentation has to agree with.
 */
export function regionAfter(
  atSec: number,
  clustered: ReadonlyArray<Onset>,
  notes: ReadonlyArray<EditNote>,
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
  // And nothing may already be sounding across ANY of it, not merely at its two ends.
  for (const n of notes) {
    if (n.endSec > atSec && n.startSec < end) return null;
  }
  return { fromSec: atSec, toSec: end };
}

// ---------------------------------------------------------------------------
// Applying it — still pure. The caller commits the result.
// ---------------------------------------------------------------------------

export interface AppliedEdit {
  kind: 'split' | 'fill';
  /** The notes this produced, in time order. A split makes two; a fill makes one. */
  noteIds: string[];
  atSec: number;
  fromSec: number;
  toSec: number;
  /** What the popover says. */
  title: string;
}

export interface EditApplication<T extends EditNote> {
  notes: T[];
  applied: AppliedEdit[];
}

export interface ApplyOptions<T extends EditNote> {
  /** Ids for the notes this creates. */
  newId: () => string;
  /**
   * How to build the note a FILL adds, when the caller's note type carries more than the four
   * fields a proposal knows about.
   *
   * The default keeps only those four, deliberately: `T` may carry importer fields (source
   * ticks, staff, bar) and an invented note has none of them — it belongs to the audio, not to
   * a symbolic source. A transcriber overrides it because its notes carry a confidence, and the
   * only honest confidence for a filled note is the one its own evidence measured.
   */
  fillNote?: (fill: FillProposal, id: string) => T;
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
export function applyEdits<T extends EditNote>(
  notes: ReadonlyArray<T>,
  plan: Pick<EditPlan, 'splits' | 'fills'>,
  opts: ApplyOptions<T>
): EditApplication<T> {
  const applied: AppliedEdit[] = [];
  const newId = opts.newId;

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
    out.push(
      opts.fillNote
        ? opts.fillNote(fill, id)
        : ({ id, startSec: fill.fromSec, endSec: fill.toSec, midi: fill.midi } as unknown as T)
    );
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

// ---------------------------------------------------------------------------
// The fixed point
// ---------------------------------------------------------------------------

export interface SettleContext<T extends EditNote> {
  onsets: ReadonlyArray<Onset>;
  pcm: Float32Array | null;
  sampleRate: number;
  durationSec: number;
  /**
   * The split floor. Defaults to `MIN_FRAGMENT_SEC`, which is the right answer for a caller
   * with no grid: it is the smallest value `fragmentFloorSec` can return, so settling against
   * it makes this the most willing splitter in the app, and a later pass on a coarser grid can
   * only be more reluctant. See the header.
   */
  floorSec?: number;
  newId: () => string;
  fillNote?: (fill: FillProposal, id: string) => T;
}

export interface SettleResult<T extends EditNote> {
  notes: T[];
  /** How many splits and fills the brain had to make. On a settled input, both are zero. */
  splits: number;
  fills: number;
  /** How many rounds changed something. Zero means the input was already a fixed point. */
  rounds: number;
  /** True when the last round proposed nothing — i.e. `planEdits` on `notes` is now empty. */
  settled: boolean;
}

/**
 * Apply the brain's own verdict to a performance until it has nothing left to say.
 *
 * THIS IS WHAT MAKES THE TRANSCRIBER'S OUTPUT A FIXED POINT OF THE PASS. Not a tidy-up and not
 * a second opinion: it is the same `planEdits` the pass runs, applied by the same `applyEdits`,
 * so whatever the pass would have proposed has already been done by the time the take leaves
 * the engine — and the pass, run again on the result, proposes nothing.
 *
 * It loops because writing a note CHANGES THE QUESTION for the region beside it (a new note is
 * a new boundary), so one decision can open one more. See `SETTLE_MAX_ROUNDS`. It stops the
 * moment a round proposes nothing, which on real takes is round one or two.
 */
export function settle<T extends EditNote>(
  notes: ReadonlyArray<T>,
  ctx: SettleContext<T>
): SettleResult<T> {
  let current: T[] = [...notes];
  let splits = 0;
  let fills = 0;
  let rounds = 0;
  let settled = false;
  const floorSec = ctx.floorSec ?? MIN_FRAGMENT_SEC;

  for (let round = 0; round < SETTLE_MAX_ROUNDS; round++) {
    const plan = planEdits({
      notes: current,
      onsets: ctx.onsets,
      pcm: ctx.pcm,
      sampleRate: ctx.sampleRate,
      floorSec,
      durationSec: ctx.durationSec
    });
    if (plan.splits.length === 0 && plan.fills.length === 0) {
      settled = true;
      break;
    }
    splits += plan.splits.length;
    fills += plan.fills.length;
    rounds++;
    const applyOpts: ApplyOptions<T> = ctx.fillNote
      ? { newId: ctx.newId, fillNote: ctx.fillNote }
      : { newId: ctx.newId };
    current = applyEdits(current, plan, applyOpts).notes;
  }

  return { notes: current, splits, fills, rounds, settled };
}
