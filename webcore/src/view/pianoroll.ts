/**
 * The piano-roll strip: "show me the MIDI" — and, since v1.2, "let me fix it here".
 *
 * A picture of the notes the app decided on — pitch up the screen, time across it — sitting
 * directly under the waveform and, when it can, exactly under the sheet's own engraving. It
 * started life read-only; it now also reports edit *intent* (never performing the edit
 * itself) and carries the selection the sheet and the tab share.
 *
 * Ten things this file is responsible for. Every one of them has been got wrong here at
 * least once, which is why each has a paragraph rather than a line.
 *
 * 1. TWO X AXES, ONE HELPER.
 *    - FREE (the old behaviour, kept): the whole take spread linearly across the plot,
 *      `x = gutter + sec / durationSec * plotWidth`. `ui/waveform.ts` imports
 *      `TIMELINE_GUTTER_PX` and uses that identical mapping, so a rectangle sits over the
 *      sound that made it. This is still the only view that shows a long take at a glance.
 *    - LINKED: DELETED. It drew each note at the sheet's own x, which put a rectangle under
 *      the notehead that made it — and re-spaced the whole roll whenever the engraving
 *      changed, so adding one note moved its neighbours. See `map()` for the full argument;
 *      the chip that switched it survives as `alignViews` and means something else now.
 *    The notes, the bar lines, the playhead and click-to-seek ALL go through `writtenToX` /
 *    `xToWritten`. One helper, never two: the v1.1 bug where the cursor led the sound was
 *    exactly two pieces of code answering the same question differently.
 *
 * 2. THE NOTES COME FROM THE LIVE SHEET, NOT FROM THE IR SNAPSHOT.
 *    `score.ir` is what the pipeline built; an edit on the sheet never touches it, because
 *    edits mutate the alphaTab object graph `score/fromPipeline.ts` constructed. The roll
 *    read the IR and so went stale the moment anybody changed a pitch — the reported bug.
 *    `setLiveModel()` hands the roll that live graph and `refresh()` re-derives from it, so
 *    the roll is a second view of the sheet's own model rather than of a build-time copy.
 *    The IR walk survives as the fallback for the moment before the sheet exists, and the
 *    two are cross-checked at load (`probe().irDeltaSec`) so a divergence is a NUMBER in the
 *    harness rather than a picture nobody compares.
 *
 * 3. THE NOTE TIMES ARE THE WRITTEN ONES, SHIFTED ONTO THE AUDIO CLOCK.
 *    Written times rather than the detected `startSec`/`endSec` the IR also carries, so the
 *    roll shows the same rhythm the sheet does — one story, told twice. The shift is not
 *    optional: the pipeline puts bar 1 at the user's bar-1 marker, so written second 0 is
 *    `barOneSec` in the recording, and without the offset a riff with a count-in draws a
 *    lead-in's worth to the left of the sound that made it. The shift itself is
 *    `scoreOriginSec()` in `src/pipeline/index.ts`, because the sheet cursor and the synth
 *    need the identical number. Three consumers, one definition.
 *
 * 4. COLOUR MEANS SELECTION, NOT PROGRESS.
 *    Until v1.2 every note whose start was behind the playhead was painted orange, so a
 *    played riff turned into a growing orange smear and "click a note to highlight it" was
 *    indistinguishable from "the playhead went past something". That fill is GONE. What is
 *    left is honest: everything is the plain note colour; the notes actually SOUNDING right
 *    now (`start <= pos < end`) take a soft accent, which is real playback feedback because
 *    it goes away again; and the SELECTED notes take the full accent plus a heavier outline.
 *    Selection is set from outside (`setSelection`) and reported outwards (`onNoteSelect`),
 *    so the sheet, the tab and the roll can never disagree about what is selected.
 *    A click on a rectangle selects THAT rectangle and does not move the playhead; a click on
 *    empty space seeks and clears the selection. A PLAIN click always REPLACES the selection
 *    and never adds to it, which is the structural reason "everything before it lights up"
 *    cannot come back however the colours are changed later. Adding is only ever possible
 *    through an explicit modifier the player is holding down — see invariant 9.
 *
 * 5. EVERY RECTANGLE IS OUTLINED, AND ABUTTING ONES ARE KEPT APART.
 *    Two 16ths of the same pitch 30 ms apart used to draw as one long block, which is
 *    exactly the case a player needs to see. Each rect gets a 1px stroke inset by half a
 *    pixel (so it lands on the pixel grid and stays crisp), and `layoutRects()` shortens a
 *    rect rather than moving it when the next one on the same row would touch — the LEFT
 *    edge is the onset and must never lie, so the gap is always taken out of the tail.
 *
 * 6. THE GUTTER IS A KEYBOARD, NOT A LIST OF OCTAVES.
 *    White and black keys are drawn as keys, and every row is named when the row is tall
 *    enough for legible type. When it is not, the naming thins in three named steps —
 *    every semitone, then the naturals, then the C's, then thinned octaves — because a
 *    legible C2 beats twelve unreadable smudges. C's stay emphasised in every mode: bolder,
 *    brighter, and they keep the hairline that runs across the plot.
 *
 * 7. THE PANE'S HEIGHT BELONGS TO THE PLAYER, AND THE HANDLE OWNS THE BOTTOM 4 PX.
 *    Height was a fixed 96px and the verdict was "useless". It is now dragged from the
 *    handle on the bottom edge, defaults to `DEFAULT_ROLL_HEIGHT_PX`, and is persisted.
 *    `clampRollHeight` is the one place the limits live — never below a readable minimum,
 *    never more than 40% of the window, and never so much of a short window that the sheet
 *    is squeezed out (the plugin has to survive REAPER's 360x280 docked FX window; see
 *    shell/BRIDGE.md §1b). The handle is a real element with its own CSS and it overlaps the
 *    pane's last few pixels, so the pitch grid stops `HANDLE_RESERVE_PX` short of the bottom
 *    and nothing this file draws ends up underneath the thing you are supposed to grab.
 *
 * 8. THE ROLL REPORTS EDITS. IT NEVER PERFORMS THEM.
 *    A drag emits a `RollEdit` in WRITTEN seconds through `onEdit` and stops there. The
 *    integrator edits the performance (`source.detected.notes`), re-runs the pipeline and
 *    calls `refresh()`. That indirection is the reason add / lengthen / shorten are possible
 *    at all — changing an alphaTab beat's duration in place would leave the bar over- or
 *    under-full. While a drag is in flight the roll draws the note where the gesture says it
 *    is, so it feels live; the next `refresh()` replaces the guess with the real thing.
 *
 * 9. MANY NOTES AT ONCE, AND WHO OWNS THE BARE DRAG.
 *    The transcriber octave-doubles runs of notes. Fixing that one rectangle at a time is the
 *    single most tedious thing this app asks of anybody, so the roll carries a real
 *    multi-selection and a gesture on ANY selected note moves the WHOLE selection.
 *
 *    THE MODIFIER RULE, and why. A rubber band and a pan both want to start on empty
 *    background, and only one of them can have the bare drag. The bare drag stays PAN.
 *    Reasons, in order of weight: (a) since v1.2 the roll is a scrolling window onto a sheet
 *    that is usually wider than the pane, so moving around it is the thing a player does
 *    constantly and selecting a run of notes is the thing they do occasionally — the frequent
 *    action gets the cheap gesture; (b) the bare drag ALREADY pans, in shipped code the user
 *    has used, and silently reassigning a gesture somebody has learnt is worse than asking
 *    for a modifier; (c) a mis-fired pan costs a scroll back, a mis-fired band throws away a
 *    selection you spent thirty seconds building. So:
 *
 *      drag background              -> pan (unchanged)
 *      SHIFT + drag background      -> rubber band, REPLACING the selection
 *      SHIFT + CMD + drag           -> rubber band, ADDED to the selection
 *      SHIFT or CMD + click a note  -> toggle that note in or out
 *      CMD + A                      -> everything currently drawn; ESC -> nothing
 *
 *    Discoverability is not left to a manual: the moment Shift goes down with the pointer over
 *    empty plot the cursor becomes a crosshair, the band is drawn while it is dragged, and the
 *    number of notes caught is printed beside it so the player knows what they have BEFORE
 *    they press Delete.
 *
 *    ONE GESTURE IS ONE EDIT. A group drag emits a single `moveMany` / `resizeMany` /
 *    `deleteMany` rather than N single-note edits, because the integrator turns one emitted
 *    edit into one undo step and the player made one gesture — N edits would mean N presses of
 *    ⌘Z to undo one drag. A selection of ONE still emits the old single-note variants, byte
 *    for byte: those are what the integrator has always handled and what the harness drives,
 *    and there is no reason to make the common case take the new path.
 *
 * 10. THE PITCH AXIS IS A WINDOW, NOT A SCALE. (v1.3 — the reported bug.)
 *
 *    Until now the roll found the lowest and the highest note in the WHOLE take and divided
 *    the pane's height across that span. So the picture's legibility was decided by the two
 *    most extreme notes in the recording — and the transcriber's commonest error is a single
 *    octave-doubled note, which on a 210px pane instantly halves every row. The owner's words:
 *    *"it apparently has a fixed maximum size, but it can hold so many notes in that fixed
 *    size... I won't have to see them so vertically short."*
 *
 *    A row is now a FIXED number of pixels (`pxPerSemitone`, default
 *    `DEFAULT_PX_PER_SEMITONE`) and the pane shows whichever rows fit. Two numbers describe the
 *    whole vertical axis and everything else is derived from them:
 *
 *      pxPerSemitone   how tall one semitone is                (the vertical ZOOM)
 *      scrollTopMidi   the fractional pitch at the plot's TOP  (the vertical SCROLL)
 *
 *    `lowMidi` / `highMidi` are no longer stored — they are derived from those two, so the
 *    picture, the gutter, the hit-test and `probe()` cannot disagree about which rows are on
 *    screen. `contentLowMidi` / `contentHighMidi` are the take's own range, and they are only
 *    used to place a fresh view and to answer Fit.
 *
 *    THE GESTURES, and who they had to be taken from:
 *
 *      two fingers up/down      PITCH ZOOM, about the pointer, heavily damped (G15)
 *      two fingers left/right   TIME ZOOM, about the pointer, heavily damped (G15)
 *      Shift + wheel            pan TIME — the mouse's way to the second axis
 *      Alt/Option + wheel       pitch zoom, about the pointer (kept; it was shipped)
 *      Ctrl/Cmd + wheel         pitch zoom — a trackpad PINCH arrives here
 *      middle-button drag       pan BOTH axes
 *      Space + drag             pan BOTH axes       (needs one line in app.ts — see below)
 *      left drag on background  pan TIME, unchanged
 *      the right-hand bar       drag the visible pitch window directly
 *      Alt + ↑ / ↓              vertical zoom from the keyboard, about the SELECTED note
 *      Alt + 0                  Fit
 *
 *    Plain wheel moving TIME is what made the owner think the middle button scrolled the
 *    timeline: `onPointerDown` has always refused every button but the left one, so no
 *    middle-button gesture ever reached this file. What he had was a wheel, or a middle-button
 *    autoscroll the BROWSER was synthesising wheel events for.
 *
 *    BOTH WHEEL AXES ARE ZOOMS NOW (G15). A trackpad has two axes and a DAW spends them on the
 *    two zooms; panning is the drag and the two scrollbars, which is also where a DAW puts it.
 *    Every wheel zoom goes through `wheelZoomFactor`, which is exponential in the delta and
 *    clamped to 6% per event — a trackpad delivers dozens of events per flick and a per-notch
 *    factor multiplied out into the jump this was reported for.
 *
 *    FIT IS A COMMAND, NOT A DEFAULT. `fitVertical()` shows the whole take at once — it is what
 *    the old geometry did on every frame — but it is now something the player asks for, and it
 *    is allowed below the interactive zoom floor (`FIT_FLOOR_PX_PER_SEMITONE`) because "show me
 *    everything" that does not actually show everything is a lie. `fitLocked` keeps it fitted
 *    across a pane resize; any manual scroll or zoom drops the lock.
 *
 *    AUTO-FOLLOW YIELDS TO THE PLAYER. During playback the roll scrolls the sounding note back
 *    into view, the way the sheet already does with its cursor — but never within
 *    `AUTO_FOLLOW_QUIET_MS` of the player's own last vertical gesture. Fighting somebody for
 *    control of the scroll position is worse than not following at all.
 *
 *    THE VIEW HAS TO BE HANDED BACK ACROSS A RE-RENDER. `App.renderMain()` destroys and
 *    rebuilds this object on every state change, so a scroll position kept only in this class
 *    would reset whenever anything at all happened. `getVerticalView()` /
 *    `opts.verticalView` / `opts.onVerticalViewChange` are the seam: the integrator holds the
 *    two numbers and hands them back to the constructor. Without that wiring the roll still
 *    works — it simply re-centres on the notes each time, which is a forgetful view rather than
 *    a broken one.
 */

import type * as alphaTab from '@coderline/alphatab';
import { scoreOriginSec, type RiffScore } from '../pipeline';
import { soundingMidi, type ScoreIndex } from '../score/fromPipeline';
import {
  ALIGN_GUTTER_PX,
  barGrid,
  clampWindow,
  fracToSec,
  fullWindow,
  gridDetail,
  gridMarks,
  isFullWindow,
  medianBeatSec,
  secToFrac,
  subdivisionsPerBeat,
  MIN_WINDOW_SEC,
  TIME_ZOOM_IN_FACTOR,
  TIME_ZOOM_OUT_FACTOR,
  secPerPx,
  PinchAccumulator,
  type BarSpan,
  type GridMark,
  type TimeLimits,
  type TimeWindow,
  type ViewportCommand
} from './timeAxis';

/**
 * The default ruler for a document with no score yet: 4/4 at the app's fallback tempo.
 *
 * `100` and `24` are not new numbers. They are the same fallbacks every other second<->tick
 * conversion in this app uses when a score cannot answer (`60 / (tempoBpm || 100)`, and the IR's
 * doubled `DIVISIONS`), stated here so a blank pane and a loaded one draw the same picture of
 * the same tempo rather than two pictures that happen to look similar.
 */
const BLANK_GRID_BPM = 100;
const BLANK_GRID_BEATS = 4;
const BLANK_GRID_DIVISIONS = 24;
/** A blank pane still shows this much of a ruler even before any take has been measured. */
const BLANK_GRID_MIN_SEC = 8;

/**
 * A plain 4/4 grid covering the take, in `barGrid`'s own output shape.
 *
 * Built THROUGH `barGrid` rather than beside it, so a blank grid and a real one cannot disagree
 * about what a `BarSpan` means or about how the origin is applied.
 */
function blankBarGrid(durationSec: number, originSec: number): BarSpan[] {
  const secPerBar = (60 / BLANK_GRID_BPM) * BLANK_GRID_BEATS;
  const span = Math.max(
    BLANK_GRID_MIN_SEC,
    Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  );
  // One past the end, so the last bar line is drawn rather than the grid stopping mid-bar.
  const count = Math.max(1, Math.ceil(span / secPerBar) + 1);
  const durTicks = BLANK_GRID_DIVISIONS * BLANK_GRID_BEATS;
  const bars = [];
  for (let i = 0; i < count; i++) {
    bars.push({
      index: i,
      number: i + 1,
      implicit: false,
      startTick: i * durTicks,
      durTicks,
      timeSig: [BLANK_GRID_BEATS, 4] as const
    });
  }
  // No `tempoChanges`: this grid is laid down at one constant tempo by construction — there is no
  // score behind it to change tempo — so the scalar branch of `barGrid` is the whole truth here.
  return barGrid({ tempoBpm: BLANK_GRID_BPM, divisions: BLANK_GRID_DIVISIONS, bars }, originSec);
}

export interface PianoRollNote {
  startSec: number;
  endSec: number;
  midi: number;
  /**
   * The pipeline's stable note id — the identity thread selection and editing hang off.
   *
   * Null when the walk could not resolve one (a note the identity map has never seen, which
   * in practice means a renderer that is mid-build). A null id is drawable but not
   * selectable and not editable, which is the right failure: better a rectangle you cannot
   * drag than a drag that edits the wrong note.
   */
  noteId: string | null;
  /**
   * 0..1, and only ever set by `setPerformanceNotes`. Nothing paints it yet.
   *
   * Carried rather than dropped at the door because the caller measured it and this is the
   * record of what was played; a later "loud notes darker" pass reads it from here and needs no
   * second channel from the app to do it.
   */
  velocity?: number;
}

/**
 * ONE NOTE AS IT WAS PLAYED — the input to `setPerformanceNotes`.
 *
 * Times are RECORDING seconds (what the microphone heard), not the written seconds every other
 * note in this file carries. That is the entire point of the mode: a performance roll shows the
 * take, so a note rushed by 40 ms is drawn 40 ms early, which is a thing you cannot see on a
 * roll derived from the engraving because the engraving has already quantized it away.
 *
 * `id` is whatever the caller identifies a note by, and it is the ONLY thing that ties a
 * rectangle back to the caller's world: edits and hovers come back naming it. Numbers are
 * allowed because a detector's note index usually is one; they are stringified once, here, so
 * that everything downstream keeps the single `string` id it already has.
 */
export interface PerformanceNote {
  id: string | number;
  midi: number;
  startSec: number;
  endSec: number;
  /** 0..1 if known. Optional, and currently carried rather than drawn — see `PianoRollNote`. */
  velocity?: number;
}

/**
 * The live sheet: the alphaTab object graph on screen, plus the identity map that says what
 * each note's sounding pitch is. This is what edits mutate.
 */
export interface PianoRollLiveModel {
  model: alphaTab.model.Score;
  index: ScoreIndex;
}

/**
 * ALIGN's shared ruler: a moment in the RECORDING, and where the sheet puts it.
 *
 * `frac` is a fraction of the PLOT (0 at the first pixel after the gutter, 1 at the right
 * edge), not a pixel, so the roll, the strip and the sheet can be different widths and still
 * agree about where a beat is.
 *
 * A LIST rather than a pair of edges because alphaTab's spacing is deliberately not
 * proportional to time — a rhythmically dense bar gets more pixels than a sparse one — so two
 * edges and a straight line between them put a note up to a fifth of the pane away from its own
 * notehead. One anchor per BEAT brings the two into the same column: the ruler agrees exactly on
 * every beat and interpolates linearly in between, which is a distance of one beat rather than
 * one screen.
 *
 * The roll is still linear in time BETWEEN anchors, and the anchors are still times, so nothing
 * here can re-space itself when a note is edited: see `setTimeAnchors`.
 */
export interface TimeAnchor {
  sec: number;
  frac: number;
}

/**
 * A time window written as the pair of anchors the WAVEFORM already understands.
 *
 * The waveform strip (`ui/waveform.ts`) has taken `setTimeAnchors` since Align was built and it
 * draws linearly between them, which is precisely a window. So the roll and the strip share a
 * time axis by the integrator forwarding ONE value through this one function — no second
 * implementation of the mapping, and nothing for the two files to disagree about.
 *
 *     roll.onTimeWindowChange = (win) => waveform.setTimeAnchors(timeWindowAnchors(win));
 */
export function timeWindowAnchors(win: TimeWindow | null): TimeAnchor[] | null {
  if (!win || !(win.toSec > win.fromSec)) return null;
  return [
    { sec: win.fromSec, frac: 0 },
    { sec: win.toSec, frac: 1 }
  ];
}

/**
 * The inverse: the window an anchor list describes, read off its two ends.
 *
 * Any monotone anchor list has a first and a last, and what the plot SHOWS is whatever lands at
 * fraction 0 and fraction 1 — so a list of any length collapses to the window it implies. For
 * the two-anchor lists `ui/app.ts` has always sent, this is the identity.
 */
export function windowFromAnchors(anchors: ReadonlyArray<TimeAnchor> | null | undefined): TimeWindow | null {
  const clean = (anchors ?? [])
    .filter((a) => Number.isFinite(a.sec) && Number.isFinite(a.frac))
    .sort((a, b) => a.frac - b.frac);
  if (clean.length < 2) return null;
  const first = clean[0];
  const last = clean[clean.length - 1];
  const fracSpan = last.frac - first.frac;
  if (!(fracSpan > 0)) return null;
  const perFrac = (last.sec - first.sec) / fracSpan;
  if (!(perFrac > 0)) return null;
  const fromSec = first.sec + (0 - first.frac) * perFrac;
  const toSec = first.sec + (1 - first.frac) * perFrac;
  return toSec > fromSec ? { fromSec, toSec } : null;
}

/**
 * The visible DAW-style edit grid. It controls drawing and every time edit.
 *
 * 'off' is a DRAWING answer, not a snapping one: BAR LINES ONLY, nothing between them. A roll
 * whose every beat and half-beat is ruled is unreadable at riff density, and the player asking
 * for the ruler to get out of the way still wants to know where bar 5 starts. It snaps like
 * 'free' — there is no unit it could round to.
 */
export type PianoRollEditGrid =
  | 'off'
  | 'quarter'
  | 'eighth'
  | 'sixteenth'
  | 'thirtysecond'
  | 'triplet'
  | 'free';

/**
 * The sheet's own engraving, injected rather than imported.
 *
 * `view/triview.ts` owns the geometry and this file owns the picture; neither imports the
 * other, so the roll works in the harness, in the browser mock and before anything has been
 * engraved, and the tri-view has no idea a roll exists. Every method may return null — "I
 * cannot answer that yet" is a normal state, not an error, and the roll simply falls back to
 * its free axis for that frame.
 */
export interface SheetMap {
  /** WRITTEN score seconds -> sheet content x (unscrolled px). Null when unresolvable. */
  writtenSecToContentX(sec: number): number | null;
  /** The inverse. Null when unresolvable. */
  contentXToWrittenSec(x: number): number | null;
  scrollLeft: number;
  viewportWidth: number;
  contentWidth: number;
}

/**
 * What a gesture on the roll ASKS FOR. All times are WRITTEN score seconds.
 *
 * The roll never applies one of these to anything. See invariant 8.
 *
 * The `*Many` variants are ONE edit, not a batch the integrator is invited to unpack into
 * several: one gesture must cost one ⌘Z. They only ever appear when two or more notes are
 * selected — a selection of one still emits `move` / `resize` / `delete`, unchanged (see
 * invariant 9), so an integrator that has not yet learnt the new variants still gets a
 * completely working single-note roll rather than a broken one.
 *
 * `resizeMany` carries a DELTA and not a length because the selected notes do not all have
 * the same length: dragging one right edge out by an eighth should lengthen every selected
 * note by an eighth, not flatten a run of mixed durations into one duration.
 */
export type RollEdit =
  | { kind: 'move'; noteId: string; deltaSec: number; deltaSemitones: number }
  | { kind: 'resize'; noteId: string; newDurationSec: number }
  | { kind: 'add'; midi: number; startSec: number; durationSec: number }
  | { kind: 'delete'; noteId: string }
  | { kind: 'moveMany'; noteIds: string[]; deltaSec: number; deltaSemitones: number }
  | { kind: 'resizeMany'; noteIds: string[]; deltaSec: number }
  | { kind: 'deleteMany'; noteIds: string[] };

/** The ids an edit names, whichever variant it is. Handy for a caller that just needs the set. */
export function rollEditNoteIds(edit: RollEdit): string[] {
  switch (edit.kind) {
    case 'move':
    case 'resize':
    case 'delete':
      return [edit.noteId];
    case 'moveMany':
    case 'resizeMany':
    case 'deleteMany':
      return [...edit.noteIds];
    default:
      return [];
  }
}

/**
 * The whole of the vertical axis, in two numbers and a flag. See invariant 10.
 *
 * Small and serialisable on purpose: this is what the integrator holds across a `renderMain()`
 * and, if it likes, writes into the settings file so the zoom survives a reload.
 */
export interface RollVerticalView {
  /** How tall one semitone is, in px. The vertical zoom. */
  pxPerSemitone: number;
  /** The fractional MIDI pitch at the TOP edge of the plot. The vertical scroll. */
  scrollTopMidi: number;
  /** The player pressed Fit and has not moved since, so a pane resize should re-fit. */
  fitLocked: boolean;
}

export interface PianoRollOptions {
  canvas: HTMLCanvasElement;
  /** Click anywhere on the roll (not the gutter) to jump there. */
  onSeek: (sec: number) => void;
  /** The pane the canvas lives in — the element the drag handle resizes. */
  pane?: HTMLElement;
  /** The grab handle on the pane's bottom edge. */
  handle?: HTMLElement;
  /** The remembered height. Clamped to the window before it is applied. */
  height?: number;
  /** Fired while dragging and once on release; persist on `commit`. */
  onHeightChange?: (px: number, commit: boolean) => void;

  // --- the pitch axis (invariant 10) ----------------------------------------
  /**
   * The vertical scroll and zoom to open with — what `getVerticalView()` last returned.
   *
   * Absent means "place it yourself", which centres the pane on the busiest part of the riff
   * at `DEFAULT_PX_PER_SEMITONE`. Pass the saved view back on a re-render, and pass nothing
   * when a genuinely new take has been opened.
   */
  verticalView?: RollVerticalView | null;
  /**
   * The pitch window moved. `commit` marks the end of a gesture, the same as `onHeightChange`.
   *
   * Fired for wheel, drag, scrollbar, zoom and Fit alike. Keep the value in memory on every
   * call (that is what survives a `renderMain()`); write it to disk on `commit` only.
   */
  onVerticalViewChange?: (view: RollVerticalView, commit: boolean) => void;

