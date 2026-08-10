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
import { detectPitchTrack } from '../audio/pitch';

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
 * ...and no longer than this. Past a couple of seconds "the engine heard nothing and the
 * tracker heard one steady pitch" stops being a missed note and starts being a drone, a hum,
 * or a stretch of feedback — none of which anybody wants written onto their sheet.
 */
const MAX_FILL_SEC = 2;

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
// What the pass produces
// ---------------------------------------------------------------------------

export interface SplitProposal {
  kind: 'split';
  /** The engine note to divide. */
  noteId: string;
  /** Where to divide it — the clustered attack time, exactly. */
  atSec: number;
  /** The note's own span, for the waveform tint and the roll highlight. */
  fromSec: number;
  toSec: number;
  /** The surviving attack's strength, 0..1 within this take. */
  strength: number;
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

/**
 * Collapse attacks that are really one attack.
 *
 * Greedy over the take in time order, keeping the strongest member of each cluster. Exported
 * because it is the guardrail most worth testing directly, and because the waveform would
 * rather draw what the pass believed than what the detector said.
 */
export function clusterOnsets(onsets: ReadonlyArray<Onset>, windowSec = CLUSTER_SEC): Onset[] {
  if (onsets.length === 0) return [];
  const sorted = [...onsets].sort((a, b) => a.timeSec - b.timeSec);
  const out: Onset[] = [];
  let best = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const o = sorted[i];
    // Measured against the cluster's CURRENT winner, not against the previous raw line: a
    // drizzle of detections 40 ms apart is one attack, and chaining off each neighbour in turn
    // would let a cluster grow without limit.
    if (o.timeSec - best.timeSec < windowSec) {
      if (o.strength > best.strength) best = o;
      continue;
    }
    out.push(best);
    best = o;
  }
  out.push(best);
  return out;
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
  const clustered = clusterOnsets(input.onsets);
  const notes = [...input.notes].sort((a, b) => a.startSec - b.startSec);
  const touched = input.userTouchedIds ?? new Set<string>();

  const splits: SplitProposal[] = [];
  const fills: FillProposal[] = [];
  const attention: AttentionMark[] = [];

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
      const before = onset.timeSec - left;
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
        fromSec: note.startSec,
        toSec: note.endSec,
        strength: onset.strength
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

    const a = Math.max(0, Math.min(pcm.length, Math.round(region.fromSec * rate)));
    const b = Math.max(a, Math.min(pcm.length, Math.round(region.toSec * rate)));
    const slice = pcm.subarray(a, b);
    const levelDb = dbBelow(peakOf(slice), takePeak);
    if (levelDb < FILL_FLOOR_DB) {
      attention.push({
        kind: 'fill',
        atSec: onset.timeSec,
        fromSec: region.fromSec,
        toSec: region.toSec,
        reason: 'Something was heard here, but it is too quiet to be a note somebody meant to play.'
      });
      continue;
    }

    const steady = steadyPitch(slice, rate, span);
    if (!steady) {
      attention.push({
        kind: 'fill',
        atSec: onset.timeSec,
        fromSec: region.fromSec,
        toSec: region.toSec,
        reason: 'Something was struck here that the engine missed, but there is no one steady pitch in it to write down.'
      });
      continue;
    }

    fills.push({
      kind: 'fill',
      fromSec: region.fromSec,
      toSec: region.toSec,
      midi: steady.midi,
      centsSpread: steady.centsSpread,
      levelDb
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
      maxFillSec: MAX_FILL_SEC,
      fillCentsSpread: FILL_CENTS_SPREAD,
      fillFloorDb: FILL_FLOOR_DB,
      snapSec: input.snapSec,
      rawOnsets: input.onsets.length,
      clusteredOnsetCount: clustered.length
    }
  };
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

/**
 * How far a missed attack's region may run: to the next attack, to the next note, or to the
 * cap — whichever comes first — and never into a note the engine did write.
 */
function regionAfter(
  atSec: number,
  clustered: ReadonlyArray<Onset>,
  notes: ReadonlyArray<AutoEditNote>,
  durationSec: number
): { fromSec: number; toSec: number } | null {
  let end = Math.min(durationSec > 0 ? durationSec : atSec + MAX_FILL_SEC, atSec + MAX_FILL_SEC);
  for (const o of clustered) {
    if (o.timeSec > atSec + 1e-6 && o.timeSec < end) end = o.timeSec;
  }
  for (const n of notes) {
    if (n.startSec > atSec && n.startSec - SILENCE_MARGIN_SEC < end) end = n.startSec - SILENCE_MARGIN_SEC;
  }
  if (!(end > atSec)) return null;
  // And the engine must be silent across ALL of it, not merely at its two ends.
  for (const n of notes) {
    if (n.endSec > atSec && n.startSec < end) return null;
  }
  return { fromSec: atSec, toSec: end };
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

/**
 * One note, or nothing.
 *
 * The tuner's own machinery, held to a stricter standard than the tuner holds it to: the
 * tuner is allowed to show a sequence and let the player judge, and this has to decide on its
 * own whether to write something onto their sheet.
 */
function steadyPitch(
  slice: Float32Array,
  sampleRate: number,
  spanSec: number
): { midi: number; centsSpread: number } | null {
  // A shorter hop than the tuner's default, because the shortest region this accepts is 150 ms
  // and the default would only fit two frames into it — and two agreeing frames is a
  // coincidence, not evidence.
  const hop = Math.max(0.005, Math.min(0.02, spanSec / 8));
  const readings = detectPitchTrack(slice, sampleRate, hop);
  if (readings.length === 0) return null;

  const pitched = readings.filter((r) => r.midi !== null && r.hz !== null);
  if (pitched.length < FILL_MIN_FRAMES) return null;

  // The note most frames agree on, then the frames that agree with it.
  const votes = new Map<number, number>();
  for (const r of pitched) votes.set(r.midi!, (votes.get(r.midi!) ?? 0) + 1);
  let midi = pitched[0].midi!;
  let best = 0;
  for (const [note, count] of votes) {
    if (count > best) {
      best = count;
      midi = note;
    }
  }
  // Agreement is measured against EVERY frame in the region, not only the pitched ones. A
  // region that is 80% silence and 20% one confident note is not a note being held.
  if (best / readings.length < FILL_AGREEMENT) return null;
  if (best < FILL_MIN_FRAMES) return null;

  const agreeing = pitched.filter((r) => r.midi === midi);
  const cents = agreeing.map((r) => r.cents);
  const spread = Math.max(...cents) - Math.min(...cents);
  if (!(spread <= FILL_CENTS_SPREAD)) return null;

  return { midi, centsSpread: Number(spread.toFixed(1)) };
}

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
      pieces.push({ ...note, id, startSec: left, endSec: cut.atSec });
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
