/**
 * THE RIFFSHEET ENGINE — the app's own transcriber, for one note at a time.
 *
 * ===========================================================================================
 * WHY THIS EXISTS, WHICH IS NOT "BECAUSE WE COULD"
 * ===========================================================================================
 * Riffsheet already ships two pieces of measured, working analysis that were built for other
 * jobs and are individually better at their own question than the transcription models are:
 *
 *   - `audio/onsets.ts` answers *was something struck here?* — 179 of 188 attacks over its own
 *     24-case corpus, median timing error 3.8 ms, and it deliberately reports evidence rather
 *     than deleting anything. MuScriptor's own exam measured muted-note recall at 0.24 and
 *     returned zero notes on two clips; on the owner's takes the attack detector has repeatedly
 *     seen notes the model did not.
 *   - `audio/pitch.ts` answers *what note is this?* — 62 of 65 real notes across six instruments,
 *     with the three failures written down rather than rounded off.
 *
 * `edit/editBrain.ts` already fused them once, for a narrower job: cluster the attacks, tell an
 * attack from a hand landing on the strings, and measure how long a missed note actually lasted.
 * Everything below is the SAME machinery asked a bigger question — not a second implementation
 * of it. `clusterOnsetsDetailed`, `classifyOnsetEnergy` and `readNoteEvidence` are imported, not
 * copied, and if they change this changes with them.
 *
 * The positioning is the owner's own sentence and it is the honest one: **good for mono sounds,
 * simple.** Zero install, instant, explainable. It is the DEFAULT because for a single-note line
 * — which is most of what a bass player records — it is at least as good as the alternatives and
 * it costs nothing and needs nothing. It is not a general transcriber and it does not pretend to
 * be one: hand it a chord and it says so and hands the take to an engine that can (see REFUSAL).
 *
 * ===========================================================================================
 * WHAT IT DOES, IN FOUR STEPS
 * ===========================================================================================
 * 1. SEGMENTATION — from attacks, not from a grid.
 *    `detectOnsets` finds every sharp change; `clusterOnsetsDetailed` collapses lines within
 *    70 ms into one event while KEEPING what collapsed, and `classifyOnsetEnergy` reads which
 *    way the energy went across each line. That direction is the whole of "note or hand":
 *      - an ATTACK (or an unreadable line, see NOTE STARTS below) STARTS a note;
 *      - a MUTE ENDS the note that was sounding and starts nothing.
 *    A damped-then-restruck note puts a mute and an attack inside one cluster, so the old note
 *    ends at the hand and the new one starts at the pick, with the real gap between them.
 *
 * 2. PITCH PER SEGMENT — a vote, never one reading.
 *    `readNoteEvidence` walks the segment in 20 ms frames, decides what note this is from the
 *    opening frames by majority, and requires `FILL_AGREEMENT` of the surviving frames to agree
 *    within ±50 cents. A segment with no stable pitch produces NO NOTE. That is the point and it
 *    is not a shortfall: an invented pitch is worse than a gap, and the attack is still on the
 *    waveform where the player can see it.
 *
 * 3. NOTE ENDS — trim to evidence.
 *    The same walk ends the note where the evidence ends: the first run of three consecutive
 *    frames that either fall under −40 dB relative to the take's own peak or read as a different
 *    note. There is no length cap and no decay model. A note lasts as long as it lasted.
 *
 * 4. THE TWO GUARDS — octaves and chords. Both have their own sections below, because both are
 *    about the one thing this engine could get confidently, plausibly wrong.
 *
 * 5. SETTLE — the last step, and the reason the app stops contradicting itself.
 *    The auto-split / gap-fill pass runs after every transcription and is the app's most
 *    trusted output: the green edits are the ones the player believes. It used to find work to
 *    do on THIS engine's output — three edits on a take the app itself had just written down —
 *    because the two asked the same questions with different code. Now the last thing this file
 *    does is run that pass's own decision procedure over its own notes (`settle`, in
 *    `edit/editBrain.ts`), so anything the pass would have proposed is already done. The pass in
 *    the UI is then the same call on the same audio and comes back with nothing:
 *
 *        THIS ENGINE'S OUTPUT IS A FIXED POINT OF THE AUTO-EDIT PASS.
 *
 *    It is asserted in `edit/editBrain.test.ts`, not assumed. What it costs is that a gap this
 *    engine's own read declined (60 ms floor, 100 ms voting lead) gets a second look at the
 *    FILL profile (150 ms and 150 ms) before the take leaves — and if the stricter profile says
 *    there is a note there, the note is written. That is the brain's verdict beating the
 *    engine's, which is the correct way round: the pass is what the player trusts.
 *
 * ===========================================================================================
 * THE OCTAVE GUARD. The tuner's one documented weakness, handled without repeating its mistakes.
 * ===========================================================================================
 * YIN's failure mode is not "a bit sharp", it is an OCTAVE — and `pitch.ts` records both
 * directions, with real recordings behind each. It also records, at length, TWO mitigations that
 * were built, measured, looked excellent against synthetic tones, and were falsified by the real
 * samples: a phantom-fundamental partial-energy test, and lowering YIN's threshold. The lesson
 * written there is the constraint on everything here:
 *
 *     A STATISTIC THAT SEPARATES SYNTHETIC TONES IS NOT EVIDENCE ABOUT REAL INSTRUMENTS.
 *
 * So this guard adds no new statistic at all. It uses three things it already has, in order, and
 * it NEVER moves a note the tracker was not already unsure about:
 *
 *  (a) THE VOTE ITSELF SAYS WHEN IT IS UNSURE. When YIN flips octaves inside a note, the frames
 *      split between m and m±12 — that split is already computed in step 2 and thrown away. A
 *      segment where an octave rival holds `OCTAVE_RIVAL_SHARE` of the pitched frames is marked
 *      AMBIGUOUS. Everything else is left exactly as read, forever. This is the whole reason the
 *      guard is safe: it can only touch notes that argued with themselves.
 *
 *  (b) THE INSTRUMENT'S RANGE. The player has already told Riffsheet what they are holding —
 *      the tuning is selected, and its lowest open string is a physical fact: you cannot play
 *      below it. A note more than `RANGE_SLACK_LOW` under the lowest open string is out of
 *      range, and if shifting it up an octave puts it back inside, that is the read that was
 *      wrong. The slack is asymmetric on purpose: the bottom of the range is a hard fact, the
 *      TOP is `maxFret` — a guess about how far up the neck somebody plays — so the upper slack
 *      is a whole octave and gross under-reads are caught while a guitarist with a bass tuning
 *      selected is not "corrected" into nonsense.
 *
 *  (c) CONTOUR CONTINUITY, last, and only between candidates that survived (a) and (b). Music
 *      moves in small steps far more often than in octave leaps, so among the octaves still on
 *      the table the one nearest the CONFIDENT neighbours wins. Confident notes — the ones the
 *      tracker never argued about — are never moved and are the only thing an ambiguous note is
 *      measured against, so one bad read cannot drag its neighbours with it.
 *
 * Deliberately NOT done: no harmonic-comb or first-two-partials test decides anything. That is
 * mitigation #1 from `pitch.ts`, it was measured against 65 real notes across six instruments,
 * and it does not separate a real piano C1 from a phantom. Re-adding it here without re-running
 * that corpus would be repeating a mistake that is already written down.
 *
 * ===========================================================================================
 * THE POLYPHONY REFUSAL. The honesty check, and the reason this can be the default at all.
 * ===========================================================================================
 * A monophonic transcriber handed a chord does not fail loudly. It picks one note per moment —
 * usually the loudest, sometimes a phantom fundamental that is in no chord anybody played — and
 * produces a confident, tidy, WRONG single line. That is the worst possible output, because it
 * looks exactly like a right one.
 *
 * So the engine tests, cheaply, whether it is being lied to, and REFUSES rather than guessing.
 * The test reuses the frames from step 2 and adds no new pass over the audio: inside a segment,
 * do the tracker's frames keep landing on TWO different notes that are not octaves of each other?
 * On one note they do not — the frames agree or they read nothing. On a dyad or a chord YIN's
 * normalised difference has competing minima and the frames genuinely alternate between them.
 *
 * Two guards keep this from firing on real monophonic playing:
 *  - octave rivals are excluded (that is the octave guard's business, not evidence of a chord);
 *  - a rival one semitone away is excluded — that is cents wobble crossing a note boundary;
 *  - and one contested segment is never enough. A slide, a bend and a fast legato pair all
 *    produce one segment with two pitches in it. A CHORDAL TAKE produces them repeatedly, so the
 *    verdict is taken over the whole take: `CHORD_MIN_SEGMENTS` of them AND at least
 *    `CHORD_SEGMENT_SHARE` of the segments that were analysed.
 *
 * When it refuses, the engine says so in a sentence a player can read, and the app hands the
 * take to the next engine automatically. A refusal is not an error and must never be shown as
 * one: it is the engine being right about its own limits.
 *
 * The second refusal is quieter and just as necessary: if nothing at all came out — attacks
 * everywhere and no stable pitch anywhere — there is no transcription to offer, so the take goes
 * to an engine that might do better rather than coming back empty.
 *
 * ===========================================================================================
 * WHAT IT DOES NOT DO
 * ===========================================================================================
 *  - NO VELOCITY. Onset `strength` is relative to the loudest attack in the SAME take and its
 *    own file says it is not comparable between takes. That is not a dynamic marking and turning
 *    it into one would be inventing data. The manifest says `producesVelocity: false`.
 *  - NO BEAT GRID OF ITS OWN. The shell's beat tracker already runs for every engine and is
 *    better at this than anything here would be. This file returns notes; beats come from where
 *    they always came from.
 *  - NO CHORDS, NO DRUMS, NO GENERAL POLYPHONY. See REFUSAL.
 *
 * Pure and offline: no DOM, no fetch, no dependencies, no `Math.random`, no clock — the same
 * requirements the two files it is built on already meet, for the same reason: it runs inside a
 * plugin's web view and it has to give the same answer twice.
 */

