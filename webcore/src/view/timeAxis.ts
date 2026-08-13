/**
 * THE TIME AXIS — one window, shared by every strip, and nothing warps.
 *
 * The roll and the waveform used to draw the WHOLE take across the plot, always, with no zoom
 * of their own; the only thing that could narrow them was Align, which handed them a pair of
 * anchors describing the stretch the sheet happened to be showing. That gave the app a time
 * zoom by accident (you zoomed the SHEET and the roll followed) and no time zoom on purpose.
 *
 * This module is the deliberate one. It owns four ideas and nothing else:
 *
 *   1. A WINDOW. `{ fromSec, toSec }` in RECORDING seconds — the stretch on screen. Every
 *      strip maps it linearly onto its own plot, so "the same x means the same second" is true
 *      across the roll, the waveform and the transport, at every zoom.
 *
 *      LINEARLY IS THE WHOLE POINT. The engraving is deliberately not proportional to time —
 *      alphaTab gives a rhythmically dense bar more pixels than a sparse one — and a picture of
 *      a performance drawn on that axis re-spaces itself whenever the performance is edited.
 *      Align therefore syncs VIEWPORTS (which region is on screen) and never CONTENT (where
 *      inside the region a note is drawn). Nothing here can move one note because another one
 *      changed, because nothing here knows that notes exist.
 *
 *   2. ZOOM, ABOUT A POINT. `zoomWindowAt` keeps one fraction of the plot pinned while the span
 *      changes, which is what makes a wheel feel like leaning in rather than being thrown
 *      somewhere else in the take. The buttons pass 0.5 and get "zoom about the middle" from
 *      the same function rather than from a second, subtly different one.
 *
 *   3. A GRID, IN PERFORMED TIME. Bar lines and beats at the seconds they were actually played,
 *      derived from the same tick->second mapping the notes are, so a marker and the note on it
 *      cannot disagree. Thinned by how much room there is, so zooming out gives fewer lines
 *      rather than a grey wash.
 *
 *   4. THE COUPLING. With Align on, one zoom gesture has to drive the sheet too. The factor is
 *      stated once, here, in `coupledSheetScale`.
 *
 * PURE, AND DELIBERATELY IGNORANT OF THE APP. Nothing here imports a score, a renderer or a
 * DOM node; the structural types are the smallest shape each function needs. That is what lets
 * every rule below be unit-tested without a browser — see `timeAxis.test.ts`, which is the only
 * reason any of this is in its own file rather than inside the roll.
 *
 * THE ONE IMPORT is `buildTickSecondsMap`, the pipeline's tick<->seconds arithmetic. It takes two
 * numbers and a list of tempo changes and returns a function; it is not a score, and the rule
 * above is intact. Copying it here instead would give the grid a second opinion about when bar 4
 * starts, which is the exact class of bug this module exists to prevent.
 */

import { buildTickSecondsMap } from '../pipeline';

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/** The stretch of RECORDING on screen. Always `fromSec < toSec`. */
export interface TimeWindow {
  fromSec: number;
  toSec: number;
}

/**
 * How far the window may be zoomed, and what it is a window ONTO.
 *
 * `durationSec` is the take. Zooming out stops when the whole take is on screen: there is
 * nothing past the end of a recording to look at, and a strip that lets you scroll into empty
 * grey has lost the one property that makes it readable at a glance.
 */
export interface TimeLimits {
  durationSec: number;
  /**
   * The narrowest window allowed, in seconds — the deepest zoom.
   *
   * `MIN_WINDOW_SEC` below is the shipped value and the reasoning is there.
   */
  minSpanSec: number;
  /**
   * The widest window allowed, in seconds — the shallowest zoom. Absent means "the take".
   *
   * THIS IS WHERE ALIGNMENT'S EDGE CONTRACT LIVES (finding 9). The roll can draw any span from
   * 50 ms to the whole take; the sheet can only be engraved between `display.scale` 0.6 and 3,
   * which is a band of achievable spans and nothing outside it. Alignment is mandatory, so the
   * shared range is the INTERSECTION of the two — see `intersectLimits`. A window that saturates
   * therefore stops in both panes at once, which is the difference between "the zoom has reached
   * its limit" and the old behaviour, where the roll went on alone and the sheet snapped it back
   * a callback later.
   */
  maxSpanSec?: number;
}

/**
 * The deepest zoom: 50 ms of recording across the whole plot.
 *
 * A 50 ms window on a 900 px pane is about 18 px per millisecond, which is far past anything
 * anybody edits at — it is a HARD STOP rather than a working zoom, and it exists so a runaway
 * pinch cannot divide the span down to zero and produce a plot where every x is the same
 * second. The working range is set by the other end: `durationSec`, the whole take.
 *
 * (The brief said "~50 ms/pixel". Read literally that is COARSER than showing a whole short
 * take — a 10 s take on a 900 px pane is already 11 ms/pixel — so it cannot be the zoom-IN
 * limit it was given as. Read as "50 ms across the plot" it is a limit that works and is the
 * same number, so that is what this is. One constant to change if the other reading was meant.)
 */
export const MIN_WINDOW_SEC = 0.05;

/** One notch of the wheel, and one press of a zoom button. Multiplicative, so it undoes. */
export const TIME_ZOOM_IN_FACTOR = 1.25;
export const TIME_ZOOM_OUT_FACTOR = 1 / 1.25;

/** The whole take, as a window. What "zoomed all the way out" means. */
export function fullWindow(limits: TimeLimits): TimeWindow {
  return { fromSec: 0, toSec: Math.max(limits.minSpanSec, limits.durationSec) };
}

