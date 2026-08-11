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
 */

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
  const minSpan = Math.max(1e-6, Math.min(limits.minSpanSec, duration));

  let span = win.toSec - win.fromSec;
  if (!Number.isFinite(span) || span <= 0) span = duration;
  span = Math.max(minSpan, Math.min(duration, span));

  let from = Number.isFinite(win.fromSec) ? win.fromSec : 0;
  from = Math.max(0, Math.min(duration - span, from));
  return { fromSec: from, toSec: from + span };
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
 * `secPerTick` is deliberately the SAME expression the roll's existing `barLines()` and the
 * app's loop bar use — `60 / bpm / divisions` with the same fallbacks — because three pictures
 * of one bar line that are each 2 ms out from the others is a bug nobody can see and everybody
 * can feel.
 *
 * ONE TEMPO. `ir.tempo.changes` is not consulted, for the same reason `secondsToTick` in the
 * app does not: every other second<->tick conversion on this path is single-tempo, and a grid
 * that followed a tempo map while the notes beside it did not would put a bar line beside the
 * downbeat rather than on it. When the app grows a real tempo map this is one of the places
 * that has to learn about it, and it is written to make that a change of one function.
 *
 * `beats` is the time signature's numerator, so 6/8 comes out as six eighth-note beats rather
 * than two dotted-quarter ones. That is what the edit grid and the note-name row already
 * assume, and a compound meter drawn two ways in one window is worse than one drawn simply.
 */