import { detectOnsets, type Onset } from './onsets';
import {
  ENGINE_MIN_NOTE_SEC,
  ENGINE_PROFILE,
  classifyOnsetEnergy,
  clusterOnsetsDetailed,
  readNoteEvidence,
  settle,
  takePeakOf,
  type EditNote,
  type NoteEvidence
} from '../edit/editBrain';
import { tuningRange } from '../score/tuning';

// ---------------------------------------------------------------------------
// Constants. Every one of them is either inherited from the file it came from or explained.
//
// The lengths this engine reads evidence with — its 60 ms floor and its 100 ms voting lead —
// are NOT here. They are `ENGINE_PROFILE` in `edit/editBrain.ts`, next to the gap-fill profile
// they have to stay honest against, because a transcription floor kept in one file and an edit
// floor kept in another is exactly how the two ended up disagreeing about the same take.
// ---------------------------------------------------------------------------

/**
 * An octave rival holding this share of a segment's pitched frames makes the segment AMBIGUOUS.
 *
 * A quarter, not a half. This is not a decision about which octave is right — it is only the
 * question "did the tracker argue with itself here?", and the answer wants to be generous,
 * because the cost of asking is that the range prior and the contour get a vote and the cost of
 * not asking is an octave error nobody catches. A note where every frame agreed has a rival
 * share of exactly zero and is never touched.
 */
