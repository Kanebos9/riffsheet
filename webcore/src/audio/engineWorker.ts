/**
 * The in-house engine, off the main thread.
 *
 * ===================== WHY THIS FILE EXISTS =====================
 *
 * `transcribeRiffsheet` and `detectOnsets` are ordinary synchronous functions that loop over the
 * whole recording doing FFT work. Marking their CALLERS `async` offloads nothing — an `await` on
 * a function that never yields still runs the whole pass inside one turn of the event loop — so
 * every transcription froze the WebView for as long as it took, inside a DAW, with the host's UI
 * thread waiting on the other side of it (codex-critique §11). Two separate passes did this: the
 * transcription itself, and the attack detector `setPcm` runs the moment a take arrives.
 *
 * A Worker is the only construct that actually moves the work. It gets its own thread, so the
 * page keeps painting, and — the part that matters more — `terminate()` stops a pass that is
 * halfway through an FFT loop, which is something no cooperative cancel flag can do to code that
 * never checks one.
 *
 * ===================== THE PROTOCOL =====================
 *
 * One job at a time per worker, addressed by a monotonic id. The host (`engineHost.ts`) owns the
 * lifetime; this file owns nothing and remembers nothing between jobs, which is what makes
 * "cancel" implementable as "throw the whole thread away and start another".
 *
 * The PCM is COPIED rather than transferred. Transferring would detach the main thread's
 * `Float32Array` — the same buffer the waveform, the tuner and the A/B player read — so the take
 * would vanish from the page the instant analysis started. A 30-second mono take at 44.1 kHz is
 * 5 MB, which is a copy nobody can perceive and a detachment everybody would.
 *
 * NOTHING IN THE SACRED SET IS TOUCHED. This imports the engine and the detector as they are;
 * their only change is an optional `onProgress` in their options, which no existing caller
 * passes. `sampler.ts`, `synth.ts` and `transport.ts` are not reachable from here at all.
 */

/// <reference lib="webworker" />

import { detectOnsets, type OnsetResult } from './onsets';
import { transcribeRiffsheet, type RiffsheetOptions, type RiffsheetResult } from './riffsheetEngine';

/** Ask for the attack detector alone — the pass `setPcm` runs when a take lands. */
export interface OnsetJob {
  id: number;
  job: 'onsets';
  pcm: Float32Array;
  sampleRate: number;
}

/** Ask for the whole transcription. `opts` is `RiffsheetOptions` minus what cannot cross a wire. */
export interface TranscribeJob {
  id: number;
  job: 'transcribe';
  pcm: Float32Array;
  sampleRate: number;
  opts: Omit<RiffsheetOptions, 'onProgress'>;
}

export type EngineJob = OnsetJob | TranscribeJob;

/**
 * What comes back.
 *
 * `failed` carries a message rather than an Error because an Error does not survive structured
 * cloning with its stack intact, and the caller's only honest move is to say the pass failed and
 * hand the take to another engine. There is no `cancelled` reply on purpose: a cancelled job's
 * thread is gone before it could send one, and the host settles the promise itself.
 */
export type EngineReply =
  | { id: number; kind: 'progress'; fraction: number }
  | { id: number; kind: 'onsets'; result: OnsetResult }
  | { id: number; kind: 'transcribe'; result: RiffsheetResult }
  | { id: number; kind: 'failed'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

/**
 * Progress, throttled to about one message every 50 ms.
 *
 * The engine calls its hook a few dozen times per pass already, but a very long take multiplies
 * that by its segment count, and `postMessage` is not free on either side. A progress bar cannot
 * show more than a frame's worth of movement anyway.
 */
function throttledProgress(id: number): (fraction: number) => void {
  let lastAt = 0;
  let lastFraction = -1;
  return (fraction) => {
    const now = Date.now();
    if (now - lastAt < 50 && fraction < 1) return;
    // Monotonic: a bar that goes backwards reads as a bug even when the number behind it is fine.
    if (fraction <= lastFraction) return;
    lastAt = now;
    lastFraction = fraction;
    scope.postMessage({ id, kind: 'progress', fraction } satisfies EngineReply);
  };
}

scope.onmessage = (event: MessageEvent<EngineJob>) => {
  const message = event.data;
  if (!message || typeof message.id !== 'number') return;
  const onProgress = throttledProgress(message.id);
  try {
    if (message.job === 'onsets') {
      const result = detectOnsets(message.pcm, message.sampleRate, { onProgress });
      scope.postMessage({ id: message.id, kind: 'onsets', result } satisfies EngineReply);
      return;
    }
    if (message.job === 'transcribe') {
      const result = transcribeRiffsheet(message.pcm, message.sampleRate, {
        ...message.opts,
        onProgress
      });
      scope.postMessage({ id: message.id, kind: 'transcribe', result } satisfies EngineReply);
      return;
    }
  } catch (e) {
    scope.postMessage({
      id: message.id,
      kind: 'failed',
      message: e instanceof Error ? e.message : String(e)
    } satisfies EngineReply);
  }
};