/**
 * Put a window back inside the rules: span within [minSpan, duration], window within the take.
 *
 * A window WIDER than the take collapses to the take rather than being centred on it with grey
 * either side — "zoomed out" and "zoomed out and also lost" are different states and only one
 * of them is wanted. A window that has been panned past an edge is SLID back, keeping its span,
 * because a pan that silently narrowed the view would read as an unasked-for zoom.
 */
export function clampWindow(win: TimeWindow, limits: TimeLimits): TimeWindow {
  const duration = Math.max(limits.minSpanSec, limits.durationSec);
  const maxSpan = maxSpanOf(limits);
  const minSpan = Math.max(1e-6, Math.min(limits.minSpanSec, maxSpan));

  let span = win.toSec - win.fromSec;
  if (!Number.isFinite(span) || span <= 0) span = maxSpan;
  span = Math.max(minSpan, Math.min(maxSpan, span));

  let from = Number.isFinite(win.fromSec) ? win.fromSec : 0;
  from = Math.max(0, Math.min(duration - span, from));
  return { fromSec: from, toSec: from + span };
}

/** The widest span these limits allow: the ceiling if one was given, the take otherwise. */
export function maxSpanOf(limits: TimeLimits): number {
  const duration = Math.max(limits.minSpanSec, limits.durationSec);
  const ceiling = limits.maxSpanSec;
  if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling <= 0) return duration;
  return Math.max(1e-6, Math.min(duration, ceiling));
}

/** True when the window is (near enough) the whole take — i.e. fully zoomed out. */
export function isFullWindow(win: TimeWindow, limits: TimeLimits): boolean {
  const full = fullWindow(limits);
  return Math.abs(win.fromSec - full.fromSec) < 1e-6 && Math.abs(win.toSec - full.toSec) < 1e-6;
}

/** Seconds per plot pixel. The number a "how deep is this zoom" check wants. */
export function secPerPx(win: TimeWindow, plotWidth: number): number {
  return (win.toSec - win.fromSec) / Math.max(1, plotWidth);
}

/** A RECORDING second -> a fraction of the plot. Extrapolates outside, so it stays invertible. */
export function secToFrac(win: TimeWindow, sec: number): number {
  const span = win.toSec - win.fromSec;
  return span > 0 ? (sec - win.fromSec) / span : 0;
}

/** The exact inverse of `secToFrac`. */
export function fracToSec(win: TimeWindow, frac: number): number {
  return win.fromSec + frac * (win.toSec - win.fromSec);
}

/**
 * Zoom about a point, given as a FRACTION of the plot rather than a pixel.
 *
 * A fraction and not a pixel because the roll, the waveform and the sheet are three different
 * widths and the gesture means the same thing on all of them: the second under the pointer
 * stays under the pointer. `factor > 1` zooms IN (a narrower window).
 *
 * The anchor is honoured before the clamp, so zooming in at the far right of a take does not
 * drag the window off the end and then get shoved back — it simply stops when it reaches it.
 */
export function zoomWindowAt(
  win: TimeWindow,
  factor: number,
  frac: number,
  limits: TimeLimits
): TimeWindow {
  if (!Number.isFinite(factor) || factor <= 0) return clampWindow(win, limits);
  const anchorFrac = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0.5;
  const anchorSec = fracToSec(win, anchorFrac);
  const span = (win.toSec - win.fromSec) / factor;
  return clampWindow({ fromSec: anchorSec - anchorFrac * span, toSec: anchorSec + (1 - anchorFrac) * span }, limits);
}

/** Zoom about the middle of the view. The buttons' gesture — same function, frac 0.5. */
export function zoomWindowCentred(win: TimeWindow, factor: number, limits: TimeLimits): TimeWindow {
  return zoomWindowAt(win, factor, 0.5, limits);
}

/** Slide the window without changing its span. */
export function panWindow(win: TimeWindow, deltaSec: number, limits: TimeLimits): TimeWindow {
  if (!Number.isFinite(deltaSec)) return clampWindow(win, limits);
  return clampWindow({ fromSec: win.fromSec + deltaSec, toSec: win.toSec + deltaSec }, limits);
}

/** Move the window so `sec` sits at `frac` of the plot, keeping the span. */
export function windowShowing(sec: number, frac: number, spanSec: number, limits: TimeLimits): TimeWindow {
  const from = sec - Math.max(0, Math.min(1, frac)) * spanSec;
  return clampWindow({ fromSec: from, toSec: from + spanSec }, limits);
}

/**
 * Bring a second into view, moving as little as possible.
 *
 * Returns the window unchanged when it is already comfortably inside, so a playhead crossing
 * the middle of the pane does not cause a scroll on every frame. `marginFrac` is the band kept
 * clear at each edge.
 */
export function windowFollowing(
  win: TimeWindow,
  sec: number,
  limits: TimeLimits,
  marginFrac = 0.15
): TimeWindow {
  const span = win.toSec - win.fromSec;
  const margin = span * Math.max(0, Math.min(0.45, marginFrac));
  if (sec >= win.fromSec + margin && sec <= win.toSec - margin) return win;
  if (sec < win.fromSec + margin) return clampWindow({ fromSec: sec - margin, toSec: sec - margin + span }, limits);
  return clampWindow({ fromSec: sec + margin - span, toSec: sec + margin }, limits);
}

// ---------------------------------------------------------------------------
// THE AUTHORITATIVE VIEWPORT, and the one reducer that moves it
// ---------------------------------------------------------------------------