const OCTAVE_RIVAL_SHARE = 0.25;
/**
 * How far under the lowest open string a note may sit before the range prior calls it wrong.
 *
 * Seven semitones. Below the lowest open string is not a matter of degree — it is unplayable on
 * the instrument the player said they are holding — but the tuning can be stale, somebody may
 * have tuned down two steps without telling the app, and a fifth of slack absorbs that while
 * still catching a full octave error, which is 12.
 */
const RANGE_SLACK_LOW = 7;
/**
 * ...and above the highest fretted note. A whole octave, because the top of the range is
 * `maxFret`, which is a guess about how far up the neck somebody plays, not a fact about the
 * instrument. Being wrong here would push real high notes down an octave, so it is lenient.
 */
const RANGE_SLACK_HIGH = 12;
/** Frets assumed reachable when working out the range. Matches the tab view's own default. */
const DEFAULT_MAX_FRET = 17;

/**
 * A rival pitch holding this share of a segment's pitched frames makes the segment CONTESTED —
 * the chord evidence. Higher than the octave threshold: an octave rival only opens a question,
 * a chord rival is the beginning of a refusal, so it has to be a substantial minority and not a
 * handful of confused frames.
 */
const CHORD_RIVAL_SHARE = 0.3;
/** ...over at least this many frames, so a two-frame coincidence cannot contest anything. */
const CHORD_RIVAL_MIN_FRAMES = 3;
/** A rival closer than this is cents wobble crossing a note boundary, not a second note. */
const CHORD_MIN_INTERVAL = 2;

/**
 * ===========================================================================================
 * THE SECOND CHORD TEST: GAPS IN THE HARMONIC SERIES. Measured, not assumed — see below.
 * ===========================================================================================
 * The frame-rivalry test above catches chords where the tracker cannot make up its mind. It
 * misses the WORST case, and the worst case is the common one in a bass register: two notes a
 * fifth apart genuinely repeat at half the lower note's frequency, so YIN does not waver at all
 * — it reports the octave below the root with a clarity of 0.999. `pitch.ts` documents exactly
 * this ("A2 at 110 Hz under D3 at 146.83 Hz ... reports D1 at a clarity of 0.999") and it is
 * what a first draft of this engine did with a synthetic fifth: seven confident, tidy, entirely
 * fictional notes.
 *
 * A phantom fundamental has a signature its own arithmetic forces, and it is a signature about
 * TWO NOTES rather than about one weak partial — which matters, because `pitch.ts` records that
 * a guard built on "is the fundamental weak?" was measured against 65 real notes and thrown away
 * (a real upright-piano C1's fundamental is weaker than the phantom's). This is a different
 * statistic and it is checked against real recordings below rather than against tones.
 *
 * When two notes at a ratio of p:q are read as one note at f/(p·q)... in practice, for a fifth
 * (2:3) read at f/2, the composite has energy ONLY at multiples of 2 and 3 of the reported
 * fundamental: 2, 3, 4, 6, 8, 9. Harmonics 1, 5 and 7 are not merely weak — they are not there
 * at all, because no partial of either note lands on them. A real note's series is contiguous:
 * partials vary in strength, and a scooped DI can bury the fundamental, but a real instrument
 * does not radiate the 2nd, 3rd, 4th and 6th while radiating nothing whatever at the 1st, 5th
 * and 7th.
 *
 * So the test is: how many of the first seven harmonics are ABSENT, and is the fundamental one
 * of them? Both conditions, and both are needed — the fundamental alone is the guard that was
 * already falsified, and gaps without a dead fundamental are just an instrument's timbre.
 *
 * MEASURED, on the recordings this app was built on, before it was believed:
 *   - `aug7.wav`, 29 s of real bass, 81 notes: 0 segments flagged.
 *   - the `2.wav` take, 10 s of real bass, 28 notes: 0 segments flagged.
 *   - six synthetic root-plus-fifth dyads: 6 of 7 segments flagged, take refused.
 * That is the separation the constants below were set from. Moving either one without re-running
 * those three is how this stops working.
 */