  // --- the time axis (#29 / #30) ---------------------------------------------
  /**
   * THE ROLL ASKS; IT DOES NOT DECIDE. One command per gesture, to the app's one reducer.
   *
   * THREE OPTIONS STOOD HERE AND ARE GONE: `onScrollRequest`, `onZoomRequest` and
   * `onResetView` (finding 14). `ui/app.ts` supplied none of them, `resetView()` fired two of
   * them into nothing, and a comment in app.ts claimed roll scrolling was routed through
   * `onScrollRequest` while this file's own comments admitted it had never been wired. A fourth,
   * `onTimeWindowChange`, has gone with them and is the important one: it published every window
   * the roll APPLIED, including the ones the app had just pushed in, so a sheet scroll came back
   * 250 ms later looking exactly like a roll zoom (finding 2). Programmatic setters are silent
   * now — see `setViewport` — and there is nothing left to mistake for a gesture.
   *
   * Wire this and the roll's wheel, pinch, drag-pan and zoom buttons become commands the app
   * reduces against ONE authoritative viewport, which it then hands back through `setViewport`.
   * The round trip is synchronous, so the picture still moves inside the same event.
   */
  onViewportCommand?: (cmd: ViewportCommand) => void;

  /**
   * The pointer moved onto a note, or off one (`null`).
   *
   * Cross-highlight (#30d): the integrator forwards this to `TriView.setHover`, so pointing at a
   * rectangle rings the notehead that made it. Coalesced to one report per changed note, not one
   * per pointermove.
   */
  onNoteHover?: (noteId: string | null) => void;

  // --- selection (invariant 4) ----------------------------------------------
  /**
   * A note was clicked, or empty space was (`null`).
   *
   * `rect` is in VIEWPORT coordinates — the canvas's own offset is already added — so a
   * popover can be positioned from it without knowing where the roll lives.
   */
  onNoteSelect?: (noteId: string | null, rect: { x: number; y: number; w: number; h: number }) => void;

  /**
   * The WHOLE selection changed, however it changed. Fires on plain clicks too.
   *
   * `onNoteSelect` above answers "which one note did the player just point at", which is what
   * a popover or a scroll-into-view needs and what it has always been used for. It cannot
   * describe a rubber band over seven notes, so rather than overload it — and break every
   * caller that reads its first argument as "the note" — this is a second, additive callback
   * carrying the full set. An integrator that wires only the old one keeps exactly the old
   * behaviour; one that wires both can light all seven notes up on the staff.
   *
   * Never fired by `setSelection()`: that is the integrator telling the roll, and echoing it
   * straight back is how a two-view selection ends up in a loop.
   */
  onSelectionChange?: (noteIds: string[]) => void;

  // --- editing (invariant 8) ------------------------------------------------
  /** A gesture finished and is asking for a change. Absent = the roll stays read-only. */
  onEdit?: (edit: RollEdit) => void;
  /** The same edit while the gesture is still running, and `null` when it ends. Optional. */
  onEditPreview?: (edit: RollEdit | null) => void;
  /** Visible/editable time unit. Unlike the transcription quantizer, this never reflows time. */
  editGrid?: PianoRollEditGrid;
}

/**
 * The label column on the left of BOTH timeline strips, in px.
 *
 * Exported because `ui/waveform.ts` reserves the identical column — see invariant 1 — and
 * because alphaTab is given a matching left padding, so at scroll 0 nothing is engraved
 * underneath it either.
 *
 * Defined as `ALIGN_GUTTER_PX` rather than as a second 34: Align's arithmetic in `timeAxis.ts`
 * takes this column off both viewports before it compares them, so the two numbers are not
 * merely equal, they are the same fact. `timeAxis.ts` is pure and must not import this file,
 * hence the dependency runs this way round.
 */
export const TIMELINE_GUTTER_PX = ALIGN_GUTTER_PX;

/**
 * What a fresh install gets.
 *
 * 96px was the first complaint ("too small, I can't see the note names"); 150 answered that
 * one and left a second: at 150 a two-octave riff gives about 6.6px per semitone, which is
 * under the 8px type the gutter draws, so the column had to fall back to naming the C's only —
 * which is the thing the player asked to stop happening. 210 puts a whole riff's worth of rows
 * over 9px each, so every name fits at first open. `clampRollHeight` still gives it back to
 * the sheet in a short window, and the height the player drags is what gets remembered.
 */
export const DEFAULT_ROLL_HEIGHT_PX = 210;
/** Below this the roll stops being readable, so the drag stops here. */
export const MIN_ROLL_HEIGHT_PX = 60;
/** The share of the window the roll may take at most. */
const MAX_ROLL_FRACTION = 0.4;
/**
 * Room kept for the sheet, the transport and the header before the 40% rule applies.
 *
 * Without it a 280px-tall plugin window (REAPER's smallest docked FX window, BRIDGE.md §1b)
 * would still hand the roll 112px and leave the sheet a sliver. Below this the roll gives up
 * its minimum and shrinks to a hint of itself instead — which is what the stylesheet used to
 * do with a media query, and is now here because the height is an inline style and a media
 * query cannot outrank one.
 */
const SHEET_RESERVE_PX = 320;
/** The floor the reserve is allowed to push the roll down to. */
const CRAMPED_ROLL_HEIGHT_PX = 46;

/**
 * The strip along the bottom the resize handle covers.
 *
 * `.pianoroll-resize` is 7px tall and hangs 3px below the pane, so it sits on top of the
 * canvas's last 4 pixels. The pitch grid stops short of them: a note or a pitch name drawn
 * there is a thing the player can see and cannot click. See invariant 7.
 */
const HANDLE_RESERVE_PX = 4;

/**
 * The TIME RULER along the top of the plot, in px. The horizontal twin of the gutter.
 *
 * It exists for two reasons and both are about the gesture, not the decoration. A wheel over a
 * RULER meaning "zoom that axis" is the convention every DAW already taught the player, and the
 * roll had only one ruler — the gutter — so only one axis could be zoomed that way. And the bar
 * numbers have to live somewhere that is not on top of the notes: printed into the plot they
 * are either behind a rectangle or in front of one, and both look like a mistake.
 *
 * The plot is offset down by exactly this much and everything below `draw()` still works in
 * plot coordinates, so the pitch axis, the hit test and the harness's `firstNoteY` are all
 * unchanged in their own frame of reference. See the `ctx.translate` in `draw()`.
 */
const RULER_H_PX = 15;
/**
 * A pane shorter than this gives the ruler back to the music.
 *
 * At REAPER's floor the roll is 46px tall (`CRAMPED_ROLL_HEIGHT_PX`); spending a third of that
 * on bar numbers would leave three rows of notes. The grid lines still run the full height, so
 * the bars are still visible — what goes is the numbered band and, with it, the wheel-to-zoom
 * target, which is why the buttons exist and are not merely a convenience.
 */
const RULER_MIN_PANE_PX = 96;

/** Semitones of headroom kept above and below the notes actually present. */
const PITCH_PADDING = 1;
/** Never zoom in further than this many semitones, or two notes fill the whole pane. */
const MIN_PITCH_SPAN = 11;

/**
 * How tall one semitone is when nobody has said otherwise. THE number this rewrite is about.
 *
 * Three things pin it down, and 12 is the only value that satisfies all three:
 *
 *   - The gutter draws a pitch NAME on every row it can. Its type is
 *     `clamp(MIN_LABEL_PX, MAX_LABEL_PX, rowH * 0.8)` and two labels need `type + 1.5px` of
 *     leading between them, so naming every row needs a row of about 11px or more. At 12 the
 *     type comes out at 10px and `labelMode` is `'all'` — every row named, which is exactly
 *     what the player asked for when 96px was "too small to read the note names".
 *   - At `DEFAULT_ROLL_HEIGHT_PX` (210) that is about 17 rows on screen: an octave and a fifth,
 *     which covers a bass riff's working range without scrolling and still leaves the octave
 *     doubling that caused the complaint somewhere to scroll TO rather than something that
 *     flattens the picture.
 *   - The move gesture only commits to a semitone after 0.6 of a row (the wobble deadzone), so
 *     a row taller than about 23px would make the harness's 14px synthetic drag transpose
 *     nothing. 12 leaves that with more than a row of margin.
 */
export const DEFAULT_PX_PER_SEMITONE = 12;
/**
 * The interactive zoom limits.
 *
 * 4px is where a rectangle (2px of note plus its gap) stops being a rectangle; below it the
 * picture is the squashed one this rewrite exists to get rid of, so a wheel will not take you
 * there. 44px is a little over three rows to the pane at the default height — past that you are
 * looking at one note, and the sheet is the better view of one note.
 */
const MIN_PX_PER_SEMITONE = 4;
const MAX_PX_PER_SEMITONE = 44;
/**
 * Fit alone may go below the interactive floor.
 *
 * "Show me everything" that quietly stops short of everything is worse than no button at all,
 * and a 60-semitone take in REAPER's 46px pane genuinely needs 0.7px a row. Only `fitVertical()`
 * can reach down here; a wheel still stops at `MIN_PX_PER_SEMITONE`.
 */
const FIT_FLOOR_PX_PER_SEMITONE = 0.5;
/** One notch of Alt+wheel, and one press of the zoom buttons. Multiplicative, so it undoes. */
const VZOOM_IN_FACTOR = 1.15;
const VZOOM_OUT_FACTOR = 1 / 1.15;

/**
 * TRACKPAD ZOOM, DAMPED (G15). How much zoom one pixel of two-finger travel is worth.
 *
 * The discrete factors above are one NOTCH of a mouse wheel — one deliberate act, one visible
 * step. A trackpad is not that: a single lazy two-finger flick delivers dozens of wheel events,
 * and answering each of them with a 15% or 25% step multiplies out to an enormous jump. The
 * reported symptom was exactly that, "it goes drastic".
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

// `OWN_ZOOM_ECHO_MS` stood here (700 ms) and is gone with `holdSpan` and `adoptNextAlignSpan`.
// It was a clock trying to answer "was this window my own zoom coming back?", which is a question
// about ORIGIN that a duration cannot answer: every `source === 'user'` request armed it,
// including a plain horizontal pan, so for 700 ms after any pan the roll would accept whatever
// span the sheet's engraving happened to produce and a pan became a zoom (finding 4). Commands
// carry their own typed source now, and programmatic setters are silent, so there is no echo.
//
// How long a pinch and its dedupe partner are treated as one gesture. WebKit emits BOTH a
// ctrl-wheel and a legacy `gesturechange` for a single trackpad pinch on some builds, and both
// used to be applied — one pinch, zoomed twice (finding 12). Whichever arrives first wins the
// gesture and the other road is ignored until this has elapsed with nothing on it.
const PINCH_DEDUPE_MS = 250;

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
/** The whole keyboard, in the pitch coordinate the scroll is expressed in. */
const MIDI_TOP = 128;

/**
 * How long the roll leaves the pitch window alone after the player has touched it.
 *
 * Auto-follow and a human reaching for the same scrollbar is the worst interaction in any
 * editor: you drag somewhere, the machine drags it back, and you cannot tell whether the app is
 * broken or you are. Three seconds is long enough to look at what you scrolled to and short
 * enough that following resumes without a ceremony.
 */
const AUTO_FOLLOW_QUIET_MS = 3000;
/** Rows of clear space auto-follow leaves around the note it is chasing, so it is not on the edge. */
const AUTO_FOLLOW_MARGIN_ROWS = 1.5;

/**
 * The vertical scrollbar down the right-hand edge of the plot.
 *
 * It is drawn on the canvas rather than being a real element because the plot is a canvas and a
 * DOM scrollbar would need a second, parallel geometry to stay in step with. It exists mostly to
 * be SEEN: "I wanna be able to scroll up and down" is a thing a player has to be told is
 * possible, and a bar on the edge tells them without a tooltip.
 */
const VBAR_W_PX = 8;
/** A thumb shorter than this cannot be grabbed, however little of the range is on screen. */
const VBAR_MIN_THUMB_PX = 18;
/** The strip that counts as "on the bar" for a press. Slightly wider than it is drawn. */
const VBAR_GRAB_PX = 12;
/** How long after a view change the roll waits before calling the change committed. */
const VIEW_COMMIT_MS = 250;

/** alphaTab's internal ticks per quarter note (MidiUtils.QuarterTime). */
const ALPHATAB_QUARTER_TICKS = 960;

/** Clear space kept between two rects that abut, so their outlines never merge. */
const NOTE_GAP_PX = 2;
/** A rect narrower than this is not a rectangle any more, it is a tick mark. */
const MIN_NOTE_W_PX = 2;
/** How close to a rect's right edge counts as "grab the edge" rather than "grab the note". */
const RESIZE_GRIP_PX = 6;
/** Pointer travel that turns a press into a drag rather than a click. */
const DRAG_SLOP_PX = 3;
/**
 * A band smaller than this in BOTH axes is a click that wobbled, not a selection.
 *
 * Without it, Shift+click on background — which a player will do by accident while reaching
 * for the modifier — sweeps a 1px box, catches whatever rectangle happens to be under the
 * pointer, and looks like the roll selected something at random.
 */
const BAND_MIN_PX = 4;
/**
 * The shortest note a group resize will draw, in seconds.
 *
 * Only the PREVIEW: the integrator has the real floor (it refuses anything the pipeline's
 * guards would delete as an artefact). This exists so shrinking a selection whose shortest
 * note is a 32nd does not draw negative-width rectangles on the way past zero.
 */
const MIN_PREVIEW_DUR_SEC = 0.03;
// ZOOM_IN_FACTOR / ZOOM_OUT_FACTOR stood here: the per-notch factors for the SHEET's zoom,
// which the roll used to forward a ctrl-wheel to through `onZoomRequest`. That branch is gone —
// a pinch over the roll now zooms the roll, which is the pane under the pointer. The roll's own
// factors are VZOOM_IN_FACTOR / VZOOM_OUT_FACTOR, below.
/** The smallest type that is still a pitch name rather than a smudge. */
const MIN_LABEL_PX = 8;
const MAX_LABEL_PX = 11;

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const NOTE_LETTERS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** How thoroughly the gutter is naming rows this frame. Reported by `probe()`. */
export type RollLabelMode = 'all' | 'naturals' | 'c-only' | 'octaves' | 'edges' | 'none';

/**
 * The height the pane may actually be, given what it was asked for and how tall the window is.
 *
 * The caller keeps the number the player chose; this returns what fits. Growing the window
 * back therefore restores the chosen height rather than leaving it stuck where a small window
 * pinned it.
 */
/**
 * Room taken by panes that come and go, on top of the fixed reserve.
 *
 * The tuner is the first of these: it appears only while a stretch of the recording is selected,
 * and it is a real horizontal band with height. Without telling the clamp about it, the roll goes
 * on claiming its full share of a window that has quietly got smaller, and the sheet is the one
 * that pays — which is the exact failure `SHEET_RESERVE_PX` exists to prevent, arriving through a
 * door it did not know about. The harness caught it the first time the tuner and a wound-out roll
 * were on screen together.
 *
 * Set by whoever puts such a pane up. Module-level rather than a constructor argument because
 * `clampRollHeight` is a free function three other files call.
 */
let transientReservePx = 0;

export function setTransientReserve(px: number): void {
  transientReservePx = Math.max(0, Math.round(px));
}

export function clampRollHeight(px: number, viewportH: number = window.innerHeight || 700): number {
  // The transient pane comes off the window FIRST, before either limit is worked out. Taking it
  // off only the fixed reserve was not enough: at 813px the 40% rule caps the roll at 325 and
  // the reserve allows 363, so the fraction binds and the roll never noticed the tuner had
  // taken 130px out of the sheet. Both limits have to be measured against the space that is
  // actually left.
  const usableH = Math.max(200, viewportH - transientReservePx);
  const max = Math.max(
    CRAMPED_ROLL_HEIGHT_PX,
    Math.min(Math.round(usableH * MAX_ROLL_FRACTION), usableH - SHEET_RESERVE_PX)
  );
  const min = Math.min(MIN_ROLL_HEIGHT_PX, max);
  const wanted = Number.isFinite(px) ? px : DEFAULT_ROLL_HEIGHT_PX;
  return Math.round(Math.max(min, Math.min(max, wanted)));
}

/**
 * The IR's notes as time/pitch rectangles, in WRITTEN seconds.
 *
 * The build-time picture. Used before the sheet exists, and kept as the cross-check the
 * live-model walk is measured against — see invariant 2.
 *
 * Ties are merged: a tied-over note is one held rect, not two abutting ones, because that is
 * what the ear hears and what the exported MIDI contains. The merged rect keeps the id of
 * the note that STARTED the tie, which is the note an edit has to name.
 */
export function pianoRollNotes(score: RiffScore): PianoRollNote[] {
  const secPerTick = secPerTickOf(score, score.ir.divisions || 12);
  const out: PianoRollNote[] = [];
  const open = new Map<number, PianoRollNote>();

  for (const bar of score.ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest) continue;
        const startSec = (bar.startTick + beat.startTick) * secPerTick;
        const endSec = startSec + beat.durTicks * secPerTick;
        for (const note of beat.notes) {
          hold(out, open, note.midi, startSec, endSec, note.tieStop, note.tieStart, note.id ?? null);
        }
      }
    }
  }
  return sortByStart(out);
}

/**
 * The same rectangles, read off the LIVE sheet instead.
 *
 * Same written clock — alphaTab counts 960 ticks to the quarter where the IR counts
 * `divisions`, and both are exact for every duration we print, so the two agree to the
 * floating-point noise. That agreement is asserted rather than assumed; see `irDeltaSec`.
 *
 * Pitch AND identity come from the index `score/fromPipeline.ts` built while constructing the
 * model — which is the entire reason this walk exists. `soundingMidi` reads the same map an
 * edit keeps in step, and the id next to it is what `setSelection` matches on.
 */
export function pianoRollNotesFromModel(score: RiffScore, live: PianoRollLiveModel): PianoRollNote[] {
  const secPerTick = secPerTickOf(score, ALPHATAB_QUARTER_TICKS);
  const out: PianoRollNote[] = [];
  const open = new Map<number, PianoRollNote>();

  for (const track of live.model.tracks) {
    for (const staff of track.staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            if (beat.isEmpty || beat.notes.length === 0) continue;
            const startSec = beat.absolutePlaybackStart * secPerTick;
            const endSec = startSec + beat.playbackDuration * secPerTick;
            for (const note of beat.notes) {
              const midi = soundingMidi(live.index, note);
              const id = live.index.noteToInfo.get(note)?.id ?? null;
              hold(out, open, midi, startSec, endSec, note.isTieDestination, note.isTieOrigin, id);
            }
          }
        }
      }
    }
  }
  return sortByStart(out);
}

/** One rect as it was actually painted. Hit-testing reads this, so it cannot drift from draw(). */
interface RollRect {
  note: PianoRollNote;
  /** The pitch DRAWN — which is the provisional one while a move drag is in flight. */
  midi: number;
  startSec: number;
  endSec: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The edges of a selection, so a group edit can stop at them AS A GROUP. See `groupStats`. */
interface GroupLimits {
  minStartSec: number;
  maxEndSec: number;
  minMidi: number;
  maxMidi: number;
  minDurationSec: number;
}

/**
 * A gesture in flight. Exactly one at a time; there is one pointer.
 *
 * `move` and `resize` carry the whole GROUP they are acting on — the grabbed note plus every
 * other selected note — because a group drag is one gesture with one delta, not several
 * gestures that happen to be simultaneous. `ids` is the ordered list (what gets emitted) and
 * `idSet` the same thing for the per-note lookup `provisional()` does on every rectangle of
 * every frame.
 */
type Gesture =
  | {
      kind: 'pan';
      pointerId: number;
      startX: number;
      startY: number;
      startScroll: number;
      /** The first second on screen when the drag began — what a time pan moves relative to. */
      startFromSec: number;
      /** Seconds per pixel when the drag began, frozen so a redraw cannot change the gearing. */
      startSecPerPx: number;
      /** The pitch at the top of the plot when the drag began. */
      startTopMidi: number;
      /**
       * Does this pan move the PITCH axis as well as the time axis?
       *
       * False for the bare left-drag on background, which has panned time since v1.2 and also
       * seeks on the way down — giving that one a vertical component would mean every click
       * that wobbled scrolled the pitch window. True for the middle button and for Space+drag,
       * which are unambiguous "move the picture" gestures and do not seek.
       */
      vertical: boolean;
      moved: boolean;
    }
  | {
      kind: 'vscroll';
      pointerId: number;
      startY: number;
      startTopMidi: number;
      /** Semitones per pixel of thumb travel, measured once when the drag began. */
      midiPerPx: number;
      /**
       * The travel the BAR represents, frozen at the press.
       *
       * The bar's range is the union of the take and what is on screen, so scrolling out past
       * the notes would grow it — and a track that grows under a thumb somebody is holding
       * makes the thumb slide away from the pointer. The wheel may still roam the keyboard;
       * the bar covers the music.
       */
      minTop: number;
      maxTop: number;
      moved: boolean;
    }
  | {
      kind: 'move';
      pointerId: number;
      /** The note actually grabbed. Its onset is what the snap is computed against. */
      note: PianoRollNote;
      noteId: string;
      ids: string[];
      idSet: Set<string>;
      startX: number;
      startY: number;
      deltaSec: number;
      deltaSemitones: number;
      moved: boolean;
    }
  | {
      kind: 'resize';
      pointerId: number;
      note: PianoRollNote;
      noteId: string;
      ids: string[];
      idSet: Set<string>;
      startX: number;
      /** The grabbed note's length when the drag began. `+ deltaSec` is where it is now. */
      baseDurationSec: number;
      deltaSec: number;
      moved: boolean;
    }
  | {
      kind: 'band';
      pointerId: number;
      startX: number;
      startY: number;
      /** Where the pointer is now, in canvas coordinates. The band is the box between them. */
      x: number;
      y: number;
      /** Cmd was held as well: the band adds to what was already selected. */
      additive: boolean;
      /** The selection the band started from. Re-applied on every move, so a band can shrink. */
      base: string[];
      moved: boolean;
    };

export class PianoRoll {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private opts: PianoRollOptions;
  private pane: HTMLElement | null;
  private handle: HTMLElement | null;

  private notes: PianoRollNote[] = [];
  /**
   * The bars, on the RECORDING clock, with their beats. The grid and the ruler's only source.
   *
   * Was `barLinesSec`, a list of written seconds. It carries the beats and the printed bar
   * number as well now, because the ruler has to name a bar and the grid has to draw inside one,
   * and rebuilding either from a bare list of line positions means re-deriving a bar length that
   * `barGrid()` already knows exactly. Rebuilt whenever the score or the origin changes.
   */
  private bars: BarSpan[] = [];
  private durationSec = 0;
  private positionSec = 0;

  // --- the pitch axis (invariant 10) ----------------------------------------
  /** How tall one semitone is, in px. The vertical zoom. */
  private pxPerSemitone = DEFAULT_PX_PER_SEMITONE;
  /** The fractional MIDI pitch at the TOP edge of the plot. The vertical scroll. */
  private scrollTopMidi = 52;
  /** The take's own range, padded — what Fit fits and where a fresh view is placed. */
  private contentLowMidi = 40;
  private contentHighMidi = 52;
  /** The same range unpadded, so "is everything on screen" is answered about real notes. */
  private noteLowMidi: number | null = null;
  private noteHighMidi: number | null = null;
  /** The middle of the busy part of the riff. A fresh view opens here, not on the mid-range. */
  private contentMedianMidi = 46;
  /** Fit is sticky across a pane resize until the player moves. See invariant 10. */
  private fitLocked = false;
  /** Has this instance decided where to look yet? Placement happens once, lazily, after layout. */
  private viewPlaced = false;
  /** `performance.now()` of the player's last vertical gesture. Auto-follow yields to it. */
  private lastUserVerticalMs = -Infinity;
  /** Scroll the sounding note back into view during playback. */
  private followPlayback = true;
  /** Space is held. Only ARMS a pan — see `wantsSpace()` for why it cannot simply take the key. */
  private spaceDown = false;
  /** The scrollbar as last painted, for hit-testing. Null when there is nothing to scroll. */
  private vbar: {
    x: number;
    w: number;
    thumbY: number;
    thumbH: number;
    trackH: number;
    /** The pitch range the whole track stands for: the take, plus wherever the view has roamed. */
    lo: number;
    hi: number;
    span: number;
  } | null = null;
  /** Trailing "the gesture has stopped" timer for `onVerticalViewChange`. */
  private viewCommitTimer: number | null = null;

  /** Where the user says bar 1 begins, in recording seconds. */
  private barOneSec = 0;
  /** Kept only to derive the origin and the tick->second mapping from. */
  private score: RiffScore | null = null;
  private live: PianoRollLiveModel | null = null;
  /**
   * The performed take, when the app has one. Null = derive the rectangles from the score.
   *
   * Held in the caller's RECORDING seconds rather than converted once, because the conversion
   * subtracts `originSec` and the origin moves — dragging the bar-1 marker on the waveform is a
   * statement about where the SCORE starts, not about when anything was played. Converting on
   * every rebuild keeps that from silently rewriting the performance.
   */
  private performance: PerformanceNote[] | null = null;
  private source: 'model' | 'ir' | 'performance' = 'ir';
  /** Worst disagreement between the two walks at load, in seconds. Null = not comparable. */
  private irDeltaSec: number | null = null;
  private irNotes = 0;
  /** What the player asked for, before the window had its say. */
  private wantedHeight = DEFAULT_ROLL_HEIGHT_PX;
  private appliedHeight = DEFAULT_ROLL_HEIGHT_PX;
  private resizing = false;
  /** Tears down the height drag's window listeners. Held so `destroy()` can too. */
  private detachHeightDrag: (() => void) | null = null;
  private labelsDrawn: string[] = [];
  private labelMode: RollLabelMode = 'none';

