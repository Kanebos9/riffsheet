/**
 * One clock, one playhead — and the clock cannot die.
 *
 * WHAT WENT WRONG IN THE FIELD (v1.0): playback ran for a couple of seconds, froze, and
 * "later" carried on. Three separate design faults could each produce exactly that, and all
 * three are fixed here. They are worth naming, because every one of them is a tempting thing
 * to write again.
 *
 *  1. **The position was read off `AudioContext.currentTime`.** That clock is not a clock:
 *     WebKit suspends an AudioContext when the page is occluded, when another app takes the
 *     audio session, or on a device change, and a suspended context's `currentTime` simply
 *     STOPS. The playhead froze while the native audio kept playing, and when the context
 *     came back the position jumped. The transport now runs on `performance.now()`, which is
 *     monotonic and never stops. The AudioContext is still what the synth is *scheduled*
 *     against — that is what it is for — but it is no longer allowed to be the timebase.
 *
 *  2. **The rAF loop re-armed itself only on the happy path.** `tick()` ended with
 *     `requestAnimationFrame`, so any throw anywhere upstream of that line — an alphaTab
 *     bounds lookup mid-render, a subscriber, a destroyed renderer — permanently killed
 *     playback, with `mode` still `'playing'` so the play button did nothing until pressed
 *     twice. The next frame is now booked BEFORE any work happens, every callout is
 *     individually caught, and a wall-clock watchdog revives the loop if it ever does stop
 *     (which also covers a WebView that suspends rAF entirely while occluded).
 *
 *  3. **Transport commands could interleave.** `play`, `pause` and `seek` are all async and
 *     all mutate the same rAF handle. A `pause()` landing inside an in-flight `play()`
 *     cancelled a stale handle and left the transport "playing" with no loop. They are now
 *     serialised through one promise chain, so they can only ever run end to end.
 *
 * The other half of the rule, from the same bug report: NEITHER SIDE'S LOADING MAY FREEZE
 * THE CLOCK. If the shell has nothing loaded, or stops reporting, or the sample player is
 * still decoding, the wall clock carries on and the fault is counted and logged — never
 * waited on. `window.__RIFFSHEET_CLOCK__()` returns the counters, including the shell's own
 * audio-thread block counts, so the next "it stalled" can be answered with numbers.
 */

import * as alphaTab from '@coderline/alphatab';
import type { NativeBridge } from '../bridge';
import { ScoreSynth, type SynthNote, type SynthVoice } from './synth';

export type TransportMode = 'stopped' | 'playing';

export interface TransportState {
  mode: TransportMode;
  positionSec: number;
  durationSec: number;
  loop: boolean;
  /** Null/null means the loop covers the whole take. */
  loopFromSec: number | null;
  loopToSec: number | null;
  /** 0 = original only, 1 = MIDI only. */
  blend: number;
}

/** Equal-power crossfade. Sitting at 0.5 keeps perceived loudness constant. */
export function crossfadeGains(blend: number): { original: number; midi: number } {
  const b = Math.max(0, Math.min(1, blend));
  return { original: Math.cos((b * Math.PI) / 2), midi: Math.sin((b * Math.PI) / 2) };
}

/** A shell report older than this is stale; we free-run rather than trust it. */
const STALE_REPORT_MS = 600;
/** How much of the shell-vs-us disagreement to absorb per report (a 20 Hz one-pole). */
const DRIFT_SLEW = 0.2;
/** Past this the shell is not drifting, it has jumped: snap instead of slewing. */
const HARD_RESYNC_SEC = 0.35;
/** Watchdog cadence, and how long without a pump counts as a dead clock. */
const WATCHDOG_MS = 250;
const CLOCK_DEAD_MS = 700;
/** Never log the same fault more than this many times; a per-frame fault would flood. */
const MAX_LOGGED_FAULTS = 5;

interface ClockDiagnostics {
  ticks: number;
  maxGapMs: number;
  faults: number;
  lastFault: string | null;
  revivals: number;
  bridgeReports: number;
  staleStretches: number;
  resyncs: number;
  lastDriftSec: number;
  ctxResumes: number;
  shellReportedNotLoaded: number;
}