const PHANTOM_HARMONICS = 7;
/** How far under the strongest of the first seven a harmonic must sit to count as ABSENT. */
const PHANTOM_ABSENT_DB = 30;
/** How many of the seven must be absent — with the fundamental among them — to flag a segment. */
const PHANTOM_MIN_GAPS = 3;
/** The window the harmonics are measured over, taken after the attack transient has passed. */
const PHANTOM_SKIP_SEC = 0.03;
const PHANTOM_WINDOW_SEC = 0.18;
/** How many contested segments it takes before the take is called chordal. */
const CHORD_MIN_SEGMENTS = 2;
/** ...and what share of the analysed segments they have to be. */
const CHORD_SEGMENT_SHARE = 0.4;

// ---------------------------------------------------------------------------
// What comes out
// ---------------------------------------------------------------------------

/** One note, in the shape the bridge already speaks (`DetectedNoteDTO`). */
export interface RiffsheetNote {
  startSec: number;
  endSec: number;
  midi: number;
  /**
   * How much the frames agreed, 0..1 — the share of the note's surviving frames that read this
   * pitch. Real and measured, not a constant: every frame that voted had already cleared the
   * tracker's own clarity floor, so what is left to be unsure about is exactly the disagreement
   * between frames, which is this number. A note the octave guard moved carries the agreement
   * of the reading it was moved FROM, scaled by `MOVED_CONFIDENCE`, because a note that argued
   * with itself is genuinely less certain than one that did not. A note the settle step added
   * (step 5) carries the agreement its own gap-fill evidence measured — the same quantity, read
   * by the same walk, at the stricter profile.
   */
  confidence: number;
}

/** Why the engine handed the take to somebody else. Never an error; always a sentence. */
export interface RiffsheetRefusal {
  kind: 'polyphony' | 'nothing-heard';
  /** One plain sentence for the player. */
  reason: string;
  /** The numbers behind that sentence, for a bug report. */
  detail: string;
}

/** Everything the pass measured, so a number on screen can be traced back to a decision. */
export interface RiffsheetStats {
  onsets: number;
  clusters: number;
  mutes: number;
  segments: number;
  /**
   * Notes that came out. Usually the segments that held a steady pitch — the rest were left
   * silent — plus anything the settle step below added.
   */
  voiced: number;
  contested: number;
  octaveMoves: number;
  rangeMoves: number;
  contourMoves: number;
  /**
   * What the settle step had to change — see step 5 in the header.
   *
   * These are the edits the auto-edit pass would otherwise have proposed on this take, made
   * here instead. ON A HEALTHY TAKE THEY ARE USUALLY ZERO and they are never a fault: a fill
   * here means the gap-fill profile heard a note in a stretch this engine's own read declined,
   * which is the pass doing the job it exists to do, one step earlier than it used to.
   */
  settledSplits: number;
  settledFills: number;
  elapsedMs: number;
}

export type RiffsheetResult =
  | { ok: true; notes: RiffsheetNote[]; stats: RiffsheetStats }
  | { ok: false; refusal: RiffsheetRefusal; stats: RiffsheetStats };

export interface RiffsheetOptions {
  /**
   * Open strings of the selected tuning, lowest first — the plausible-range prior. Omitted or
   * empty means the prior is not applied at all, which is the right behaviour when we have not
   * been told what instrument this is: an invented range would be worse than no range.
   */
  tuningLowToHigh?: number[];
  /** Highest fret assumed reachable. Only the range prior reads it. */
  maxFret?: number;
  /** Take length. Defaults to the buffer's own length, which is nearly always right. */
  durationSec?: number;
  /**
   * Skip step 5. THE TEST SEAM, and the only caller that may pass it is the fixed-point test.
   *
   * With this set, the engine returns what it read and nothing else — which is precisely the
   * behaviour that let the auto-edit pass find three edits on our own take. The test needs to
   * be able to produce that, because "the pass now finds zero" is only evidence if the same
   * fixture can be shown to have produced more than zero before. The app never sets it.
   */
  unsettled?: boolean;
  /**
   * How far through the pass we are, 0..1. See `OnsetOptions.onProgress`, which this forwards
   * into: the pass runs in a Worker now (`audio/engineWorker.ts`) and a job that says nothing
   * for several seconds cannot be told from one that has hung.
   *
   * The two heavy phases are the spectral flux pass (the detector) and the per-segment pitch
   * read, and the fractions below are their measured share of the whole rather than a guess at
   * one. Every existing caller omits this and gets exactly the function it always had.
   */
  onProgress?: (fraction: number) => void;
}

