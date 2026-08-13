/**
 * The tri-view: staff + note-names + tab, one timeline, one playhead.
 *
 * Rows 1 and 3 (staff, tab) are ONE alphaTab render — alignment is the engine's problem,
 * not ours, which is the entire reason alphaTab was chosen. Row 2 (names) and the
 * playhead/selection overlay are derived from `boundsLookup`, so they are aligned by
 * construction and re-derive themselves on every render. Nothing here measures glyphs or
 * corrects positions; if you ever find yourself adding such code, something is wrong.
 *
 * The one exception, and it is a measurement rather than a correction: `tuneLeftInset()`
 * reads back how much empty space alphaTab actually left on the left and adjusts the page
 * padding so it comes to exactly the piano roll's label-gutter width. See §D below.
 *
 * This file is also the tri-view's public X-AXIS. `tickToContentX` / `contentXToTick`
 * hand the engraving's own geometry to anything that has to line up with it — today the
 * piano roll, which draws its rectangles at the sheet's x rather than at its own. The
 * cursor uses the very same helper, so the roll and the playhead cannot drift apart.
 */

import * as alphaTab from '@coderline/alphatab';
import {
  applyStaffTabGap,
  createSettings,
  setLeftPadding,
  setTopPadding,
  PAGE_PADDING_PX,
  type ViewSettings
} from './atSettings';
import { TIMELINE_GUTTER_PX } from './pianoroll';
import { installGestureRecorder } from './gestureRecorder';
import { buildAlphaTabScore, soundingMidi, type ScoreIndex } from '../score/fromPipeline';
import { midiToName, accidentalsForKey, type Accidentals } from '../score/notes';
import { assignFret } from '../score/tuning';
import {
  STRING_LETTER_GAP_PX,
  stringLettersFromBounds,
  tuningLowToHighFromScore
} from './stringLetters';
import {
  soleStaveKind,
  staveKindsFromBars,
  staveKindsFromStaves,
  tabStaveIndex,
  type StaveKind
} from './staveKinds';
import type { EngravedExtent } from './timeAxis';
// The one wheel-to-zoom law, borrowed rather than restated: a pinch over the SHEET and a pinch
// over the ROLL have to be worth exactly the same amount, or the coupled pair pulls apart in the
// hand. That used to mean two copies of the road/dedupe/baseline machinery on two surfaces (three,
// with the waveform strip) which drifted apart in exactly the ways view/gesture.ts documents.
// There is one copy now, and what is left here is the sheet's own coordinates.
import { PinchGesture } from './gesture';
import { countRendererCredits, stripRendererCredit } from './watermark';
import { t, TIPS } from '../ui/tips';
// THE ONE-PROPORTION LAW'S COORDINATE CORRECTION (G1). Pointer coordinates and
// `getBoundingClientRect()` are VISUAL pixels; alphaTab's bounds lookup, `LEFT_INSET_PX`, the
// scroller's `scrollLeft` and every engraved measurement are LOGICAL ones. One conversion, in
// `ui/faceScale.ts`, and every hit test on this surface goes through it.
import { faceScale, logicalPoint, logicalRect, logicalX, toLogical, toVisual } from '../ui/faceScale';
import type { RiffScore } from '../pipeline';

export type NamesPlacement = 'between' | 'above' | 'below';

/** Which of the two staves a pointer is over. The tri-view's third row is names, not a staff. */
export type StaffKind = 'notation' | 'tab';

/** What the scroller looks like right now, in CONTENT (unscrolled) pixels. */
export interface TriViewViewport {
  scrollLeft: number;
  viewportWidth: number;
  contentWidth: number;
}

/**
 * Live feedback while a note is being dragged. Nothing has been changed yet.
 *
 * `steps` is signed and in the units of `kind`: staff positions for 'pitch' (up is
 * positive), strings for 'string' (toward the thinner strings is positive, matching
 * alphaTab's own numbering where string 1 is the fattest). `valid` is false when the
 * candidate cannot exist on this instrument — off the end of the fretboard, or a fret
 * number that would be negative or past the limit.
 *
 * Null means the drag ended: clear whatever you were showing.
 */
export interface NoteDragPreview {
  noteId: string;
  kind: 'pitch' | 'string' | 'time';
  steps: number;
  valid: boolean;
}

/**
 * A finished drag, ready to become an edit. Only ever emitted for a valid, non-zero move.
 *
 * 'pitch' is in SEMITONES, already converted from staff positions through the key (or
 * taken literally when Alt was held) — feed it straight to `ChangePitchAction`.
 *
 * 'string' carries both spellings of the same move: `direction` + `steps` for
 * `ChangeStringAction`, which moves one string at a time, and `toString` / `toFret` as the
 * absolute answer this file already computed and validated. They cannot disagree; apply
 * whichever suits, and prefer the absolute one if you ever add an action that takes it.
 */
export type NoteDragCommit =
  | { noteId: string; kind: 'pitch'; semitones: number }
  /**
   * A HORIZONTAL drag: the same note, attacked at a different written time.
   *
   * `tick` is where it was dropped, unrounded, for the same reason `SheetTarget.tick` is: the
   * beat it should land on is a question about the meter. The app rounds and then applies the
   * collision law — see edit/performanceEdit.ts.
   */
  | { noteId: string; kind: 'time'; tick: number }
  | {
      noteId: string;
      kind: 'string';
      direction: 1 | -1;
      steps: number;
      fromString: number;
      toString: number;
      toFret: number;
    };

export interface TriViewOptions {
  container: HTMLElement;
  view?: Partial<ViewSettings>;
  namesPlacement?: NamesPlacement;
  showNames?: boolean;
  /**
   * The app's native export door, for the DEBUG gesture recorder only (D2).
   *
   * Optional, and absent everywhere except the one wiring in ui/app.ts: the recorder is off
   * unless its flag is set, and with no door it falls back to a browser download. Nothing about
   * the engraving depends on it. See view/gestureRecorder.ts.
   */
  exportFile?: (name: string, bytes: Uint8Array, mimeType?: string) => Promise<unknown>;
  onNoteClick?: (hit: NoteHit) => void;
  onSeekRequest?: (tick: number) => void;
  /**
   * Highest playable fret, for deciding whether a drag is possible at all. Same number as
   * `AppSettings.maxFret`; keep it in step with `setFretLimit()`.
   */
  maxFret?: number;
  /** Live drag feedback. Called with null when the drag ends. See NoteDragPreview. */
  onNoteDragPreview?: (preview: NoteDragPreview | null) => void;
  /** A finished, valid drag. Never fired for a plain click or a refused move. */
  onNoteDragCommit?: (commit: NoteDragCommit) => void;
  /**
   * The sheet scrolled, or was re-engraved so that its content got wider or narrower.
   *
   * Fired on scroll (coalesced to one animation frame, so a fast drag cannot thrash) and
   * at the end of every overlay rebuild. Only fired when something actually changed.
   *
   * A REPAINT SIGNAL, NOT AN ALIGNMENT ONE, and that separation is finding 7's fix. This fires
   * from partial renders, from mid-render overlay rebuilds and from before the scroll anchor has
   * been restored — geometry that is true for an instant and then is not. `ui/app.ts` used to
   * wire this straight into the coupling, so the roll could be handed incomplete-partial
   * geometry, then final geometry at the old pixel scroll, then final geometry again after the
   * anchor moved: three windows for one gesture, and the panes visibly walked through them.
   * Use `onRenderSettled` for anything that decides where the other panes look.
   */
  onViewportChange?: (v: TriViewViewport) => void;
  /**
   * ONE SETTLED VIEWPORT PER RENDER, and nothing partial (finding 7).
   *
   * Fired exactly once at the very end of a render that has finished for real: after every
   * corrective inset render, after the scroll anchor has been put back, with the geometry the
   * player is actually looking at. A render that starts a correcting render does not fire this —
   * the one that finishes the correction does.
   */
  onRenderSettled?: (v: TriViewViewport) => void;
  /**
   * THE PLAYER MOVED THE SHEET. One edge, in ticks, and nothing about how much is on screen.
   *
   * Fired only for a scroll this class did not cause: a trackpad swipe, a keyboard page, the
   * browser's own scrollbar. Programmatic scrolls — `setScrollLeft`, the anchor restore, the
   * app pushing the authoritative window back in — are silent, which is what stops a scroll the
   * app just applied from arriving back as if a hand had made it.
   *
   * Null tick means the sheet cannot say yet (nothing engraved); the app leaves the window alone.
   */
  onSheetScroll?: (leftTick: number | null) => void;
  /**
   * A PINCH OVER THE SHEET. Multiplicative, with the pointer's client x so it can be anchored.
   *
   * The sheet does NOT zoom itself here, and that is the point of routing it out: sheet pinch and
   * roll pinch are the same gesture about the same shared window, so they go through the same
   * reducer and cannot come out feeling different (finding 10). What comes back is a scale, via
   * `setZoom(scale, clientX)`.
   */
  onPinch?: (factor: number, clientX: number) => void;
  /**
   * CROSS-HIGHLIGHT (#30d), outward: the pointer is over this note's glyph, so the roll can
   * ring the matching rectangle. Null when it leaves the glyph, or the sheet entirely.
   *
   * Coalesced to one call per CHANGED note — the hit test already runs at most once an
   * animation frame, and the other end of this is a canvas repaint. Silent during a drag: the
   * interesting note then is the one being dragged, and it is already highlighted.
   *
   * The exact counterpart of `PianoRoll`'s option of the same name, and the two are wired to
   * each other's `setHover`. Never echo one into the other's report or the pair will loop.
   */
  onNoteHover?: (noteId: string | null) => void;
  /**
   * A PRINTED PART NAME WAS PRESSED. The alphaTab track it belongs to, and where it is on screen.
   *
   * alphaTab engraves the track name sideways down the left of the system out of `track.name` /
   * `track.shortName`, and no code in this app draws it — so it is found rather than published:
   * see `syncPartLabelHits` for how a label is told apart from the music and matched to a track.
   * The rect is in CLIENT coordinates, because what the app puts there is a field over the top
   * of it and the sheet is about to be re-engraved underneath.
   */
  onPartLabelClick?: (trackIndex: number, rect: { x: number; y: number; w: number; h: number }) => void;
  /**
   * A RIGHT-CLICK ON THE SHEET, resolved to a semantic target. The browser's own menu is
   * already suppressed by the time this fires; see `onContextMenu` and `SheetTarget`.
   */
  onSheetContextMenu?: (target: SheetTarget) => void;
  // `onZoomChange` stood here and is gone (finding 14). It was documented as identifying
  // SHEET-ORIGINATED zoom, and it could not: `ui/app.ts` also called `setZoom()` to carry a ROLL
  // zoom onto the sheet, and this fired for that too. So the one caller — `adoptNextAlignSpan` —
  // was armed by both directions of the coupling and told the roll to accept the next span
  // whatever it was. Direction is a property of the command now, and commands carry their source.
}

export interface NoteHit {
  noteId: string | null;
  note: alphaTab.model.Note | null;
  beat: alphaTab.model.Beat;
  /** Screen rect of the notehead (or the beat, when no note resolved). */
  rect: { x: number; y: number; w: number; h: number };
  /**
   * Which staff the pointer was on. It decides what a drag from here means — pitch on the
   * notation staff, string on the tab — and it is what the keyboard equivalents have to
   * route on too. Null when there is no way to tell.
   */
  staff: StaffKind | null;
  /**
   * WHICH PART THIS IS, carried on every hit rather than looked up per decision.
   *
   * A note id was not enough identity and the gap was reachable: an EMPTY imported staff has no
   * note under the pointer, so a guard written as "is this note id an imported one?" answered
   * "no" for the one case where the answer matters most, and the press fell through to seek or
   * to an edit on a part that is paper. `trackIndex` comes off `bar.staff.track`, so it is the
   * engraving's own answer and it is there whether or not a note resolved.
   */
  trackIndex: number | null;
  /** True when `trackIndex` is the take's own part — the only part v1 edits. */
  live: boolean;
  /** The MASTER bar under the pointer, 0-based. Null when nothing is engraved there. */
  barIndex: number | null;
}

/**
 * WHERE A RIGHT-CLICK LANDED, as a semantic target rather than as a pixel.
 *
 * Everything the context menu has to decide — which items exist, which are enabled, what the
 * ticked value is — is a question about the MUSIC at that point, and the sheet is the only
 * object that can answer it: it owns the engraving's geometry, the clefs and the staff ladder.
 * So the sheet answers all of it once, and `ui/app.ts` builds a menu out of the answer without
 * ever converting a pixel itself.
 */
export interface SheetTarget {
  /**
   * Where the press landed, for placing the menu — in LOGICAL client pixels (G1).
   *
   * Logical rather than raw `clientX/clientY` because the menu is `position: fixed` inside a body
   * that carries the face scale, and a fixed element's offsets are read in the design's own
   * pixels. Converted here, once, so `ui/app.ts` still "builds a menu out of the answer without
   * ever converting a pixel itself".
   */
  clientX: number;
  clientY: number;
  /** The note under the pointer, if the press was on one. */
  noteId: string | null;
  /** Which part, and whether it is the live one. See `NoteHit.trackIndex`. */
  trackIndex: number | null;
  live: boolean;
  /** The master bar the press was in, 0-based. */
  barIndex: number | null;
  /** Which staff, so an "add note" on the TAB can be refused rather than guessed at. */
  staff: StaffKind | null;
  /**
   * The engraved tick under the pointer, unrounded.
   *
   * NOT snapped to a beat here: rounding needs the meter and the divisions, which live in the
   * IR, and the sheet does not hold the IR's bar list. `ui/app.ts` rounds it. Handing over a
   * rounded number would be this file guessing at music theory with geometry.
   */
  tick: number | null;
  /**
   * The MIDI pitch the pointer's height names on a NOTATION staff, in the current key.
   *
   * Null over a TAB staff, and deliberately: a y over a tab identifies a STRING, not a pitch,
   * and the fret is the other half of the answer. Inventing an open-string note there would be
   * a surprise, so empty-space "Add note" exists on notation staves only.
   */
  midi: number | null;
}

export interface RenderInfo {
  /** ms from renderScore() call to postRenderFinished. */
  durationMs: number;
  beatCount: number;
  /** True when two BarBounds per master bar were seen, i.e. the staff/tab split is known. */
  hasStaffTabSplit: boolean;
}

interface NameLabel {
  el: HTMLElement;
  x: number;
}

/**
 * One label in the note-names row, WITH THE NOTE IT IS ABOUT (P6).
 *
 * `noteId` is the whole of the addition. A press on a label used to be resolved by X alone
 * (`hitTestByX`), which walks the beats, finds the nearest anchor and takes `beat.notes[0]` — so
 * on a CHORD every one of the stacked names selected the same, bottom, member. Clicking "C3"
 * highlighted C2, which reads on screen as "the short member cannot be selected at all". The
 * label knows perfectly well which note it was drawn for; it now carries it.
 *
 * `null` for a label whose note has no stable id, which nothing in the live take produces but
 * an imported part can — the press then falls back to the by-X answer, as before.
 */
interface WantedName {
  x: number;
  y: number;
  text: string;
  uncertain: boolean;
  noteId: string | null;
}

/**
 * Name-row metrics, in px. These are the numbers the CSS produces (`.note-name` is
 * 10.5px/1 with 1px padding), kept here because the placement maths needs them and a
 * silent disagreement between the two is exactly how the row ended up on top of the tab.
 */
const NAME_HEIGHT = 13;
/**
 * Half the on-screen width of a label, in px, without measuring it.
 *
 * `.note-name` is `600 10.5px ui-monospace` with 2px of padding either side (ui/styles.css), and
 * a monospace advance is 0.6em — so a name's width is arithmetic rather than a layout question.
 * Measuring instead would mean a `getBoundingClientRect` per label per render, on a row that can
 * hold four hundred of them, to learn a number that only ever depends on the character count.
 */
function nameHalfWidth(text: string): number {
  return (text.length * 6.3 + 4) / 2;
}

/**
 * One element for one of the three decoration rows: a class, and a tooltip if the row has one.
 *
 * The three `sync*` builders had the same four lines each, and all three now also have to be
 * reachable from the parked pool (§THE PARKED POOLS) — so the "make a fresh one" half is stated
 * once, here, and each row is left saying only which class and which tip it wants.
 */
function labelSpan(className: string, tip?: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  if (tip) el.setAttribute('title', tip);
  return el;
}
/** Chord names stack upward from the anchor by this much per extra note. */
const NAME_STACK_STEP = 12;
/** How far above the top of the system the LOWEST name of an 'above' row sits. */
const NAMES_ABOVE_GAP = 16;

/**
 * The tallest stack of NAMES any beat in this score will ask for. See `reserveTopRoom`.
 *
 * Counted the same way the row itself counts (`rebuildOverlays`): tie DESTINATIONS get no name,
 * because a note held across a bar line is one attack engraved as several noteheads and labelling
 * every glyph is what produced the reported "A1 A1 A1 A1" stutter. So a chord's height here is
 * the number of names that will actually be drawn over it, not the number of noteheads.
 *
 * Over the MODEL rather than the bounds, because this runs before the first render of this score
 * — which is the whole point: the padding has to be right for the frame the clipping was a
 * photograph of, not one corrective render later.
 */
function maxChordSize(score: alphaTab.model.Score): number {
  let most = 1;
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            let n = 0;
            for (const note of beat.notes) if (!note.isTieDestination) n++;
            if (n > most) most = n;
          }
        }
      }
    }
  }
  return most;
}
/**
 * The tallest chord the headroom is sized for (P5).
 *
 * The owner's own number: "stacks are 3–5 max" on the material this app is for. It is a CAP and
 * not an assumption — `reserveTopRoomFor` takes the smaller of this and the tallest stack the
 * score actually contains, so an ordinary single-note riff reserves nothing at all and a
 * pathological twelve-note cluster reserves five names' worth rather than half the pane.
 */
const MAX_STACK_FOR_HEADROOM = 5;
/**
 * How far tab fret digits rise above the y that `BarBounds.visualBounds` calls the top of
 * the tab staff. They are centred ON the top line, so that y is the MIDDLE of the topmost
 * digit, not its top — placing a label flush to it means placing it on the digit.
 *
 * Measured, not guessed: alphaTab draws them at 14px Arial in a 16px box whose top lands
 * 10px above that y. 13 clears the box with a little to spare, and the harness asserts
 * zero intersections between the labels and those digits at every viewport.
 */
const TAB_DIGIT_RISE = 13;
/** Breathing room under the staff's own bottom overflow (stem tips, staccato dots). */
const STAFF_CLEARANCE = 2;
/** How far the octave-fold marker sits above the fret digit it belongs to. */
const TAB_MARK_RISE = 6;

/**
 * Empty space kept at the left of the engraving, in px.
 *
 * It is the piano roll's pitch-label gutter, IMPORTED rather than copied: the roll paints
 * its note names in a column that width, and the two strips are only in the same
 * coordinate system if the sheet leaves that same column blank. Copy the number and the
 * day somebody widens the roll's labels the two drift apart silently, which is the exact
 * class of bug this whole x-axis exists to kill.
 */
const LEFT_INSET_PX = TIMELINE_GUTTER_PX;

/**
 * How far the leftmost engraved ink sticks out to the LEFT of `display.padding[0]`, per
 * unit of `display.scale`.
 *
 * alphaTab puts the staff system at exactly `padding[0]`, but two things are drawn to the
 * left of that line: the system bracket (about 3px at scale 1) and the sideways track
 * name (another 6px). Both scale linearly with `display.scale` — measured at 0.5, 1 and 2
 * in the 1.8.4 build that ships with this repo — so ONE number, divided by the scale,
 * describes the overhang at every zoom.
 *
 * It starts as the measured value for a named single track, and `tuneLeftInset()` replaces
 * it with whatever the current score actually produced. Module-level and not per instance
 * on purpose: it is a property of alphaTab's engraving, not of one TriView, and app.ts
 * throws the TriView away and builds a new one on every DOM rebuild.
 */
let leftInkOverhangPerScale = 9;

/**
 * The floor on that overhang for a BRACED system, per unit of `display.scale`.
 *
 * A grand staff is two staves joined by an accolade — a brace, plus the bracket and the sideways
 * track name — and all of it is drawn to the left of the system line. The measured single-staff
 * value (9) does not cover it, so the very first frame of a grand-staff score put the brace, and
 * with it the left edge of the clef and time signature, outside the scroller and the container
 * cut them off. It was reported from a photograph of exactly that.
 *
 * `tuneLeftInset()` still measures and still wins afterwards; this only stops the FIRST render
 * from being the wrong one, which on a score that never re-renders is the only render there is.
 * Deliberately generous rather than exact: over-reserving costs a few px of white space at the
 * left, under-reserving costs a clipped clef.
 */
const BRACED_LEFT_OVERHANG_PER_SCALE = 22;

/**
 * How many corrective left-inset renders one score (or one zoom) may cost.
 *
 * Two, not one: the first pass measures and corrects, the second exists only for the case where
 * the first still left ink outside the container. See `TriView.insetTuneBudget`.
 */
const INSET_TUNE_PASSES = 2;

/**
 * alphaTab display scale limits. 1.0 is the default.
 *
 * Exported because Align's coupled zoom is computed OUTSIDE this class — `coupledSheetScale`
 * needs the clamps to work against, and a caller that guessed them would either fight `setZoom`'s
 * own clamp (asking for 6 and getting 3 every notch, so the roll and the sheet drift apart) or
 * stop short of a zoom the sheet would have allowed.
 *
 * THE FLOOR IS 0.6, UP FROM 0.4, AND IT IS A MEASUREMENT (H2).
 *
 * 0.4 was justified as "below this the tab digits stop being readable", which had it backwards:
 * 0.4 IS below it. alphaTab draws fret digits at 14px and the music font at 36px, so at 0.4 a
 * digit is 5.6px tall and a notehead is 5px wide. Rendered live on the triplet fixture at 8 bars
 * — the picture the report is of — the whole take came out 954px wide: about 119px a bar, 12px
 * an eighth-note triplet, which is a grey smear rather than an engraving, and it is where the
 * coupling used to park itself (see pianoroll.ts §reportTimeWindow). At 0.6 a digit is 8.4px and
 * a triplet gets 18px, which is the point at which the same render is readable in a screenshot.
 *
 * THE ROLL ADAPTS AND THE SHEET DOES NOT. Past this floor the coupling simply stops magnifying
 * the sheet while the roll goes on zooming out — the two panes then show different spans, which
 * is visibly a limit rather than a fault. The alternative is a sheet that is present but cannot
 * be read, which is worse than one that has stopped following.
 */
export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 3.0;

/** We only ever render track 0. Hoisted so a per-note query does not allocate a Set. */
const TRACK_ZERO = new Set([0]);

/**
 * tick -> x for the WHOLE score, in content coordinates, built once per render.
 *
 * `ticks` is strictly ascending and so is `xs`, which is only true because the score is
 * engraved in `LayoutMode.Horizontal` — one staff system, time running left to right and
 * never wrapping. `systems` records what the bounds lookup actually reported so that
 * assumption is visible in `layoutProbe()` rather than merely believed.
 *
 * The last entry is not a beat: it is the end of the final beat, placed at the right edge
 * of the last engraved bar. Without it there is nowhere to put the tail of the take, and a
 * roll rectangle that ends on the final beat would collapse to zero width.
 */
interface TickAxis {
  ticks: number[];
  xs: number[];
  systems: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * How far the pointer has to travel before a click becomes a drag.
 *
 * Small enough that a deliberate move is picked up at once, large enough that the shake in
 * a real hand on a trackpad does not turn "select this note" into "transpose it".
 */
const DRAG_THRESHOLD_PX = 3;

/** Matches `AppSettings.maxFret`'s default. Overridden through the option or `setFretLimit`. */
const DEFAULT_MAX_FRET = 17;

/**
 * THE TOP PRINTED LINE OF EACH CLEF, as a diatonic index where 0 is middle C (C4, MIDI 60).
 *
 * Counting in DIATONIC steps rather than semitones is not a convenience: a staff position is a
 * letter, not a pitch, which is exactly why the key signature has to be applied afterwards. Two
 * clefs are listed because two are engraved — treble and bass. Anything else falls back to
 * treble rather than answering with a pitch it cannot justify.
 *
 *   G2 (treble)  top line F5 = C4 + 10 diatonic steps
 *   F4 (bass)    top line A3 = C4 - 2 diatonic steps
 */
const TOP_LINE_DIATONIC: Partial<Record<alphaTab.model.Clef, number>> = {
  [alphaTab.model.Clef.G2]: 10,
  [alphaTab.model.Clef.F4]: -2,
  [alphaTab.model.Clef.C3]: 4,
  [alphaTab.model.Clef.C4]: 2
};

/** Semitones above C for each letter of the scale, C D E F G A B. */
const DIATONIC_SEMITONES = [0, 2, 4, 5, 7, 9, 11] as const;
/** The order sharps are added in, as scale degrees: F C G D A E B. */
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6] as const;
/** And flats: B E A D G C F. */
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3] as const;

/** What the key signature does to one letter. ±1 semitone, or nothing. */
function keyAlteration(degree: number, fifths: number): number {
  if (fifths > 0) return SHARP_ORDER.slice(0, Math.min(7, fifths)).includes(degree as 0) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, Math.min(7, -fifths)).includes(degree as 0) ? -1 : 0;
  return 0;
}

/** A diatonic index (0 = C4) as a sounding MIDI note, in the given key. */
function diatonicToMidi(index: number, fifths: number): number {
  const octave = Math.floor(index / 7);
  const degree = index - octave * 7;
  const midi = 60 + octave * 12 + DIATONIC_SEMITONES[degree] + keyAlteration(degree, fifths);
  return Math.max(0, Math.min(127, midi));
}

/** Everything one in-flight note drag needs to remember. See the drag section on the class. */
interface DragState {
  noteId: string;
  note: alphaTab.model.Note;
  staff: StaffKind;
  startClientY: number;
  startClientX: number;
  /**
   * WHICH AXIS THIS DRAG IS ABOUT, decided once and then locked (Z4d).
   *
   * Null until the pointer has moved past the threshold. A horizontal drag now means "attack it
   * somewhere else" and a vertical one still means pitch (or string), so without a lock an
   * ordinary diagonal wobble on a pitch drag would also move the note in time — a hand that
   * meant one thing doing two. Whichever component was larger when the drag was recognised wins,
   * and it keeps winning: re-deciding mid-drag would make the note jitter between two meanings.
   */
  axis: 'pitch' | 'time' | null;
  /** Time drags only: where the note was dropped, unrounded. See `NoteDragCommit`. */
  tick: number | null;
  /** Time drags only: the ghost's x offset from the grabbed glyph, in content px. */
  dx: number;
  /** False on an imported part, where a drag may look at the music and change nothing. */
  editable: boolean;
  /** The grabbed glyph, in content coordinates — the ghost is drawn relative to it. */
  head: { x: number; y: number; w: number; h: number };
  /** Pointer travel per step: half a staff space on the staff, one line gap on the tab. */
  stepPx: number;
  steps: number;
  semitones: number;
  valid: boolean;
  moved: boolean;
  chromatic: boolean;
  label: string;
  targetString?: number;
  targetFret?: number;
}

export class TriView {
  readonly api: alphaTab.AlphaTabApi;
  readonly scroller: HTMLElement;
  readonly stack: HTMLElement;
  readonly host: HTMLElement;
  readonly namesRow: HTMLElement;
  readonly tabMarksRow: HTMLElement;
  readonly stringLettersRow: HTMLElement;
  readonly partLabelHits: HTMLElement;
  readonly overlay: SVGSVGElement;

