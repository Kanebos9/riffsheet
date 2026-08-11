/**
 * The waveform strip.
 *
 * Jobs: show the recording, seek on click, carry the draggable "bar 1" marker, say which part
 * of the take the sheet is reading, and — when you click it — hand the tuner a short window of
 * audio to interrogate.
 *
 * ===========================================================================================
 * 1. WHY THERE IS NO DRAG-OUT-A-RANGE GESTURE ANY MORE
 * ===========================================================================================
 * Up to v1.2 the way into the tuner was to drag a stretch of recording out of this strip. That
 * is gone, on the owner's decision, and the reasoning is worth keeping because it will look
 * like a lost feature otherwise:
 *
 *   A dragged region can contain many notes, and "what pitch is in these four seconds" has no
 *   good answer — the tuner had to group runs, pick a headline and hedge. "What is at THIS
 *   moment" has exactly one answer, and it is the answer the player wanted.
 *
 * The property that had to survive the change — and the only reason selection existed at all —
 * is that you must be able to point at a place where the app heard NO note. A click on the
 * waveform still does that, because you are pointing at the RECORDING and not at a notehead.
 * That is the whole feature; the drag was only ever the delivery mechanism.
 *
 * So a click now emits one committed selection of a FIXED width, `PROBE_WINDOW_SEC`, centred
 * on the moment you clicked. `onSelectionChange(sel, commit)` is unchanged as an outward
 * contract, so the integrator's wiring and the tuner keep working untouched: the strip simply
 * never emits anything but that one width.
 *
 * WHY 0.2 SECONDS, measured against `audio/pitch.ts` rather than guessed:
 *   - the detector's analysis frame is two periods of the lowest note it will look for
 *     (27.5 Hz), i.e. ~73 ms. Under that there is no frame at all.
 *   - `detectPitchTrack`'s default hop is 50 ms, and `ui/tuner.ts` requires `MIN_RUN_FRAMES`
 *     = 2 frames to agree before it will call something a note rather than a transient.
 *   - 0.2 s gives floor((0.200 - 0.073) / 0.05) + 1 = 3 frames. One more than the minimum, so
 *     a steady note survives the run filter with a frame to spare.
 *   - and 0.2 s is shorter than an eighth note at 120 BPM (0.25 s), so it does not straddle
 *     two notes at any tempo a bass player is likely to be at.
 * It is ONE constant. Tuning this feature means changing that number and nothing else.
 *
 * ===========================================================================================
 * 2. ONE AXIS: LINEAR RECORDING TIME, FOR EVERYBODY
 * ===========================================================================================
 * `x = gutter + sec / durationSec * plotWidth`, and `view/pianoroll.ts` uses the identical
 * mapping (it exports `TIMELINE_GUTTER_PX` so the two cannot drift), so a rectangle on the
 * roll sits over the sound that made it and both agree with the transport about what a second
 * is.
 *
 * THERE WAS A SECOND AXIS AND IT IS DELETED. The strip and the roll could both be put on the
 * SHEET's engraved x — a chip switched it — so that a rectangle sat under the notehead that
 * produced it. It reads beautifully in a screenshot and it is unusable: alphaTab gives a
 * rhythmically dense bar more pixels than a sparse one, so the axis MOVES whenever the
 * engraving changes, and the engraving changes on every edit. Adding one note re-spaced the
 * whole picture of the recording. A waveform that shifts when you edit a note has stopped
 * being evidence, which is the only thing this strip is for.
 *
 * The chip survives as `alignViews` ("Align") and does something the geometry cannot break:
 * point at a moment in any view and the sheet scrolls to it. See `ui/app.ts`. `probe()` still
 * reports `sheetLinked`, always false, so a check that asserted it keeps being asked.
 *
 * ===========================================================================================
 * 3. TWO CLOCKS, ONE ORIGIN — the documented past bug (design notes §4.13)
 * ===========================================================================================
 * The peaks in this file are on the RECORDING's clock, which starts at the top of the file.
 * The sheet map speaks WRITTEN score seconds, which start at bar 1 and keep whatever came
 * before it as an anacrusis. The difference is `scoreOriginSec(score, barOneSec)`:
 *
 *     writtenSec = audioSec - origin        audioSec = writtenSec + origin
 *
 * This file does NOT compute that origin. It is handed one through `setScoreOrigin()` and it
 * uses it and nothing else. In v1.1 three consumers each had their own idea of the origin and
 * the cursor ran a whole count-in ahead of the audio; the fix was to make all of them ask the
 * same function. A fourth consumer inventing its own would re-open exactly that bug, and it
 * would look like "the waveform is a bit out" rather than like a timebase error.
 *
 * The origin defaults to 0, which is only correct for a take with no count-in. An integrator
 * that wires `sheetMap` and forgets `setScoreOrigin` gets a strip shifted by the anacrusis —
 * so `probe().scoreOriginSec` reports it, next to the sheet's own.
 *
 * ===========================================================================================
 * 4. ENGRAVED X IS NOT LINEAR IN TIME, SO THE ENVELOPE IS DRAWN PER SCREEN COLUMN
 * ===========================================================================================
 * A bar of semiquavers is engraved wider than a bar of semibreves, so on the sheet's axis a
 * second of audio is worth a different number of pixels in every bar. Iterating peak buckets
 * and painting each one where it lands would leave gaps in the stretched bars and overdraw in
 * the squeezed ones — a smear.
 *
 * So every column asks its own question: "which span of RECORDING time do I cover?", via the
 * axis's inverse, and reduces exactly the peaks inside that span. That is correct at any
 * stretch factor, in both modes, and it costs one pass over the peak array per frame however
 * the axis is bent.
 *
 * IS IT READABLE? THE STRETCHING IS FINE. THE RESOLUTION IS NOT, AND THAT IS NOT THIS FILE'S
 * BUG. `ui/app.ts` computes `PEAK_BUCKETS = 2000` for the WHOLE take, once. Linked mode shows
 * only the slice the sheet is on, so if a fraction `f` of the take is engraved on screen the
 * strip has `2000 * f` buckets to spread over its plot width. At the 1180px design target the
 * plot is ~1146px, so the envelope is at or above native resolution only while
 *
 *     f >= 1146 / 2000 ≈ 0.57
 *
 * — i.e. only while more than half the recording is on screen. On the 5-bar demo fixture the
 * whole score fits and it looks exactly like a waveform. On a real 3-minute take showing two
 * bars out of ninety, f ≈ 0.022: forty-five buckets across 1146px, i.e. one peak every 25
 * pixels. That is a bar chart, not an envelope.
 *
 * Two things are done about it, and one is not done here:
 *   - a column narrower than one bucket interpolates the envelope between the two neighbouring
 *     bucket centres instead of repeating one bucket's value as a 25px plateau. This can never
 *     invent a peak larger than the data — every value lies between two real measurements —
 *     and it turns a staircase back into a shape. Columns a bucket or wider take the exact
 *     min/max, byte for byte what this file drew before: checked over 4704 columns at plot
 *     widths of 1146, 866 and 326, zero of them differ from the old bucket arithmetic. The
 *     interpolating branch only opens on the even ruler if somebody stretches the window past
 *     2000px of plot, where the old code was drawing plateaus anyway.
 *   - THE REAL FIX IS ONE NUMBER IN `ui/app.ts`: `PEAK_BUCKETS` 2000 -> 20000. Two Float32
 *     arrays of 20000 is 160 KB, computed once per take in a single pass that already reads
 *     every sample, and it moves the threshold to f >= 0.057. It is not changed here because
 *     this file does not own it.
 *
 * ===========================================================================================
 * 5. THE HANDLE LANE IS GONE; A WHOLE-TAKE OVERVIEW RIBBON TOOK ITS PLACE
 * ===========================================================================================
 * The lane along the top existed for exactly one reason: forty-six pixels could not tell FOUR
 * gestures apart (seek, drag bar 1, drag the viewport bracket, drag out a selection), so the
 * two handles were moved out of the waveform and the body was given wholly to selection.
 *
 * The fourth gesture is gone and the strip is now 72px, so the lane has no job left. The bar-1
 * flag is back on the body, on the audio it marks, grabbable along its own full-height line —
 * which is where it lived for the whole of v1.0 and v1.1 and where muscle memory expects it.
 *
 * The top band did not disappear, though; it changed meaning, because linked mode created a
 * genuine new problem: WHEN THE BODY IS ON THE SHEET'S AXIS, THE STRIP NO LONGER SHOWS THE
 * WHOLE RECORDING. Something has to (plan notes §1.3) — where the loud bits are, where the app
 * trimmed silence, how much of the take you are actually reading. So when, and only when, the
 * body is engraved, a thin whole-take overview ribbon appears along the top on the plain even
 * ruler, with the visible span bracketed in it. Drag that bracket to scrub the sheet.
 *
 * The regions therefore mean different things and never both apply:
 *   - UNLINKED: no ribbon. The body IS the whole take, and the bracket is drawn on the body as
 *     dimming plus two full-height edge lines. Clicking outside it brings the sheet there.
 *   - LINKED: a ribbon on top holds the whole take and the bracket; the body holds the slice
 *     you are reading, engraved. No bracket on the body — the body IS the bracket, and a
 *     rectangle drawn around everything is noise, not information.
 *
 * WHAT EACH GESTURE MEANS IS STILL A MATTER OF WHERE YOU STARTED:
 *   body   -> the music: seek here, probe here, or take hold of bar 1.
 *   ribbon -> where you are in the take: bring the sheet here, or slide it.
 *   gutter -> nothing. It is the roll's label column (see 6).
 *
 * ===========================================================================================
 * 6. A PRESS SEEKS IMMEDIATELY. NOT ON RELEASE.
 * ===========================================================================================
 * The harness drives a BARE `pointerdown` at `.waveform` — no pointerup at all — and asserts
 * the playhead moved, because "the same x on the waveform means the same second" is the check
 * that catches the two strips drifting apart. More importantly, a navigator that waits for
 * your finger to come up before it moves feels broken.
 *
 * So a body press seeks and paints its probe window at once, reporting it UNCOMMITTED, and
 * commits the same window on release. That is the same `commit` protocol the drag used, so
 * `app.ts` needs no change: it already ignores uncommitted frames and only opens the tuner on
 * the committed one. It also means the tuner — which re-renders the whole main screen and
 * therefore destroys and rebuilds this strip — is never opened with a pointer still down.
 *
 * ===========================================================================================
 * 7. THE LEFT GUTTER IS STILL NOT THIS STRIP'S IDEA
 * ===========================================================================================
 * The piano roll under it needs a column for its pitch labels, and the two panes are stacked
 * edge to edge, so a label column that only one of them reserves makes the two pictures start
 * at different x and read as misaligned. This file imports `TIMELINE_GUTTER_PX` from the roll
 * and reserves the identical column — empty here, but reserved. Change it in one place.
 */