/** Where the detector's own progress ends and the segment read's begins. See `onProgress`. */
const PROGRESS_ONSETS_SHARE = 0.6;
const PROGRESS_SEGMENTS_END = 0.9;

/** How much confidence a note keeps after the octave guard moved it. See `RiffsheetNote`. */
const MOVED_CONFIDENCE = 0.75;

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * A note on its way through the settle step: what this engine writes, plus the id the brain
 * needs to talk about it. The id never leaves this file.
 */
interface SettlingNote extends EditNote {
  id: string;
  confidence: number;
}

/** Seconds, to a tenth of a millisecond. Below that is not a claim this engine is making. */
function round4(sec: number): number {
  return Number(sec.toFixed(4));
}

/** One segment between two attacks, with everything the frames said about it. */
interface Segment {
  startSec: number;
  /** The furthest this note may run: the next attack, a mute, or the end of the take. */
  limitSec: number;
  evidence: NoteEvidence;
  /** The pitch the vote settled on, or null when nothing steady was found. */
  midi: number | null;
  endSec: number;
  agreement: number;
  /** An octave of `midi` held `OCTAVE_RIVAL_SHARE` of the frames: which octaves are on the table. */
  octaveCandidates: number[];
  /** A NON-octave rival held `CHORD_RIVAL_SHARE` of the frames — the chord evidence. */
  contested: boolean;
  /** True once the octave guard has moved this note, so contour never chains off a guess. */
  moved: boolean;
}

/**
 * Transcribe a monophonic take. One pass, deterministic, no network and no model.
 *
 * Returns either notes or a refusal, and a refusal is a normal outcome — see the header. The
 * caller is expected to hand a refused take to another engine and say so out loud.
 */