  private index: ScoreIndex | null = null;
  private currentScore: RiffScore | null = null;
  /** The alphaTab object graph on screen — what an edit mutates. See `model`. */
  private builtModel: alphaTab.model.Score | null = null;
  private accidentals: Accidentals = 'sharps';
  private labels: NameLabel[] = [];
  private tabMarks: NameLabel[] = [];
  /** The letters keep their y too: the pinned x is rewritten on scroll and needs the pair. */
  private stringLetters: Array<NameLabel & { y: number }> = [];
  /** One transparent button per printed part name. See `syncPartLabelHits`. */
  private partLabelButtons: HTMLButtonElement[] = [];
  /**
   * THE PARKED POOLS — retired label elements, hidden but STILL IN THE DOCUMENT (P4).
   *
   * The four rows above reuse their elements across renders, and until now a render that wanted
   * fewer of them `.remove()`d the surplus. That is the second half of the swallowed-gesture bug
   * described at §THE PANE IS THE HIT SURFACE: these four classes are the only things over the
   * engraving that are deliberately still hit-testable, so a pinch whose fingers happen to be
   * over a note name is latched to that `<span>` — and zooming OUT is exactly the direction that
   * makes labels stop fitting, so the very first event of the gesture could delete the element
   * the rest of the gesture was being delivered to.
   *
   * Retired elements are therefore hidden and kept, never removed, and taken back from here when
   * the row grows again. Nothing else changes: the live arrays still hold exactly the live
   * elements, so every reader of `labels.length` / `tabMarks.length` still counts what is on
   * screen. The pools are bounded by the largest row the session has ever drawn.
   */
  private readonly parked = {
    labels: [] as HTMLElement[],
    tabMarks: [] as HTMLElement[],
    stringLetters: [] as HTMLElement[],
    partLabelButtons: [] as HTMLButtonElement[]
  };
  /** noteId -> semitones the TAB position was folded by. Empty for anything in range. */
  private tabShifts = new Map<string, number>();
  private opts: TriViewOptions;
  private renderStartedAt = 0;
  private playheadLine: SVGLineElement;
  private selectionGroup: SVGGElement;
  /** The cross-highlight ring layer (#30d). Never the selection — see `setHover`. */
  private hoverGroup: SVGGElement;
  private ghostGroup: SVGGElement;
  private lastRenderInfo: RenderInfo | null = null;
  private namesPlacement: NamesPlacement;
  private showNames: boolean;
  /**
   * Which note ids are highlighted RIGHT NOW — a render input, and no longer an authority.
   *
   * IT USED TO BE ONE, and that was audit finding 7. Four places held a selection: the app's
   * runtime store, this array, `PianoRoll`'s private `Set`, and the waveform's time range. Every
   * rebuild path updated a different subset. `rebuildNotation` cleared only the runtime, so the
   * old rings survived on a page that no longer contained those notes; `renderMain` destroyed and
   * rebuilt both views without reapplying anything, so a fresh TriView started empty while the
   * runtime still believed something was selected; and `load()` deliberately RETAINED this array
   * across a score replacement, which is how a ring came to be drawn around whichever note in the
   * new score happened to inherit the same id.
   *
   * Now: `DocumentState.selection` (the runtime store) is the only authority, and this is a copy
   * of it that arrives WITH the score it applies to. `load()` takes the selection as an argument
   * rather than keeping the old one, so there is no frame in which this array describes a
   * different score from `this.index`.
   */
  private selectedIds: string[] = [];
  /**
   * THE REVISION THIS VIEW'S MODEL AND INDEX DESCRIBE, and separately the one its BOUNDS do.
   *
   * These are two numbers because they really can differ, which is audit finding 8 and the
   * mechanism behind the intermittent dead click after an edit. `load()` replaces the score, the
   * index and alphaTab's model and then asks for a render — but a render into a host that is
   * hidden, zero-width or not yet renderable returns early WITHOUT replacing
   * `renderer.boundsLookup`. The bounds then still describe the PREVIOUS engraving, so
   * `hitTest` resolves a real `Note` object out of them, looks it up in the NEW index, finds
   * nothing, and returns `noteId: null` — which the app reads as "empty space" and answers with
   * a seek. A click on a visible notehead did nothing, intermittently, and only after an edit.
   *
   * Stamping both sides and comparing turns that silent wrong answer into a refusal: a hit whose
   * bounds predate the current index is REJECTED. See `hitTest`.
   */
  private modelRevision = 0;
  private boundsRevision = -1;
  /** Rejections since construction, so a probe can prove one happened rather than infer it. */
  private staleHitRejections = 0;
  /** Built lazily from the bounds, thrown away by every `rebuildOverlays`. */
  private axis: TickAxis | null = null;
  /** The last viewport we told the caller about, so we only fire on a real change. */
  private lastViewport: TriViewViewport | null = null;
  private viewportFrame = 0;
  /**
   * The tick that was at the left edge before a zoom, so the same music can be put back
   * there afterwards. `atStart` is kept separately: "I was at the very beginning" is a
   * stronger statement than "I was at tick 0" and should survive exactly.
   */
  /** Where `setScrollLeft` last put us, until the scroll event it caused has been seen. */
  private programmaticScrollTo: number | null = null;
  private scrollAnchorTick: number | null = null;
  /** ALIGN's pending anchor: the tick that must be at the music column's left edge (#30). */
  private alignAnchorTick: number | null = null;
  private scrollAnchorAtStart = false;
  /**
   * How far from the LEFT EDGE the anchor tick has to land, in px. 0 for every zoom that came
   * from a button or the coupling; the pointer's own offset for a pinch (see `zoomAt`).
   */
  private scrollAnchorOffsetPx = 0;
  /**
   * THE RENDER GATE. Nothing may ask alphaTab to render while alphaTab is rendering.
   *
   * With `useWorkers` and `enableLazyLoading` both off — which they are, and must stay (see
   * view/atSettings.ts) — a render is entirely SYNCHRONOUS: `api.render()` lays out, paints
   * every partial, fires `partialRenderFinished` for each one and then `postRenderFinished`,
   * all on one stack. This view listens to both of those, and both listeners call OUT: the
   * partial one rebuilds the overlays and publishes a viewport, the post one publishes a render
   * and a viewport. A listener that comes back in through `setZoom`, `applyGap` or
   * `tuneLeftInset` therefore starts a SECOND render inside the first.
   *
   * That is not merely wasteful, it is how two engravings end up on screen at once. alphaTab's
   * browser facade holds one placeholder `<div>` per partial and reuses them BY INDEX, resetting
   * its index counter on every `preRender` (`BrowserUiFacade.beginAppendRenderResults`, and the
   * counter is `_totalResultCount`). A render nested inside another resets that counter to 0 and
   * refills the placeholders from the top; when the outer stack unwinds, its remaining partials
   * no longer find a placeholder to reuse and APPEND fresh ones instead — absolutely positioned,
   * at the outer render's coordinates. Two engravings then sit on top of each other, offset by
   * exactly the difference in scale or page padding between them, and the trailing "remove the
   * placeholders nobody claimed" sweep cannot see it because the counter is now too high.
   *
   * ONE SUCH NEST IS REAL TODAY: `tuneLeftInset()` is called from `postRenderFinished` and used
   * to render straight back into the render that was finishing. It nests at the very END of the
   * outer render, so it happens to be survivable; it is one reordering away from not being, and
   * nothing about the arrangement said so.
   *
   * So every render this class starts goes through `startRender`, which runs it now if the
   * stack is clear and otherwise runs it the moment the current one has finished. Never nested,
   * never dropped.
   */
  private renderInFlight = false;
  private queuedRender: (() => void) | null = null;
  /**
   * THE FACADE FRAME, and this is the THIRD ghosting mechanism — the one the render gate and
   * `reuseViewport: false` could not touch, because it is not about nesting or about reuse.
   *
   * alphaTab's browser facade reclaims stale partial placeholders by counting them. Every
   * render appends its partials into `.at-surface` at `_totalResultCount`, reusing whatever is
   * already there, and the sweep at the end of a render is
   *
   *     while (childElementCount > _totalResultCount) remove the last child
   *
   * The counter is reset to 0 by a listener on `renderer.preRender` — and that listener is
   * registered inside `BrowserUiFacade.initialRender()`, which `AlphaTabApiBase`'s constructor
   * schedules through `uiFacade.beginInvoke`, i.e. inside `requestAnimationFrame`. So for the
   * whole of the first animation frame after `new AlphaTabApi(...)` THE COUNTER NEVER RESETS.
   *
   * Any render started in that frame therefore APPENDS rather than reuses, and the sweep
   * removes nothing because the counter has kept climbing. Two renders in that frame leave two
   * complete engravings inside one surface, a few pixels apart — every glyph doubled, which is
   * exactly what the report was a photograph of.
   *
   * TWO renders in the first frame is the ordinary case for a GRAND STAFF, which is why only
   * grand-staff scores showed it: `load()` renders once at the braced-overhang GUESS
   * (`BRACED_LEFT_OVERHANG_PER_SCALE`) and `tuneLeftInset()` immediately re-renders at the
   * measured value. A single-staff score reuses the already-tuned module-level
   * `leftInkOverhangPerScale`, so its first frame costs one render and it never doubled.
   * Measured, live: `.at-surface > div` went 2 -> 4 with two 477-glyph copies at widths 3557
   * and 3551 the moment the clef was switched to Grand.
   *
   * The fix is to hold every render until the facade has had its frame. One rAF, registered
   * here — after alphaTab's own, in the same frame, so it is guaranteed to run after it. The
   * cost is that the very first engraving of a view lands one frame later; the alternative is
   * that it lands twice.
   */
  private facadeReady = false;
  private facadeFrame = 0;
  private deferredRender: (() => void) | null = null;
  /**
   * Partials this render laid out. Our own copy of the facade's `_totalResultCount`, kept so
   * `trimSurface()` can repair a miscount rather than trust one. See `trimSurface`.
   */
  private partialsThisRender = 0;
  /** Stale placeholders removed since this view was built. MUST stay 0 — see `trimSurface`. */
  private ghostsTrimmed = 0;
  /**
   * The widest a render has had to grow `.at-surface` past the box alphaTab gave it, in px.
   *
   * Non-zero is NORMAL and is the repair working — see `growSurfaceToPartials`. It is published
   * so the harness can assert that the repair is what keeps a zoomed-in sheet on screen, rather
   * than assert that a screenshot has ink in it.
   */
  private surfaceGrownPx = 0;
  /**
   * True from the moment a render is asked for until one finishes. See `renderPending`.
   *
   * A flag rather than a request/finish counter on purpose: alphaTab renders on its own account
   * too (a container resize goes straight to `resizeRender`), so a counter this class keeps
   * would drift the moment it was not the only one asking, and a drifted counter answers the
   * anchor's question wrongly for the rest of the session.
   */
  private awaitingRender = false;
  /**
   * How many more corrective left-inset renders this score may have. The hard stop on any loop.
   *
   * It was a single boolean, which allowed exactly one correction per render and was the right
   * number while the relationship was linear with slope one. A BRACED system broke that
   * assumption in the only way that matters: if the first pass still leaves ink outside the
   * container, there was no second pass and the clef stayed clipped. A small budget is bounded
   * in exactly the same way a boolean is and covers the case.
   */
  private insetTuneBudget = 0;
  /** True when the score renders more than one stave — a grand staff, or grand staff + tab. */
  private multiStaff = false;
  /** Does the engraved score show tablature at all? See `reserveTopRoom`. */
  private hasTabStave = false;
  /** Highest playable fret. Only used to decide whether a drag is possible. */
  private maxFret: number;
  /** The key signature, for turning staff positions into semitones. */
  private keyFifths = 0;
  /** Which staff the last selecting click landed on. Routes the keyboard equivalents. */
  private selectionStaffKind: StaffKind | null = null;
  private drag: DragState | null = null;
  /** What the last finished drag emitted — for the headless harness, which cannot watch a callback. */
  private lastDragCommit: NoteDragCommit | null = null;
  private lastDragPreview: NoteDragPreview | null = null;
  private cursorFrame = 0;
  /** Notes the ROLL says the pointer is over. Rings only — never the selection (#30d). */
  private hoveredIds: string[] = [];
  /** The last note reported OUTWARD, so the same one is not reported twice. */
  private hoverReported: string | null = null;
  /** How many "rendered by alphaTab" nodes have been removed since this view was built (#40). */
  private creditsRemoved = 0;

  constructor(opts: TriViewOptions) {
    this.opts = opts;
    this.namesPlacement = opts.namesPlacement ?? 'between';
    this.showNames = opts.showNames ?? true;

    // THE GESTURE RECORDER (D2), behind its flag and inert without it. Installed from here
    // because this is the first thing built for the screen the gestures happen on; it listens on
    // `window` in the capture phase, so it sees the roll's and the strip's events too, and it is
    // passive, so it cannot change what any of them do. See view/gestureRecorder.ts for the
    // one-step recipe.
    installGestureRecorder(opts.exportFile);

    opts.container.classList.add('triview');
    opts.container.innerHTML = `
      <div class="triview-scroll">
        <div class="triview-stack">
          <div class="at-host"></div>
          <div class="names-row" aria-hidden="true"></div>
          <!-- Not aria-hidden, unlike the three decoration rows around it: the buttons in here
               are the only control for the printed part names. See syncPartLabelHits(). -->
          <div class="part-label-hits"></div>
          <div class="tabmarks-row" aria-hidden="true"></div>
          <div class="stringletters-row" aria-hidden="true"></div>
          <svg class="triview-overlay" xmlns="http://www.w3.org/2000/svg">
            <!-- Under the selection on purpose: a note can be both, and the answer
                 ("selected") must be the one you see. See drawHover(). -->
            <g class="hover"></g>
            <g class="selection"></g>
            <line class="playhead" x1="0" y1="0" x2="0" y2="0" />
            <g class="drag-ghost"></g>
          </svg>
        </div>
      </div>`;

    this.scroller = opts.container.querySelector('.triview-scroll')!;
    this.stack = opts.container.querySelector('.triview-stack')!;
    this.host = opts.container.querySelector('.at-host')!;
    /*
     * §THE PANE IS THE HIT SURFACE (P4) — the engraving is a PICTURE, not a target.
     *
     * THE BUG THIS FIXES, as the owner reported it: a pinch over the sheet zooms perfectly when
     * the pointer is over the empty space BELOW the music and is dead, or dies after one event,
     * when it is directly over the engraving.
     *
     * THE MECHANISM, and it is not "something calls preventDefault". Every listener below is on
     * `this.scroller`, and events bubble, so where the pointer is cannot change WHICH handler
     * runs — it changes which node the platform DELIVERS the gesture to. On macOS both roads
     * (see view/gesture.ts) are LATCHED: WebKit hit-tests once, at the start of the gesture, and
     * routes every later `wheel`, `gesturechange` and `gestureend` of that same pinch to the node
     * it found. If that node leaves the document mid-gesture the latch is dropped and the rest of
     * the pinch is dispatched to nobody.
     *
     * And over the engraving the latched node is ALWAYS destroyed, by the pinch itself: the hit
     * is an alphaTab `<path>` or `<text>` inside a partial `<div>`, the first event of the pinch
     * asks for a zoom, the zoom re-engraves, and alphaTab replaces every partial. One event
     * lands, the fingers keep moving, nothing else arrives — "dead/unreliable". Below the music
     * the hit is `.triview-scroll` itself, which is built once in this constructor and outlives
     * every render there will ever be, so the latch holds and the same pinch works perfectly.
     * That is the whole of the difference the owner was seeing.
     *
     * MEASURED, not deduced. With this line reverted, scripts/scrollzoom-probe.mjs §P4 reports at
     * a notehead, a beam, a staff line, a TAB digit and a name label: the node under the pointer
     * is `isConnected === false` one pinch event later, where the node below the music is the one
     * it always was — and on the GestureEvent road, which is delivered to one latched node the
     * way macOS delivers it, the same pinch is worth x1.06 over the engraving against x1.2625
     * over the empty pane. One event of four. Both faces, both roads, level at x1.2625 with this.
     *
     * SO THE STACK STOPS BEING HIT-TESTABLE, and with it the whole engraving underneath it: at
     * every pixel of the pane, glyph or not, the node a gesture latches to is now `.triview-scroll`.
     * Nothing is lost, because nothing here has ever asked the DOM what is under the pointer —
     * `hitTest`/`hitTestByX`/`targetAt` all work from client coordinates against alphaTab's
     * bounds lookup, the hover cursor is written to the scroller, and no alphaTab mouse event
     * (`beatMouseDown` and friends) is subscribed anywhere in this app.
     *
     * AND IT GIVES THE NAME LABELS BACK, which nobody had noticed was missing. alphaTab gives
     * each engraved partial `z-index: 1` and the four decoration rows have none, so the music was
     * painted — and therefore hit-tested — ON TOP of the very labels those rows exist to make
     * clickable: with this line reverted the probe cannot find a single `.note-name` whose topmost
     * element is itself, out of the forty-eight on screen. `onPointerDown`'s `.note-name` branch
     * (P6, "the label's OWN note first") was unreachable anywhere over the engraving. It is not
     * unreachable now, because the thing that was covering the labels no longer takes hits.
     *
     * THE FOUR EXCEPTIONS ARE THE FOUR CONTROLS, and they say so themselves: `.note-name`,
     * `.tab-mark`, `.string-letter` and `.part-label-hit` set `pointer-events: auto` in
     * ui/styles.css and stay clickable, hoverable and focusable through this. They are the reason
     * §THE PARKED POOLS exists — being a hit target is exactly what makes being deleted mid-pinch
     * dangerous.
     *
     * IN CODE RATHER THAN IN THE STYLESHEET on purpose. This is not how the pane looks; it is the
     * contract between the pane and the four handlers registered thirty lines below, and the two
     * have to be read together or the next person moves one without the other.
     */
    this.stack.style.pointerEvents = 'none';
    this.namesRow = opts.container.querySelector('.names-row')!;
    this.tabMarksRow = opts.container.querySelector('.tabmarks-row')!;
    this.stringLettersRow = opts.container.querySelector('.stringletters-row')!;
    this.partLabelHits = opts.container.querySelector('.part-label-hits')!;
    this.overlay = opts.container.querySelector('.triview-overlay')!;
    this.playheadLine = this.overlay.querySelector('.playhead')!;
    this.selectionGroup = this.overlay.querySelector('.selection')!;
    this.hoverGroup = this.overlay.querySelector('.hover')!;
    this.ghostGroup = this.overlay.querySelector('.drag-ghost')!;
    this.maxFret = opts.maxFret ?? DEFAULT_MAX_FRET;

    const settings = createSettings({
      // Reserve the roll's label column before the first render, so the very first frame
      // is already aligned. tuneLeftInset() trims it to the pixel afterwards.
      leftPadPx: LEFT_INSET_PX + leftInkOverhangPerScale * (opts.view?.scale ?? 1),
      ...opts.view,
      namesGap: this.needsGap()
    });
    this.api = new alphaTab.AlphaTabApi(this.host, settings);

    // postRenderFinished is the one that matters: renderFinished can fire before the
    // bounds are usable (Escala works around this with a 50ms setTimeout; 1.8 gives us
    // the proper event instead).
    this.api.postRenderFinished.on(() => this.onPostRender());
    // Partials arrive one at a time even with lazy loading off, and each one adds bounds,
    // so the overlay is rebuilt as they land rather than only at the end.
    this.api.renderer.partialRenderFinished.on(() => this.rebuildOverlays());
    // OUR OWN placeholder count, for `trimSurface`. Subscribed AFTER the facade's own two
    // listeners (registered in alphaTab's constructor above), so by the time these run the
    // placeholder for the partial already exists. The `width/height` test mirrors
    // `_appendRenderResult`'s: a zero-size partial is laid out but never given a placeholder,
    // and counting it would make the trim remove one live partial too many.
    this.api.renderer.preRender.on(() => {
      this.partialsThisRender = 0;
    });
    this.api.renderer.partialLayoutFinished.on((r) => {
      if (r.width > 0 || r.height > 0) this.partialsThisRender++;
    });
    // See §THE FACADE FRAME. Registered after alphaTab's own `beginInvoke` rAF and therefore
    // guaranteed to run after it, in the same frame.
    this.facadeFrame = requestAnimationFrame(() => {
      this.facadeFrame = 0;
      this.facadeReady = true;
      (window as any).__RSLOG__ = ((window as any).__RSLOG__ ?? []).concat([{ what: 'facadeFrame', held: !!this.deferredRender }]);
      const held = this.deferredRender;
      this.deferredRender = null;
      if (held) this.startRender(held);
    });

    this.scroller.addEventListener('pointerdown', this.onPointerDown);
    this.scroller.addEventListener('contextmenu', this.onContextMenu);
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    // Not passive: a pinch arrives as a ctrl-wheel and the browser would zoom the whole plugin
    // window with it unless this says it was handled. See `onSheetWheel`.
    this.scroller.addEventListener('wheel', this.onSheetWheel, { passive: false });
    this.scroller.addEventListener('gesturestart', this.onGestureStart, { passive: false });
    this.scroller.addEventListener('gesturechange', this.onGestureChange, { passive: false });
    this.scroller.addEventListener('gestureend', this.onGestureEnd, { passive: false });
    // Hover only: the cursor has to say "this note can be moved up and down" before
    // anybody tries it. The drag itself listens on window, so it survives the pointer
    // leaving the element mid-gesture.
    this.scroller.addEventListener('pointermove', this.onHoverMove, { passive: true });
    this.scroller.addEventListener('pointerleave', this.onHoverLeave, { passive: true });
  }

  // -------------------------------------------------------------------------
  // Score loading and re-rendering
  // -------------------------------------------------------------------------

  /**
   * Run a render, or hold it until the one on the stack has finished. See the render gate.
   *
   * The queue is one deep on purpose. Two requests raised during one render are two descriptions
   * of the SAME wanted state — a new scale, a new padding — and running both would engrave a
   * frame nobody will ever see. The last one wins because it is the most recent statement of
   * what the page should look like.
   */
  private startRender(run: () => void): void {
    (window as any).__RSLOG__ = ((window as any).__RSLOG__ ?? []).concat([{ what: 'startRender', ready: this.facadeReady, inFlight: this.renderInFlight, from: new Error().stack?.split('\n')[2]?.trim() }]);
    this.awaitingRender = true;
    // Nothing renders before alphaTab's facade has initialised itself. See §THE FACADE FRAME:
    // a render in that window cannot have its placeholders reclaimed, and two of them leave two
    // engravings on screen. One deep, same argument as the queue below.
    if (!this.facadeReady) {
      this.deferredRender = run;
      return;
    }
    if (this.renderInFlight) {
      this.queuedRender = run;
      return;
    }
    this.renderInFlight = true;
    try {
      this.renderStartedAt = performance.now();
      run();
    } finally {
      this.renderInFlight = false;
    }
    const queued = this.queuedRender;
    if (!queued) return;
    this.queuedRender = null;
    // Not recursion in any meaningful sense: the stack is clear again, and the queue is one
    // deep, so this runs at most once more per render that asked for one.
    this.startRender(queued);
  }

  /**
   * True while a re-engrave is still owed to somebody.
   *
   * The question a PENDING anchor has to ask before it arms itself: an anchor that no render
   * will consume is not a promise, it is a landmine that goes off on the next unrelated render.
   * Because renders are synchronous (see the render gate), the usual answer after `setZoom` has
   * returned is FALSE — the re-engrave has already happened — and the only times it is true are
   * a render that alphaTab has deferred (container not renderable yet) and one this class has
   * queued behind the current stack.
   */
  private renderPending(): boolean {
    return this.awaitingRender;
  }

  /**
   * Full load: build the alphaTab object graph from the pipeline's data and render it.
   *
   * `selection` IS NOT OPTIONAL IN SPIRIT, only in signature. It is the authority's answer for
   * the score being loaded, and passing it here rather than in a separate `setSelection` call is
   * what makes the publish atomic: there is no instant in which this view holds a new index and
   * an old selection. Omitting it means "nothing is selected in this score", which is the correct
   * reading for every caller that has no authority to consult — not "keep what you had", which is
   * what this method used to do and which is finding 7.
   */
  load(score: RiffScore, selection: ReadonlyArray<string> = []): void {
    this.currentScore = score;
    this.keyFifths = score.ir.key.fifths ?? 0;
    this.accidentals = accidentalsForKey(score.ir.key.fifths);
    this.cancelDrag();
    // A hover names a note in the score being replaced. Carrying it over would ring whatever
    // note in the NEW score happened to be given the same id.
    this.hoveredIds = [];
    this.reportHover(null);
    // Same for a pending Align anchor: a tick in the old score is not the same moment in this one.
    this.alignAnchorTick = null;
    this.tabShifts = collectTabOctaveShifts(score);
    const built = buildAlphaTabScore(score.data, this.api.settings);
    this.index = built.index;
    this.builtModel = built.score;
    /*
     * THE ATOMIC PUBLISH. Model, index and selection are replaced together, under one new
     * revision, BEFORE the render is requested — and the bounds are left explicitly behind
     * (`boundsRevision` keeps its old value) until a render actually produces new ones.
     *
     * That asymmetry is the fix rather than an oversight. The bounds are the one part of this
     * quartet that alphaTab owns and that a render may decline to replace; pretending they are
     * current at publish time is precisely the assumption that produced the dead click.
     */
    this.modelRevision++;
    this.selectedIds = [...selection];
    // A braced system needs a wider reserved column than a single staff, and it needs it BEFORE
    // the first render rather than one corrective render later. See BRACED_LEFT_OVERHANG_PER_SCALE.
    this.reserveLeftColumnFor(built.score);
    this.insetTuneBudget = INSET_TUNE_PASSES;
    this.startRender(() => this.api.renderScore(built.score, [0]));
  }

  /**
   * Widen the reserved left column when the score about to be engraved carries a brace.
   *
   * Read off the MODEL rather than the bounds, because the bounds do not exist yet — that is
   * the whole point: this runs before the first render of this score, which is the frame the
   * clipping report was a photograph of.
   */
  private reserveLeftColumnFor(score: alphaTab.model.Score): void {
    // THE WIDEST TRACK, not `tracks[0]`. Both things this decides — the reserved left column and
    // the staff-to-staff gap — are properties of the SYSTEM, and a system is as braced as its
    // most braced part. Reading track 0 meant a grand-staff take with a one-stave import
    // reordered above it reserved the single-staff column and engraved its brace into the
    // clipping, which is the same reordering assumption as Codex finding 8.
    const staves = score.tracks.reduce((most, t) => Math.max(most, t.staves.length), 0) || 1;
    // Same measurement, second consumer: a braced system is also the one whose staves need more
    // air between them (F2b). Recorded before the render so the first frame already has it.
    this.multiStaff = staves > 1;
    /*
     * Third consumer, and the one `reserveTopRoom` reads: with no tablature there is no staff/tab
     * band for the names row to sit in, so it goes above the system and needs headroom.
     *
     * THE LIVE TRACK'S TABLATURE, NOT THE SCORE'S (per-part TAB, critique §D). The note names are
     * the LIVE part's decoration — they are placed against the live staves, by `liveBars()`, for
     * the same reordering reason as the string legend. `score.tracks.some(…)` was safe only while
     * an imported part could not have tablature at all; now that it can, an imported guitar with
     * its tab on would tell the live staff it has an inter-staff band to sit in when it does not,
     * and the names would be laid into a lane that is not there.
     *
     * The two other consumers above stay score-wide on purpose: the reserved left column and the
     * staff gap are properties of the SYSTEM, and a system is as braced as its most braced part.
     */
    const liveTrack = score.tracks[this.liveTrackIndex()] ?? score.tracks[0];
    this.hasTabStave = !!liveTrack && liveTrack.staves.some((s) => s.showTablature);
    applyStaffTabGap(this.api.settings, this.needsGap(), this.multiStaff);
    const overhang = this.multiStaff
      ? Math.max(leftInkOverhangPerScale, BRACED_LEFT_OVERHANG_PER_SCALE)
      : leftInkOverhangPerScale;
    const wanted = LEFT_INSET_PX + overhang * this.api.settings.display.scale;
    if (Math.abs(wanted - (this.api.settings.display.padding[0] ?? 0)) >= 0.5) {
      setLeftPadding(this.api.settings, wanted);
    }
    this.maxChordSize = maxChordSize(score);
    this.reserveTopRoom();
    // Unconditional: the gap above may have changed even when the padding did not, and there is
    // no render in flight yet — `load()` starts one immediately after this returns.
    this.api.updateSettings();
  }

