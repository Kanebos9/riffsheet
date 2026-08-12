/**
 * THE ONE PINCH LAW: which road a trackpad gesture came down, and what it is worth.
 *
 * THREE SURFACES, ONE GESTURE. The sheet, the roll and the waveform strip each used to carry
 * their own copy of "is this pinch the other road's duplicate?", their own `gestureScale`
 * baseline and their own 250 ms timer. Three copies of one rule is three chances for the panes to
 * disagree about the same fingers, and they did — see the three faults below, all of which
 * existed in all three copies. Everything about DECIDING is here; each surface keeps only what is
 * genuinely its own, which is coordinates (where the anchor is, in its own pixels) and whether it
 * has the axis the gesture asked for.
 *
 * WHY A ROAD AT ALL. macOS delivers one trackpad pinch to a web view TWICE on some builds:
 *
 *   ctrl-wheel    a `wheel` event with `ctrlKey` forced on, whether or not ctrl is held.
 *                 The only road on Windows/WebView2 (see `PINCH_ROADS` below).
 *   GestureEvent  WebKit's own `gesturestart` / `gesturechange` / `gestureend`, carrying a
 *                 CUMULATIVE `scale` since the fingers landed.
 *
 * Applied naively that is one pinch, zoomed twice. So the first road to speak owns the gesture
 * and the other one's copy is dropped.
 *
 * THE THREE FAULTS THIS FILE FIXES, each of which was live in the shipped code:
 *
 *   1. OPTION+PINCH WAS APPLIED ON BOTH ROADS. The roll's wheel handler took the `altKey`
 *      branch and applied the vertical zoom BEFORE claiming the road (pianoroll.ts, the
 *      `if (e.altKey)` early return above `claimPinch('wheel')`), so the road stayed unclaimed;
 *      the GestureEvent copy then claimed it and applied the same vertical zoom again. An
 *      Option+pinch zoomed pitch twice per event while a plain pinch zoomed time once. Here the
 *      claim happens for every pinch event before the axis is even looked at.
 *
 *   2. NOBODY REGISTERED `gestureend`. All three surfaces listened for `gesturestart` and
 *      `gesturechange` and never for the event that says the fingers left the glass, so the road
 *      could only ever be released by a timeout. It is released by `gestureend` now, which is
 *      also what makes fault 3 fixable.
 *
 *   3. THE 250 MS TIMER COULD SWITCH ROADS MID-PINCH. The old rule refused the other road only
 *      while the last APPLIED zoom was under 250 ms old. A slow pinch produces per-event ratios
 *      below the accumulator's threshold, so nothing is applied for as long as the fingers move
 *      gently — and after a quarter second of that, the other road was let in and the same
 *      gesture started being counted twice halfway through. A road now holds for as long as the
 *      fingers are ON the trackpad (between `gesturestart` and `gestureend`) and, on the
 *      wheel-only road where there is no such bracket, for as long as events keep ARRIVING at
 *      all — applied or not. The timeout is the end of a gesture, never a switch inside one.
 *
 * PURE, AND DELIBERATELY IGNORANT OF THE DOM. `read()` takes a plain record and returns a plain
 * decision, so the whole law is exercised by replaying event streams in a unit test rather than
 * by trying to synthesise a trackpad — see scripts/gesture-test.ts and the captured fixtures in
 * scripts/fixtures/gesture/.
 */

import { PinchAccumulator } from './timeAxis';

/**
 * TRACKPAD ZOOM, DAMPED (G15). How much zoom one pixel of two-finger travel is worth.
 *
 * The discrete factors the buttons use are one NOTCH of a mouse wheel — one deliberate act, one
 * visible step. A trackpad is not that: a single lazy two-finger flick delivers dozens of wheel
 * events, and answering each of them with a 15% or 25% step multiplies out to an enormous jump.
 * The reported symptom was exactly that, "it goes drastic".
 *
 * So the factor is exponential in the delta — `exp(-delta * k)`, which composes correctly
 * (two events of 10px are worth exactly one of 20) and is its own inverse in the other
 * direction, so a flick one way and back lands where it started.
 */
const WHEEL_ZOOM_PER_PX = 0.0015;

/**
 * The most a SINGLE wheel event may zoom, in either direction.
 *
 * The anti-jump clamp, and the reason it is a clamp rather than a smaller gain: some platforms
 * (and every plain mouse) send one enormous delta — 100, 120, or a whole 'page' in
 * `deltaMode` 1 — where a trackpad sends twenty small ones. A gain low enough to make those
 * bearable would make a trackpad feel dead. 6% is a step you can see and cannot be thrown by.
 */