/**
 * THE ONE PIECE OF STATE. Which stretch of recording every pane is showing, and a counter.
 *
 * What this replaces is not a smaller version of itself — it is three partial authorities that
 * had to guess at each other through timers and tolerances (`ownZoomUntilMs`, `ALIGN_HOLD_MS`,
 * `adoptNextAlignSpan`, `sameTimeWindow`, all now deleted). The sheet produced a window out of
 * engraving geometry, the roll clamped and re-published a window of its own, and `ui/app.ts`
 * decided from a 250 ms clock and a 2% comparison which of those two had been a user gesture.
 * A scroll could therefore come back as a zoom half a second later, which is exactly what
 * "breathing" was.
 *
 * `revision` is the mechanism those clocks were badly approximating. It goes up when, and only
 * when, the window actually moved. Anything downstream that wants to know "is this the value I
 * just pushed, or a new one?" compares revisions — an integer, not a tolerance.
 */
export interface TimelineViewport {
  fromSec: number;
  toSec: number;
  revision: number;
}

/** Who asked. Typed, so nothing downstream ever has to infer intent from timing again. */
export type ViewportSource = 'roll' | 'sheet' | 'waveform' | 'scrollbar' | 'transport' | 'system';

/**
 * WHAT A VIEW MAY SAY. Note what is not here: a replacement window.
 *
 * A view that hands over a finished window is claiming authority it does not have, and the
 * moment two of them do it the app is back to reconciling. A view may state an INTENT —
 * "slide by this many seconds", "magnify by this factor about this point", "my left edge is
 * now this second" — and the reducer below decides what that means against the current state
 * and the shared limits.
 *
 * `sheetScroll` is deliberately the only one that names an absolute position, and deliberately
 * names ONE edge: a sheet scroll changes where you are looking, never how much you can see.
 * Deriving a span from the sheet's two engraved endpoints during an ordinary scroll is what
 * turned a scrollbar drag into a zoom (finding 2), because the engraving is not proportional to
 * time and the same pane covers a different number of seconds in a dense bar than a sparse one.
 */
export type ViewportCommand =
  | { kind: 'pan'; deltaSec: number; source: ViewportSource }
  | { kind: 'zoom'; factor: number; anchorFrac: number; source: ViewportSource }
  | { kind: 'sheetScroll'; fromSec: number; source: ViewportSource }
  | { kind: 'showSpan'; fromSec: number; toSec: number; source: ViewportSource }
  | { kind: 'fit'; source: ViewportSource };

/**
 * Below this two windows are the same window.
 *
 * A NUMERIC identity guard and nothing else, which is the whole difference from the 2% echo
 * guard it replaces (finding 5). That one discarded any pan under a fiftieth of the span — 0.2 s
 * on a 10 s window, about 20 px of careful trackpad movement — because it was trying to tell a
 * user gesture from a clamped echo by looking at the numbers. Silent setters mean there are no
 * echoes to tell apart, so this only has to be smaller than anything a person can ask for.
 */
export const VIEWPORT_EPSILON_SEC = 1e-6;

/** The whole take as a viewport, revision zero. */
export function fullViewport(limits: TimeLimits): TimelineViewport {
  const win = clampWindow(fullWindow(limits), limits);
  return { fromSec: win.fromSec, toSec: win.toSec, revision: 0 };
}

export function viewportSpan(v: TimelineViewport): number {
  return v.toSec - v.fromSec;
}

/** The window inside a viewport, for the many callers that do not care about the revision. */
export function viewportWindow(v: TimelineViewport): TimeWindow {
  return { fromSec: v.fromSec, toSec: v.toSec };
}

export function sameViewportWindow(a: TimeWindow, b: TimeWindow): boolean {
  return (
    Math.abs(a.fromSec - b.fromSec) < VIEWPORT_EPSILON_SEC &&
    Math.abs(a.toSec - b.toSec) < VIEWPORT_EPSILON_SEC
  );
}

/**
 * THE REDUCER. Pure: state and a command in, state out, nothing measured and nothing called.
 *
 * Everything the old controller needed a clock for is a consequence of this being a function:
 *
 *   - A pan NEVER changes the span. `panWindow` slides and `clampWindow` slides it back inside
 *     the take keeping the span, so scrolling to either edge preserves both the magnification
 *     and — up to the edge itself — the moment (finding 3). No extrapolated engraving endpoint
 *     can reach this: the only absolute a view may state is `sheetScroll`'s single edge.
 *   - A zoom that is already at a limit returns the SAME OBJECT, so `revision` does not move
 *     and nothing downstream re-renders. That is the saturation contract (finding 9) stated as
 *     an identity rather than as a snap-back.
 *   - Every route in is this one function, so sheet pinch and roll pinch cannot feel different:
 *     the same factor about the same fraction produces the same window (finding 10).
 */