  /** The tallest chord in the score about to be engraved. See `reserveTopRoom`. */
  private maxChordSize = 1;

  /**
   * HEADROOM ABOVE THE FIRST STAFF LINE, sized for the names row that will sit in it (P5).
   *
   * THE REPORTED FAULT: a stacked chord's names ran off the top of the sheet pane with no way to
   * scroll to them. Not a scrolling problem — `namesYFor` anchors the row `NAMES_ABOVE_GAP` above
   * the system and the stack grows UPWARD from there, so with alphaTab's default 35px of page
   * padding the third name of a stack is laid out at a negative y. A negative y is OUTSIDE the
   * scrollable content, which is why "scroll up to it" was never going to be the fix.
   *
   * So the room is reserved in the ENGRAVING's own padding, which moves the SVG and the HTML
   * labels together. The prerequisite was splitting `setLeftPadding` into per-edge writers: it
   * used to rewrite all four every time it ran, and it runs on every zoom, so any headroom
   * reserved here would have been silently destroyed by the next pinch (`atSettings.ts`).
   *
   * WHAT IT COSTS WHEN IT IS NOT NEEDED: nothing. The reserved height is derived from the score's
   * own tallest chord, capped at `MAX_STACK_FOR_HEADROOM`, and floored at alphaTab's own
   * `PAGE_PADDING_PX` — so a single-note riff, a names-off view, and the notation-plus-tab shape
   * whose row lives in the staff/tab band all keep exactly the padding they had before.
   *
   * NOT SCALED by `display.scale`: alphaTab divides page padding by the scale during layout and
   * multiplies the finished coordinates back (measured in 1.8.4, see `PAGE_PADDING_PX`), and the
   * label metrics this is computed from are CSS pixels that do not shrink with the engraving
   * either. Both sides of the sum are screen pixels, at every zoom.
   */
  private reserveTopRoom(): void {
    const stack = Math.max(1, Math.min(MAX_STACK_FOR_HEADROOM, this.maxChordSize));
    // Only the row that sits ABOVE the system needs it. The 'between' row lives in a gap that is
    // already reserved (`applyStaffTabGap`), and 'below' hangs off the bottom.
    const above =
      this.showNames &&
      (this.namesPlacement === 'above' ||
        (this.namesPlacement === 'between' && (this.multiStaff || !this.hasTabStave)));
    const wanted = above
      ? Math.max(PAGE_PADDING_PX, NAMES_ABOVE_GAP + (stack - 1) * NAME_STACK_STEP + NAME_HEIGHT / 2)
      : PAGE_PADDING_PX;
    if (Math.abs(wanted - (this.api.settings.display.padding[1] ?? PAGE_PADDING_PX)) < 0.5) return;
    setTopPadding(this.api.settings, wanted);
  }

  /**
   * Re-render after an in-place model edit.
   *
   * `reuseViewport` keeps the current pixels while the new ones are prepared, so an edit
   * does not flash.
   *
   * `firstChangedMasterBar` is deliberately NOT passed. The Phase 0 spike measured it as a
   * large pessimization in horizontal layout — at 32 bars it took the median edit from
   * 17.7ms to 107.9ms and the p90 from 24.8ms to 419ms. Pass it only if you re-measure and
   * find that alphaTab has changed. (spike-results/spike.json holds the numbers.)
   */
  rerenderAfterEdit(): void {
    // The one place `reuseViewport` is still asked for, and the only one where it is safe: the
    // display scale and the page padding are unchanged, so a partial that has not been repainted
    // yet is showing ink in exactly the right place and leaving it there avoids a flash. Every
    // render that CHANGES the geometry passes false instead — see `setZoom`.
    this.startRender(() => this.api.render({ reuseViewport: true }));
  }

  /** Regenerate the player's MIDI after an edit that changed pitch or rhythm. */
  refreshMidi(): void {
    // Public since 1.6.0 — no private cast needed (Escala's `as any` predates it).
    this.api.loadMidiForScore();
  }

  get scoreIndex(): ScoreIndex | null {
    return this.index;
  }

  /**
   * The live alphaTab model, for a second view of the same notes.
   *
   * This is the graph the edit actions mutate in place. Anything that has to stay in step
   * with an edit must read THIS and not `RiffScore.ir`, which is a build-time snapshot the
   * editor never touches — the piano roll read the snapshot and went stale on every pitch
   * change. Returned as the model, not a copy: there is one truth on screen.
   */
  get model(): alphaTab.model.Score | null {
    return this.builtModel;
  }

  get score(): RiffScore | null {
    return this.currentScore;
  }

  /**
   * The open-string letters currently on screen, per system, top line first.
   *
   * The tuning legend used to be one line of prose with a `.tuning-summary` class, and the
   * harness read that string to prove a custom tuning had really reached the page. It reads
   * this instead — the same claim, made against what is actually drawn on the staff.
   */
  stringLetterTexts(): string[][] {
    const bySystem: string[][] = [];
    const letters = stringLettersFromBounds(
      this.api.renderer.boundsLookup,
      tuningLowToHighFromScore(this.builtModel, this.liveTrackIndex()),
      STRING_LETTER_GAP_PX,
      null,
      this.liveTrackIndex()
    );
    for (const l of letters) {
      (bySystem[l.system] ??= []).push(l.text);
    }
    return bySystem.map((s) => s ?? []);
  }

  /**
   * WHICH ALPHATAB TRACK IS THE TAKE (Codex finding 8). Not `0` — parts can be reordered.
   *
   * Everything this view draws BESIDE the music rather than on it — the tuning legend down the
   * left of the tab, the note-name row between the staves — is about the player's own part and
   * about nothing else. An imported MusicXML chart dragged above the take makes it track 0, and
   * every one of those decorations then described the wrong instrument without saying so.
   *
   * The `parts` sidecar is the score's own answer (`score/parts.ts §ScorePartInfo`), so this is
   * read rather than inferred. A single-part score has no sidecar and no ambiguity: 0.
   */
  private liveTrackIndex(): number {
    const parts = (this.currentScore as { parts?: Array<{ role: string; trackIndex: number }> } | null)
      ?.parts;
    const live = parts?.find((p) => p.role === 'live');
    return live ? live.trackIndex : 0;
  }

  /** The bar bounds belonging to the live part's staves. See `liveTrackIndex`. */
  private liveBars(barBoundsList: alphaTab.rendering.BarBounds[]): alphaTab.rendering.BarBounds[] {
    // A single-part score never filters: one track, and `bar.staff.track` is one indirection this
    // does not need to trust on the overwhelmingly common path.
    if ((this.builtModel?.tracks.length ?? 1) < 2) return barBoundsList;
    const live = this.liveTrackIndex();
    const mine = barBoundsList.filter((b) => b.bar?.staff?.track?.index === live);
    // Never NOTHING. If a future alphaTab stops carrying the back-reference, a row that vanishes
    // is a worse answer than the row this has always drawn.
    return mine.length > 0 ? mine : barBoundsList;
  }

  get renderInfo(): RenderInfo | null {
    return this.lastRenderInfo;
  }

  setNamesVisible(visible: boolean): void {
    this.showNames = visible;
    this.namesRow.style.display = visible ? '' : 'none';
    // Re-engrave: the staff<->tab gap exists only to hold this row, so turning it off must
    // close the hole rather than leave the two staves floating apart.
    if (this.applyGap()) return;
    if (visible) this.rebuildOverlays();
  }

  setNamesPlacement(placement: NamesPlacement): void {
    this.namesPlacement = placement;
    if (this.applyGap()) return;
    this.rebuildOverlays();
  }

  /**
   * Only the 'between' row lives inside the staff<->tab gap; the others sit outside it.
   *
   * ...and on a GRAND staff there is no 'between' row at all — `namesYFor` puts it above the
   * system, because the gap the band would name is full of the bass staff's own stems (B7). So
   * the gap must not be reserved for it either: the two answers are one decision and asking it
   * twice is how a hole opens under a row that is somewhere else.
   */
  private needsGap(): boolean {
    return this.showNames && this.namesPlacement === 'between' && !this.multiStaff;
  }

  /**
   * Push the current gap into the live renderer.
   *
   * Returns true when a re-render was kicked off (the overlays then rebuild from
   * postRenderFinished, so the caller must not also rebuild them).
   */
  private applyGap(): boolean {
    const wanted = this.needsGap();
    const before = this.api.settings.display.notationStaffPaddingTop;
    const beforeTop = this.api.settings.display.padding[1];
    applyStaffTabGap(this.api.settings, wanted, this.multiStaff);
    // Turning the names off, or moving the row out of the band, changes how much headroom the
    // page owes it — the same decision, so the same re-render. See `reserveTopRoom`.
    this.reserveTopRoom();
    if (
      this.api.settings.display.notationStaffPaddingTop === before &&
      this.api.settings.display.padding[1] === beforeTop
    ) {
      return false;
    }
    this.api.updateSettings();
    // Geometry change: every stave below the first moves, so nothing already painted is still
    // in the right place and `reuseViewport` would only license a ghost. See `setZoom`.
    this.startRender(() => this.api.render({ reuseViewport: false }));
    return true;
  }

  // -------------------------------------------------------------------------
  // Overlays derived from boundsLookup
  // -------------------------------------------------------------------------

  private onPostRender(): void {
    // FIRST, before anything below can ask for another render: this render is done, whatever
    // else happens in this method. `renderPending()` is read by the Align anchor and it must see
    // a request `tuneLeftInset` is about to raise, not the one that has just been served — so
    // this is cleared here and `startRender` sets it again if there is more to come.
    this.awaitingRender = false;
    /*
     * THE BOUNDS NOW DESCRIBE THE CURRENT MODEL — the one moment in the lifecycle at which that
     * is true, and therefore the only place this may be stamped.
     *
     * `postRenderFinished` fires after alphaTab has replaced `renderer.boundsLookup`. A render
     * that returned early (hidden host, zero width, not yet renderable) never reaches here, so
     * `boundsRevision` correctly stays behind and `hitTest` refuses to answer from bounds that
     * describe an engraving the index no longer knows about.
     */
    this.boundsRevision = this.modelRevision;
    // Before anything measures the host: a stale placeholder is ink, and `measureLeftInk()`
    // and `scrollWidth` would both take it for part of this engraving.
    this.trimSurface();
    const info = this.rebuildOverlays();
    this.lastRenderInfo = {
      durationMs: performance.now() - this.renderStartedAt,
      beatCount: info.beatCount,
      hasStaffTabSplit: info.hasStaffTabSplit
    };
    // `onRenderComplete?.(info)` was called here, before the inset correction and before the
    // scroll anchor — and `ui/app.ts` wired it straight to the coupling alongside
    // `onViewportChange`, so the roll was handed the geometry of a render that was about to be
    // replaced (finding 7). Nobody supplied it once that wiring moved to `onRenderSettled`, so
    // it is gone rather than left as a second, earlier, wronger settled event. `renderInfo` is
    // still readable as a property for anything that wants the timing.
    // If the left inset needs correcting, a second render is already on its way; let the
    // scroll anchor ride on THAT one, so the tick we restore is measured against the
    // coordinates the user will actually see. NO SETTLED EVENT FROM HERE: this render's
    // geometry is about to be replaced, and publishing it is exactly the transient window
    // finding 7 is about.
    if (this.tuneLeftInset()) return;
    this.restoreScrollAnchor();
    // Last, and unconditional: the scroll anchor may have just moved us, and anything
    // drawing against this ruler has to hear about the finished render even when the three
    // numbers happen to be unchanged.
    this.emitViewport(true);
    // THE settled event. After the corrective renders, after the anchor. One per render that
    // finished for real, and the only viewport this class publishes that anything is allowed to
    // align against.
    const v = this.viewport();
    if (v) this.opts.onRenderSettled?.(v);
  }

  /**
   * Remove placeholders that belong to a PREVIOUS engraving. Belt to §THE FACADE FRAME's braces.
   *
   * The frame guard removes the cause; this removes the ghost whatever the cause, and — more
   * usefully — it is a NUMBER (`ghostsTrimmed`, published through `layoutProbe`) that a harness
   * can assert stays zero. A repair with no counter is indistinguishable from a bug that never
   * happened.
   *
   * THE LAST `n` CHILDREN ARE THIS RENDER'S, and that is not a guess. alphaTab fills
   * placeholders from `_totalResultCount` upward, appending past the end when it runs out. If
   * the counter was reset (the healthy case) this render owns children 0..n-1 and there are
   * exactly n of them, so "the last n" is all of them and nothing is removed. If the counter
   * was stale at some base b, this render's ink went into b..b+n-1 and the surface holds
   * exactly b+n children — so the last n are again this render's, and the first b are the ghost.
   */
  private trimSurface(): void {
    const surface = this.host.querySelector('.at-surface');
    const n = this.partialsThisRender;
    if (!surface || n <= 0) return;
    let extra = surface.childElementCount - n;
    if (extra <= 0) return;
    this.ghostsTrimmed += extra;
    while (extra > 0 && surface.firstElementChild) {
      surface.firstElementChild.remove();
      extra--;
    }
  }

  /**
   * THE CLIPPED ENGRAVING, and it is the blank sheet — both reports of it, one cause.
   *
   * alphaTab's `.at-surface` is `overflow: hidden` (BrowserUiFacade sets it inline) and its box is
   * written once per render from `RenderFinishedEventArgs.totalWidth`:
   *
   *     _onRenderFinished()   e.totalWidth = this.layout.width          // LAYOUT units
   *     _appendRenderResult() this.canvasElement.width = result.totalWidth
   *
   * while every partial placeholder inside it is positioned by `registerPartial`, which multiplies
   * `x`, `width` and `totalWidth` by `display.scale` first. So the box is in unscaled units and
   * its contents are in scaled pixels, and the surface is short by exactly the scale factor.
   * Measured on `?demo=triplet&bars=16`, surface width against the partials' own right edge:
   *
   *     scale 0.96 -> 4673 px box, 4434 px of ink   nothing clipped, and this is why it hid
   *     scale 2.33 -> 4630 px box, 10774 px of ink  more than half the take gone
   *     scale 3.00 -> 4623 px box, 13835 px of ink  scrolled to 7553, FOURTEEN glyphs on screen
   *
   * At an ordinary zoom the unscaled number is coincidentally the larger of the two and nothing is
   * lost, which is why this only ever showed up zoomed in — as a sheet that went blank at a big
   * zoom, and, when the engraving overhung the box by less than a bar, as the last bar or two
   * coming out half drawn. Same clip, two descriptions.
   *
   * IT IS THE BOX THAT IS WRONG, NOT THE CLIPPING, so the box is what this repairs: the surface is
   * GROWN to the union of the placeholders it already holds. Never shrunk — a box that is bigger
   * than alphaTab thinks costs nothing (it clips nothing, and `.triview-stack` shrink-wraps to the
   * ink either way), whereas shrinking one that is currently generous enough would be this bug
   * with the sign flipped. `surfaceGrownPx` is published through `layoutProbe` so a harness can
   * assert the repair fired rather than infer it from a picture.
   */
  private growSurfaceToPartials(): void {
    const surface = this.host.querySelector<HTMLElement>('.at-surface');
    if (!surface) return;
    let right = 0;
    let bottom = 0;
    for (const child of Array.from(surface.children)) {
      if (child.tagName !== 'DIV') continue;
      const el = child as HTMLElement;
      right = Math.max(right, (parseFloat(el.style.left) || 0) + (parseFloat(el.style.width) || 0));
      bottom = Math.max(bottom, (parseFloat(el.style.top) || 0) + (parseFloat(el.style.height) || 0));
    }
    // Read off the inline style alphaTab wrote rather than `getBoundingClientRect`, so this
    // compares like with like and does not creep by a sub-pixel every render.
    const width = parseFloat(surface.style.width) || 0;
    const height = parseFloat(surface.style.height) || 0;
    if (right > width) {
      this.surfaceGrownPx = Math.max(this.surfaceGrownPx, Math.round(right - width));
      surface.style.width = `${right}px`;
    }
    if (bottom > height) surface.style.height = `${bottom}px`;
  }

  private rebuildOverlays(): { beatCount: number; hasStaffTabSplit: boolean } {
    // Every x in the axis came from the bounds we are about to re-read, so it is stale by
    // definition. Thrown away rather than rebuilt: most renders are never asked for an x.
    this.axis = null;

    // BEFORE the overlay is sized and before anything reads `scrollWidth`: a clipped surface is
    // narrower than its own ink, so every measurement below would be taken against the clip
    // rather than against the engraving. See `growSurfaceToPartials`.
    this.growSurfaceToPartials();

    // #40: alphaTab's "rendered by alphaTab" credit, out of the emitted SVG. FIRST, before
    // anything below measures the host: the credit is centred over the score and its box would
    // otherwise be included in `scrollWidth` and in `measureLeftInk()`'s union — so removing it
    // afterwards would leave the overlay sized to ink that is no longer there. See view/watermark.ts
    // for why this is a DOM removal rather than a setting (there is no setting).
    this.creditsRemoved += stripRendererCredit(this.host);

    const lookup = this.api.renderer.boundsLookup;
    if (!lookup) return { beatCount: 0, hasStaffTabSplit: false };

    // Size the overlay to the rendered content so SVG coordinates == bounds coordinates.
    const width = this.host.scrollWidth || this.host.clientWidth;
    const height = this.host.scrollHeight || this.host.clientHeight;
    this.overlay.setAttribute('width', String(width));
    this.overlay.setAttribute('height', String(height));
    this.overlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
    // A render changes contentWidth even when nothing scrolled, and the piano roll sizes
    // itself off that. Fired here rather than only from postRenderFinished so a partial
    // that widens the score is not missed; emitViewport() drops it if nothing moved.
    this.emitViewport();

    if (!this.index) return { beatCount: 0, hasStaffTabSplit: false };

    let beatCount = 0;
    let hasStaffTabSplit = false;
    const wanted: Array<WantedName> = [];
    const wantedMarks: Array<{ x: number; y: number; text: string }> = [];

    for (const system of lookup.staffSystems) {
      for (const masterBar of system.bars) {
        // THE LIVE PART'S STAVES ONLY (Codex finding 8). `masterBar.bars` is every rendered
        // stave of every TRACK, so on a two-part score this list is the take's staves and the
        // imported chart's, interleaved. Unfiltered, the note-name row labelled the imported
        // part's notes as if they were the player's, and `namesYFor` placed the row against
        // whichever pair of staves happened to come first — which, with the import reordered
        // above the take, is a gap in somebody else's system. See `liveBars`.
        const barBoundsList = this.liveBars(masterBar.bars ?? []);
        // With one staff showing both notation and tab, alphaTab produces one BarBounds
        // per rendered stave. Two entries => we know where the gap between them is.
        const split = barBoundsList.length >= 2;
        if (split) hasStaffTabSplit = true;
        const namesY = this.namesYFor(barBoundsList, system);

        // Octave-folded tab positions get a marker on the TAB stave's own glyph. Which stave
        // that is comes from `tabStaveIndex`, not from the number 1: on a grand staff with a
        // tab the tab is the THIRD rendered stave, and index 1 is the bass clef.
        const tabIndex = tabStaveIndex(staveKindsFromBars(barBoundsList));
        if (tabIndex >= 0 && this.tabShifts.size > 0) {
          for (const tabBeat of barBoundsList[tabIndex].beats) {
            for (const nb of tabBeat.notes ?? []) {
              const id = this.index.noteToInfo.get(nb.note)?.id;
              const shift = id ? this.tabShifts.get(id) : undefined;
              if (!shift) continue;
              const r = nb.noteHeadBounds;
              // CENTRED OVER ITS OWN DIGIT, not hung off the digit's right edge (H10).
              //
              // Hung to the right, an "8va" is ~14px of ink starting 1px after a fret digit —
              // so on any tab tight enough to matter (a capo makes most positions fold, which is
              // the configuration this was reported in) it lands on the NEXT digit and the row
              // reads "1 8va 1" with the marker between two numbers it does not belong to.
              // Above the digit it can only ever cover the digit it is about, and the row above
              // the tab is empty by construction — `TAB_DIGIT_RISE` is already reserved there.
              wantedMarks.push({
                x: r.x + r.w / 2,
                y: r.y - TAB_MARK_RISE,
                text: octaveMarkText(shift)
              });
            }
          }
        }

        // EVERY STAVE'S BEATS, DEDUPED — not `bars[0]`'s.
        //
        // The old rule ("beats are duplicated per stave, so the first stave's list is enough")
        // is true of exactly one shape: ONE alphaTab Staff showing notation and tab, where both
        // rendered staves carry the same Beat objects. A GRAND STAFF is two Staffs with two
        // independent voices, so `bars[0]` is the TREBLE stave — and on a bass riff every beat
        // in it is a rest. The whole note-names row silently vanished the moment the clef was
        // switched to Grand, which is a row of information disappearing with no message.
        //
        // Deduped by Beat IDENTITY, so the notation+tab case still labels each beat once.
        for (const beatBounds of dedupeBeats(barBoundsList)) {
          beatCount++;
          const beat = beatBounds.beat;
          if (beat.isEmpty || beat.notes.length === 0) continue;
          if (!this.showNames) continue;

          const names = beat.notes
            // A NAME BELONGS TO AN ATTACK, NOT TO A NOTEHEAD.
            //
            // A note held across a bar line or a beat is engraved as several noteheads joined by
            // ties — one note, several glyphs, which is simply how notation writes a held note.
            // This row labelled every glyph, so a single held A1 came out reading
            // "A1 A1 A1 A1 A1 A1 A1" and looked for all the world like the transcriber had
            // stuttered. It was reported from the field as "false repeats", and hours went into
            // blaming the listening engine for something this row was doing.
            //
            // A tie DESTINATION is a continuation of a note already named, so it gets no name.
            // A note the player genuinely struck again is not a tie destination and keeps every
            // one of its names — that distinction is the whole fix, and it is asserted in the
            // harness ("names: a re-struck note keeps every name"), because "fixed" and "labels
            // quietly deleted" look identical on screen.
            //
            // Worst in FREE grid, which is where it was reported: nothing is rounded, so notes
            // end at arbitrary times and need more tied pieces to write down. More pieces, more
            // phantom labels.
            .filter((n) => !n.isTieDestination)
            .map((n) => ({
              midi: soundingMidi(this.index!, n),
              uncertain: false,
              // THE NOTE THIS NAME IS ABOUT, carried through to the DOM. See `WantedName`.
              noteId: this.index!.noteToInfo.get(n)?.id ?? null
            }))
            // Lowest first, and stacked UPWARD from the anchor. Two reasons: it matches
            // how the pitches sit on the staff, and it keeps a tall chord growing into the
            // empty gap rather than down through the top line of the tab.
            .sort((a, b) => a.midi - b.midi)
            .map((n) => ({
              text: midiToName(n.midi, this.accidentals),
              uncertain: n.uncertain,
              noteId: n.noteId
            }));

          names.forEach((n, i) => {
            wanted.push({
              x: beatBounds.onNotesX,
              y: namesY - i * NAME_STACK_STEP,
              text: n.text,
              uncertain: n.uncertain,
              noteId: n.noteId
            });
          });
        }
      }
    }

    this.syncLabels(this.pruneNames(wanted));
    this.syncTabMarks(wantedMarks);
    // The tab's own legend. Derived from the SAME bounds as everything else above, so it
    // re-places itself on every render — a zoom, an edit or a re-flow cannot leave it behind.
    this.syncStringLetters(
      stringLettersFromBounds(
        lookup,
        tuningLowToHighFromScore(this.builtModel, this.liveTrackIndex()),
        STRING_LETTER_GAP_PX,
        this.stringLetterColumnX(),
        this.liveTrackIndex()
      )
    );
    // The one thing in this sweep that is not drawn by this file: a target over a name alphaTab
    // engraved. Same trigger as everything else here — the bounds it is matched against have
    // just changed, so the targets have to move with them.
    this.syncPartLabelHits(lookup);
    // The highlight rectangles were drawn against the OLD geometry. Redraw them from the
    // new bounds, or a zoom (or any edit) would leave the selection behind.
    this.drawSelection();
    // Same argument, same frame: the hover ring is bounds-derived too.
    this.drawHover();
    return { beatCount, hasStaffTabSplit };
  }

  /**
   * Where the names row sits.
   *
   * 'between' needs the staff/tab split, which we get when a master bar reports two
   * BarBounds. If it does not (single-stave score, or a future alphaTab change), we fall
   * back to 'above' rather than guessing a y — a wrong y is worse than a different row order.
   */
  private namesYFor(
    barBoundsList: alphaTab.rendering.BarBounds[],
    system: alphaTab.rendering.StaffSystemBounds
  ): number {
    if (this.namesPlacement === 'above') {
      return Math.max(0, system.visualBounds.y - NAMES_ABOVE_GAP);
    }
    if (this.namesPlacement === 'below') {
      return system.realBounds.y + system.realBounds.h - 14;
    }
    /*
     * A GRAND STAFF HAS NO LABEL LANE, so 'between' means 'above' on one (B7).
     *
     * Photographed by the owner on Clef: Grand + Tab: Bass — the names crammed into the gap
     * between the BASS staff and the tablature, sharing pixels with the bass stems that hang down
     * into it and with the fret digits below. `bandStaves` picks "the tab and whatever is directly
     * above it", which on a grand-plus-tab system is the bass staff, and that gap is not a lane:
     * it is where the bass staff's own downward stems, beams and ledger lines go, and `pruneNames`
     * deliberately ignores music glyphs (Bravura's em box is about four times its ink, so
     * intersecting against it would delete the whole row) — so nothing downstream could catch it.
     *
     * The lane only genuinely exists on the one shape it was designed for: a SINGLE notation
     * stave engraved directly above its own tablature, where `applyStaffTabGap` reserves the
     * room for it. Anywhere else the row goes above the whole system, which is the placement
     * already proven on single-stave scores — and `reserveTopRoomFor` reserves the headroom it
     * needs there.
     */
    if (this.multiStaff) {
      return Math.max(0, system.visualBounds.y - NAMES_ABOVE_GAP);
    }
    if (barBoundsList.length >= 2) {
      const band = this.nameBand(barBoundsList);
      if (!band) return Math.max(0, system.visualBounds.y - NAMES_ABOVE_GAP);
      // Sit LOW in the band, not centred. Tuplet brackets, staccato dots and stem
      // descenders all hang below the staff into the top of it; a centred row collides
      // with the "3" of every triplet, and a chord stacks UPWARD from this anchor anyway.
      const anchor = band.bottom - NAME_HEIGHT;
      if (anchor >= band.top) return anchor;
      // Not enough room for even one label — a tiny scale, or a future alphaTab that lays
      // the two staves out differently. Centre what there is rather than pick a side to
      // collide with. The reserved padding (atSettings.applyStaffTabGap) makes this the
      // path that should never run.
      return Math.max(0, (band.top + band.bottom) / 2 - NAME_HEIGHT / 2);
    }
    return Math.max(0, system.visualBounds.y - NAMES_ABOVE_GAP);
  }

