/**
 * F16 — SILENCE TRIM AND CUT OUT: the whole of the model, and none of the DOM.
 *
 * =============================================================================================
 * WHY THIS IS A LIST AND NOT A NEW AUDIO BUFFER
 * =============================================================================================
 *
 * "Cut out" is the one editing gesture that would normally mean rewriting the audio pipeline:
 * decode, splice the PCM, recompute the peaks, re-run the transcription, and hope the note ids
 * survive it. They would not — ids are what the notation edits, the session blob and the
 * engraving-to-performance identity are all keyed on (§4.8) — so a destructive cut would cost
 * the player every correction they had made, every time they trimmed a second of silence.
 *
 * So nothing is ever removed. The take keeps its full length and its full peaks, and a cut is
 * an entry on a list of spans the page agrees not to show. Everything downstream reads the take
 * through ONE pure mapping between two clocks:
 *
 *   THE AUDIO CLOCK — the recording, all of it, as it came off the disk. What the transport
 *   plays, what `source.peaks` is measured in, what `source.detected.notes` are stamped with.
 *   A cut span is stated in these seconds.
 *
 *   THE EDITED CLOCK — the take with the cuts closed up. What the waveform draws, what the
 *   sheet is engraved from, what the roll's rectangles sit at, what every export writes.
 *
 *     editedSec = audioSec - (total cut length before audioSec)
 *
 * With no cuts the two are the same number and every function here is the identity, which is
 * the property the app leans on to keep the un-cut path bit-for-bit unchanged.
 *
 * =============================================================================================
 * WHAT IS DELIBERATELY NOT HERE
 * =============================================================================================
 *
 * No thresholds, no "significant silence" judgement, no undo, no chips. `detectTrimCuts` takes
 * the numbers it is given. Everything here is a total function of its arguments so that the
 * arithmetic can be exercised without a browser — see scripts/view-units-test.ts.
 */

import type { InputNote } from '@pipeline';

/**
 * A stretch of the recording the player has taken out, in AUDIO seconds.
 *
 * Half-open, `[fromSec, toSec)`: an attack exactly on `toSec` is the first thing you hear after
 * the cut rather than the last thing you lose to it. That choice is what lets a leading-silence
 * trim of `[0, firstAttack)` keep the note it was trimming up to.
 */
export interface CutSpan {
  fromSec: number;
  toSec: number;
}

/** Spans shorter than this are a mis-click, not an edit. */
export const MIN_CUT_SEC = 0.01;

/**
 * Clamp, drop the degenerate, sort, and merge everything that touches or overlaps.
 *
 * Every other function in this file takes a NORMALIZED list and none of them re-check it, so
 * this is the one gate: overlapping spans would double-count their length in `cutBeforeSec` and
 * the two clocks would stop being inverses of each other.
 *
 * Touching spans are merged as well as overlapping ones (`<=`, not `<`). `[0,1)` and `[1,2)`
 * remove exactly the same second of tape as `[0,2)`, and leaving them apart would mean two list
 * entries that no measurement could ever tell from one.
 */
export function normalizeCuts(
  cuts: ReadonlyArray<CutSpan> | null | undefined,
  durationSec: number
): CutSpan[] {
  if (!cuts?.length) return [];
  const limit = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const clean: CutSpan[] = [];
  for (const c of cuts) {
    if (!c || !Number.isFinite(c.fromSec) || !Number.isFinite(c.toSec)) continue;
    const fromSec = Math.max(0, Math.min(limit, Math.min(c.fromSec, c.toSec)));
    const toSec = Math.max(0, Math.min(limit, Math.max(c.fromSec, c.toSec)));
    if (toSec - fromSec < MIN_CUT_SEC) continue;
    clean.push({ fromSec, toSec });
  }
  if (!clean.length) return [];
  clean.sort((a, b) => a.fromSec - b.fromSec || a.toSec - b.toSec);
  const out: CutSpan[] = [clean[0]];
  for (let i = 1; i < clean.length; i++) {
    const last = out[out.length - 1];
    const next = clean[i];
    if (next.fromSec <= last.toSec) last.toSec = Math.max(last.toSec, next.toSec);
    else out.push(next);
  }
  return out;
}

/** Total seconds removed. */
export function cutTotalSec(cuts: ReadonlyArray<CutSpan>): number {
  let total = 0;
  for (const c of cuts) total += c.toSec - c.fromSec;
  return total;
}

/** How much of the tape before `audioSec` is gone. The whole of the forward mapping. */
function cutBeforeSec(audioSec: number, cuts: ReadonlyArray<CutSpan>): number {
  let removed = 0;
  for (const c of cuts) {
    if (c.fromSec >= audioSec) break;
    removed += Math.min(audioSec, c.toSec) - c.fromSec;
  }
  return removed;
}

