/**
 * STATION 7 — GUARDS (the audio-independent half).
 *
 * Two jobs, both of which the pipeline can do without hearing anything:
 *
 *  1. PAST-END FILTER. A detector that keeps hallucinating after the audio stops produces
 *     notes with `startSec >= audioDurationSec`. Those are never real. Dropped outright.
 *
 *  2. REPEAT-LOOP DETECTOR (interface only, by design). A stuck decoder emits a run of
 *     identical pitches at a machine-regular spacing. That is ALSO what a real sixteenth-note
 *     pedal figure looks like, and the two are indistinguishable from a note list. So this
 *     module only ever FLAGS suspects and puts them in the IR; the webcore resolves them with
 *     audio evidence (onset strength / spectral flux at each suspect onset). We do not have
 *     audio here and must not pretend to.
 *
 * WRITTEN. No upstream equivalent exists in either research doc; these are Riffsheet's own
 * failure modes.
 */

import type { InputNote } from './types.js';
import type { IRRepeatSuspect } from './ir.js';

/** §7.3 rule 1: 30 ms is barely one cycle of a low E's fundamental (41 Hz => 24 ms period). */
export const MIN_NOTE_SEC = 0.03;
/** A run must be at least this long before it is even a candidate. */
export const REPEAT_MIN_RUN = 8;
/** Machine regularity: human sixteenths never hold inter-onset jitter this tight. */
export const REPEAT_IOI_STDDEV_SEC = 0.015;

export interface GuardResult {
  notes: InputNote[];
  pastEndDropped: number;
  tooShortDropped: number;
  repeatLoops: IRRepeatSuspect[];
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  return Math.sqrt(v);
}

/**
 * Flag runs of >= REPEAT_MIN_RUN consecutive notes at the same pitch whose inter-onset
 * intervals have a standard deviation below REPEAT_IOI_STDDEV_SEC.
 *
 * `noteIndices` point into the array PASSED IN, which is the caller's post-filter ordering;
 * `applyGuards` re-maps them to indices in the original input array before returning.
 */
export function detectRepeatLoops(notes: InputNote[]): IRRepeatSuspect[] {
  const out: IRRepeatSuspect[] = [];
  const sorted = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.startSec - b.n.startSec);

  let runStart = 0;
  const flush = (endExclusive: number): void => {
    const len = endExclusive - runStart;
    if (len < REPEAT_MIN_RUN) return;
    const slice = sorted.slice(runStart, endExclusive);
    const iois: number[] = [];
    for (let k = 1; k < slice.length; k++) iois.push(slice[k].n.startSec - slice[k - 1].n.startSec);
    const sd = stddev(iois);
    if (sd >= REPEAT_IOI_STDDEV_SEC) return;
    out.push({
      noteIndices: slice.map((s) => s.i),
      midi: slice[0].n.midi,
      count: slice.length,
      meanIoiSec: iois.reduce((a, b) => a + b, 0) / Math.max(1, iois.length),
      stddevIoiSec: sd,
      startSec: slice[0].n.startSec,
      endSec: slice[slice.length - 1].n.endSec
    });
  };

  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i].n.midi !== sorted[runStart].n.midi) {
      flush(i);
      runStart = i;
    }
  }
  return out;
}

/**
 * BOTH GUARDS ARE STATEMENTS ABOUT A DETECTOR, and neither is true of a symbolic source.
 *
 * A note that carries `sourceTiming` was WRITTEN by a human in a score editor, not inferred from
 * a spectrogram. It cannot be a sub-30 ms artefact of a decoder that never stopped, because no
 * decoder was involved: at 140 BPM a legal 64th note lasts 27 ms and the unconditional
 * `MIN_NOTE_SEC` filter deleted it outright, which is how an imported score quietly lost notes
 * it plainly contained. Likewise the past-end filter compares against an AUDIO duration; an
 * imported part has no audio, and where the caller supplies one anyway (a score imported beside
 * a take) it describes the take, not the import.
 *
 * So a symbolic note is exempt from both. Everything else — chord grouping, overlap clamping,
 * repeat-loop flagging — is unchanged, and a detected note is guarded exactly as before.
 */
export function isSymbolic(note: InputNote): boolean {
  const timing = note.sourceTiming;
  return !!timing && Number.isFinite(timing.ppq) && timing.ppq > 0;
}

export function applyGuards(notes: InputNote[], audioDurationSec?: number): GuardResult {
  let pastEndDropped = 0;
  let tooShortDropped = 0;

  const kept: { note: InputNote; originalIndex: number }[] = [];
  notes.forEach((n, originalIndex) => {
    if (isSymbolic(n)) {
      kept.push({ note: { ...n }, originalIndex });
      return;
    }
    if (audioDurationSec !== undefined && n.startSec >= audioDurationSec) {
      pastEndDropped++;
      return;
    }
    // Clamp a note that rings past the end of the audio rather than dropping it.
    const endSec = audioDurationSec !== undefined ? Math.min(n.endSec, audioDurationSec) : n.endSec;
    if (endSec - n.startSec < MIN_NOTE_SEC) {
      tooShortDropped++;
      return;
    }
    kept.push({ note: { ...n, endSec }, originalIndex });
  });

  const suspects = detectRepeatLoops(kept.map((k) => k.note)).map((s) => ({
    ...s,
    noteIndices: s.noteIndices.map((i) => kept[i].originalIndex)
  }));

  return {
    notes: kept.map((k) => k.note),
    pastEndDropped,
    tooShortDropped,
    repeatLoops: suspects
  };
}