export function reduceViewport(
  state: TimelineViewport,
  cmd: ViewportCommand,
  limits: TimeLimits
): TimelineViewport {
  const win = viewportWindow(state);
  let next: TimeWindow;
  switch (cmd.kind) {
    case 'pan':
      next = panWindow(win, cmd.deltaSec, limits);
      break;
    case 'zoom': {
      // THE SPAN IS CLAMPED BEFORE THE ANCHOR IS SPENT, and that ordering is the saturation
      // contract rather than a detail. `zoomWindowAt` divides first and clamps the finished
      // window, so at a zoom limit it produces a window whose span is illegal, `clampWindow`
      // widens it back, and the position it widens around is NOT where the gesture asked for —
      // repeated pinching against the floor walks the window sideways a few milliseconds at a
      // time while appearing to do nothing. Clamping the span first makes "already at the limit"
      // an exact no-op: the same state comes back, `revision` does not move, and the panes stop
      // together and stay stopped.
      const span = win.toSec - win.fromSec;
      const maxSpan = maxSpanOf(limits);
      const minSpan = Math.max(1e-6, Math.min(limits.minSpanSec, maxSpan));
      const factor = Number.isFinite(cmd.factor) && cmd.factor > 0 ? cmd.factor : 1;
      const wanted = Math.max(minSpan, Math.min(maxSpan, span / factor));
      if (Math.abs(wanted - span) < VIEWPORT_EPSILON_SEC) return state;
      const frac = Number.isFinite(cmd.anchorFrac) ? Math.max(0, Math.min(1, cmd.anchorFrac)) : 0.5;
      const anchorSec = fracToSec(win, frac);
      next = clampWindow({ fromSec: anchorSec - frac * wanted, toSec: anchorSec + (1 - frac) * wanted }, limits);
      break;
    }
    case 'sheetScroll': {
      // ONE EDGE, SPAN PRESERVED. The sheet says where its left edge is; how much is on screen
      // is not its to say, and asking the engraving would give a different answer in every bar.
      const span = win.toSec - win.fromSec;
      const from = Number.isFinite(cmd.fromSec) ? cmd.fromSec : win.fromSec;
      next = clampWindow({ fromSec: from, toSec: from + span }, limits);
      break;
    }
    case 'showSpan':
      next = clampWindow({ fromSec: cmd.fromSec, toSec: cmd.toSec }, limits);
      break;
    case 'fit':
      next = clampWindow(fullWindow(limits), limits);
      break;
  }
  if (sameViewportWindow(next, win)) return state;
  return { fromSec: next.fromSec, toSec: next.toSec, revision: state.revision + 1 };
}

/** Which way the zoom has run out of room. Both true means there is only one legal span. */
export function viewportSaturation(
  state: TimelineViewport,
  limits: TimeLimits
): { atMinSpan: boolean; atMaxSpan: boolean } {
  const duration = Math.max(limits.minSpanSec, limits.durationSec);
  const maxSpan = maxSpanOf(limits);
  const minSpan = Math.max(1e-6, Math.min(limits.minSpanSec, maxSpan));
  const span = viewportSpan(state);
  return {
    atMinSpan: span <= minSpan + VIEWPORT_EPSILON_SEC,
    atMaxSpan: span >= Math.min(maxSpan, duration) - VIEWPORT_EPSILON_SEC
  };
}

/**
 * The span band the SHEET can actually engrave, from one measurement of it.
 *
 * `display.scale` multiplies every engraved coordinate linearly, so a pane of a fixed width
 * shows `refSpanSec * refScale / scale` seconds at any other scale. Feed in what the sheet is
 * doing right now and the two ends of `[minScale, maxScale]` come back as two spans.
 *
 * This is measured rather than assumed for the same reason `absoluteSheetScale` is: how many
 * seconds a bar is wide at scale 1 depends on the meter, the density and the clef, so there is
 * no constant to write down.
 */
export function sheetSpanLimits(
  refSpanSec: number,
  refScale: number,
  minScale: number,
  maxScale: number
): { minSpanSec: number; maxSpanSec: number } | null {
  if (!(refSpanSec > 0) || !(refScale > 0) || !(minScale > 0) || !(maxScale >= minScale)) return null;
  const pxSeconds = refSpanSec * refScale;
  return { minSpanSec: pxSeconds / maxScale, maxSpanSec: pxSeconds / minScale };
}

/**
 * THE INTERSECTION, and it is the whole of the edge contract.
 *
 * Alignment is mandatory in this app, so the shared zoom range cannot be either pane's own: it
 * is the stretch both can reach. The roll cannot zoom past what the sheet can follow, and the
 * take is still the outer wall in both directions.
 *
 * A degenerate intersection (a sheet band entirely outside the roll's) collapses to a single
 * legal span rather than throwing: better a saturated view than a window with `min > max`.
 */
export function intersectLimits(
  base: TimeLimits,
  sheet: { minSpanSec: number; maxSpanSec: number } | null
): TimeLimits {
  const duration = Math.max(base.minSpanSec, base.durationSec);
  if (!sheet) return base;
  const maxSpan = Math.max(1e-6, Math.min(maxSpanOf(base), sheet.maxSpanSec));
  const minSpan = Math.max(1e-6, Math.min(Math.max(base.minSpanSec, sheet.minSpanSec), maxSpan));
  return { durationSec: duration, minSpanSec: minSpan, maxSpanSec: maxSpan };
}

/**
 * FRACTIONAL PINCH DELTAS, KEPT (finding 10).
 *
 * A trackpad reports a pinch as a cumulative scale, and the per-event ratio is routinely a
 * fraction of a percent. Both pinch paths used to drop anything under their threshold AND
 * advance their baseline, so the dropped part was gone for good — at sheet scale 0.6 a
 * one-pixel wheel delta asks for a 0.0009 change against a 0.001 floor, so the sheet simply did
 * not move while the same fingers over the roll did.
 *
 * Folding the ratio in instead makes the threshold a RATE LIMIT rather than a filter: nothing
 * is lost, it merely arrives one or two events later.
 */
export class PinchAccumulator {
  private pending = 1;

  /** A new gesture starts with nothing owed. */
  reset(): void {
    this.pending = 1;
  }

  /** Fold in one raw ratio. Returns the factor to apply, or null while it is still too small. */
  take(ratio: number, minStep = 1e-4): number | null {
    if (!Number.isFinite(ratio) || ratio <= 0) return null;
    this.pending *= ratio;
    if (!Number.isFinite(this.pending) || this.pending <= 0) {
      this.pending = 1;
      return null;
    }
    if (Math.abs(this.pending - 1) < minStep) return null;
    const out = this.pending;
    this.pending = 1;
    return out;
  }

  /** What is still owed, for a test that wants to prove nothing was thrown away. */
  get owed(): number {
    return this.pending;
  }
}

// ---------------------------------------------------------------------------
// The grid: bars and beats, at the seconds they were played
// ---------------------------------------------------------------------------