export const WHEEL_ZOOM_MAX_STEP = 1.06;

/**
 * One wheel event's worth of zoom. Negative delta (up, or left) zooms IN, matching every notch
 * gesture in the app; the result is a multiplier for `zoomTimeAt` / `zoomVerticalAt`.
 *
 * `deltaMode` is honoured because a Windows mouse reports LINES (mode 1) and some browsers
 * report PAGES (mode 2): taking those numbers as pixels would make one notch worth nothing.
 */
export function wheelZoomFactor(delta: number, deltaMode = 0): number {
  const px = delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  const raw = Math.exp(-px * WHEEL_ZOOM_PER_PX);
  return Math.min(WHEEL_ZOOM_MAX_STEP, Math.max(1 / WHEEL_ZOOM_MAX_STEP, raw));
}

/** Clamp any per-event multiplier to the same anti-jump step a wheel event gets. */
export function clampZoomStep(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(WHEEL_ZOOM_MAX_STEP, Math.max(1 / WHEEL_ZOOM_MAX_STEP, factor));
}

/** The two ways one physical pinch can reach a handler. */
export type GestureRoad = 'wheel' | 'gesture';

/**
 * How long a road stays claimed with nothing arriving on it.
 *
 * This is the end of a GESTURE, not a referee between two roads inside one: while the fingers are
 * down (`gesturestart` seen, `gestureend` not) the road is held whatever this says, and on the
 * wheel-only road every arriving event refreshes it whether or not it was big enough to apply.
 * A quarter of a second is longer than any gap inside a live event stream and shorter than the
 * time it takes to start a second, deliberate gesture.
 */
export const PINCH_IDLE_MS = 250;

/**
 * WHAT EACH HOST DELIVERS, as a claim about the platforms this ships on.
 *
 * macOS / WKWebView (the JUCE plugin) and Safari: BOTH roads, which is the whole reason this file
 * exists. Windows / WebView2 and every Chromium: the wheel road ONLY — `GestureEvent` is a WebKit
 * API and Chromium has never implemented it, so `gesturestart` never fires there and the road
 * machinery collapses to "the wheel road claims, nothing ever contests it". That is not a
 * degraded path: it is the same code with one of its two inputs never firing, which is exactly
 * what the wheel-only replay in scripts/gesture-test.ts asserts.
 *
 * Stated rather than measured for WebView2 — nothing in this repo's CI loads the plugin in a
 * host. What IS measured is that a Chromium build never dispatches `gesturestart` (the live
 * probes run there and the road is always 'wheel'), and WebView2 is Chromium.
 */
export const PINCH_ROADS: Readonly<Record<'webkit' | 'chromium', readonly GestureRoad[]>> = {
  webkit: ['wheel', 'gesture'],
  chromium: ['wheel']
};

/** One event, reduced to the parts the law cares about. Filled in by each surface's adapter. */
export interface PinchInput {
  kind: 'wheel' | 'gesturestart' | 'gesturechange' | 'gestureend';
  /** `performance.now()` at the surface, or a synthetic clock in a replay. */
  atMs: number;
  /** wheel only: `deltaY || deltaX`. */
  delta?: number;
  /** wheel only: `WheelEvent.deltaMode`. */
  deltaMode?: number;
  /** GestureEvent only: the CUMULATIVE scale since `gesturestart`. */
  scale?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * What the surface should do about one event.
 *
 * 'zoom' names the AXIS rather than the action, because the three surfaces answer the same axis
 * differently: the roll zooms pitch, the sheet and the strip have no pitch axis and swallow it.
 * 'pan' and 'none' are both "this file has nothing to say" — 'pan' additionally means the event
 * was not a pinch at all, so the surface's own scroll rules apply.
 */
export type PinchOutcome =
  | { kind: 'none' }
  | { kind: 'pan' }
  | { kind: 'zoom'; axis: 'time' | 'pitch'; factor: number; road: GestureRoad };

const NONE: PinchOutcome = { kind: 'none' };
const PAN: PinchOutcome = { kind: 'pan' };

/**
 * One surface's pinch state: which road owns the gesture in flight, and what is owed on it.
 *
 * One instance per surface rather than one for the app: the roads are per element, because the
 * events are, and a pinch over the roll must not lock out a later pinch over the sheet.
 */
export class PinchGesture {
  private owner: GestureRoad | null = null;
  private lastMs = Number.NEGATIVE_INFINITY;
  /** True between `gesturestart` and `gestureend`: the fingers are on the glass RIGHT NOW. */
  private contact = false;
  /** The last cumulative `scale`, so a `gesturechange` becomes a per-event ratio. */
  private baseline = 1;
  /** Sub-threshold ratios, kept rather than dropped (finding 10). */
  private readonly accumulator = new PinchAccumulator();