export class Transport {
  private bridge: NativeBridge;
  private ctx: AudioContext;
  private synth: ScoreSynth;
  private api: alphaTab.AlphaTabApi | null = null;

  private mode: TransportMode = 'stopped';
  private durationSec = 0;
  private loopEnabled = false;
  private loopFromSec: number | null = null;
  private loopToSec: number | null = null;
  private blendValue = 0.35;
  private hasOriginal = false;

  // --- the clock ------------------------------------------------------------
  // Position is always `anchorPos + (wall now - anchorWall)`. Both the free-run
  // case and the follow-the-shell case are the same expression; the shell only
  // ever moves the anchor, it never becomes the timebase.
  private anchorPos = 0;
  private anchorWall = 0;
  private pausedAtSec = 0;

  private bridgeIsPlaying = false;
  private lastBridgeReportMs = 0;
  private wasStale = false;

  private raf = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastPumpMs = 0;
  private loggedFaults = 0;
  /**
   * Set the instant we decide the take has ended, cleared when the transport next moves.
   *
   * Without it, every frame between "we asked to loop" and "the queued seek actually ran"
   * asks again — sixty restarts a second on a loop, which is a stutter storm rather than a
   * loop. The commands are serialised, so the queue would faithfully run all of them.
   */
  private endHandled = false;
  /** True while we are pushing a position into alphaTab, so its own transport
      callbacks cannot bounce straight back into us and start a feedback loop. */
  private pushingToAlphaTab = false;

  private listeners = new Set<(s: TransportState) => void>();
  private unsubPlayback: (() => void) | null = null;

  private diag: ClockDiagnostics = {
    ticks: 0,
    maxGapMs: 0,
    faults: 0,
    lastFault: null,
    revivals: 0,
    bridgeReports: 0,
    staleStretches: 0,
    resyncs: 0,
    lastDriftSec: 0,
    ctxResumes: 0,
    shellReportedNotLoaded: 0
  };