/**
 * The smallest shape of a score this file needs to lay out a bar grid.
 *
 * Structural rather than `RiffScore` so the arithmetic is testable with three lines of literal
 * data. The caller adapts; see `PianoRoll.barGridSource`.
 */
export interface BarGridSource {
  tempoBpm: number;
  /** IR ticks per quarter note. */
  divisions: number;
  /**
   * `ir.tempo.changes` — symbolic tempo changes at absolute IR ticks, quarter-note BPM.
   *
   * Optional because most sources have none and because the blank-document grid has no IR to take
   * them from. Absent, empty, or describing a single tempo, `tempoBpm` alone decides the grid and
   * the arithmetic below is byte-for-byte what it was before this field existed.
   */
  tempoChanges?: readonly { tick: number; bpm: number }[];
  bars: ReadonlyArray<{
    index: number;
    number: number;
    implicit: boolean;
    /** Absolute IR ticks from the start of the score. */
    startTick: number;
    durTicks: number;
    timeSig: readonly [number, number];
  }>;
}

/** One bar, placed on the RECORDING clock. */
export interface BarSpan {
  index: number;
  /** The number PRINTED on the sheet. An anacrusis is implicit and prints nothing. */
  number: number;
  implicit: boolean;
  startSec: number;
  endSec: number;
  /** How many beats it holds, and how long one of them is. */
  beats: number;
  beatSec: number;
}

/**
 * Bars and their beats, in RECORDING seconds.
 *
 * TEMPO CHANGES ARE FOLLOWED, and they are followed through the pipeline's own map. A score with
 * `ir.tempo.changes` has no single `secPerTick`: at 120 then 60 BPM the fifth bar starts a whole
 * bar later than the scalar says, and the error grows with every bar after the change. When
 * `src.tempoChanges` describes two or more tempi, each bar's two ends go through
 * `buildTickSecondsMap`, which is the same piecewise arithmetic the MIDI writer and the MusicXML
 * tempo directions use, so a bar line here cannot disagree with the file we export.
 *
 * `gridMarks()` inherits all of it for free: it reads `startSec` and `beatSec` off these spans and
 * has never seen a BPM, so its beats and subdivisions bend with the tempo the moment these do.
 *
 * ONE TEMPO IS STILL THE SCALAR, deliberately. `60 / bpm / divisions` is the same expression the
 * roll's `barLines()` and the app's loop bar use, and three pictures of one bar line that are each
 * 2 ms out from the others is a bug nobody can see and everybody can feel. The map's own
 * `60 / (bpm * divisions)` is the same quantity but not necessarily the same double, so a
 * constant-tempo score — every existing test, probe and screenshot — keeps the multiply verbatim,
 * ends included, rather than being nudged by a rounding step it did not ask for.
 *
 * `beats` is the time signature's numerator, so 6/8 comes out as six eighth-note beats rather
 * than two dotted-quarter ones. That is what the edit grid and the note-name row already
 * assume, and a compound meter drawn two ways in one window is worse than one drawn simply.
 */
export function barGrid(src: BarGridSource, originSec: number): BarSpan[] {
  const secPerTick = 60 / (src.tempoBpm || 100) / (src.divisions || 12);
  // The map is built on the SAME two fallbacks, so a source with a missing tempo or missing
  // divisions lands on 100 and 12 whichever branch reads it. `segments.length > 1` is the whole
  // test for "this score changes tempo": one segment is an affine map that the multiply below
  // already expresses exactly, and a lone change at tick 0 is a tempo, not a change.
  const built = src.tempoChanges?.length
    ? buildTickSecondsMap({
        divisions: src.divisions || 12,
        tempo: { displayBpm: src.tempoBpm || 100, changes: [...src.tempoChanges] }
      })
    : null;
  const map = built && built.segments.length > 1 ? built : null;
  const out: BarSpan[] = [];
  for (const bar of src.bars) {
    const startSec = originSec + (map ? map.tickToSec(bar.startTick) : bar.startTick * secPerTick);
    // The END is converted from its own tick rather than from `startSec + duration`, because past
    // a tempo change the two are different numbers and only the tick is true. `beatSec` below is
    // then tempo-aware for nothing extra: both ends already are.
    const endSec = map
      ? originSec + map.tickToSec(bar.startTick + bar.durTicks)
      : startSec + bar.durTicks * secPerTick;
    const beats = Math.max(1, Math.round(bar.timeSig?.[0] ?? 4));
    out.push({
      index: bar.index,
      number: bar.number,
      implicit: bar.implicit,
      startSec,
      endSec,
      beats,
      beatSec: (endSec - startSec) / beats
    });
  }
  return out;
}

/** What a grid line is. The three weights a DAW ruler draws. */
export type GridLevel = 'bar' | 'beat' | 'sub';

export interface GridMark {
  sec: number;
  level: GridLevel;
  /** The bar number, on bar lines only, and only when the bar prints one. */
  label: string | null;
}

/** Which levels there is room for, at this zoom. */
export interface GridDetail {
  bars: boolean;
  beats: boolean;
  subs: boolean;
  /** Draw every Nth bar line's LABEL. 1 = all of them. Lines are always drawn for every bar. */
  labelEvery: number;
  /**
   * How many equal parts a BEAT is cut into by the finest level.
   *
   * Carried on the detail rather than baked into `gridMarks` because it is the EDIT GRID's
   * number, not the zoom's: the roll snaps a drag to the unit the player picked in the Grid
   * selector, and a drawn grid at a different subdivision is a ruler that disagrees with the
   * thing it is ruling. 3 is a triplet, and a triplet-snapped note landing between two drawn
   * columns was exactly the reported symptom.
   */
  subsPerBeat: number;
}