  /**
   * The two staves the names row sits between: the TAB, and whatever is directly above it.
   *
   * "Between" means notation-to-tab and nothing else. It used to fall back to the top two staves
   * of a grand pair when there was no tab at all, and that gap is not a label lane: it is where
   * the treble staff's downward stems, its ledger lines below the staff, and the bass staff's
   * upward stems and ledger lines all go. A grand staff with tablature OFF printed the whole row
   * on top of that ink — reported from the field, and visible in the screenshot as note names
   * sitting on beams and noteheads. Widening MULTI_STAFF_GAP would not have cured it either:
   * alphaTab consumes that number in LAYOUT units and multiplies the finished geometry by
   * `display.scale`, so one value that clears a beam at scale 1 is 60% of itself at 0.6.
   *
   * With no tab there is no band, and `namesYFor` takes the 'above' fallback it already has for
   * a single-stave score — the same row, in the place it is already proven to work.
   *
   * Split out of `nameBand` so `layoutProbe` reports the measurement for the SAME pair the row
   * was actually placed against. They read `barBoundsList[0]` and `[1]` separately once, and a
   * three-stave score made them describe two different gaps.
   */
  private bandStaves(
    barBoundsList: alphaTab.rendering.BarBounds[]
  ): { upper: alphaTab.rendering.Bounds; lower: alphaTab.rendering.Bounds } | null {
    if (barBoundsList.length < 2) return null;
    const tabIndex = tabStaveIndex(staveKindsFromBars(barBoundsList));
    // < 1 rather than < 0: a tab engraved ABOVE everything else has nothing to be between.
    if (tabIndex < 1) return null;
    return {
      upper: barBoundsList[tabIndex - 1].visualBounds,
      lower: barBoundsList[tabIndex].visualBounds
    };
  }

  /**
   * The clear band between the staff and the tab that the names row may use.
   *
   * NOT simply `staff.bottom .. tab.top`: tab fret digits are centred on the top tab line,
   * so `tab.y` is the middle of the topmost digit and the label has to stop TAB_DIGIT_RISE
   * short of it. Getting that wrong is what put the row on top of the tab.
   */
  private nameBand(
    barBoundsList: alphaTab.rendering.BarBounds[]
  ): { top: number; bottom: number } | null {
    const pair = this.bandStaves(barBoundsList);
    if (!pair) return null;
    return {
      top: pair.upper.y + pair.upper.h + STAFF_CLEARANCE,
      bottom: pair.lower.y - TAB_DIGIT_RISE
    };
  }

  /**
   * What the layout actually came out as — for the headless harness, and for anyone
   * debugging a collision report from the field.
   *
   * Measured from the first system that reports a staff/tab split, in host pixels, plus
   * the real DOM rects of the labels so it catches a CSS/metrics disagreement rather than
   * only re-stating the maths above.
   */
  layoutProbe(): {
    hasSplit: boolean;
    staffBottom: number;
    tabTop: number;
    bandTop: number;
    bandBottom: number;
    labels: number;
    labelTop: number;
    labelBottom: number;
    /** Slack above the highest label and below the lowest. Negative means a collision. */
    clearAboveStaff: number;
    clearBelowTab: number;
    /**
     * Labels whose box intersects an engraved LETTERED text — tab fret digits, bar
     * numbers, the tempo mark. The blunt, honest check; see the loop for why the music
     * font is deliberately not in it.
     */
    textOverlaps: number;
    /** The first such collision, spelled out, so a FAIL says what hit what. */
    textOverlapSample: string | null;
    /** IR notes whose tab position was octave-folded, and the markers drawn for them. */
    octaveShiftNotes: number;
    octaveMarks: number;
    /** Markers that landed on the tab rather than somewhere else. Should equal octaveMarks. */
    octaveMarksOnTab: number;
    octaveMarkTexts: string[];
    /**
     * How many staff systems the bounds lookup reported. MUST be 1: horizontal layout is
     * one unbroken system, and that is what makes x monotone in tick and the piano roll's
     * borrowed x-axis meaningful. Anything else and `tickToContentX` is using the first
     * system only.
     */
    systems: number;
    /**
     * Measured px between the left edge of `.triview-stack` and the first engraved ink.
     * Should equal the piano roll's label gutter (`TIMELINE_GUTTER_PX`, 34), so that at
     * scroll 0 the sheet draws nothing in the column the roll uses for its pitch names.
     */
    contentLeftInset: number;
    /**
     * "rendered by alphaTab" nodes STILL in the engraving. Must be 0 — see view/watermark.ts.
     *
     * Counted rather than assumed: the credit is re-emitted by every render, so this is a claim
     * about the DOM as it stands right now, not about a call having been made once.
     */
    rendererCredits: number;
    /** How many have been removed since this view was built. Non-zero once anything is drawn. */
    rendererCreditsRemoved: number;
    /**
     * THE GHOST, counted. `.at-surface` holds one absolutely-positioned `<div>` per render
     * partial and one `svg.at-surface-svg` inside each, so a second engraving is arithmetic
     * rather than an impression: `surfacePartials` must equal `partialsThisRender` and
     * `surfaceSvgs`, and `ghostsTrimmed` must be 0. See §THE FACADE FRAME and `trimSurface`.
     */
    surfacePartials: number;
    surfaceSvgs: number;
    partialsThisRender: number;
    ghostsTrimmed: number;
    /** Px the surface had to be grown past alphaTab's box. See `growSurfaceToPartials`. */
    surfaceGrownPx: number;
    /**
     * Where the first few notes are engraved, by id, in CONTENT and in SCREEN x.
     *
     * The sheet's half of the three-pane alignment claim (G2): the roll's rectangle and the
     * waveform's hit for the same note id have to sit on this same screen x. Published here
     * rather than computed by the caller so the number under test is the ENGRAVED one — read
     * off `BeatBounds.onNotesX`, the notehead's own geometry.
     */
    noteXs: Array<{ noteId: string; contentX: number; screenX: number }>;
    /**
     * THE KEY SIGNATURE ON EACH STAVE, as a number of accidentals with its sign (P8).
     *
     * Read off the MODEL's bars, which is precisely where the fault was: `MasterBar.keySignature`
     * is a deprecated setter that writes track 0, staff 0 and nothing else, so the value could be
     * right on the treble stave of a grand system and absent on every other one. A harness that
     * only looked at the score's declared key would have seen the correct number and missed it.
     */
    keySignaturePerStave: number[];
    /**
     * The top of the first engraved system, in content y — the line the names row must be ABOVE
     * on a grand staff (B7) and the number the reserved headroom is spent on (P5).
     */
    systemTop: number | null;
    /** alphaTab's page padding as it currently stands: `[left, top, right, bottom]`. */
    pagePadding: number[];
    /**
     * THE NUMBERS ALIGN'S WINDOW IS DERIVED FROM, read from the pane that owns them.
     *
     * `ui/app.ts §syncViewports` turns the sheet's two viewport edges into the seconds every
     * other pane draws. When that derivation goes wrong the symptom is a mile away from the
     * cause — the sheet re-scales, the roll re-spans — so the inputs are published here rather
     * than reconstructed by a harness that would only be guessing at them. `leftEdgeTick` and
     * `rightEdgeTick` are `contentXToTick` at exactly the two x's app.ts asks about.
     */
    axis: {
      scale: number;
      scrollLeft: number;
      viewportWidth: number;
      contentWidth: number;
      firstX: number | null;
      lastX: number | null;
      leftEdgeTick: number | null;
      rightEdgeTick: number | null;
    };
  } | null {
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup) return null;

    const systems = lookup.staffSystems.length;
    const contentLeftInset = Math.round(this.measureLeftInk() ?? 0);
    const surface = this.host.querySelector('.at-surface');
    const surfacePartials = surface
      ? Array.from(surface.children).filter((c) => c.tagName === 'DIV').length
      : 0;
    const surfaceSvgs = this.host.querySelectorAll('svg.at-surface-svg').length;
    const noteXs = this.sampleNoteXs();

    let band: { top: number; bottom: number } | null = null;
    let staffBottom = 0;
    let tabTop = 0;
    for (const system of lookup.staffSystems) {
      for (const masterBar of system.bars) {
        // THE SAME STAVES `rebuildOverlays` PLACED THE ROW AGAINST, which on a multi-part score
        // means the live part's and not whichever system came first. A probe that measured a
        // different pair from the one the row was positioned by would report a collision the
        // page does not have, or miss one it does. See `liveBars`.
        const bars = this.liveBars(masterBar.bars ?? []);
        const pair = this.bandStaves(bars);
        const b = this.nameBand(bars);
        if (!pair || !b) continue;
        band = b;
        // The SAME pair the row was placed against — see `bandStaves`.
        staffBottom = pair.upper.y + pair.upper.h;
        tabTop = pair.lower.y;
        break;
      }
      if (band) break;
    }
    const extent = this.engravedExtent();
    const vp = this.viewport();
    const axis = {
      scale: this.api.settings.display.scale,
      scrollLeft: Math.round(vp?.scrollLeft ?? 0),
      viewportWidth: Math.round(vp?.viewportWidth ?? 0),
      contentWidth: Math.round(vp?.contentWidth ?? 0),
      firstX: extent ? Math.round(extent.firstX) : null,
      lastX: extent ? Math.round(extent.lastX) : null,
      leftEdgeTick: vp ? this.contentXToTick(vp.scrollLeft + LEFT_INSET_PX) : null,
      rightEdgeTick: vp ? this.contentXToTick(vp.scrollLeft + vp.viewportWidth) : null
    };
    /*
     * THE PROBE MEASURES IN THE ENGRAVING'S PIXELS (G1).
     *
     * Every number this returns is compared against `band`, `staffBottom` and `tabTop`, which come
     * from alphaTab's bounds lookup and are LOGICAL. The DOM rects below are visual, so each
     * difference from the host's own edge is converted once, here — otherwise `clearBelowTab` and
     * `clearAboveStaff` would be reported in a different unit from the thing they clear, and the
     * harness's "the names row never sits on a fret digit" check would pass or fail by the face
     * scale rather than by the geometry.
     */
    const hostRect = this.host.getBoundingClientRect();
    const fromHostTop = (clientTop: number): number => toLogical(clientTop - hostRect.top);
    const markTexts = this.tabMarks.map((m) => m.el.textContent ?? '');
    let marksOnTab = 0;
    for (const m of this.tabMarks) {
      const r = m.el.getBoundingClientRect();
      // "On the tab" = below the notation staff. tabTop is the top LINE of the tab and the
      // marker deliberately rises above it, so compare against the band instead.
      if (band && r.height > 0 && fromHostTop(r.top) >= band.top) marksOnTab++;
    }

    if (!band) {
      return {
        hasSplit: false,
        staffBottom: 0,
        tabTop: 0,
        bandTop: 0,
        bandBottom: 0,
        labels: 0,
        labelTop: 0,
        labelBottom: 0,
        clearAboveStaff: 0,
        clearBelowTab: 0,
        textOverlaps: 0,
        textOverlapSample: null,
        octaveShiftNotes: this.tabShifts.size,
        octaveMarks: this.tabMarks.length,
        octaveMarksOnTab: marksOnTab,
        octaveMarkTexts: markTexts,
        systems,
        contentLeftInset,
        rendererCredits: countRendererCredits(this.host),
        rendererCreditsRemoved: this.creditsRemoved,
        surfacePartials,
        surfaceSvgs,
        partialsThisRender: this.partialsThisRender,
        ghostsTrimmed: this.ghostsTrimmed,
        surfaceGrownPx: this.surfaceGrownPx,
        noteXs,
        keySignaturePerStave: this.keySignaturePerStave(),
        systemTop: this.systemTop(),
        pagePadding: [...(this.api.settings.display.padding ?? [])],
        axis
      };
    }

    let labelTop = Number.POSITIVE_INFINITY;
    let labelBottom = Number.NEGATIVE_INFINITY;
    const labelRects: DOMRect[] = [];
    for (const label of this.labels) {
      const r = label.el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      labelRects.push(r);
      labelTop = Math.min(labelTop, fromHostTop(r.top));
      labelBottom = Math.max(labelBottom, fromHostTop(r.bottom));
    }
    if (labelRects.length === 0) {
      labelTop = band.top;
      labelBottom = band.bottom;
    }

    // Glyph collision, measured rather than reasoned about. Every engraved <text> counts:
    // tab digits, noteheads, tuplet numbers, bar numbers.
    let textOverlaps = 0;
    let textOverlapSample: string | null = null;
    const engraved: Array<{ r: DOMRect; text: string }> = [];
    for (const glyph of this.host.querySelectorAll('svg text')) {
      // Skip the MUSIC font. Bravura's em box is about four times its ink — a 36px
      // notehead reports a 144px tall box, spanning the staff, the gap and the tab — so
      // intersecting against it answers a question nobody asked. Clearance from noteheads
      // and stems is what `clearAboveStaff` measures instead, off alphaTab's own
      // overflow-aware bounds. What is left here is the lettered text: tab fret digits,
      // bar numbers, the tempo mark. Their boxes sit close to their ink, and the fret
      // digits are precisely what the names row used to be printed on top of.
      if (getComputedStyle(glyph).fontFamily.includes('alphaTab')) continue;
      const r = glyph.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      engraved.push({ r, text: glyph.textContent ?? '' });
    }
    for (const rect of labelRects) {
      for (const { r: g, text } of engraved) {
        if (rect.left < g.right && rect.right > g.left && rect.top < g.bottom && rect.bottom > g.top) {
          textOverlaps++;
          textOverlapSample ??=
            `"${text.trim().slice(0, 12)}" ` +
            `[${Math.round(g.left - hostRect.left)},${Math.round(g.top - hostRect.top)} ` +
            `${Math.round(g.width)}x${Math.round(g.height)}] vs label ` +
            `[${Math.round(rect.left - hostRect.left)},${Math.round(rect.top - hostRect.top)} ` +
            `${Math.round(rect.width)}x${Math.round(rect.height)}]`;
          break;
        }
      }
    }