  /** Which road owns the gesture in flight, or null when none does. For probes and tests. */
  get road(): GestureRoad | null {
    return this.owner;
  }

  /** Whether the fingers are still down, as far as WebKit has told us. For probes and tests. */
  get inContact(): boolean {
    return this.contact;
  }

  /** What the accumulator is still holding back. For a test that proves nothing was thrown away. */
  get owed(): number {
    return this.accumulator.owed;
  }

  /** Forget everything: a new element, a teardown, or a gesture abandoned by a re-render. */
  reset(): void {
    this.owner = null;
    this.lastMs = Number.NEGATIVE_INFINITY;
    this.contact = false;
    this.baseline = 1;
    this.accumulator.reset();
  }

  read(e: PinchInput): PinchOutcome {
    switch (e.kind) {
      case 'gesturestart':
        // The fingers are down. Claim if the road is free — if the ctrl-wheel copy of this same
        // pinch got here first, it keeps the gesture and `contact` merely stops the timeout from
        // handing it over halfway through.
        this.baseline = normalScale(e.scale);
        this.accumulator.reset();
        // CLAIMED BEFORE `contact` IS RAISED, and the order is load-bearing: `live()` reads
        // `contact`, so setting it first would make this event's own contact the reason the
        // claim is refused, and the gesture road could never take a free road at all.
        this.claim('gesture', e.atMs);
        this.contact = true;
        return NONE;

      case 'gestureend':
        // THE ONLY HONEST END OF A GESTURE, and until now nobody listened for it. Releasing here
        // is right even when the WHEEL road owned the pinch: it is the same fingers leaving.
        this.owner = null;
        this.contact = false;
        this.lastMs = e.atMs;
        this.baseline = 1;
        this.accumulator.reset();
        return NONE;

      case 'gesturechange': {
        const scale = e.scale;
        if (!scale || !Number.isFinite(scale) || scale <= 0) return NONE;
        const ratio = scale / (this.baseline > 0 ? this.baseline : 1);
        // The baseline advances whoever owns the road, so a handover is never a jump.
        this.baseline = scale;
        // CLAIMED BEFORE THE ACCUMULATOR, not after. This is fault 3: claiming only when a zoom
        // was actually applied left the road unrefreshed through the quiet middle of a slow
        // pinch, and the timeout then let the other road in.
        if (!this.claim('gesture', e.atMs)) return NONE;
        const stepped = this.accumulator.take(ratio);
        if (stepped === null) return NONE;
        return { kind: 'zoom', axis: e.altKey ? 'pitch' : 'time', factor: clampZoomStep(stepped), road: 'gesture' };
      }

      case 'wheel': {
        const pinch = !!e.ctrlKey || !!e.metaKey;
        // Alt WITHOUT a pinch is the plain mouse's pitch zoom, which predates all of this and is
        // not a trackpad gesture at all: no road, no dedupe, nothing to be a duplicate of.
        if (!pinch && !e.altKey) return PAN;
        const delta = e.delta ?? 0;
        if (delta === 0) return NONE;
        // CLAIMED BEFORE THE AXIS IS LOOKED AT. This is fault 1.
        if (pinch && !this.claim('wheel', e.atMs)) return NONE;
        return {
          kind: 'zoom',
          axis: e.altKey ? 'pitch' : 'time',
          factor: wheelZoomFactor(delta, e.deltaMode ?? 0),
          road: 'wheel'
        };
      }
    }
  }

  /**
   * Whichever road speaks first owns the gesture; the other is refused while it is still live.
   *
   * "Live" is contact OR recent traffic, never "recently applied" — see fault 3 above.
   */
  private claim(road: GestureRoad, atMs: number): boolean {
    if (this.owner !== null && this.owner !== road && this.live(atMs)) return false;
    this.owner = road;
    this.lastMs = atMs;
    return true;
  }

  private live(atMs: number): boolean {
    return this.contact || atMs - this.lastMs < PINCH_IDLE_MS;
  }
}

function normalScale(scale: number | undefined): number {
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1;
}