/** Below this many pixels apart, a set of lines stops being a grid and becomes a tint. */
const MIN_LINE_GAP_PX = 7;
/** A bar number needs about this much room or the numbers collide. */
const MIN_LABEL_GAP_PX = 34;
/** How many subdivisions of a beat the finest level draws when nobody has said otherwise. */
export const SUBS_PER_BEAT = 4;

/**
 * The edit grid, as a number of parts per BEAT.
 *
 * The vocabulary is the piano roll's Grid selector (`PianoRollEditGrid`), taken as a plain
 * string union so this module still imports nothing. A beat is a quarter note on the meters
 * this app writes, so 'eighth' is two parts and 'sixteenth' four; 'triplet' is three, which is
 * the whole reason this exists — the drawn grid was hard-wired to four and a triplet-snapped
 * note therefore sat between two drawn columns.
 *
 * 'free' snaps to nothing, so there is no unit it could draw; it falls back to the default
 * quarter-division rather than drawing no subdivisions at all, because the ruler is still
 * useful when the notes are not on it.
 *
 * 'off' RETURNS 0, and 0 is a value with a meaning here rather than an absence: "the beat is
 * not a unit I draw at all". `gridDetail` reads it as BAR LINES ONLY. Every other answer is at
 * least 1 (the beat itself), so 0 cannot collide with a real subdivision count.
 */
export function subdivisionsPerBeat(
  grid: 'off' | 'quarter' | 'eighth' | 'sixteenth' | 'thirtysecond' | 'triplet' | 'free'
): number {
  switch (grid) {
    case 'off':
      return 0;
    case 'quarter':
      return 1;
    case 'eighth':
      return 2;
    case 'sixteenth':
      return 4;
    // Eight per beat: a 32nd note is an eighth of a quarter, and a quarter is the beat on every
    // meter this app writes.
    case 'thirtysecond':
      return 8;
    case 'triplet':
      return 3;
    case 'free':
      return SUBS_PER_BEAT;
  }
}

/**
 * How much grid to draw, decided by SPACING rather than by zoom.
 *
 * Spacing, because the same window is a different picture on a 390 px plugin pane and a 1600 px
 * desktop one. `medianBeatSec` is used rather than the exact local beat so the answer does not
 * flicker between two levels while the pointer moves through a tempo-less passage.
 *
 * `subsPerBeat` is the EDIT GRID's subdivision (see `subdivisionsPerBeat`). It changes both what
 * is drawn and whether there is room to draw it: three columns per beat fit where four do not.
 * 1 means the beat is the finest unit there is, so there are no subdivisions to draw at all.
 */
export function gridDetail(
  medianBeatSec: number,
  secondsPerPixel: number,
  subsPerBeat: number = SUBS_PER_BEAT
): GridDetail {
  const beatPx = secondsPerPixel > 0 ? medianBeatSec / secondsPerPixel : Number.POSITIVE_INFINITY;
  // GRID 'off': bar lines and nothing else. Checked before the clamp below, which would
  // otherwise round 0 up to 1 and draw the beats anyway. Bar lines stay because the bar number
  // is the one landmark the ruler is for; see `subdivisionsPerBeat`.
  if (Number.isFinite(subsPerBeat) && Math.round(subsPerBeat) === 0) {
    return { bars: true, beats: false, subs: false, labelEvery: labelStep(beatPx), subsPerBeat: 0 };
  }
  const parts = Number.isFinite(subsPerBeat) ? Math.max(1, Math.round(subsPerBeat)) : SUBS_PER_BEAT;
  const bars = true;
  const beats = beatPx >= MIN_LINE_GAP_PX;
  const subs = parts > 1 && beatPx / parts >= MIN_LINE_GAP_PX;
  return { bars, beats, subs, labelEvery: labelStep(beatPx), subsPerBeat: parts };
}

function labelStep(beatPx: number): number {
  // Bars are four beats often enough that this is the right unit to reason in, and the answer
  // is corrected by the caller when it knows the real bar length.
  const barPx = beatPx * 4;
  if (!Number.isFinite(barPx) || barPx <= 0) return 1;
  for (const step of [1, 2, 4, 8, 16, 32]) {
    if (barPx * step >= MIN_LABEL_GAP_PX) return step;
  }
  return 64;
}

/**
 * Every grid line inside a window, in time order, coarsest weight first per position.
 *
 * Only what is ON SCREEN: this is called once per frame and a five-minute take at the finest
 * subdivision is tens of thousands of positions, almost none of them visible.
 *
 * A position that is both a bar line and a beat comes back ONCE, as a bar — the strongest
 * weight wins, so a caller can paint the list in order without worrying that it is drawing a
 * faint line over a strong one.
 */
export function gridMarks(
  bars: ReadonlyArray<BarSpan>,
  win: TimeWindow,
  detail: GridDetail
): GridMark[] {
  const out: GridMark[] = [];
  if (bars.length === 0) return out;

  let printed = 0;
  for (const bar of bars) {
    // A bar that ends before the window starts, or starts after it ends, has nothing to add.
    if (bar.endSec < win.fromSec || bar.startSec > win.toSec) {
      if (!bar.implicit) printed++;
      continue;
    }
    if (detail.bars && bar.startSec >= win.fromSec && bar.startSec <= win.toSec) {
      const show = !bar.implicit && printed % Math.max(1, detail.labelEvery) === 0;
      out.push({ sec: bar.startSec, level: 'bar', label: show ? String(bar.number) : null });
    }
    if (!bar.implicit) printed++;

    if (!detail.beats || !(bar.beatSec > 0)) continue;
    for (let b = 1; b < bar.beats; b++) {
      const sec = bar.startSec + b * bar.beatSec;
      if (sec < win.fromSec || sec > win.toSec) continue;
      out.push({ sec, level: 'beat', label: null });
    }
    if (!detail.subs) continue;
    // The EDIT GRID's subdivision, carried on the detail. See `GridDetail.subsPerBeat`.
    const parts = Math.max(1, Math.round(detail.subsPerBeat || SUBS_PER_BEAT));
    const sub = bar.beatSec / parts;
    for (let b = 0; b < bar.beats; b++) {
      for (let s = 1; s < parts; s++) {
        const sec = bar.startSec + b * bar.beatSec + s * sub;
        if (sec < win.fromSec || sec > win.toSec) continue;
        out.push({ sec, level: 'sub', label: null });
      }
    }
  }
  out.sort((a, b) => a.sec - b.sec || levelRank(a.level) - levelRank(b.level));
  return out;
}