    return {
      hasSplit: true,
      staffBottom: Math.round(staffBottom),
      tabTop: Math.round(tabTop),
      bandTop: Math.round(band.top),
      bandBottom: Math.round(band.bottom),
      labels: labelRects.length,
      labelTop: Math.round(labelTop),
      labelBottom: Math.round(labelBottom),
      clearAboveStaff: Math.round(labelTop - staffBottom),
      clearBelowTab: Math.round(tabTop - labelBottom),
      textOverlaps,
      textOverlapSample,
      octaveShiftNotes: this.tabShifts.size,
      octaveMarks: this.tabMarks.length,
      octaveMarksOnTab: marksOnTab,
      octaveMarkTexts: markTexts,
      systems,
      contentLeftInset,
      rendererCredits: countRendererCredits(this.host),
      rendererCreditsRemoved: this.creditsRemoved,
      surfacePartials,
      surfaceSvgs,
      partialsThisRender: this.partialsThisRender,
      ghostsTrimmed: this.ghostsTrimmed,
      surfaceGrownPx: this.surfaceGrownPx,
      noteXs,
      keySignaturePerStave: this.keySignaturePerStave(),
      systemTop: this.systemTop(),
      pagePadding: [...(this.api.settings.display.padding ?? [])],
      axis
    };
  }

  /**
   * The key signature each engraved stave is carrying. See `layoutProbe().keySignaturePerStave`.
   *
   * The first bar of each stave of each track, in engraved order. alphaTab's `KeySignature` is
   * the count of accidentals with its sign (C = 0, three sharps = 3, two flats = -2), so a
   * harness can say "they all agree and none of them is C" without a lookup table.
   */
  private keySignaturePerStave(): number[] {
    const out: number[] = [];
    for (const track of this.builtModel?.tracks ?? []) {
      for (const staff of track.staves) {
        const bar = staff.bars[0];
        if (bar) out.push(bar.keySignature as unknown as number);
      }
    }
    return out;
  }

  /** Content y of the top of the first engraved system, or null with nothing engraved. */
  private systemTop(): number | null {
    const system = this.api.renderer.boundsLookup?.staffSystems?.[0];
    return system ? system.visualBounds.y : null;
  }

  /**
   * A spread of engraved notes, by id, in content and screen x. See `layoutProbe().noteXs`.
   *
   * Walked in engraving order and thinned to at most `limit`, spread across the whole score
   * rather than taken from the front: three neighbours would only ever prove the panes agree in
   * one place, which is precisely how a coupling that is right at the left edge and wrong
   * everywhere else survives a check.
   */
  private sampleNoteXs(limit = 12): Array<{ noteId: string; contentX: number; screenX: number }> {
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup || !this.index) return [];
    const stackLeft = this.stack.getBoundingClientRect().left;
    const all: Array<{ noteId: string; contentX: number; screenX: number }> = [];
    const seen = new Set<string>();
    for (const system of lookup.staffSystems) {
      for (const masterBar of system.bars) {
        for (const beatBounds of dedupeBeats(masterBar.bars ?? [])) {
          for (const note of beatBounds.beat.notes) {
            const id = this.index.noteToInfo.get(note)?.id;
            if (!id || seen.has(id)) continue;
            seen.add(id);
            all.push({
              noteId: id,
              contentX: Number(beatBounds.onNotesX.toFixed(2)),
              // A true CLIENT x: `stackLeft` is visual and `onNotesX` is engraved, so the
              // engraved half is scaled on the way out (G1).
              screenX: Number((stackLeft + toVisual(beatBounds.onNotesX)).toFixed(2))
            });
          }
        }
      }
    }
    if (all.length <= limit) return all;
    const out: Array<{ noteId: string; contentX: number; screenX: number }> = [];
    for (let i = 0; i < limit; i++) out.push(all[Math.round((i * (all.length - 1)) / (limit - 1))]);
    return out;
  }

  /**
   * A PER-BAR CENSUS OF THE ENGRAVING: what was laid out, against what was painted.
   *
   * Written for the blank-sheet reports, which `layoutProbe()` could not tell apart. Both of
   * them look identical in totals — a plausible content width, a non-zero glyph count, bounds
   * that answer for the visible range — and differ only in WHERE the ink is: bars alphaTab put
   * in `boundsLookup` and then painted nothing into. So each master bar is reported with the
   * content span it claims and the number of painted `<path>` nodes actually standing inside
   * that span, plus the partial each one belongs to. A bar with `notes > 0` and `ink === 0` is
   * the bug, by the numbers, and it names the bar.
   */
  sheetCensus(): {
    scale: number;
    contentWidth: number;
    partials: Array<{ index: number; left: number; width: number; glyphs: number }>;
    /** One row per master bar PER STAFF SYSTEM — see `ensureAxis`, which uses only system 0. */
    bars: Array<{
      system: number;
      bar: number;
      x: number;
      w: number;
      notes: number;
      ink: number;
      partial: number;
    }>;
    /** Bars that were laid out with notes in them and painted nothing. Empty is the claim. */
    blankBars: number[];
    totalGlyphs: number;
    /**
     * THE ONLY NUMBER THE EYE AGREES WITH: painted glyphs whose box intersects the pane.
     *
     * Everything else here is about the engraving as laid out, and the clipped-surface bug
     * (`growSurfaceToPartials`) is invisible to all of it — every bar is laid out, every bar has
     * ink, and the pane is blank. Counted last so the census can answer "is there anything to
     * look at" as well as "was it drawn".
     */
    inkOnScreen: number;
    /** `.at-surface`'s own box against the union of its partials — see `growSurfaceToPartials`. */
    surfaceWidth: number;
    partialsRight: number;
  } | null {
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup || lookup.staffSystems.length === 0) return null;
    const stackLeft = this.stack.getBoundingClientRect().left;

    const surface = this.host.querySelector('.at-surface');
    const partialEls = surface
      ? (Array.from(surface.children).filter((c) => c.tagName === 'DIV') as HTMLElement[])
      : [];
    const partials = partialEls.map((el, index) => ({
      index,
      left: Math.round(parseFloat(el.style.left) || 0),
      width: Math.round(parseFloat(el.style.width) || 0),
      glyphs: el.querySelectorAll('path,text').length
    }));

    // Every painted glyph, in CONTENT x. Read off the live boxes rather than the partial's
    // declared offset, because a partial whose ink is drawn at the wrong offset is one of the
    // things this is meant to be able to see.
    //
    // `stackLeft` ALREADY carries the scroll: `.triview-stack` is the scrolled content inside
    // `.triview-scroll`, so it slides left as the pane scrolls and a screen x minus it is a
    // content x with nothing further to add. Adding `scrollLeft` on top of that was the first
    // version of this, and it reported every bar left of the scroll position as blank — a census
    // that manufactures exactly the bug it is looking for.
    const paneRect = this.scroller.getBoundingClientRect();
    const inkXs: number[] = [];
    let inkOnScreen = 0;
    for (const glyph of this.host.querySelectorAll('svg.at-surface-svg path,svg.at-surface-svg text')) {
      const r = glyph.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // CONTENT x, so LOGICAL: `inkInSpan` below is called with `realBounds` from alphaTab, and
      // a census measured in visual pixels would have counted the wrong bars' ink (G1).
      inkXs.push(toLogical(r.left - stackLeft + r.width / 2));
      if (
        r.right >= paneRect.left &&
        r.left <= paneRect.right &&
        r.bottom >= paneRect.top &&
        r.top <= paneRect.bottom
      ) {
        inkOnScreen++;
      }
    }
    inkXs.sort((a, b) => a - b);
    const inkInSpan = (from: number, to: number): number => {
      let lo = 0;
      let hi = inkXs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (inkXs[mid] < from) lo = mid + 1;
        else hi = mid;
      }
      let n = 0;
      for (let i = lo; i < inkXs.length && inkXs[i] < to; i++) n++;
      return n;
    };

    const bars: Array<{
      system: number;
      bar: number;
      x: number;
      w: number;
      notes: number;
      ink: number;
      partial: number;
    }> = [];
    const blankBars: number[] = [];
    for (let s = 0; s < lookup.staffSystems.length; s++) {
      const system = lookup.staffSystems[s];
      for (const masterBar of system.bars) {
        const b = masterBar.realBounds;
        let notes = 0;
        for (const beatBounds of dedupeBeats(masterBar.bars ?? [])) {
          notes += beatBounds.beat.notes.length;
        }
        const ink = inkInSpan(b.x, b.x + b.w);
        const partial = partials.findIndex((p) => b.x >= p.left && b.x < p.left + p.width);
        bars.push({
          system: s,
          bar: masterBar.index,
          x: Math.round(b.x),
          w: Math.round(b.w),
          notes,
          ink,
          partial
        });
        if (notes > 0 && ink === 0 && !blankBars.includes(masterBar.index)) {
          blankBars.push(masterBar.index);
        }
      }
    }

    return {
      scale: this.api.settings.display.scale,
      contentWidth: Math.round(this.viewport()?.contentWidth ?? 0),
      partials,
      bars,
      blankBars,
      totalGlyphs: inkXs.length,
      inkOnScreen,
      surfaceWidth: Math.round(
        parseFloat(this.host.querySelector<HTMLElement>('.at-surface')?.style.width ?? '0') || 0
      ),
      partialsRight: partials.reduce((max, p) => Math.max(max, p.left + p.width), 0)
    };
  }

  // -------------------------------------------------------------------------
  // The x-axis: score ticks <-> content pixels
  //
  // "Content" pixels are unscrolled pixels inside `.triview-stack` — the same space
  // `BeatBounds.onNotesX` is already in, and the space the overlay, the names row and the
  // piano roll all draw in. Nothing here knows about scrolling; `viewport()` does that.
  // -------------------------------------------------------------------------

  /**
   * Where a MIDI tick sits on the page. Null only when nothing has been engraved yet.
   *
   * The tick cache is asked first because it knows each beat's real playback duration,
   * which is what lets the answer glide smoothly between two attacks instead of stepping.
   * Everything it cannot answer — a tick before the first beat, after the last one, or in
   * a stretch whose bounds are missing — falls through to the axis, which extrapolates
   * from the nearest pair of beats. It never gives up while there is any geometry at all:
   * a roll that quietly stops drawing is worse than one that is a few pixels out at the
   * very end of the take.
   */
  tickToContentX(tick: number): number | null {
    const axis = this.ensureAxis();
    if (!axis) return null;

    const lookup = this.api.renderer.boundsLookup;
    const tickCache = this.api.tickCache;
    if (lookup && tickCache) {
      const result = tickCache.findBeat(TRACK_ZERO, tick);
      const bounds = result ? lookup.findBeat(result.beat) : null;
      if (result && bounds) {
        const next = result.nextBeat ? lookup.findBeat(result.nextBeat.beat) : null;
        if (next && result.tickDuration > 0) {
          const progress = Math.min(1, Math.max(0, (tick - result.start) / result.tickDuration));
          return bounds.onNotesX + (next.onNotesX - bounds.onNotesX) * progress;
        }
        // No next beat: this is the last one, and its own width is not in the bounds. The
        // axis carries the right edge of the final bar, so it can still place the tail.
        if (tick > result.start) return axisXAt(axis, tick);
        return bounds.onNotesX;
      }
    }
    return axisXAt(axis, tick);
  }

  /**
   * How far the engraving reaches, in content pixels: the first engraved beat and the right
   * edge of the final bar. Null until something has been engraved.
   *
   * Published because it is the honest limit of every answer this class gives about time: past
   * `lastX` there is no music, only page. See `timeAxis.clampXToEngraving`.
   */
  engravedExtent(): EngravedExtent | null {
    const axis = this.ensureAxis();
    if (!axis || axis.xs.length < 2) return null;
    return { firstX: axis.xs[0], lastX: axis.xs[axis.xs.length - 1] };
  }

  /**
   * The inverse: which tick is under this x. O(log n), by bisecting the same axis.
   *
   * IT EXTRAPOLATES PAST BOTH ENDS, and the right-hand one is the fix for H1b — the sheet
   * collapsing to MIN_ZOOM the moment you scrolled it to its right edge.
   *
   * THE FAULT, root-caused live rather than described. Align is a closed loop: `syncViewports`
   * asks this method which second sits at each edge of the sheet's viewport, hands the pair to
   * the roll, the roll reports back the window it applied, and ui/app.ts answers any difference
   * by re-scaling the sheet through `coupledSheetScale`. That loop is a controller whose job is
   * to make the sheet's visible span equal the roll's, and it is stable only while shrinking the
   * sheet INCREASES the span the sheet is showing — which is obvious, and was false here.
   *
   * This method used to hold x inside the engraving at the right end (`Math.min(lastX, x)`), so
   * once the viewport reached past the last engraved bar the right edge's answer FROZE at the
   * final tick while the left edge went on moving. Shrinking the sheet then made its derived
   * span smaller, not larger, and the controller's sign flipped from negative to positive.
   * Worse, it accelerates: at half the scale the engraving is half as wide, so the pane hangs
   * twice as far past the end. Measured on `?demo=triplet&bars=8&tab=bass`, scrolling right in
   * 220px steps with the right edge pinned at tick 30720 throughout, `display.scale` went
   * 1 -> 0.978 -> 0.955 -> 0.887 -> 0.777 -> 0.570 -> 0.40 in six steps and the whole take was
   * a 430px smudge. With the pin gone it stays at 0.978 all the way to the last bar.
   *
   * WHAT THE PIN WAS FOR, and why losing it costs nothing measurable. It was added because
   * extrapolating produced a time beyond the end of the recording whenever the pane was wider
   * than the engraving — a short riff — after which `clampWindow` slid the window back keeping
   * its span and the panes ended up showing different music (~578 px of drift). That reading is
   * still available and still bounded, because `axisTickAt` extrapolates on the axis's OWN
   * average slope: blank page to the right of the last bar is worth what a page of this music is
   * worth, which is exactly what the roll needs in order to leave the same proportion of its own
   * plot empty. Re-measured after this change on the harness's own three-pane check
   * (scripts/ghost-probe.mjs): worst sheet-vs-roll disagreement 66 px, unchanged from the pinned
   * build, and the first engraved note still pinned to 8 px.
   *
   * The short riff — the very case the pin was added for — was re-measured too, on
   * `?demo=triplet&bars=2`, whose whole engraving is 855 px inside a 1440 px pane: worst
   * sheet-vs-roll 768 px WITH the pin and 258 px without it. The pin was not paying for itself
   * even on its own fixture, which is what a clamp does when the thing it clamps is a ruler.
   *
   * The LEFT end was never clamped here (G2), for the same reason now stated once for both:
   * left of the first beat is the clef, key and meter prefix — real page width standing for the
   * lead-in the roll and the strip are quite right to go on drawing. Clamping it pinned the
   * window's start to the first ATTACK while the sheet still showed the whole prefix, measured
   * at 114-177 px of disagreement, the worst on the page.
   *
   * The `exact` opt-out this used to carry is gone with the clamp it opted out of: there is one
   * answer now, and it is `axisTickAt`'s.
   */
  contentXToTick(x: number): number | null {
    const axis = this.ensureAxis();
    if (!axis) return null;
    return axisTickAt(axis, x);
  }

  /**
   * Where a note's OWN glyph is engraved, in content x. Null when it is not in the lookup.
   *
   * Deliberately read straight off `BeatBounds.onNotesX` and NOT recomputed through
   * `tickToContentX`. The harness compares the piano roll's rectangle against this number
   * for the same note id; if both sides came out of the same interpolation the check would
   * be comparing a number with itself and could never fail. This is the independent
   * witness, and it is the real engraved position.
   */
  noteContentX(noteId: string): number | null {
    const lookup = this.api.renderer.boundsLookup;
    const note = this.index?.idToNote.get(noteId);
    if (!lookup || !note) return null;
    const beatBounds = lookup.findBeat(note.beat);
    return beatBounds ? beatBounds.onNotesX : null;
  }

  /** Build the axis on demand and keep it until the next render throws it away. */
  private ensureAxis(): TickAxis | null {
    if (this.axis) return this.axis;
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup || lookup.staffSystems.length === 0) return null;

    // ONE staff system is the whole premise of horizontal layout, and of this axis: it is
    // what makes x monotone in tick. If a future alphaTab (or a settings mistake) ever
    // produces more, use the first and say so in layoutProbe() rather than silently
    // interleaving two systems into one nonsense axis.
    const systems = lookup.staffSystems.length;
    const system = lookup.staffSystems[0];

    const points: Array<{ tick: number; x: number }> = [];
    let lastBeat: alphaTab.model.Beat | null = null;
    let rightEdge = 0;
    for (const masterBar of system.bars) {
      const right = masterBar.realBounds.x + masterBar.realBounds.w;
      if (right > rightEdge) rightEdge = right;
      // Every stave, deduped — see `dedupeBeats`. On a grand staff `bars[0]` is the treble
      // stave, so on a bass riff the axis was built from whole-bar RESTS: two or three points
      // per bar instead of one per attack, and every x between them an interpolation across a
      // whole bar. That is the coarsest possible ruler for the pane that has to agree with the
      // roll to the pixel.
      for (const beatBounds of dedupeBeats(masterBar.bars ?? [])) {
        const beat = beatBounds.beat;
        points.push({ tick: beat.absolutePlaybackStart, x: beatBounds.onNotesX });
        if (!lastBeat || beat.absolutePlaybackStart >= lastBeat.absolutePlaybackStart) {
          lastBeat = beat;
        }
      }
    }
    if (points.length === 0) return null;

    points.sort((a, b) => a.tick - b.tick || a.x - b.x);
    const ticks: number[] = [];
    const xs: number[] = [];
    for (const p of points) {
      const n = ticks.length;
      // Strictly ascending in BOTH, or the bisection below has no bracket to find. Second
      // voices land on ticks that are already in the list; the first one wins.
      if (n > 0 && (p.tick <= ticks[n - 1] || p.x <= xs[n - 1])) continue;
      ticks.push(p.tick);
      xs.push(p.x);
    }
    if (lastBeat) {
      const endTick = lastBeat.absolutePlaybackStart + lastBeat.playbackDuration;
      if (endTick > ticks[ticks.length - 1] && rightEdge > xs[xs.length - 1]) {
        ticks.push(endTick);
        xs.push(rightEdge);
      }
    }

    this.axis = { ticks, xs, systems };
    return this.axis;
  }

  // -------------------------------------------------------------------------
  // Viewport and scrolling
  // -------------------------------------------------------------------------

  /** Null until something has been engraved. */
  viewport(): TriViewViewport | null {
    if (!this.api.renderer.boundsLookup) return null;
    return {
      scrollLeft: this.scroller.scrollLeft,
      viewportWidth: this.scroller.clientWidth,
      contentWidth: Math.max(this.scroller.scrollWidth, this.stack.scrollWidth)
    };
  }

  /**
   * Scroll the sheet, clamped to what actually exists. SILENT: never reports a sheet scroll.
   *
   * Every programmatic route in goes through here — the app pushing the authoritative window
   * back, the scroll anchor after a re-engrave, "bring this note into view" — and none of them
   * is the player moving the page. Marking them is what lets `onScroll` tell a hand from an echo
   * without a timer: the DOM's own scroll event arrives asynchronously, so a boolean set here
   * and cleared on the next event is the whole mechanism.
   */
  setScrollLeft(px: number): void {
    const max = Math.max(0, this.scroller.scrollWidth - this.scroller.clientWidth);
    const next = Math.min(max, Math.max(0, px));
    if (Math.abs(next - this.scroller.scrollLeft) < 0.5) return;
    this.programmaticScrollTo = next;
    this.scroller.scrollLeft = next;
  }

  /**
   * Bring a note's glyph into view horizontally, moving as little as possible.
   *
   * Used when a note is picked on the piano roll: the sheet should come to it, not jump to
   * put it in the middle and lose the reader's place.
   */
  scrollNoteIntoView(noteId: string): void {
    const note = this.index?.idToNote.get(noteId);
    if (!note) return;
    const r = this.noteGlyphRects(note)[0];
    if (!r) return;

    const left = this.scroller.scrollLeft;
    const width = this.scroller.clientWidth;
    // Keep it clear of the roll's label column on the left, and off the very edge on the
    // right; landing a note half under the gutter reads as "it did not scroll".
    const margin = Math.max(LEFT_INSET_PX, Math.min(80, width * 0.15));
    if (r.x < left + margin) this.setScrollLeft(r.x - margin);
    else if (r.x + r.w > left + width - margin) this.setScrollLeft(r.x + r.w - width + margin);
  }

  /**
   * Tell the caller where we are.
   *
   * `force` skips the "nothing changed" check. Every finished render forces one, because
   * the piano roll repaints off this callback: after a zoom the numbers can come back
   * identical (same scroll, same viewport, a content width that happens to round the same)
   * while every x inside the sheet has moved, and a roll that skipped that frame would be
   * left drawing against the old engraving.
   */
  private emitViewport(force = false): void {
    if (!this.opts.onViewportChange) return;
    const v = this.viewport();
    if (!v) return;
    const last = this.lastViewport;
    if (
      !force &&
      last &&
      last.scrollLeft === v.scrollLeft &&
      last.viewportWidth === v.viewportWidth &&
      last.contentWidth === v.contentWidth
    ) {
      return;
    }
    this.lastViewport = v;
    this.opts.onViewportChange(v);
  }

  // -------------------------------------------------------------------------
  // Zoom
  // -------------------------------------------------------------------------

  /** alphaTab's display scale. 1.0 is the default size. */
  getZoom(): number {
    return this.api.settings.display.scale;
  }

  /**
   * Re-engrave at a new size, keeping the music under the left edge where it was.
   *
   * Scroll position is remembered as a TICK, not as pixels, because pixels are precisely
   * what is about to change: at 2x the same bar is twice as far along the page. Restoring
   * the tick's new x after the render is what makes zooming feel like leaning in rather
   * than being thrown somewhere else in the take.
   */
  setZoom(scale: number, anchorClientX: number | null = null): void {
    if (!Number.isFinite(scale)) return;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
    if (Math.abs(next - this.api.settings.display.scale) < 0.001) {
      // Already there. Still write the exact value, so `getZoom()` reads back the number
      // that was asked for rather than something 0.0004 away from it — "Reset view" is
      // checked by comparing against 1.
      //
      // NOTHING IS OWED BY DROPPING THIS RENDER. The caller derives the scale ABSOLUTELY from
      // the authoritative span (`timeAxis.absoluteSheetScale`), so a change too small to be
      // worth re-engraving is simply asked for again, in full, on the next event — which is
      // what makes a slow trackpad pinch move the sheet at all (finding 10). The old coupling
      // scaled by a ratio against a remembered span, so a dropped step was lost for good.
      this.api.settings.display.scale = next;
      return;
    }

    // THE ANCHOR IS WRITTEN BEFORE THE RENDER, and this is finding 6 (finding 6).
    //
    // `zoomAt` used to call `setZoom` first and write `scrollAnchorTick`/`scrollAnchorOffsetPx`
    // afterwards, guarded by `renderPending()`. Renders here are SYNCHRONOUS, so by the time
    // `setZoom` returned `onPostRender` had already run `restoreScrollAnchor()` and consumed the
    // default left-edge anchor; `renderPending()` was false and the pointer anchor was never
    // installed at all. A sheet pinch therefore anchored on the left edge of the pane while a
    // roll pinch anchored under the fingers, which is most of why the two felt like different
    // gestures. The pointer's tick and its offset now go in before `api.render` is ever called.
    const left = this.scroller.scrollLeft;
    const anchored = anchorClientX !== null && Number.isFinite(anchorClientX);
    // LOGICAL, because `scrollLeft` is and `contentXToTick` reads engraved coordinates (G1).
    const rect = anchored ? this.scroller.getBoundingClientRect() : null;
    const px = rect
      ? Math.max(0, Math.min(toLogical(rect.width), logicalX(this.scroller, anchorClientX as number)))
      : 0;
    const anchorTick = anchored ? this.contentXToTick(left + px) : null;
    if (anchored && anchorTick !== null) {
      this.scrollAnchorAtStart = false;
      this.scrollAnchorTick = anchorTick;
      this.scrollAnchorOffsetPx = px;
    } else {
      this.scrollAnchorAtStart = left <= 0;
      this.scrollAnchorTick = this.scrollAnchorAtStart ? null : this.contentXToTick(left);
      this.scrollAnchorOffsetPx = 0;
    }

    this.api.settings.display.scale = next;
    // The overhang scales with the engraving, so the padding has to be recomputed for the
    // new scale or the reserved column would come out wider or narrower than the roll's.
    setLeftPadding(this.api.settings, LEFT_INSET_PX + leftInkOverhangPerScale * next);
    this.api.updateSettings();
    // A new scale is a new measurement problem, so the corrective budget is refilled.
    this.insetTuneBudget = INSET_TUNE_PASSES;
    // NOT `reuseViewport`, and this is the other half of the ghosting.
    //
    // `reuseViewport: true` tells alphaTab's facade to leave the previous partial's ink in its
    // placeholder rather than blanking it first (`if (!renderResult.reuseViewport) placeholder
    // .textContent = ""`, BrowserUiFacade.beginAppendRenderResults). It is the right trade when
    // the geometry is unchanged and the only risk is a flash between two identical pictures. At
    // a NEW `display.scale` every engraved coordinate has moved, so a placeholder the new render
    // does not overwrite is left holding a differently-scaled copy of the same music, a few
    // pixels off — which is what the reports look like. Blanked placeholders cannot ghost at
    // all, whatever else goes wrong upstream, and a zoom re-engraves every partial anyway so
    // there is nothing worth reusing.
    this.startRender(() => this.api.render({ reuseViewport: false }));
  }

  /** Where the pointer is, as a fraction of the music column. The anchor a `zoom` command wants. */
  pinchFrac(clientX: number): number {
    // BOTH SIDES IN LOGICAL PIXELS (G1): `rect.width` is visual and `LEFT_INSET_PX` is logical, so
    // the inset used to be subtracted from a width it was not measured in — an anchor that drifted
    // further from the fingers the smaller the window was.
    const width = Math.max(1, toLogical(this.scroller.getBoundingClientRect().width) - LEFT_INSET_PX);
    return Math.max(0, Math.min(1, (logicalX(this.scroller, clientX) - LEFT_INSET_PX) / width));
  }

  /**
   * THE SHEET'S HALF OF THE TRACKPAD CONTRACT (H1/H2).
   *
   *   pinch                  -> HORIZONTAL zoom: re-engrave at a new `display.scale`
   *   Option (alt) + pinch   -> the PITCH axis, which only the roll has — swallowed here
   *   two fingers, any way   -> SCROLL, and nothing else, ever
   *
   * ZOOMING FROM HERE IS EXACTLY WHAT NO LONGER HAPPENS. The pinch leaves as a COMMAND and comes
   * back as a scale, and that round trip is what makes a pinch over the sheet and a pinch over
   * the roll the same gesture rather than two implementations of one idea.
   *
   * The old note here described the sheet zooming itself and the roll refusing to follow unless
   * `onZoomChange` armed `adoptNextAlignSpan` — "live, six pinch events move display.scale
   * 1.269 -> 1.274; the gesture is inert, not wrong". That whole apparatus is deleted. The app
   * reduces one `zoom` command against the shared window and hands the sheet the scale that span
   * needs, so there is no direction to arm and nothing to refuse.
   *
   * A plain two-finger swipe is left to the browser, which is already correct — except on the
   * one axis the browser cannot guess: this pane is a horizontal strip, so fingers moving UP and
   * DOWN over it have nowhere vertical to go and must move the music sideways instead. Without
   * that the sheet is the only pane in the app a trackpad cannot scroll.
   */
  private onSheetWheel = (e: WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      // Always swallowed, both branches: an unhandled ctrl-wheel is the browser's page zoom,
      // which inside a plugin window resizes the entire UI and cannot be got back from.
      e.preventDefault();
      const d = e.deltaY || e.deltaX;
      if (d === 0) return;
      // One pinch, one zoom, whichever road WebKit sent it down — and the road is claimed for
      // Option+pinch too, even though this pane has no pitch axis to give it. Claiming only for
      // the axis a surface HAPPENS to own is what let the same Option+pinch be counted on both
      // roads over the roll. See view/gesture.ts.
      const out = this.pinch.read({
        kind: 'wheel',
        atMs: performance.now(),
        delta: d,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey
      });
      // The sheet has one axis. A pitch zoom is swallowed here rather than forwarded, exactly as
      // it always was — the roll is the pane with a pitch axis.
      if (out.kind !== 'zoom' || out.axis !== 'time') return;
      this.opts.onPinch?.(out.factor, e.clientX);
      return;
    }
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * lines;
    const dy = e.deltaY * lines;
    if (dy === 0 || Math.abs(dy) <= Math.abs(dx)) return;
    if (this.scroller.scrollHeight > this.scroller.clientHeight + 1) return;
    if (this.scroller.scrollWidth <= this.scroller.clientWidth + 1) return;
    e.preventDefault();
    this.setScrollLeft(this.scroller.scrollLeft + dy);
  };

  /** Safari/WKWebView's pinch, and the ctrl-wheel's, under one law. See view/gesture.ts. */
  private pinch = new PinchGesture();

  private onGestureStart = (e: Event): void => {
    e.preventDefault();
    this.pinch.read({
      kind: 'gesturestart',
      atMs: performance.now(),
      scale: (e as Event & { scale?: number }).scale
    });
  };

  private onGestureChange = (e: Event): void => {
    const g = e as Event & { scale?: number; altKey?: boolean; clientX?: number };
    if (!g.scale || !Number.isFinite(g.scale) || g.scale <= 0) return;
    e.preventDefault();
    const out = this.pinch.read({
      kind: 'gesturechange',
      atMs: performance.now(),
      scale: g.scale,
      altKey: g.altKey
    });
    if (out.kind !== 'zoom' || out.axis !== 'time') return;
    const rect = this.scroller.getBoundingClientRect();
    this.opts.onPinch?.(out.factor, g.clientX ?? rect.left + rect.width / 2);
  };

  /** The fingers left the trackpad. Nothing was listening for this until now — see view/gesture.ts. */
  private onGestureEnd = (e: Event): void => {
    e.preventDefault();
    this.pinch.read({ kind: 'gestureend', atMs: performance.now() });
  };

  /**
   * "Reset view": back to the default size, back to the beginning, in one call.
   *
   * One entry point rather than two, because the two halves have to agree — a reset that
   * sets the zoom and forgets the scroll (or the other way round) is exactly the sort of
   * half-applied state a user reads as "the button is broken". Anything the caller stores
   * about the current zoom must be set to 1 alongside this; see the note in the report.
   */
  resetView(): void {
    this.scrollAnchorTick = null;
    // "Back to the beginning" outranks any Align anchor still waiting for a render.
    this.alignAnchorTick = null;
    this.scrollAnchorAtStart = true;
    this.setZoom(1);
    this.setScrollLeft(0);
  }

  /**
   * ALIGN (#30): put this tick at the left edge of the MUSIC column — now, and again after the
   * next re-engrave finishes.
   *
   * The "and again" is the whole point, and it is why this exists instead of the caller simply
   * computing an x and calling `setScrollLeft`. A coupled zoom is TWO steps: the roll's window
   * changes, and the sheet is re-engraved at a new `display.scale` to match (see
   * `coupledSheetScale`). Every content x moves during that render, and it is asynchronous — a
   * scroll applied by the caller beforehand is computed against the old engraving and a scroll
   * applied afterwards needs the caller to have listened for the right event. A TICK survives
   * the re-engrave, so the anchor is stated once and honoured on the far side of it.
   *
   * The gutter comes off because Align matches the two MUSIC edges, not the two element edges:
   * the roll spends its first `TIMELINE_GUTTER_PX` on pitch names and the sheet is padded by
   * the same column, so the window's first second is at the same screen x in both panes. This
   * is exactly `timeAxis.sheetScrollForSec`, in ticks and against the live engraving.
   *
   * Pass null to drop a pending anchor — switching Align off, for instance — and leave the
   * plain zoom anchor (`setZoom`'s own, which keeps the left edge where it was) in charge.
   *
   * THE ANCHOR ONLY ARMS WHEN A RENDER WILL CONSUME IT, and that is the fix rather than a
   * detail. It used to arm unconditionally, which was wrong in both directions. Renders here
   * are synchronous, so by the time the caller reaches this line after a coupled zoom the
   * re-engrave has ALREADY finished — the "and again afterwards" had nothing left to wait for
   * and simply sat in the field. And when `setZoom` starts no render at all (the scale was
   * unchanged, or the coupling asked for one outside [MIN_ZOOM, MAX_ZOOM] and it clamped back
   * to where it already was) there was never going to be a render either. Either way the tick
   * survived, and the next unrelated re-engrave — an edit, a names toggle, a resize — restored
   * it and yanked the sheet somewhere the player had not asked to be.
   *
   * So: scroll now, always, because the geometry on screen is the current geometry. Arm only if
   * `renderPending()` says a re-engrave is still owed.
   */
  alignScrollToTick(tick: number | null): boolean {
    if (tick === null) {
      this.alignAnchorTick = null;
      return true;
    }
    const x = this.tickToContentX(tick);
    if (x === null) return true;
    const wanted = x - LEFT_INSET_PX;
    this.setScrollLeft(wanted);
    this.alignAnchorTick = this.renderPending() ? tick : null;
    // DID THE PAGE HAVE ANYWHERE TO GO? Returned rather than swallowed, because the one case
    // where it does not is a real disagreement the caller has to hear about.
    //
    // A take with leading silence engraves its first attack in bar 1 — the pipeline anchors the
    // music, not the tape — so the seconds before it have NO PAGE. Ask for a moment inside that
    // silence and the scroll clamps at 0 while the shared window goes on claiming the pane's
    // left edge is that moment; the roll then spends real pixels on time the sheet spends on a
    // clef. False here lets `ui/app.ts` take the sheet's actual left edge instead, which settles
    // in one step and is the only place the engraving is allowed to answer back.
    return Math.abs(this.scroller.scrollLeft - Math.max(0, wanted)) < 1;
  }

  private restoreScrollAnchor(): void {
    const offset = this.scrollAnchorOffsetPx;
    this.scrollAnchorOffsetPx = 0;
    // Align outranks the zoom anchor: when both are set, the caller has asked for a specific
    // moment at the left edge and `setZoom` only ever asked for "wherever we were".
    const aligned = this.alignAnchorTick;
    if (aligned !== null) {
      this.alignAnchorTick = null;
      this.scrollAnchorTick = null;
      this.scrollAnchorAtStart = false;
      const alignedX = this.tickToContentX(aligned);
      if (alignedX !== null) this.setScrollLeft(alignedX - LEFT_INSET_PX);
      return;
    }
    if (this.scrollAnchorAtStart && offset === 0) {
      this.scrollAnchorAtStart = false;
      this.scrollAnchorTick = null;
      this.setScrollLeft(0);
      return;
    }
    this.scrollAnchorAtStart = false;
    const tick = this.scrollAnchorTick;
    if (tick === null) return;
    this.scrollAnchorTick = null;
    const x = this.tickToContentX(tick);
    // `offset` is the pinch's own anchor: put the tick back where the fingers were, not at the
    // left edge. It is 0 for every other zoom, so this line is the identity for them.
    if (x !== null) this.setScrollLeft(x - offset);
  }

  // -------------------------------------------------------------------------
  // The reserved left column (§D)
  // -------------------------------------------------------------------------

  /**
   * Make the empty space on the left of the engraving exactly `LEFT_INSET_PX` wide.
   *
   * `settings.display.padding[0]` puts the staff SYSTEM at that x, which is not the same
   * thing as putting the first ink there: alphaTab draws the system bracket and the
   * sideways track name to the left of the system line. So the padding is set from a
   * measurement — read back how far out the ink actually landed, keep the difference, and
   * ask again with the difference added in.
   *
   * The relationship is exactly linear with slope one (everything left of the first bar is
   * laid out relative to the system's x), so one correction is enough; the 0.5px deadband
   * and `insetTuneInFlight` are there so a rounding difference can never turn it into a
   * render loop. Returns true when a correcting render was started.
   */
  private tuneLeftInset(): boolean {
    if (this.insetTuneBudget <= 0) return false;
    const scale = this.api.settings.display.scale;
    const ink = this.measureLeftInk();
    if (ink === null || scale <= 0) return false;

    const pad = this.api.settings.display.padding[0] ?? 0;
    leftInkOverhangPerScale = (pad - ink) / scale;
    const wanted = LEFT_INSET_PX + leftInkOverhangPerScale * scale;
    // The deadband is skipped when the ink is OUTSIDE the stack (a negative x is ink the
    // container is clipping, not ink half a pixel out of place), so a clipped brace is always
    // worth another pass while there is budget for one.
    if (ink >= 0 && Math.abs(wanted - pad) < 0.5) return false;

    setLeftPadding(this.api.settings, wanted);
    this.api.updateSettings();
    this.insetTuneBudget--;
    // Through the gate, and NOT `reuseViewport`: this call is made from inside the finishing
    // render's own `postRenderFinished`, so without the gate it would nest; and it moves the
    // whole engraving sideways, so nothing already painted is where it belongs. See `setZoom`.
    this.startRender(() => this.api.render({ reuseViewport: false }));
    return true;
  }

  /**
   * Content x of the leftmost engraved ink, or null when nothing is engraved.
   *
   * One `getBBox()` per rendered partial rather than a walk over every glyph: the union
   * box of an <svg>'s children is exactly the same number — checked against a
   * glyph-by-glyph measurement at three zooms, with and without a track name — and there
   * are a handful of partials against thousands of glyphs.
   */
  private measureLeftInk(): number | null {
    const stackLeft = this.stack.getBoundingClientRect().left;
    let min = Number.POSITIVE_INFINITY;
    for (const svg of this.host.querySelectorAll('svg')) {
      let box: { x: number; width: number; height: number } | null = null;
      try {
        box = (svg as SVGGraphicsElement).getBBox();
      } catch {
        box = null;
      }
      if (!box || (box.width === 0 && box.height === 0)) continue;
      // `getBBox()` is in SVG user units — the engraving's own pixels — so only the DOM half of
      // this sum is visual and only that half is converted (G1).
      const left = toLogical(svg.getBoundingClientRect().left - stackLeft) + box.x;
      if (left < min) min = left;
    }
    return Number.isFinite(min) ? min : null;
  }

  /**
   * A NOTE NAME IS NEVER DRAWN ON TOP OF SOMETHING ELSE (H2/H10).
   *
   * Two collisions, one pass, and both were photographed:
   *
   *   1. ENGRAVED LETTERING. alphaTab writes the capo annotation ("Capo. fret 1") as an effect
   *      band in exactly the gap this row lives in, so with a capo set the first two names came
   *      out reading "E(Capo. fret)1". The tempo mark and the bar numbers are the same shape of
   *      problem at the same y. Rather than special-case the capo, ANY engraved text made of
   *      ordinary letters is treated as occupied ground — the music font is skipped, because
   *      Bravura's em box is about four times its ink (a 36px notehead reports a 144px box that
   *      spans the staff, the gap and the tab) and intersecting against it would delete the whole
   *      row. Cheap to tell apart without `getComputedStyle`: every music glyph is a private-use
   *      codepoint, and lettering is not.
   *
   *   2. EACH OTHER. The row is one label per attack, so at a zoomed-out scale a dense bar asks
   *      for more labels than there are pixels: at 0.6 the triplet fixture wants "G1 A#1 C2" in
   *      the width of one of them and prints them as a smudge. Where two would collide the LATER
   *      one is dropped, which is the same thing the piano roll does to its own pitch names when
   *      the pane gets short (§labelMode). A missing label reads as "no room"; two labels on top
   *      of each other read as a bug, and neither can be read anyway.
   *
   * Chord stacks share an anchor x, so they survive or fall together — which is right: half a
   * chord's names is a wrong chord, not a thinner one.
   */
  private pruneNames(
    wanted: Array<WantedName>
  ): Array<WantedName> {
    if (wanted.length === 0) return wanted;
    const stackLeft = this.stack.getBoundingClientRect().left;
    const stackTop = this.stack.getBoundingClientRect().top;
    // The band the row occupies, with the tallest chord stack allowed for, so only the handful
    // of engraved texts that could possibly be in the way are measured.
    let bandTop = Number.POSITIVE_INFINITY;
    let bandBottom = Number.NEGATIVE_INFINITY;
    for (const w of wanted) {
      bandTop = Math.min(bandTop, w.y);
      bandBottom = Math.max(bandBottom, w.y + NAME_HEIGHT);
    }
    const blockers: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    for (const glyph of this.host.querySelectorAll('svg text')) {
      const text = glyph.textContent ?? '';
      // Music font = private use area. Anything with a plain letter or digit in it is lettering.
      if (text.length === 0 || ![...text].some((c) => c.charCodeAt(0) < 0xe000)) continue;
      const r = glyph.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Against `wanted`, which is in the engraving's pixels — so the blockers must be too (G1).
      const top = toLogical(r.top - stackTop);
      const bottom = toLogical(r.bottom - stackTop);
      if (bottom < bandTop || top > bandBottom) continue;
      blockers.push({
        left: toLogical(r.left - stackLeft),
        right: toLogical(r.right - stackLeft),
        top,
        bottom
      });
    }

    const kept: Array<WantedName> = [];
    const keptBoxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    let droppedAnchorX: number | null = null;
    let keptAnchorX: number | null = null;
    for (const w of wanted) {
      // One decision per anchor, reused by every name stacked on it.
      if (droppedAnchorX !== null && w.x === droppedAnchorX) continue;
      const box = {
        left: w.x - nameHalfWidth(w.text),
        right: w.x + nameHalfWidth(w.text),
        top: w.y,
        bottom: w.y + NAME_HEIGHT
      };
      const sameAnchor = keptAnchorX !== null && w.x === keptAnchorX;
      const hits =
        blockers.some((b) => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top) ||
        // Only the last few: `wanted` is built in engraving order, so a label can only ever
        // collide with its immediate neighbours, and comparing every pair is quadratic on a row
        // that can hold four hundred of them.
        (!sameAnchor &&
          keptBoxes
            .slice(-6)
            .some(
              (b) => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top
            ));
      if (hits) {
        droppedAnchorX = w.x;
        continue;
      }
      keptAnchorX = w.x;
      kept.push(w);
      keptBoxes.push(box);
    }
    return kept;
  }

  /**
   * Retire one label element: hidden, kept in the document, offered back on the next growth.
   *
   * `hidden` rather than `remove()` — that one word is the whole point. See §THE PARKED POOLS:
   * these elements are hit targets, a hit target that vanishes mid-pinch takes the rest of the
   * gesture with it on macOS, and a render that shrinks a row is exactly what a zoom-out is.
   * A hidden element is not hit-testable and not drawn, so nothing else can tell the difference.
   */
  private park<T extends HTMLElement>(el: T, pool: T[]): void {
    el.hidden = true;
    pool.push(el);
  }

  /** Take a retired element back into use, or `null` when the pool is empty and one must be made. */
  private unpark<T extends HTMLElement>(pool: T[]): T | null {
    const el = pool.pop();
    if (!el) return null;
    el.hidden = false;
    return el;
  }

  /** Reuse label elements across renders; creating 400 divs per keystroke is not free. */
  private syncLabels(wanted: Array<WantedName>): void {
    while (this.labels.length < wanted.length) {
      const el = this.unpark(this.parked.labels) ?? this.namesRow.appendChild(labelSpan('note-name'));
      this.labels.push({ el, x: 0 });
    }
    while (this.labels.length > wanted.length) {
      this.park(this.labels.pop()!.el, this.parked.labels);
    }
    for (let i = 0; i < wanted.length; i++) {
      const w = wanted[i];
      const l = this.labels[i];
      if (l.el.textContent !== w.text) l.el.textContent = w.text;
      l.el.style.transform = `translate(${w.x}px, ${w.y}px) translateX(-50%)`;
      l.el.classList.toggle('uncertain', w.uncertain);
      // The label's own note, for the press handler (P6). Deleted rather than set to "" when
      // there is none, so `dataset.noteId` is absent exactly when the answer is unknown.
      if (w.noteId) l.el.dataset.noteId = w.noteId;
      else delete l.el.dataset.noteId;
      l.x = w.x;
    }
  }

  /**
   * The column the letters are right-aligned against: just right of the time signature, just
   * left of the first notehead. Null when nothing has been engraved, which leaves the letters
   * in the reserved left padding as before.
   *
   * The first engraved beat's x is the handle. alphaTab publishes no bounds for the clef, the
   * key signature or the time signature individually, but everything between the start of the
   * staff and the first beat IS that prefix, so its right end is where the time signature
   * finishes. Right-aligning the letters a hair left of the first beat therefore puts them in
   * the same column as the meter, which is the column a tab book puts them in — and, once the
   * whole row is pinned to the viewport below, the column they stay in.
   */
  private stringLetterColumnX(): number | null {
    const axis = this.ensureAxis();
    if (!axis || axis.xs.length === 0) return null;
    return axis.xs[0] - STRING_LETTER_GAP_PX;
  }

  /**
   * A PRESSABLE TARGET OVER EVERY PART NAME THE ENGRAVING PRINTS.
   *
   * THE NAME IS NOT OURS TO DRAW. alphaTab writes the track name sideways in the reserved column
   * to the left of the system, out of `track.name` / `track.shortName`, as an ordinary SVG
   * `<text>` — there is no bounds entry for it, no event about it, and nothing in this app puts
   * it there. So it is FOUND, by the three properties that separate it from every other letter
   * on the page, and a transparent button is laid over the box it was found in:
   *
   *   1. it is LETTERING, not music. The music font is a private-use codepage, so anything with
   *      an ordinary character in it is text — the same test `pruneNames` makes, for the same
   *      reason and against the same glyphs;
   *   2. it is LEFT OF THE STAFF. Bar numbers, the tempo mark and the fret digits are all inside
   *      the system's own x; the reserved column is the only place a name is printed;
   *   3. it is PRINTED SIDEWAYS — taller than it is wide. A fret digit is 8x16 and passes (1)
   *      and would pass (3), which is exactly why (2) is not optional.
   *
   * Which TRACK it belongs to is then decided by geometry rather than by matching the string:
   * the label's centre falls inside one track's band of staves in that system, and two parts are
   * perfectly entitled to be called the same thing. `bar.staff.track.index` is the same
   * back-reference `liveBars` reads.
   *
   * A ONE-TRACK SCORE PRINTS NO NAME AT ALL — measured, not assumed: alphaTab omits it, and the
   * lettered text in the left column of a single-part page is the bar number and the tempo mark
   * and nothing else. So this produces nothing there, which is right: there would be no name
   * under the target.
   */
  private syncPartLabelHits(lookup: alphaTab.rendering.BoundsLookup): void {
    const wanted = this.opts.onPartLabelClick ? this.partLabelBoxes(lookup) : [];
    while (this.partLabelButtons.length < wanted.length) {
      // A parked button is a button that has already been through here, so it still carries the
      // one `click` listener bound below — taking it back must NOT bind a second one.
      const reused = this.unpark(this.parked.partLabelButtons);
      if (reused) {
        this.partLabelButtons.push(reused);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'part-label-hit';
      // Bound once and read from the element, so a reused button is never holding the track
      // index it had two renders ago.
      button.addEventListener('click', () => {
        const index = Number(button.dataset.track);
        if (!Number.isFinite(index)) return;
        // LOGICAL CLIENT COORDINATES (G1): the rename field this opens is `position: fixed`, and
        // under the face scale a fixed element's `left`/`top` are read in the design's own pixels.
        const r = logicalRect(button);
        this.opts.onPartLabelClick?.(index, { x: r.left, y: r.top, w: r.width, h: r.height });
      });
      this.partLabelHits.appendChild(button);
      this.partLabelButtons.push(button);
    }
    while (this.partLabelButtons.length > wanted.length) {
      this.park(this.partLabelButtons.pop()!, this.parked.partLabelButtons);
    }
    for (let i = 0; i < wanted.length; i++) {
      const w = wanted[i];
      const button = this.partLabelButtons[i];
      button.dataset.track = String(w.trackIndex);
      button.style.transform = `translate(${w.x}px, ${w.y}px)`;
      button.style.width = `${w.w}px`;
      button.style.height = `${w.h}px`;
      const label = `Part name: ${w.name}`;
      if (button.getAttribute('aria-label') !== label) {
        button.setAttribute('aria-label', label);
        button.setAttribute('title', 'Click this name to rename the part');
      }
    }
  }

  /** The printed part names, in stack coordinates, with the track each one belongs to. */
  private partLabelBoxes(
    lookup: alphaTab.rendering.BoundsLookup
  ): Array<{ trackIndex: number; x: number; y: number; w: number; h: number; name: string }> {
    const found: Array<{ trackIndex: number; x: number; y: number; w: number; h: number; name: string }> = [];
    const stack = this.stack.getBoundingClientRect();
    const lettered: Array<{ x: number; y: number; w: number; h: number; text: string }> = [];
    for (const glyph of this.host.querySelectorAll('svg text')) {
      const text = (glyph.textContent ?? '').trim();
      if (!text || ![...text].some((c) => c.charCodeAt(0) < 0xe000)) continue;
      const r = glyph.getBoundingClientRect();
      // Sideways, and only sideways. See (3) above.
      if (r.width === 0 || r.height <= r.width) continue;
      // Matched against `realBounds`/`visualBounds` below, which are engraved pixels (G1).
      lettered.push({
        x: toLogical(r.left - stack.left),
        y: toLogical(r.top - stack.top),
        w: toLogical(r.width),
        h: toLogical(r.height),
        text
      });
    }
    if (lettered.length === 0) return found;

    for (const system of lookup.staffSystems) {
      const first = system.bars[0];
      if (!first) continue;
      const bands = new Map<number, { top: number; bottom: number }>();
      let staffLeft = Number.POSITIVE_INFINITY;
      for (const bar of first.bars ?? []) {
        const index = bar.bar?.staff?.track?.index;
        if (index === undefined || index === null) continue;
        const box = bar.realBounds ?? bar.visualBounds;
        const band = bands.get(index);
        bands.set(index, {
          top: Math.min(band?.top ?? box.y, box.y),
          bottom: Math.max(band?.bottom ?? box.y + box.h, box.y + box.h)
        });
        staffLeft = Math.min(staffLeft, bar.visualBounds.x);
      }
      if (!Number.isFinite(staffLeft)) continue;
      for (const [trackIndex, band] of bands) {
        const label = lettered.find((l) => {
          const middle = l.y + l.h / 2;
          return l.x + l.w <= staffLeft - 1 && middle >= band.top && middle <= band.bottom;
        });
        if (!label) continue;
        found.push({ trackIndex, x: label.x, y: label.y, w: label.w, h: label.h, name: label.text });
      }
    }
    return found;
  }

  /**
   * The open-string letters, same reuse discipline as the names row.
   *
   * `translate(x, y)` then `translate(-100%, -50%)`: x is the RIGHT edge (the letters are
   * right-aligned against the staff, so a two-character name and a one-character one end at
   * the same place) and y is the LINE, so the text is centred on it rather than hanging below.
   *
   * PINNED TO THE VIEWPORT (F8). The x stored here is the CONTENT x, and what is written into
   * the transform is that x plus the current scroll — so the letters sit in a fixed screen
   * column instead of sliding off the left edge the moment Align scrolls the sheet. They are a
   * legend for the staff, not a mark on the music: scrolling to bar 30 does not stop the third
   * line from being a D, and a legend you have to scroll back to is the thing this row replaced.
   * `restringLetterPositions()` re-applies it on every scroll.
   */
  private syncStringLetters(wanted: Array<{ x: number; y: number; text: string }>): void {
    while (this.stringLetters.length < wanted.length) {
      // The plate the pinned row needs to be readable over music lives in `.string-letter`
      // (ui/styles.css). It was set inline here while the row was being built; nothing about
      // it depends on anything this file knows, so it is a stylesheet's job.
      const el =
        this.unpark(this.parked.stringLetters) ??
        this.stringLettersRow.appendChild(labelSpan('string-letter', t(TIPS.stringLetters)));
      this.stringLetters.push({ el, x: 0, y: 0 });
    }
    while (this.stringLetters.length > wanted.length) {
      this.park(this.stringLetters.pop()!.el, this.parked.stringLetters);
    }
    for (let i = 0; i < wanted.length; i++) {
      const w = wanted[i];
      const m = this.stringLetters[i];
      if (m.el.textContent !== w.text) m.el.textContent = w.text;
      m.x = w.x;
      m.y = w.y;
    }
    this.placeStringLetters();
  }

  /** Write the pinned transform for every letter. Cheap enough to call on every scroll frame. */
  private placeStringLetters(): void {
    const left = this.scroller.scrollLeft;
    /*
     * THE LINE SPACING IS THE SIZE (H10), the same law the printed page uses
     * (export/pdf.ts §stringLetterSize) and for the same reason: the letters are stacked one per
     * tab line, and a tab line on a six-string staff at a zoomed-out scale is a few pixels from
     * the next. A fixed 9px is therefore sometimes taller than the gap it has to sit in, and four
     * letters become one grey column with no white between them — which is what "vertical
     * crowding on grand + tab" was a photograph of.
     *
     * 68% of the smallest measured gap, capped at the stylesheet's own 9px and floored at 6px so
     * a very tight staff shrinks them rather than making them illegible. Measured off the letters
     * that are actually there, so nothing here has to know how many strings the instrument has.
     */
    let minGap = Number.POSITIVE_INFINITY;
    for (let i = 1; i < this.stringLetters.length; i++) {
      const gap = Math.abs(this.stringLetters[i].y - this.stringLetters[i - 1].y);
      if (gap > 0) minGap = Math.min(minGap, gap);
    }
    const size = Number.isFinite(minGap) ? Math.max(6, Math.min(9, minGap * 0.68)) : 9;
    for (const m of this.stringLetters) {
      m.el.style.fontSize = `${size.toFixed(2)}px`;
      m.el.style.transform = `translate(${m.x + left}px, ${m.y}px) translate(-100%, -50%)`;
    }
  }

  /**
   * The octave-fold markers, same reuse discipline as the names row.
   *
   * These exist because the pipeline can only place a below-range note on the fretboard by
   * folding it up an octave (`IRNote.tabOctaveShift`). The notation staff still shows the
   * pitch you played; the tab shows a position that sounds an octave off. Unmarked, that
   * is a silent lie in the one place a beginner trusts most.
   */
  private syncTabMarks(wanted: Array<{ x: number; y: number; text: string }>): void {
    while (this.tabMarks.length < wanted.length) {
      // The tip is set once, at creation: the tooltip layer moves `title` to `data-riff-tip` on
      // first hover, and re-setting it afterwards resurrects the native OS tooltip alongside ours.
      const el =
        this.unpark(this.parked.tabMarks) ??
        this.tabMarksRow.appendChild(labelSpan('tab-mark', t(TIPS.tabOctaveShift)));
      this.tabMarks.push({ el, x: 0 });
    }
    while (this.tabMarks.length > wanted.length) {
      this.park(this.tabMarks.pop()!.el, this.parked.tabMarks);
    }
    for (let i = 0; i < wanted.length; i++) {
      const w = wanted[i];
      const m = this.tabMarks[i];
      if (m.el.textContent !== w.text) m.el.textContent = w.text;
      // `x` is the CENTRE of the digit the marker is about; see the note where they are built.
      m.el.style.transform = `translate(${w.x}px, ${w.y}px) translateX(-50%)`;
      m.x = w.x;
    }
  }

  // -------------------------------------------------------------------------
  // Playhead
  // -------------------------------------------------------------------------

  /**
   * Move the playhead to a MIDI tick.
   *
   * Deliberately the SAME helper the piano roll uses (`tickToContentX`), not a second copy
   * of the same arithmetic. The cursor and the roll's rectangles are two drawings of one
   * number; give them two code paths and they will eventually disagree, which is exactly
   * the class of bug design notes §4.13 is about.
   */
  setPlayheadTick(tick: number): void {
    const x = this.tickToContentX(tick);
    if (x === null) return;

    const height = Number(this.overlay.getAttribute('height')) || this.host.clientHeight;
    this.playheadLine.setAttribute('x1', String(x));
    this.playheadLine.setAttribute('x2', String(x));
    this.playheadLine.setAttribute('y1', '0');
    this.playheadLine.setAttribute('y2', String(height));
    this.playheadLine.style.opacity = '1';
    this.keepPlayheadVisible(x);
  }

  hidePlayhead(): void {
    this.playheadLine.style.opacity = '0';
  }

  private keepPlayheadVisible(x: number): void {
    const left = this.scroller.scrollLeft;
    const width = this.scroller.clientWidth;
    // Keep the playhead in a comfortable band rather than snapping on every frame.
    const margin = width * 0.25;
    if (x < left + margin) {
      this.scroller.scrollLeft = Math.max(0, x - margin);
    } else if (x > left + width - margin) {
      this.scroller.scrollLeft = x - width + margin;
    }
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  /**
   * Instant selection: overlay rectangles straight from the bounds, no re-render.
   * This is what makes clicking feel free.
   */
  setSelection(noteIds: string[]): void {
    // Copied, not stored by reference: the caller keeps its own list and we redraw from
    // ours on every render.
    this.selectedIds = [...noteIds];
    this.drawSelection();
    // A note that has just BECOME selected must lose its hover ring in the same frame, or the
    // click leaves two rings around one notehead until the pointer moves.
    this.drawHover();
  }

  /** Which notes are highlighted right now. A read of the copy, never of an authority. */
  get selection(): string[] {
    return [...this.selectedIds];
  }

  /**
   * DO THE BOUNDS DESCRIBE THE SCORE THE INDEX DESCRIBES?
   *
   * Every pointer road has to ask, not just `hitTest`: the name-label road (`hitTestByName`) and
   * the nearest-beat fallback (`hitTestByX`) read the same `boundsLookup` and would happily
   * answer from an engraving that has been replaced. `hitTestByX` in particular is the one that
   * turns a refusal into a SEEK — `onPointerDown` falls through to it when nothing was hit — so
   * gating `hitTest` alone would have moved the playhead instead of selecting, which is the
   * original symptom wearing a different hat.
   *
   * Counted rather than merely returned, so `probe()` can show a rejection happened. A number
   * that stays at zero through a normal session and rises during a deferred/hidden rebuild is
   * the evidence that this gate is doing something.
   */
  private boundsAreCurrent(): boolean {
    if (this.boundsRevision === this.modelRevision) return true;
    this.staleHitRejections++;
    return false;
  }

  /**
   * The revision pair and what the gate has done with it. For `__RIFFSHEET_SEAM__`.
   *
   * `current` is the invariant a probe asserts between interactions; `staleHitRejections` is the
   * evidence that the gate fires when it should, which is the half a passing session cannot show.
   */
  revisionProbe(): {
    model: number;
    bounds: number;
    current: boolean;
    staleHitRejections: number;
  } {
    return {
      model: this.modelRevision,
      bounds: this.boundsRevision,
      current: this.boundsRevision === this.modelRevision,
      staleHitRejections: this.staleHitRejections
    };
  }

  // -------------------------------------------------------------------------
  // Cross-highlight (#30d)
  // -------------------------------------------------------------------------

  /**
   * The roll says the pointer is over these notes, so ring them here.
   *
   * DELIBERATELY NOT THE SELECTION, and the distinction is the whole reason this is a second
   * layer rather than a call to `setSelection`. A hover is a question — "is this the note I
   * mean?" — and a selection is an answer. Drawing them the same way would make pointing at a
   * rectangle on the roll look as though it had already changed what Delete would remove.
   *
   * Never echoed back through `onNoteHover`: this is the INWARD half, and reporting what we
   * were just told is how a two-view highlight becomes a loop.
   */
  setHover(noteIds: ReadonlyArray<string>): void {
    if (noteIds.length === this.hoveredIds.length && noteIds.every((id, i) => this.hoveredIds[i] === id)) return;
    this.hoveredIds = [...noteIds];
    this.drawHover();
  }

  /** Which notes are ringed right now. The counterpart of `selection`. */
  get hovered(): string[] {
    return [...this.hoveredIds];
  }

  /**
   * The OUTWARD half: tell the caller which note is under the pointer, once per change.
   *
   * Private and funnelled, because every route that can change it (a move, a leave, the start
   * of a drag) has to go through the same "has it actually changed" test — a pointermove fires
   * dozens of times a second and the far end of this repaints a canvas.
   */
  private reportHover(noteId: string | null): void {
    if (noteId === this.hoverReported) return;
    this.hoverReported = noteId;
    this.opts.onNoteHover?.(noteId);
  }

  /**
   * The rings themselves: lighter than the selection's, and no fill.
   *
   * A note that is ALREADY SELECTED is skipped rather than ringed twice. Two rings around one
   * notehead reads as a third state that does not exist, and the selection's is the one that
   * means something you can act on.
   *
   * Weights inline for the same reason `drawSelection` sets its own — `styles.css` belongs to
   * the integrator — but the class is kept so the accent colour still comes from there.
   */
  private drawHover(): void {
    this.hoverGroup.replaceChildren();
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup || !this.index) return;
    const selected = new Set(this.selectedIds);

    for (const id of this.hoveredIds) {
      if (selected.has(id)) continue;
      // Every notehead of the note, as in `drawSelection`: one held note is several tied
      // glyphs sharing one id, and ringing one of them looks like the others are a different note.
      const notes = this.index.idToNotes?.get(id) ?? [];
      const single = notes.length === 0 ? this.index.idToNote.get(id) : null;
      const chain = notes.length > 0 ? notes : single ? [single] : [];
      // The same screen-pixel floor the selection gets, one step lighter. A hover ring at 1.75
      // engraving units is 0.48 screen pixels on a 0.273 face — not a lighter answer to "is this
      // the note I mean?", just no answer. See `drawSelection` for the arithmetic.
      const width = Math.max(HOVER_RING_UNITS, HOVER_RING_MIN_SCREEN_PX / Math.max(faceScale(), 0.05));
      for (const r of chain.flatMap((n) => this.noteGlyphRects(n))) {
        this.hoverGroup.appendChild(
          selectionRect(
            r,
            Math.max(5, width * 0.9),
            { fill: 'none', strokeWidth: String(width), opacity: '0.65' },
            'sel-rect hover-rect'
          )
        );
      }
    }
  }

  /**
   * Every rendered glyph of one note, in content coordinates — the notehead on the staff
   * AND the fret digit on the tab.
   *
   * `findBeats`, not `findBeat`: a beat is registered once per stave and `findBeat` hands
   * back only the first of them, which is the notation one. Reading that alone is why the
   * highlight used to appear on the staff and never on the tab, and why a drag started on
   * a fret digit would have drawn its ghost up on the staff.
   */
  private noteGlyphRects(note: alphaTab.model.Note): Array<{ x: number; y: number; w: number; h: number }> {
    const lookup = this.api.renderer.boundsLookup;
    const all = lookup?.findBeats(note.beat);
    if (!all || all.length === 0) return [];
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const bb of all) {
      for (const nb of bb.notes ?? []) {
        if (nb.note === note) rects.push(nb.noteHeadBounds);
      }
    }
    // Nothing per-note (includeNoteBounds off, or a glyph alphaTab does not itemise):
    // fall back to the beat's own box so the user still sees WHERE the selection is.
    if (rects.length === 0) rects.push(all[0].visualBounds);
    return rects;
  }

  /**
   * Draw the highlight rings.
   *
   * They are heavier than they used to be on purpose. They are now the ONLY highlight in
   * the app: the piano roll's old "everything before the playhead is filled orange" was a
   * bug — it made half the take look selected — and it is gone. A single thin outline was
   * enough when there was a wash of colour behind it and is not enough now, so each glyph
   * gets a soft halo with a firm ring inside it.
   *
   * The weights are set as inline styles rather than left to `.sel-rect` in styles.css,
   * because that stylesheet belongs to the integrator and a rule there would otherwise win
   * over anything set here. The COLOURS still come from the stylesheet, so the app's accent
   * stays in one place.
   */
  private drawSelection(): void {
    const lookup = this.api.renderer.boundsLookup;
    this.selectionGroup.replaceChildren();
    this.syncLabelSelection();
    if (!lookup || !this.index) return;

    /*
     * THE UNIT CONVERSION THAT MAKES THIS VISIBLE, and whose absence is the whole of finding 11.
     *
     * The overlay is drawn in the ENGRAVING's own coordinates, which are logical pixels — the
     * same space `logicalPoint` converts a pointer into. The face is then scaled onto the screen
     * by ONE number (`faceScale`, see ui/faceScale.ts §THE ONE-PROPORTION LAW). So
     *
     *     screen px = engraving units x faceScale
     *
     * and every weight written here as a constant was in fact a promise about a 1:1 window. At
     * REAPER's 360x280 the scale is about 0.273, so the "firm 2.5 px ring" was 0.68 screen
     * pixels and the 6 px halo at 30% opacity was 1.64 of them — a highlight that technically
     * rendered on every glyph and could readily look like nothing at all, which is exactly what
     * was reported.
     *
     * Dividing the screen-pixel minimum by the scale gives the engraving-unit weight that comes
     * out at that many real pixels. Above the base size the scale is 1 and nothing changes, so
     * this cannot make the highlight heavier than it was designed to be on a large window; it
     * only refuses to let it become invisible on a small one.
     */
    const scale = Math.max(faceScale(), 0.05);
    const unitsFor = (screenPx: number) => screenPx / scale;
    const ringWidth = Math.max(SEL_RING_UNITS, unitsFor(SEL_RING_MIN_SCREEN_PX));
    const haloWidth = Math.max(SEL_HALO_UNITS, unitsFor(SEL_HALO_MIN_SCREEN_PX));
    // The padding has to grow with the strokes or the halo swallows the ring and both swallow
    // the notehead: a 7-unit pad under a 12-unit stroke is a solid blob.
    const ringPad = Math.max(SEL_RING_PAD_UNITS, ringWidth * 0.9);
    const haloPad = ringPad + haloWidth * 0.5;

    for (const id of this.selectedIds) {
      // EVERY notehead of the note, not just the first. A note held across a bar line is
      // engraved as several tied noteheads that share one id, and highlighting only one made
      // the others look like separate notes the player could not select — which is exactly
      // what was reported. `idToNotes` is the whole chain; the fallback keeps a score built
      // by an older build working rather than silently drawing no highlight at all.
      const notes = this.index.idToNotes?.get(id) ?? [];
      const single = notes.length === 0 ? this.index.idToNote.get(id) : null;
      const chain = notes.length > 0 ? notes : single ? [single] : [];
      const rects = chain.flatMap((n) => this.noteGlyphRects(n));
      if (rects.length === 0) continue;

      for (const r of rects) {
        // Halo first so it sits behind the ring.
        this.selectionGroup.appendChild(
          selectionRect(r, haloPad, {
            fill: 'none',
            strokeWidth: String(haloWidth),
            opacity: String(SEL_HALO_OPACITY)
          })
        );
        // ...then the firm ring, WITH ITS FILL. The fill used to come from `.sel-rect`'s
        // `accent-soft` (20% alpha), which on paper-coloured staff is a tint you have to be
        // looking for. `sel-rect-firm` gives it a solid-enough wash to read as "this one" at a
        // glance, which is what the owner asked for in the words "it should really attract".
        this.selectionGroup.appendChild(
          selectionRect(r, ringPad, { strokeWidth: String(ringWidth) }, 'sel-rect sel-rect-firm')
        );
      }
    }
  }

  /**
   * The clicked note's NAME gets the treatment too.
   *
   * Finding 11 lists this as part of why selection reads as faint: the note-names row is the
   * thing a player is often actually reading, and it never received a selected class at all, so
   * the one piece of the interface that spells out which note you picked stayed ordinary ink.
   *
   * Driven from `drawSelection` rather than from the label sync, because selection changes far
   * more often than the label row is rebuilt and this is a class toggle on a few dozen elements.
   */
  private syncLabelSelection(): void {
    const selected = new Set(this.selectedIds);
    for (const label of this.labels) {
      const id = label.el.dataset.noteId;
      label.el.classList.toggle('selected', !!id && selected.has(id));
    }
  }

  // -------------------------------------------------------------------------
  // Direct manipulation: drag a note on the staff or on the tab
  //
  // WHICH STAFF YOU GRABBED IS THE WHOLE INTERFACE. There is no mode, no modifier that
  // changes the meaning, and nothing here moves a note in TIME — that belongs to the piano
  // roll, where a horizontal axis is the point.
  //
  //   notation staff -> PITCH. One staff position per line-or-space, so the notehead lands
  //                     where the pointer is. Steps are diatonic in the current key; hold
  //                     Alt/Option for literal semitones.
  //   tab staff      -> STRING. Same sounding pitch, different place on the neck. A string
  //                     that cannot reach the note is shown as a refusal, not silently
  //                     ignored and not quietly clamped to a different one.
  //
  // Nothing is applied while the pointer moves. A render is 10–25 ms; doing one per
  // pointermove would feel like dragging through treacle. What moves is a GHOST in the
  // overlay SVG, and the edit happens once, on pointerup.
  // -------------------------------------------------------------------------

  /** Keep the fret limit in step with the settings panel. */
  setFretLimit(maxFret: number): void {
    this.maxFret = Number.isFinite(maxFret) && maxFret > 0 ? maxFret : DEFAULT_MAX_FRET;
  }

  /**
   * Which staff the current selection was made on, so a keyboard Up/Down can mean the same
   * thing the drag would have meant. Null when nothing was selected by pointer.
   */
  get selectionStaff(): StaffKind | null {
    return this.selectionStaffKind;
  }

  /**
   * Staff positions -> semitones for one note, in the current key.
   *
   * Public so the keyboard path can use the SAME conversion the drag uses instead of
   * growing a second, subtly different one. Null when the note is unknown.
   */
  diatonicSemitones(noteId: string, steps: number, chromatic = false): number | null {
    const note = this.index?.idToNote.get(noteId);
    if (!note || !this.index) return null;
    if (chromatic) return steps;
    return diatonicShift(soundingMidi(this.index, note), steps, this.keyFifths);
  }

  /** What a drag would do right now — for the headless harness, which cannot watch a callback. */
  dragProbe(): {
    dragging: boolean;
    noteId: string | null;
    dragKind: 'pitch' | 'string' | null;
    dragSteps: number;
    dragValid: boolean;
    ghostVisible: boolean;
    /** Pixels of pointer travel per step, so a test can compute a distance instead of guessing. */
    stepPx: number;
    selectionStaff: StaffKind | null;
    /** The last preview emitted, and the last commit — both survive pointerup. */
    lastPreview: NoteDragPreview | null;
    lastCommit: NoteDragCommit | null;
    /** Cross-highlight (#30d): what the roll told us, and what we told the roll. */
    hoverIds: string[];
    hoverReported: string | null;
    /** Rings actually in the overlay. Zero while the only hovered note is also selected. */
    hoverRings: number;
  } {
    const d = this.drag;
    return {
      hoverIds: [...this.hoveredIds],
      hoverReported: this.hoverReported,
      hoverRings: this.hoverGroup.childNodes.length,
      dragging: !!d && d.moved,
      noteId: d?.noteId ?? null,
      dragKind: d ? (d.staff === 'notation' ? 'pitch' : 'string') : null,
      dragSteps: d?.steps ?? 0,
      dragValid: d?.valid ?? false,
      ghostVisible: this.ghostGroup.childNodes.length > 0,
      stepPx: d ? d.stepPx : 0,
      selectionStaff: this.selectionStaffKind,
      lastPreview: this.lastDragPreview,
      lastCommit: this.lastDragCommit
    };
  }

  /** Begin a possible drag. Nothing is committed to until the pointer actually moves. */
  private beginDrag(hit: NoteHit, e: PointerEvent): void {
    if (!hit.note || !hit.noteId || !hit.staff || !this.index) return;
    // A drag has started, so hovering is over: the note that matters is the one in the hand,
    // and it is about to be highlighted as the drag's own. `onHoverMove` stays silent for the
    // duration; this is what closes the report that was already open.
    this.reportHover(null);
    // The note has a glyph on each staff. The ghost has to follow the one the pointer is
    // actually on, so pick the nearest by y rather than the first in the list.
    const heads = this.noteGlyphRects(hit.note);
    if (heads.length === 0) return;
    const pointerY = logicalPoint(this.host, e.clientX, e.clientY).y;
    let head = heads[0];
    let best = Number.POSITIVE_INFINITY;
    for (const r of heads) {
      const d = Math.abs(r.y + r.h / 2 - pointerY);
      if (d < best) {
        best = d;
        head = r;
      }
    }

    const engraving = this.api.settings.display.resources.engravingSettings;
    const scale = this.api.settings.display.scale;
    // A staff POSITION is half a staff space — one line to the next space. A tab string is
    // a whole tab line gap. Both come from alphaTab's own engraving metrics rather than a
    // measurement of the picture, and both are scaled because the bounds are.
    const stepPx =
      hit.staff === 'notation'
        ? (engraving.oneStaffSpace / 2) * scale
        : engraving.tabLineSpacing * scale;

    this.drag = {
      noteId: hit.noteId,
      note: hit.note,
      staff: hit.staff,
      startClientY: e.clientY,
      startClientX: e.clientX,
      axis: null,
      tick: null,
      dx: 0,
      editable: hit.live,
      head: { x: head.x, y: head.y, w: head.w, h: head.h },
      stepPx: stepPx > 0 ? stepPx : 1,
      steps: 0,
      semitones: 0,
      valid: false,
      moved: false,
      chromatic: e.altKey,
      label: ''
    };
  }

  private updateDrag(clientX: number, clientY: number, altKey: boolean): void {
    const d = this.drag;
    if (!d || !this.index) return;
    /*
     * THE DELTAS GO LOGICAL AND THE THRESHOLD COMES WITH THEM (G1).
     *
     * `dy` is divided by `stepPx`, which is an alphaTab engraving metric times `display.scale` —
     * a LOGICAL length — so the pointer delta has to be logical too or a drag moves a note by the
     * wrong number of staff positions at every face scale below 1.
     *
     * `DRAG_THRESHOLD_PX` is the opposite kind of number: it describes how far a hand moves before
     * it meant to, which is a fact about the hand and not about the drawing, so it stays constant
     * in VISUAL pixels — and staying constant in visual pixels while the deltas are logical means
     * dividing it by the same scale.
     */
    const dy = toLogical(clientY - d.startClientY);
    const dx = toLogical(clientX - d.startClientX);
    const threshold = toLogical(DRAG_THRESHOLD_PX);
    if (!d.moved && Math.max(Math.abs(dy), Math.abs(dx)) < threshold) return;
    // THE LOCK, taken at the moment the drag is recognised and never revisited. See `DragState`.
    if (d.axis === null) d.axis = Math.abs(dx) > Math.abs(dy) ? 'time' : 'pitch';
    d.moved = true;
    d.chromatic = altKey;

    if (d.axis === 'time') {
      d.dx = dx;
      // A CONTENT x, not a client one: the ghost is drawn inside the scrolled stack, and the
      // tick has to come from the same axis the engraving publishes.
      const contentX = logicalX(this.host, clientX);
      d.tick = this.contentXToTick(contentX);
      // An imported part is paper. The gesture is shown as refused rather than ignored, so the
      // player learns the rule from the picture instead of from nothing happening.
      d.valid = d.editable && d.tick !== null && Math.abs(dx) >= threshold;
      d.label = d.editable ? 'move in time' : 'imported part';
      d.steps = 0;
      this.drawGhost();
      this.lastDragPreview = { noteId: d.noteId, kind: 'time', steps: 0, valid: d.valid };
      this.opts.onNoteDragPreview?.(this.lastDragPreview);
      return;
    }

    // Screen y grows downward; pitch and string number both grow upward.
    const steps = -Math.round(dy / d.stepPx);
    d.steps = steps;
    this.evaluateDrag();
    this.drawGhost();
    this.lastDragPreview = {
      noteId: d.noteId,
      kind: d.staff === 'notation' ? 'pitch' : 'string',
      steps: d.steps,
      valid: d.valid
    };
    this.opts.onNoteDragPreview?.(this.lastDragPreview);
  }

  /** Work out whether the candidate exists on this instrument, and what to call it. */
  private evaluateDrag(): void {
    const d = this.drag;
    if (!d || !this.index) return;
    const sounding = soundingMidi(this.index, d.note);
    const tuning = this.index.tuningLowToHigh;
    const capo = this.index.capo;

    if (d.staff === 'notation') {
      const semitones = d.chromatic
        ? d.steps
        : diatonicShift(sounding, d.steps, this.keyFifths);
      d.semitones = semitones;
      if (d.steps === 0) {
        d.valid = false;
        d.label = midiToName(sounding, this.accidentals);
        return;
      }
      const target = sounding + semitones;
      if (target < 0 || target > 127) {
        d.valid = false;
        d.label = 'out of range';
        return;
      }
      // Standard notation has no fretboard to validate. The old unconditional assignFret()
      // therefore rejected every vertical drag after universal/staff-only import became the
      // default. MIDI bounds are the complete validity rule for a plain staff.
      if (tuning.length === 0) {
        d.valid = true;
        d.label = midiToName(target, this.accidentals);
        return;
      }
      // The same refusal rule ChangePitchAction uses, asked in advance so the ghost can
      // say no before the user lets go rather than after.
      const placed = assignFret(target, tuning, {
        maxFret: this.maxFret,
        capo,
        style: 'minimize-movement',
        previousFret: d.note.fret
      });
      d.valid = !!placed;
      d.label = midiToName(target, this.accidentals);
      return;
    }

    // Tab: same pitch, a different string. Never a pitch change, never a time change.
    const targetString = d.note.string + d.steps;
    if (d.steps === 0 || targetString < 1 || targetString > tuning.length) {
      d.valid = false;
      d.label = d.steps === 0 ? `${d.note.string} · ${d.note.fret}` : 'no string';
      return;
    }
    const fret = sounding - (tuning[targetString - 1] + capo);
    d.valid = fret >= 0 && fret <= this.maxFret;
    d.targetString = targetString;
    d.targetFret = fret;
    d.label = d.valid ? `${targetString} · ${fret}` : fret < 0 ? 'too low here' : 'too far up';
  }

  private drawGhost(): void {
    const d = this.drag;
    this.ghostGroup.replaceChildren();
    if (!d || !d.moved) return;

    const colors = readOverlayColors();
    const stroke = d.valid ? colors.accent : colors.danger;
    // A TIME drag moves the box sideways and leaves the height alone; a pitch/string drag does
    // the opposite. One ghost, one axis, because the drag itself is locked to one axis.
    const y = d.axis === 'time' ? d.head.y : d.head.y - d.steps * d.stepPx;
    const x = d.axis === 'time' ? d.head.x + d.dx : d.head.x;
    const pad = 3;

    if (d.axis === 'time') {
      const box = document.createElementNS(SVG_NS, 'rect');
      box.setAttribute('x', String(x - pad));
      box.setAttribute('y', String(y - pad));
      box.setAttribute('width', String(d.head.w + pad * 2));
      box.setAttribute('height', String(d.head.h + pad * 2));
      box.setAttribute('rx', '3');
      box.style.fill = 'none';
      box.style.stroke = stroke;
      box.style.strokeWidth = '2';
      if (!d.valid) box.style.strokeDasharray = '3 3';
      this.ghostGroup.appendChild(box);

      const cy = d.head.y + d.head.h / 2;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(d.head.x + d.head.w / 2));
      line.setAttribute('x2', String(x + d.head.w / 2));
      line.setAttribute('y1', String(cy));
      line.setAttribute('y2', String(cy));
      line.style.stroke = stroke;
      line.style.strokeWidth = '1';
      line.style.strokeDasharray = '2 3';
      line.style.opacity = '0.7';
      this.ghostGroup.appendChild(line);

      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', String(x + d.head.w + 7));
      text.setAttribute('y', String(y - 6));
      text.textContent = d.label;
      text.style.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      text.style.fill = stroke;
      text.style.stroke = colors.paper;
      text.style.strokeWidth = '3px';
      text.style.paintOrder = 'stroke';
      this.ghostGroup.appendChild(text);
      return;
    }

    const box = document.createElementNS(SVG_NS, 'rect');
    box.setAttribute('x', String(d.head.x - pad));
    box.setAttribute('y', String(y - pad));
    box.setAttribute('width', String(d.head.w + pad * 2));
    box.setAttribute('height', String(d.head.h + pad * 2));
    box.setAttribute('rx', '3');
    box.style.fill = 'none';
    box.style.stroke = stroke;
    box.style.strokeWidth = '2';
    if (!d.valid) box.style.strokeDasharray = '3 3';
    this.ghostGroup.appendChild(box);

    // A guide line back to where the note started, so a four-position jump is legible.
    const from = d.head.y + d.head.h / 2;
    const to = y + d.head.h / 2;
    if (Math.abs(to - from) > 1) {
      const line = document.createElementNS(SVG_NS, 'line');
      const cx = d.head.x + d.head.w / 2;
      line.setAttribute('x1', String(cx));
      line.setAttribute('x2', String(cx));
      line.setAttribute('y1', String(from));
      line.setAttribute('y2', String(to));
      line.style.stroke = stroke;
      line.style.strokeWidth = '1';
      line.style.strokeDasharray = '2 3';
      line.style.opacity = '0.7';
      this.ghostGroup.appendChild(line);
    }

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(d.head.x + d.head.w + 7));
    text.setAttribute('y', String(y + d.head.h / 2 + 4));
    text.textContent = d.label;
    text.style.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    text.style.fill = stroke;
    // A paint-order halo instead of a background box: no width to measure, and it stays
    // readable over staff lines and fret digits alike.
    text.style.stroke = colors.paper;
    text.style.strokeWidth = '3px';
    text.style.paintOrder = 'stroke';
    this.ghostGroup.appendChild(text);
  }

  /** Finish: emit the edit if there is a legal one, then clean up either way. */
  private finishDrag(): void {
    const d = this.drag;
    this.drag = null;
    this.ghostGroup.replaceChildren();
    if (!d) return;
    this.opts.onNoteDragPreview?.(null);
    if (!d.moved || !d.valid) return;

    if (d.axis === 'time') {
      if (d.tick === null) return;
      this.lastDragCommit = { noteId: d.noteId, kind: 'time', tick: d.tick };
      this.opts.onNoteDragCommit?.(this.lastDragCommit);
      return;
    }
    if (d.steps === 0) return;

    if (d.staff === 'notation') {
      this.lastDragCommit = { noteId: d.noteId, kind: 'pitch', semitones: d.semitones };
    } else if (d.targetString !== undefined && d.targetFret !== undefined) {
      this.lastDragCommit = {
        noteId: d.noteId,
        kind: 'string',
        direction: d.steps > 0 ? 1 : -1,
        steps: Math.abs(d.steps),
        fromString: d.note.string,
        toString: d.targetString,
        toFret: d.targetFret
      };
    } else {
      return;
    }
    this.opts.onNoteDragCommit?.(this.lastDragCommit);
  }

  /** Abandon without emitting anything — Escape, or the score being replaced underneath us. */
  private cancelDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.ghostGroup.replaceChildren();
    this.opts.onNoteDragPreview?.(null);
  }

  private onDragMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    this.updateDrag(e.clientX, e.clientY, e.altKey);
  };

  private onDragUp = (): void => {
    this.detachDragListeners();
    this.finishDrag();
  };

  private onDragKey = (e: KeyboardEvent): void => {
    if (!this.drag) return;
    if (e.key === 'Escape') {
      this.detachDragListeners();
      this.cancelDrag();
      return;
    }
    // Alt can be pressed or released mid-drag; re-evaluate at the current position.
    if (e.key === 'Alt' && this.drag.moved) {
      this.drag.chromatic = e.type === 'keydown';
      this.evaluateDrag();
      this.drawGhost();
    }
  };

  private attachDragListeners(): void {
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragUp);
    window.addEventListener('pointercancel', this.onDragUp);
    window.addEventListener('keydown', this.onDragKey);
    window.addEventListener('keyup', this.onDragKey);
  }

  private detachDragListeners(): void {
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragUp);
    window.removeEventListener('pointercancel', this.onDragUp);
    window.removeEventListener('keydown', this.onDragKey);
    window.removeEventListener('keyup', this.onDragKey);
  }

  /** Hover: say so when a glyph can be dragged. One hit test per frame, not per event. */
  private onHoverMove = (e: PointerEvent): void => {
    if (this.drag || this.cursorFrame) return;
    const clientX = e.clientX;
    const clientY = e.clientY;
    this.cursorFrame = requestAnimationFrame(() => {
      this.cursorFrame = 0;
      if (this.drag) return;
      const hit = this.hitTest(clientX, clientY);
      this.scroller.style.cursor = hit?.note ? 'ns-resize' : '';
      // The SAME hit test the cursor is decided from, so the ring on the roll and the shape of
      // the pointer can never disagree about which note is under the hand (#30d).
      this.reportHover(hit?.note ? hit.noteId : null);
    });
  };

  /**
   * The pointer left the sheet, so nothing is hovered.
   *
   * Needed as its own event: a pointer that leaves fires no final `pointermove` over empty
   * space, so without this the last note stays ringed on the roll after the hand has gone.
   */
  private onHoverLeave = (): void => {
    this.reportHover(null);
  };

  // -------------------------------------------------------------------------
  // Hit testing
  // -------------------------------------------------------------------------

  /**
   * Which staff a content y is on.
   *
   * Nearest staff centre rather than a boundary line, because a note with ledger lines
   * sits well outside its own staff box and must still belong to it.
   *
   * WHICH STAVE IS WHICH IS DERIVED, NOT COUNTED. This used to read "two BarBounds means
   * notation at 0 and tab at 1", which is true of exactly one of the three shapes the app
   * now engraves. On a GRAND STAFF the lower stave is a second notation stave, and the
   * positional rule called it tablature — so clicking a bass-clef notehead started a STRING
   * drag on a staff that has no strings, and the drag was then refused for a reason that made
   * no sense on screen. `staveKindsFromBars` asks the staves themselves; see view/staveKinds.ts.
   */
  private staffAtY(y: number): StaffKind | null {
    const lookup = this.api.renderer.boundsLookup;
    for (const system of lookup?.staffSystems ?? []) {
      for (const masterBar of system.bars) {
        const bars = masterBar.bars ?? [];
        if (bars.length === 0) continue;
        const kinds = staveKindsFromBars(bars);
        let best: StaveKind = 'other';
        let bestDist = Number.POSITIVE_INFINITY;
        for (let i = 0; i < bars.length; i++) {
          const v = bars[i].visualBounds;
          const d = Math.abs(y - (v.y + v.h / 2));
          if (d < bestDist) {
            bestDist = d;
            best = kinds[i] ?? 'other';
          }
        }
        return best === 'other' ? null : best;
      }
    }
    // Nothing engraved yet. The model can still answer when every rendered stave is the same
    // kind; when they are not, WHICH one is a question about geometry we do not have.
    return soleStaveKind(staveKindsFromStaves(this.builtModel?.tracks[0]?.staves ?? []));
  }

  /**
   * Screen coordinates -> the note under them, resolved to our stable id.
   *
   * NEAREST NOTEHEAD WITHIN A RADIUS, not "inside the notehead's box" (Z4e). alphaTab's
   * `getNoteAtPos` is an exact containment test against a glyph that is about nine pixels tall
   * at default zoom, so a press four pixels high of centre selected nothing and the sheet felt
   * like it was ignoring the player — while the piano roll, whose rule has always been
   * nearest-centre, felt fine. The same rule is used here: alphaTab answers first (it is exact
   * and it is free), and only when it does not does this fall back to the nearest notehead
   * centre inside `NOTE_HIT_RADIUS_PX`.
   *
   * The radius is in SCREEN pixels and is deliberately not scaled: it describes how accurately
   * a hand can point, which does not change when the engraving does.
   */
  hitTest(clientX: number, clientY: number): NoteHit | null {
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup) return null;
    /*
     * REVISION GATE (finding 8). The bounds and the index must describe the same engraving, or
     * every answer this method gives is about a page that is no longer on screen.
     *
     * Returning null here is NOT the same as the null this used to return. That one meant "there
     * is no note under the pointer", and `App.onNoteClick` correctly answered it with a seek —
     * which is why a click on a plainly visible notehead sometimes just moved the playhead. This
     * one means "ask again once the page has caught up", and the app distinguishes them: a
     * rejected hit does nothing at all. Doing nothing for one frame is invisible; seeking to the
     * wrong place because a stale `Note` object failed a lookup is the reported defect.
     */
    if (!this.boundsAreCurrent()) return null;

    // THE LAW'S CONVERSION (G1): alphaTab's bounds lookup is in the engraving's own pixels.
    const { x, y } = logicalPoint(this.host, clientX, clientY);
    // …and the rect below comes back in LOGICAL CLIENT coordinates — the space a `position: fixed`
    // popover is placed in under the face scale — so a caller can hand it straight to `style.left`.
    const hostRect = logicalRect(this.host);

    let beat = lookup.getBeatAtPos(x, y);
    let note = beat ? lookup.getNoteAtPos(beat, x, y) : null;
    /*
     * NEAREST CENTRE WINS EVEN WHEN ALPHATAB REPORTS AN "EXACT" HIT (P6).
     *
     * `BeatBounds.findNoteAtPos` returns the FIRST note in the beat's list whose notehead box
     * contains the point — list order, not distance. That is only unambiguous while the boxes are
     * disjoint, and in a chord they are not: a second is engraved with one notehead shifted
     * sideways so the two boxes overlap, and every stacked member's box is inflated by the
     * glyph's own bearings. So a press aimed at the upper member of a stack could be answered
     * with the lower one, deterministically — which on screen is "clicking this notehead selects
     * the other one", the reported failure.
     *
     * The nearest CENTRE is the rule the piano roll has always used and the one this class
     * already fell back to; it is simply asked first-among-equals now. alphaTab's answer is still
     * used when it is the closer of the two, and it is still the only answer available outside
     * the hit radius.
     */
    const near = this.nearestNoteHead(x, y);
    if (near && near.note !== note) {
      const exact = note ? this.noteHeadDistance(note, x, y) : Number.POSITIVE_INFINITY;
      if (near.dist < exact) {
        note = near.note;
        beat = near.note.beat;
      }
    }
    if (!beat) return null;
    const beatBounds = lookup.findBeat(beat);

    let rect = { x: 0, y: 0, w: 0, h: 0 };
    if (note && beatBounds?.notes) {
      const nb = beatBounds.notes.find((n) => n.note === note);
      if (nb) {
        rect = {
          x: nb.noteHeadBounds.x + hostRect.left,
          y: nb.noteHeadBounds.y + hostRect.top,
          w: nb.noteHeadBounds.w,
          h: nb.noteHeadBounds.h
        };
      }
    }
    if (rect.w === 0 && beatBounds) {
      rect = {
        x: beatBounds.visualBounds.x + hostRect.left,
        y: beatBounds.visualBounds.y + hostRect.top,
        w: beatBounds.visualBounds.w,
        h: beatBounds.visualBounds.h
      };
    }

    return {
      noteId: note ? (this.index?.noteToInfo.get(note)?.id ?? null) : null,
      note,
      beat,
      rect,
      staff: this.staffAtY(y),
      ...this.identityOf(beat, y)
    };
  }

  /**
   * SCREEN pixels within which a press counts as being ON a notehead. See `hitTest`.
   *
   * Twelve, matched to the roll's own tolerance rather than picked: a notehead is about nine
   * screen pixels tall at scale 1, so this is "within about one notehead of the centre", which
   * is what a player means by clicking on it.
   */
  private static readonly NOTE_HIT_RADIUS_PX = 12;

  /**
   * The closest notehead centre to a content point, inside the radius. Null past it.
   *
   * THE RADIUS IS DIVIDED BY THE FACE SCALE, AND THAT IS WHAT KEEPS IT CONSTANT (G1).
   *
   * It describes how accurately a hand can point, which does not change when the face is drawn
   * smaller — so the number that must stay fixed is the SCREEN one, and the search happens in
   * LOGICAL pixels. Twelve screen pixels is twelve logical ones at scale 1 and forty-four at
   * REAPER's 360x280 floor, where the whole face is painted at 0.27. Left unscaled it would have
   * shrunk with the picture: at that window a press three screen pixels from a notehead's centre
   * would have missed it, on a face where three screen pixels is the best anybody can do.
   */
  /** How far a point is from ONE note's notehead centre. Infinite when it has no geometry. */
  private noteHeadDistance(note: alphaTab.model.Note, x: number, y: number): number {
    const bounds = this.api.renderer.boundsLookup?.findBeat(note.beat);
    const nb = bounds?.notes?.find((n) => n.note === note);
    if (!nb) return Number.POSITIVE_INFINITY;
    const r = nb.noteHeadBounds;
    return Math.hypot(x - (r.x + r.w / 2), y - (r.y + r.h / 2));
  }

  private nearestNoteHead(x: number, y: number): { note: alphaTab.model.Note; dist: number } | null {
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup) return null;
    const limit = toLogical(TriView.NOTE_HIT_RADIUS_PX);
    let best: { note: alphaTab.model.Note; dist: number } | null = null;
    for (const system of lookup.staffSystems) {
      for (const masterBar of system.bars) {
        for (const barBounds of masterBar.bars ?? []) {
          for (const bb of barBounds.beats) {
            // Cheap reject on the beat's own column before looking at its noteheads: a system
            // holds hundreds of beats and only the ones near this x can win.
            if (bb.visualBounds.x - limit > x || bb.visualBounds.x + bb.visualBounds.w + limit < x) continue;
            for (const nb of bb.notes ?? []) {
              const r = nb.noteHeadBounds;
              const dx = x - (r.x + r.w / 2);
              const dy = y - (r.y + r.h / 2);
              const dist = Math.hypot(dx, dy);
              if (dist > limit) continue;
              if (!best || dist < best.dist) best = { note: nb.note, dist };
            }
          }
        }
      }
    }
    return best;
  }

  /** Part and bar identity for a beat. See `NoteHit.trackIndex` for why every hit carries it. */
  private identityOf(
    beat: alphaTab.model.Beat | null,
    contentY: number
  ): { trackIndex: number | null; live: boolean; barIndex: number | null } {
    const track = beat?.voice?.bar?.staff?.track?.index;
    const trackIndex = typeof track === 'number' ? track : this.trackAtY(contentY);
    const barIndex = beat?.voice?.bar?.masterBar?.index ?? null;
    return {
      trackIndex,
      live: trackIndex !== null && trackIndex === this.liveTrackIndex(),
      barIndex: typeof barIndex === 'number' ? barIndex : null
    };
  }

  /**
   * Which TRACK a content y is over, when no beat resolved.
   *
   * The empty-imported-staff case: there is no note and no beat under the pointer, and without
   * this the target would carry no part identity at all and the guard would pass by default.
   */
  private trackAtY(y: number): number | null {
    const lookup = this.api.renderer.boundsLookup;
    let bestTrack: number | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const system of lookup?.staffSystems ?? []) {
      for (const masterBar of system.bars) {
        for (const barBounds of masterBar.bars ?? []) {
          const track = barBounds.bar?.staff?.track?.index;
          if (typeof track !== 'number') continue;
          const v = barBounds.visualBounds;
          const dist = Math.abs(y - (v.y + v.h / 2));
          if (dist < bestDist) {
            bestDist = dist;
            bestTrack = track;
          }
        }
      }
      if (bestTrack !== null) return bestTrack;
    }
    return bestTrack;
  }

  /**
   * A right-click, resolved to everything the menu needs. Null when the sheet cannot answer.
   *
   * The one entry point for the context menu, so the sheet decides part, bar, staff, tick and
   * pitch once, together, off the same geometry — rather than the app asking four questions and
   * getting answers from four different frames.
   */
  targetAt(clientX: number, clientY: number): SheetTarget | null {
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup) return null;
    const { x, y } = logicalPoint(this.host, clientX, clientY);

    const hit = this.hitTest(clientX, clientY);
    const staff = hit?.staff ?? this.staffAtY(y);
    // WHICH PART, ANSWERED BY THE THING THE POINTER IS ACTUALLY ON. With a notehead under it,
    // that note's own track is the answer and there is nothing to argue about. WITHOUT one,
    // the beat alphaTab reports is not evidence: `getBeatAtPos` is generous vertically, so a
    // press on an empty imported staff comes back with a beat from the take's staff above it —
    // and the menu would then offer edits on a part that is paper. The y is the only honest
    // witness there, so `trackAtY` decides.
    const identity = hit?.noteId
      ? { trackIndex: hit.trackIndex, live: hit.live, barIndex: hit.barIndex }
      : { ...this.identityOf(null, y), barIndex: hit?.barIndex ?? null };
    // The BAR is answerable from geometry even where no beat is, which is what makes the bar
    // menu reachable on the empty half of a grand staff.
    const barIndex = identity.barIndex ?? this.barIndexAtX(x);
    const at = { x: toLogical(clientX), y: toLogical(clientY) };
    return {
      clientX: at.x,
      clientY: at.y,
      noteId: hit?.noteId ?? null,
      trackIndex: identity.trackIndex,
      live: identity.live,
      barIndex,
      staff,
      tick: this.contentXToTick(x),
      midi: staff === 'notation' ? this.midiAtStaffY(x, y) : null
    };
  }

  /**
   * VERIFICATION ONLY: where the live part's noteheads are, and one point of empty staff.
   *
   * In CLIENT coordinates, because what the probe does with them is dispatch a pointer event,
   * and every conversion it would otherwise do itself is a chance for the test to be measuring
   * its own arithmetic instead of the engraving. Read straight off `BeatBounds.notes`, which is
   * the same geometry `hitTest` uses.
   */
  editProbe(): {
    /**
     * Every live notehead, WITH THE STAVE IT IS ON and the beat it belongs to.
     *
     * `staff` because the list holds tab positions as well as noteheads — a fret digit has
     * `noteHeadBounds` too — and a probe that took "the seventh notehead" without looking could
     * be dispatching a PITCH drag at a tablature digit, where the same gesture means a string
     * change and the pitch deliberately does not move. That is a test measuring the wrong thing,
     * passing or failing for reasons that have nothing to do with what it claims.
     *
     * `beat` is what makes a CHORD addressable: the members of one stack share it, so a probe can
     * click every notehead of a stack and assert that each answers with its own id (P6).
     */
    noteHeads: Array<{
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      staff: StaveKind;
      beat: number;
    }>;
    /** A point on a NOTATION staff of the live part with no notehead anywhere near it. */
    emptyNotation: { x: number; y: number } | null;
    /**
     * A point on an IMPORTED part's staff, or null when the score has only the take.
     *
     * The case a note-id guard cannot reach: an EMPTY imported staff has no note under the
     * pointer, so "is this note id imported?" answers no. See `NoteHit.trackIndex`.
     */
    importedStaff: { x: number; y: number } | null;
  } {
    const lookup = this.api.renderer.boundsLookup;
    const hostRect = this.host.getBoundingClientRect();
    /*
     * ENGRAVED (logical) -> CLIENT (visual), and this is the one place in the file that goes that
     * way (G1). Everything alphaTab reports — `visualBounds`, `noteHeadBounds`, `LEFT_INSET_PX` —
     * is in the design's own pixels; `hostRect` and the client coordinates the caller is going to
     * dispatch a pointer event at are visual. Adding the two without scaling was correct only at
     * face scale 1, and silently aimed the harness at the wrong pixel everywhere else — which is
     * exactly the class of bug the law had to land before, so that the gesture and hit-test work
     * after it is measured against true coordinates.
     */
    const cx = (x: number): number => hostRect.left + toVisual(x);
    const cy = (y: number): number => hostRect.top + toVisual(y);
    const noteHeads: Array<{
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      staff: StaveKind;
      beat: number;
    }> = [];
    const staves: Array<{ x: number; y: number; w: number; h: number }> = [];
    let importedStaff: { x: number; y: number } | null = null;
    const live = this.liveTrackIndex();
    for (const system of lookup?.staffSystems ?? []) {
      for (const masterBar of system.bars) {
        const bars = masterBar.bars ?? [];
        const kinds = staveKindsFromBars(bars);
        for (let i = 0; i < bars.length; i++) {
          const bounds = bars[i];
          if (bounds.bar?.staff?.track?.index !== live) {
            const v = bounds.visualBounds;
            const x = Math.round(cx(v.x + v.w / 2));
            if (!importedStaff && x > cx(LEFT_INSET_PX) && x < window.innerWidth - 8) {
              importedStaff = { x, y: Math.round(cy(v.y + v.h / 2)) };
            }
            continue;
          }
          if (kinds[i] === 'notation') staves.push({ ...bounds.visualBounds });
          for (const bb of bounds.beats) {
            for (const nb of bb.notes ?? []) {
              const id = this.index?.noteToInfo.get(nb.note)?.id;
              if (!id) continue;
              const r = nb.noteHeadBounds;
              noteHeads.push({
                id,
                x: Math.round(cx(r.x + r.w / 2)),
                y: Math.round(cy(r.y + r.h / 2)),
                w: Math.round(toVisual(r.w)),
                h: Math.round(toVisual(r.h)),
                staff: kinds[i] ?? 'other',
                // The beat's own playback tick, which is stable across renders and shared by
                // every member of a chord.
                beat: bb.beat.absolutePlaybackStart
              });
            }
          }
        }
      }
    }
    // The first place on a notation staff that is at least 40px from every notehead AND on
    // screen. Deliberately measured rather than guessed: on a dense take there may not be one,
    // and a probe that clicked "somewhere empty" without checking would be testing nothing.
    // THE WIDEST GAP BETWEEN TWO NOTEHEADS, and its midpoint — which is the emptiest point on
    // the staff that is still INSIDE the music. Two ends had to be excluded for a reason each:
    // left of the first note is the clef/key/meter prefix, which is real page width before the
    // score's own tick 0; right of the last note is past the end of the take, where the
    // pipeline's past-end filter drops what is drawn there. A probe pointing at either would be
    // testing the guards rather than the feature.
    const xs = [...new Set(noteHeads.map((n) => n.x))].sort((a, b) => a - b);
    let emptyNotation: { x: number; y: number } | null = null;
    const staff = staves[0];
    // A BLANK SCORE HAS NO NOTEHEADS AT ALL, so there are no gaps to be widest — the whole staff
    // is one. Its own middle, clamped onto the screen, is the honest answer there.
    if (staff && xs.length < 2) {
      const left = Math.max(cx(staff.x), cx(LEFT_INSET_PX + 40));
      const right = Math.min(cx(staff.x + staff.w), window.innerWidth - 20);
      if (right > left) {
        emptyNotation = {
          x: Math.round((left + right) / 2),
          y: Math.round(cy(staff.y + staff.h / 2))
        };
      }
    }
    if (staff && xs.length >= 2) {
      const y = Math.round(cy(staff.y + staff.h / 2));
      let widest = 0;
      for (let i = 1; i < xs.length; i++) {
        const mid = Math.round((xs[i - 1] + xs[i]) / 2);
        const gap = xs[i] - xs[i - 1];
        if (gap <= widest) continue;
        if (mid < cx(LEFT_INSET_PX) || mid > window.innerWidth - 8) continue;
        widest = gap;
        emptyNotation = { x: mid, y };
      }
    }
    return { noteHeads, emptyNotation, importedStaff };
  }

  private barIndexAtX(x: number): number | null {
    const lookup = this.api.renderer.boundsLookup;
    for (const system of lookup?.staffSystems ?? []) {
      for (const masterBar of system.bars) {
        const b = masterBar.visualBounds;
        if (x >= b.x && x <= b.x + b.w) return masterBar.index;
      }
    }
    return null;
  }

  /**
   * THE STAFF LADDER: a height over a notation staff, as a sounding MIDI pitch in the key.
   *
   * Read off the engraved bar's own `visualBounds` — five lines, so `h / 4` is one staff space
   * and half of that is one staff POSITION — and off that bar's own CLEF, which is the only
   * thing that says what the top line is called. A grand staff has two different answers at two
   * different heights and this asks the stave under the pointer, not the first one.
   *
   * The key signature is applied, because a click on the F line in D major means F#: the player
   * is pointing at a place on the staff, and what that place sounds like is what the key says.
   * An accidental they want on top of that is a note they can then drag.
   */
  private midiAtStaffY(x: number, y: number): number | null {
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup) return null;
    let best: { bounds: alphaTab.rendering.Bounds; clef: alphaTab.model.Clef } | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const system of lookup.staffSystems) {
      for (const masterBar of system.bars) {
        const bars = masterBar.bars ?? [];
        const kinds = staveKindsFromBars(bars);
        for (let i = 0; i < bars.length; i++) {
          if (kinds[i] !== 'notation') continue;
          const b = bars[i];
          const v = b.visualBounds;
          if (x < v.x - 8 || x > v.x + v.w + 8) continue;
          const dist = Math.abs(y - (v.y + v.h / 2));
          if (dist < bestDist) {
            bestDist = dist;
            best = { bounds: v, clef: b.bar?.clef ?? alphaTab.model.Clef.G2 };
          }
        }
      }
    }
    if (!best || best.bounds.h <= 0) return null;
    // One staff POSITION is half a space, and four spaces span the five printed lines.
    const positionPx = best.bounds.h / 8;
    if (!(positionPx > 0)) return null;
    const stepsBelowTopLine = Math.round((y - best.bounds.y) / positionPx);
    const topLine = TOP_LINE_DIATONIC[best.clef] ?? 10;
    return diatonicToMidi(topLine - stepsBelowTopLine, this.keyFifths);
  }

  /**
   * A press on a NOTE NAME, answered by the note the label was drawn for (P6).
   *
   * The label carries its own note id (`WantedName`), so this is a lookup rather than a guess.
   * `hitTestByX` — which finds the nearest beat anchor and takes `beat.notes[0]` — is still there
   * for a press on empty paper and for a label with no id behind it, but on a chord it answered
   * every one of the stacked names with the bottom member, and that is what made a stacked note
   * look unselectable.
   *
   * Null when the label names a note this render no longer has, which is a stale DOM node about
   * to be replaced; the caller falls back to the by-X answer.
   */
  hitTestByName(label: HTMLElement): NoteHit | null {
    const id = label.dataset.noteId;
    const note = id ? this.index?.idToNote.get(id) : undefined;
    const lookup = this.api.renderer.boundsLookup;
    if (!note || !lookup) return null;
    const beatBounds = lookup.findBeat(note.beat);
    if (!beatBounds) return null;
    const hostRect = logicalRect(this.host);
    const nb = beatBounds.notes?.find((n) => n.note === note);
    const box = nb ? nb.noteHeadBounds : beatBounds.visualBounds;
    return {
      noteId: id ?? null,
      note,
      beat: note.beat,
      rect: { x: box.x + hostRect.left, y: box.y + hostRect.top, w: box.w, h: box.h },
      // A press on the names row is not a press on either staff: the row sits between them or
      // above them, so there is no staff kind to report and no drag to start from it.
      staff: null,
      ...this.identityOf(note.beat, beatBounds.visualBounds.y + beatBounds.visualBounds.h / 2)
    };
  }

  /** Names-row click: we only have an x, so resolve by nearest beat anchor. */
  hitTestByX(clientX: number): NoteHit | null {
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup) return null;
    const x = logicalX(this.host, clientX);
    // LOGICAL CLIENT coordinates for the rect below, as in `hitTest` — see `NoteHit.rect`.
    const hostRect = logicalRect(this.host);

    let best: alphaTab.rendering.BeatBounds | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const system of lookup.staffSystems) {
      for (const masterBar of system.bars) {
        for (const barBounds of masterBar.bars ?? []) {
          for (const bb of barBounds.beats) {
            const d = Math.abs(bb.onNotesX - x);
            if (d < bestDist) {
              bestDist = d;
              best = bb;
            }
          }
        }
      }
    }
    if (!best || bestDist > 40) return null;
    const note = best.beat.notes[0] ?? null;
    return {
      noteId: note ? (this.index?.noteToInfo.get(note)?.id ?? null) : null,
      note,
      beat: best.beat,
      rect: {
        x: best.visualBounds.x + hostRect.left,
        y: best.visualBounds.y + hostRect.top,
        w: best.visualBounds.w,
        h: best.visualBounds.h
      },
      // A names-row click has no meaningful y on either staff.
      staff: null,
      ...this.identityOf(best.beat, best.visualBounds.y + best.visualBounds.h / 2)
    };
  }

  /**
   * One pointer, three outcomes: select, drag, or seek.
   *
   * The selection still happens on PRESS, not on release — that is what makes clicking a
   * note feel instant, and a drag is a superset of a click rather than an alternative to
   * it. What has gone is the popover: a click now only highlights, here and on the piano
   * roll, and changing the note is the drag.
   */
  private onPointerDown = (e: PointerEvent): void => {
    // THE BUTTON, BEFORE ANYTHING ELSE (Z4ii). This used to select and seek without ever looking
    // at which button was pressed, so a right-click on a note selected it and a right-click on
    // empty space SEEKED THE TRANSPORT — the playhead jumped as the context menu opened. The
    // menu is raised from `contextmenu` below; nothing about a secondary press belongs here.
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // A press on a printed part name is a press on ITS control, not on the music behind it.
    // Without this the press falls through to the seek below and the transport jumps to bar 1
    // underneath the rename field that is opening. See `syncPartLabelHits`.
    if (target.classList.contains('part-label-hit')) return;
    // THE PAGE UNDER THE POINTER IS NOT THE CURRENT PAGE. Do nothing — not even the seek this
    // method falls through to, which is the whole point of gating here rather than in `hitTest`.
    // See `boundsAreCurrent`.
    if (!this.boundsAreCurrent()) return;
    const hit = target.classList.contains('note-name')
      ? // The label's OWN note first (P6); the nearest beat anchor only when it has none.
        (this.hitTestByName(target) ?? this.hitTestByX(e.clientX))
      : this.hitTest(e.clientX, e.clientY);

    if (hit) {
      this.selectionStaffKind = hit.staff;
      this.opts.onNoteClick?.(hit);
      // Only a real notehead can be dragged. A beat hit with no note resolved (a rest, or
      // a click in the beat's whitespace) selects and stops there.
      if (hit.note && hit.noteId && hit.staff) {
        this.beginDrag(hit, e);
        if (this.drag) {
          this.attachDragListeners();
          e.preventDefault();
        }
      }
      return;
    }
    // Empty space: treat as a seek.
    this.selectionStaffKind = null;
    const beatAtX = this.hitTestByX(e.clientX);
    if (beatAtX) this.opts.onSeekRequest?.(beatAtX.beat.absolutePlaybackStart);
  };

  /**
   * RIGHT-CLICK IS EDIT, and it is its own road.
   *
   * On `contextmenu` rather than on a `pointerdown` with `button === 2`, because that is the one
   * event every way of asking for a menu produces: a right press, a two-finger tap, Ctrl-click
   * on macOS, and the keyboard's own context key. `preventDefault` is unconditional — the
   * browser's menu offers Reload and Inspect inside a plugin window, which is at best noise and
   * at worst the take.
   */
  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    // Same gate as the primary press: a menu raised against stale bounds would name one note and
    // edit another. See `boundsAreCurrent`.
    if (!this.boundsAreCurrent()) return;
    const target = this.targetAt(e.clientX, e.clientY);
    if (!target) return;
    this.opts.onSheetContextMenu?.(target);
  };

  /**
   * The names row and the overlay live inside the scrolled stack, so they move by
   * themselves. What DOES need telling is anything drawn outside this element against the
   * same ruler — the piano roll — and that is one report per animation frame, not one per
   * scroll event, because a trackpad flick fires dozens of them per frame.
   */
  private onScroll = (): void => {
    // Synchronously, not in the frame below: the letters are pinned to the viewport, so they
    // have to move WITH the scroll or they lag a frame behind it and visibly swim.
    this.placeStringLetters();
    // WAS THIS OUR OWN SCROLL? A number rather than a flag, because the browser can coalesce
    // several scroll events into one and a bare boolean would swallow a real gesture that
    // happened to land in the same frame. Within half a pixel of where we put it, it is ours.
    const target = this.programmaticScrollTo;
    this.programmaticScrollTo = null;
    const mine = target !== null && Math.abs(this.scroller.scrollLeft - target) < 0.5;
    if (!mine) this.opts.onSheetScroll?.(this.contentXToTick(this.scroller.scrollLeft + LEFT_INSET_PX));
    if (this.viewportFrame) return;
    this.viewportFrame = requestAnimationFrame(() => {
      this.viewportFrame = 0;
      this.emitViewport();
    });
  };

  destroy(): void {
    if (this.viewportFrame) cancelAnimationFrame(this.viewportFrame);
    if (this.cursorFrame) cancelAnimationFrame(this.cursorFrame);
    if (this.facadeFrame) cancelAnimationFrame(this.facadeFrame);
    this.viewportFrame = 0;
    this.cursorFrame = 0;
    this.facadeFrame = 0;
    this.deferredRender = null;
    this.detachDragListeners();
    this.drag = null;
    this.scroller.removeEventListener('pointerdown', this.onPointerDown);
    this.scroller.removeEventListener('contextmenu', this.onContextMenu);
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.scroller.removeEventListener('wheel', this.onSheetWheel);
    this.scroller.removeEventListener('gesturestart', this.onGestureStart);
    this.scroller.removeEventListener('gesturechange', this.onGestureChange);
    this.scroller.removeEventListener('gestureend', this.onGestureEnd);
    this.scroller.removeEventListener('pointermove', this.onHoverMove);
    this.scroller.removeEventListener('pointerleave', this.onHoverLeave);
    this.api.destroy();
  }
}

