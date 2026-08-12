/**
 * The main thread's side of the engine worker.
 *
 * ===================== WHAT THIS BUYS =====================
 *
 * Two passes used to run to completion inside one turn of the page's event loop: the attack
 * detector, the moment a take is decoded, and the whole transcription when the player presses
 * Listen. Both are FFT loops over the entire recording, both are synchronous, and `async` on the
 * function that calls them offloads nothing (codex-critique §11). Inside a plugin that is the
 * DAW's UI thread standing still.
 *
 * Everything below exists to make three claims true:
 *
 *   ALIVE.    The page keeps painting and keeps accepting clicks while a pass runs, because the
 *             pass is on another thread and this side only ever handles messages.
 *   PROGRESS. The engine reports how far through it is (`RiffsheetOptions.onProgress`), the
 *             worker throttles that, and the caller gets a number it can put on screen.
 *   CANCEL.   `terminate()` stops a pass mid-FFT. This is why cancellation is real here and
 *             would not be if the same code ran inline: a synchronous loop cannot be asked to
 *             stop, only killed.
 *
 * ===================== ONE WORKER PER LANE =====================
 *
 * There are two lanes because there are two callers with different lifetimes, and they overlap:
 * a player who presses Listen the instant a take finishes decoding has a detector pass and a
 * transcription in flight at once. Sharing one worker would serialise them — the transcription
 * would wait behind a detector pass whose result it does not need — so each lane owns a worker
 * and cancels only its own previous job.
 *
 * A lane's worker is created on first use and re-created after a cancellation or a crash. That
 * is the whole lifecycle: there is no state in the worker to preserve (see `engineWorker.ts`).
 *
 * ===================== THE FALLBACK IS NOT A SHORTCUT =====================
 *
 * When `Worker` cannot be constructed at all — a bundling arrangement that did not emit the
 * chunk, a host that forbids workers — this runs the same functions inline rather than failing.
 * The app then behaves exactly as it did before this file existed, which is worse but not
 * broken, and `probe()` says so out loud so a verification run cannot mistake the fallback for
 * the real thing.
 */

/**
 * ============ WHY THE URL IS AN IMPORT AND NOT `new URL(…, import.meta.url)` ============
 *
 * The obvious form — `new Worker(new URL('./engineWorker.ts', import.meta.url))` — is wrong in
 * THIS bundle, and wrong in a way that only shows up at runtime. webcore ships as a classic
 * IIFE, not an ES module (vite.config.ts §classic scripts: WKWebView refuses module documents
 * over juce://), so there is no real `import.meta.url` to resolve against. Vite compiles it to
 * `document.currentScript.src || document.baseURI`, and `document.currentScript` is only set
 * WHILE THE SCRIPT IS EXECUTING. A worker built lazily — on the first transcription, or after a
 * cancellation threw the old thread away — reads it as null and falls back to `document.baseURI`,
 * which is the PAGE, so `assets/engineWorker-hash.js` resolves to `/engineWorker-hash.js` and the
 * worker 404s. Measured: every pass failed with "the transcription engine stopped unexpectedly"
 * and silently fell back to running inline, which is the exact behaviour this file exists to end.
 *
 * `?worker&url` gives the built worker's URL as a module-scope constant, evaluated once while
 * the script is still running and correct for ever after — including for the fifth worker built
 * after four cancellations.
 */
import engineWorkerUrl from './engineWorker?worker&url';

import { detectOnsets, type OnsetResult } from './onsets';
import type { EngineJob, EngineReply, OnsetJob, TranscribeJob } from './engineWorker';
import { transcribeRiffsheet, type RiffsheetOptions, type RiffsheetResult } from './riffsheetEngine';

/**
 * What a cancelled job rejects with.
 *
 * A sentinel rather than a plain Error so callers can tell "the player changed their mind" from
 * "the engine fell over" — the first is not worth a toast and the second is.
 */
export const ENGINE_CANCELLED = 'riffsheet-engine-cancelled';

export function isEngineCancelled(e: unknown): boolean {
  return e instanceof Error && e.message === ENGINE_CANCELLED;
}

/** A job in flight: what it will answer, and the one thing that can stop it. */
export interface EngineJobHandle<T> {
  readonly promise: Promise<T>;
  /** Kill the thread. The promise rejects with `ENGINE_CANCELLED`; see the header. */
  cancel(): void;
}

type EngineLaneName = 'onsets' | 'transcribe';

interface Pending {
  id: number;
  resolve: (value: never) => void;
  reject: (e: Error) => void;
  onProgress?: (fraction: number) => void;
}

/**
 * One worker, one job at a time.
 *
 * The lane is deliberately not a queue. Both callers want the LATEST answer — a second take
 * makes the first take's detector pass worthless, and a second Listen makes the first
 * transcription worthless — so starting a job cancels whatever this lane was doing.
 */
class EngineLane {
  private worker: Worker | null = null;
  /** Set once construction has been tried and failed; stops us re-throwing on every job. */
  private unavailable = false;
  private pending: Pending | null = null;
  private nextId = 1;

  constructor(private readonly name: EngineLaneName) {}

  get workerLive(): boolean {
    return this.worker !== null;
  }

  get usable(): boolean {
    return !this.unavailable;
  }