  /** Name every row, not just the C's. The integrator drives this from settings. */
  private showAllNames = true;
  /** Drag-to-edit. Also needs an `onEdit` to report to; see `editingOn`. */
  private editableOn = true;
  /** One grid for paint, add, move, resize and keyboard nudge. */
  private editGrid: PianoRollEditGrid = 'eighth';
  private selection = new Set<string>();
  /** Notes the auto-edit pass CHANGED and that are still waiting to be reviewed. */
  private autoMarks = new Set<string>();
  /** How many of those got their halo painted this frame. `probe()` reports it. */
  private autoMarksDrawn = 0;
  private gesture: Gesture | null = null;
  /**
   * THE TIME AXIS. The stretch of RECORDING on screen; null = the whole take, evenly.
   *
   * Was `anchors`, a list of (second, fraction) pairs Align lent the roll. It is a plain window
   * now, for two reasons. The roll has a time ZOOM of its own (#29) and the thing a zoom moves
   * has to be the roll's own state, not something borrowed. And a window of two edges with a
   * straight line between them is what an anchor list of two entries already WAS — app.ts has
   * only ever sent two — so nothing about the picture changes and one whole interpolation
   * disappears. See `setTimeWindow` and view/timeAxis.ts.
   */
  private timeWindow: TimeWindow | null = null;
  /** A window that arrived from the app mid-gesture, waiting for the pointer to come up. Boxed so
   *  that a deferred `null` (the whole take) differs from "nothing arrived". */
  private deferredWindow: { value: TimeWindow | null } | null = null;
  /** Sub-threshold pinch ratios, kept rather than dropped. See `timeAxis.PinchAccumulator`. */
  private pinch = new PinchAccumulator();
  /** When the last pinch reached the reducer, and which road it came in on. `PINCH_DEDUPE_MS`. */
  private lastPinchMs = 0;
  private pinchRoad: 'wheel' | 'gesture' | null = null;
  /** The note the pointer is over, for the sheet to ring. Null when it is over nothing. */
  private hoverNoteId: string | null = null;
  /** Notes the SHEET says the pointer is over. Drawn like a light selection — see `setHover`. */
  private hovered = new Set<string>();
  /**
   * The edit just emitted, still drawn where the gesture left it.
   *
   * Cleared by the next `refresh()`. Without it the rect snaps back to its old place for the
   * frame between letting go and the pipeline finishing, which reads as "the drag did
   * nothing" — the one thing a direct-manipulation gesture must never look like.
   */
  private pending: RollEdit | null = null;
  /** `pending`'s ids, pre-set. `provisional()` asks this once per rectangle per frame. */
  private pendingIds = new Set<string>();
  /** What the last frame actually painted. Hit-testing and `probe()` read this. */
  private rects: RollRect[] = [];
  private outlinedRects = 0;

  /**
   * Where the pointer is over the canvas, and whether it is over it at all.
   *
   * Kept because the cursor has to be able to change when NOTHING moves — the player holds
   * Shift with the mouse still, and the crosshair has to appear then, not on the next
   * pointermove. A key event carries no coordinates, so these are the coordinates it uses.
   */
  private hoverX = -1;
  private hoverY = -1;
  private hovering = false;
  /** Shift, the band modifier. Tracked rather than read, for the reason directly above. */
  private bandModifier = false;

  private colors = {
    bg: '#1e2128',
    gutter: '#16181d',
    row: '#191c22',
    line: '#2e3340',
    note: '#6b7695',
    /**
     * The "sounding right now" accent. Same token the waveform's played region uses.
     *
     * PURPLE, not the old orange (G20). Every canvas-drawn accent in the app is one family now
     * — the app's accent is #8b5cf6 and its lighter partner #a78bfa — so a highlight on the
     * roll, a ring on the sheet and a played region on the strip read as one system rather than
     * as three unrelated colours. These are FALLBACKS: the live values come from the CSS tokens
     * in `readColors()`, which is where the palette actually lives.
     */
    played: '#a78bfa',
    playhead: '#ffffff',
    label: '#9aa0ab',
    /** The outline every rect gets. Light, so it reads on the fill AND on the dark rows. */
    noteEdge: '#cfd6e4',
    accent: '#8b5cf6',
    /**
     * BAR LINES (G20). The accent, at full strength and 2px wide — clearly heavier than a beat.
     *
     * Its own token rather than a reuse of `label`, because "which one is the downbeat" is the
     * single question the ruler exists to answer and a grey line one shade stronger than its
     * neighbours does not answer it at a glance. Beats stay in the text colour and subdivisions
     * in the border colour, so the three weights are now three DIFFERENT things rather than
     * three alphas of one.
     */
    bar: '#8b5cf6',
    text: '#e8eaee',
    ink: '#16181d',
    keyWhite: '#bcc3cf',
    keyBlack: '#1b1e25',
    /**
     * The app's own ears, in one colour across two panes.
     *
     * Deliberately the SAME token the waveform paints its attack ticks with: the halo on a
     * rectangle here and the tick under the waveform are the same piece of evidence, and
     * giving them two colours would hide that they are one claim.
     */
    autoEdit: '#62d6b5'
    // There was a second token here — `autoAttention`, yellow, for "heard but not acted on".
    // It is deleted rather than unused. See `setAutoMarks`.
  };