export function transcribeRiffsheet(
  pcm: Float32Array,
  sampleRate: number,
  opts: RiffsheetOptions = {}
): RiffsheetResult {
  const startedAt = Date.now();
  const durationSec = opts.durationSec ?? (sampleRate > 0 ? pcm.length / sampleRate : 0);
  const blank = (): RiffsheetStats => ({
    onsets: 0,
    clusters: 0,
    mutes: 0,
    segments: 0,
    voiced: 0,
    contested: 0,
    octaveMoves: 0,
    rangeMoves: 0,
    contourMoves: 0,
    settledSplits: 0,
    settledFills: 0,
    elapsedMs: Date.now() - startedAt
  });

  if (!pcm || pcm.length === 0 || !(sampleRate > 0)) {
    return {
      ok: false,
      refusal: {
        kind: 'nothing-heard',
        reason: 'There is no audio here to listen to.',
        detail: `${pcm ? pcm.length : 0} samples at ${sampleRate} Hz.`
      },
      stats: blank()
    };
  }

  const takePeak = takePeakOf(pcm);
  const progress = opts.onProgress;
  const detected = detectOnsets(pcm, sampleRate, {
    onProgress: progress ? (f) => progress(f * PROGRESS_ONSETS_SHARE) : undefined
  });
  const clusters = clusterOnsetsDetailed(detected.onsets);

  // --- 1. segmentation ----------------------------------------------------
  const starts: Array<{ atSec: number; endsPreviousAtSec: number }> = [];
  /** Where a mute that stands on its own — a hand landing with nothing struck after it — ended
   *  the note that started at this time. Keyed by that note's start, which is unique. */
  const muteEnds = new Map<number, number>();
  let mutes = 0;
  for (const cluster of clusters) {
    const winner = cluster.winner;
    const kind = classifyOnsetEnergy(pcm, sampleRate, winner.timeSec).kind;
    if (kind === 'mute') {
      // A hand landing on the strings. It ends whatever was ringing and starts nothing.
      mutes++;
      if (starts.length > 0) {
        const last = starts[starts.length - 1];
        // THE FIRST HAND WINS. This used to overwrite, so a note followed by two mutes was
        // limited by the SECOND one and ran straight through the first — and a cluster winner
        // sitting inside a note is precisely what the auto-edit pass calls a split, which is
        // where one of the three edits on our own take came from. A note ends the first time
        // somebody stops it; a later damp is the hand settling on a string already silenced.
        if (winner.timeSec > last.atSec && !muteEnds.has(last.atSec)) {
          muteEnds.set(last.atSec, winner.timeSec);
        }
      }
      continue;
    }
    // ATTACK, and also 'unknown'. An unreadable line is one where the energy barely moved
    // either way — which is exactly what a re-strike of a note that is already ringing looks
    // like, and that is a note the sheet has to show. The detector has already said something
    // was struck; the evidence gates below will drop it if there is no note under it. Treating
    // 'unknown' as silence would lose the repeated-note case this engine exists to get right.
    const earlierMute = earliestMuteBefore(cluster.members, winner, pcm, sampleRate);
    if (earlierMute !== null) mutes++;
    starts.push({ atSec: winner.timeSec, endsPreviousAtSec: earlierMute ?? winner.timeSec });
  }

  const segments: Segment[] = [];
  for (let i = 0; i < starts.length; i++) {
    if (progress && starts.length > 0) {
      progress(
        PROGRESS_ONSETS_SHARE + (i / starts.length) * (PROGRESS_SEGMENTS_END - PROGRESS_ONSETS_SHARE)
      );
    }
    const from = starts[i].atSec;
    // The furthest this note may run. Three things can stop it and the earliest wins: the next
    // attack, the mute that ended it (recorded either inside the next cluster or as a mute
    // cluster of its own), and the end of the recording.
    let limit = durationSec;
    if (i + 1 < starts.length) limit = Math.min(limit, starts[i + 1].endsPreviousAtSec);
    const standaloneMute = muteEnds.get(from);
    if (standaloneMute !== undefined) limit = Math.min(limit, standaloneMute);
    if (!(limit > from)) continue;

    const evidence = readNoteEvidence(pcm, sampleRate, takePeak, from, limit, ENGINE_PROFILE);
    const segment = describeSegment(from, limit, evidence);
    // The second chord test, asked only of segments that produced a confident reading — a
    // segment with no steady pitch is already producing no note, and there is nothing there to
    // be a phantom OF.
    if (segment.midi !== null && !segment.contested) {
      segment.contested = looksPhantom(pcm, sampleRate, segment.startSec, segment.endSec, segment.midi);
    }
    segments.push(segment);
  }

  const stats: RiffsheetStats = {
    onsets: detected.onsets.length,
    clusters: clusters.length,
    mutes,
    segments: segments.length,
    voiced: 0,
    contested: 0,
    octaveMoves: 0,
    rangeMoves: 0,
    contourMoves: 0,
    settledSplits: 0,
    settledFills: 0,
    elapsedMs: 0
  };

  // --- the chord refusal, before anything is written down ------------------
  const analysed = segments.filter((s) => s.evidence.readings.length > 0);
  const contested = segments.filter((s) => s.contested);
  stats.contested = contested.length;
  if (
    contested.length >= CHORD_MIN_SEGMENTS &&
    analysed.length > 0 &&
    contested.length / analysed.length >= CHORD_SEGMENT_SHARE
  ) {
    stats.elapsedMs = Date.now() - startedAt;
    return {
      ok: false,
      refusal: {
        kind: 'polyphony',
        reason: 'This sounds like more than one note at a time, and Riffsheet only writes down one.',
        detail:
          `${contested.length} of ${analysed.length} segments had two different pitches sounding ` +
          `across them. Riffsheet's own engine is for single-note lines.`
      },
      stats
    };
  }

  // --- 4a. the octave guard: range, then contour ---------------------------
  applyOctaveGuard(segments, opts, stats);

  // --- what the frames said ------------------------------------------------
  let ids = 0;
  const read: SettlingNote[] = [];
  for (const s of segments) {
    if (s.midi === null) continue;
    if (!(s.endSec - s.startSec >= ENGINE_MIN_NOTE_SEC)) continue;
    read.push({
      id: `r${ids++}`,
      startSec: round4(s.startSec),
      endSec: round4(s.endSec),
      midi: s.midi,
      confidence: Number((s.moved ? s.agreement * MOVED_CONFIDENCE : s.agreement).toFixed(3))
    });
  }

  // --- 5. settle: the auto-edit pass's own verdict, taken here --------------
  // See step 5 in the header. This is the same `planEdits` the pass runs, on the same audio and
  // the same attacks, so once it has nothing left to say the pass has nothing left to say
  // either. The ids are throwaway — `ui/app.ts` renumbers every note it receives — but they
  // have to exist, because a split is a decision ABOUT a note and the brain identifies notes
  // by id. Without them the engine would settle against a question the pass answers differently.
  const settled = opts.unsettled
    ? { notes: read, splits: 0, fills: 0 }
    : settle(read, {
        onsets: detected.onsets,
        pcm,
        sampleRate,
        durationSec,
        newId: () => `r${ids++}`,
        fillNote: (fill, id) => ({
          id,
          startSec: fill.fromSec,
          endSec: fill.toSec,
          midi: fill.midi,
          // The measurement, not a constant, and not 1: a filled note is exactly as certain as
          // the frames that voted for it. See `RiffsheetNote.confidence`.
          confidence: Number(fill.agreement.toFixed(3))
        })
      });
  stats.settledSplits = settled.splits;
  stats.settledFills = settled.fills;

  const notes: RiffsheetNote[] = settled.notes.map((n) => ({
    startSec: round4(n.startSec),
    endSec: round4(n.endSec),
    midi: n.midi,
    confidence: n.confidence
  }));
  stats.voiced = notes.length;
  stats.elapsedMs = Date.now() - startedAt;

  if (notes.length === 0) {
    return {
      ok: false,
      refusal: {
        kind: 'nothing-heard',
        reason: 'Riffsheet could not find a single-note line in this recording.',
        detail:
          `${detected.onsets.length} attacks, ${segments.length} segments, and not one of them ` +
          `held a steady pitch long enough to write down.`
      },
      stats
    };
  }

  return { ok: true, notes, stats };
}

