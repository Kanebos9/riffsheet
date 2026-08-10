/**
 * Auto-trim: find the leading and trailing silence.
 *
 * A simple RMS gate. Anything below the threshold for longer than MIN_SILENCE_MS at the
 * head or tail is silence, and the pipeline is told to start counting bar 1 from the first
 * real sound instead of from wherever the file happens to begin. Without this a riff that
 * starts three seconds in gets three seconds of empty bars in front of it.
 *
 * The user can override the result by dragging the "bar 1" marker on the waveform.
 */

export interface TrimResult {
  /** Seconds of silence at the head. This is the default bar-1 position. */
  startOffsetSec: number;
  /** Absolute time where the trailing silence begins. */
  endSec: number;
  /** Whole-file duration, for reference. */
  durationSec: number;
  /** True when the gate found nothing to trim. */
  trivial: boolean;
}

const DEFAULT_THRESHOLD_DB = -50;
const MIN_SILENCE_MS = 300;
const FRAME_MS = 10;

export function findTrim(
  pcm: Float32Array,
  sampleRate: number,
  thresholdDb = DEFAULT_THRESHOLD_DB,
  minSilenceMs = MIN_SILENCE_MS
): TrimResult {
  const durationSec = pcm.length / sampleRate;
  const frameSize = Math.max(1, Math.floor((sampleRate * FRAME_MS) / 1000));
  const frameCount = Math.floor(pcm.length / frameSize);
  if (frameCount < 2) {
    return { startOffsetSec: 0, endSec: durationSec, durationSec, trivial: true };
  }

  const threshold = Math.pow(10, thresholdDb / 20);
  const loud = new Uint8Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const start = f * frameSize;
    for (let i = start; i < start + frameSize; i++) sum += pcm[i] * pcm[i];
    loud[f] = Math.sqrt(sum / frameSize) > threshold ? 1 : 0;
  }

  const minSilenceFrames = Math.ceil(minSilenceMs / FRAME_MS);

  let firstLoud = loud.indexOf(1);
  if (firstLoud < 0) {
    // Nothing above the gate anywhere — do not trim a file we cannot hear.
    return { startOffsetSec: 0, endSec: durationSec, durationSec, trivial: true };
  }
  let lastLoud = frameCount - 1;
  while (lastLoud > 0 && loud[lastLoud] === 0) lastLoud--;

  const headSilentFrames = firstLoud;
  const tailSilentFrames = frameCount - 1 - lastLoud;

  // Only trim when the silence is long enough to be deliberate rather than a gap.
  const startOffsetSec = headSilentFrames >= minSilenceFrames
    ? Math.max(0, (firstLoud * frameSize) / sampleRate - 0.02) // 20ms of pre-roll keeps the attack
    : 0;
  const endSec = tailSilentFrames >= minSilenceFrames
    ? Math.min(durationSec, ((lastLoud + 1) * frameSize) / sampleRate + 0.05)
    : durationSec;

  return {
    startOffsetSec,
    endSec,
    durationSec,
    trivial: startOffsetSec === 0 && endSec === durationSec
  };
}

/** Min/max peaks for the waveform strip. */
export function computePeaks(
  pcm: Float32Array,
  buckets: number
): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const per = pcm.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let lo = 1;
    let hi = -1;
    const start = Math.floor(b * per);
    const end = Math.min(pcm.length, Math.floor((b + 1) * per) + 1);
    for (let i = start; i < end; i++) {
      const v = pcm[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo <= hi ? lo : 0;
    max[b] = lo <= hi ? hi : 0;
  }
  return { min, max };
}