  constructor(opts: PianoRollOptions) {
    this.opts = opts;
    this.canvas = opts.canvas;
    this.pane = opts.pane ?? null;
    this.handle = opts.handle ?? null;
    this.ctx = this.canvas.getContext('2d')!;
    this.editGrid = opts.editGrid ?? 'eighth';
    this.readColors();
    // A ruler from the very first frame (F3a). `setDuration`/`setBarOne`/`setScore` all replace
    // it, but none of them is guaranteed to have been called on a document nobody has opened
    // anything into — which is exactly the state the missing grid was reported in.
    this.rebuildBars();

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
    // Not passive: a ctrl-wheel is a pinch on a trackpad and the browser will zoom the whole
    // page with it unless we say we handled it.
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    // Safari/WKWebView's own pinch. Harmless everywhere else — no other engine fires them.
    this.canvas.addEventListener('gesturestart', this.onGestureStart, { passive: false });
    this.canvas.addEventListener('gesturechange', this.onGestureChange, { passive: false });
    // The drag listeners live for the object's whole life rather than per gesture, so there
    // is exactly one place that adds them and exactly one that removes them. They return
    // immediately when nothing is being dragged.
    window.addEventListener('pointermove', this.onWindowPointerMove);
    window.addEventListener('pointerup', this.onWindowPointerUp);
    window.addEventListener('pointercancel', this.onWindowPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    // Keyup and blur exist only to keep the crosshair honest. A modifier that goes down and is
    // then released over another window would otherwise leave the roll claiming, for the rest
    // of the session, that a drag here is a rubber band.
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('resize', this.onWindowResize);

    if (this.handle) {
      this.handle.addEventListener('pointerdown', this.onHandleDown);
      this.handle.addEventListener('keydown', this.onHandleKey);
      this.handle.addEventListener('dblclick', this.onHandleDouble);
    }
    this.wantedHeight = opts.height ?? DEFAULT_ROLL_HEIGHT_PX;
    this.applyHeight(false);
    // AFTER the height, because the scroll is clamped against how tall the pane is and the
    // pane is not that tall until `applyHeight` has said so. A restored view counts as PLACED,
    // so the notes arriving a moment later cannot re-centre the pane the player deliberately
    // scrolled somewhere else before the last re-render.
    if (opts.verticalView) this.setVerticalView(opts.verticalView);
  }

  /** Same trick as the waveform: read the CSS tokens once, so a light theme stays possible. */
  private readColors(): void {
    const s = getComputedStyle(document.documentElement);
    const pick = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
    this.colors = {
      bg: pick('--bg-raised', this.colors.bg),
      gutter: pick('--bg', this.colors.gutter),
      row: pick('--roll-row', this.colors.row),
      line: pick('--border', this.colors.line),
      note: pick('--roll-note', this.colors.note),
      played: pick('--wave-played', this.colors.played),
      playhead: pick('--playhead', this.colors.playhead),
      label: pick('--text-dim', this.colors.label),
      noteEdge: pick('--roll-note-edge', this.colors.noteEdge),
      accent: pick('--accent', this.colors.accent),
      bar: pick('--accent', this.colors.bar),
      text: pick('--text', this.colors.text),
      ink: pick('--ink', this.colors.ink),
      keyWhite: pick('--roll-key-white', this.colors.keyWhite),
      keyBlack: pick('--roll-key-black', this.colors.keyBlack),
      autoEdit: pick('--success', this.colors.autoEdit)
    };
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  /**
   * The x axis in FREE mode. Set from the SOURCE duration, not the score's, so the roll and
   * the waveform above it share one ruler even when the sheet runs a little past the audio.
   *
   * Linked mode ignores this for drawing but still uses it to clamp a seek.
   */
  setDuration(durationSec: number): void {
    this.durationSec = durationSec;
    // The BLANK grid is laid out to cover the take, so a take that has just been measured is a
    // new grid. Cheap and a no-op once there is a score, whose bars are its own.
    if (!this.score) this.rebuildBars();
    this.draw();
  }

  /**
   * Where bar 1 sits in the recording — the auto-trim point, or wherever the user dragged
   * the marker on the waveform. This is the whole of the written->audio shift.
   */
  setBarOne(sec: number): void {
    this.barOneSec = sec;
    // The bar grid is expressed on the recording's clock, so moving bar 1 moves every line.
    this.rebuildBars();
    // Performed rectangles are stored on the recording's clock and converted through the origin,
    // so they have to be re-derived here — otherwise moving bar 1 would slide the bar lines out
    // from under a performance that stayed exactly where it was. Score-derived rectangles are
    // already written-clock and must NOT be rebuilt: for them, moving the origin is the point.
    if (this.performance) this.rebuildNotes();
    this.draw();
  }

  /**
   * The live sheet behind the score.
   *
   * Hand this over as soon as the tri-view has built its object graph; until then the roll
   * draws the IR and says so.
   */
  setLiveModel(live: PianoRollLiveModel | null): void {
    this.live = live;
    if (this.score) this.rebuildNotes();
    this.draw();
  }

  /**
   * DRAW THE TAKE, not the print (#36).
   *
   * Hand over the notes as they were PLAYED and every rectangle comes from them and from
   * nothing else — the score walk is not consulted at all while this is set. Pass `null` (or
   * never call it) and the roll is exactly what it was: rectangles derived from the score, live
   * model first and the IR behind it.
   *
   * WHY IT REPLACES RATHER THAN OVERLAYS. Two sets of rectangles on one pitch row is two answers
   * to "which note is under my pointer", and every gesture in this file starts with that
   * question. A performance roll and a score roll are two PICTURES of the same music; the app
   * switches between them, and the one on screen is the one you can edit.
   *
   * WHAT IS UNCHANGED, deliberately:
   *   - gestures. A drag still emits today's `RollEdit`, still naming ids — the ones handed in
   *     here, stringified. The app maps them back to its own notes; this file does not care what
   *     they mean. Deltas are unaffected by the clock change because a delta is a difference and
   *     the two clocks differ by a constant.
   *   - hover, both ways. `onNoteHover` reports these ids and `setHover` takes them, so the
   *     sheet's cross-highlight works against a performance the same way it does against a score.
   *   - the time window, the grid and the bar ruler, which are already on the recording's clock.
   *
   * The array is copied, so a caller may keep mutating theirs.
   */
  setPerformanceNotes(notes: ReadonlyArray<PerformanceNote> | null): void {
    this.performance = notes ? notes.map((note) => ({ ...note })) : null;
    if (this.performance) {
      // A performance can arrive before any audio duration has been measured, and an axis with
      // no length puts every rectangle in the same column. The last note played is a true lower
      // bound on how long the take is, so use it — but only as a floor, never to shorten a
      // duration the app has already measured off the actual recording.
      const end = this.performance.reduce((max, note) => Math.max(max, note.endSec), 0);
      if (end > this.durationSec) this.durationSec = end;
    }
    this.rebuildNotes();
    this.draw();
  }

  setScore(score: RiffScore): void {
    this.score = score;
    this.rebuildBars();
    if (this.durationSec <= 0) this.durationSec = score.durationSec;
    this.rebuildNotes();
    this.draw();
  }

  /**
   * The bar grid, on the recording's clock.
   *
   * Depends on the ORIGIN as well as on the score, so it is rebuilt by `setBarOne` too — moving
   * the bar-1 marker moves every bar line, and a grid that only refreshed on a new score would
   * go on drawing the old downbeats under the new notes.
   */
  private rebuildBars(): void {
    const score = this.score;
    if (!score) {
      // A BLANK DOCUMENT STILL GETS A RULER (F3a).
      //
      // It used to get an empty list, so `gridMarks()` returned nothing, so the pane was a flat
      // wash with a sentence in the middle of it until the app had listened and a score existed.
      // That is the one moment the grid is most useful: it is what tells a player that the pane
      // has a time axis at all, that it is 4/4, and where the bars will land when they play.
      //
      // The grid is honest about being a default rather than a measurement — it is the same
      // 4/4-at-the-fallback-tempo the rest of this file falls back to (`60 / (tempoBpm || 100)`)
      // — and the moment a real score arrives, `setScore` replaces every line of it.
      this.bars = blankBarGrid(this.durationSec, this.originSec);
      return;
    }
    this.bars = barGrid(
      {
        tempoBpm: score.tempoBpm,
        divisions: score.ir.divisions,
        // THE TEMPO TRACK, not just its average. `tempoBpm` is one number for the whole score, so
        // on an imported MIDI with a tempo change every bar line after it was drawn at the wrong
        // second and the error accumulated. `barGrid` falls back to the scalar when this is empty
        // or describes a single tempo, so a detected-from-audio take is unchanged.
        ...(score.ir.tempo.changes?.length ? { tempoChanges: score.ir.tempo.changes } : {}),
        bars: score.ir.bars.map((b) => ({
          index: b.index,
          number: b.number,
          implicit: b.implicit,
          startTick: b.startTick,
          durTicks: b.durTicks,
          timeSig: b.timeSig
        }))
      },
      this.originSec
    );
  }

  /**
   * ALIGN: show exactly this stretch of the RECORDING, filling the plot. Null = the whole take.
   *
   * This is what "the views line up" is, and what it deliberately is NOT.
   *
   * IS: the sheet's visible span, in seconds, handed over so the roll draws the same music in
   * the same horizontal band. `ui/app.ts` derives it from alphaTab's own bounds — the sheet's
   * scroll position mapped back through `contentXToWrittenSec` — so scroll the sheet and the
   * roll and the strip follow, at the sheet's scale, with bar lines in the same columns. The
   * sheet's left page padding is already sized to this roll's gutter (`TIMELINE_GUTTER_PX`), so
   * the window's first second is at the same screen x in all three panes.
   *
   * IS NOT: the sheet's x-AXIS. Inside the window the ruler stays perfectly linear in time, and
   * that is the whole of §1's argument surviving intact — alphaTab spaces a dense bar wider
   * than a sparse one, so borrowing its axis makes the picture of a performance re-space itself
   * when the performance is edited. A window is a pair of numbers about WHERE TO LOOK; it
   * cannot do that, because adding a note changes no other note's time.
   *
   * FROZEN DURING A GESTURE. A drag or a double-click ends in a re-engrave, which can change
   * the sheet's content width and therefore this window. Applying that while the player still
   * has the pointer down would move every other rectangle out from under their hand mid-edit —
   * the exact failure the old linked mode was deleted for. So a window arriving during a
   * gesture is remembered and applied when the gesture ends. Re-sync on commit, never live.
   */
  setTimeAnchors(anchors: ReadonlyArray<TimeAnchor> | null): void {
    this.setViewport(windowFromAnchors(anchors));
  }

  /**
   * THE CONTROLLED SETTER, AND IT IS SILENT. `null` = the whole take.
   *
   * Silence is the whole of finding 2's fix and it is worth being explicit about what it means:
   * nothing on this path calls back out. The app owns one authoritative viewport; this is the
   * app writing it into the roll. A setter that announced what it had just been told would let
   * the app's own value come back as if a player had produced it — which is precisely what
   * `applyTimeWindow` -> `reportTimeWindow` did, on a 250 ms trailing timer, so that a sheet
   * scroll arrived at `onTimeWindowChange` looking like a roll zoom and re-scaled the sheet a
   * quarter-second after the hand had stopped. That was the "breathing".
   *
   * `holdSpan()` used to defend against the same loop from the other side, by refusing spans
   * that arrived from Align unless a 700 ms clock said this roll had zoomed recently. It is gone
   * too, and nothing replaced it: the span in an authoritative window is authoritative, because
   * the only thing that can change a span is a `zoom` command through the one reducer.
   *
   * FROZEN DURING A GESTURE, which survives unchanged. A window arriving while the player has
   * the pointer down on a note is remembered and applied when they let go — moving every other
   * rectangle out from under a hand mid-edit is the failure the old linked mode was deleted for.
   */
  setViewport(win: TimeWindow | null): void {
    if (this.gesture) {
      this.deferredWindow = { value: win };
      return;
    }
    this.deferredWindow = null;
    this.applyTimeWindow(win);
  }

  /** The stretch of RECORDING on screen. Never null: with no window set, it is the whole take. */
  getTimeWindow(): TimeWindow {
    return this.timeWindow ?? fullWindow(this.timeLimits());
  }

  /** True while the roll is showing the whole take — i.e. the time zoom is all the way out. */
  isTimeZoomedOut(): boolean {
    return this.timeWindow === null || isFullWindow(this.timeWindow, this.timeLimits());
  }

  private timeLimits(): TimeLimits {
    return {
      durationSec: Math.max(this.durationSec, this.minTakeSec()),
      minSpanSec: MIN_WINDOW_SEC
    };
  }

  /** A take with no measured duration still has to be a window onto SOMETHING. */
  private minTakeSec(): number {
    return this.score?.durationSec && this.score.durationSec > 0 ? this.score.durationSec : 1;
  }

  private applyTimeWindow(next: TimeWindow | null): void {
    const clamped = next ? clampWindow(next, this.timeLimits()) : null;
    const now = this.timeWindow;
    const same =
      (clamped === null && now === null) ||
      (clamped !== null &&
        now !== null &&
        Math.abs(clamped.fromSec - now.fromSec) < 1e-4 &&
        Math.abs(clamped.toSec - now.toSec) < 1e-4);
    if (same) return;
    this.timeWindow = clamped;
    this.draw();
  }

  /** One line, so every gesture below reaches the app's reducer by the same road. */
  private command(cmd: ViewportCommand): void {
    this.opts.onViewportCommand?.(cmd);
  }

  /**
   * ONE PINCH, ONE ZOOM (finding 12). Returns false for the other road's copy of this gesture.
   *
   * macOS delivers a trackpad pinch as a ctrl-wheel; WKWebView ALSO delivers the legacy
   * `gesturestart`/`gesturechange` pair, and on the builds that emit both, both handlers used to
   * fire and the pinch was applied twice. Whichever road speaks first owns the gesture, and the
   * other is refused until `PINCH_DEDUPE_MS` has passed with nothing on it. Same road again is
   * always allowed — that is just the next event of the same pinch.
   */
  private claimPinch(road: 'wheel' | 'gesture'): boolean {
    const t = now();
    if (this.pinchRoad !== null && this.pinchRoad !== road && t - this.lastPinchMs < PINCH_DEDUPE_MS) {
      return false;
    }
    this.pinchRoad = road;
    this.lastPinchMs = t;
    return true;
  }

  /** Whatever arrived while the pointer was down. Called from the one place a gesture ends. */
  private flushDeferredWindow(): void {
    const deferred = this.deferredWindow;
    if (!deferred) return;
    this.deferredWindow = null;
    this.applyTimeWindow(deferred.value);
  }

  // --- the public time-zoom API (#29): COMMANDS, not mutations ----------------
  //
  // `reportTimeWindow` and its `VIEW_COMMIT_MS` trailing timer stood here. The timer was the
  // "the gesture has stopped" signal the app used to decide when to re-engrave the sheet, and it
  // was also the thing that made finding 2 a DELAYED bug rather than an obvious one: the window
  // the app had pushed in came back a quarter of a second after the hand stopped, which is long
  // enough to read as the picture moving by itself. The app no longer needs to be told when a
  // gesture ends, because it is the one applying every gesture.

  /**
   * Zoom the time axis about a point on the plot, given in canvas x.
   *
   * The gutter is not part of the time axis, so an x inside it anchors on the plot's left edge
   * rather than extrapolating backwards into a column that means nothing in seconds.
   */
  zoomTimeAt(factor: number, x: number): void {
    const frac = Math.max(0, Math.min(1, (x - this.gutterPx) / this.plotWidth));
    this.command({ kind: 'zoom', factor, anchorFrac: frac, source: 'roll' });
  }

  /** Zoom about the middle of the view — what the buttons do. */
  zoomTime(factor: number): void {
    this.command({ kind: 'zoom', factor, anchorFrac: 0.5, source: 'roll' });
  }

  zoomTimeIn(): void {
    this.zoomTime(TIME_ZOOM_IN_FACTOR);
  }

  zoomTimeOut(): void {
    this.zoomTime(TIME_ZOOM_OUT_FACTOR);
  }

  /** Back to the whole take. */
  fitTime(): void {
    this.command({ kind: 'fit', source: 'roll' });
  }

  /** Slide the window without changing how much of the take is on screen. */
  panTimeBy(deltaSec: number): void {
    this.command({ kind: 'pan', deltaSec, source: 'roll' });
  }

  /**
   * A RECORDING second -> a fraction of the plot. Null only when there is no window at all,
   * which is the "whole take, evenly" case the caller handles itself.
   */
  private anchorFrac(sec: number): number | null {
    return this.timeWindow ? secToFrac(this.timeWindow, sec) : null;
  }

  /** The exact inverse of `anchorFrac`. */
  private anchorSec(frac: number): number | null {
    return this.timeWindow ? fracToSec(this.timeWindow, frac) : null;
  }

  /**
   * Re-read the notes from the live sheet.
   *
   * Called from the ONE place an edit becomes visible (`App.applyResult`), so the roll
   * changes on exactly the events the sheet changes on — including undo and redo, which take
   * the same path. Nothing here polls.
   *
   * This is also where a provisional drag stops being provisional: whatever the integrator
   * did with the edit, the sheet is now the truth again.
   */
  refresh(): void {
    this.pending = null;
    this.pendingIds = new Set();
    // A performance is rebuildable without a score — it IS the notes — so it counts as
    // something to refresh.
    if (!this.score && !this.performance) {
      this.draw();
      return;
    }
    this.rebuildNotes();
    this.draw();
  }

  clear(): void {
    this.score = null;
    this.live = null;
    // A performance belongs to one take. Kept across `clear()` it would be drawn over the next
    // one, at seconds that mean nothing there.
    this.performance = null;
    this.notes = [];
    this.bars = [];
    this.source = 'ir';
    this.irDeltaSec = null;
    this.irNotes = 0;
    this.selection.clear();
    this.pending = null;
    this.pendingIds = new Set();
    this.gesture = null;
    this.rects = [];
    // A new take gets a fresh pitch window. The ZOOM is kept, because how tall a player likes
    // their rows is a preference and not a property of the recording.
    this.measureContentRange();
    this.viewPlaced = false;
    this.fitLocked = false;
    this.lastUserVerticalMs = -Infinity;
    this.draw();
  }

  setPosition(sec: number): void {
    if (Math.abs(sec - this.positionSec) < 0.005) return;
    this.positionSec = sec;
    this.followSoundingNote();
    this.draw();
  }

  private rebuildNotes(): void {
    // #36: a performance replaces the walk outright. First, and before the score is even
    // looked at, so that the rectangles cannot be a mixture of the two.
    if (this.performance) {
      this.notes = sortByStart(
        this.performance.map((note) => ({
          startSec: note.startSec - this.originSec,
          endSec: Math.max(note.startSec, note.endSec) - this.originSec,
          midi: note.midi,
          noteId: String(note.id),
          velocity: note.velocity
        }))
      );
      this.source = 'performance';
      // The IR cross-check is a comparison between two walks of the same score. There is only
      // one walk here and it is not of the score, so there is no delta to report — null rather
      // than a stale number from before the performance arrived.
      this.irDeltaSec = null;
      this.irNotes = this.score ? pianoRollNotes(this.score).length : 0;
      this.measureContentRange();
      if (this.fitLocked) this.applyFit();
      return;
    }

    const score = this.score;
    if (!score) return;

    const fromIr = pianoRollNotes(score);
    this.irNotes = fromIr.length;

    let fromModel: PianoRollNote[] | null = null;
    if (this.live) {
      try {
        const walked = pianoRollNotesFromModel(score, this.live);
        if (walked.length > 0) fromModel = walked;
      } catch (e) {
        // A renderer that has not finished, or a model shape we did not expect. The IR is
        // still a true picture of what was built, so fall back to it rather than blank the
        // pane — but say so, loudly, because a stale roll is the bug this replaced.
        console.error('[riffsheet] piano roll could not read the live sheet', e);
      }
    }

    this.notes = fromModel ?? fromIr;
    this.source = fromModel ? 'model' : 'ir';
    // Only meaningful when nothing has been edited yet; an edit is SUPPOSED to move things.
    this.irDeltaSec = fromModel ? maxStartDelta(fromModel, fromIr) : null;
    this.measureContentRange();
    // A fitted view has to keep fitting when the notes change under it — an edit that widens
    // the take's range would otherwise leave "Fit" showing less than everything without any
    // gesture from the player. A view that is merely scrolled somewhere is left exactly alone.
    if (this.fitLocked) this.applyFit();
  }

  // -------------------------------------------------------------------------
  // Modes: linked / names / editing / selection
  // -------------------------------------------------------------------------

  /** Change the edit grid without rebuilding the score or changing any existing note. */
  setEditGrid(grid: PianoRollEditGrid): void {
    if (this.editGrid === grid) return;
    this.editGrid = grid;
    this.draw();
  }

  /** Name every row, not only the C's. Thins itself when the rows are too short either way. */
  setShowAllNames(on: boolean): void {
    if (this.showAllNames === on) return;
    this.showAllNames = on;
    this.draw();
  }

  get showsAllNames(): boolean {
    return this.showAllNames;
  }

  /** Drag-to-edit. Off leaves the roll exactly as read-only as it was in v1.1. */
  setEditable(on: boolean): void {
    if (this.editableOn === on) return;
    this.editableOn = on;
    if (!on) this.cancelGesture();
    this.draw();
  }

  get editable(): boolean {
    return this.editableOn;
  }

  /**
   * Highlight exactly these ids and nothing else.
   *
   * The integrator calls this when the sheet's selection changes, and the roll calls
   * `onNoteSelect` when its own does — one selection, two views, no polling.
   */
  setSelection(ids: string[]): void {
    const next = new Set(ids);
    if (sameIds(next, this.selection)) return;
    this.selection = next;
    this.draw();
  }

  get selectedIds(): string[] {
    return [...this.selection];
  }

  /**
   * Mark notes the app edited on its own evidence, so the player can see what was done to them.
   *
   * THE ROLL IS THE RIGHT PLACE FOR THIS AND THE SHEET IS NOT. The staff and the tab are the
   * RESULT — they say what the music is, and putting "the app changed this one" ink on a
   * notehead would make the reading harder in exchange for information about the app rather
   * than about the music. The roll and the waveform are where the player already goes to
   * argue with what was heard, so that is where the argument is shown.
   *
   * ONE KIND OF MARK, AND IT MEANS "THE APP CHANGED THIS". There used to be a second,
   * yellow kind for a detection the pass NOTICED and did not act on. It is gone — not
   * unused, unrepresentable: this signature carries no flag that could ask for it.
   *
   * Why it went: a highlight the player cannot act on is a highlight they have to learn to
   * ignore, and a roll speckled with yellow on every take taught exactly that. Worse, it
   * trained the eye to skim past the green ones, which are the marks that DO need a decision.
   * The pass still records its refusals — `AutoEditPlan.attention` is unchanged and the
   * probes still count it — it simply no longer paints them.
   */
  setAutoMarks(marks: ReadonlyArray<{ noteId: string }>): void {
    const next = new Set<string>();
    for (const m of marks) if (m.noteId) next.add(m.noteId);
    if (next.size === this.autoMarks.size) {
      let same = true;
      for (const id of next) {
        if (!this.autoMarks.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.autoMarks = next;
    this.draw();
  }

  get autoMarkIds(): string[] {
    return [...this.autoMarks];
  }

  /**
   * Stable-id bridge from a waveform interval to the notes drawn here.
   * Inputs and output times use the recording clock; internal note geometry uses
   * written score seconds, so the shared score origin is applied exactly once.
   */
  noteIdsInAudioRange(fromSec: number, toSec: number): string[] {
    const lo = Math.min(fromSec, toSec) - this.originSec;
    const hi = Math.max(fromSec, toSec) - this.originSec;
    const ids = new Set<string>();
    for (const note of this.notes) {
      if (!note.noteId) continue;
      if (note.endSec > lo && note.startSec < hi) ids.add(note.noteId);
    }
    return [...ids];
  }

  /** Recording-clock extent of one or more selected stable note ids. */
  audioRangeForIds(ids: Iterable<string>): { fromSec: number; toSec: number } | null {
    const wanted = new Set(ids);
    if (wanted.size === 0) return null;
    let from = Number.POSITIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    for (const note of this.notes) {
      if (!note.noteId || !wanted.has(note.noteId)) continue;
      from = Math.min(from, note.startSec + this.originSec);
      to = Math.max(to, note.endSec + this.originSec);
    }
    return Number.isFinite(from) && to > from ? { fromSec: from, toSec: to } : null;
  }

  /** How many notes are selected. The number the count badge prints. */
  get selectionCount(): number {
    return this.selection.size;
  }

  /**
   * The selection changed HERE, so tell whoever is listening. `setSelection` does not use this.
   *
   * Every path inside this file goes through it, which is the only reason the sheet, the tab
   * and the roll can be relied on to agree — one door out, no exceptions to remember.
   */
  private changeSelection(next: Set<string>): boolean {
    if (sameIds(next, this.selection)) return false;
    this.selection = next;
    this.opts.onSelectionChange?.([...this.selection]);
    return true;
  }

  /**
   * Select every note the roll is currently DRAWING. ⌘A.
   *
   * Drawn, not "in the score": in linked mode the roll is a window onto a long sheet, and
   * "select all" meaning "including the forty notes eight bars off the right of the screen"
   * is a selection nobody can see and a Delete nobody can predict. What you can see is what
   * you get, which is also what a rubber band gives you, so the two agree.
   */
  selectAllVisible(): void {
    const ids = new Set<string>();
    for (const r of this.rects) if (r.note.noteId) ids.add(r.note.noteId);
    if (!this.changeSelection(ids)) return;
    this.draw();
  }

  /** Escape. Also what a click on empty background does. */
  clearSelection(): void {
    if (!this.changeSelection(new Set())) return;
    this.draw();
  }

  /** Add the note if it is out, drop it if it is in. Shift/Cmd + click. */
  toggleSelection(noteId: string): void {
    const next = new Set(this.selection);
    if (next.has(noteId)) next.delete(noteId);
    else next.add(noteId);
    if (!this.changeSelection(next)) return;
    this.draw();
  }

  /**
   * "Back to the default size."
   *
   * Both axes, and both for real. The two lines that stood at the top of this method fired
   * `onResetView` and `onScrollRequest` — options `ui/app.ts` has never supplied, so the TIME
   * half of "reset" went nowhere at all (finding 14). It is a `fit` command now, through the
   * same reducer every other gesture uses, so the sheet and the strip come back with it.
   */
  resetView(): void {
    this.command({ kind: 'fit', source: 'roll' });
    this.pxPerSemitone = DEFAULT_PX_PER_SEMITONE;
    this.fitLocked = false;
    this.lastUserVerticalMs = now();
    this.placeView();
    this.reportView(true);
    this.draw();
  }

  // -------------------------------------------------------------------------
  // Height
  // -------------------------------------------------------------------------

  /** Set the pane height. `commit` marks the end of a gesture — persist there, not before. */
  setHeight(px: number, commit: boolean): void {
    this.wantedHeight = px;
    this.applyHeight(commit);
  }

  private applyHeight(commit: boolean): void {
    const next = clampRollHeight(this.wantedHeight);
    const changed = next !== this.appliedHeight;
    this.appliedHeight = next;
    if (this.pane) this.pane.style.height = `${next}px`;
    if (this.handle) {
      this.handle.setAttribute('aria-valuenow', String(next));
      this.handle.setAttribute('aria-valuemin', String(clampRollHeight(0)));
      this.handle.setAttribute('aria-valuemax', String(clampRollHeight(Number.MAX_SAFE_INTEGER)));
    }
    if (!changed && !commit) return;
    // The pane's height and the vertical zoom are two separate things and both have to keep
    // working (see invariant 7 and invariant 10). Dragging the pane taller now shows MORE ROWS
    // at the same row height, which is the whole change — except when Fit is locked, where the
    // player has asked for everything to stay on screen and the row height is what gives.
    if (this.fitLocked) this.applyFit();
    else if (this.viewPlaced) this.applyScrollTop(this.scrollTopMidi);
    this.opts.onHeightChange?.(next, commit);
    this.draw();
  }

  private onWindowResize = (): void => {
    // Re-clamp before redrawing: a window that just got shorter may no longer afford the
    // height the player picked, and one that got taller should give it back.
    this.applyHeight(false);
    this.draw();
  };

  private onHandleDown = (e: PointerEvent): void => {
    if (!this.pane || e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = this.pane.getBoundingClientRect().height;
    this.resizing = true;
    this.handle?.classList.add('dragging');
    // Capture keeps the drag alive over the sheet below; a synthetic pointer from the
    // harness has no active pointer id, so a failure here is not a failure of the drag.
    try {
      this.handle?.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }

    const move = (m: PointerEvent): void => {
      if (!this.resizing) return;
      this.setHeight(startH + (m.clientY - startY), false);
    };
    const detach = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.detachHeightDrag = null;
    };
    const up = (u: PointerEvent): void => {
      if (!this.resizing) return;
      this.resizing = false;
      this.handle?.classList.remove('dragging');
      try {
        this.handle?.releasePointerCapture(u.pointerId);
      } catch {
        /* never captured */
      }
      detach();
      // One commit per gesture: this is what reaches the settings file.
      this.setHeight(this.appliedHeight, true);
    };

    this.detachHeightDrag?.();
    this.detachHeightDrag = detach;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /** The handle is focusable, so it has to work without a mouse. */
  private onHandleKey = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 24 : 8;
    if (e.key === 'ArrowDown') this.setHeight(this.appliedHeight + step, true);
    else if (e.key === 'ArrowUp') this.setHeight(this.appliedHeight - step, true);
    else if (e.key === 'Home') this.setHeight(DEFAULT_ROLL_HEIGHT_PX, true);
    else return;
    e.preventDefault();
  };

  private onHandleDouble = (): void => {
    this.setHeight(DEFAULT_ROLL_HEIGHT_PX, true);
  };

  // -------------------------------------------------------------------------
  // Geometry — invariant 1 lives here
  // -------------------------------------------------------------------------

  /**
   * ==================== WRITTEN SECOND 0, AND WHO GETS TO DECIDE IT ====================
   *
   * The recording-clock second that the score calls 0. Every conversion in this file goes through
   * it, and so does the app's own — which is the whole problem it used to have.
   *
   * THE DIVERGENCE (codex-critique §7). The app moved its canonical origin to a FIRST-ATTACK
   * alignment (`App.originSec`, ui/app.ts §F13) because `scoreOriginSec` derives the answer from
   * `barOneSec`, which is 0 unless somebody has dragged the marker — so a take with four seconds
   * of leading silence claimed bar 1 was at second 0 while the roll and the strip drew that first
   * attack where it was actually played. This getter went on computing the OLD answer. Double-
   * clicking to add a note then emitted a written second measured against this origin, and
   * `edit/rollPerformance.ts` added the app's DIFFERENT origin back on: the note landed exactly
   * one leading silence away from where it was clicked.
   *
   * ONE AUTHORITY. The app owns the origin and pushes it in (`setOriginSec`). This file no longer
   * has an opinion; it only has a fallback, for the case that has to keep working — a roll
   * standing on its own with a score and no integrator, which is what `scoreOriginSec` always
   * answered and still does.
   */
  private appOriginSec: number | null = null;

  private get originSec(): number {
    if (this.appOriginSec !== null) return this.appOriginSec;
    return this.score ? scoreOriginSec(this.score, this.barOneSec) : this.barOneSec;
  }

  /**
   * The app's written second 0, which from here on is the only one.
   *
   * Pass `null` to hand the question back to the fallback above. Everything derived from the
   * origin — the bar grid, and the performed rectangles that are stored on the recording's clock
   * — is rebuilt here for the same reason `setBarOne` rebuilds them: moving the origin moves
   * every bar line, and it must not slide them out from under a performance that has not moved.
   */
  setOriginSec(sec: number | null): void {
    const next = sec !== null && Number.isFinite(sec) ? sec : null;
    if (next === this.appOriginSec) return;
    this.appOriginSec = next;
    this.rebuildBars();
    if (this.performance) this.rebuildNotes();
    this.draw();
  }

  // ==========================================================================
  // `map(): SheetMap | null` STOOD HERE, RETURNING NULL FOREVER. Read this before restoring it.
  // ==========================================================================
  //
  // It used to return the SHEET's geometry when a chip was on, and everything below drew against
  // it: a notehead and its rectangle in the same column, the two panes scrolling as one. It
  // looked right in a screenshot and was wrong to use. alphaTab deliberately gives a rhythmically
  // dense bar more pixels than a sparse one, so a roll drawn on that axis RE-SPACES ITSELF
  // whenever the engraving changes — and the engraving changes every time a note is added, moved
  // or lengthened. Adding one note moved the notes either side of it, which is the one thing a
  // picture of a performance must never do.
  //
  // The supplier was deleted; the `if (m)` branches were kept "so a future engraved-axis design
  // has somewhere to land". They are gone now too (finding 14). A permanently-false branch is not
  // a landing site, it is a second version of every mapping in this file that nobody can run, and
  // the live coupling bugs came out of exactly this habit of keeping two generations alive. The
  // axis here is linear recording time, always, which is what makes "the same x means the same
  // second" true across the strip, the roll and the transport.

  /**
   * The label column, in px — 0 when the pane is too narrow to spare it.
   *
   * At REAPER's floor the editor is about 390px wide; 34px of that is still worth spending on
   * being able to read a pitch off the pane. It only collapses when the gutter would be a
   * quarter of the whole strip.
   */
  private get gutterPx(): number {
    const w = this.canvas.clientWidth;
    return w >= TIMELINE_GUTTER_PX * 4 ? TIMELINE_GUTTER_PX : 0;
  }

  private get plotWidth(): number {
    return Math.max(1, this.canvas.clientWidth - this.gutterPx);
  }

  /**
   * The time ruler's height, or 0 when the pane cannot spare it. The top strip.
   *
   * The one number that says where the pitch plot begins; `draw()` translates by it and
   * `localPoint()` subtracts it, so nothing else in the file has to know it exists.
   */
  private get rulerH(): number {
    return this.canvas.clientHeight >= RULER_MIN_PANE_PX ? RULER_H_PX : 0;
  }

  /** The rows' height. The top strip is the ruler, the bottom one the resize handle — invariant 7. */
  private get plotHeight(): number {
    const h = this.canvas.clientHeight;
    return Math.max(1, h - this.rulerH - (this.handle ? HANDLE_RESERVE_PX : 0));
  }

  /**
   * WRITTEN seconds -> screen x. THE mapping, and there is now only one of it.
   *
   * The window's two ends and a straight line between them. Still a ruler made of TIMES — adding
   * a note changes no other note's time, so no other rectangle can move. See `setViewport`.
   */
  private writtenToX(sec: number): number {
    const frac = this.anchorFrac(sec + this.originSec);
    if (frac !== null) return this.gutterPx + frac * this.plotWidth;
    if (this.durationSec <= 0) return this.gutterPx;
    return this.gutterPx + ((sec + this.originSec) / this.durationSec) * this.plotWidth;
  }

  /** The exact inverse. */
  private xToWritten(x: number): number {
    const sec = this.anchorSec((x - this.gutterPx) / this.plotWidth);
    if (sec !== null) return sec - this.originSec;
    if (this.durationSec <= 0) return 0;
    return ((x - this.gutterPx) / this.plotWidth) * this.durationSec - this.originSec;
  }

  /** RECORDING seconds -> px, via the one mapping above. The playhead's only route. */
  private secToX(sec: number): number {
    return this.writtenToX(sec - this.originSec);
  }

  /** px -> RECORDING seconds. What a click means. */
  private xToSec(x: number): number {
    const written = this.xToWritten(x);
    return Number.isFinite(written) ? written + this.originSec : Number.NaN;
  }

  /**
   * The snap unit, in seconds: the nearest 1/16, or one of the score's own divisions,
   * whichever is COARSER.
   *
   * The score's grid and not a round number of milliseconds, because the sheet is going to
   * re-quantize whatever comes back and a drag that lands between two printable durations
   * just moves somewhere the player did not ask for.
   */
  private get snapSec(): number {
    const quarter = 60 / (this.score?.tempoBpm || 100);
    switch (this.editGrid) {
      case 'quarter': return quarter;
      case 'eighth': return quarter / 2;
      case 'sixteenth': return quarter / 4;
      case 'thirtysecond': return quarter / 8;
      case 'triplet': return quarter / 3;
      // Free placement still needs a sensible default length for a newly added
      // note and for keyboard nudges. Alt/Option remains fully unsnapped. 'off' is the same
      // bargain seen from the ruler's side: no lines to snap to, so no snapping.
      case 'off':
      case 'free': return quarter / 4;
    }
  }

  /** Alt/Option bypasses the grid entirely — see the editing contract. */
  private snap(sec: number, free: boolean): number {
    if (free || this.editGrid === 'free' || this.editGrid === 'off') return sec;
    const unit = this.snapSec;
    return unit > 0 ? Math.round(sec / unit) * unit : sec;
  }

  // --- the pitch axis: two numbers, everything else derived -------------------
  //
  // Invariant 10. `lowMidi` and `highMidi` were fields until v1.3 and are getters now, on
  // purpose: while they were stored, `fitPitchRange()` and `geometry()` were two answers to one
  // question and a scroll would have had to remember to update both. Derived, they cannot drift
  // from the picture, from the hit-test, or from `probe()`.

  /** How many semitone rows the plot is tall. Fractional — the edges are usually part-rows. */
  private get visibleRows(): number {
    return this.plotHeight / this.pxPerSemitone;
  }

  /** The lowest pitch row with any pixel on screen. */
  private get lowMidi(): number {
    const bottom = this.scrollTopMidi - this.visibleRows;
    return Math.max(0, Math.min(127, Math.floor(bottom)));
  }

  /** The highest pitch row with any pixel on screen. */
  private get highMidi(): number {
    const top = Math.ceil(this.scrollTopMidi) - 1;
    return Math.max(0, Math.min(127, Math.max(top, this.lowMidi)));
  }

  private geometry(): { rowH: number; yFor: (midi: number) => number; span: number } {
    const rowH = this.pxPerSemitone;
    const top = this.scrollTopMidi;
    return {
      rowH,
      span: Math.max(1, this.highMidi - this.lowMidi + 1),
      // A row occupies the pitch interval [midi, midi + 1); its TOP edge is the higher of the
      // two, which is why the `+ 1` is here and not in the caller.
      yFor: (midi: number) => (top - midi - 1) * rowH
    };
  }

  private yToMidi(y: number): number {
    if (!(this.pxPerSemitone > 0)) return this.lowMidi;
    const midi = Math.floor(this.scrollTopMidi - y / this.pxPerSemitone);
    return Math.max(0, Math.min(127, midi));
  }

  /**
   * The take's own pitch range, and where its notes actually cluster.
   *
   * This USED to be the scale the pane was drawn on, which is the reported bug: one octave
   * error at either end and every row halved. It now only answers two questions — what Fit
   * fits, and where a view that has never been placed should open.
   */
  private measureContentRange(): void {
    if (this.notes.length === 0) {
      this.contentLowMidi = 40;
      this.contentHighMidi = 52;
      this.contentMedianMidi = 46;
      this.noteLowMidi = null;
      this.noteHighMidi = null;
      return;
    }
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    const pitches: number[] = [];
    for (const n of this.notes) {
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
      pitches.push(n.midi);
    }
    this.noteLowMidi = lo;
    this.noteHighMidi = hi;
    // The MEDIAN, not the midpoint of the range. A riff that lives around E1 with one stray
    // octave-doubled note at E3 has a midpoint nobody plays; opening there would show the
    // player an empty pane and the bug at the same time. The median opens on the music.
    pitches.sort((a, b) => a - b);
    this.contentMedianMidi = pitches[Math.floor(pitches.length / 2)];

    let padLo = lo - PITCH_PADDING;
    let padHi = hi + PITCH_PADDING;
    const short = MIN_PITCH_SPAN - (padHi - padLo);
    if (short > 0) {
      padLo -= Math.floor(short / 2);
      padHi += Math.ceil(short / 2);
    }
    this.contentLowMidi = Math.max(0, Math.floor(padLo));
    this.contentHighMidi = Math.min(127, Math.ceil(padHi));
  }

  /**
   * Where a view that has never been placed opens.
   *
   * Centred on the median pitch, then pulled back inside the take's own range so the pane is
   * never showing empty keyboard while there are notes just off the edge of it.
   */
  private placeView(): void {
    // No layout yet — in the plugin the canvas has no height until JUCE has sized the page, and
    // a view placed against a 1px pane would be placed wrong and then believed.
    if (this.canvas.clientHeight <= 0) return;
    const rows = this.visibleRows;
    const span = this.contentHighMidi - this.contentLowMidi + 1;
    let top: number;
    if (span <= rows) {
      top = (this.contentLowMidi + this.contentHighMidi + 1) / 2 + rows / 2;
    } else {
      top = this.contentMedianMidi + 0.5 + rows / 2;
      top = Math.max(this.contentLowMidi + rows, Math.min(this.contentHighMidi + 1, top));
    }
    this.applyScrollTop(top);
  }

  /**
   * Place the view the first time there is both a pane to place it in and music to place it on.
   *
   * Both halves matter, and the second one was got wrong once already. `App.renderMain()` builds
   * the roll, sets its duration — which draws — and only THEN hands over the score, so a
   * placement made on the first frame would centre the pane on the empty default range and then
   * refuse to move when the notes turned up a millisecond later. Until there are notes the roll
   * re-centres on every frame, which costs one comparison and means the frame that first HAS
   * music is the frame that decides where the player is looking.
   */
  private ensureViewPlaced(): void {
    if (this.viewPlaced || this.canvas.clientHeight <= 0) return;
    this.placeView();
    if (this.notes.length > 0) this.viewPlaced = true;
  }

  /**
   * Set the vertical scroll, clamped to the keyboard.
   *
   * The clamp is the whole 0..127 keyboard rather than the take's range on purpose: a
   * double-click adds a note at the pitch under the pointer, so a player has to be able to
   * scroll to a pitch the take does not contain yet. Returns whether it moved.
   */
  private applyScrollTop(next: number): boolean {
    const rows = this.visibleRows;
    let top: number;
    if (!Number.isFinite(next)) return false;
    if (rows >= MIDI_TOP) {
      // The whole keyboard fits and then some. Centre it, so the empty margin is shared
      // between the top and the bottom instead of all landing under the lowest note.
      top = MIDI_TOP / 2 + rows / 2;
    } else {
      top = Math.max(rows, Math.min(MIDI_TOP, next));
    }
    if (Math.abs(top - this.scrollTopMidi) < 1e-6) return false;
    this.scrollTopMidi = top;
    return true;
  }

  /** Clamp a zoom. `floor` is the one thing Fit is allowed to argue with. */
  private clampZoom(px: number, floor = MIN_PX_PER_SEMITONE): number {
    if (!Number.isFinite(px) || px <= 0) return DEFAULT_PX_PER_SEMITONE;
    return Math.max(floor, Math.min(MAX_PX_PER_SEMITONE, px));
  }

  /**
   * The player moved the pitch window themselves.
   *
   * Two consequences, and both matter: auto-follow stands down for a few seconds, and Fit stops
   * being sticky, because a view somebody has scrolled is no longer the fitted one.
   */
  private markUserVertical(): void {
    this.lastUserVerticalMs = now();
    this.fitLocked = false;
    // A view somebody has scrolled is a placed view, whatever else has or has not arrived yet.
    // Without this, notes landing a frame after a scroll would re-centre the pane out from
    // under them.
    this.viewPlaced = true;
  }

  /** Tell the integrator where the pitch window is, so it survives the next `renderMain()`. */
  private reportView(commit: boolean): void {
    const cb = this.opts.onVerticalViewChange;
    if (!cb) return;
    cb(this.getVerticalView(), commit);
    if (commit) {
      this.clearViewCommitTimer();
      return;
    }
    // A wheel and a trackpad swipe have no "end", so the end is a pause. Without this the
    // integrator would never get a commit off a scroll and the zoom would not survive a reload.
    this.clearViewCommitTimer();
    this.viewCommitTimer = window.setTimeout(() => {
      this.viewCommitTimer = null;
      this.opts.onVerticalViewChange?.(this.getVerticalView(), true);
    }, VIEW_COMMIT_MS);
  }

  private clearViewCommitTimer(): void {
    if (this.viewCommitTimer === null) return;
    window.clearTimeout(this.viewCommitTimer);
    this.viewCommitTimer = null;
  }

  // --- the public vertical API ------------------------------------------------

  /** The two numbers that describe the pitch axis. Hand these back to the constructor. */
  getVerticalView(): RollVerticalView {
    return {
      pxPerSemitone: Number(this.pxPerSemitone.toFixed(4)),
      scrollTopMidi: Number(this.scrollTopMidi.toFixed(4)),
      fitLocked: this.fitLocked
    };
  }

  /** Put a saved view back. Does not fire `onVerticalViewChange` — that would be an echo. */
  setVerticalView(view: RollVerticalView | null): void {
    if (!view) return;
    this.pxPerSemitone = this.clampZoom(view.pxPerSemitone, FIT_FLOOR_PX_PER_SEMITONE);
    this.fitLocked = !!view.fitLocked;
    this.viewPlaced = true;
    this.applyScrollTop(view.scrollTopMidi);
    this.draw();
  }

  /** How tall a semitone is right now, in px. */
  get verticalZoom(): number {
    return this.pxPerSemitone;
  }

  /** Is the whole take on screen? Not the same question as "did somebody press Fit". */
  get isFitted(): boolean {
    if (this.noteLowMidi === null || this.noteHighMidi === null) return true;
    const top = this.scrollTopMidi;
    const bottom = top - this.visibleRows;
    return this.noteHighMidi + 1 <= top + 1e-6 && this.noteLowMidi >= bottom - 1e-6;
  }

  /** Scroll the pitch window by a number of PIXELS. Positive is down the keyboard. */
  scrollVerticalBy(px: number): void {
    if (!px) return;
    if (!this.applyScrollTop(this.scrollTopMidi - px / this.pxPerSemitone)) return;
    this.markUserVertical();
    this.reportView(false);
    this.draw();
  }

  /** Put a pitch at a given y in the plot. The one primitive every "scroll to" goes through. */
  private scrollPitchTo(midi: number, y: number): boolean {
    return this.applyScrollTop(midi + y / this.pxPerSemitone);
  }

  /**
   * Vertical zoom about a fixed point on screen.
   *
   * `anchorY` is the y the pitch under it must still be at afterwards — the pointer for a
   * wheel, the selected note for the keyboard. Zooming about the top of the pane instead is the
   * thing that makes a zoom feel like the picture ran away from you.
   */
  zoomVerticalAt(factor: number, anchorY: number): void {
    const next = this.clampZoom(this.pxPerSemitone * factor);
    if (Math.abs(next - this.pxPerSemitone) < 1e-6) return;
    const y = Math.max(0, Math.min(this.plotHeight, anchorY));
    const pivot = this.scrollTopMidi - y / this.pxPerSemitone;
    this.pxPerSemitone = next;
    this.applyScrollTop(pivot + y / next);
    this.markUserVertical();
    this.reportView(false);
    this.draw();
  }

  /**
   * Zoom about the selection, or about the middle of the pane when nothing is selected.
   *
   * This is the keyboard's and a toolbar button's route in: neither carries a pointer position,
   * and "zoom about wherever the mouse happens to be resting" is not what either one means.
   */
  zoomVertical(factor: number): void {
    const midi = this.selectionCentreMidi();
    if (midi === null) {
      this.zoomVerticalAt(factor, this.plotHeight / 2);
      return;
    }
    const next = this.clampZoom(this.pxPerSemitone * factor);
    if (Math.abs(next - this.pxPerSemitone) < 1e-6) return;
    const currentY = this.geometry().yFor(midi) + this.pxPerSemitone / 2;
    // Keep it where it is if it is on screen; bring it to the middle if it is not.
    const y = currentY >= 0 && currentY <= this.plotHeight ? currentY : this.plotHeight / 2;
    this.pxPerSemitone = next;
    this.scrollPitchTo(midi + 0.5, y);
    this.markUserVertical();
    this.reportView(true);
    this.draw();
  }

  zoomVerticalIn(): void {
    this.zoomVertical(VZOOM_IN_FACTOR);
  }

  zoomVerticalOut(): void {
    this.zoomVertical(VZOOM_OUT_FACTOR);
  }

  /** The mean pitch of the selection, or null when nothing selectable is selected. */
  private selectionCentreMidi(): number | null {
    if (this.selection.size === 0) return null;
    let sum = 0;
    let n = 0;
    for (const note of this.notes) {
      if (!note.noteId || !this.selection.has(note.noteId)) continue;
      sum += note.midi;
      n++;
    }
    return n > 0 ? sum / n : null;
  }

  /**
   * THE FIT COMMAND. Show the whole take at once — what the pane used to do on every frame.
   *
   * It is a command now and not the default, which is the entire point of invariant 10. It
   * takes the lock with it so that growing the pane afterwards keeps everything on screen
   * rather than leaving a band of empty keyboard at the top.
   */
  fitVertical(): void {
    this.applyFit();
    this.fitLocked = true;
    // Fit is the player asking for a particular view, so auto-follow must not immediately
    // scroll away from it either.
    this.lastUserVerticalMs = now();
    this.viewPlaced = true;
    this.reportView(true);
    this.draw();
  }

  private applyFit(): void {
    if (this.canvas.clientHeight <= 0) return;
    const h = this.plotHeight;
    const span = Math.max(1, this.contentHighMidi - this.contentLowMidi + 1);
    this.pxPerSemitone = this.clampZoom(h / span, FIT_FLOOR_PX_PER_SEMITONE);
    this.applyScrollTop((this.contentLowMidi + this.contentHighMidi + 1) / 2 + this.visibleRows / 2);
  }

  /** Scroll the sounding note back into view during playback. On by default. */
  setFollowPlayback(on: boolean): void {
    this.followPlayback = on;
  }

  get followsPlayback(): boolean {
    return this.followPlayback;
  }

  /**
   * Does Space belong to the roll at this instant?
   *
   * `App.installGlobalHandlers()` binds Space to play/pause on `window`, and it registered its
   * listener before this object existed, so the roll cannot out-run it with `preventDefault()`
   * however early it listens. Rather than fight for the key, the roll answers this question and
   * the app stands aside — ONE line in `installGlobalHandlers`:
   *
   *     if (e.key === ' ' && this.pianoRoll?.wantsSpace()) return;
   *
   * True only while the pointer is actually over the roll, so Space is the transport everywhere
   * else in the window, which is where a player expects it.
   */
  wantsSpace(): boolean {
    return this.hovering;
  }

  /**
   * Bring a pitch into view, minimally, unless it is far away — then centre it.
   *
   * Used by auto-follow and available to the integrator for "show me the note I just picked on
   * the sheet". Returns whether anything moved.
   */
  scrollPitchIntoView(lowMidi: number, highMidi = lowMidi): boolean {
    if (!this.bringPitchIntoView(lowMidi, highMidi)) return false;
    this.draw();
    return true;
  }

  /**
   * The same, without the repaint.
   *
   * Auto-follow runs inside `setPosition`, which draws once at the end anyway; painting here as
   * well would be a second full canvas repaint on every transport tick.
   */
  private bringPitchIntoView(lowMidi: number, highMidi: number): boolean {
    const rows = this.visibleRows;
    const top = this.scrollTopMidi;
    const bottom = top - rows;
    const margin = Math.min(AUTO_FOLLOW_MARGIN_ROWS, rows / 6);
    const wanted = highMidi + 1 - lowMidi;
    if (wanted >= rows) {
      // Taller than the pane: centre it and accept that some of it is off the edge.
      return this.applyScrollTop((lowMidi + highMidi + 1) / 2 + rows / 2);
    }
    if (highMidi + 1 > top - margin) return this.applyScrollTop(highMidi + 1 + margin);
    if (lowMidi < bottom + margin) return this.applyScrollTop(lowMidi - margin + rows);
    return false;
  }

  /**
   * Keep the note that is sounding on screen, the way the sheet keeps its cursor on screen.
   *
   * Deliberately silent about `onVerticalViewChange`: this is not the player's scroll and
   * writing it into the settings file would mean playback quietly rewriting a preference.
   */
  private followSoundingNote(): void {
    if (!this.followPlayback || this.gesture) return;
    if (now() - this.lastUserVerticalMs < AUTO_FOLLOW_QUIET_MS) return;
    const nowWritten = this.positionSec - this.originSec;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const n of this.notes) {
      if (n.startSec > nowWritten || nowWritten >= n.endSec) continue;
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
    }
    if (!Number.isFinite(lo)) return;
    this.bringPitchIntoView(lo, hi);
  }

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  /** Editing is on only when it was asked for AND somebody is listening for the result. */
  private get editingOn(): boolean {
    return this.editableOn && !!this.opts.onEdit;
  }

  /**
   * CANVAS coordinates: y = 0 is the top of the element, which is the top of the time ruler.
   * Only the ruler's own hit test wants this.
   */
  private canvasPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /**
   * PLOT coordinates: y = 0 is the first pitch row.
   *
   * The matching half of the `ctx.translate` in `draw()`. Everything that hit-tests a rectangle,
   * a row or the pitch scrollbar goes through here, so the ruler's height is accounted for
   * exactly once on the way in and exactly once on the way out. A y below zero means the pointer
   * is on the ruler.
   */
  private localPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const p = this.canvasPoint(e);
    return { x: p.x, y: p.y - this.rulerH };
  }

  /** Is the pointer on the TIME ruler — the horizontal axis's own zoom target? */
  private overTimeRuler(e: { clientX: number; clientY: number }): boolean {
    const rh = this.rulerH;
    if (rh <= 0) return false;
    const p = this.canvasPoint(e);
    return p.y >= 0 && p.y < rh && p.x >= this.gutterPx;
  }

  /** The rect under a point, from what was last PAINTED. Null over the gutter or empty space. */
  private hitTest(x: number, y: number): RollRect | null {
    if (x < this.gutterPx) return null;
    // Backwards, so the rect drawn last (and therefore on top) is the one you grabbed.
    for (let i = this.rects.length - 1; i >= 0; i--) {
      const r = this.rects[i];
      // A very thin rect is unclickable without a little padding either side of it.
      const pad = r.w < 6 ? 3 : 0;
      if (x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y && y <= r.y + r.h) return r;
    }
    return null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    // A gesture that is somehow still open — a `pointerup` swallowed by a native drag, or a
    // synthetic press from the harness that never had one — must not survive into the next
    // press, or the following mouse move drags a note nobody grabbed.
    this.cancelGesture();
    const { x, y } = this.localPoint(e);

    /*
     * PANNING COMES FIRST, and it is allowed to start anywhere — including over the label
     * gutter, because a pan is the one gesture that can never be mistaken for a seek.
     *
     * The middle button and Space are the two gestures that mean "move the picture" in every
     * editor a player has ever used, and they are what answers "I wanna be able to scroll up
     * and down" for somebody who reaches for the mouse before the wheel. Note what this
     * REPLACES: nothing. Every button but the left one was refused outright until v1.3, which
     * is why the middle button has never done anything here.
     */
    const wantsPan = e.button === 1 || (this.spaceDown && (e.button === undefined || e.button === 0));
    if (wantsPan) {
      e.preventDefault();
      this.beginPan(e.pointerId, x, y, true);
      return;
    }

    // The scrollbar on the right-hand edge. Before the hit-test, or a note underneath it would
    // take a press aimed at the bar — the bar is drawn on top, so it must be hit first too.
    if (this.beginVScroll(e, x, y)) return;

    // The gutter is a label column, not part of the timeline: a click there would otherwise
    // always mean "seek to zero", which is not what anybody reaching for a label wants.
    if (x < this.gutterPx) return;
    if (e.button !== undefined && e.button !== 0) return;

    const hit = this.hitTest(x, y);

    /*
     * A RECTANGLE AND EMPTY SPACE MEAN DIFFERENT THINGS. This is the reported bug's home.
     *
     * On a rectangle: select THAT note, alone, and do not move the playhead. The complaint
     * was "all the previous notes before it highlight" — so a PLAIN press REPLACES the
     * selection with a one-element set and never adds to it, and there is no longer any fill
     * keyed off the playhead at all, which is what was actually painting the smear. The only
     * way to end up with more than one note selected is to hold a modifier down, which is a
     * thing the player did on purpose.
     *
     * On empty space: seek, exactly as before, and clear the selection — unless Shift is
     * down, which makes it a rubber band instead. Invariant 9.
     *
     * Note for whoever maintains scripts/verify.mjs: the click-to-seek checks dispatch a lone
     * `pointerdown` at the canvas's vertical middle. If a rectangle happens to be there, the
     * click is now a selection and the transport will not move. `probe().emptyRowY` exists
     * for exactly that: click at that y and the press is guaranteed to land on background.
     */
    if (hit) {
      const id = hit.note.noteId;

      /*
       * A modifier on a rectangle is a TOGGLE, and nothing else. Invariant 9.
       *
       * No seek, no `onNoteSelect` and no drag armed. `onNoteSelect` means "the player is
       * pointing at this one note" to everybody who consumes it — firing it here would tell
       * the staff to light up one note while the roll shows five, which is precisely the
       * disagreement between views that invariant 4 exists to prevent. The full set goes out
       * through `onSelectionChange` instead.
       */
      if (id && (e.shiftKey || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.toggleSelection(id);
        return;
      }

      /*
       * Grabbing a note that is ALREADY part of a multi-selection grabs the whole selection.
       *
       * This is the entire point of the feature: eight octave-doubled notes, one drag. So the
       * selection is left alone here rather than replaced — replacing it is what would make a
       * group drag impossible, because the press that starts the drag would destroy the group
       * first. A press that turns out not to travel collapses back to the one note on
       * pointerUP, which keeps "click a note, get that note" true either way.
       */
      const inGroup = !!id && this.selection.has(id) && this.selection.size > 1;
      if (!inGroup) {
        // Replaced, not extended. Nothing else can be left tinted by a plain click.
        this.changeSelection(id ? new Set([id]) : new Set());
        this.opts.onNoteSelect?.(id, this.viewportRect(hit));
      }

      if (this.editingOn && id) {
        const ids = inGroup ? [...this.selection] : [id];
        const idSet = new Set(ids);
        // Measured now, once, while the notes are still where they started.
        this.groupLimits = this.groupStats(idSet);
        const nearRightEdge = x >= hit.x + hit.w - RESIZE_GRIP_PX;
        this.gesture = nearRightEdge
          ? {
              kind: 'resize',
              pointerId: e.pointerId,
              note: hit.note,
              noteId: id,
              ids,
              idSet,
              startX: x,
              baseDurationSec: hit.note.endSec - hit.note.startSec,
              deltaSec: 0,
              moved: false
            }
          : {
              kind: 'move',
              pointerId: e.pointerId,
              note: hit.note,
              noteId: id,
              ids,
              idSet,
              startX: x,
              startY: y,
              deltaSec: 0,
              deltaSemitones: 0,
              moved: false
            };
        this.capture(e.pointerId);
        e.preventDefault();
      }
      this.draw();
      return;
    }

    /*
     * SHIFT ON EMPTY BACKGROUND IS THE RUBBER BAND. See invariant 9 for who gets the bare drag
     * and why.
     *
     * It deliberately does NOT seek. A band is a selection gesture; moving the playhead as a
     * side effect of starting one loses the player's place in the take for no reason they
     * asked for. Cmd as well means "add to what I already had" — without it the band IS the
     * selection, which is what makes a second band a correction rather than an accumulation.
     */
    if (e.shiftKey) {
      const additive = !!(e.metaKey || e.ctrlKey);
      this.gesture = {
        kind: 'band',
        pointerId: e.pointerId,
        startX: x,
        startY: y,
        x,
        y,
        additive,
        base: additive ? [...this.selection] : [],
        moved: false
      };
      if (!additive) this.changeSelection(new Set());
      this.capture(e.pointerId);
      e.preventDefault();
      this.canvas.style.cursor = 'crosshair';
      this.draw();
      return;
    }

    // Empty background: seek, deselect, and arm a pan. The pan only becomes a pan once the
    // pointer has actually travelled, so a plain click stays a plain click — and the seek has
    // already happened by then, which is what the DAW-timeline reflex expects and what the
    // harness's lone `pointerdown` needs.
    const sec = this.xToSec(x);
    if (Number.isFinite(sec)) {
      const clamped = this.durationSec > 0 ? Math.max(0, Math.min(this.durationSec, sec)) : Math.max(0, sec);
      this.opts.onSeek(clamped);
    }
    this.changeSelection(new Set());
    this.opts.onNoteSelect?.(null, this.viewportRect(null, x, y));
    // Horizontal only, and only when there is a sheet to scroll. See the `vertical` field on
    // the pan gesture for why this one does not touch the pitch axis. Armed whenever there is
    // anywhere to pan TO — i.e. whenever the time axis is zoomed in at all.
    if (!this.isTimeZoomedOut()) this.beginPan(e.pointerId, x, y, false);
    this.draw();
  };

  /** One place a pan starts, so the middle button, Space and the bare drag cannot diverge. */
  private beginPan(pointerId: number, x: number, y: number, vertical: boolean): void {
    const win = this.getTimeWindow();
    this.gesture = {
      kind: 'pan',
      pointerId,
      startX: x,
      startY: y,
      startScroll: 0,
      startFromSec: win.fromSec,
      // Frozen at the press: the gearing must not change while the hand is moving, and a
      // re-engrave underneath a drag must not change how far the hand moves the picture.
      startSecPerPx: (win.toSec - win.fromSec) / Math.max(1, this.plotWidth),
      startTopMidi: this.scrollTopMidi,
      vertical,
      moved: false
    };
    this.capture(pointerId);
    // Only the deliberate pans say so straight away. The bare left-drag has to look like a
    // click until it has travelled, because most of the time that is exactly what it was.
    if (vertical) this.canvas.style.cursor = 'grabbing';
  }

  /**
   * A press on the vertical scrollbar: drag the thumb, or jump a page by pressing the track.
   *
   * Returns true when it took the press. The track click is a page rather than a jump-to-here
   * because the thumb is 8px wide and a mis-aimed press that teleported the pitch window would
   * be indistinguishable from a bug.
   */
  private beginVScroll(e: PointerEvent, x: number, y: number): boolean {
    const bar = this.vbar;
    if (!bar) return false;
    if (e.button !== undefined && e.button !== 0) return false;
    if (x < bar.x - (VBAR_GRAB_PX - bar.w) || x > bar.x + bar.w + 2) return false;
    e.preventDefault();
    const rows = this.visibleRows;
    if (y < bar.thumbY || y > bar.thumbY + bar.thumbH) {
      // The track. One pane of pitch, in the direction pressed.
      const dir = y < bar.thumbY ? 1 : -1;
      if (this.applyScrollTop(this.scrollTopMidi + dir * rows * 0.9)) {
        this.markUserVertical();
        this.reportView(true);
        this.draw();
      }
      return true;
    }
    // Semitones per pixel of THUMB travel: the thumb crosses `trackH - thumbH` pixels while the
    // window crosses `span - rows` semitones, so those are the two numbers that have to divide.
    const travel = Math.max(1, bar.trackH - bar.thumbH);
    this.gesture = {
      kind: 'vscroll',
      pointerId: e.pointerId,
      startY: y,
      startTopMidi: this.scrollTopMidi,
      midiPerPx: Math.max(0, bar.span - rows) / travel,
      minTop: bar.lo + rows,
      maxTop: bar.hi,
      moved: false
    };
    this.capture(e.pointerId);
    return true;
  }

  /**
   * The limits a group drag must respect, measured once when the drag starts.
   *
   * Held beside the gesture rather than inside it because a resize and a move want different
   * fields out of the same measurement, and because recomputing it on every pointermove would
   * walk the whole note list sixty times a second to learn a number that cannot change.
   *
   * They exist so a GROUP moves as a group. Clamping each note separately — which is what the
   * integrator does, correctly, as its last line of defence — would let the low note of a run
   * stop at midi 0 while the rest carried on down, shearing a shape the player was moving as
   * one thing. Same for time at second 0, and for length at the shortest note in the set.
   */
  private groupLimits: GroupLimits = {
    minStartSec: 0,
    maxEndSec: 0,
    minMidi: 0,
    maxMidi: 127,
    minDurationSec: 1
  };

  private groupStats(ids: Set<string>): GroupLimits {
    let minStartSec = Number.POSITIVE_INFINITY;
    let maxEndSec = Number.NEGATIVE_INFINITY;
    let minMidi = Number.POSITIVE_INFINITY;
    let maxMidi = Number.NEGATIVE_INFINITY;
    let minDurationSec = Number.POSITIVE_INFINITY;
    for (const n of this.notes) {
      if (!n.noteId || !ids.has(n.noteId)) continue;
      minStartSec = Math.min(minStartSec, n.startSec);
      maxEndSec = Math.max(maxEndSec, n.endSec);
      minMidi = Math.min(minMidi, n.midi);
      maxMidi = Math.max(maxMidi, n.midi);
      minDurationSec = Math.min(minDurationSec, n.endSec - n.startSec);
    }
    return Number.isFinite(minStartSec)
      ? { minStartSec, maxEndSec, minMidi, maxMidi, minDurationSec }
      : { minStartSec: 0, maxEndSec: 0, minMidi: 0, maxMidi: 127, minDurationSec: 1 };
  }

  private capture(pointerId: number): void {
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {
      /* synthetic pointer, or a browser that will not capture. The window listeners cover it. */
    }
  }

  /** Cursor feedback. It has to tell the truth or the gestures are undiscoverable. */
  private onPointerMove = (e: PointerEvent): void => {
    const { x, y } = this.localPoint(e);
    this.hoverX = x;
    this.hoverY = y;
    this.hovering = true;
    // A modifier can go down or come up between two pointer events without a key event ever
    // reaching this window (it was pressed while another app had focus). Take the truth from
    // whichever event arrives last rather than trusting either one alone.
    this.bandModifier = e.shiftKey;
    if (this.gesture) return;
    this.refreshCursor();
    this.reportHover(this.hitTest(x, y)?.note.noteId ?? null);
  };

  private onPointerLeave = (): void => {
    this.hovering = false;
    this.reportHover(null);
  };

  /**
   * Cross-highlight (#30d), outward: point at a rectangle and the SHEET rings the notehead.
   *
   * Coalesced to one report per CHANGED note. A pointermove fires dozens of times a second and
   * the other end of this is an SVG rebuild on the sheet; sending the same id sixty times would
   * make hovering the most expensive thing the app does. Never fired while a gesture is running
   * — during a drag the interesting note is the one being dragged, and it is already selected.
   */
  private reportHover(noteId: string | null): void {
    if (noteId === this.hoverNoteId) return;
    this.hoverNoteId = noteId;
    this.opts.onNoteHover?.(noteId);
  }

  /**
   * Cross-highlight, inward: the SHEET says the pointer is over these notes, so ring them here.
   *
   * Deliberately NOT the selection. A hover is a question ("is this the note I mean?") and a
   * selection is an answer; drawing them the same way would make pointing at a notehead look
   * like it had already changed what a Delete would remove. Never echoed back through
   * `onNoteHover` — that is how a two-view highlight ends up in a loop.
   */
  setHover(noteIds: ReadonlyArray<string>): void {
    const next = new Set(noteIds);
    if (next.size === this.hovered.size && [...next].every((id) => this.hovered.has(id))) return;
    this.hovered = next;
    this.draw();
  }

  /**
   * The one place the cursor is decided, because it has two inputs — where the pointer is and
   * which modifiers are down — and only one of them produces an event when it changes.
   *
   * The crosshair is the whole discoverability story for the rubber band: hold Shift over
   * empty plot and the pointer says, without a tooltip or a manual, that a drag here now means
   * something else. It appears over BACKGROUND only. Over a rectangle the same Shift means
   * "toggle this note", so a crosshair there would be advertising a band that will not start.
   */
  private refreshCursor(): void {
    if (this.gesture || !this.hovering) return;
    const x = this.hoverX;
    const y = this.hoverY;
    // Space is the pan modifier, so say so with an open hand before anything else is decided:
    // over a note, over the gutter, over the scrollbar, a Space-drag pans all the same.
    if (this.spaceDown) {
      this.canvas.style.cursor = 'grab';
      return;
    }
    const bar = this.vbar;
    if (bar && x >= bar.x - (VBAR_GRAB_PX - bar.w) && x <= bar.x + bar.w + 2) {
      this.canvas.style.cursor = 'default';
      return;
    }
    if (x < this.gutterPx) {
      this.canvas.style.cursor = 'default';
      return;
    }
    const hit = this.hitTest(x, y);
    if (!hit) {
      this.canvas.style.cursor = this.bandModifier ? 'crosshair' : 'pointer';
      return;
    }
    // A modifier over a rectangle is a toggle, not a drag. Say "you can click this".
    if (!this.editingOn || this.bandModifier) {
      this.canvas.style.cursor = 'pointer';
      return;
    }
    this.canvas.style.cursor = x >= hit.x + hit.w - RESIZE_GRIP_PX ? 'ew-resize' : 'move';
  }

  private onWindowPointerMove = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g) return;
    // The button is not down any more, so the release happened somewhere we never heard about
    // (a native drag, a context menu, the window losing focus). Let go rather than carry on
    // dragging a note the player is no longer holding. `buttons` is undefined on some
    // synthetic events, hence the explicit zero test rather than a falsy one.
    if (e.buttons === 0) {
      this.cancelGesture();
      this.draw();
      return;
    }
    const { x, y } = this.localPoint(e);

    if (g.kind === 'pan') {
      const dx = x - g.startX;
      const dy = y - g.startY;
      if (!g.moved && Math.abs(dx) < DRAG_SLOP_PX && Math.abs(g.vertical ? dy : 0) < DRAG_SLOP_PX) return;
      g.moved = true;
      this.canvas.style.cursor = 'grabbing';
      // Dragging the picture LEFT means moving further into the take, so the window goes up.
      //
      // ABSOLUTE FROM THE PRESS, expressed as a pan from where the window is NOW. The gearing
      // was frozen at pointer-down (`startSecPerPx`) so a re-engrave mid-drag cannot change how
      // far the hand moves the picture; the delta is recomputed against the live window each
      // move, so the reducer's own clamping at an edge is not fought by a stale absolute.
      const wantedFrom = g.startFromSec - dx * g.startSecPerPx;
      this.command({ kind: 'pan', deltaSec: wantedFrom - this.getTimeWindow().fromSec, source: 'roll' });
      if (g.vertical) {
        // The picture follows the hand: drag DOWN and the higher pitches come into view from
        // above, so the pitch at the top edge goes UP.
        if (this.applyScrollTop(g.startTopMidi + dy / this.pxPerSemitone)) {
          this.markUserVertical();
          this.reportView(false);
          this.draw();
        }
      }
      return;
    }

    if (g.kind === 'vscroll') {
      const dy = y - g.startY;
      if (!g.moved && Math.abs(dy) < 1) return;
      g.moved = true;
      // The thumb goes DOWN as the pitch window goes DOWN the keyboard, so the sign flips.
      const wanted = Math.max(g.minTop, Math.min(g.maxTop, g.startTopMidi - dy * g.midiPerPx));
      if (!this.applyScrollTop(wanted)) return;
      this.markUserVertical();
      this.reportView(false);
      this.draw();
      return;
    }

    if (g.kind === 'band') {
      g.x = x;
      g.y = y;
      // A band commits after a few pixels in EITHER axis: a thin horizontal sweep along one
      // pitch row is a completely normal way to grab a run of notes, and demanding travel in
      // both axes would refuse it.
      if (!g.moved && (Math.abs(x - g.startX) >= BAND_MIN_PX || Math.abs(y - g.startY) >= BAND_MIN_PX)) {
        g.moved = true;
      }
      this.canvas.style.cursor = 'crosshair';
      this.applyBand(g);
      this.draw();
      return;
    }

    const free = e.altKey;
    const limits = this.groupLimits;
    if (g.kind === 'move') {
      const from = this.xToWritten(g.startX);
      const to = this.xToWritten(x);
      const rawDelta = Number.isFinite(from) && Number.isFinite(to) ? to - from : 0;
      // Snap the RESULTING onset, not the delta: snapping a delta leaves a note that was
      // already off the grid exactly as far off it as it started. For a group it is the
      // GRABBED note's onset that lands on the grid and everything else that keeps its
      // spacing from it — the alternative, snapping each note independently, would collapse
      // the very off-grid detail a player selects a run in order to preserve.
      const target = this.snap(g.note.startSec + rawDelta, free);
      // Clamped for the whole group at once: the earliest selected note is the one that
      // reaches second 0 first, and when it does, everything stops together.
      const writtenEnd = this.durationSec > 0
        ? Math.max(0, this.durationSec - this.originSec)
        : Number.POSITIVE_INFINITY;
      const maxDelta = Number.isFinite(writtenEnd)
        ? Math.max(0, writtenEnd - limits.maxEndSec)
        : Number.POSITIVE_INFINITY;
      const deltaSec = Math.min(maxDelta, Math.max(target - g.note.startSec, -limits.minStartSec));
      const { rowH } = this.geometry();
      /*
       * A vertical deadzone, because moving a note in TIME is now the main event.
       *
       * The sheet's note popover is gone, so this gesture is the only way to move a note
       * along the bar. A horizontal drag with a few pixels of hand-wobble in it must not
       * transpose anything: `Math.round` alone flips at half a row, which on a 150px pane is
       * about five pixels of accidental semitone. Six tenths of a row to commit to the first
       * step, plain rounding after that.
       */
      const rows = rowH > 0 ? (g.startY - y) / rowH : 0;
      const wanted = Math.abs(rows) < 0.6 ? 0 : Math.round(rows);
      const deltaSemitones = clampSemitoneDelta(wanted, limits);
      if (deltaSec === g.deltaSec && deltaSemitones === g.deltaSemitones) return;
      g.deltaSec = deltaSec;
      g.deltaSemitones = deltaSemitones;
      g.moved = g.moved || Math.abs(x - g.startX) >= DRAG_SLOP_PX || Math.abs(y - g.startY) >= DRAG_SLOP_PX;
      this.opts.onEditPreview?.(this.moveEdit(g.ids, g.noteId, deltaSec, deltaSemitones));
      this.draw();
      return;
    }

    // resize
    const end = this.xToWritten(x);
    if (!Number.isFinite(end)) return;
    const snapped = this.snap(end, free);
    const min = free ? MIN_PREVIEW_DUR_SEC : this.snapSec;
    const durationSec = Math.max(min, snapped - g.note.startSec);
    // The delta the GROUP takes. Floored so the shortest note in the set never goes through
    // zero on the way — one note collapsing while the rest shrink is not one gesture.
    const writtenEnd = this.durationSec > 0
      ? Math.max(0, this.durationSec - this.originSec)
      : Number.POSITIVE_INFINITY;
    const maxDelta = Number.isFinite(writtenEnd)
      ? Math.max(0, writtenEnd - limits.maxEndSec)
      : Number.POSITIVE_INFINITY;
    const deltaSec = Math.min(
      maxDelta,
      Math.max(durationSec - g.baseDurationSec, min - limits.minDurationSec)
    );
    if (deltaSec === g.deltaSec) return;
    g.deltaSec = deltaSec;
    g.moved = g.moved || Math.abs(x - g.startX) >= DRAG_SLOP_PX;
    this.opts.onEditPreview?.(this.resizeEdit(g.ids, g.noteId, g.baseDurationSec, deltaSec));
    this.draw();
  };

  /**
   * The band's selection, recomputed from scratch on every move.
   *
   * From scratch and not incrementally, because a band that only ever grew would be unable to
   * let go of a note the player dragged back off — and "I overshot, let me pull it back" is
   * the most common thing anybody does with a rubber band.
   *
   * What counts as caught is INTERSECTION, not containment: a long note whose middle you swept
   * through is a note you meant, and requiring the whole rectangle inside the band makes held
   * notes unselectable at any sensible zoom.
   */
  private applyBand(g: Extract<Gesture, { kind: 'band' }>): void {
    const next = new Set(g.base);
    if (g.moved) {
      const b = bandBox(g, this.gutterPx);
      for (const r of this.rects) {
        const id = r.note.noteId;
        if (!id) continue;
        if (r.x <= b.x + b.w && r.x + r.w >= b.x && r.y <= b.y + b.h && r.y + r.h >= b.y) next.add(id);
      }
    }
    this.changeSelection(next);
  }

  /** One note or many, decided in ONE place so no caller can pick the wrong variant. */
  private moveEdit(ids: string[], grabbedId: string, deltaSec: number, deltaSemitones: number): RollEdit {
    return ids.length > 1
      ? { kind: 'moveMany', noteIds: [...ids], deltaSec, deltaSemitones }
      : { kind: 'move', noteId: grabbedId, deltaSec, deltaSemitones };
  }

  /** Ditto. Note the single-note variant still reports an ABSOLUTE length: unchanged contract. */
  private resizeEdit(ids: string[], grabbedId: string, baseDurationSec: number, deltaSec: number): RollEdit {
    return ids.length > 1
      ? { kind: 'resizeMany', noteIds: [...ids], deltaSec }
      : { kind: 'resize', noteId: grabbedId, newDurationSec: baseDurationSec + deltaSec };
  }

  private onWindowPointerUp = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    // ON COMMIT, NEVER LIVE. Any Align window that arrived while the pointer was down has been
    // waiting here — see `setTimeWindow`. Applied first, so the edit emitted below is drawn on
    // the ruler the player will be looking at a moment later rather than on a stale one.
    this.flushDeferredWindow();
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* never captured */
    }
    this.canvas.style.cursor = 'pointer';

    if (g.kind === 'pan' || g.kind === 'vscroll') {
      // The gesture ENDED, which is the moment a saved view is worth writing down.
      if (g.moved) this.reportView(true);
      this.refreshCursor();
      this.draw();
      return;
    }
    if (g.kind === 'band') {
      // Nothing to emit: a band only ever changed the selection, and it did that live so the
      // count beside it was true the whole way. Letting go just takes the box off the screen.
      this.refreshCursor();
      this.draw();
      return;
    }
    this.opts.onEditPreview?.(null);
    if (!g.moved) {
      /*
       * A press that never travelled is a selection, not an edit.
       *
       * For a single note it already happened on pointerDOWN. For a press on one member of a
       * group the down deliberately left the group alone (so the drag could have moved all of
       * it), so the collapse to the one note happens here instead — which is what makes
       * "click a note and you get that note" true whether or not it was already in a
       * selection, without ever making a group undraggable.
       */
      if (g.ids.length > 1) {
        this.changeSelection(new Set([g.noteId]));
        this.opts.onNoteSelect?.(g.noteId, this.viewportRect(this.rectForId(g.noteId)));
      }
      this.draw();
      return;
    }
    if (g.kind === 'move') {
      if (g.deltaSec === 0 && g.deltaSemitones === 0) {
        this.draw();
        return;
      }
      this.emit(this.moveEdit(g.ids, g.noteId, g.deltaSec, g.deltaSemitones));
      return;
    }
    if (Math.abs(g.deltaSec) < 1e-6) {
      this.draw();
      return;
    }
    this.emit(this.resizeEdit(g.ids, g.noteId, g.baseDurationSec, g.deltaSec));
  };