/**
 * Every distinct beat of one master bar, across all its rendered staves, in render order.
 *
 * `BoundsLookup` reports one `BarBounds` per rendered STAVE. When one alphaTab `Staff` shows
 * notation and tablature the two staves carry the SAME `Beat` objects, so a naive concatenation
 * would visit each beat twice; when the score is a grand staff they are different Staffs with
 * different beats, so reading only the first stave misses everything the other one plays.
 * Identity dedupe is the one rule that is right for both, and for grand-staff-plus-tab, where
 * both things are true at once.
 */
function dedupeBeats(
  bars: ReadonlyArray<alphaTab.rendering.BarBounds>
): alphaTab.rendering.BeatBounds[] {
  const seen = new Set<alphaTab.model.Beat>();
  const out: alphaTab.rendering.BeatBounds[] = [];
  for (const bar of bars) {
    for (const bb of bar.beats ?? []) {
      if (seen.has(bb.beat)) continue;
      seen.add(bb.beat);
      out.push(bb);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The tick axis
// ---------------------------------------------------------------------------

/** Straight line through two points, evaluated (and happily extrapolated) at `at`. */
function lerp(a0: number, b0: number, a1: number, b1: number, at: number): number {
  if (a1 === a0) return b0;
  return b0 + ((b1 - b0) * (at - a0)) / (a1 - a0);
}

/**
 * The index of the last entry whose value is <= `v`, in an ascending array.
 * Returns 0 for anything at or below the start, so the caller always has a pair to
 * interpolate across.
 */
function bracket(values: number[], v: number): number {
  let lo = 0;
  let hi = values.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * tick -> x, extrapolating past both ends from the nearest pair of beats.
 *
 * Extrapolating rather than returning null is a deliberate choice: a rectangle whose tail
 * runs a fraction past the last beat, or a pickup that starts before the first one, must
 * land SOMEWHERE sensible. The alternative is a note that vanishes at the edge of the take.
 */
function axisXAt(axis: TickAxis, tick: number): number {
  const { ticks, xs } = axis;
  const n = ticks.length;
  if (n === 1) return xs[0];
  if (tick <= ticks[0]) {
    const slope = outerTicksPerPx(axis);
    return slope > 0
      ? xs[0] + (tick - ticks[0]) / slope
      : lerp(ticks[0], xs[0], ticks[1], xs[1], tick);
  }
  if (tick >= ticks[n - 1]) return lerp(ticks[n - 2], xs[n - 2], ticks[n - 1], xs[n - 1], tick);
  const i = bracket(ticks, tick);
  return lerp(ticks[i], xs[i], ticks[i + 1], xs[i + 1], tick);
}

/**
 * Ticks per pixel across the WHOLE engraving — the slope used before the first beat.
 *
 * The nearest PAIR is the right slope inside the engraving and the wrong one outside it at the
 * start. What sits left of the first beat is the clef, key signature and meter: a fixed lump of
 * page that stands for no time at all, and typically wider than the first two beats put
 * together. Extrapolating across it on the local slope of a fast opening figure said that lump
 * was worth about a second, which threw every other note out by up to 159 px (measured); the
 * take's own average says it is worth roughly what a pane-width of roll says it is worth, which
 * is exactly what the panes have to agree on.
 *
 * 0 when there is nothing to measure, which is the caller's signal to fall back.
 */
function outerTicksPerPx(axis: TickAxis): number {
  const n = axis.ticks.length;
  if (n < 2) return 0;
  const dx = axis.xs[n - 1] - axis.xs[0];
  const dt = axis.ticks[n - 1] - axis.ticks[0];
  return dx > 0 && dt > 0 ? dt / dx : 0;
}

/** x -> tick, the exact mirror of `axisXAt` so the two round-trip. */
function axisTickAt(axis: TickAxis, x: number): number {
  const { ticks, xs } = axis;
  const n = xs.length;
  if (n === 1) return ticks[0];
  if (x <= xs[0]) {
    // The axis's own average, not the first pair's — see `outerTicksPerPx`. Kept the exact
    // mirror of `axisXAt`'s branch so the two still round-trip.
    const slope = outerTicksPerPx(axis);
    return slope > 0 ? ticks[0] + (x - xs[0]) * slope : lerp(xs[0], ticks[0], xs[1], ticks[1], x);
  }
  if (x >= xs[n - 1]) return lerp(xs[n - 2], ticks[n - 2], xs[n - 1], ticks[n - 1], x);
  const i = bracket(xs, x);
  return lerp(xs[i], ticks[i], xs[i + 1], ticks[i + 1], x);
}

// ---------------------------------------------------------------------------
// Staff positions -> semitones
// ---------------------------------------------------------------------------

/** Semitones above the tonic for each degree of a major scale. */
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

/** Semitone offset of ladder index `d` from the tonic. Negative indices work. */
function ladderOffset(d: number): number {
  const octave = Math.floor(d / 7);
  return MAJOR_STEPS[d - octave * 7] + octave * 12;
}

/**
 * Move a pitch by whole STAFF POSITIONS in a key, and say how many semitones that was.
 *
 * A staff position is a line-or-space step, which on paper is one letter name — so how far
 * it moves in semitones depends on where you are in the scale. Dragging E up one position
 * in C major gives F (one semitone); dragging F up one gives G (two). This is the
 * difference between a drag that writes music and a drag that writes chromatic mush.
 *
 * A note that is NOT in the key LANDS ON THE KEY, it does not carry its accidental along.
 * A C# in C major dragged one position down becomes B, not B# — because on paper the note
 * moved from the C position to the B position, and the key signature is what decides what
 * a B is. Carrying the sharp across would spell absurdities and is not what any notation
 * editor does. The cost is that a chromatic note loses its accidental the first time it is
 * dragged; Alt/Option is the escape hatch, and it moves in literal semitones.
 *
 * `fifths` names a MAJOR tonic, and that is right even in a minor key: a key signature
 * describes a set of pitches, and the relative minor's set is the same set.
 */
function diatonicShift(midi: number, steps: number, keyFifths: number): number {
  if (steps === 0) return 0;
  // The tonic of a major key is `fifths` fifths up from C.
  const tonic = (((keyFifths * 7) % 12) + 12) % 12;
  const rel = midi - tonic;
  const octave = Math.floor(rel / 12);
  const within = rel - octave * 12;
  // The scale degree at or below this pitch — the staff position the note is written on.
  let degree = 0;
  while (degree < 6 && MAJOR_STEPS[degree + 1] <= within) degree++;
  const from = octave * 7 + degree;
  return tonic + ladderOffset(from + steps) - midi;
}

/**
 * The overlay's colours, read from the stylesheet so the ghost matches the app.
 *
 * Read rather than hard-coded because `ui/styles.css` belongs to the integrator and the
 * palette lives there; the fallbacks exist only so a ghost is never invisible if a token
 * is renamed.
 */
function readOverlayColors(): { accent: string; danger: string; paper: string } {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string): string => {
    const v = cs.getPropertyValue(name).trim();
    return v.length > 0 ? v : fallback;
  };
  return {
    // The purple family (G20): #8b5cf6 is the app's accent, and it is the fallback here so a
    // renamed token cannot bring the old orange back through the back door.
    accent: pick('--accent', '#8b5cf6'),
    danger: pick('--danger', '#e05252'),
    paper: pick('--paper', '#f8f6f0')
  };
}

// ---------------------------------------------------------------------------
// Selection rectangles
// ---------------------------------------------------------------------------

/** One highlight rectangle, inflated by `pad` and given its weight inline. See drawSelection. */
/*
 * ---------------------------------------------------------------------------------------------
 * THE SELECTION TREATMENT, in numbers.
 *
 * Two weights per glyph — a soft halo and a firm ring — expressed twice: as ENGRAVING UNITS
 * (what they should be on a full-size window, where one unit is one screen pixel) and as a
 * SCREEN-PIXEL FLOOR (what they may never fall below, whatever the face scale does). See
 * `drawSelection` for the arithmetic and for why the floor is the entire fix.
 *
 * The floors are chosen against a hostile host rather than a comfortable one. At REAPER's
 * 360x280 the face scale is ~0.273, so the old 2.5-unit ring landed at 0.68 screen px: a
 * sub-pixel line, antialiased into a grey suggestion. 2 screen px is the smallest weight that
 * survives that treatment as a definite line on both the light and the dark papers, and 5 px of
 * halo behind it is what separates "outlined" from "glowing" at a glance.
 * ---------------------------------------------------------------------------------------------
 */
/** The firm ring's weight on a 1:1 window. */
const SEL_RING_UNITS = 2.5;
/** ...and the screen pixels it may never be thinner than. */
const SEL_RING_MIN_SCREEN_PX = 2;
/** The halo's weight on a 1:1 window. */
const SEL_HALO_UNITS = 6;
/** ...and its screen-pixel floor. */
const SEL_HALO_MIN_SCREEN_PX = 5;
/**
 * The halo's opacity. RAISED from 0.30.
 *
 * 0.3 was chosen when the halo was 6 real pixels wide. It is a different mark at 5 px on a small
 * face — thinner, so it needs more of the accent in it to register as the same emphasis.
 */
const SEL_HALO_OPACITY = 0.45;
/** The gap between the notehead's box and the firm ring, on a 1:1 window. */
const SEL_RING_PAD_UNITS = 4;
/** The hover ring: a lighter answer to the same question, under the same floor. See `drawHover`. */
const HOVER_RING_UNITS = 1.75;
const HOVER_RING_MIN_SCREEN_PX = 1.4;

function selectionRect(
  r: { x: number; y: number; w: number; h: number },
  pad: number,
  style: { fill?: string; strokeWidth: string; opacity?: string },
  className = 'sel-rect'
): SVGRectElement {
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', String(r.x - pad));
  rect.setAttribute('y', String(r.y - pad));
  rect.setAttribute('width', String(r.w + pad * 2));
  rect.setAttribute('height', String(r.h + pad * 2));
  rect.setAttribute('rx', String(Math.min(4, pad)));
  rect.setAttribute('class', className);
  if (style.fill) rect.style.fill = style.fill;
  rect.style.strokeWidth = style.strokeWidth;
  if (style.opacity) rect.style.opacity = style.opacity;
  return rect;
}

// ---------------------------------------------------------------------------
// Octave-folded tab positions
// ---------------------------------------------------------------------------

/**
 * `IRNote.tabOctaveShift`, keyed by note id.
 *
 * It only exists on the IR — Team C's `AlphaTabNoteData` does not carry it — so the
 * renderer's own input cannot answer this and the IR has to be walked once per load.
 */
function collectTabOctaveShifts(score: RiffScore): Map<string, number> {
  const out = new Map<string, number>();
  for (const bar of score.ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        for (const note of beat.notes) {
          if (note.tabOctaveShift) out.set(note.id, note.tabOctaveShift);
        }
      }
    }
  }
  return out;
}

/**
 * The marker text for a fold, in the vocabulary a player already has.
 *
 * `8va` / `15ma` for a position printed above the sounding pitch, `8vb` / `15mb` for below.
 * Anything else (which the pipeline does not emit — it only tries ±12 and ±24) falls back
 * to the raw interval rather than lying about the size.
 */
function octaveMarkText(shift: number): string {
  switch (shift) {
    case 12:
      return '8va';
    case -12:
      return '8vb';
    case 24:
      return '15ma';
    case -24:
      return '15mb';
    default:
      return `${shift > 0 ? '+' : ''}${shift}`;
  }
}