export function barGrid(src: BarGridSource, originSec: number): BarSpan[] {
  const secPerTick = 60 / (src.tempoBpm || 100) / (src.divisions || 12);
  const out: BarSpan[] = [];
  for (const bar of src.bars) {
    const startSec = originSec + bar.startTick * secPerTick;
    const endSec = startSec + bar.durTicks * secPerTick;
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
 * What the sheet looks like right now, in the two numbers this file needs.
 *
 * Deliberately not `TriViewViewport`: this function must be callable from a test with three
 * literals, and it must not drag a renderer into a module about arithmetic.
 */
export interface SheetViewport {
  scrollLeft: number;
  viewportWidth: number;
  contentWidth: number;
  /** alphaTab's `display.scale`. */
  scale: number;
}

/**
 * How wide the sheet's left gutter is, in px — the column the roll uses for pitch names and
 * the sheet is padded to leave blank. Aligning the two edges means aligning the two MUSIC
 * edges, not the two element edges, so this comes off both.
 */
export const ALIGN_GUTTER_PX = 34;

/**
 * Where to scroll the sheet so its first engraved column shows `sec`.
 *
 * `contentXAt` is the sheet's own geometry — `tickToContentX` through the app's second<->tick
 * mapping — so this asks the engraving where a moment is rather than assuming anything about
 * how it is spaced. That is the whole reason Align can be exact at the edge while the two
 * views remain differently spaced inside it: only ONE point is being matched.
 *
 * Null when the sheet cannot place that second yet (nothing engraved), which is a normal state
 * and means "leave the scroll alone this frame".
 *
 * IT PARKS, IT DOES NOT GO NEGATIVE (F13). Scroll the roll left of the first note — into the
 * leading silence, which the roll and the waveform quite rightly go on drawing — and the second
 * asked for here is before written second 0. There is no page there, so the answer is 0: the
 * sheet sits still at its start while the other two strips keep scrolling. The alternative, a
 * negative scroll clamped by the browser to 0 anyway, is the same picture arrived at through a
 * value nothing else can reason about; and letting it wrap to the far end would make the sheet
 * jump, which is what was reported.
 */
export function sheetScrollForSec(
  sec: number,
  contentXAt: (sec: number) => number | null,
  view: SheetViewport
): number | null {
  const x = contentXAt(sec);
  if (x === null || !Number.isFinite(x)) return null;
  const max = Math.max(0, view.contentWidth - view.viewportWidth);
  return Math.max(0, Math.min(max, x - ALIGN_GUTTER_PX));
}

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
 * Hold an x inside the engraving before anybody turns it into a time.
 *
 * THE BUG THIS EXISTS FOR. `x -> tick` extrapolates past both ends on purpose (a note's tail
 * that runs a fraction past the last beat has to land somewhere). Feed it the sheet's RIGHT
 * VIEWPORT EDGE, though, and the extrapolation is not a rounding detail: on a take whose
 * engraving is narrower than the pane — a short riff, or any take at a deep zoom-out — the edge
 * is hundreds of pixels past the last bar, so the derived window ends well past the end of the
 * recording. `clampWindow` then slides that window back inside the take KEEPING ITS SPAN, which
 * moves `fromSec` away from the second the sheet's left edge is really showing. The roll and the
 * sheet are then looking at different music at different scales, and the next coupled zoom
 * computes its ratio from the wrong previous span and compounds it. Measured as ~578 px of
 * drift.
 *
 * Clamping is the honest answer rather than a fudge: past the last engraved bar there is no more
 * music, so the last engraved moment IS what that edge is showing.
 *
 * BOTH ENDS, and the left one was re-measured rather than assumed (G2).
 *
 * Left of the first engraved beat is the CLEF, KEY AND METER PREFIX: real page width standing
 * for no time at all. Dropping the left clamp so that column extrapolates was tried, live, on
 * the grand-staff demo — it fixes the first note (177 px -> 83 px) and makes every note after it
 * worse (1 px -> 159 px), because the extrapolation runs off the slope of the FIRST TWO BEATS,
 * which at the start of a fast figure is far steeper than the take's average. Pinning the window
 * to the first engraved beat is the better of the two, and it is measured that way round rather
 * than argued.
 *
 * The residual it leaves — the first note sitting up to `firstX - ALIGN_GUTTER_PX` right of its
 * own rectangle at scroll 0 — is a FRACTION question, not a clamping one: the roll is told the
 * first anchor is at frac 0 (its gutter) when the sheet has it at `firstX`. See
 * `windowFromSheet` and the anchor list in ui/app.ts.
 */
export function clampXToEngraving(x: number, extent: EngravedExtent | null | undefined): number {
  if (!extent) return x;
  const { firstX, lastX } = extent;
  if (!Number.isFinite(firstX) || !Number.isFinite(lastX) || !(lastX > firstX)) return x;
  return Math.max(firstX, Math.min(lastX, x));
}

/**
 * The window the roll should show to match what the sheet is showing.
 *
 * The sheet is the one being read here: its left edge and its right edge are turned into
 * seconds and become the window. Null when the sheet cannot answer.
 *
 * `engraved` is the stretch of page that has actually been engraved; pass it and both edges are
 * held inside it first. See `clampXToEngraving` for why that is not optional in practice.
 */
export function windowFromSheet(
  view: SheetViewport,
  secAtContentX: (x: number) => number | null,
  limits: TimeLimits,
  engraved?: EngravedExtent | null
): TimeWindow | null {
  const from = secAtContentX(clampXToEngraving(view.scrollLeft + ALIGN_GUTTER_PX, engraved));
  const to = secAtContentX(clampXToEngraving(view.scrollLeft + view.viewportWidth, engraved));
  if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (!(to > from)) return null;
  return clampWindow({ fromSec: from, toSec: to }, limits);
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
 * THE COUPLING FACTOR, stated once.
 *
 * With Align on, the roll and the sheet must magnify together: zoom the roll in by 2 and the
 * sheet has to get twice as big too, or the two panes stop showing the same music and the
 * feature is a lie the moment anybody touches the wheel.
 *
 * The rule is exactly inverse proportionality:
 *
 *     newScale / oldScale  =  oldSpanSec / newSpanSec
 *
 * and it is not a taste. alphaTab's `display.scale` multiplies every engraved coordinate
 * linearly (measured at 0.5, 1 and 2 in the 1.8.4 build here — the same measurement
 * `leftInkOverhangPerScale` in triview.ts rests on), so the sheet's pixels-per-second is
 * `pxPerSec(1) * scale`. Making the sheet's visible span equal the roll's therefore means
 * making `viewportWidth / (pxPerSec(1) * scale)` equal `spanSec`, which rearranges to the line
 * above with everything unmeasurable cancelled out.
 *
 * Stated as a RATIO rather than an absolute scale because the absolute one needs a measurement
 * of the current engraving (`pxPerSecAtCurrentScale`) that is only available when something has
 * been engraved. `absoluteSheetScale` below is the measured form; this is the one a plain zoom
 * notch uses, and the two agree.
 */
export function coupledSheetScale(
  currentScale: number,
  oldSpanSec: number,
  newSpanSec: number,
  minScale: number,
  maxScale: number
): number {
  if (!(oldSpanSec > 0) || !(newSpanSec > 0) || !Number.isFinite(currentScale)) return currentScale;
  return Math.max(minScale, Math.min(maxScale, currentScale * (oldSpanSec / newSpanSec)));
}

/**
 * The sheet scale that makes the sheet's viewport show exactly `spanSec` of music.
 *
 * `pxPerSecAtCurrentScale` is MEASURED off the live engraving — take two seconds a known
 * distance apart, ask the sheet where they are, divide — so this needs no constant describing
 * how wide a bar is at scale 1, which is not a constant anyway (it depends on the meter, the
 * rhythmic density and the clef).
 *
 * Used when Align is switched ON, where there is no "old span" to scale from: the sheet has to
 * be brought to the roll in one step rather than nudged.
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