function levelRank(level: GridLevel): number {
  return level === 'bar' ? 0 : level === 'beat' ? 1 : 2;
}

/** The median bar's beat length — the number `gridDetail` wants. 0 when there are no bars. */
export function medianBeatSec(bars: ReadonlyArray<BarSpan>): number {
  const lengths = bars.map((b) => b.beatSec).filter((s) => s > 0).sort((a, b) => a - b);
  if (lengths.length === 0) return 0;
  return lengths[lengths.length >> 1];
}

// ---------------------------------------------------------------------------
// Align: two viewports, one musical region
// ---------------------------------------------------------------------------

/**
 * How wide the sheet's left gutter is, in px — the column the roll uses for pitch names and the
 * sheet is padded to leave blank. Aligning the two edges means aligning the two MUSIC edges, not
 * the two element edges, so this comes off both. `TIMELINE_GUTTER_PX` in view/pianoroll.ts is
 * this same number under the name the roll knows it by; there is deliberately only one.
 */
export const ALIGN_GUTTER_PX = 34;

// FOUR THINGS STOOD HERE AND ARE GONE (finding 14): `SheetViewport`,
// `sheetScrollForSec`, `clampXToEngraving` and `windowFromSheet`.
//
// They were a COMPLETE SECOND DESIGN for alignment — sheet scrolling, engraved-edge clamping and
// window extraction — with no production caller. `ui/app.ts` hand-implemented a different edge
// policy beside them, and the two disagreed on the one question that matters: `windowFromSheet`
// documented engraved clamping as necessary while the shipped `TriView.contentXToTick` deliberately
// extrapolated through the page padding. Both were tested, both were described as correct, and the
// live feedback bugs came directly out of trying to keep two incompatible generations alive.
//
// There is nothing left to clamp, because nothing derives a window from the engraving any more.
// The sheet states ONE edge (`ViewportCommand.sheetScroll`) and the reducer supplies the span.
//
// `coupledSheetScale` went with them. It scaled the sheet by the RATIO of the previous span to
// the new one, which needs a previous span to be remembered and therefore needs somebody to
// decide which of several remembered spans was the real one. `absoluteSheetScale` below answers
// the same question from a measurement of the live engraving and needs no memory at all.

/**
 * How far the ENGRAVING actually reaches, in content pixels.
 *
 * `firstX` is the first engraved beat's x and `lastX` the right edge of the final bar — the two
 * ends of the tick axis, which is the only stretch of the page where "which second is at this
 * x" has been measured rather than extrapolated.
 */
export interface EngravedExtent {
  firstX: number;
  lastX: number;
}

/**
 * How many content pixels the engraving spends on one second, at the CURRENT `display.scale`.
 *
 * The one measurement the sheet's half of the coupling rests on, and the only thing anybody
 * still asks the engraving's geometry for. Taken across the WHOLE engraved extent rather than
 * across the viewport, on purpose: alphaTab spaces a dense bar wider than a sparse one, so a
 * measurement over one screenful moves as you scroll, and a calibration that moves when you
 * scroll is how a scroll turns back into a zoom. Over both ends it is one number for the take.
 *
 * Null when there is nothing engraved yet, or when the two ends carry no time between them.
 */
export function engravedPxPerSec(
  extent: EngravedExtent | null | undefined,
  secAtContentX: (x: number) => number | null
): number | null {
  if (!extent) return null;
  const { firstX, lastX } = extent;
  if (!Number.isFinite(firstX) || !Number.isFinite(lastX) || !(lastX > firstX)) return null;
  const from = secAtContentX(firstX);
  const to = secAtContentX(lastX);
  if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (!(to - from > 1e-6)) return null;
  return (lastX - firstX) / (to - from);
}

// ---------------------------------------------------------------------------
// The origin: where bar 1 sits on the recording's clock
// ---------------------------------------------------------------------------

/**
 * WRITTEN SECOND 0 ON THE RECORDING'S CLOCK, derived from the FIRST NOTE rather than from the
 * top of the file.
 *
 * THE BUG THIS EXISTS FOR (F13). A take with leading silence engraves its first attack in bar 1
 * — the pipeline anchors the music, not the tape — while the roll and the waveform draw that
 * same attack where it was actually played, two seconds in. `scoreOriginSec()` answers this
 * question from `barOneSec`, which is 0 unless somebody has dragged the bar-1 marker, so the
 * sheet claimed bar 1 was at second 0 and Align had no way to bring the two together: every
 * mapping was uniformly wrong by the length of the silence.
 *
 * One attack pins the two clocks together, and it is the first one because it is the only event
 * both pictures are certain to contain:
 *
 *     audioSec = writtenSec + origin,  where  origin = firstPerformedSec - firstWrittenSec
 *
 * Returns `fallbackSec` when either end is missing (no notes yet, or a score with no performed
 * times), so a blank document still has a defined origin rather than a NaN that would poison
 * every x on the page.
 *
 * NOT CLAMPED TO ZERO. A negative origin is a real state — a pickup engraved before bar 1 whose
 * first attack was played earlier than written second 0 — and forcing it up to 0 would re-open
 * the same misalignment from the other side. What must not go negative is a SCROLL, and that is
 * `sheetScrollForSec`'s job, not this one.
 */