  /**
   * Build the worker, or answer null if this environment has none.
   *
   * `engineWorkerUrl` is the built chunk's address, fixed at module scope — see the note on the
   * import for why it may not be resolved here. Module workers are fine over juce://; only the
   * main document is not (vite.config.ts declares `worker: { format: 'es' }`). Anywhere without
   * a `Worker` at all — Node — this answers null and the caller runs the pass inline.
   */
  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (this.unavailable || typeof Worker === 'undefined') return null;
    try {
      const worker = new Worker(engineWorkerUrl, {
        type: 'module',
        name: `riffsheet-engine-${this.name}`
      });
      worker.onmessage = (event: MessageEvent<EngineReply>) => this.receive(event.data);
      // A worker that dies takes its job's promise with it. Without this the caller waits for
      // ever on a thread that is not there any more. The message NAMES the failure: a silent
      // fallback to running inline is how the URL bug above survived its first run.
      worker.onerror = (event: ErrorEvent | Event) => {
        const detail = 'message' in event && event.message ? event.message : engineWorkerUrl;
        this.fail(`The transcription engine stopped unexpectedly (${detail}).`);
      };
      this.worker = worker;
      return worker;
    } catch {
      this.unavailable = true;
      return null;
    }
  }

  private receive(reply: EngineReply): void {
    const pending = this.pending;
    // A reply addressed to a job that has already been cancelled or replaced. Dropped rather
    // than delivered: the caller has moved on, and a stale result is a wrong answer.
    if (!pending || reply.id !== pending.id) return;
    if (reply.kind === 'progress') {
      pending.onProgress?.(reply.fraction);
      return;
    }
    this.pending = null;
    if (reply.kind === 'failed') pending.reject(new Error(reply.message));
    else pending.resolve(reply.result as never);
  }

  private fail(message: string): void {
    const pending = this.pending;
    this.pending = null;
    // The thread is in an unknown state; the next job gets a fresh one.
    this.worker?.terminate();
    this.worker = null;
    pending?.reject(new Error(message));
  }

  /**
   * Stop whatever is running.
   *
   * TERMINATE, NOT A FLAG. The pass is a synchronous loop with no yield point in it, so the only
   * thing that stops it is losing its thread. The worker is dropped and the next job builds
   * another; there is nothing in it worth keeping (`engineWorker.ts` holds no state).
   */
  cancel(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      this.worker?.terminate();
      this.worker = null;
      pending.reject(new Error(ENGINE_CANCELLED));
    }
  }

  /**
   * Post a job, or answer null when this lane has no worker — in which case the CALLER runs the
   * pass inline, so a missing worker costs responsiveness and never a result.
   */
  post<T>(
    // Written out rather than `Omit<EngineJob, 'id'>`: `Omit` over a union collapses to the
    // properties the members share, which is exactly the field that distinguishes them.
    job: Omit<OnsetJob, 'id'> | Omit<TranscribeJob, 'id'>,
    onProgress?: (fraction: number) => void
  ): EngineJobHandle<T> | null {
    this.cancel();
    const worker = this.ensureWorker();
    if (!worker) return null;
    const id = this.nextId++;
    let handle: EngineJobHandle<T>;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending = { id, resolve: resolve as (value: never) => void, reject, onProgress };
      try {
        worker.postMessage({ ...job, id } as EngineJob);
      } catch (e) {
        this.pending = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    handle = { promise, cancel: () => this.cancel() };
    return handle;
  }

  destroy(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }
}

/** A handle for a pass that had to run inline. Cancelling it is honest about doing nothing. */
function inlineHandle<T>(run: () => T): EngineJobHandle<T> {
  let cancelled = false;
  // Deferred by a turn so an inline pass at least lets the caller's own frame finish, which is
  // the only thing about the old behaviour that was salvageable.
  const promise = new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      if (cancelled) {
        reject(new Error(ENGINE_CANCELLED));
        return;
      }
      try {
        resolve(run());
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }, 0);
  });
  return {
    promise,
    // Only effective BEFORE the pass starts. Said plainly rather than pretended otherwise: there
    // is no way to interrupt a synchronous FFT loop on the thread you are standing on.
    cancel: () => {
      cancelled = true;
    }
  };
}

/**
 * The app's one engine host. Two lanes, created lazily, killed together on teardown.
 */
export class EngineHost {
  private readonly onsetLane = new EngineLane('onsets');
  private readonly transcribeLane = new EngineLane('transcribe');

  /** The attack detector — the pass `setPcm` runs the moment a take is decoded. */
  detectOnsets(
    pcm: Float32Array,
    sampleRate: number,
    onProgress?: (fraction: number) => void
  ): EngineJobHandle<OnsetResult> {
    // A COPY, not a transfer: transferring detaches the page's own `pcm`, which the waveform,
    // the tuner and the A/B player all read. See `engineWorker.ts` §the protocol.
    const posted = this.onsetLane.post<OnsetResult>(
      { job: 'onsets', pcm: pcm.slice(), sampleRate },
      onProgress
    );
    return posted ?? inlineHandle(() => detectOnsets(pcm, sampleRate));
  }

  /** The whole in-house transcription. */
  transcribe(
    pcm: Float32Array,
    sampleRate: number,
    opts: Omit<RiffsheetOptions, 'onProgress'>,
    onProgress?: (fraction: number) => void
  ): EngineJobHandle<RiffsheetResult> {
    const posted = this.transcribeLane.post<RiffsheetResult>(
      { job: 'transcribe', pcm: pcm.slice(), sampleRate, opts },
      onProgress
    );
    return posted ?? inlineHandle(() => transcribeRiffsheet(pcm, sampleRate, opts));
  }

  /** For the harness: is the work actually leaving this thread, and is a lane busy right now? */
  probe(): { workers: boolean; onsetWorkerLive: boolean; transcribeWorkerLive: boolean } {
    return {
      workers: this.onsetLane.usable && this.transcribeLane.usable && typeof Worker !== 'undefined',
      onsetWorkerLive: this.onsetLane.workerLive,
      transcribeWorkerLive: this.transcribeLane.workerLive
    };
  }

  destroy(): void {
    this.onsetLane.destroy();
    this.transcribeLane.destroy();
  }
}