  /**
   * Let go of whatever was in flight WITHOUT emitting anything.
   *
   * A band is the exception that is not one: it has no edit to abandon, and the notes it had
   * already caught stay caught. Throwing a half-built selection away because a pointerup went
   * missing would be losing work the player can see on screen. (Escape is different, and says
   * so where it is handled: that one is the player asking for the band to be forgotten.)
   */
  private cancelGesture(): void {
    if (!this.gesture) return;
    this.gesture = null;
    this.flushDeferredWindow();
    this.opts.onEditPreview?.(null);
    this.canvas.style.cursor = 'pointer';
  }

  /** The painted rectangle for an id, or null if it is not on screen this frame. */
  private rectForId(noteId: string): RollRect | null {
    for (const r of this.rects) if (r.note.noteId === noteId) return r;
    return null;
  }

  /**
   * Double-click on empty space adds a note of the current grid length.
   *
   * On a rect it deletes that note. Empty space and notes are deliberately symmetric:
   * double-click creates here, double-click removes there.
   *
   * The end is kept inside the take. The pipeline's guards DROP any note whose onset is past
   * the end of the audio (design notes §4.8), so a note added off the right-hand end would
   * simply never come back — an add that silently does nothing, which is the worst possible
   * outcome for the gesture people will use most.
   */
  private onDoubleClick = (e: MouseEvent): void => {
    if (!this.editingOn) return;
    const { x, y } = this.localPoint(e);
    if (x < this.gutterPx) {
      // DOUBLE-CLICK THE RULER TO FIT. This is what the "Fit" and "Reset view" chips used to
      // be, moved onto the thing they act on: the gutter is the pitch axis, and double-clicking
      // an axis to make everything fit is the same gesture as double-clicking a column edge in
      // a spreadsheet. Two chips of permanent screen furniture for something done once a
      // session was a poor trade on a bar that has to survive a 360 px window.
      e.preventDefault();
      this.fitVertical();
      return;
    }
    const hit = this.hitTest(x, y);
    if (hit?.note.noteId) {
      e.preventDefault();
      this.changeSelection(new Set());
      this.emit({ kind: 'delete', noteId: hit.note.noteId });
      return;
    }
    // WRITTEN SECONDS, ON THE APP'S ORIGIN AND NO OTHER. `edit/rollPerformance.ts` adds the app's
    // origin straight back onto this number, so the two have to be the same origin or a take with
    // leading silence puts the new note exactly one silence away from the pointer. They are the
    // same one now — see `originSec` above, which no longer computes its own (codex-critique §7).
    const written = this.xToWritten(x);
    if (!Number.isFinite(written)) return;
    e.preventDefault();
    const durationSec = this.snapSec;
    let startSec = Math.max(0, this.snap(written, e.altKey));
    if (this.durationSec > 0) {
      const lastWritten = this.durationSec - this.originSec - durationSec;
      if (lastWritten > 0) startSec = Math.min(startSec, lastWritten);
    }
    this.emit({ kind: 'add', midi: this.yToMidi(y), startSec, durationSec });
  };