import type { TrimResult } from '../audio/trim';
import type { OnsetResult } from '../audio/onsets';
import { TIMELINE_GUTTER_PX, type SheetMap, type TimeAnchor } from '../view/pianoroll';

/** A stretch of the RECORDING, in recording seconds. `fromSec` is always the earlier one. */
export interface WaveformSelection {
  fromSec: number;
  toSec: number;
}

export interface WaveformOptions {
  canvas: HTMLCanvasElement;
  onSeek: (sec: number) => void;
  /** Fired while dragging and once on release; `commit` is true on release. */
  onBarOneChange: (sec: number, commit: boolean) => void;
  /**
   * The player asked to look at a different part of the take: by sliding the overview
   * bracket, or by clicking a part of the recording the sheet is not currently on.
   * `centreSec` is where the middle of the visible span wants to be, on the RECORDING's
   * clock. `commit` is true on release (and on a click), false for the live frames of a drag.
   *
   * The strip does not move the sheet itself — it cannot; it does not know how the sheet is
   * engraved. It reports, the integrator scrolls, and the answer comes back through
   * `setViewportRange`. Leave this out and the bracket is a read-only indicator, which is a
   * perfectly good thing for it to be.
   */
  onViewportScrub?: (centreSec: number, commit: boolean) => void;
  /**
   * The player pointed at a moment of the recording, or cleared the last one.
   *
   * Always a window of exactly `PROBE_WINDOW_SEC` (slid, never shortened, at the two ends of
   * the take), because the question is "what is at this moment". `null` means there is no
   * selection any more — Escape, or a new take. `commit` is false for the press and true on
   * release, unchanged from when this was a drag, so a listener can highlight immediately and
   * only do the expensive listening once.
   *
   * This is the gesture the tuner is built on, and it exists precisely because a stretch of
   * audio the transcriber heard NOTHING in has no note to click on. Pointing at the recording
   * is the only way to ask about silence.
   */
  onSelectionChange?: (sel: WaveformSelection | null, commit: boolean) => void;
  /**
   * The sheet's engraving, asked for fresh on every frame — the SAME accessor and the same
   * `SheetMap` interface `view/pianoroll.ts` takes, deliberately not a second copy of it.
   *
   * Return null when the roll is unlinked. See section 2 of the header: this strip has no
   * link switch of its own, so the accessor is the only thing keeping the two strips on one
   * ruler. Called once per frame (not once per column), so it may measure the DOM, but it
   * must never throw — a throw is caught and treated as "no map" for that frame.
   */
}

/**
 * Which gesture has the pointer. Null means none is in flight.
 *
 * Two, where there were five. `select`, `select-from` and `select-to` went with the drag —
 * a click needs no gesture state, only `pressing` below.
 */
type DragKind = 'marker' | 'viewport';

export class WaveformStrip {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private opts: WaveformOptions;

  private peaksMin: Float32Array | null = null;
  private peaksMax: Float32Array | null = null;
  private durationSec = 0;
  private trim: TrimResult | null = null;
  private barOneSec = 0;
  private positionSec = 0;
  /** Independent evidence from the recording: where something was struck. */
  private onsetResult: OnsetResult | null = null;
  /**
   * Written second 0 on the RECORDING's clock. Handed in, never derived here — §4.13, and
   * section 3 of the header. Zero is only right for a take with no count-in.
   */
  private scoreOriginSec = 0;
  /** The slice the sheet and the roll are showing, or null for "no bracket". */
  private viewportFromSec: number | null = null;
  private viewportToSec: number | null = null;
  /** ALIGN: the sheet's own ruler, in time. Null = the whole take, evenly. */
  private anchors: TimeAnchor[] | null = null;
  /** The moment the player has picked out to ask about, as a window, or null for none. */
  private selectionFromSec: number | null = null;
  private selectionToSec: number | null = null;
  private dragging: DragKind | null = null;
  /** A body press waiting for its release, which is what commits the probe window. */
  private pressing = false;
  /** Where the pointer went down, so a press that never moved can still be a plain click. */
  private pressX = 0;
  /** The second under `pressX`, resolved once on press so the release cannot re-resolve it
   *  against an axis the sheet has scrolled underneath us in the meantime. */
  private pressSec = 0;
  /** True once a press has moved far enough to be a drag rather than a click. */
  private pressMoved = false;
  /**
   * Grabbing the bracket 20px right of its middle must keep the pointer 20px right of its
   * middle for the whole drag — otherwise the bracket jumps under your finger on the first
   * pixel of movement. Captured on press, in seconds so a resize mid-drag cannot break it.
   */
  private grabOffsetSec = 0;
  /** The bracket's width at the moment of the grab. Sliding must not resize it. */
  private grabSpanSec = 0;
  private colors = {
    bg: '#1e2128',
    gutter: '#16181d',
    line: '#2e3340',
    wave: '#3a4150',
    waveDim: '#282d38',
    played: '#e8734a',
    playhead: '#ffffff',
    marker: '#e8b34a',
    viewport: '#9aa0ab',
    select: '#5aa9e8',
    onset: '#62d6b5',
    /** Same token the roll haloes an auto-edited note with — one claim, one colour. */
    autoEdit: '#62d6b5'
    // `autoAttention` (yellow) is deleted, not unused. See `setAttentionRegions`.
  };

  /** See `setAttentionRegions`. Empty until the auto-edit pass has run. */
  private attention: Array<{ fromSec: number; toSec: number }> = [];

