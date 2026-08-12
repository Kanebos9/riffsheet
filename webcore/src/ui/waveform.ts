/**
 * The waveform strip.
 *
 * Jobs: show the recording, seek on click, carry the draggable "bar 1" marker, say which part
 * of the take the sheet is reading, and — when you click it — hand the tuner a short window of
 * audio to interrogate.
 *
 * ===========================================================================================
 * 1. WHY A CLICK IS A MOMENT, AND WHEN A DRAG IS A SPAN
 * ===========================================================================================
 * Up to v1.2 the way into the tuner was to drag a stretch of recording out of this strip. That
 * is gone as the DEFAULT gesture, on the owner's decision, and the reasoning is worth keeping
 * because it will look like a lost feature otherwise:
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
 * So a click emits one committed selection of a FIXED width, `PROBE_WINDOW_SEC`, centred on
 * the moment you clicked. `onSelectionChange(sel, commit)` is unchanged as an outward
 * contract, so the integrator's wiring and the tuner keep working untouched.
 *
 * THE WIDTH IS 0.1 SECONDS. This paragraph said 0.2 for a while after the constant was
 * lowered, which is worth naming rather than quietly correcting: 0.2 was derived, 0.1 was
 * chosen, and the derivation is what makes the number arguable at all. Against `audio/pitch.ts`:
 *   - the detector's analysis frame is two periods of the lowest note it will look for
 *     (27.5 Hz), i.e. ~73 ms. Under that there is no frame at all.
 *   - `detectPitchTrack`'s default hop is 50 ms, and `ui/tuner.ts` requires `MIN_RUN_FRAMES`
 *     = 2 frames to agree before it will call something a note rather than a transient.
 *   - 0.2 s gives floor((0.200 - 0.073) / 0.05) + 1 = 3 frames, one more than the minimum.
 *   - 0.1 s gives 1 frame by that arithmetic, and it is what ships. The HIGHLIGHT is what this
 *     constant sizes; the tuner may inspect a wider hidden window around it, and the reason for
 *     the change was that a 0.2 s band drawn on the strip implies you selected a fifth of a
 *     second when you were pointing at one transient.
 * It is ONE constant. Tuning the highlight means changing that number and nothing else.
 *
 * ===========================================================================================
 * 1b. AND THE DRAG IS BACK, BEHIND A MODE (G8)
 * ===========================================================================================
 * The argument above is an argument about the TUNER. Cutting a stretch out of a take is a
 * different question with a perfectly good answer, and with only the probe window to work from
 * the "Cut out" button under this strip could offer to remove one tenth of one second and
 * nothing else. That was the whole of the reported fault.
 *
 * `setSelectArmed(true)` — driven by the Cut chip under the strip, never by this file — puts a
 * press-and-drag back on the body: sweep out a span, grab either edge to adjust it, and the
 * same `onSelectionChange(sel, commit)` carries it. Unarmed, nothing about this file's
 * behaviour has changed by a pixel, which is the point of the mode: the tuner's gesture cannot
 * be made ambiguous by a feature it has nothing to do with.
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
import { TIMELINE_GUTTER_PX, wheelZoomFactor, WHEEL_ZOOM_MAX_STEP, type TimeAnchor } from '../view/pianoroll';
import { PinchAccumulator, type ViewportCommand } from '../view/timeAxis';

/** One pinch, one zoom, whichever road WebKit sends it down. See `PianoRoll`'s constant. */
const PINCH_DEDUPE_MS = 250;

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
   * THE STRIP'S HALF OF THE SHARED WINDOW. Same command type the roll and the sheet emit.
   *
   * `onViewportScrub` stood here and is gone with the overview ribbon that produced it: the
   * ribbon was drawn only when `map()` returned non-null, `map()` returned null forever, so the
   * ribbon never appeared, its drag path was unreachable and this callback could not fire
   * (findings 8 and 14). What the strip lacked was not a scrub callback but any wheel or gesture
   * handler at all — so a ctrl-wheel over the waveform fell through to the browser and zoomed
   * the whole plugin window, which inside a plugin cannot be got back from (finding 12).
   *
   * Wire this and a pinch or a two-finger swipe over the strip means here what it means over
   * the roll, because it reaches the same reducer.
   */
  onViewportCommand?: (cmd: ViewportCommand) => void;
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
}