  /**
   * The note under a point in canvas coordinates, or null.
   *
   * Public so the harness can drive a real click at a place it knows is a note (or is not
   * one) rather than guessing, and so the integrator can hit-test without duplicating the
   * geometry. Reads the last painted frame, so it agrees with the picture by construction.
   */
  noteIdAt(x: number, y: number): string | null {
    return this.hitTest(x, y)?.note.noteId ?? null;
  }

  /**
   * THE WHEEL, AND NO KEY TO HOLD DOWN.
   *
   *   over the GUTTER      zoom the pitch axis, about the pointer
   *   over the RULER       zoom the time axis, about the pointer
   *   over the NOTES       the axis you MOVE is the axis you zoom (G15)
   *   pinch (ctrl-wheel)   pitch zoom, wherever the pointer is
   *   Alt + wheel          the same — kept, because it was shipped
   *   Shift + wheel        pan time
   *
   * WHERE THE POINTER IS, NOT WHICH KEY IS DOWN. Zoom used to need Alt, which is a thing you
   * have to be told and then remember, and the complaint was exactly that: nothing on screen
   * says a modifier exists. The gutter is a RULER — it is the pitch axis drawn as a keyboard —
   * and a wheel over a ruler meaning "zoom that axis" is a convention the player already has
   * from every DAW, discoverable by trying it once. Over the NOTES both axes zoom now, damped
   * hard, so a trackpad reaches either zoom without a modifier and cannot jump (G15).
   *
   * A trackpad pinch arrives as a wheel event with `ctrlKey` set, whether or not anybody is
   * holding ctrl. It is handled as zoom rather than forwarded to the sheet: the roll is under
   * the pointer, so the roll is what the gesture is about. `preventDefault` is unconditional on
   * that path — without it the browser zooms the whole page instead.
   *
   * The time half is still a REQUEST: the roll owns neither the sheet's zoom nor its scroll, so
   * it asks and redraws from the sheet's new numbers on the next frame. The pitch half is the
   * roll's own and is applied here.
   */
  private onWheel = (e: WheelEvent): void => {
    const zoom = (delta: number) => wheelZoomFactor(delta, e.deltaMode);
    /*
     * A PINCH IS THE ONLY THING THAT ZOOMS FROM THE FINGERS (H1).
     *
     * macOS delivers a trackpad pinch to a web view as a wheel event with `ctrlKey` forced on,
     * whether or not anybody is touching ctrl; Safari/WKWebView ALSO emits the older
     * `gesturestart`/`gesturechange` pair, which is why `onGestureChange` below exists. Both
     * roads end here, at the same two rules:
     *
     *     pinch                -> HORIZONTAL zoom, the TIME axis, about the pointer
     *     Option (alt) + pinch -> VERTICAL zoom, the PITCH axis, about the pointer
     *
     * WHAT THIS REPLACES, and why it is a straight deletion rather than a tuning. The previous
     * model was "the axis you move is the axis you zoom": a bare two-finger swipe up/down zoomed
     * pitch and left/right zoomed time, with no modifier at all. It was reported as wrong and
     * hated, and the reason is not taste — a two-finger swipe is SCROLLING on every other surface
     * of every machine this runs on, so the one gesture a hand makes without thinking about it
     * was the one gesture that threw the picture away. Nothing about a swipe zooms now, at any
     * angle, over any part of this pane.
     */
    const pinch = e.ctrlKey || e.metaKey;

    if (pinch || e.altKey) {
      const d = e.deltaY || e.deltaX;
      if (d === 0) return;
      e.preventDefault();
      // Option picks the other axis. Alt on its own (no pinch) is kept as the pitch zoom a
      // plain MOUSE has always had here — a mouse cannot pinch, and it was shipped.
      if (e.altKey) {
        this.zoomVerticalAt(zoom(d), this.localPoint(e).y);
        return;
      }
      // One pinch, one zoom, whichever road WebKit chose to send it down. See `claimPinch`.
      if (pinch && !this.claimPinch('wheel')) return;
      this.zoomTimeAt(zoom(d), this.canvasPoint(e).x);
      return;
    }

    /*
     * THE TIME RULER (#29). A wheel over the band along the top zooms TIME, about the pointer.
     * The exact mirror of the rule the gutter already had — a wheel over a RULER zooms that
     * ruler's axis — and it is why the ruler is drawn at all. Unchanged by H1: a ruler is a
     * control, not the picture, so a scroll there has nothing else it could mean.
     */
    if (this.overTimeRuler(e)) {
      const d = e.deltaY || e.deltaX;
      if (d === 0) return;
      e.preventDefault();
      this.zoomTimeAt(zoom(d), this.canvasPoint(e).x);
      return;
    }

    // The same rule on the other ruler: the pitch gutter down the left zooms pitch.
    const overGutter = this.gutterPx > 0 && this.localPoint(e).x < this.gutterPx;
    if (overGutter && !e.shiftKey) {
      const d = e.deltaY || e.deltaX;
      if (d === 0) return;
      e.preventDefault();
      this.zoomVerticalAt(zoom(d), this.localPoint(e).y);
      return;
    }

    /*
     * EVERYTHING ELSE PANS, in whichever direction the fingers went.
     *
     *   two fingers left/right   -> pan TIME
     *   two fingers up/down      -> pan PITCH
     *   Shift + wheel            -> pan TIME (the mouse's way to the second axis; kept)
     *
     * Both axes at once, because a trackpad sends both components of one diagonal flick and
     * throwing one away makes the picture crab sideways under a hand that moved diagonally.
     */
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    let dx = e.deltaX * lines;
    let dy = e.deltaY * lines;
    if (e.shiftKey && dx === 0) {
      // Shift+wheel arrives as deltaX on some platforms and deltaY on others; a mouse with one
      // axis gets its only delta treated as sideways rather than losing the gesture.
      dx = dy;
      dy = 0;
    }
    if (dx === 0 && dy === 0) return;
    e.preventDefault();
    if (dx !== 0) {
      const win = this.getTimeWindow();
      this.panTimeBy((dx / Math.max(1, this.plotWidth)) * (win.toSec - win.fromSec));
    }
    if (dy !== 0) this.scrollVerticalBy(dy);
  };

  /**
   * Safari's own pinch, for the JUCE WebView.
   *
   * WKWebView reports a trackpad pinch as `gesturestart`/`gesturechange`/`gestureend` with a
   * CUMULATIVE `scale` since the gesture began, and — depending on the build — may not synthesise
   * the ctrl-wheel `onWheel` reads. Taking the RATIO against the previous event turns the
   * cumulative number into the same per-event multiplier a wheel produces, so both roads reach
   * `zoomTimeAt`/`zoomVerticalAt` with the same units and a pinch feels identical either way.
   *
   * Typed structurally rather than against `GestureEvent`, which is not in the standard DOM lib.
   */
  private gestureScale = 1;

  private onGestureStart = (e: Event): void => {
    e.preventDefault();
    this.gestureScale = (e as Event & { scale?: number }).scale ?? 1;
    this.pinch.reset();
  };

  private onGestureChange = (e: Event): void => {
    const g = e as Event & { scale?: number; altKey?: boolean; clientX?: number; clientY?: number };
    const scale = g.scale;
    if (!scale || !Number.isFinite(scale) || scale <= 0) return;
    e.preventDefault();
    const ratio = scale / (this.gestureScale > 0 ? this.gestureScale : 1);
    this.gestureScale = scale;
    // ACCUMULATED, NOT DROPPED (finding 10). The baseline advances on every event whether or not
    // the ratio was big enough to use, so a discarded fraction used to be gone for good; folded
    // in, it simply arrives one event later.
    const stepped = this.pinch.take(ratio);
    if (stepped === null) return;
    if (!this.claimPinch('gesture')) return;
    // Clamped by the same anti-jump step a wheel gets, so one violent pinch cannot throw the view.
    const factor = Math.min(WHEEL_ZOOM_MAX_STEP, Math.max(1 / WHEEL_ZOOM_MAX_STEP, stepped));
    const rect = this.canvas.getBoundingClientRect();
    const at = {
      clientX: g.clientX ?? rect.left + rect.width / 2,
      clientY: g.clientY ?? rect.top + rect.height / 2
    };
    if (g.altKey) this.zoomVerticalAt(factor, this.localPoint(at).y);
    else this.zoomTimeAt(factor, this.canvasPoint(at).x);
  };

  /**
   * The keyboard half of the selection: what you can do to a group without a mouse.
   *
   *   Esc            abandon the gesture in flight, or clear the selection
   *   Cmd/Ctrl + A   select every note drawn
   *   Delete/⌫       remove the selection
   *   Cmd/Ctrl + ↑/↓ octave up / octave down
   *   ← / →          nudge earlier / later by one snap unit
   *
   * On `window`, because the canvas is not focusable and making it so would put it in the tab
   * order ahead of the transport. Two guards make that safe. The event target is checked, so
   * this can never eat a backspace out of the BPM box; and `defaultPrevented` is checked, so a
   * handler closer to the event — the resize handle's own ↑/↓, which is a real focusable
   * element inside this same pane — keeps the key it already claimed.
   */
  private onKeyDown = (e: KeyboardEvent): void => {
    // Do this before any guard: the crosshair has to appear even when the pointer is over a
    // pane the roll is not going to act on.
    this.bandModifier = e.shiftKey;
    if (e.key === ' ' && !isTypingTarget(e.target)) this.spaceDown = true;
    this.refreshCursor();
    if (e.defaultPrevented || isTypingTarget(e.target)) return;

    const mod = e.metaKey || e.ctrlKey;

    /*
     * VERTICAL ZOOM FROM THE KEYBOARD, about the SELECTED note. Invariant 10.
     *
     * Alt and not Ctrl/Cmd, because those two are already the SHEET's zoom over this same pane
     * and one modifier cannot mean two zooms. Alt+↑/↓ also reads as "the vertical axis", which
     * is what it moves, and it is placed above the editing guard below because zooming is a
     * VIEW action — it must work with nothing selected and with editing switched off.
     */
    if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      this.zoomVertical(e.key === 'ArrowUp' ? VZOOM_IN_FACTOR : VZOOM_OUT_FACTOR);
      return;
    }
    // `e.code`, not `e.key`: on macOS Option+0 does not produce "0", it produces "º". Every
    // Alt-plus-a-character shortcut written against `key` is broken on this machine's own
    // keyboard, which is not a thing to find out in the field.
    if (e.altKey && !mod && (e.code === 'Digit0' || e.code === 'Numpad0')) {
      e.preventDefault();
      this.fitVertical();
      return;
    }

    if (e.key === 'Escape') {
      if (this.gesture) {
        e.preventDefault();
        // Escape out of a BAND means "forget this box", so the selection goes back to what it
        // was before the box started. Escape out of a move or a resize means "not that move" —
        // the notes stay selected, because the player is about to try the drag again.
        if (this.gesture.kind === 'band') this.changeSelection(new Set(this.gesture.base));
        this.cancelGesture();
        this.draw();
        return;
      }
      if (this.selection.size === 0) return;
      e.preventDefault();
      this.clearSelection();
      return;
    }

    if (mod && (e.key === 'a' || e.key === 'A')) {
      // Always swallowed. The browser's own ⌘A selects the app's chrome as text, which is
      // never the thing anybody wanted in a plugin window.
      e.preventDefault();
      this.selectAllVisible();
      return;
    }