/**
 * AUDIO second -> EDITED second.
 *
 * Monotonic but not strictly so: every second inside a cut maps to the single point the cut
 * collapses to, which is the correct answer for a playhead passing through one and the reason
 * `isCutSec` exists for callers that need to tell "at the seam" from "inside".
 */
export function audioToEditedSec(audioSec: number, cuts: ReadonlyArray<CutSpan>): number {
  if (!cuts.length || !Number.isFinite(audioSec)) return audioSec;
  return audioSec - cutBeforeSec(audioSec, cuts);
}

/**
 * EDITED second -> AUDIO second. The exact inverse of the above on every second that survives.
 *
 * A second that lands on a seam resolves FORWARD, to where the tape picks up again, because the
 * seam is one moment on the edited clock and the audio second before the cut is not part of it.
 */
export function editedToAudioSec(editedSec: number, cuts: ReadonlyArray<CutSpan>): number {
  if (!cuts.length || !Number.isFinite(editedSec)) return editedSec;
  let audioSec = editedSec;
  for (const c of cuts) {
    if (c.fromSec <= audioSec) audioSec += c.toSec - c.fromSec;
    else break;
  }
  return audioSec;
}

/** Is this audio second inside a cut — i.e. is it tape the player has taken out? */
export function isCutSec(audioSec: number, cuts: ReadonlyArray<CutSpan>): boolean {
  for (const c of cuts) {
    if (audioSec < c.fromSec) return false;
    if (audioSec < c.toSec) return true;
  }
  return false;
}

/**
 * The first audio second at or after `audioSec` that is NOT inside a cut.
 *
 * This is what playback jumps to: the transport counts recording seconds, so honouring a cut
 * during playback is a seek to the far side of it rather than anything the transport has to
 * know about. Returns `audioSec` unchanged when it is already on kept tape.
 */
export function nextKeptSec(audioSec: number, cuts: ReadonlyArray<CutSpan>): number {
  for (const c of cuts) {
    if (audioSec < c.fromSec) return audioSec;
    if (audioSec < c.toSec) return c.toSec;
  }
  return audioSec;
}

/** What is LEFT of the take, in audio seconds, in order. The complement of the cuts. */
export function keptRegions(cuts: ReadonlyArray<CutSpan>, durationSec: number): CutSpan[] {
  const limit = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const out: CutSpan[] = [];
  let at = 0;
  for (const c of cuts) {
    if (c.fromSec > at) out.push({ fromSec: at, toSec: Math.min(c.fromSec, limit) });
    at = Math.max(at, c.toSec);
    if (at >= limit) break;
  }
  if (at < limit) out.push({ fromSec: at, toSec: limit });
  return out.filter((r) => r.toSec > r.fromSec);
}

/** How long the take is once the cuts are closed up. */
export function editedDurationSec(cuts: ReadonlyArray<CutSpan>, durationSec: number): number {
  return Math.max(0, durationSec - cutTotalSec(cuts));
}

/**
 * Add a span the player selected ON THE EDITED CLOCK, and hand back the new list.
 *
 * The two-step is the whole reason this is a function rather than an array push. The player
 * drags on a waveform that is ALREADY showing the take with earlier cuts closed up, so the span
 * they selected is in edited seconds and has to come back to audio seconds before it can join a
 * list that is stated in them. Mapping both ends and normalizing also settles what happens when
 * the new span swallows an old one: the two merge, which is why repeated cuts stay a flat list
 * of disjoint spans however many times the gesture is made.
 */
export function addCut(
  cuts: ReadonlyArray<CutSpan>,
  editedSpan: CutSpan,
  durationSec: number
): CutSpan[] {
  const fromSec = editedToAudioSec(Math.min(editedSpan.fromSec, editedSpan.toSec), cuts);
  const toSec = editedToAudioSec(Math.max(editedSpan.fromSec, editedSpan.toSec), cuts);
  return normalizeCuts([...cuts, { fromSec, toSec }], durationSec);
}

/**
 * The lead-in and the tail, as cuts — the trim chip's whole proposal.
 *
 * Derived from the PERFORMANCE rather than from the samples: the take's own first and last
 * attack are what "silence" means to a musician, and the app already has them. Anything shorter
 * than `thresholdSec` at either end is not worth a chip, and each end is judged on its own — a
 * take can have four seconds of fumbling at the front and a clean ending.
 *
 * `keepSec` is left in place at each end deliberately. Trimming exactly to the attack clips the
 * pick noise off the front of the first note, which is audible, and a tenth of a second of room
 * costs nothing.
 */