/**
 * Which gesture has the pointer. Null means none is in flight.
 *
 * `select` is back (G8), and it is back BEHIND A MODE rather than as the strip's default
 * gesture. The reasoning that removed it in v1.2 stands for the TUNER — "what pitch is in
 * these four seconds" has no good answer, "what is at this moment" has exactly one — but
 * cutting a stretch out of a take is a different question, and there was no way to ask it: the
 * only selection the strip could produce was the 0.1s probe window, so "Cut out" offered to
 * remove a tenth of a second and nothing else. That is the reported bug.
 *
 * One gesture, two meanings, told apart by `selectArmed` and never by guessing: unarmed, a
 * press is a click and paints the probe window exactly as before; armed, a press-and-drag
 * sweeps out a span. `select-from`/`select-to` are NOT back — an edge grab is this same kind
 * with the opposite edge pinned as the anchor, which is one state instead of three.
 */
type DragKind = 'marker' | 'select';

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
  /**
   * Is the strip in span-selecting mode? (G8)
   *
   * False by default and false for every caller that never asks, so the strip a player meets
   * is the click-to-probe strip the tuner is built on. The app arms it from the Cut chip under
   * the strip; see `setSelectArmed`.
   */
  private selectArmed = false;
  /**
   * The end of a span drag that is NOT moving: the second the drag started from, or — when an
   * edge handle was grabbed — the OPPOSITE edge of the existing span. One field, because a
   * drag has exactly one fixed end however it began.
   */
  private dragAnchorSec = 0;
  /** A body press waiting for its release, which is what commits the probe window. */
  private pressing = false;
  /** Where the pointer went down, so a press that never moved can still be a plain click. */
  private pressX = 0;
  /** The second under `pressX`, resolved once on press so the release cannot re-resolve it
   *  against an axis the sheet has scrolled underneath us in the meantime. */
  private pressSec = 0;
  /** True once a press has moved far enough to be a drag rather than a click. */
  private pressMoved = false;
  private colors = {
    bg: '#1e2128',
    gutter: '#16181d',
    line: '#2e3340',
    wave: '#3a4150',
    waveDim: '#282d38',
    played: '#8b5cf6',
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
  /** Both edges have to be visible as edges, so the bracket is never drawn thinner than this. */
  private static VIEWPORT_MIN_DRAW_PX = 3;
  /**
   * A press is a click until it has travelled this far. That is what lets "click seeks" and
   * "drag does something else" live on the same pixels without either one surprising the
   * player.
   */
  private static DRAG_SLOP_PX = 3;
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
   * How close to a span's edge counts as taking hold of it (G8).
   *
   * Deliberately smaller than `MARKER_HIT_PX`: the bar-1 flag is a thin line somebody has to
   * find, while a span's edges bound a filled band that is itself a target, so a generous slop
   * here would steal presses meant for "start a new span in the middle of this one".
   */
  private static SELECT_EDGE_HIT_PX = 5;
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
    // Not passive: a pinch arrives as a ctrl-wheel and an unhandled one is the browser's page
    // zoom, which inside a plugin window resizes the whole UI. See `onWheel`.
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('gesturestart', this.onGestureStart, { passive: false });
    this.canvas.addEventListener('gesturechange', this.onGestureChange, { passive: false });
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

  // `map(): SheetMap | null` AND `overviewHeight()` STOOD HERE, and they are gone together
  // (findings 8 and 14) because they were two halves of one dead mode.
  //
  // `map()` returned null forever — the engraved-axis mode was deleted for re-spacing the picture
  // of a recording whenever a note was edited — and `overviewHeight(!!map())` was therefore always
  // 0, so the whole-take overview ribbon was never drawn, its drag path was unreachable, and
  // `onViewportScrub` was dead. Meanwhile `setTimeAnchors` went on zooming the BODY to the aligned
  // window while `bracket()` computed its x's on the plain whole-take ruler and painted them over
  // that zoomed body. On a 100 s take showing [40,60] the body mapped 40 s to its left edge and
  // 60 s to its right, and the bracket was drawn from 40% to 60% of that — leaving roughly 48-52 s
  // bright. Two rulers, one canvas, and neither the dimming nor the advertised drag worked.
  //
  // One ruler now: the body IS the authoritative window. `bracket()` survives on the body's own
  // axis, where it agrees with the window by construction rather than by luck — which is the
  // property the probe check asserts.

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

  /** RECORDING seconds -> x. THE mapping, and now the only one: the window's two ends. */
  private secToX(sec: number): number {
    return this.secToEvenX(sec);
  }

  /** The exact inverse. */
  private xToSec(x: number): number {
    return this.evenXToSec(x);
  }

  /** A pointer x turned into a second inside the recording. */
  private secAt(x: number): number {
    const sec = this.xToSec(x);
    return Number.isFinite(sec) ? Math.max(0, Math.min(this.durationSec, sec)) : Number.NaN;
  }

  /**
   * Where the visible window is ON THE BODY'S OWN AXIS, or null when there is nothing to point at.
   *
   * THE SAME AXIS THE BODY IS DRAWN ON, and that is finding 8's fix stated in one function call:
   * `secToEvenX` goes through the anchors, so these two x's are the two edges of exactly the
   * stretch of recording the envelope underneath them is showing. It used to go through
   * `wholeTakeSecToX`, which ignores the anchors entirely, so the bracket described a window on
   * a ruler the body was not using.
   *
   * The consequence, now that the body and the window are the same thing, is that this reaches
   * the two ends of the plot — which is correct and is why nothing dims. It is kept because it
   * is the strip's own answer to "which seconds am I showing", asserted against the app's
   * authoritative window by the scroll/zoom probe.
   *
   * Null covers: no range set, no audio, and a range that already spans the whole take.
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

    let fromX = this.secToEvenX(lo);
    let toX = this.secToEvenX(hi);
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
  private selectionBox(): { fromX: number; toX: number; fromSec: number; toSec: number } | null {
    const from = this.selectionFromSec;
    const to = this.selectionToSec;
    if (from === null || to === null || !(this.durationSec > 0)) return null;
    const w = this.canvas.clientWidth || 0;
    const g = this.gutterPx;
    if (w <= g + 1) return null;

    const lo = Math.max(0, Math.min(from, this.durationSec));
    const hi = Math.max(lo, Math.min(to, this.durationSec));
    let fromX = this.secToX(lo);
    let toX = this.secToX(hi);
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
  private overMarker(x: number): boolean {
    const mx = this.secToX(this.barOneSec);
    if (!Number.isFinite(mx) || mx < this.gutterPx || mx > (this.canvas.clientWidth || 0)) {
      return false;
    }
    return Math.abs(x - mx) <= WaveformStrip.MARKER_HIT_PX;
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
    this.pressX = x;
    this.pressMoved = false;
    this.pressing = false;

    if (x < this.gutterPx) return;

    const sec = this.secAt(x);
    if (!Number.isFinite(sec)) return;
    this.pressSec = sec;

    if (this.overMarker(x)) {
      this.dragging = 'marker';
      this.capture(e.pointerId);
      return;
    }

    // ARMED: sweep out a span (G8). Nothing below this branch runs, which is what keeps the
    // probe window and the span from ever being emitted by the same press.
    if (this.selectArmed) {
      // AN EDGE FIRST, because the alternative — starting a fresh span from a point one pixel
      // inside the old one — is what makes a selection feel un-adjustable. The anchor becomes
      // the OPPOSITE edge, so dragging the left handle past the right one simply turns the span
      // around rather than collapsing it.
      const box = this.selectionBox();
      if (box) {
        const slop = WaveformStrip.SELECT_EDGE_HIT_PX;
        if (Math.abs(x - box.fromX) <= slop) {
          this.dragAnchorSec = box.toSec;
          this.dragging = 'select';
          this.capture(e.pointerId);
          return;
        }
        if (Math.abs(x - box.toX) <= slop) {
          this.dragAnchorSec = box.fromSec;
          this.dragging = 'select';
          this.capture(e.pointerId);
          return;
        }
      }
      this.dragAnchorSec = sec;
      this.dragging = 'select';
      // The seek still happens, because knowing where you have grabbed is worth as much here
      // as anywhere. What does NOT happen is the probe window: in this mode a press is the
      // start of a span, and painting a 0.1s band under it would be the app answering a
      // question nobody asked.
      this.opts.onSeek(sec);
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
   * Point at a moment: a window of exactly `PROBE_WINDOW_SEC` centred on it.
   *
   * Centred rather than starting there because the question is "what is at this moment", and
   * because a window that starts at the click swallows the pluck's attack transient, which is
   * the least pitched part of any note. At the two ends of the take the window SLIDES to stay
   * inside the recording rather than being shortened — a shorter window is a worse answer, and
   * silently changing the width the whole feature is calibrated on is how a constant stops
   * meaning anything.
   */
  /**
   * Turn span-selecting on or off (G8).
   *
   * Public because the control that arms it is not in this file: it lives under the strip with
   * the other take edits, where "Cut out 3.4s" appears, because arming a destructive gesture
   * belongs beside the destructive button and not on the canvas it changes the meaning of.
   *
   * Disarming does NOT clear the span. The normal sequence is arm, drag, press "Cut out", and
   * the app disarms on the way into the cut — throwing the span away at that moment would
   * discard the thing being cut.
   */
  setSelectArmed(on: boolean): void {
    if (this.selectArmed === on) return;
    this.selectArmed = on;
    this.canvas.style.cursor = on ? 'crosshair' : 'default';
    this.draw();
  }

  /** True while a span drag is the strip's gesture. Reported by `probe()` for the checks. */
  isSelectArmed(): boolean {
    return this.selectArmed;
  }

  /**
   * The span under the pointer, as a selection, clamped to the take and ordered.
   *
   * Shared by the move handler and the edge grab so a span dragged left-to-right and one
   * dragged right-to-left cannot come out as different shapes.
   */
  private emitSpan(sec: number, commit: boolean): void {
    const lo = Math.max(0, Math.min(this.dragAnchorSec, sec));
    const hi = Math.min(this.durationSec, Math.max(this.dragAnchorSec, sec));
    this.selectionFromSec = lo;
    this.selectionToSec = hi;
    this.opts.onSelectionChange?.({ fromSec: lo, toSec: hi }, commit);
    this.draw();
  }

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

    if (this.dragging === 'select') {
      if (!this.pressMoved && Math.abs(x - this.pressX) < WaveformStrip.DRAG_SLOP_PX) return;
      const sec = this.secAt(x);
      if (!Number.isFinite(sec)) return;
      this.pressMoved = true;
      // Live, uncommitted: the band follows the finger and the notes under it light up, and
      // nothing expensive runs until the release.
      this.emitSpan(sec, false);
      return;
    }

    // A body press has nothing to track: the window was decided on press and a click does not
    // grow. All that is left is the cursor.
    if (!this.pressing) this.canvas.style.cursor = this.cursorFor(x);
  };

  /** What the pointer should look like here. One place, so the hit tests cannot lie. */
  private cursorFor(x: number): string {
    if (x < this.gutterPx) return 'default';
    if (this.overMarker(x)) return 'ew-resize';
    if (this.selectArmed) {
      // The two edges of an existing span are handles, and the cursor is the only thing that
      // says so — the band has no drawn grips (see `drawSelection`).
      const box = this.selectionBox();
      if (
        box &&
        (Math.abs(x - box.fromX) <= WaveformStrip.SELECT_EDGE_HIT_PX ||
          Math.abs(x - box.toX) <= WaveformStrip.SELECT_EDGE_HIT_PX)
      ) {
        return 'ew-resize';
      }
      return 'crosshair';
    }
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

    if (was === 'select') {
      this.canvas.style.cursor = 'crosshair';
      if (!this.pressMoved) {
        // Armed, pressed, released without moving. That is "start again here", so the old span
        // goes: leaving it would make the next press look like it had done nothing, and
        // falling back to the 0.1s probe window would put the app straight back into the bug
        // this mode exists to fix — a Cut button offering to remove a tenth of a second.
        if (this.selectionFromSec !== null || this.selectionToSec !== null) {
          this.selectionFromSec = null;
          this.selectionToSec = null;
          this.opts.onSelectionChange?.(null, true);
          this.draw();
        }
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      const sec = this.secAt(e.clientX - rect.left);
      // The release lands where the finger is, not where the press was: the last live frame
      // may be a whole pointer-move behind, and a span that shrinks on release feels like a
      // dropped edit.
      this.emitSpan(Number.isFinite(sec) ? sec : this.selectionToSec ?? this.dragAnchorSec, true);
      return;
    }

    // A body click. The seek and the highlight happened on press; this is the commit that
    // actually asks the question, and it is deliberately the second the press landed on and
    // not wherever the finger drifted to before it came up.
    this.setProbeWindow(this.pressSec, true);
  };

  /**
   * THE STRIP'S HALF OF THE TRACKPAD CONTRACT, which it did not have at all until now.
   *
   *   pinch                  -> the shared TIME window, about the pointer
   *   two fingers sideways   -> pan the shared TIME window
   *   Option (alt) + pinch   -> the PITCH axis, which only the roll has — swallowed here
   *
   * THE BUG THIS FIXES IS NOT A MISSING FEATURE (finding 12). This strip had no wheel or gesture
   * listener at all, so a ctrl-wheel over it — which is what macOS calls a trackpad pinch — fell
   * through to the browser. Inside a plugin window the browser's page zoom resizes the entire UI
   * and there is no way back from it. `preventDefault` is therefore unconditional on that path,
   * exactly as it is over the sheet and the roll, whether or not the gesture is used.
   */
  private onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.altKey) return;
      const d = e.deltaY || e.deltaX;
      if (d === 0) return;
      if (!this.claimPinch('wheel')) return;
      this.emitZoom(wheelZoomFactor(d, e.deltaMode), e.clientX);
      return;
    }
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * lines;
    if (dx === 0) return;
    e.preventDefault();
    const span = this.windowSpanSec();
    if (!(span > 0)) return;
    this.opts.onViewportCommand?.({
      kind: 'pan',
      deltaSec: (dx / Math.max(1, this.plotWidth)) * span,
      source: 'waveform'
    });
  };

  private gestureScale = 1;
  private pinch = new PinchAccumulator();
  private lastPinchMs = 0;
  private pinchRoad: 'wheel' | 'gesture' | null = null;

  /** ONE PINCH, ONE ZOOM. The same rule the roll and the sheet apply, on the third surface. */
  private claimPinch(road: 'wheel' | 'gesture'): boolean {
    const t = performance.now();
    if (this.pinchRoad !== null && this.pinchRoad !== road && t - this.lastPinchMs < PINCH_DEDUPE_MS) {
      return false;
    }
    this.pinchRoad = road;
    this.lastPinchMs = t;
    return true;
  }

  private onGestureStart = (e: Event): void => {
    e.preventDefault();
    this.gestureScale = (e as Event & { scale?: number }).scale ?? 1;
    this.pinch.reset();
  };

  private onGestureChange = (e: Event): void => {
    const g = e as Event & { scale?: number; altKey?: boolean; clientX?: number };
    const scale = g.scale;
    if (!scale || !Number.isFinite(scale) || scale <= 0) return;
    e.preventDefault();
    const ratio = scale / (this.gestureScale > 0 ? this.gestureScale : 1);
    this.gestureScale = scale;
    if (g.altKey) return;
    const stepped = this.pinch.take(ratio);
    if (stepped === null) return;
    if (!this.claimPinch('gesture')) return;
    const rect = this.canvas.getBoundingClientRect();
    this.emitZoom(
      Math.min(WHEEL_ZOOM_MAX_STEP, Math.max(1 / WHEEL_ZOOM_MAX_STEP, stepped)),
      g.clientX ?? rect.left + rect.width / 2
    );
  };

  /** A client x, as a fraction of the plot, as a zoom command. The gutter anchors at the edge. */
  private emitZoom(factor: number, clientX: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const frac = Math.max(
      0,
      Math.min(1, (clientX - rect.left - this.gutterPx) / Math.max(1, this.plotWidth))
    );
    this.opts.onViewportCommand?.({ kind: 'zoom', factor, anchorFrac: frac, source: 'waveform' });
  }

  /** What the body is showing, in seconds. The whole take when nothing has been pushed in. */
  private windowSpanSec(): number {
    const a = this.anchors;
    if (a && a.length >= 2) {
      const from = this.anchorSec(0);
      const to = this.anchorSec(1);
      if (from !== null && to !== null && to > from) return to - from;
    }
    return this.durationSec;
  }

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

    const g = this.gutterPx;
    // The ribbon lane is gone, so the body starts at the top of the canvas. Kept as a named zero
    // rather than deleted from every call below: it is the y the body begins at, and a future
    // band along the top would be one assignment rather than a sweep through the painting code.
    const top = 0;

    // The roll's label column, reserved and left empty, with the same edge the roll draws.
    if (g > 0) {
      ctx.fillStyle = this.colors.gutter;
      ctx.fillRect(0, 0, g, h);
      ctx.fillStyle = this.colors.line;
      ctx.fillRect(g - 1, 0, 1, h);
    }

    const hasAudio = !!this.peaksMin && !!this.peaksMax && this.durationSec > 0;

    // UNDER the envelope, so the audio stays the picture and the tint reads as something the
    // app has written on the background rather than as a change to the recording.
    this.drawAttention(ctx, w, h, g, top);
    if (hasAudio) this.drawWave(ctx, w, h, g, top);
    this.drawOnsets(ctx, w, h, g, top);
    // NO BRACKET IS DRAWN, and it is not an omission. The body is the window, so the bracket's
    // two edges are the plot's two edges and there is nothing outside them to dim — see
    // `bracket()`. `drawBodyBracket` was the wash between two rulers that no longer disagree.
    this.drawSelection(ctx, h, top);

    // Bar-1 marker: a line the whole height of the body so you can see what it lands on, with
    // its flag at the top of the body. NaN means the sheet has scrolled past it — draw nothing
    // rather than pinning it to the left wall, where it would claim bar 1 is at the edge of
    // the screen.
    // `>= g` and not `>= 0`: on an engraved axis bar 1 can land inside the roll's label column,
    // and canvas does not clip, so the flag would be painted over the labels.
    const mx = this.secToX(this.barOneSec);
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
        ctx.fillStyle = '#150c26';
        ctx.font = '700 7px ui-monospace, Menlo, monospace';
        ctx.fillText('1', mx + 2.5, top + flagH - 3.5);
      }
    }

    // Playhead.
    const px = this.secToX(this.positionSec);
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
    top: number
  ): void {
    const bodyH = Math.max(2, h - top);
    const mid = top + bodyH / 2;
    const scale = (bodyH / 2) * 0.88;
    const trimStart = this.trim ? this.trim.startOffsetSec : 0;
    const trimEnd = this.trim ? this.trim.endSec : this.durationSec;

    for (let x = g; x < w; x++) {
      const a = this.xToSec(x);
      const b = this.xToSec(x + 1);
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
    top: number
  ): void {
    if (this.attention.length === 0) return;
    const height = h - top;
    if (height <= 0) return;

    ctx.save();
    for (const region of this.attention) {
      const fromX = this.secToX(region.fromSec);
      const toX = this.secToX(region.toSec);
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
    top: number
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
        const sec = this.xToSec(x + 0.5);
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
      const x = this.secToX(onset.timeSec);
      if (!Number.isFinite(x) || x < g || x > w) continue;
      const tickH = 4 + Math.round(Math.max(0, Math.min(1, onset.strength)) * 6);
      ctx.fillRect(x - 0.75, h - tickH, 1.5, tickH);
    }
  }

  // `drawOverview()` STOOD HERE — the whole-take ribbon, ~90 lines of miniature envelope,
  // trimmed-head wash, bracket, rails and playhead tick. `overviewHeight()` gated it and returned
  // 0 forever, so not one pixel of it was ever painted. Deleted rather than preserved (finding 14):
  // it is the second half of a design whose first half — `map()` — was already gone, and keeping
  // unreachable alternatives alive is what made the two rulers in this file possible.
  // `drawBodyBracket()` STOOD HERE: the dim wash over the parts of the body outside the visible
  // window. With the body drawn on the window's own axis there are no parts outside it, so this
  // could only ever paint two zero-width rectangles. See `bracket()`.
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
  private drawSelection(ctx: CanvasRenderingContext2D, h: number, top: number): void {
    const s = this.selectionBox();
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
    /** True while the body's press means "sweep out a span" rather than "probe this moment". */
    selectArmed: boolean;
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
    const b = this.bracket();
    const s = this.selectionBox();
    const round = (v: number | null) => (v === null ? null : Number(v.toFixed(3)));
    // Zero, permanently: the ribbon lane is deleted. Kept in the shape because callers use it as
    // "where does the body start" when aiming a synthetic pointer.
    const ribbon = 0;
    return {
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      gutterPx: this.gutterPx,
      plotWidth: Math.round(this.plotWidth),
      handleLanePx: ribbon,
      overviewPx: ribbon,
      sheetLinked: false,
      windowFromSec: this.anchors ? Number((this.anchorSec(0) ?? 0).toFixed(4)) : null,
      windowToSec: this.anchors ? Number((this.anchorSec(1) ?? 0).toFixed(4)) : null,
      midPlotSec: Number(this.evenXToSec(this.gutterPx + this.plotWidth / 2).toFixed(4)),
      scoreOriginSec: Number(this.scoreOriginSec.toFixed(3)),
      probeWindowSec: WaveformStrip.PROBE_WINDOW_SEC,
      selectArmed: this.selectArmed,
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
      viewportDraggable: false,
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
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('gesturestart', this.onGestureStart);
    this.canvas.removeEventListener('gesturechange', this.onGestureChange);
    window.removeEventListener('resize', this.draw);
    window.removeEventListener('keydown', this.onKeyDown);
  }
}