  private static MARKER_HIT_PX = 7;
  /**
   * How far outside a bracket edge still counts as grabbing the bracket. A long take read at
   * a big zoom can put the whole visible slice inside three pixels, and a three-pixel target
   * is not a target. The grab band is also floored at `VIEWPORT_MIN_GRAB_PX` overall.
   */
  private static VIEWPORT_EDGE_HIT_PX = 5;
  /** The smallest the grab band may be, however narrow the bracket itself is drawn. */
  private static VIEWPORT_MIN_GRAB_PX = 13;
  /** Both edges have to be visible as edges, so the bracket is never drawn thinner than this. */
  private static VIEWPORT_MIN_DRAW_PX = 3;
  /**
   * A press is a click until it has travelled this far. That is what lets "click seeks" and
   * "drag does something else" live on the same pixels without either one surprising the
   * player.
   */
  private static DRAG_SLOP_PX = 3;
  /** How much of the take that is NOT on screen below is knocked back. */
  private static OUTSIDE_DIM = 0.52;
  /**
   * HOW MUCH OF THE RECORDING A CLICK ASKS ABOUT, in seconds. The one number that tunes this
   * feature — see section 1 of the header for the arithmetic behind 0.2 (three analysis
   * frames, one more than `ui/tuner.ts` needs to call something a note, and still shorter
   * than an eighth note at 120 BPM so it cannot straddle two).
   */
  // Keep the visible question narrow enough to point at one moment. Pitch analysis
  // may still inspect a wider hidden window in the tuner; the highlight itself
  // should not imply that a fifth of a second was selected when the user clicked
  // a precise transient.
  private static PROBE_WINDOW_SEC = 0.1;
  /**
   * The whole-take overview ribbon along the top, present ONLY while the body is engraved.
   *
   * Thirteen pixels out of seventy-two: enough for an envelope with a recognisable shape and
   * a bracket with two visible edges, small enough that the body is still the picture.
   */
  private static OVERVIEW_PX = 13;
  /** Never let the ribbon eat more than this share of a strip somebody has made short. */
  private static OVERVIEW_MAX_FRACTION = 1 / 3;
  /** Below this the ribbon stops being either legible or a target, so it never shrinks past it. */
  private static OVERVIEW_MIN_PX = 7;
  /** So a probe window on a zoomed-out take still shows as a band rather than vanishing. */
  private static SELECTION_MIN_DRAW_PX = 2;

  constructor(opts: WaveformOptions) {
    this.opts = opts;
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext('2d')!;
    this.readColors();

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('resize', this.draw);
    window.addEventListener('keydown', this.onKeyDown);
  }

  /** Resolve CSS custom properties once, so the canvas is themeable rather than hardcoded. */
  private readColors(): void {
    const s = getComputedStyle(document.documentElement);
    const pick = (name: string, fallback: string) =>
      s.getPropertyValue(name).trim() || fallback;
    this.colors = {
      bg: pick('--bg-raised', this.colors.bg),
      gutter: pick('--bg', this.colors.gutter),
      line: pick('--border', this.colors.line),
      wave: pick('--wave', this.colors.wave),
      waveDim: '#282d38',
      played: pick('--wave-played', this.colors.played),
      playhead: pick('--playhead', this.colors.playhead),
      marker: pick('--warn', this.colors.marker),
      // Deliberately a neutral grey rather than the accent or the warn colour: the bracket is
      // chrome, and it has to be told apart at a glance from the bar-1 flag (warm) and the
      // playhead (white). Those two mean something about the music; this one does not.
      viewport: pick('--text-dim', this.colors.viewport),
      // The fifth meaning on a strip that already has four, so it has to be a colour none of
      // the others is: not orange (played), not amber (bar 1), not white (playhead), not grey
      // (viewport). Blue is what every DAW uses for a time selection. `--select` is a token
      // this file would like to exist; the fallback is a working colour, not a placeholder,
      // so the strip is correct whether or not the stylesheet ever gains it.
      select: pick('--select', this.colors.select),
      onset: pick('--success', this.colors.onset),
      autoEdit: pick('--success', this.colors.autoEdit)
    };
  }

  setAudio(
    peaks: { min: Float32Array; max: Float32Array } | null,
    durationSec: number,
    trim: TrimResult | null
  ): void {
    this.peaksMin = peaks?.min ?? null;
    this.peaksMax = peaks?.max ?? null;
    this.durationSec = durationSec;
    this.trim = trim;
    this.barOneSec = trim?.startOffsetSec ?? 0;
    // A new recording has a new clock; the old bracket and the old selection were both
    // measured against the old one. Cleared silently — the integrator is rebuilding the
    // screen around this call and does not need to be told about a range it just replaced.
    this.viewportFromSec = null;
    this.viewportToSec = null;
    this.selectionFromSec = null;
    this.selectionToSec = null;
    this.draw();
  }

  /** Paint onset evidence computed once for this recording. */
  setOnsets(result: OnsetResult | null): void {
    this.onsetResult = result;
    this.draw();
  }

  /**
   * Stretches of the recording where the auto-edit pass CHANGED a note.
   *
   * ONE claim, not two. There used to be a second, yellow kind — `applied: false`, "I heard
   * something here and did NOT touch it" — drawn whenever a guardrail refused or the setting
   * was off. It is gone, and the flag that selected it is gone with it, so it cannot come
   * back by accident. A mark the player cannot act on teaches them to ignore marks, and the
   * ones they must not ignore are these.
   *
   * On the STRIP and on the roll, never on the sheet or the tab. Those two are the result — a
   * player reads them to find out what the music is, and marking them up with what the app
   * thinks of itself would make that harder in exchange for nothing about the music.
   */
  setAttentionRegions(regions: ReadonlyArray<{ fromSec: number; toSec: number }>): void {
    this.attention = regions.map((r) => ({
      fromSec: Math.min(r.fromSec, r.toSec),
      toSec: Math.max(r.fromSec, r.toSec)
    }));
    this.draw();
  }

  setBarOne(sec: number): void {
    this.barOneSec = sec;
    this.draw();
  }

  get barOne(): number {
    return this.barOneSec;
  }

  setPosition(sec: number): void {
    if (Math.abs(sec - this.positionSec) < 0.005) return;
    this.positionSec = sec;
    this.draw();
  }

  /**
   * Written second 0, expressed on the RECORDING's clock — `scoreOriginSec(score, barOneSec)`
   * and nothing else. §4.13 and section 3 of the header.
   *
   * Only matters while `sheetMap()` is returning a map; on the even ruler the strip is already
   * on the recording's clock and this is not consulted. Which is exactly why forgetting it is
   * an easy bug to ship: everything looks right until the player turns Linked on, and then the
   * envelope is a count-in adrift of the notes above it.
   */
  setScoreOrigin(sec: number): void {
    const v = Number.isFinite(sec) ? sec : 0;
    if (v === this.scoreOriginSec) return;
    this.scoreOriginSec = v;
    this.draw();
  }

  /**
   * Say which slice of the recording the sheet and the roll are showing.
   *
   * `null, null` means "do not draw a bracket" — nothing has been engraved yet, or the whole
   * take fits on screen, and in both of those cases a bracket would be noise. The strip then
   * draws exactly what it has always drawn.
   *
   * Rubbish in (NaN, infinities, a backwards range) is survived rather than thrown at: the
   * numbers come from a scroll position and a layout that can both be measured mid-render.
   */
  setViewportRange(fromSec: number | null, toSec: number | null): void {
    const r = this.cleanRange(fromSec, toSec);
    if (r.from === this.viewportFromSec && r.to === this.viewportToSec) return;
    this.viewportFromSec = r.from;
    this.viewportToSec = r.to;
    this.draw();
  }

  /**
   * Set the selection from outside — a restored session, a "select this bar" button, or the
   * tuner clearing up after itself.
   *
   * Silent: it does not call `onSelectionChange`, because the caller is the one who already
   * knows. Only a gesture on this strip reports. The width is NOT forced to
   * `PROBE_WINDOW_SEC`: a session saved before this change, or a caller with a real reason to
   * highlight a longer stretch, gets drawn what it asked for. Only clicks are fixed-width.
   */
  setSelection(fromSec: number | null, toSec: number | null): void {
    const r = this.cleanRange(fromSec, toSec);
    if (r.from === this.selectionFromSec && r.to === this.selectionToSec) return;
    this.selectionFromSec = r.from;
    this.selectionToSec = r.to;
    this.draw();
  }

  get selection(): WaveformSelection | null {
    const from = this.selectionFromSec;
    const to = this.selectionToSec;
    if (from === null || to === null) return null;
    return { fromSec: from, toSec: to };
  }

  /** One pair in, a sane ordered pair or a pair of nulls out. Never half a range. */
  private cleanRange(
    fromSec: number | null,
    toSec: number | null
  ): { from: number | null; to: number | null } {
    const clean = (v: number | null): number | null =>
      v === null || v === undefined || !Number.isFinite(v) ? null : v;
    const a = clean(fromSec);
    const b = clean(toSec);
    // One end without the other is not a range. Refuse it rather than guess the other end.
    if (a === null || b === null) return { from: null, to: null };
    return { from: Math.min(a, b), to: Math.max(a, b) };
  }