/**
 * The earliest line inside a cluster that reads as a mute BEFORE the winner.
 *
 * This is `mutesBeforeWinners`'s rule, applied to one cluster: a damp AFTER the winner belongs
 * to the new note being stopped, not to the old one, and the hand lands once, so the earliest
 * qualifying line is the one that ended the previous note.
 */
function earliestMuteBefore(
  members: readonly Onset[],
  winner: Onset,
  pcm: Float32Array,
  sampleRate: number
): number | null {
  if (members.length < 2) return null;
  for (const member of members) {
    if (member.timeSec >= winner.timeSec - 1e-6) continue;
    if (classifyOnsetEnergy(pcm, sampleRate, member.timeSec).kind !== 'mute') continue;
    return member.timeSec;
  }
  return null;
}

/**
 * Turn one segment's frames into a verdict: what note, how long, how sure — and the two
 * questions the guards ask, both answered from the SAME frames rather than a second pass.
 */
function describeSegment(startSec: number, limitSec: number, evidence: NoteEvidence): Segment {
  const base: Segment = {
    startSec,
    limitSec,
    evidence,
    midi: null,
    endSec: limitSec,
    agreement: 0,
    octaveCandidates: [],
    contested: false,
    moved: false
  };
  // Rivalry is asked of the WHOLE candidate span, not of the frames that survived the walk.
  // The walk stops three frames into a run of a different note, so by construction the surviving
  // frames can hold almost no rival — asking them "was a second note sounding here?" would
  // always answer no. The span between two attacks is the window the question is about.
  const pitched = evidence.readings.filter((r) => r.midi !== null).map((r) => r.midi as number);
  base.contested = isContested(pitched, evidence.ok ? evidence.midi : dominant(pitched));

  if (!evidence.ok) return base;

  base.midi = evidence.midi;
  base.endSec = evidence.toSec;
  // The reader already counted this while applying its own agreement gate — see
  // `NoteEvidence.pitchAgreement`. Counting it again here is how the same word ends up meaning
  // two things in two files.
  base.agreement = evidence.pitchAgreement;
  base.octaveCandidates = octaveCandidates(pitched, evidence.midi);
  return base;
}