  constructor(bridge: NativeBridge, ctx: AudioContext) {
    this.bridge = bridge;
    this.ctx = ctx;
    this.synth = new ScoreSynth(ctx);
    this.applyGains();

    this.unsubPlayback = bridge.onPlaybackState((s) => this.onShellReport(s));

    // Runs whether or not rAF does. This is the guarantee that a frozen playhead
    // un-freezes itself instead of needing the play button pressed twice.
    this.watchdog = setInterval(() => this.onWatchdog(), WATCHDOG_MS);

    this.installDiagnosticsHook();
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /**
   * Attach alphaTab so its cursor follows us.
   *
   * In EnabledExternalMedia the player's output is an IExternalMediaSynthOutput: we give it
   * a handler describing our media, and push positions into it each frame. Its callbacks are
   * routed through the same serialised commands a button press uses — and ignored outright
   * while we are mid-push, so `updatePosition -> seekTo -> pause/play -> updatePosition` can
   * never become a loop.
   */
  attachAlphaTab(api: alphaTab.AlphaTabApi): void {
    this.api = api;
    const output = api.player?.output as alphaTab.synth.IExternalMediaSynthOutput | undefined;
    if (!output) return;
    output.handler = {
      get backingTrackDuration() {
        return 0;
      },
      playbackRate: 1,
      masterVolume: 1,
      seekTo: (timeMs: number) => {
        if (this.pushingToAlphaTab) return;
        void this.seek(timeMs / 1000);
      },
      play: () => {
        if (this.pushingToAlphaTab) return;
        void this.play();
      },
      pause: () => {
        if (this.pushingToAlphaTab) return;
        void this.pause();
      }
    };
    // The handler's duration getter needs our value; rebind it now that `this` is known.
    Object.defineProperty(output.handler, 'backingTrackDuration', {
      get: () => this.durationSec * 1000
    });
  }

  /**
   * Is there a recording behind the Original side of the fader?
   *
   * Exposed so a diagnostic can report it. The bug this exists for — "I closed the plugin
   * window and it forgot the original sound" — shows up precisely as this being false after a
   * restore, and until now nothing outside this class could see it.
   */
  get originalAvailable(): boolean {
    return this.hasOriginal;
  }

  setOriginalAvailable(available: boolean, durationSec: number): void {
    this.hasOriginal = available;
    if (durationSec > 0) this.durationSec = durationSec;
    this.applyGains();
  }

  setScoreNotes(notes: SynthNote[], durationSec: number): void {
    this.synth.setNotes(notes);
    if (!this.hasOriginal) this.durationSec = durationSec;
    // Notes changed under a running transport (an edit during playback): re-arm
    // the schedule so what you hear matches what you just changed.
    if (this.mode === 'playing') this.rescheduleSynth();
  }

  setVoice(voice: SynthVoice): void {
    this.synth.setVoice(voice);
    if (this.mode === 'playing') this.rescheduleSynth();
  }

  // `setBeatTimes` and `setMetronome` stood here. The only thing either ever fed was the
  // metronome click, and that feature is gone — see audio/synth.ts §start(). The beat times
  // themselves are still very much alive; they simply have no business on the audio path.

  // -------------------------------------------------------------------------
  // The fader
  // -------------------------------------------------------------------------

  setBlend(blend: number): void {
    this.blendValue = Math.max(0, Math.min(1, blend));
    this.applyGains();
    this.emit();
  }

  get blend(): number {
    return this.blendValue;
  }

  private applyGains(): void {
    const { original, midi } = crossfadeGains(this.blendValue);
    this.bridge.setOriginalGain(this.hasOriginal ? original : 0);
    // A symbolic score has no Original side. Do not turn its only sound down merely because
    // the remembered crossfade knob happens to sit in the middle.
    this.synth.setGain(this.hasOriginal ? midi : 1);
  }

  // -------------------------------------------------------------------------
  // Transport commands
  //
  // Public methods only queue; the do* methods do the work. Nothing else may
  // call a do* method, because that is what re-introduces the interleaving bug.
  // -------------------------------------------------------------------------

  private chain: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  play(): Promise<void> {
    return this.serial(() => this.doPlay());
  }

  pause(): Promise<void> {
    return this.serial(() => this.doPause());
  }

  stop(): Promise<void> {
    // One chain entry, not two: stop is pause-then-rewind and must not have a
    // seek from somewhere else land in the middle of it. (Basscribe shipped
    // `seek(0)` alone here, which resumed playback because seek preserves state.)
    return this.serial(async () => {
      await this.doPause();
      await this.doSeek(0);
    });
  }

  toggle(): Promise<void> {
    // The decision is made INSIDE the chain, so two fast presses cannot both
    // read the same stale mode.
    return this.serial(() => (this.mode === 'playing' ? this.doPause() : this.doPlay()));
  }

  seek(positionSec: number): Promise<void> {
    return this.serial(() => this.doSeek(positionSec));
  }

  private async doPlay(): Promise<void> {
    if (this.mode === 'playing') return;

    let from = this.position();
    if (
      this.loopEnabled &&
      this.loopFromSec !== null &&
      this.loopToSec !== null &&
      (from < this.loopFromSec || from >= this.loopToSec)
    ) {
      await this.doSeek(this.loopFromSec);
      from = this.loopFromSec;
    }

    // Get everything that can be slow out of the way BEFORE the clock starts, so
    // "one side is still loading" is never something the clock has to survive.
    await this.resumeContext();
    await this.waitForSynth();

    this.mode = 'playing';
    this.endHandled = false;
    this.reanchor(from);
    this.lastPumpMs = performance.now();

    if (this.hasOriginal) {
      try {
        await this.bridge.play();
      } catch (e) {
        // The original not starting is not a reason for the sheet not to play.
        this.fault('bridge.play', e);
        this.hasOriginal = false;
        this.applyGains();
      }
    }

    this.synth.start(from, this.ctx.currentTime);

    this.emit();
    this.armFrame();
  }

  private async doPause(): Promise<void> {
    if (this.mode !== 'playing') return;
    const at = this.position();
    this.mode = 'stopped';
    this.pausedAtSec = at;
    this.cancelFrame();
    this.synth.stop();
    if (this.hasOriginal) {
      try {
        await this.bridge.pause();
      } catch (e) {
        this.fault('bridge.pause', e);
      }
    }
    this.bridgeIsPlaying = false;
    this.emit();
  }

  private async doSeek(positionSec: number): Promise<void> {
    const target = Math.max(0, Math.min(this.durationSec || Number.MAX_SAFE_INTEGER, positionSec));
    const wasPlaying = this.mode === 'playing';

    if (wasPlaying) await this.doPause();

    this.pausedAtSec = target;
    this.endHandled = false;
    this.reanchor(target);

    if (this.hasOriginal) {
      try {
        await this.bridge.seek(target);
      } catch (e) {
        this.fault('bridge.seek', e);
      }
    }

    if (wasPlaying) await this.doPlay();
    else this.emit();
  }

  setLoop(on: boolean): void {
    this.loopEnabled = on;
    this.emit();
  }

  /** Loop a bar/region on the recording clock; nulls restore whole-take looping. */
  setLoopRange(fromSec: number | null, toSec: number | null): void {
    if (fromSec === null || toSec === null || !Number.isFinite(fromSec) || !Number.isFinite(toSec)) {
      this.loopFromSec = null;
      this.loopToSec = null;
      this.emit();
      return;
    }

    const from = Math.max(0, Math.min(fromSec, toSec));
    const to = Math.min(this.durationSec || Number.MAX_SAFE_INTEGER, Math.max(fromSec, toSec));
    if (to - from < 0.02) return;
    this.loopFromSec = from;
    this.loopToSec = to;
    this.endHandled = false;
    const at = this.position();
    if (at < from || at >= to) void this.seek(from);
    this.emit();
  }

  get loopRange(): { fromSec: number; toSec: number } | null {
    return this.loopFromSec !== null && this.loopToSec !== null
      ? { fromSec: this.loopFromSec, toSec: this.loopToSec }
      : null;
  }

  get loop(): boolean {
    return this.loopEnabled;
  }

  get state(): TransportState {
    return {
      mode: this.mode,
      positionSec: this.position(),
      durationSec: this.durationSec,
      loop: this.loopEnabled,
      loopFromSec: this.loopFromSec,
      loopToSec: this.loopToSec,
      blend: this.blendValue
    };
  }

  // -------------------------------------------------------------------------
  // The clock itself
  // -------------------------------------------------------------------------

  /** Monotonic seconds. Never stops, never jumps, unaffected by audio state. */
  private static wallSec(): number {
    return performance.now() / 1000;
  }

  private reanchor(positionSec: number): void {
    this.anchorPos = positionSec;
    this.anchorWall = Transport.wallSec();
  }

  /** The authoritative position, in seconds. */
  position(): number {
    if (this.mode !== 'playing') return this.pausedAtSec;
    return Math.max(0, this.anchorPos + (Transport.wallSec() - this.anchorWall));
  }

  /**
   * The shell's own report of where the original audio is.
   *
   * Treated as a CORRECTION to our anchor, never as the clock. Small
   * disagreements are absorbed a fifth at a time so the playhead does not
   * jitter at the report rate; a big one means the shell restarted or stalled,
   * and we snap to it because the user hears the shell, not us.
   */
  private onShellReport(s: { isPlaying: boolean; positionSec: number; durationSec: number; loaded?: boolean }): void {
    this.diag.bridgeReports++;
    this.lastBridgeReportMs = performance.now();
    this.bridgeIsPlaying = s.isPlaying;
    if (s.loaded === false) this.diag.shellReportedNotLoaded++;
    if (s.durationSec > 0) this.durationSec = Math.max(this.durationSec, s.durationSec);

    if (this.wasStale) {
      this.wasStale = false;
      this.log('info', 'shell position reports resumed');
    }

    if (this.mode !== 'playing' || !this.hasOriginal || !s.isPlaying) return;

    const drift = s.positionSec - this.position();
    this.diag.lastDriftSec = Number(drift.toFixed(4));

    if (Math.abs(drift) > HARD_RESYNC_SEC) {
      this.diag.resyncs++;
      this.reanchor(s.positionSec);
      // The synth was scheduled against the old timeline; it has to move too.
      this.rescheduleSynth();
      return;
    }

    this.reanchor(this.position() + drift * DRIFT_SLEW);
  }

  private armFrame(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  private cancelFrame(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick = (): void => {
    this.raf = 0;
    if (this.mode !== 'playing') return;
    // Book the next frame BEFORE doing any work. This single line is what makes
    // the clock un-killable: nothing below can prevent the next tick, because
    // the next tick is already scheduled.
    this.raf = requestAnimationFrame(this.tick);
    this.pump();
  };

  private pump(): void {
    const nowMs = performance.now();
    if (this.lastPumpMs) {
      const gap = nowMs - this.lastPumpMs;
      if (gap > this.diag.maxGapMs) this.diag.maxGapMs = Math.round(gap);
    }
    this.lastPumpMs = nowMs;
    this.diag.ticks++;

    if (this.hasOriginal && this.bridgeIsPlaying && !this.wasStale
        && nowMs - this.lastBridgeReportMs > STALE_REPORT_MS) {
      this.wasStale = true;
      this.diag.staleStretches++;
      this.log('warn', `no position from the shell for ${Math.round(nowMs - this.lastBridgeReportMs)}ms — free-running`);
    }

    const pos = this.position();

    const endSec = this.loopEnabled && this.loopToSec !== null ? this.loopToSec : this.durationSec;
    if (endSec > 0 && pos >= endSec - 0.01) {
      if (this.endHandled) return;
      this.endHandled = true;
      if (this.loopEnabled) void this.seek(this.loopFromSec ?? 0);
      else void this.pause();
      return;
    }

    // alphaTab follows. Its cursor, tick cache and scroll all derive from this
    // one call — and it is the single most likely thing here to throw, which is
    // exactly why it is wrapped and why the next frame is already booked.
    this.pushingToAlphaTab = true;
    try {
      const output = this.api?.player?.output as alphaTab.synth.IExternalMediaSynthOutput | undefined;
      output?.updatePosition(pos * 1000);
    } catch (e) {
      this.fault('alphaTab.updatePosition', e);
    } finally {
      this.pushingToAlphaTab = false;
    }

    this.emit();
  }

  /**
   * The belt to the rAF loop's braces.
   *
   * Covers the two things rAF cannot cover itself: a WebView that stops serving
   * frames while occluded (setInterval keeps running, throttled but alive), and
   * an AudioContext that WebKit suspended out from under the synth.
   */
  private onWatchdog(): void {
    if (this.mode !== 'playing') return;

    if (this.ctx.state !== 'running') {
      this.diag.ctxResumes++;
      this.log('warn', `audio context went ${this.ctx.state} mid-playback — resuming`);
      void this.ctx
        .resume()
        .then(() => this.rescheduleSynth())
        .catch((e) => this.fault('ctx.resume', e));
    }

    const since = performance.now() - this.lastPumpMs;
    if (since < CLOCK_DEAD_MS) return;

    this.diag.revivals++;
    this.log('warn', `clock had not ticked for ${Math.round(since)}ms — reviving`);
    this.cancelFrame();
    this.armFrame();
    // Drive one beat by hand too, so the UI stays live even if frames never come
    // back (an occluded WebView will not serve rAF at all).
    this.pump();
  }

  private async resumeContext(): Promise<void> {
    if (this.ctx.state === 'running') return;
    try {
      await this.ctx.resume();
      this.diag.ctxResumes++;
    } catch (e) {
      this.fault('ctx.resume', e);
    }
  }

  /**
   * Give a sample-backed voice the chance to finish loading before the clock starts.
   *
   * Optional by design: `ScoreSynth` only has to expose `ready()` if it has something to
   * wait for. A synth that is always ready simply does not define it, and this costs one
   * property lookup. What must never happen is the transport blocking forever on it — hence
   * the race with a deadline.
   */
  private async waitForSynth(): Promise<void> {
    const ready = (this.synth as unknown as { ready?: () => Promise<unknown> }).ready;
    if (typeof ready !== 'function') return;
    try {
      await Promise.race([
        ready.call(this.synth),
        new Promise((ok) => setTimeout(ok, 2500))
      ]);
    } catch (e) {
      this.fault('synth.ready', e);
    }
  }

  private rescheduleSynth(): void {
    try {
      this.synth.stop();
      this.synth.start(this.position(), this.ctx.currentTime);
    } catch (e) {
      this.fault('synth.reschedule', e);
    }
  }

  // -------------------------------------------------------------------------
  // Subscribers, faults, diagnostics
  // -------------------------------------------------------------------------

  subscribe(listener: (s: TransportState) => void): () => void {
    this.listeners.add(listener);
    try {
      listener(this.state);
    } catch (e) {
      this.fault('subscribe', e);
    }
    return () => this.listeners.delete(listener);
  }

  /** One broken subscriber must not stop the others, and must not stop the clock. */
  private emit(): void {
    const s = this.state;
    for (const l of this.listeners) {
      try {
        l(s);
      } catch (e) {
        this.fault('listener', e);
      }
    }
  }

  private fault(where: string, error: unknown): void {
    this.diag.faults++;
    const message = `${where}: ${String((error as Error)?.stack ?? error)}`.slice(0, 400);
    this.diag.lastFault = message;
    this.log('error', message);
  }

  /**
   * Diagnostics go to the native log as well as the console.
   *
   * Inside a DAW the console is invisible, so a console-only message is a message nobody
   * will ever read. Rate-limited: a fault that happens every frame would otherwise flood
   * both.
   */
  private log(level: 'info' | 'warn' | 'error', message: string): void {
    if (this.loggedFaults >= MAX_LOGGED_FAULTS) return;
    this.loggedFaults++;
    const line = `[transport] ${message}`;
    if (level === 'error') console.error(line);
    else console.warn(line);
    try {
      void this.bridge.log?.(level, line);
    } catch {
      /* the log channel is never allowed to be the thing that breaks */
    }
    if (this.loggedFaults === MAX_LOGGED_FAULTS) {
      console.warn('[transport] further clock diagnostics suppressed — call __RIFFSHEET_CLOCK__()');
    }
  }

  /**
   * `await __RIFFSHEET_CLOCK__()` in the debug panel (or over the CDP harness) answers
   * "why did playback stall?" without a rebuild: our counters plus the shell's own
   * audio-thread block counts, side by side.
   */
  private installDiagnosticsHook(): void {
    (window as unknown as Record<string, unknown>).__RIFFSHEET_CLOCK__ = async () => ({
      mode: this.mode,
      positionSec: Number(this.position().toFixed(3)),
      durationSec: Number(this.durationSec.toFixed(3)),
      hasOriginal: this.hasOriginal,
      bridgeIsPlaying: this.bridgeIsPlaying,
      msSinceShellReport: this.lastBridgeReportMs
        ? Math.round(performance.now() - this.lastBridgeReportMs)
        : null,
      msSinceTick: this.lastPumpMs ? Math.round(performance.now() - this.lastPumpMs) : null,
      rafArmed: this.raf !== 0,
      audioContext: { state: this.ctx.state, currentTime: Number(this.ctx.currentTime.toFixed(3)) },
      ...this.diag,
      shell: (await this.bridge.playbackDiagnostics?.().catch(() => null)) ?? null
    });
  }

  destroy(): void {
    this.cancelFrame();
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    this.synth.stop();
    this.unsubPlayback?.();
    this.listeners.clear();
  }
}