  // =========================================================================
  // Geometry
  // =========================================================================

  /** The reserved label column, or 0 when the strip is too narrow to spare it. */
  private get gutterPx(): number {
    return (this.canvas.clientWidth || 1) >= TIMELINE_GUTTER_PX * 4 ? TIMELINE_GUTTER_PX : 0;
  }

  private get plotWidth(): number {
    return Math.max(1, (this.canvas.clientWidth || 1) - this.gutterPx);
  }

  /**
   * The sheet's geometry for this frame, or null when the strip is on its own ruler.
   *
   * Null is a complete, supported mode and not a degraded one: it is the whole-take overview.
   * A `sheetMap` that throws is treated as null for that frame and never specially again —
   * the tri-view is another agent's file and this one must not be able to take the strip down
   * with it.
   *
   * Resolve it ONCE per frame and pass it down. `app.ts`'s accessor measures the DOM, and
   * asking it per column would be a thousand forced layouts a paint.
   */
  private map(): SheetMap | null {
    // DELETED WITH THE ROLL'S COPY OF IT — see `view/pianoroll.ts` §map(). The strip drew on
    // the sheet's x-axis when the chip was on, and the sheet's x-axis re-spaces itself
    // whenever the engraving changes, so a note added anywhere moved the picture of the
    // recording everywhere. A waveform that moves when you edit a note is a waveform that
    // cannot be trusted as evidence, which is the strip's whole job.
    //
    // The chip survives as `alignViews` and moves the SHEET's scroll instead: nothing here has
    // any geometry to change. The `m` parameters threaded through the drawing code below are
    // kept — they are always null now, and they are the shape a future engraved-axis design
    // would need if one is ever built that does not reflow.
    return null;
  }

  /**
   * How tall the overview ribbon is right now — 0 whenever the body is already the whole take.
   *
   * A fraction rather than a flat constant so that a strip somebody has made short still has a
   * body to read; the ribbon is a means to an end and the body is the end.
   */
  private overviewHeight(linked: boolean): number {
    if (!linked) return 0;
    const h = this.canvas.clientHeight || 0;
    if (h <= 0) return 0;
    const cap = Math.floor(h * WaveformStrip.OVERVIEW_MAX_FRACTION);
    return Math.max(
      Math.min(WaveformStrip.OVERVIEW_MIN_PX, h),
      Math.min(WaveformStrip.OVERVIEW_PX, cap)
    );
  }

  /**
   * ALIGN: show exactly this stretch of the recording in the BODY. Null = the whole take.
   *
   * The strip's half of the same bargain the roll takes (`view/pianoroll.ts §setTimeWindow`):
   * the sheet's visible span, so a peak in the envelope is directly under the notehead written
   * from it. The ruler stays linear in time inside the window — the envelope is evidence about
   * a recording, and a waveform that re-spaces itself when a note is edited is not evidence.
   *
   * The OVERVIEW ribbon is unaffected and stays whole-take: it is the map, and a map that
   * zoomed with the thing it is a map of would be no use.
   */
  setTimeAnchors(anchors: ReadonlyArray<TimeAnchor> | null): void {
    const clean =
      anchors && anchors.length >= 2
        ? anchors
            .filter((a) => Number.isFinite(a.sec) && Number.isFinite(a.frac))
            .slice()
            .sort((a, b) => a.sec - b.sec)
            .filter((a, i, all) => i === 0 || a.sec - all[i - 1].sec > 1e-6)
        : null;
    const next = clean && clean.length >= 2 ? clean : null;
    const a = this.anchors;
    const same =
      (next === null && a === null) ||
      (next !== null &&
        a !== null &&
        next.length === a.length &&
        next.every((n, i) => Math.abs(n.sec - a[i].sec) < 1e-4 && Math.abs(n.frac - a[i].frac) < 1e-4));
    if (same) return;
    this.anchors = next;
    this.draw();
  }