export function alignOriginSec(
  firstWrittenSec: number | null | undefined,
  firstPerformedSec: number | null | undefined,
  fallbackSec = 0
): number {
  if (
    firstWrittenSec === null ||
    firstWrittenSec === undefined ||
    firstPerformedSec === null ||
    firstPerformedSec === undefined ||
    !Number.isFinite(firstWrittenSec) ||
    !Number.isFinite(firstPerformedSec)
  ) {
    return Number.isFinite(fallbackSec) ? fallbackSec : 0;
  }
  return firstPerformedSec - firstWrittenSec;
}

/** A recording second as a WRITTEN one, against an origin. The pair below cannot drift apart. */
export function writtenSecAt(audioSec: number, originSec: number): number {
  return audioSec - originSec;
}

/** A written second as a RECORDING one. The exact inverse of `writtenSecAt`. */
export function audioSecAt(writtenSec: number, originSec: number): number {
  return writtenSec + originSec;
}

/**
 * The sheet scale that makes the sheet's viewport show exactly `spanSec` of music.
 *
 * `pxPerSecAtCurrentScale` is MEASURED off the live engraving — take two seconds a known
 * distance apart, ask the sheet where they are, divide — so this needs no constant describing
 * how wide a bar is at scale 1, which is not a constant anyway (it depends on the meter, the
 * rhythmic density and the clef).
 *
 * THE ONLY COUPLING LAW LEFT, and being absolute is why. Its predecessor scaled by the ratio of
 * the previous span to the new one, so every zoom had to be told what the previous span had
 * been — and when the answer was wrong (a clamped window, a stale remembered one, an engraving
 * that had moved underneath) the error compounded across gestures instead of being corrected by
 * the next one. This asks only what the sheet is doing NOW and what span is wanted, so a scale
 * that came out 0.0009 short and was dropped under `setZoom`'s render threshold is simply asked
 * for again, correctly, on the very next event. Nothing accumulates and nothing is owed.
 */
export function absoluteSheetScale(
  currentScale: number,
  pxPerSecAtCurrentScale: number,
  viewportWidth: number,
  spanSec: number,
  minScale: number,
  maxScale: number
): number {
  if (!(pxPerSecAtCurrentScale > 0) || !(spanSec > 0) || !(viewportWidth > 0)) return currentScale;
  const wantedPxPerSec = viewportWidth / spanSec;
  return Math.max(minScale, Math.min(maxScale, currentScale * (wantedPxPerSec / pxPerSecAtCurrentScale)));
}

// ---------------------------------------------------------------------------
// BPM CHANGES TIME, NOT TYPOGRAPHY
// ---------------------------------------------------------------------------

/**
 * WHAT A REBUILD IS ALLOWED TO DO TO THE WINDOW. Typed, because the two answers are opposite.
 *
 * `follow-window` — the span on screen is a decision the player made and the new engraving must
 *   be scaled to honour it. Every ordinary rebuild: an edit, a snap change, a re-quantize. The
 *   written music moved; the clock under it did not, so the same seconds mean the same music.
 *
 * `preserve-sheet-scale` — the CLOCK moved. A tempo (or meter) change re-maps written ticks onto
 *   seconds and nothing else: the same notes, the same page, a different number of seconds per
 *   bar. Scaling the engraving to keep the old seconds on screen turns that into a zoom command —
 *   at 30 BPM a quarter of the measured px/sec asks for about four times `display.scale`, and the
 *   sheet visibly grows under a control that was never about size. So the SIZE is what is held
 *   and the seconds window is rebased around an anchor instead.
 *
 * The three things a tempo change cannot all preserve are the engraving's size, the old seconds
 * window, and endpoint alignment between the panes. This picks SIZE plus ALIGNMENT: the same
 * bars stay on screen at the same size, and the roll and the strip widen (or narrow) to say the
 * same music now occupies more (or fewer) seconds. That is what a tempo change MEANS.
 */
export type RebuildViewportPolicy = 'follow-window' | 'preserve-sheet-scale';

/**
 * The window a FIXED engraving shows, around an anchor. The exact inverse of `absoluteSheetScale`.
 *
 * `absoluteSheetScale` answers "what scale shows this span"; this answers "what span does this
 * scale show", off the same one measurement of the live engraving. Being each other's inverse is
 * the property that makes the rebuild a fixed point rather than a nudge: hand the window this
 * returns straight back to `absoluteSheetScale` at the same `pxPerSec` and it asks for the scale
 * the sheet is already at, so the re-engrave that would have been the visible bug never starts.
 *
 * `anchorFrac` is where in the plot the anchor is pinned — 0 for the left edge, which is the one
 * point the sheet and the roll are exactly pinned at anyway (§sheetLeftEdgeSec).
 *
 * CLAMPED, and the clamp is not cosmetic. `limits` is the shared range, so a span the take cannot
 * hold (a slow tempo on a short document) comes back reduced — and the caller has then been told,
 * honestly, that size could not be held. See `App.rebaseViewportAtSheetScale`.
 */
export function preservedScaleWindow(
  anchorSec: number,
  anchorFrac: number,
  pxPerSecAtCurrentScale: number,
  plotWidthPx: number,
  limits: TimeLimits
): TimeWindow | null {
  if (!(pxPerSecAtCurrentScale > 0) || !(plotWidthPx > 0) || !Number.isFinite(anchorSec)) return null;
  return windowShowing(anchorSec, anchorFrac, plotWidthPx / pxPerSecAtCurrentScale, limits);
}