export function detectTrimCuts(
  firstNoteSec: number | null,
  lastNoteSec: number | null,
  durationSec: number,
  thresholdSec = 1.5,
  keepSec = 0.1
): CutSpan[] {
  const out: CutSpan[] = [];
  if (!(durationSec > 0)) return out;
  if (firstNoteSec !== null && Number.isFinite(firstNoteSec) && firstNoteSec >= thresholdSec) {
    out.push({ fromSec: 0, toSec: Math.max(0, firstNoteSec - keepSec) });
  }
  if (
    lastNoteSec !== null &&
    Number.isFinite(lastNoteSec) &&
    durationSec - lastNoteSec >= thresholdSec
  ) {
    out.push({ fromSec: Math.min(durationSec, lastNoteSec + keepSec), toSec: durationSec });
  }
  return normalizeCuts(out, durationSec);
}

/**
 * The performance, on the edited clock.
 *
 * Three cases, and the middle one is the interesting one:
 *
 *   - a note whose ATTACK is inside a cut is gone. The player removed the moment it was struck,
 *     so there is no honest second to draw it at and no honest reason to sound it.
 *   - a note that is struck on kept tape and RUNS INTO a cut is shortened to the seam. That is
 *     what "the timeline ripples closed" means for a held note, and it is why the mapping is
 *     applied to both ends rather than shifting the note wholesale.
 *   - everything else simply slides earlier by however much tape was removed before it.
 *
 * Ids are untouched, which is what lets the notation edits, the session blob and playback's
 * engraving-to-performance match survive a cut (§4.8).
 */
export function mapNotesThroughCuts(
  notes: ReadonlyArray<InputNote>,
  cuts: ReadonlyArray<CutSpan>
): InputNote[] {
  if (!cuts.length) return notes as InputNote[];
  const out: InputNote[] = [];
  for (const n of notes) {
    if (isCutSec(n.startSec, cuts)) continue;
    const startSec = audioToEditedSec(n.startSec, cuts);
    const endSec = audioToEditedSec(n.endSec, cuts);
    if (!(endSec - startSec >= MIN_CUT_SEC)) continue;
    out.push({ ...n, startSec, endSec });
  }
  return out;
}

/** Beat/downbeat times through the same mapping. Anything inside a cut stops existing. */
export function mapTimesThroughCuts(
  times: ReadonlyArray<number> | undefined,
  cuts: ReadonlyArray<CutSpan>
): number[] | undefined {
  if (!times) return times;
  if (!cuts.length) return times as number[];
  const out: number[] = [];
  for (const sec of times) {
    if (isCutSec(sec, cuts)) continue;
    out.push(audioToEditedSec(sec, cuts));
  }
  return out;
}

/**
 * The peaks of the kept tape, spliced together.
 *
 * Buckets rather than samples, because that is all the waveform ever had: the strip draws
 * `min[i] / max[i]` across a plot whose width is the take's duration, so handing it the kept
 * buckets and the edited duration is the entire display side of this feature. No PCM is touched
 * and none is decoded — the arrays here are the same few thousand floats the strip was already
 * drawing, with the cut runs left out.
 *
 * Bucket boundaries are not cut boundaries, so a cut edge lands inside a bucket and that bucket
 * is kept whole. The error is one bucket, which at the strip's own resolution is well under a
 * pixel, and rounding INWARD instead would make a cut eat a hair of the note beside it.
 */
export function applyCutsToPeaks(
  peaks: { min: Float32Array; max: Float32Array } | null,
  durationSec: number,
  cuts: ReadonlyArray<CutSpan>
): { min: Float32Array; max: Float32Array } | null {
  if (!peaks || !cuts.length || !(durationSec > 0)) return peaks;
  const buckets = Math.min(peaks.min.length, peaks.max.length);
  if (buckets === 0) return peaks;
  const perSec = buckets / durationSec;
  const kept = keptRegions(cuts, durationSec);
  const minOut: number[] = [];
  const maxOut: number[] = [];
  for (const region of kept) {
    const lo = Math.max(0, Math.floor(region.fromSec * perSec));
    const hi = Math.min(buckets, Math.ceil(region.toSec * perSec));
    for (let i = lo; i < hi; i++) {
      minOut.push(peaks.min[i]);
      maxOut.push(peaks.max[i]);
    }
  }
  // A take cut down to nothing still has to be drawable rather than a zero-length array the
  // strip would divide by.
  if (!minOut.length) return peaks;
  return { min: Float32Array.from(minOut), max: Float32Array.from(maxOut) };
}