  /** See view/pianoroll.ts §anchorFrac — the same ruler, so the two strips cannot drift. */
  private anchorFrac(sec: number): number | null {
    const a = this.anchors;
    if (!a) return null;
    if (sec <= a[0].sec) {
      const span = a[1].sec - a[0].sec;
      return a[0].frac + (span > 0 ? ((sec - a[0].sec) / span) * (a[1].frac - a[0].frac) : 0);
    }
    const last = a.length - 1;
    if (sec >= a[last].sec) {
      const span = a[last].sec - a[last - 1].sec;
      return a[last].frac + (span > 0 ? ((sec - a[last].sec) / span) * (a[last].frac - a[last - 1].frac) : 0);
    }
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid].sec <= sec) lo = mid;
      else hi = mid;
    }
    const span = a[hi].sec - a[lo].sec;
    return span > 0 ? a[lo].frac + ((sec - a[lo].sec) / span) * (a[hi].frac - a[lo].frac) : a[lo].frac;
  }

  private anchorSec(frac: number): number | null {
    const a = this.anchors;
    if (!a) return null;
    if (frac <= a[0].frac) {
      const span = a[1].frac - a[0].frac;
      return a[0].sec + (span > 0 ? ((frac - a[0].frac) / span) * (a[1].sec - a[0].sec) : 0);
    }
    const last = a.length - 1;
    if (frac >= a[last].frac) {
      const span = a[last].frac - a[last - 1].frac;
      return a[last].sec + (span > 0 ? ((frac - a[last].frac) / span) * (a[last].sec - a[last - 1].sec) : 0);
    }
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid].frac <= frac) lo = mid;
      else hi = mid;
    }
    const span = a[hi].frac - a[lo].frac;
    return span > 0 ? a[lo].sec + ((frac - a[lo].frac) / span) * (a[hi].sec - a[lo].sec) : a[lo].sec;
  }

  /** RECORDING seconds -> x on the plain even ruler. The overview's axis, and the fallback. */
  private secToEvenX(sec: number): number {
    const frac = this.anchorFrac(sec);
    if (frac !== null) return this.gutterPx + frac * this.plotWidth;
    return this.durationSec > 0
      ? this.gutterPx + (sec / this.durationSec) * this.plotWidth
      : this.gutterPx;
  }

  /** The exact inverse of `secToEvenX`, unclamped. */
  private evenXToSec(x: number): number {
    const sec = this.anchorSec((x - this.gutterPx) / this.plotWidth);
    if (sec !== null) return sec;
    return ((x - this.gutterPx) / this.plotWidth) * this.durationSec;
  }

  /**
   * RECORDING seconds -> x on whichever axis the BODY is using. THE mapping.
   *
   * NaN when the engraved axis cannot place the second (nothing engraved yet). Callers skip a
   * NaN rather than drawing at 0 — an envelope column parked on the left edge looks like real
   * audio at second zero, which is a lie. Same rule as the roll's `writtenToX`.
   */
  private secToX(sec: number, m: SheetMap | null = this.map()): number {
    if (m) {
      // RECORDING -> WRITTEN before the sheet is asked anything. §4.13.
      const cx = m.writtenSecToContentX(sec - this.scoreOriginSec);
      return cx === null || !Number.isFinite(cx) ? Number.NaN : cx - m.scrollLeft;
    }
    return this.secToEvenX(sec);
  }

  /** The exact inverse, in both modes. NaN when the engraved axis cannot answer. */
  private xToSec(x: number, m: SheetMap | null = this.map()): number {
    if (m) {
      const written = m.contentXToWrittenSec(x + m.scrollLeft);
      return written === null || !Number.isFinite(written)
        ? Number.NaN
        : written + this.scoreOriginSec;
    }
    return this.evenXToSec(x);
  }

  /** A pointer x turned into a second inside the recording. NaN when the axis cannot say. */
  private secAt(x: number, m: SheetMap | null = this.map()): number {
    const sec = this.xToSec(x, m);
    return Number.isFinite(sec) ? Math.max(0, Math.min(this.durationSec, sec)) : Number.NaN;
  }

  /** The same, for the overview ribbon, which is always the WHOLE TAKE. */
  private evenSecAt(x: number): number {
    return Math.max(0, Math.min(this.durationSec, this.wholeTakeXToSec(x)));
  }

  /** The ribbon's own axis: the whole recording, always, whatever the body is showing. */
  private wholeTakeSecToX(sec: number): number {
    return this.durationSec > 0
      ? this.gutterPx + (sec / this.durationSec) * this.plotWidth
      : this.gutterPx;
  }

  private wholeTakeXToSec(x: number): number {
    return ((x - this.gutterPx) / this.plotWidth) * this.durationSec;
  }

  /**
   * Where the viewport bracket is, ON THE EVEN RULER, or null when there is nothing worth
   * bracketing.
   *
   * ALWAYS the even ruler, because the bracket only ever appears somewhere that is showing the
   * whole take: on the body when unlinked, in the ribbon when linked. One geometry, painted in
   * two places, so the two can never drift.
   *
   * Null covers all of: no range set, no audio, and a range that already spans the whole take
   * — that last one because dimming nothing while drawing two edges hard against the left and
   * right walls looks like a bug, not like information.
   *
   * One function so `draw()`, the hit test and `probe()` cannot drift apart.
   */
  private bracket(): { fromX: number; toX: number; fromSec: number; toSec: number } | null {
    const from = this.viewportFromSec;
    const to = this.viewportToSec;
    if (from === null || to === null || !(this.durationSec > 0)) return null;
    const w = this.canvas.clientWidth || 0;
    const g = this.gutterPx;
    if (w <= g + 1) return null;

    const lo = Math.max(0, Math.min(from, this.durationSec));
    const hi = Math.max(lo, Math.min(to, this.durationSec));
    if (!(hi > lo)) return null;
    // The whole take is on screen below: nothing to point at.
    if (lo <= 0.0005 && hi >= this.durationSec - 0.0005) return null;

    let fromX = this.wholeTakeSecToX(lo);
    let toX = this.wholeTakeSecToX(hi);
    // Widen a hairline bracket around its own middle so both edges survive as edges. It lies
    // by a pixel or two about the range; a bracket you cannot see lies about all of it.
    const min = WaveformStrip.VIEWPORT_MIN_DRAW_PX;
    if (toX - fromX < min) {
      const mid = (fromX + toX) / 2;
      fromX = mid - min / 2;
      toX = mid + min / 2;
    }
    // Never let it wander into the roll's label column or off the right edge.
    if (fromX < g) {
      toX += g - fromX;
      fromX = g;
    }
    if (toX > w) {
      fromX -= toX - w;
      toX = w;
    }
    return { fromX: Math.max(g, fromX), toX: Math.min(w, toX), fromSec: lo, toSec: hi };
  }

  /**
   * Where the probe window is on screen, or null when there is not one — or when it is off the
   * side of an engraved axis, which is a normal thing for a moment the sheet has scrolled past.
   */
  private selectionBox(
    m: SheetMap | null = this.map()
  ): { fromX: number; toX: number; fromSec: number; toSec: number } | null {
    const from = this.selectionFromSec;
    const to = this.selectionToSec;
    if (from === null || to === null || !(this.durationSec > 0)) return null;
    const w = this.canvas.clientWidth || 0;
    const g = this.gutterPx;
    if (w <= g + 1) return null;

    const lo = Math.max(0, Math.min(from, this.durationSec));
    const hi = Math.max(lo, Math.min(to, this.durationSec));
    let fromX = this.secToX(lo, m);
    let toX = this.secToX(hi, m);
    if (!Number.isFinite(fromX) || !Number.isFinite(toX)) return null;
    if (toX - fromX < WaveformStrip.SELECTION_MIN_DRAW_PX) {
      toX = fromX + WaveformStrip.SELECTION_MIN_DRAW_PX;
    }
    // Entirely outside the plot. Clamping it would draw a zero- or negative-width band pinned
    // to whichever wall it fell off, which reads as a selection at the wrong moment.
    if (toX <= g || fromX >= w) return null;
    return { fromX: Math.max(g, fromX), toX: Math.min(w, toX), fromSec: lo, toSec: hi };
  }

  /**
   * True when x is close enough to the bar-1 line to count as taking hold of it.
   *
   * Refuses when the line is not on screen — off an engraved axis, or behind the roll's label
   * column — so the hit test and what is actually drawn can never disagree. A handle you
   * cannot see but can still grab is worse than no handle.
   */
  private overMarker(x: number, m: SheetMap | null): boolean {
    const mx = this.secToX(this.barOneSec, m);
    if (!Number.isFinite(mx) || mx < this.gutterPx || mx > (this.canvas.clientWidth || 0)) {
      return false;
    }
    return Math.abs(x - mx) <= WaveformStrip.MARKER_HIT_PX;
  }

  /** True when x is close enough to the bracket to count as grabbing it. */
  private overBracket(x: number): boolean {
    const b = this.bracket();
    if (!b) return false;
    const slop = WaveformStrip.VIEWPORT_EDGE_HIT_PX;
    let left = b.fromX - slop;
    let right = b.toX + slop;
    const short = WaveformStrip.VIEWPORT_MIN_GRAB_PX - (right - left);
    if (short > 0) {
      left -= short / 2;
      right += short / 2;
    }
    return x >= left && x <= right;
  }

  // =========================================================================
  // Gestures
  // =========================================================================

  /**
   * Take the pointer, or carry on without it.
   *
   * A synthetic pointer — the headless harness, and some assistive tooling — has no active
   * pointer id, and `setPointerCapture` throws rather than declining. It must not become an
   * uncaught exception on a mouse press.
   *
   * What capture buys is a drag that keeps working once the pointer leaves the strip. Where it
   * fails, the moves simply stop arriving — which for a synthetic pointer is moot, because the
   * harness dispatches every event straight at the canvas anyway.
   */
  private capture(pointerId: number): void {
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {
      /* no active pointer — synthetic events are dispatched at the canvas regardless */
    }
  }

  /**
   * WHO WINS A PRESS. Where it lands decides — see section 5 of the header.
   *
   *   THE GUTTER wins nothing. It is the roll's label column: seeking from it would always
   *   mean second 0, and grabbing from it would be grabbing a label.
   *
   *   THE RIBBON (only exists while the body is engraved) is navigation and nothing else:
   *   bring the sheet here, and keep bringing it while you drag. It does not seek and it does
   *   not probe, because it is not showing you the music, it is showing you where you are.
   *
   *   THE BODY, in order:
   *     1. THE BAR-1 MARKER, along its whole line. It is the one gesture on this strip that
   *        changes the sheet's MEANING rather than the view of it, and it has been draggable
   *        since before any of the others existed. A press on it that never moves falls back
   *        to a plain click on release, so aiming at it by accident costs nothing — in
   *        particular it does NOT commit a bar-1 change nobody made, which would re-engrave
   *        the whole score for nothing.
   *     2. Otherwise: seek at once and paint the probe window. A body click never scrolls
   *        the written page; navigation belongs to the overview ribbon above it.
   */
  private onPointerDown = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.pressX = x;
    this.pressMoved = false;
    this.pressing = false;

    if (x < this.gutterPx) return;

    const m = this.map();
    if (y < this.overviewHeight(!!m)) {
      this.onRibbonPress(x, e.pointerId);
      return;
    }

    const sec = this.secAt(x, m);
    if (!Number.isFinite(sec)) return;
    this.pressSec = sec;

    if (this.overMarker(x, m)) {
      this.dragging = 'marker';
      this.capture(e.pointerId);
      return;
    }

    // See section 6: this does not wait for release.
    this.pressing = true;
    this.opts.onSeek(sec);
    this.setProbeWindow(sec, false);
    this.capture(e.pointerId);
  };

  /**
   * A press in the whole-take ribbon. Standard scrollbar behaviour, which is the one thing
   * everybody already knows: land on the bracket and it slides from where you took hold; land
   * anywhere else and it jumps to you first, then slides.
   */
  private onRibbonPress(x: number, pointerId: number): void {
    if (!this.opts.onViewportScrub || !(this.durationSec > 0)) return;
    const b = this.bracket();
    const sec = this.evenSecAt(x);
    this.grabSpanSec = b ? b.toSec - b.fromSec : 0;
    this.dragging = 'viewport';
    this.capture(pointerId);
    this.canvas.style.cursor = 'grabbing';

    if (b && this.overBracket(x)) {
      this.grabOffsetSec = sec - (b.fromSec + this.grabSpanSec / 2);
      return;
    }
    this.grabOffsetSec = 0;
    this.moveBracketTo(this.centreFor(sec, this.grabSpanSec), true);
  }

  /**
   * Where the middle of the visible span should sit if the player asked to look at `sec`, kept
   * inside the recording so the last bar can still be reached but the bracket never hangs off
   * either end. The span is passed in rather than read from state so that a drag keeps the
   * width it was grabbed at.
   */
  private centreFor(sec: number, spanSec: number): number {
    const half = Math.min(Math.max(0, spanSec), this.durationSec) / 2;
    return Math.max(half, Math.min(this.durationSec - half, sec));
  }

  /**
   * Report a new centre, and move the bracket locally on the way.
   *
   * The local move is not redundant: a navigator that lags its own drag by a frame feels
   * broken. The integrator's reply through `setViewportRange` is still authoritative and
   * overwrites this a moment later.
   */
  private moveBracketTo(centreSec: number, commit: boolean): void {
    const span = Math.min(this.grabSpanSec, this.durationSec);
    if (span > 0) {
      this.viewportFromSec = Math.max(0, centreSec - span / 2);
      this.viewportToSec = Math.min(this.durationSec, this.viewportFromSec + span);
    }
    this.opts.onViewportScrub?.(centreSec, commit);
    this.draw();
  }

  /**
   * Point at a moment: a window of exactly `PROBE_WINDOW_SEC` centred on it.
   *
   * Centred rather than starting there because the question is "what is at this moment", and
   * because a window that starts at the click swallows the pluck's attack transient, which is
   * the least pitched part of any note. At the two ends of the take the window SLIDES to stay
   * inside the recording rather than being shortened — a shorter window is a worse answer, and
   * silently changing the width the whole feature is calibrated on is how a constant stops
   * meaning anything.
   */
  private setProbeWindow(sec: number, commit: boolean): void {
    // No recording, no question to ask. Emitting a zero-width window here would open the tuner
    // on nothing and have it report "too short", which is a worse answer than silence.
    if (!(this.durationSec > 0)) return;
    const width = Math.min(WaveformStrip.PROBE_WINDOW_SEC, this.durationSec);
    let from = sec - width / 2;
    let to = from + width;
    if (from < 0) {
      from = 0;
      to = width;
    }
    if (to > this.durationSec) {
      to = this.durationSec;
      from = Math.max(0, to - width);
    }
    this.selectionFromSec = from;
    this.selectionToSec = to;
    this.opts.onSelectionChange?.({ fromSec: from, toSec: to }, commit);
    this.draw();
  }

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (this.dragging === 'marker') {
      if (!this.pressMoved && Math.abs(x - this.pressX) < WaveformStrip.DRAG_SLOP_PX) return;
      const sec = this.secAt(x);
      if (!Number.isFinite(sec)) return;
      this.pressMoved = true;
      this.barOneSec = sec;
      this.opts.onBarOneChange(this.barOneSec, false);
      this.draw();
      return;
    }

    if (this.dragging === 'viewport') {
      if (!this.pressMoved && Math.abs(x - this.pressX) < WaveformStrip.DRAG_SLOP_PX) return;
      this.pressMoved = true;
      this.moveBracketTo(
        this.centreFor(this.wholeTakeXToSec(x) - this.grabOffsetSec, this.grabSpanSec),
        false
      );
      return;
    }

    // A body press has nothing to track: the window was decided on press and a click does not
    // grow. All that is left is the cursor.
    if (!this.pressing) this.canvas.style.cursor = this.cursorFor(x, y);
  };

  /** What the pointer should look like here. One place, so the hit tests cannot lie. */
  private cursorFor(x: number, y: number): string {
    if (x < this.gutterPx) return 'default';
    const m = this.map();
    if (y < this.overviewHeight(!!m)) {
      return this.opts.onViewportScrub ? 'grab' : 'default';
    }
    if (this.overMarker(x, m)) return 'ew-resize';
    // Crosshair rather than pointer, because the body's gesture is "aim at a moment and ask
    // what is in it", and the answer is only as precise as the aim.
    return this.opts.onSelectionChange ? 'crosshair' : 'pointer';
  }

  private onPointerUp = (e: PointerEvent): void => {
    const was = this.dragging;
    const pressing = this.pressing;
    if (was === null && !pressing) return;
    this.dragging = null;
    this.pressing = false;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }

    if (was === 'marker') {
      if (!this.pressMoved) {
        // Aimed at the flag and let go without moving it. That is a click, not an edit: seek
        // and probe, and above all do NOT commit a bar-1 change, which would re-run the
        // notation build for a marker that is exactly where it was.
        this.opts.onSeek(this.pressSec);
        this.setProbeWindow(this.pressSec, true);
        return;
      }
      // Commit: this is what re-runs the notation build (never the transcription).
      this.opts.onBarOneChange(this.barOneSec, true);
      return;
    }

    if (was === 'viewport') {
      this.canvas.style.cursor = 'grab';
      if (!this.pressMoved) return; // the press already committed where it landed
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      this.moveBracketTo(
        this.centreFor(this.wholeTakeXToSec(x) - this.grabOffsetSec, this.grabSpanSec),
        true
      );
      return;
    }

    // A body click. The seek and the highlight happened on press; this is the commit that
    // actually asks the question, and it is deliberately the second the press landed on and
    // not wherever the finger drifted to before it came up.
    this.setProbeWindow(this.pressSec, true);
  };

  /**
   * Escape clears the selection.
   *
   * Not `preventDefault`ed and not stopped: Escape closes panels elsewhere in the app, and a
   * player pressing it while a tuner is open over a selection means both. Silent when there
   * is nothing selected, so this listener never swallows anybody else's Escape.
   */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    if (this.selectionFromSec === null && this.selectionToSec === null) return;
    this.selectionFromSec = null;
    this.selectionToSec = null;
    this.opts.onSelectionChange?.(null, true);
    this.draw();
  };

  // =========================================================================
  // Painting
  // =========================================================================

  draw = (): void => {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, w, h);

    // ONE map for the whole frame. See `map()` on why this is not asked for per column.
    const m = this.map();
    const g = this.gutterPx;
    const top = this.overviewHeight(!!m);

    // The roll's label column, reserved and left empty, with the same edge the roll draws.
    if (g > 0) {
      ctx.fillStyle = this.colors.gutter;
      ctx.fillRect(0, 0, g, h);
      ctx.fillStyle = this.colors.line;
      ctx.fillRect(g - 1, 0, 1, h);
    }

    const hasAudio = !!this.peaksMin && !!this.peaksMax && this.durationSec > 0;

    if (top > 0) this.drawOverview(ctx, w, g, top, hasAudio);
    // UNDER the envelope, so the audio stays the picture and the tint reads as something the
    // app has written on the background rather than as a change to the recording.
    this.drawAttention(ctx, w, h, g, top, m);
    if (hasAudio) this.drawWave(ctx, w, h, g, top, m);
    this.drawOnsets(ctx, w, h, g, top, m);

    // The bracket goes on the BODY only when the body is the whole take. When it is engraved,
    // the body IS the bracket and the ribbon above carries the real one.
    if (!m) this.drawBodyBracket(ctx, w, h, g, top);
    this.drawSelection(ctx, h, top, m);

    // Bar-1 marker: a line the whole height of the body so you can see what it lands on, with
    // its flag at the top of the body. NaN means the sheet has scrolled past it — draw nothing
    // rather than pinning it to the left wall, where it would claim bar 1 is at the edge of
    // the screen.
    // `>= g` and not `>= 0`: on an engraved axis bar 1 can land inside the roll's label column,
    // and canvas does not clip, so the flag would be painted over the labels.
    const mx = this.secToX(this.barOneSec, m);
    if (Number.isFinite(mx) && mx >= g && mx <= w) {
      ctx.fillStyle = this.colors.marker;
      ctx.fillRect(mx - 0.5, top, 1.5, h - top);
      const flagH = Math.min(11, Math.max(6, h - top));
      ctx.beginPath();
      ctx.moveTo(mx, top);
      ctx.lineTo(mx + 9, top);
      ctx.lineTo(mx + 9, top + flagH - 3);
      ctx.lineTo(mx, top + flagH);
      ctx.closePath();
      ctx.fill();
      if (flagH >= 8) {
        ctx.fillStyle = '#1a1005';
        ctx.font = '700 7px ui-monospace, Menlo, monospace';
        ctx.fillText('1', mx + 2.5, top + flagH - 3.5);
      }
    }

    // Playhead.
    const px = this.secToX(this.positionSec, m);
    if (Number.isFinite(px) && px >= g && px <= w) {
      ctx.fillStyle = this.colors.playhead;
      ctx.fillRect(px - 0.5, top, 1, h - top);
    }
  };

  /**
   * The min and max of the recording covered by ONE screen column, or null when that column
   * covers no audio at all.
   *
   * Two branches, and section 4 of the header is the argument for the second one:
   *  - a column at least one bucket wide takes the exact extremes of every bucket it touches.
   *    That is every column on the even ruler up to a 2000px plot, so the fallback draws
   *    exactly what it always drew — verified column by column against the old arithmetic at
   *    1180, 900 and 360 wide.
   *  - a column NARROWER than a bucket is being asked for detail the peak data does not have,
   *    which happens as soon as the sheet is zoomed in. Repeating one bucket's value across
   *    every column that lands in it turns the envelope into a staircase of 25px plateaus.
   *    Interpolating between the two neighbouring bucket centres cannot invent a peak — every
   *    value it produces lies between two real measurements — and it reads as audio again.
   */
  private columnPeak(t0: number, t1: number): { lo: number; hi: number } | null {
    const minArr = this.peaksMin!;
    const maxArr = this.peaksMax!;
    const buckets = minArr.length;
    if (buckets === 0 || !(this.durationSec > 0)) return null;

    const perSec = buckets / this.durationSec;
    const a = t0 * perSec;
    const b = t1 * perSec;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    // Off either end of the recording. On an engraved axis this is normal: the sheet extends
    // past the last note and extrapolates before the first one.
    if (b <= 0 || a >= buckets) return null;

    if (b - a >= 1 || buckets < 2) {
      // The nudge is not cosmetic. A column's time bounds came out of `x -> seconds` and go
      // straight back in through `seconds -> buckets`, so `duration` is divided out of a number
      // it was just multiplied into. Measured over 4704 columns at four viewport widths, that
      // round trip lands one boundary a few ULPs BELOW a whole bucket (999.999999999 for
      // 1000.0) and the column then drops a bucket the old integer-only maths kept. A
      // millionth of a bucket is a hundred thousand times smaller than any real boundary and
      // ten thousand times larger than the noise.
      const eps = 1e-6;
      const i0 = Math.max(0, Math.floor(a + eps));
      const i1 = Math.min(buckets, Math.max(i0 + 1, Math.floor(b + eps)));
      let lo = 1;
      let hi = -1;
      for (let i = i0; i < i1; i++) {
        if (minArr[i] < lo) lo = minArr[i];
        if (maxArr[i] > hi) hi = maxArr[i];
      }
      return lo > hi ? null : { lo, hi };
    }

    // Sub-bucket: interpolate between the centres of the buckets either side of this column.
    const c = (a + b) / 2 - 0.5;
    const i = Math.max(0, Math.min(buckets - 2, Math.floor(c)));
    const f = Math.max(0, Math.min(1, c - i));
    const lo = minArr[i] + (minArr[i + 1] - minArr[i]) * f;
    const hi = maxArr[i] + (maxArr[i + 1] - maxArr[i]) * f;
    return lo > hi ? null : { lo, hi };
  }

  /**
   * The audio itself, one column per pixel, on whichever axis the body is using.
   *
   * Colour is decided from the column's own TIME rather than by comparing its x against a
   * playhead x. On the even ruler the two are identical; on the engraved one, comparing pixels
   * would be comparing positions on a ruler that is not linear in time, which is exactly the
   * class of bug this change exists to remove.
   */
  private drawWave(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    g: number,
    top: number,
    m: SheetMap | null
  ): void {
    const bodyH = Math.max(2, h - top);
    const mid = top + bodyH / 2;
    const scale = (bodyH / 2) * 0.88;
    const trimStart = this.trim ? this.trim.startOffsetSec : 0;
    const trimEnd = this.trim ? this.trim.endSec : this.durationSec;

    for (let x = g; x < w; x++) {
      const a = this.xToSec(x, m);
      const b = this.xToSec(x + 1, m);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const p = this.columnPeak(Math.min(a, b), Math.max(a, b));
      if (!p) continue;

      const trimmed = a < trimStart || a > trimEnd;
      ctx.fillStyle = trimmed
        ? this.colors.waveDim
        : a <= this.positionSec
          ? this.colors.played
          : this.colors.wave;
      const y = mid + p.lo * scale;
      ctx.fillRect(x, y, 1, Math.max(1, (p.hi - p.lo) * scale));
    }
  }

  /**
   * The stretches the auto-edit pass acted on, or wanted to. See `setAttentionRegions`.
   *
   * A tinted band with a brighter cap along the top edge. The cap is what makes a very short
   * region visible at all: a 150 ms gap-fill on a two-minute take is under a pixel wide, and a
   * 12% wash a pixel wide is invisible, so the cap is drawn at a floor width instead.
   */
  private drawAttention(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    g: number,
    top: number,
    m: SheetMap | null
  ): void {
    if (this.attention.length === 0) return;
    const height = h - top;
    if (height <= 0) return;

    ctx.save();
    for (const region of this.attention) {
      const fromX = this.secToX(region.fromSec, m);
      const toX = this.secToX(region.toSec, m);
      if (!Number.isFinite(fromX) || !Number.isFinite(toX)) continue;
      const left = Math.max(g, Math.min(fromX, toX));
      const right = Math.min(w, Math.max(fromX, toX));
      if (right < g || left > w) continue;
      const width = Math.max(2, right - left);
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = this.colors.autoEdit;
      ctx.fillRect(left, top, width, height);
      ctx.globalAlpha = 0.85;
      ctx.fillRect(left, top, width, 2);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * A faint detection curve plus a clear tick for each picked attack. This is
   * evidence, not a correction: nothing here adds or deletes a note.
   */
  private drawOnsets(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    g: number,
    top: number,
    m: SheetMap | null
  ): void {
    const result = this.onsetResult;
    if (!result || h - top < 8) return;

    const envelope = result.envelope;
    const hop = result.envelopeHopSec;
    const laneH = Math.min(15, Math.max(6, (h - top) * 0.24));
    const bottom = h - 1;

    if (envelope.length > 1 && hop > 0) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = this.colors.onset;
      for (let x = g; x < w; x++) {
        const sec = this.xToSec(x + 0.5, m);
        if (!Number.isFinite(sec) || sec < 0) continue;
        const at = sec / hop;
        const i = Math.floor(at);
        if (i < 0 || i >= envelope.length) continue;
        const next = Math.min(envelope.length - 1, i + 1);
        const value = envelope[i] + (envelope[next] - envelope[i]) * (at - i);
        const height = Math.max(0, Math.min(1, value)) * laneH;
        if (height > 0.25) ctx.fillRect(x, bottom - height, 1, height);
      }
      ctx.restore();
    }

    ctx.fillStyle = this.colors.onset;
    for (const onset of result.onsets) {
      const x = this.secToX(onset.timeSec, m);
      if (!Number.isFinite(x) || x < g || x > w) continue;
      const tickH = 4 + Math.round(Math.max(0, Math.min(1, onset.strength)) * 6);
      ctx.fillRect(x - 0.75, h - tickH, 1.5, tickH);
    }
  }

  /**
   * THE WHOLE-TAKE RIBBON — only drawn while the body is engraved, because only then has the
   * body stopped being the whole take.
   *
   * Everything in it is on the plain even ruler: a miniature envelope, the trimmed head and
   * tail knocked back, the visible span as a bright bracket with the rest dimmed, and one-pixel
   * ticks for bar 1 and the playhead so you can see where you are in the recording even when
   * the sheet has scrolled miles from either.
   */
  private drawOverview(
    ctx: CanvasRenderingContext2D,
    w: number,
    g: number,
    ribbonH: number,
    hasAudio: boolean
  ): void {
    ctx.fillStyle = this.colors.gutter;
    ctx.fillRect(g, 0, w - g, ribbonH);

    if (hasAudio) {
      const mid = ribbonH / 2;
      const scale = (ribbonH / 2) * 0.82;
      const trimStart = this.trim ? this.trim.startOffsetSec : 0;
      const trimEnd = this.trim ? this.trim.endSec : this.durationSec;
      for (let x = g; x < w; x++) {
        const a = this.wholeTakeXToSec(x);
        const p = this.columnPeak(a, this.wholeTakeXToSec(x + 1));
        if (!p) continue;
        ctx.fillStyle = a < trimStart || a > trimEnd ? this.colors.waveDim : this.colors.wave;
        ctx.fillRect(x, mid + p.lo * scale, 1, Math.max(1, (p.hi - p.lo) * scale));
      }
    }

    const b = this.bracket();
    if (b) {
      // Knock the take back OUTSIDE the visible span, so the bright part of the ribbon and the
      // engraved body below it are obviously the same music.
      ctx.save();
      ctx.globalAlpha = WaveformStrip.OUTSIDE_DIM;
      ctx.fillStyle = this.colors.gutter;
      if (b.fromX > g) ctx.fillRect(g, 0, b.fromX - g, ribbonH);
      if (b.toX < w) ctx.fillRect(b.toX, 0, w - b.toX, ribbonH);
      ctx.restore();

      ctx.fillStyle = this.colors.viewport;
      ctx.fillRect(b.fromX, 0, 1, ribbonH);
      ctx.fillRect(b.toX - 1, 0, 1, ribbonH);
      ctx.fillRect(b.fromX, 0, Math.max(2, b.toX - b.fromX), 1);
      ctx.fillRect(b.fromX, ribbonH - 1, Math.max(2, b.toX - b.fromX), 1);
    }

    if (this.durationSec > 0) {
      ctx.fillStyle = this.colors.marker;
      ctx.fillRect(this.wholeTakeSecToX(this.barOneSec) - 0.5, 0, 1, ribbonH);
      ctx.fillStyle = this.colors.playhead;
      ctx.fillRect(this.wholeTakeSecToX(this.positionSec) - 0.5, 0, 1, ribbonH);
    }

    ctx.fillStyle = this.colors.line;
    ctx.fillRect(g, ribbonH - 1, w - g, 1);
  }

  /**
   * The bracket on the BODY, for the unlinked ruler only: what you are reading below stays
   * bright and the rest of the take is knocked back.
   *
   * The wash is drawn over the finished waveform instead of by re-colouring the columns,
   * because the columns already carry three meanings (trimmed, played, unplayed) and a fourth
   * set of colours multiplied against those three is a palette nobody can read. A translucent
   * coat of the strip's own background dims all three the same way.
   *
   * There is no rail to grab any more: with the drag-out-a-range gesture gone there is no
   * fourth gesture to disambiguate, and a click outside the bracket already means "bring the
   * sheet here" — one action instead of a small target to find and slide.
   */
  private drawBodyBracket(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    g: number,
    top: number
  ): void {
    const b = this.bracket();
    if (!b) return;

    ctx.save();
    ctx.globalAlpha = WaveformStrip.OUTSIDE_DIM;
    ctx.fillStyle = this.colors.bg;
    if (b.fromX > g) ctx.fillRect(g, top, b.fromX - g, h - top);
    if (b.toX < w) ctx.fillRect(b.toX, top, w - b.toX, h - top);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = this.colors.viewport;
    ctx.fillRect(b.fromX, top, 1, h - top);
    ctx.fillRect(b.toX - 1, top, 1, h - top);
    ctx.restore();
  }

  /**
   * The probe window.
   *
   * A wash the full height of the body with a solid edge each side. It is drawn AFTER the
   * bracket wash on purpose: what you have picked out to listen to must stay visible even in a
   * part of the take the sheet is not currently showing, because that is the common case — you
   * point at the bit that came out wrong.
   *
   * No grips any more. They said "take hold of this edge", and there is nothing to take hold
   * of: the window is a fixed width and a new one is one click away.
   */
  private drawSelection(
    ctx: CanvasRenderingContext2D,
    h: number,
    top: number,
    m: SheetMap | null
  ): void {
    const s = this.selectionBox(m);
    if (!s) return;
    const height = h - top;
    if (height <= 0) return;

    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = this.colors.select;
    ctx.fillRect(s.fromX, top, s.toX - s.fromX, height);
    ctx.restore();

    ctx.fillStyle = this.colors.select;
    ctx.fillRect(s.fromX, top, 1.5, height);
    ctx.fillRect(s.toX - 1.5, top, 1.5, height);
  }

  /** What the harness (and a bug report) needs to see. Read-only. */
  probe(): {
    width: number;
    height: number;
    gutterPx: number;
    plotWidth: number;
    /**
     * The top band that is NOT the main envelope — the whole-take overview ribbon, and 0
     * whenever the body is already the whole take. Kept under its old name because it is what
     * a caller means by "where does the body start": the handle lane it used to describe was
     * deleted with the drag gesture it existed to disambiguate.
     */
    handleLanePx: number;
    /** The same number under the name it now deserves. */
    overviewPx: number;
    /** True when the body is drawn on the SHEET's engraved x-axis rather than on even time. */
    sheetLinked: boolean;
    /** ALIGN: the stretch of RECORDING the BODY is showing. The ribbon is always whole-take. */
    windowFromSec: number | null;
    windowToSec: number | null;
    /** What the middle of the body's plot means, in RECORDING seconds. */
    midPlotSec: number;
    /** Written second 0 on the recording's clock, as handed in. Compare with the sheet's. */
    scoreOriginSec: number;
    /** The fixed width a click asks about. */
    probeWindowSec: number;
    durationSec: number;
    barOneSec: number;
    positionSec: number;
    hasAudio: boolean;
    onsetCount: number;
    hasOnsetEnvelope: boolean;
    /** The slice the sheet and the roll say they are showing, as handed to us. */
    viewportFromSec: number | null;
    viewportToSec: number | null;
    /**
     * Whether a bracket is actually on screen — in the ribbon when linked, on the body when
     * not. False with numbers still set means the range covers the whole take: see `bracket()`.
     */
    hasViewport: boolean;
    /** Where the bracket is drawn, on the even ruler, so a synthetic drag can aim at it. */
    viewportFromX: number | null;
    viewportToX: number | null;
    /** True when the bracket is a navigator; false when it is only a picture. */
    viewportDraggable: boolean;
    /** The window the player has pointed at, on the recording's clock. */
    selectionFromSec: number | null;
    selectionToSec: number | null;
    /** Where that band is drawn on the BODY's axis, or null when it is off screen. */
    selectionFromX: number | null;
    selectionToX: number | null;
    /** True when a listener is wired; false means probing is off. */
    selectable: boolean;
    dragging: DragKind | null;
    /**
     * Stretches the auto-edit pass marked, and how many of those were real edits.
     *
     * The same number twice now, and both kept: every mark IS a real edit since the yellow
     * "noticed but untouched" kind was removed, and `attentionApplied` is the field the
     * harness asserts drops to zero once the player has reviewed the pass.
     */
    attentionRegions: number;
    attentionApplied: number;
  } {
    const m = this.map();
    const b = this.bracket();
    const s = this.selectionBox(m);
    const round = (v: number | null) => (v === null ? null : Number(v.toFixed(3)));
    const ribbon = this.overviewHeight(!!m);
    return {
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      gutterPx: this.gutterPx,
      plotWidth: Math.round(this.plotWidth),
      handleLanePx: ribbon,
      overviewPx: ribbon,
      sheetLinked: !!m,
      windowFromSec: this.anchors ? Number((this.anchorSec(0) ?? 0).toFixed(4)) : null,
      windowToSec: this.anchors ? Number((this.anchorSec(1) ?? 0).toFixed(4)) : null,
      midPlotSec: Number(this.evenXToSec(this.gutterPx + this.plotWidth / 2).toFixed(4)),
      scoreOriginSec: Number(this.scoreOriginSec.toFixed(3)),
      probeWindowSec: WaveformStrip.PROBE_WINDOW_SEC,
      durationSec: Number(this.durationSec.toFixed(3)),
      barOneSec: Number(this.barOneSec.toFixed(3)),
      positionSec: Number(this.positionSec.toFixed(3)),
      hasAudio: !!this.peaksMin && !!this.peaksMax,
      onsetCount: this.onsetResult?.onsets.length ?? 0,
      hasOnsetEnvelope: (this.onsetResult?.envelope.length ?? 0) > 0,
      viewportFromSec: round(this.viewportFromSec),
      viewportToSec: round(this.viewportToSec),
      hasViewport: !!b,
      viewportFromX: b ? Number(b.fromX.toFixed(2)) : null,
      viewportToX: b ? Number(b.toX.toFixed(2)) : null,
      viewportDraggable: !!this.opts.onViewportScrub,
      selectionFromSec: round(this.selectionFromSec),
      selectionToSec: round(this.selectionToSec),
      selectionFromX: s ? Number(s.fromX.toFixed(2)) : null,
      selectionToX: s ? Number(s.toX.toFixed(2)) : null,
      selectable: !!this.opts.onSelectionChange,
      dragging: this.dragging,
      attentionRegions: this.attention.length,
      attentionApplied: this.attention.length
    };
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('resize', this.draw);
    window.removeEventListener('keydown', this.onKeyDown);
  }
}