/** The most-voted pitch in a list of frame readings, or null. */
function dominant(pitched: readonly number[]): number | null {
  if (pitched.length === 0) return null;
  const votes = new Map<number, number>();
  for (const m of pitched) votes.set(m, (votes.get(m) ?? 0) + 1);
  let best = pitched[0];
  let bestCount = 0;
  for (const [midi, count] of votes) {
    if (count > bestCount || (count === bestCount && midi < best)) {
      best = midi;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Magnitude at one frequency, by Goertzel — one bin of a DFT for the price of a loop.
 *
 * A whole FFT would give every bin and we want seven, so this is the arithmetic that is actually
 * needed and nothing else. Hann-windowed for the same reason `onsets.ts` windows: an unwindowed
 * block leaks a loud partial into every bin and the gaps this is looking for would fill in.
 */
function goertzelMag(
  pcm: Float32Array,
  sampleRate: number,
  from: number,
  count: number,
  hz: number
): number {
  if (count < 8 || !(hz > 0) || hz >= sampleRate / 2) return 0;
  const w = (2 * Math.PI * hz) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < count; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / count);
    const s0 = win * pcm[from + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const re = s1 - s2 * Math.cos(w);
  const im = s2 * Math.sin(w);
  return (2 * Math.sqrt(re * re + im * im)) / count;
}

/**
 * Does this segment's spectrum have the gap pattern only two notes can make? See the long
 * comment on `PHANTOM_HARMONICS` for what the pattern is and what it was measured against.
 */
function looksPhantom(
  pcm: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
  midi: number
): boolean {
  const from = Math.round((startSec + PHANTOM_SKIP_SEC) * sampleRate);
  const available = Math.min(
    Math.round(PHANTOM_WINDOW_SEC * sampleRate),
    Math.round(endSec * sampleRate) - from,
    pcm.length - from
  );
  if (from < 0 || available < 256) return false;

  const f0 = 440 * Math.pow(2, (midi - 69) / 12);
  const mags: number[] = [];
  for (let h = 1; h <= PHANTOM_HARMONICS; h++) {
    mags.push(goertzelMag(pcm, sampleRate, from, available, f0 * h));
  }
  const loudest = Math.max(...mags);
  if (!(loudest > 0)) return false;
  const floor = loudest * Math.pow(10, -PHANTOM_ABSENT_DB / 20);
  const absent = mags.filter((m) => m < floor).length;
  // The fundamental has to be one of the gaps. Without that clause this is a timbre detector.
  return mags[0] < floor && absent >= PHANTOM_MIN_GAPS;
}

/**
 * Did a SECOND, non-octave note hold a substantial share of this segment's frames?
 *
 * The chord evidence, and the only new question this engine asks of the tracker. Octave rivals
 * are excluded because an octave is the tracker arguing with itself about one note; neighbours a
 * semitone away are excluded because that is a reading wobbling across a note boundary. What is
 * left is two different notes sounding across the same stretch of recording.
 */
function isContested(pitched: readonly number[], winner: number | null): boolean {
  if (winner === null || pitched.length < CHORD_RIVAL_MIN_FRAMES) return false;
  const votes = new Map<number, number>();
  for (const m of pitched) votes.set(m, (votes.get(m) ?? 0) + 1);
  for (const [midi, count] of votes) {
    const interval = Math.abs(midi - winner);
    if (interval < CHORD_MIN_INTERVAL) continue;
    if (interval % 12 === 0) continue;
    if (count < CHORD_RIVAL_MIN_FRAMES) continue;
    if (count / pitched.length >= CHORD_RIVAL_SHARE) return true;
  }
  return false;
}

/**
 * Which octaves of the winning pitch are genuinely on the table.
 *
 * Always includes the reading itself, and adds an octave only when the frames themselves put it
 * there. A segment every frame agreed on comes back with one candidate and is untouchable.
 */
function octaveCandidates(pitched: readonly number[], winner: number): number[] {
  const out = [winner];
  if (pitched.length === 0) return out;
  const votes = new Map<number, number>();
  for (const m of pitched) votes.set(m, (votes.get(m) ?? 0) + 1);
  for (const [midi, count] of votes) {
    if (midi === winner) continue;
    const interval = Math.abs(midi - winner);
    if (interval % 12 !== 0) continue;
    if (count / pitched.length < OCTAVE_RIVAL_SHARE) continue;
    if (!out.includes(midi)) out.push(midi);
  }
  return out;
}

/**
 * Range first, then contour. See the OCTAVE GUARD section at the top of this file for why in
 * that order and why neither may touch a note the tracker never argued about.
 */
function applyOctaveGuard(segments: Segment[], opts: RiffsheetOptions, stats: RiffsheetStats): void {
  const tuning = opts.tuningLowToHigh ?? [];
  const range =
    tuning.length > 0 ? tuningRange(tuning, opts.maxFret ?? DEFAULT_MAX_FRET) : null;
  const lo = range ? range.min - RANGE_SLACK_LOW : -Infinity;
  const hi = range ? range.max + RANGE_SLACK_HIGH : Infinity;

  // (b) THE RANGE PRIOR. This one MAY move a note the frames agreed on, and it is the only thing
  // that may: an unplayable note is wrong however confidently it was read, and the shift is only
  // taken when it lands the note back inside the instrument. If no octave shift helps, the read
  // stands — being out of range is not on its own proof of which direction the error went.
  for (const s of segments) {
    if (s.midi === null) continue;
    if (s.midi >= lo && s.midi <= hi) continue;
    let fixed: number | null = null;
    for (const shift of [12, -12, 24, -24]) {
      const candidate = s.midi + shift;
      if (candidate >= lo && candidate <= hi) {
        fixed = candidate;
        break;
      }
    }
    if (fixed === null) continue;
    s.midi = fixed;
    s.octaveCandidates = [fixed];
    s.moved = true;
    stats.rangeMoves++;
    stats.octaveMoves++;
  }

  // (c) CONTOUR CONTINUITY, measured only against notes nobody is unsure about. A note with one
  // candidate is confident by construction; a note the range prior just moved is pinned. So the
  // anchors below are exactly the reads this pass has no argument with, and an ambiguous note
  // can never drag another ambiguous note with it.
  const confident = segments
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.midi !== null && s.octaveCandidates.length <= 1);

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.midi === null || s.octaveCandidates.length < 2) continue;
    const before = lastBefore(confident, i);
    const after = firstAfter(confident, i);
    if (before === null && after === null) continue;

    let best = s.midi;
    let bestCost = Infinity;
    for (const candidate of s.octaveCandidates) {
      let cost = 0;
      if (before !== null) cost += Math.abs(candidate - before);
      if (after !== null) cost += Math.abs(candidate - after);
      // Ties go to what the tracker actually read. The guard breaks deadlocks; it does not
      // outrank the measurement when it has nothing to add.
      if (cost < bestCost - 1e-9 || (Math.abs(cost - bestCost) < 1e-9 && candidate === s.midi)) {
        bestCost = cost;
        best = candidate;
      }
    }
    if (best !== s.midi) {
      s.midi = best;
      s.moved = true;
      stats.contourMoves++;
      stats.octaveMoves++;
    }
  }
}

function lastBefore(confident: ReadonlyArray<{ s: Segment; index: number }>, i: number): number | null {
  let out: number | null = null;
  for (const c of confident) {
    if (c.index >= i) break;
    out = c.s.midi;
  }
  return out;
}

function firstAfter(confident: ReadonlyArray<{ s: Segment; index: number }>, i: number): number | null {
  for (const c of confident) if (c.index > i) return c.s.midi;
  return null;
}