    // Everything below CHANGES notes, so it needs somewhere to send the change and something
    // to send it about.
    if (!this.editingOn || this.selection.size === 0) return;

    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      this.deleteSelection();
      return;
    }
    if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      this.transposeSelection(e.key === 'ArrowUp' ? 12 : -12);
      return;
    }
    if (!mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      this.nudgeSelection(e.key === 'ArrowRight' ? 1 : -1);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.bandModifier = e.shiftKey;
    if (e.key === ' ') {
      this.spaceDown = false;
      // A pan that was armed by Space ends when Space does, even with the button still down —
      // otherwise letting go of the key mid-drag leaves a gesture nobody is holding any more.
      if (this.gesture?.kind === 'pan' && this.gesture.vertical) this.cancelGesture();
    }
    this.refreshCursor();
  };

  /** Focus went elsewhere, so we will never see the keyup. Assume nothing is held. */
  private onWindowBlur = (): void => {
    this.bandModifier = false;
    this.spaceDown = false;
    this.refreshCursor();
  };

  // -------------------------------------------------------------------------
  // Edits on the selection — one gesture, one edit, one undo step
  // -------------------------------------------------------------------------

  /**
   * Remove every selected note. Public so a toolbar button can do what Delete does.
   *
   * The selection is dropped first and on purpose: the notes are about to stop existing, and a
   * selection holding ids the score no longer contains is how a stale highlight survives a
   * rebuild and lights up whatever inherits the id.
   */
  deleteSelection(): void {
    if (!this.editingOn || this.selection.size === 0) return;
    const ids = [...this.selection];
    this.changeSelection(new Set());
    this.emit(ids.length > 1 ? { kind: 'deleteMany', noteIds: ids } : { kind: 'delete', noteId: ids[0] });
  }

  /**
   * Move the selection by semitones — ±12 is the octave fix this whole feature exists for.
   *
   * The transcriber octave-doubles runs, so "select the run, press ⌘↓" is the single gesture
   * that answers the single most common transcription error this engine makes.
   */
  transposeSelection(semitones: number): void {
    if (!this.editingOn || this.selection.size === 0 || semitones === 0) return;
    const ids = [...this.selection];
    const delta = clampSemitoneDelta(semitones, this.groupStats(new Set(ids)));
    // Already against the ceiling or the floor: do nothing rather than emit an edit that
    // changes nothing and costs the player a ⌘Z to get past.
    if (delta === 0) return;
    this.emit(this.moveEdit(ids, ids[0], 0, delta));
  }

  /** Shift the selection earlier or later by whole snap units. One arrow press, one unit. */
  nudgeSelection(units: number): void {
    if (!this.editingOn || this.selection.size === 0 || units === 0) return;
    const ids = [...this.selection];
    const limits = this.groupStats(new Set(ids));
    const deltaSec = Math.max(units * this.snapSec, -limits.minStartSec);
    if (deltaSec === 0) return;
    this.emit(this.moveEdit(ids, ids[0], deltaSec, 0));
  }

  /** One place edits leave the roll, so `pending` can never be forgotten. */
  private emit(edit: RollEdit): void {
    this.pending = edit;
    this.pendingIds = new Set(rollEditNoteIds(edit));
    this.opts.onEdit?.(edit);
    this.draw();
  }

  /** A rect in viewport coordinates, for whoever has to put a popover next to it. */
  private viewportRect(hit: RollRect | null, x = 0, y = 0): { x: number; y: number; w: number; h: number } {
    const r = this.canvas.getBoundingClientRect();
    if (!hit) return { x: r.left + x, y: r.top + y, w: 0, h: 0 };
    return { x: r.left + hit.x, y: r.top + hit.y, w: hit.w, h: hit.h };
  }

  // -------------------------------------------------------------------------
  // Probe
  // -------------------------------------------------------------------------

  /**
   * What the harness (and a bug report) needs to see. Read-only.
   *
   * NOTHING IS EVER REMOVED FROM THIS OBJECT. `scripts/verify.mjs` reads it field by field
   * and a missing one is a failed check, so a rename here is a broken test somewhere else.
   */
  probe(): {
    notes: number;
    durationSec: number;
    lowMidi: number;
    highMidi: number;
    width: number;
    height: number;
    gutterPx: number;
    plotWidth: number;
    plotHeight: number;
    originSec: number;
    barOneSec: number;
    /** The first rect's left edge, on the recording's clock. Should sit under the audio. */
    firstNoteSec: number | null;
    firstNoteMidi: number | null;
    /** Where that rect is drawn. An edit that changes a pitch MUST move this. */
    firstNoteY: number | null;
    firstNoteX: number | null;
    /**
     * 'model' once the sheet exists; 'ir' only before it does; 'performance' whenever
     * `setPerformanceNotes` is holding a take, in which case neither walk was consulted.
     */
    source: 'model' | 'ir' | 'performance';
    /** Worst |Δstart| between the live walk and the IR walk. Must be ~0 before any edit. */
    irDeltaSec: number | null;
    irNotes: number;
    /** The pitch labels actually painted in the gutter, low to high. */
    labels: string[];
    rowHeight: number;
    /** The height asked for, and the window's limits on it. See `clampRollHeight`. */
    wantedHeight: number;
    minHeight: number;
    maxHeight: number;

    // --- v1.2 ---------------------------------------------------------------
    /**
     * Always false, and kept so a check that asserted it cannot silently stop being asked.
     * The engraved-axis mode it described is deleted; see `map()`.
     */
    linked: boolean;
    /** True only when linking is on AND the sheet answered. Free mode otherwise. */
    linkedActive: boolean;
    /**
     * ALIGN: the stretch of RECORDING on screen, or null for the whole take.
     *
     * Deliberately beside `linkedActive`, which stays false: a window says WHERE the roll is
     * looking and `linkedActive` says whose x-axis it is drawing on. The second is still nobody
     * else's, which is the invariant that keeps a picture of a performance from re-spacing
     * itself, and this pair is how a check can tell the two claims apart.
     */
    windowFromSec: number | null;
    windowToSec: number | null;
    /** How many beats the shared ruler is pinned to. 0 = the roll is on its own even ruler. */
    anchorCount: number;
    /** What the middle of the plot means, in RECORDING seconds. The ruler, stated as a number. */
    midPlotSec: number;
    /** Kept as a permanent false: the sheet-geometry mode is deleted, not switched off. */
    hasSheetMap: boolean;
    /** Both permanently null, for the same reason. */
    zoomedContentWidth: number | null;
    sheetScrollLeft: number | null;
    /** The ids currently highlighted. */
    selection: string[];
    /**
     * How many notes are selected — the number the badge on the band prints.
     *
     * `selection.length` says the same thing. This is here anyway because it is the ONE number
     * a check about multi-selection wants, and reading `.length` off a possibly-null array in
     * a harness expression is how a check ends up passing on `undefined`.
     */
    selectionCount: number;
    /** A rubber band is being dragged right now. */
    bandActive: boolean;
    /** True when every rect painted this frame got its outline. */
    noteOutline: boolean;
    /** How thoroughly the gutter is naming rows right now. */
    labelMode: RollLabelMode;
    /** The switch. Editing also needs an `onEdit` — `editingLive` is the real answer. */
    editable: boolean;
    editingLive: boolean;
    showAllNames: boolean;
    /** The grid a drag snaps to, in seconds. */
    snapSec: number;
    /** The gesture in flight, if any. `'band'` and `'vscroll'` joined the list in v1.3. */
    dragging: 'pan' | 'move' | 'resize' | 'band' | 'vscroll' | null;
    /** The last edit emitted, still drawn provisionally until the next refresh(). */
    pendingEdit: RollEdit | null;
    /** How many rects were painted (visible ones only — clipped notes are not drawn). */
    drawnRects: number;
    /**
     * A y with no rectangle on it, for a click that is meant to land on background.
     *
     * A click on a rect now selects instead of seeking, so "click at half the height" is no
     * longer a safe way to drive click-to-seek. Null only when every visible row is occupied.
     */
    emptyRowY: number | null;

    // --- v1.3: the pitch axis is a window (invariant 10) ---------------------
    /**
     * How tall one semitone is, in px. THE number the rewrite is about.
     *
     * `rowHeight` above is the same number and stays for the harness's sake. It is not derived
     * from the pane's height any more: a taller pane shows MORE ROWS at the same row height,
     * which is what `visibleSemitones` is for.
     */
    pxPerSemitone: number;
    /** The fractional MIDI pitch at the TOP edge of the plot. The vertical scroll position. */
    scrollTopMidi: number;
    /** The lowest pitch row with any pixel on screen. Same number as `lowMidi`. */
    visibleLowMidi: number;
    /** The highest pitch row with any pixel on screen. Same number as `highMidi`. */
    visibleHighMidi: number;
    /** How many rows the pane is showing. This is what grows when the pane is dragged taller. */
    visibleSemitones: number;
    /** Is every note in the take on screen right now? */
    fitted: boolean;
    /** The player pressed Fit and has not moved since, so a pane resize will re-fit. */
    fitLocked: boolean;
    /** The take's own pitch range, padded — what Fit fits to. Not the drawn range any more. */
    contentLowMidi: number;
    contentHighMidi: number;
    /** The limits a wheel or a button may zoom between. Fit alone may go below the floor. */
    minPxPerSemitone: number;
    maxPxPerSemitone: number;
    /** Is there anywhere to scroll? The scrollbar is drawn exactly when this is true. */
    verticalScrollable: boolean;
    /** Auto-scroll to the sounding note during playback. */
    followPlayback: boolean;
    /** Milliseconds since the player last moved the pitch window. Auto-follow waits this out. */
    msSinceUserVertical: number | null;

    // --- the auto-edit pass's marks (see `setAutoMarks`) ---------------------
    /** How many notes are marked at all. */
    autoMarks: number;
    /** ...and which, so a check can name one rather than count them. */
    autoMarkIds: string[];
    /** How many of those actually got a halo painted this frame. */
    autoMarksDrawn: number;
    /**
     * Of the marked notes, how many are edits the app made.
     *
     * Equal to `autoMarks` now, and kept as its own field on purpose: it is the number the
     * harness has always asserted goes to zero when the player reviews an edit, and the claim
     * it makes ("no unreviewed change is still highlighted") is the one worth keeping. The
     * two can no longer differ because a mark that is not an applied edit cannot be made.
     */
    autoMarksApplied: number;

    // --- the time axis (#29 / #30) ------------------------------------------
    /** Seconds per plot pixel. The zoom, as one number. */
    secPerPx: number;
    /** True while the whole take is on screen, i.e. the time zoom is all the way out. */
    timeZoomedOut: boolean;
    /** The narrowest window the zoom will go to, and the widest. */
    minWindowSec: number;
    maxWindowSec: number;
    /** The time ruler's height in px, or 0 when the pane is too short to spare it. */
    rulerHeight: number;
    /** How many grid lines are on screen, and how many of them are bar lines. */
    gridMarks: number;
    barMarks: number;
    /** The bar numbers actually printed on the ruler this frame. */
    barLabels: string[];
    /** Cross-highlight: what the pointer is over here, and what the sheet says it is over. */
    hoverNoteId: string | null;
    hoveredFromSheet: string[];
  } {
    const first = this.notes[0] ?? null;
    const geo = this.geometry();
    const firstX = first ? this.writtenToX(first.startSec) : Number.NaN;
    const marks = this.gridMarks();
    return {
      notes: this.notes.length,
      durationSec: Number(this.durationSec.toFixed(3)),
      lowMidi: this.lowMidi,
      highMidi: this.highMidi,
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      gutterPx: this.gutterPx,
      plotWidth: Math.round(this.plotWidth),
      plotHeight: Math.round(this.plotHeight),
      originSec: Number(this.originSec.toFixed(3)),
      barOneSec: Number(this.barOneSec.toFixed(3)),
      firstNoteSec: first ? Number((first.startSec + this.originSec).toFixed(3)) : null,
      firstNoteMidi: first ? first.midi : null,
      firstNoteY: first ? Number(geo.yFor(first.midi).toFixed(2)) : null,
      firstNoteX: first && Number.isFinite(firstX) ? Number(firstX.toFixed(2)) : null,
      source: this.source,
      irDeltaSec: this.irDeltaSec === null ? null : Number(this.irDeltaSec.toFixed(5)),
      irNotes: this.irNotes,
      labels: [...this.labelsDrawn],
      rowHeight: Number(geo.rowH.toFixed(2)),
      wantedHeight: Math.round(this.wantedHeight),
      minHeight: clampRollHeight(0),
      maxHeight: clampRollHeight(Number.MAX_SAFE_INTEGER),

      linked: false,
      // Permanently false, and now structurally so: the roll has no second axis to draw on.
      linkedActive: false,
      windowFromSec: this.timeWindow ? Number(this.timeWindow.fromSec.toFixed(4)) : null,
      windowToSec: this.timeWindow ? Number(this.timeWindow.toSec.toFixed(4)) : null,
      // A window IS two anchors — its two ends — which is all `ui/app.ts` has ever sent. Kept
      // reporting the same number so a check that asserts "the shared ruler is pinned" still can.
      anchorCount: this.timeWindow ? 2 : 0,
      midPlotSec: Number(this.xToSec(this.gutterPx + this.plotWidth / 2).toFixed(4)),
      hasSheetMap: false,
      zoomedContentWidth: null,
      sheetScrollLeft: null,
      selection: [...this.selection],
      selectionCount: this.selection.size,
      bandActive: this.gesture?.kind === 'band',
      noteOutline: this.rects.length === 0 ? true : this.outlinedRects === this.rects.length,
      labelMode: this.labelMode,
      editable: this.editableOn,
      editingLive: this.editingOn,
      showAllNames: this.showAllNames,
      snapSec: Number(this.snapSec.toFixed(4)),
      dragging: this.gesture ? this.gesture.kind : null,
      pendingEdit: this.pending,
      drawnRects: this.rects.length,
      emptyRowY: this.emptyRowY(),

      pxPerSemitone: Number(this.pxPerSemitone.toFixed(3)),
      scrollTopMidi: Number(this.scrollTopMidi.toFixed(3)),
      visibleLowMidi: this.lowMidi,
      visibleHighMidi: this.highMidi,
      visibleSemitones: Number(this.visibleRows.toFixed(2)),
      fitted: this.isFitted,
      fitLocked: this.fitLocked,
      contentLowMidi: this.contentLowMidi,
      contentHighMidi: this.contentHighMidi,
      minPxPerSemitone: MIN_PX_PER_SEMITONE,
      maxPxPerSemitone: MAX_PX_PER_SEMITONE,
      verticalScrollable: this.vbar !== null,
      followPlayback: this.followPlayback,
      msSinceUserVertical: Number.isFinite(this.lastUserVerticalMs)
        ? Math.round(now() - this.lastUserVerticalMs)
        : null,

      autoMarks: this.autoMarks.size,
      autoMarkIds: [...this.autoMarks],
      autoMarksDrawn: this.autoMarksDrawn,
      autoMarksApplied: this.autoMarks.size,

      secPerPx: Number(secPerPx(this.getTimeWindow(), this.plotWidth).toFixed(6)),
      timeZoomedOut: this.isTimeZoomedOut(),
      minWindowSec: MIN_WINDOW_SEC,
      maxWindowSec: Number(this.timeLimits().durationSec.toFixed(3)),
      rulerHeight: this.rulerH,
      gridMarks: marks.length,
      barMarks: marks.filter((m) => m.level === 'bar').length,
      barLabels: marks.filter((m) => m.label !== null).map((m) => m.label as string),
      hoverNoteId: this.hoverNoteId,
      hoveredFromSheet: [...this.hovered]
    };
  }

  /**
   * The rectangles as painted, with their note ids — geometry, not a count.
   *
   * `probe().drawnRects` answers "how many"; this answers "where, and which note". It exists
   * for the one check that matters most in this file: comparing a rectangle's x against the x
   * of the notehead that produced it, over on the sheet. A count cannot do that, and neither
   * can recomputing the position from the same map the roll drew with — that would be
   * comparing a number with itself.
   *
   * Canvas coordinates, so a caller can dispatch a pointer event straight at one — hence the
   * `rulerH` on the y. `this.rects` is in PLOT space, which is what `draw()` works in after
   * its `translate(0, rulerH)` and what `localPoint()` hands the hit test; a y taken straight
   * from there lands one ruler-height too high, which since the time axis grew a ruler (#29)
   * meant every synthetic click aimed at a rectangle missed it.
   */
  paintedRects(): Array<{
    noteId: string | null;
    midi: number;
    /**
     * The onset in WRITTEN seconds — `x`'s own input, so a caller can put the same moment on a
     * third axis (the waveform strip's) instead of guessing it back out of the pixel. Add
     * `probe().originSec` for the RECORDING clock. See §4.13 on the two clocks.
     */
    startSec: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }> {
    const rulerH = this.rulerH;
    return this.rects.map((r) => ({
      noteId: r.note.noteId,
      midi: r.midi,
      startSec: Number(r.startSec.toFixed(4)),
      x: Number(r.x.toFixed(2)),
      y: Number((r.y + rulerH).toFixed(2)),
      w: Number(r.w.toFixed(2)),
      h: Number(r.h.toFixed(2))
    }));
  }

  /**
   * The centre of the topmost pitch row that has no rectangle anywhere along it.
   *
   * The row's centre has to be genuinely INSIDE the plot now that the pitch axis scrolls: the
   * top and bottom rows are usually part-rows, and a y an event cannot land on is worse than no
   * answer at all for the harness check that exists to click on background.
   */
  private emptyRowY(): number | null {
    const { rowH, yFor } = this.geometry();
    if (!(rowH > 0)) return null;
    const ph = this.plotHeight;
    const busy = new Set(this.rects.map((r) => r.midi));
    for (let midi = this.highMidi; midi >= this.lowMidi; midi--) {
      if (busy.has(midi)) continue;
      const y = yFor(midi) + rowH / 2;
      if (y < 1 || y > ph - 1) continue;
      // Inside the plot is what the bounds check above means; CANVAS is what the answer is in,
      // for the same reason as `paintedRects()` — the caller turns it straight into a clientY.
      return Number((y + this.rulerH).toFixed(2));
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Paint
  // -------------------------------------------------------------------------

  draw = (): void => {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    // The first frame with a real height is the first moment the pitch window can be placed:
    // "centre the pane on the music" needs to know how tall the pane is, and in the plugin the
    // canvas has no height at all until JUCE has laid the page out.
    this.ensureViewPlaced();
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, w, h);

    // The ruler is drawn in CANVAS coordinates, and everything after it in PLOT coordinates —
    // one translate rather than an offset threaded through forty expressions. The pitch axis,
    // the rectangles, the hit test and `probe().firstNoteY` therefore all keep meaning exactly
    // what they meant before the ruler existed. `localPoint()` is the matching subtraction on
    // the way back in; those two are the whole of the change.
    this.drawTimeRuler(ctx, w);
    ctx.save();
    ctx.translate(0, this.rulerH);
    try {
      this.drawPlot(ctx, w, h);
    } finally {
      ctx.restore();
    }
  };

  private drawPlot(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const g = this.gutterPx;
    const ph = this.plotHeight;
    const { rowH, yFor } = this.geometry();

    // The label column, recessed so it reads as chrome rather than as an empty bar of music.
    if (g > 0) {
      ctx.fillStyle = this.colors.gutter;
      ctx.fillRect(0, 0, g, h);
    }

    // Rows: black keys shaded, so a pitch can be read off the pane without counting.
    ctx.fillStyle = this.colors.row;
    for (let midi = this.lowMidi; midi <= this.highMidi; midi++) {
      if (!BLACK_KEYS.has(((midi % 12) + 12) % 12)) continue;
      ctx.fillRect(g, yFor(midi), w - g, rowH);
    }

    // A hairline at every C, which is the only landmark a piano roll really needs. It runs
    // through the gutter as well — on a keyboard there IS a line between B and C — so a
    // label sits ON its own key rather than beside it.
    ctx.fillStyle = this.colors.line;
    for (let midi = this.lowMidi; midi <= this.highMidi; midi++) {
      if (((midi % 12) + 12) % 12 !== 0) continue;
      ctx.fillRect(0, Math.round(yFor(midi) + rowH), w, 1);
    }

    // Everything on the time axis is clipped to the plot, so a note scrolled off the left in
    // linked mode is CUT rather than drawn over the pitch names. Same clip for the bar lines
    // and the notes, because they are the same axis.
    ctx.save();
    ctx.beginPath();
    ctx.rect(g, 0, Math.max(0, w - g), h);
    ctx.clip();

    /*
     * DAW-STYLE GRID, AT PERFORMED TIME. (#30a)
     *
     * The bar lines and the beats inside them, placed at the seconds they were actually played —
     * `barGrid()` runs the score's own tick->second mapping, the same one the notes came through,
     * so a downbeat marker and the note on the downbeat cannot land in different columns.
     *
     * It used to be a grid of the EDIT unit stepped from written second zero, plus a separate
     * pass over bar starts. Two problems, both visible: the edit grid is a preference (switch it
     * to 'free' and the whole ruler vanished), and stepping a float in a loop over a five-minute
     * take at a 32nd-note unit is tens of thousands of iterations a frame, almost none of them on
     * screen. `gridMarks` returns only what is inside the window, thinned to what there is room
     * for, and the strongest weight at any position wins so nothing is drawn twice.
     */
    const marks = this.gridMarks();
    ctx.save();
    for (const mark of marks) {
      const x = this.secToX(mark.sec);
      if (!Number.isFinite(x) || x < g - 1 || x > w) continue;
      // THE THREE WEIGHTS, stepped up (F3b).
      //
      // They were 0.85 / 0.34 / 0.15 of `--border` — a token chosen to separate two panels of
      // near-identical dark grey, which is a job that wants a whisper. Drawn over the roll's
      // striped rows it was a whisper against a pattern, and the beat lines in particular were
      // reported as invisible: 0.34 of a colour a shade off the background is nothing.
      //
      // So bars and beats are drawn in the LABEL colour, which is a text token and therefore
      // legible against this pane by definition, and subdivisions keep the quiet border colour
      // — a subdivision is a hint about where a drag will land, not a landmark. Bars stay
      // clearly the strongest of the three, and 2px wide, because "which one is the downbeat"
      // is the one question the ruler exists to answer at a glance.
      const bar = mark.level === 'bar';
      const beat = mark.level === 'beat';
      // G20: a bar line is the ACCENT, at full strength and 2px. See `colors.bar`.
      ctx.globalAlpha = bar ? 1 : beat ? 0.55 : 0.28;
      ctx.fillStyle = bar ? this.colors.bar : beat ? this.colors.label : this.colors.line;
      ctx.fillRect(Math.round(x), 0, bar ? 2 : 1, ph);
    }
    ctx.restore();

    this.rects = this.layoutRects(rowH, yFor, w, g);
    this.outlinedRects = 0;
    if (this.rects.length > 0) this.paintRects(ctx);

    // The rubber band, over the notes it is catching and inside the same clip — a band drawn
    // across the label gutter would look like it was selecting pitch names.
    this.paintBand(ctx, w);

    ctx.restore();

    // The message, only when there is genuinely nothing — not merely nothing IN VIEW, which
    // in linked mode is a normal thing to have scrolled to.
    if (this.notes.length === 0 && this.rects.length === 0) {
      this.vbar = null;
      this.drawGutter(rowH, yFor);
      ctx.fillStyle = this.colors.label;
      ctx.font = '12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('The notes appear here once the app has listened.', g + (w - g) / 2, ph / 2 + 4);
      ctx.textAlign = 'left';
      return;
    }

    this.drawGutter(rowH, yFor);

    // Playhead, same white hairline as the waveform. Never over the labels, and it stops
    // short of the resize handle like everything else.
    const px = this.secToX(this.positionSec);
    if (Number.isFinite(px) && px >= g && px <= w) {
      ctx.fillStyle = this.colors.playhead;
      ctx.fillRect(px - 0.5, 0, 1, ph);
    }

    // The vertical scrollbar last, over everything: it is chrome, it has to stay legible on top
    // of a dense passage, and it is the thing that TELLS the player the pane scrolls at all.
    this.paintVScrollbar(ctx, w);
  }

  /**
   * The grid this frame: bars, beats and subdivisions, thinned to what there is room for.
   *
   * Rebuilt every frame on purpose — it depends on the window, and the window moves. The cost is
   * a walk over the bars that overlap the view, which at riff length is single digits.
   */
  private gridMarks(): GridMark[] {
    const bars = this.bars;
    if (bars.length === 0) return [];
    const win = this.getTimeWindow();
    const detail = gridDetail(
      medianBeatSec(bars),
      (win.toSec - win.fromSec) / Math.max(1, this.plotWidth),
      // THE SELECTED GRID, and it never used to get here. `setEditGrid` changed what a drag
      // SNAPPED to and nothing else, so the drawn subdivisions stayed at four per beat whatever
      // the Grid selector said — pick triplets and every snapped note landed neatly between two
      // drawn columns, which reads as the snapping being broken rather than the ruler.
      subdivisionsPerBeat(this.editGrid)
    );
    return gridMarks(bars, win, detail);
  }

  /**
   * THE TIME RULER: bar numbers along the top, and the horizontal axis's own zoom target.
   *
   * Drawn in CANVAS coordinates — this is the only thing in the file that is — because it sits
   * above the plot rather than in it. Its left end covers the gutter's corner, which the plot's
   * own gutter fill no longer reaches now that the plot starts lower down.
   */
  private drawTimeRuler(ctx: CanvasRenderingContext2D, w: number): void {
    const rh = this.rulerH;
    if (rh <= 0) return;
    const g = this.gutterPx;

    ctx.save();
    ctx.fillStyle = this.colors.gutter;
    ctx.fillRect(0, 0, w, rh);
    // The edge between the ruler and the music, so the band reads as chrome.
    ctx.fillStyle = this.colors.line;
    ctx.fillRect(0, rh - 1, w, 1);

    ctx.beginPath();
    ctx.rect(g, 0, Math.max(0, w - g), rh);
    ctx.clip();

    ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (const mark of this.gridMarks()) {
      const x = this.secToX(mark.sec);
      if (!Number.isFinite(x) || x < g - 1 || x > w) continue;
      // Ticks: a bar gets the full height of the band, a beat a stub, a subdivision nothing —
      // at that density the band would be a solid block.
      if (mark.level === 'sub') continue;
      // Same weights as the plot's own lines below, so a bar tick in the band and the bar line
      // under it read as one mark rather than two of different strengths. See the grid in
      // `drawPlot` for why the label token and not the border one.
      ctx.globalAlpha = mark.level === 'bar' ? 1 : 0.55;
      ctx.fillStyle = mark.level === 'bar' ? this.colors.bar : this.colors.label;
      const tickH = mark.level === 'bar' ? rh - 1 : 4;
      ctx.fillRect(Math.round(x), rh - 1 - tickH, mark.level === 'bar' ? 2 : 1, tickH);
      if (!mark.label) continue;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = this.colors.label;
      ctx.fillText(mark.label, Math.round(x) + 3, 10);
    }

    // The playhead crosses the ruler too, so the moment has one unbroken line through the pane.
    const px = this.secToX(this.positionSec);
    if (Number.isFinite(px) && px >= g && px <= w) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = this.colors.playhead;
      ctx.fillRect(px - 0.5, 0, 1, rh - 1);
    }
    ctx.restore();
  }

  /**
   * The pitch scrollbar down the right-hand edge — drawn only when there is somewhere to go.
   *
   * THE SAME RANGE THE WHEEL HAS, and that is a fix rather than a preference (finding 13).
   *
   * It used to measure the union of the take's range and what is on screen, which sounds like
   * the more informative choice and is a trap: the union has no track beyond the thumb, so when
   * the thumb reached the lowest note there was nothing left to drag into, while the WHEEL went
   * on scrolling down into empty keyboard quite happily (`applyScrollTop` clamps against the
   * whole 0..127, on purpose, so a note can be ADDED out there). Only after the wheel had moved
   * into that space did the bar's range grow to include it. Two controls, two navigable spaces,
   * and the smaller one was the one that looked like the map.
   *
   * The cost is a smaller thumb on a bass take. That is honest: the take really is a seventh of
   * a piano, and where the notes are is said by the notes.
   *
   * Hidden when everything fits, because a scrollbar that cannot move is furniture.
   */
  private paintVScrollbar(ctx: CanvasRenderingContext2D, w: number): void {
    this.vbar = null;
    const ph = this.plotHeight;
    const rows = this.visibleRows;
    if (ph <= 0 || this.notes.length === 0) return;

    const top = this.scrollTopMidi;
    const lo = 0;
    const hi = MIDI_TOP;
    const span = hi - lo;
    // Everything is on screen, so there is nothing a scrollbar could do.
    if (!(span > rows + 0.01)) return;

    const trackH = ph;
    const thumbH = Math.max(VBAR_MIN_THUMB_PX, Math.min(trackH, (rows / span) * trackH));
    // The window's DISTANCE FROM THE TOP of the range, as a fraction of the travel available.
    const frac = span - rows <= 0 ? 0 : (hi - top) / (span - rows);
    const thumbY = Math.max(0, Math.min(trackH - thumbH, frac * (trackH - thumbH)));
    const x = w - VBAR_W_PX - 2;

    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = this.colors.gutter;
    ctx.fillRect(x, 0, VBAR_W_PX, trackH);
    ctx.globalAlpha = this.gesture?.kind === 'vscroll' ? 0.95 : 0.6;
    ctx.fillStyle = this.colors.label;
    const r = VBAR_W_PX / 2;
    // Rounded, so it reads as a control rather than as one more rectangle of music.
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, thumbY, VBAR_W_PX, thumbH, r);
      ctx.fill();
    } else {
      ctx.fillRect(x, thumbY, VBAR_W_PX, thumbH);
    }
    ctx.restore();

    this.vbar = { x, w: VBAR_W_PX, thumbY, thumbH, trackH, lo, hi, span };
  }

  /**
   * Where every rectangle goes, including the one a drag is currently holding.
   *
   * Two passes, and the second is the one people forget: after the widths are computed, any
   * rect that would touch the next one on the same row is SHORTENED. Never moved — the left
   * edge is the onset and a picture that lies about when a note started is worse than one
   * that lies about how long it was. Invariant 5.
   */
  private layoutRects(rowH: number, yFor: (midi: number) => number, w: number, g: number): RollRect[] {
    const noteH = Math.max(2, rowH - 2);
    const out: RollRect[] = [];

    /*
     * A just-added note is drawn before it exists.
     *
     * `add` is the one edit with no note behind it, so without this the double-click does
     * nothing at all for however long the pipeline takes and the player double-clicks again.
     * It carries `noteId: null`, so it cannot be selected or dragged in the meantime — the
     * next `refresh()` brings back the real one, with a real id.
     */
    const add = this.pending && this.pending.kind === 'add' ? this.pending : null;
    const source: PianoRollNote[] = add
      ? [
          ...this.notes,
          { startSec: add.startSec, endSec: add.startSec + add.durationSec, midi: add.midi, noteId: null }
        ]
      : this.notes;

    const ph = this.plotHeight;

    for (const n of source) {
      const prov = this.provisional(n);
      const x0 = this.writtenToX(prov.startSec);
      const x1 = this.writtenToX(prov.endSec);
      if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
      if (x1 < g - 1 || x0 > w) continue;
      /*
       * CULLED VERTICALLY TOO, since the pitch axis became a window (invariant 10).
       *
       * Not an optimisation — a correctness requirement. `this.rects` is what the hit-test
       * reads, what ⌘A means by "everything currently drawn", and what `paintedRects()` reports
       * to the harness. A rect for a note eleven rows above the top of the pane would be
       * selectable by a band that never went near it and countable in a badge that claims to
       * describe what you can see.
       */
      const rowTop = yFor(prov.midi);
      if (rowTop + rowH < 0 || rowTop > ph) continue;
      const y = rowTop + (rowH - noteH) / 2;
      out.push({
        note: n,
        midi: prov.midi,
        startSec: prov.startSec,
        endSec: prov.endSec,
        x: x0,
        y,
        w: Math.max(MIN_NOTE_W_PX, x1 - x0 - NOTE_GAP_PX),
        h: noteH
      });
    }

    // Keep the outlines apart. Sorted per row so "the next one" is well defined even after a
    // provisional move has put a note on a row it does not normally live on.
    const byRow = new Map<number, RollRect[]>();
    for (const r of out) {
      const row = byRow.get(r.midi);
      if (row) row.push(r);
      else byRow.set(r.midi, [r]);
    }
    for (const row of byRow.values()) {
      row.sort((a, b) => a.x - b.x);
      for (let i = 0; i < row.length - 1; i++) {
        const a = row[i];
        const b = row[i + 1];
        const room = b.x - NOTE_GAP_PX - a.x;
        if (a.x + a.w > b.x - NOTE_GAP_PX) a.w = Math.max(1, room);
      }
    }
    return out;
  }

  /**
   * A note as the gesture currently has it — or as it was, when nothing is being dragged.
   *
   * The provisional position covers both the drag itself and the moment after it, while the
   * integrator is re-running the pipeline. See invariant 8.
   */
  private provisional(n: PianoRollNote): { startSec: number; endSec: number; midi: number } {
    const base = { startSec: n.startSec, endSec: n.endSec, midi: n.midi };
    const id = n.noteId;
    if (!id) return base;

    /** Every member of a group drag moves by the SAME delta, which is what makes it one drag. */
    const moved = (deltaSec: number, deltaSemitones: number) => ({
      startSec: Math.max(0, n.startSec + deltaSec),
      endSec: Math.max(0, n.endSec + deltaSec),
      midi: Math.max(0, Math.min(127, n.midi + deltaSemitones))
    });
    /** A group resize is a delta on each note's OWN length, never one length for all of them. */
    const resized = (deltaSec: number) => ({
      startSec: n.startSec,
      endSec: n.startSec + Math.max(MIN_PREVIEW_DUR_SEC, n.endSec - n.startSec + deltaSec),
      midi: n.midi
    });

    const g = this.gesture;
    if (g && g.kind === 'move' && g.idSet.has(id)) return moved(g.deltaSec, g.deltaSemitones);
    if (g && g.kind === 'resize' && g.idSet.has(id)) {
      // The grabbed note follows the pointer exactly; the rest of the group take the delta.
      return id === g.noteId
        ? { startSec: n.startSec, endSec: n.startSec + Math.max(MIN_PREVIEW_DUR_SEC, g.baseDurationSec + g.deltaSec), midi: n.midi }
        : resized(g.deltaSec);
    }

    const p = this.pending;
    if (!p || !this.pendingIds.has(id)) return base;
    if (p.kind === 'move') return moved(p.deltaSec, p.deltaSemitones);
    if (p.kind === 'moveMany') return moved(p.deltaSec, p.deltaSemitones);
    if (p.kind === 'resize') return { startSec: n.startSec, endSec: n.startSec + p.newDurationSec, midi: n.midi };
    if (p.kind === 'resizeMany') return resized(p.deltaSec);
    // A pending delete (of either kind) is drawn where it was; the fill drops to a ghost in
    // paintRects. Removing it outright here would make an undo look like the note came back
    // from nowhere.
    return base;
  }

  /**
   * The fills and the outlines. Invariants 4 and 5.
   *
   * Colour means: nothing = a note; soft accent = sounding right now; full accent + a heavier
   * outline = selected. There is deliberately NO "already played" colour — that fill is the
   * bug this replaced, see invariant 4.
   */
  private paintRects(ctx: CanvasRenderingContext2D): void {
    const nowWritten = this.positionSec - this.originSec;
    const deleting = this.pending && (this.pending.kind === 'delete' || this.pending.kind === 'deleteMany');
    this.autoMarksDrawn = 0;

    // The halo goes UNDER the fills, in its own pass, so it reads as something around the note
    // rather than as part of it — and so a run of adjacent auto-split fragments does not have
    // every halo overdrawn by its neighbour's fill.
    if (this.autoMarks.size > 0) {
      ctx.save();
      for (const r of this.rects) {
        const id = r.note.noteId;
        if (!id || !this.autoMarks.has(id)) continue;
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = this.colors.autoEdit;
        ctx.lineWidth = 2;
        // Outside the rectangle, not inset: an inset stroke would be mistaken for the ordinary
        // note outline every rect already has, and the two mean completely different things.
        ctx.strokeRect(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3);
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = this.colors.autoEdit;
        ctx.fillRect(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3);
        this.autoMarksDrawn++;
      }
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }

    /*
     * The HOVER ring (#30d, inward): the sheet is pointing at these notes.
     *
     * Under the fills like the auto-edit halo, and much lighter than a selection: a hover is a
     * question and a selection is an answer, and a highlight that looked like a selection would
     * make pointing at a notehead on the staff appear to have changed what Delete would remove.
     */
    if (this.hovered.size > 0) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = this.colors.text;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      for (const r of this.rects) {
        const id = r.note.noteId;
        if (!id || !this.hovered.has(id)) continue;
        ctx.strokeRect(r.x - 2.5, r.y - 2.5, r.w + 5, r.h + 5);
      }
      ctx.setLineDash([]);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    for (const r of this.rects) {
      const id = r.note.noteId;
      const selected = !!id && this.selection.has(id);
      const sounding = r.startSec <= nowWritten && nowWritten < r.endSec;
      const ghost = !!id && deleting && this.pendingIds.has(id);

      ctx.globalAlpha = ghost ? 0.25 : 1;
      if (selected) {
        ctx.fillStyle = this.colors.accent;
      } else if (sounding) {
        // Soft: the plain note colour first, then a wash of accent over it, so the difference
        // reads as "lit up" rather than as a second, unrelated category of note.
        ctx.fillStyle = this.colors.note;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.globalAlpha = ghost ? 0.15 : 0.45;
        ctx.fillStyle = this.colors.played;
      } else {
        ctx.fillStyle = this.colors.note;
      }
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.globalAlpha = ghost ? 0.35 : 1;

      // The outline. Inset by half a pixel so a 1px stroke lands ON the pixel grid instead of
      // straddling two rows of it and coming out as a 2px smear at 50% alpha.
      if (r.w >= 2 && r.h >= 2) {
        const heavy = selected && r.w >= 5 && r.h >= 5;
        ctx.lineWidth = heavy ? 2 : 1;
        ctx.strokeStyle = selected ? this.colors.text : this.colors.noteEdge;
        if (!selected) ctx.globalAlpha = ghost ? 0.35 : 0.8;
        const inset = heavy ? 1 : 0.5;
        ctx.strokeRect(r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2);
        this.outlinedRects++;
      } else {
        // Sub-2px: there is no room for a stroke inside the fill, so the fill IS the mark and
        // the gap either side of it does the separating. Still counted as outlined, because
        // the invariant is "two notes read as two", not "ctx.stroke was called".
        this.outlinedRects++;
      }
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 1;
  }

  /**
   * The rubber band, and the count of what is caught in it.
   *
   * THE COUNT IS THE POINT. A band that only tints things leaves the player to count seven
   * rectangles by eye before pressing Delete — on a 46px pane, at four notes to the bar, that
   * is not a thing anybody can do reliably. The number is printed while the band is still
   * being dragged, so the decision is made with the answer on screen rather than after it.
   *
   * The badge outlives the band: once the pointer is released it moves to the top right and
   * stays there for as long as more than one note is selected, because the dangerous moment
   * is not the drag, it is the Delete four seconds later.
   */
  private paintBand(ctx: CanvasRenderingContext2D, w: number): void {
    const g = this.gesture;
    const banding = !!g && g.kind === 'band' && g.moved;
    if (!banding && this.selection.size < 2) return;

    ctx.save();
    let bx = w - this.gutterPx;
    let by = 0;

    if (banding && g && g.kind === 'band') {
      const b = bandBox(g, this.gutterPx);
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = this.colors.accent;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      // Dashed, so it reads as a transient tool rather than as one more rectangle of music.
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = this.colors.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, Math.max(1, b.w - 1), Math.max(1, b.h - 1));
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      bx = b.x;
      // Above the band by preference: inside it, the badge covers the notes being counted.
      by = b.y - 2;
    }

    const n = this.selection.size;
    const text = `${n} ${n === 1 ? 'note' : 'notes'}`;
    const fontPx = 11;
    ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
    const padX = 5;
    const padY = 3;
    const bw = Math.ceil(ctx.measureText(text).width) + padX * 2;
    const bh = fontPx + padY * 2;
    // Clamped into the plot on both axes, because at REAPER's floor the pane is 46px tall and
    // the band can be dragged from anywhere in it — a badge drawn off the edge is a count
    // nobody can read, which is the same as no count at all.
    const left = Math.max(this.gutterPx + 1, Math.min(bx, w - bw - 1));
    const top = Math.max(0, Math.min(banding ? by - bh : by + 2, this.plotHeight - bh));

    ctx.fillStyle = this.colors.accent;
    ctx.fillRect(left, top, bw, bh);
    ctx.fillStyle = this.colors.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + padX, top + bh / 2);
    ctx.restore();
  }

  /**
   * The gutter: a keyboard with pitch names on it, drawn last so nothing paints over it.
   *
   * Invariant 6. Four things have to hold at once and they fight each other in a 46px pane:
   * the names must be legible, the C's must stand out, the column must never be blank, and
   * nothing may land under the resize handle. So the naming thins in named steps rather than
   * the type shrinking — a legible C2 beats twelve grey smudges — and every mode is reported
   * through `probe().labelMode` so the harness can assert which one a given size chose.
   */
  private drawGutter(rowH: number, yFor: (midi: number) => number): void {
    const ctx = this.ctx;
    const g = this.gutterPx;
    const h = this.canvas.clientHeight;
    const ph = this.plotHeight;
    this.labelsDrawn = [];
    this.labelMode = 'none';
    if (g <= 0) return;

    // The key strip. Black keys recessed, white keys raised — the same shapes the rows in the
    // plot are shaded with, so the eye carries a pitch across the divider without counting.
    for (let midi = this.lowMidi; midi <= this.highMidi; midi++) {
      const black = BLACK_KEYS.has(((midi % 12) + 12) % 12);
      ctx.fillStyle = black ? this.colors.keyBlack : this.colors.keyWhite;
      const y = yFor(midi);
      ctx.fillRect(0, y, g - 1, Math.max(1, rowH - (rowH > 3 ? 1 : 0)));
    }
    // Below the last row the strip would show the pane's background through it; fill it with
    // the gutter colour so the column has one continuous edge.
    if (ph < h) {
      ctx.fillStyle = this.colors.gutter;
      ctx.fillRect(0, ph, g, h - ph);
    }

    // Divider, so the column has an edge even where no note reaches it.
    ctx.fillStyle = this.colors.line;
    ctx.fillRect(g - 1, 0, 1, h);

    const fontPx = Math.max(MIN_LABEL_PX, Math.min(MAX_LABEL_PX, Math.round(rowH * 0.8)));
    // A label needs its own height plus a hair of leading before two of them touch.
    const need = fontPx + 1.5;
    ctx.textAlign = 'right';

    const cs: number[] = [];
    for (let midi = this.lowMidi; midi <= this.highMidi; midi++) {
      if (((midi % 12) + 12) % 12 === 0) cs.push(midi);
    }

    /** One label, coloured for the key it sits on. C's are bolder and at full strength. */
    const label = (midi: number, onLine: boolean): void => {
      const centre = onLine ? yFor(midi) + rowH : yFor(midi) + rowH / 2;
      /*
       * A row that is only half on screen gets no name.
       *
       * `clampLabelY` pins a baseline inside the plot, which is right for a squashed pane and
       * wrong for a scrolled one: the top and bottom rows are part-rows now, so clamping would
       * park a name against the edge with nothing under it and, at a tall zoom, on top of the
       * name below it. Better to draw one fewer label than one label in the wrong place.
       */
      if (centre < -1 || centre > ph + 1) return;
      const pc = ((midi % 12) + 12) % 12;
      const isC = pc === 0;
      const black = BLACK_KEYS.has(pc);
      ctx.font = `${isC ? 700 : 500} ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillStyle = black ? this.colors.label : this.colors.ink;
      ctx.globalAlpha = isC ? 1 : 0.7;
      ctx.fillText(pitchName(midi), g - 4, clampLabelY(centre, fontPx, ph));
      ctx.globalAlpha = 1;
      this.labelsDrawn.push(pitchName(midi));
    };

    /**
     * The column must never come out blank. Invariant 6, and now also invariant 10.
     *
     * Every tier below picks particular rows, and since the pitch axis scrolls, ANY of those
     * rows can turn out to be a part-row at an edge that `label()` correctly declines to name —
     * a pane showing four and a half rows with its only C among the halves would leave the
     * player a keyboard with no names on it at all. So whichever tier ran, if it drew nothing,
     * the middle row of what IS on screen gets named.
     */
    const finish = (): void => {
      if (this.labelsDrawn.length === 0) {
        const middle = Math.floor((this.lowMidi + this.highMidi) / 2);
        label(Math.max(0, Math.min(127, middle)), false);
      }
      ctx.textAlign = 'left';
    };

    // Tier 1: every row. Tier 2: the naturals — "every other" done musically, so the column
    // reads C D E F G A B rather than C D E F# G# A#. Tier 3 and 4: the C's, thinned.
    if (this.showAllNames && rowH >= need) {
      this.labelMode = 'all';
      for (let midi = this.lowMidi; midi <= this.highMidi; midi++) label(midi, false);
      finish();
      return;
    }
    // Tier 2: the naturals. Musically this is the right "every other" — the column reads
    // C D E F G A B rather than C D E F# G# A#.
    //
    // But it buys almost no vertical room, and the first version of this gate pretended
    // otherwise: it reasoned from the AVERAGE spacing of 12/7 semitones, when what decides
    // whether two labels touch is the TIGHTEST pair. E-F and B-C are one semitone apart, the
    // same as tier 1, so a pane that cannot fit every name cannot fit every natural either.
    // The harness caught it drawing E1 and F1 6.6px apart in 8px type.
    //
    // So the naturals tier now drops those two adjacencies — F and C keep their labels and E
    // and B give theirs up when the rows are tight, which leaves a worst gap of two semitones
    // and a column that still reads as a scale. C is never the one dropped: it is the
    // landmark, and it is the one the player asked to stand out.
    if (this.showAllNames && rowH * 2 >= need) {
      this.labelMode = 'naturals';
      const tight = rowH < need; // E-F and B-C would touch
      for (let midi = this.lowMidi; midi <= this.highMidi; midi++) {
        const pc = ((midi % 12) + 12) % 12;
        if (BLACK_KEYS.has(pc)) continue;
        if (tight && (pc === 4 || pc === 11)) continue; // E and B, the halves of those pairs
        label(midi, false);
      }
      finish();
      return;
    }

    if (cs.length === 0) {
      // No octave line in range: name the top and bottom of what is shown instead, so the
      // column is never blank on a riff that lives inside one octave.
      this.labelMode = 'edges';
      for (const midi of [this.highMidi, this.lowMidi]) label(midi, false);
      this.labelsDrawn.reverse();
      finish();
      return;
    }

    // Skip whole octaves when even they would collide.
    const octavePx = rowH * 12;
    const step = Math.max(1, Math.ceil(need / Math.max(1, octavePx)));
    this.labelMode = step > 1 ? 'octaves' : 'c-only';
    for (let i = 0; i < cs.length; i++) {
      // Count from the TOP so the highest C is always one of the survivors: the eye lands on
      // the top of the pane first, and a thinned column that starts blank reads as broken.
      if ((cs.length - 1 - i) % step !== 0) continue;
      label(cs[i], true);
    }
    finish();
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('gesturestart', this.onGestureStart);
    this.canvas.removeEventListener('gesturechange', this.onGestureChange);
    window.removeEventListener('pointermove', this.onWindowPointerMove);
    window.removeEventListener('pointerup', this.onWindowPointerUp);
    window.removeEventListener('pointercancel', this.onWindowPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('resize', this.onWindowResize);
    this.handle?.removeEventListener('pointerdown', this.onHandleDown);
    this.handle?.removeEventListener('keydown', this.onHandleKey);
    this.handle?.removeEventListener('dblclick', this.onHandleDouble);
    // A height drag that was still in flight when the pane was rebuilt has two window
    // listeners of its own. They are not on `this` and nothing else would ever take them off.
    this.detachHeightDrag?.();
    this.detachHeightDrag = null;
    // The trailing "the scroll has stopped" timer would otherwise fire into a destroyed roll and
    // hand the integrator a view for a pane that no longer exists.
    this.clearViewCommitTimer();
    this.gesture = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Add one note to the rect list, merging it into the rect it is tied to if there is one.
 *
 * Shared by both walks so the two cannot disagree about what a tie is — which would show up
 * as a phantom `irDeltaSec` and send somebody hunting a tick bug that was never there.
 */
function hold(
  out: PianoRollNote[],
  open: Map<number, PianoRollNote>,
  midi: number,
  startSec: number,
  endSec: number,
  tieStop: boolean,
  tieStart: boolean,
  noteId: string | null
): void {
  const held = tieStop ? open.get(midi) : undefined;
  if (held) {
    held.endSec = endSec;
    if (!tieStart) open.delete(midi);
    return;
  }
  const rect: PianoRollNote = { startSec, endSec, midi, noteId };
  out.push(rect);
  if (tieStart) open.set(midi, rect);
  else open.delete(midi);
}

/** Earliest first, so `notes[0]` is the riff's first note whichever walk produced it. */
function sortByStart(notes: PianoRollNote[]): PianoRollNote[] {
  return notes.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
}

/** Worst disagreement in start time between two walks. Null when they are not comparable. */
function maxStartDelta(a: PianoRollNote[], b: PianoRollNote[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i].startSec - b[i].startSec));
  return worst;
}

function sameIds(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * The rubber band as a normalised box, in canvas coordinates.
 *
 * Normalised because a band is dragged in all four directions and "start" is wherever the
 * player happened to press, not the top left of anything. Clipped to the gutter on the left so
 * a band swept off the side of the plot cannot catch notes by reaching across the label
 * column — which does not draw notes, so a band over it would select things the player was
 * demonstrably not pointing at.
 */
function bandBox(
  g: { startX: number; startY: number; x: number; y: number },
  gutterPx: number
): { x: number; y: number; w: number; h: number } {
  const x0 = Math.min(g.startX, g.x);
  const x1 = Math.max(g.startX, g.x);
  const y0 = Math.min(g.startY, g.y);
  const y1 = Math.max(g.startY, g.y);
  const left = Math.max(gutterPx, x0);
  return { x: left, y: y0, w: Math.max(0, x1 - left), h: Math.max(0, y1 - y0) };
}

/**
 * A transposition that keeps the WHOLE group inside the MIDI range.
 *
 * The integrator clamps each note as its last line of defence, and it is right to. But
 * clamping per note is the wrong shape for a group: an octave-down on a run whose bottom note
 * is already at midi 6 would pin that one note at 0 and drop the other seven a full octave,
 * turning one edit into a chord the player never played. Better to move less, together.
 */
function clampSemitoneDelta(delta: number, limits: GroupLimits): number {
  return Math.max(-limits.minMidi, Math.min(127 - limits.maxMidi, delta));
}

/**
 * A monotonic clock, for "has the player touched this in the last few seconds".
 *
 * `performance.now()` and not `Date.now()`: auto-follow yielding to the player must not be
 * confused by the system clock stepping, and in a plugin window the host is perfectly capable
 * of being alive across one. Guarded, because the JUCE WebView has shipped without it before.
 */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Is the player typing? Then this key belongs to them, not to the roll. */
function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

/**
 * Keep a label's baseline inside the drawable area.
 *
 * At 22 semitones in a 60px pane a row is under 3px tall, so an unclamped label on the top or
 * bottom row is drawn half outside and comes out beheaded. The bottom limit is the plot
 * height and not the canvas height, because the last few pixels belong to the resize handle.
 */
function clampLabelY(centreY: number, fontPx: number, plotH: number): number {
  const baseline = centreY + fontPx * 0.36;
  return Math.max(fontPx, Math.min(plotH - 1, baseline));
}

function secPerTickOf(score: RiffScore, ticksPerQuarter: number): number {
  return 60 / (score.tempoBpm || 100) / ticksPerQuarter;
}

function pitchName(midi: number): string {
  return `${NOTE_LETTERS[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
