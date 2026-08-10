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
  type ViewSettings
} from './atSettings';
import { TIMELINE_GUTTER_PX } from './pianoroll';
import { buildAlphaTabScore, soundingMidi, type ScoreIndex } from '../score/fromPipeline';
import { midiToName, accidentalsForKey, type Accidentals } from '../score/notes';
import { assignFret } from '../score/tuning';
import { t, TIPS } from '../ui/tips';
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
  kind: 'pitch' | 'string';
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
  onNoteClick?: (hit: NoteHit) => void;
  onSeekRequest?: (tick: number) => void;
  onRenderComplete?: (info: RenderInfo) => void;
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
   */
  onViewportChange?: (v: TriViewViewport) => void;
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
 * Name-row metrics, in px. These are the numbers the CSS produces (`.note-name` is
 * 10.5px/1 with 1px padding), kept here because the placement maths needs them and a
 * silent disagreement between the two is exactly how the row ended up on top of the tab.
 */
const NAME_HEIGHT = 13;
/** Chord names stack upward from the anchor by this much per extra note. */
const NAME_STACK_STEP = 12;
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

/** alphaTab display scale limits. 1.0 is the default; below 0.4 the tab digits stop being readable. */
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3.0;

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

/** Everything one in-flight note drag needs to remember. See the drag section on the class. */
interface DragState {
  noteId: string;
  note: alphaTab.model.Note;
  staff: StaffKind;
  startClientY: number;
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
  readonly overlay: SVGSVGElement;

  private index: ScoreIndex | null = null;
  private currentScore: RiffScore | null = null;
  /** The alphaTab object graph on screen — what an edit mutates. See `model`. */
  private builtModel: alphaTab.model.Score | null = null;
  private accidentals: Accidentals = 'sharps';
  private labels: NameLabel[] = [];
  private tabMarks: NameLabel[] = [];
  /** noteId -> semitones the TAB position was folded by. Empty for anything in range. */
  private tabShifts = new Map<string, number>();
  private opts: TriViewOptions;
  private renderStartedAt = 0;
  private playheadLine: SVGLineElement;
  private selectionGroup: SVGGElement;
  private ghostGroup: SVGGElement;
  private lastRenderInfo: RenderInfo | null = null;
  private namesPlacement: NamesPlacement;
  private showNames: boolean;
  /** Which note ids are highlighted. Kept so a re-render can redraw them. */
  private selectedIds: string[] = [];
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
  private scrollAnchorTick: number | null = null;
  private scrollAnchorAtStart = false;
  /** True while a left-inset correction is being rendered — the hard stop on any loop. */
  private insetTuneInFlight = false;
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

  constructor(opts: TriViewOptions) {
    this.opts = opts;
    this.namesPlacement = opts.namesPlacement ?? 'between';
    this.showNames = opts.showNames ?? true;

    opts.container.classList.add('triview');
    opts.container.innerHTML = `
      <div class="triview-scroll">
        <div class="triview-stack">
          <div class="at-host"></div>
          <div class="names-row" aria-hidden="true"></div>
          <div class="tabmarks-row" aria-hidden="true"></div>
          <svg class="triview-overlay" xmlns="http://www.w3.org/2000/svg">
            <g class="selection"></g>
            <line class="playhead" x1="0" y1="0" x2="0" y2="0" />
            <g class="drag-ghost"></g>
          </svg>
        </div>
      </div>`;

    this.scroller = opts.container.querySelector('.triview-scroll')!;
    this.stack = opts.container.querySelector('.triview-stack')!;
    this.host = opts.container.querySelector('.at-host')!;
    this.namesRow = opts.container.querySelector('.names-row')!;
    this.tabMarksRow = opts.container.querySelector('.tabmarks-row')!;
    this.overlay = opts.container.querySelector('.triview-overlay')!;
    this.playheadLine = this.overlay.querySelector('.playhead')!;
    this.selectionGroup = this.overlay.querySelector('.selection')!;
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

    this.scroller.addEventListener('pointerdown', this.onPointerDown);
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    // Hover only: the cursor has to say "this note can be moved up and down" before
    // anybody tries it. The drag itself listens on window, so it survives the pointer
    // leaving the element mid-gesture.
    this.scroller.addEventListener('pointermove', this.onHoverMove, { passive: true });
  }

  // -------------------------------------------------------------------------
  // Score loading and re-rendering
  // -------------------------------------------------------------------------

  /** Full load: build the alphaTab object graph from the pipeline's data and render it. */
  load(score: RiffScore): void {
    this.currentScore = score;
    this.keyFifths = score.ir.key.fifths ?? 0;
    this.accidentals = accidentalsForKey(score.ir.key.fifths);
    this.cancelDrag();
    this.tabShifts = collectTabOctaveShifts(score);
    const built = buildAlphaTabScore(score.data, this.api.settings);
    this.index = built.index;
    this.builtModel = built.score;
    this.renderStartedAt = performance.now();
    this.api.renderScore(built.score, [0]);
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
    this.renderStartedAt = performance.now();
    this.api.render({ reuseViewport: true });
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

  /** Only the 'between' row lives inside the staff<->tab gap; the others sit outside it. */
  private needsGap(): boolean {
    return this.showNames && this.namesPlacement === 'between';
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
    applyStaffTabGap(this.api.settings, wanted);
    if (this.api.settings.display.notationStaffPaddingTop === before) return false;
    this.api.updateSettings();
    this.renderStartedAt = performance.now();
    this.api.render({ reuseViewport: true });
    return true;
  }

  // -------------------------------------------------------------------------
  // Overlays derived from boundsLookup
  // -------------------------------------------------------------------------

  private onPostRender(): void {
    const info = this.rebuildOverlays();
    this.lastRenderInfo = {
      durationMs: performance.now() - this.renderStartedAt,
      beatCount: info.beatCount,
      hasStaffTabSplit: info.hasStaffTabSplit
    };
    this.opts.onRenderComplete?.(this.lastRenderInfo);
    // If the left inset needs correcting, a second render is already on its way; let the
    // scroll anchor ride on THAT one, so the tick we restore is measured against the
    // coordinates the user will actually see.
    if (this.tuneLeftInset()) return;
    this.restoreScrollAnchor();
    // Last, and unconditional: the scroll anchor may have just moved us, and anything
    // drawing against this ruler has to hear about the finished render even when the three
    // numbers happen to be unchanged.
    this.emitViewport(true);
  }

  private rebuildOverlays(): { beatCount: number; hasStaffTabSplit: boolean } {
    // Every x in the axis came from the bounds we are about to re-read, so it is stale by
    // definition. Thrown away rather than rebuilt: most renders are never asked for an x.
    this.axis = null;

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
    const wanted: Array<{ x: number; y: number; text: string; uncertain: boolean }> = [];
    const wantedMarks: Array<{ x: number; y: number; text: string }> = [];

    for (const system of lookup.staffSystems) {
      for (const masterBar of system.bars) {
        const barBoundsList = masterBar.bars ?? [];
        // With one staff showing both notation and tab, alphaTab produces one BarBounds
        // per rendered stave. Two entries => we know where the gap between them is.
        const split = barBoundsList.length >= 2;
        if (split) hasStaffTabSplit = true;
        const namesY = this.namesYFor(barBoundsList, system);

        // Octave-folded tab positions get a marker on the TAB stave's own glyph, which is
        // why this reads barBoundsList[1] rather than the notation stave used below.
        if (split && this.tabShifts.size > 0) {
          for (const tabBeat of barBoundsList[1].beats) {
            for (const nb of tabBeat.notes ?? []) {
              const id = this.index.noteToInfo.get(nb.note)?.id;
              const shift = id ? this.tabShifts.get(id) : undefined;
              if (!shift) continue;
              const r = nb.noteHeadBounds;
              wantedMarks.push({
                x: r.x + r.w + 1,
                y: r.y - TAB_MARK_RISE,
                text: octaveMarkText(shift)
              });
            }
          }
        }

        // Beats are duplicated per stave; the first stave's list is enough for anchoring
        // because onNotesX is identical across staves (one layout pass — that is the point).
        const beatSource = barBoundsList[0]?.beats ?? [];
        for (const beatBounds of beatSource) {
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
            .map((n) => ({ midi: soundingMidi(this.index!, n), uncertain: false }))
            // Lowest first, and stacked UPWARD from the anchor. Two reasons: it matches
            // how the pitches sit on the staff, and it keeps a tall chord growing into the
            // empty gap rather than down through the top line of the tab.
            .sort((a, b) => a.midi - b.midi)
            .map((n) => ({ text: midiToName(n.midi, this.accidentals), uncertain: n.uncertain }));

          names.forEach((n, i) => {
            wanted.push({
              x: beatBounds.onNotesX,
              y: namesY - i * NAME_STACK_STEP,
              text: n.text,
              uncertain: n.uncertain
            });
          });
        }
      }
    }

    this.syncLabels(wanted);
    this.syncTabMarks(wantedMarks);
    // The highlight rectangles were drawn against the OLD geometry. Redraw them from the
    // new bounds, or a zoom (or any edit) would leave the selection behind.
    this.drawSelection();
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
      return Math.max(0, system.visualBounds.y - 16);
    }
    if (this.namesPlacement === 'below') {
      return system.realBounds.y + system.realBounds.h - 14;
    }
    if (barBoundsList.length >= 2) {
      const band = this.nameBand(barBoundsList);
      if (!band) return Math.max(0, system.visualBounds.y - 16);
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
    return Math.max(0, system.visualBounds.y - 16);
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
    if (barBoundsList.length < 2) return null;
    const staff = barBoundsList[0].visualBounds;
    const tab = barBoundsList[1].visualBounds;
    return {
      top: staff.y + staff.h + STAFF_CLEARANCE,
      bottom: tab.y - TAB_DIGIT_RISE
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
  } | null {
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup) return null;

    const systems = lookup.staffSystems.length;
    const contentLeftInset = Math.round(this.measureLeftInk() ?? 0);

    let band: { top: number; bottom: number } | null = null;
    let staffBottom = 0;
    let tabTop = 0;
    for (const system of lookup.staffSystems) {
      for (const masterBar of system.bars) {
        const bars = masterBar.bars ?? [];
        const b = this.nameBand(bars);
        if (!b) continue;
        band = b;
        staffBottom = bars[0].visualBounds.y + bars[0].visualBounds.h;
        tabTop = bars[1].visualBounds.y;
        break;
      }
      if (band) break;
    }
    const hostRect = this.host.getBoundingClientRect();
    const markTexts = this.tabMarks.map((m) => m.el.textContent ?? '');
    let marksOnTab = 0;
    for (const m of this.tabMarks) {
      const r = m.el.getBoundingClientRect();
      // "On the tab" = below the notation staff. tabTop is the top LINE of the tab and the
      // marker deliberately rises above it, so compare against the band instead.
      if (band && r.height > 0 && r.top - hostRect.top >= band.top) marksOnTab++;
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
        contentLeftInset
      };
    }

    let labelTop = Number.POSITIVE_INFINITY;
    let labelBottom = Number.NEGATIVE_INFINITY;
    const labelRects: DOMRect[] = [];
    for (const label of this.labels) {
      const r = label.el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      labelRects.push(r);
      labelTop = Math.min(labelTop, r.top - hostRect.top);
      labelBottom = Math.max(labelBottom, r.bottom - hostRect.top);
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
      contentLeftInset
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
   * The inverse: which tick is under this x. O(log n), by bisecting the same axis.
   *
   * Outside the engraved range it extrapolates rather than clamping, so it round-trips
   * with `tickToContentX` and a click in the empty margin still means something.
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
      // The first stave is enough: onNotesX is identical across staves because the staff
      // and the tab come out of one layout pass. Same reason the names row reads bars[0].
      for (const beatBounds of masterBar.bars?.[0]?.beats ?? []) {
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

  /** Scroll the sheet, clamped to what actually exists. */
  setScrollLeft(px: number): void {
    const max = Math.max(0, this.scroller.scrollWidth - this.scroller.clientWidth);
    const next = Math.min(max, Math.max(0, px));
    if (Math.abs(next - this.scroller.scrollLeft) < 0.5) return;
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
  setZoom(scale: number): void {
    if (!Number.isFinite(scale)) return;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
    if (Math.abs(next - this.api.settings.display.scale) < 0.001) {
      // Already there. Still write the exact value, so `getZoom()` reads back the number
      // that was asked for rather than something 0.0004 away from it — "Reset view" is
      // checked by comparing against 1.
      this.api.settings.display.scale = next;
      return;
    }

    const left = this.scroller.scrollLeft;
    this.scrollAnchorAtStart = left <= 0;
    this.scrollAnchorTick = this.scrollAnchorAtStart ? null : this.contentXToTick(left);

    this.api.settings.display.scale = next;
    // The overhang scales with the engraving, so the padding has to be recomputed for the
    // new scale or the reserved column would come out wider or narrower than the roll's.
    setLeftPadding(this.api.settings, LEFT_INSET_PX + leftInkOverhangPerScale * next);
    this.api.updateSettings();
    this.renderStartedAt = performance.now();
    this.api.render({ reuseViewport: true });
  }

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
    this.scrollAnchorAtStart = true;
    this.setZoom(1);
    this.setScrollLeft(0);
  }

  private restoreScrollAnchor(): void {
    if (this.scrollAnchorAtStart) {
      this.scrollAnchorAtStart = false;
      this.scrollAnchorTick = null;
      this.setScrollLeft(0);
      return;
    }
    const tick = this.scrollAnchorTick;
    if (tick === null) return;
    this.scrollAnchorTick = null;
    const x = this.tickToContentX(tick);
    if (x !== null) this.setScrollLeft(x);
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
    if (this.insetTuneInFlight) {
      this.insetTuneInFlight = false;
      return false;
    }
    const scale = this.api.settings.display.scale;
    const ink = this.measureLeftInk();
    if (ink === null || scale <= 0) return false;

    const pad = this.api.settings.display.padding[0] ?? 0;
    leftInkOverhangPerScale = (pad - ink) / scale;
    const wanted = LEFT_INSET_PX + leftInkOverhangPerScale * scale;
    if (Math.abs(wanted - pad) < 0.5) return false;

    setLeftPadding(this.api.settings, wanted);
    this.api.updateSettings();
    this.insetTuneInFlight = true;
    this.renderStartedAt = performance.now();
    this.api.render({ reuseViewport: true });
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
      const left = svg.getBoundingClientRect().left - stackLeft + box.x;
      if (left < min) min = left;
    }
    return Number.isFinite(min) ? min : null;
  }

  /** Reuse label elements across renders; creating 400 divs per keystroke is not free. */
  private syncLabels(wanted: Array<{ x: number; y: number; text: string; uncertain: boolean }>): void {
    while (this.labels.length < wanted.length) {
      const el = document.createElement('span');
      el.className = 'note-name';
      this.namesRow.appendChild(el);
      this.labels.push({ el, x: 0 });
    }
    while (this.labels.length > wanted.length) {
      const extra = this.labels.pop()!;
      extra.el.remove();
    }
    for (let i = 0; i < wanted.length; i++) {
      const w = wanted[i];
      const l = this.labels[i];
      if (l.el.textContent !== w.text) l.el.textContent = w.text;
      l.el.style.transform = `translate(${w.x}px, ${w.y}px) translateX(-50%)`;
      l.el.classList.toggle('uncertain', w.uncertain);
      l.x = w.x;
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
      const el = document.createElement('span');
      el.className = 'tab-mark';
      // Set once: the tooltip layer moves `title` to `data-riff-tip` on first hover, and
      // re-setting it afterwards resurrects the native OS tooltip alongside ours.
      const tip = t(TIPS.tabOctaveShift);
      if (tip) el.setAttribute('title', tip);
      this.tabMarksRow.appendChild(el);
      this.tabMarks.push({ el, x: 0 });
    }
    while (this.tabMarks.length > wanted.length) {
      this.tabMarks.pop()!.el.remove();
    }
    for (let i = 0; i < wanted.length; i++) {
      const w = wanted[i];
      const m = this.tabMarks[i];
      if (m.el.textContent !== w.text) m.el.textContent = w.text;
      m.el.style.transform = `translate(${w.x}px, ${w.y}px)`;
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
  }

  /** Which notes are highlighted right now. Lets the piano roll round-trip a selection. */
  get selection(): string[] {
    return [...this.selectedIds];
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
    if (!lookup || !this.index) return;

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
          selectionRect(r, 7, { fill: 'none', strokeWidth: '6', opacity: '0.3' })
        );
        this.selectionGroup.appendChild(selectionRect(r, 4, { strokeWidth: '2.5' }));
      }
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
  } {
    const d = this.drag;
    return {
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
    // The note has a glyph on each staff. The ghost has to follow the one the pointer is
    // actually on, so pick the nearest by y rather than the first in the list.
    const heads = this.noteGlyphRects(hit.note);
    if (heads.length === 0) return;
    const pointerY = e.clientY - this.host.getBoundingClientRect().top;
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

  private updateDrag(clientY: number, altKey: boolean): void {
    const d = this.drag;
    if (!d || !this.index) return;
    const dy = clientY - d.startClientY;
    if (!d.moved && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    d.chromatic = altKey;

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
    const y = d.head.y - d.steps * d.stepPx;
    const pad = 3;

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
    if (!d.moved || !d.valid || d.steps === 0) return;

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
    this.updateDrag(e.clientY, e.altKey);
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
    });
  };

  // -------------------------------------------------------------------------
  // Hit testing
  // -------------------------------------------------------------------------

  /**
   * Which staff a content y is on.
   *
   * Nearest staff centre rather than a boundary line, because a note with ledger lines
   * sits well outside its own staff box and must still belong to it.
   */
  private staffAtY(y: number): StaffKind | null {
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup) return null;
    for (const system of lookup.staffSystems) {
      for (const masterBar of system.bars) {
        const bars = masterBar.bars ?? [];
        if (bars.length < 2) continue;
        const a = bars[0].visualBounds;
        const b = bars[1].visualBounds;
        const toNotation = Math.abs(y - (a.y + a.h / 2));
        const toTab = Math.abs(y - (b.y + b.h / 2));
        return toNotation <= toTab ? 'notation' : 'tab';
      }
    }
    // One stave only: whichever one it is showing.
    const staff = this.builtModel?.tracks[0]?.staves[0];
    if (!staff) return null;
    if (staff.showStandardNotation && !staff.showTablature) return 'notation';
    if (staff.showTablature && !staff.showStandardNotation) return 'tab';
    return null;
  }

  /** Screen coordinates -> the note under them, resolved to our stable id. */
  hitTest(clientX: number, clientY: number): NoteHit | null {
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup) return null;

    const hostRect = this.host.getBoundingClientRect();
    const x = clientX - hostRect.left;
    const y = clientY - hostRect.top;

    const beat = lookup.getBeatAtPos(x, y);
    if (!beat) return null;

    const note = lookup.getNoteAtPos(beat, x, y);
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
      staff: this.staffAtY(y)
    };
  }

  /** Names-row click: we only have an x, so resolve by nearest beat anchor. */
  hitTestByX(clientX: number): NoteHit | null {
    const lookup = this.api.renderer.boundsLookup;
    if (!lookup) return null;
    const hostRect = this.host.getBoundingClientRect();
    const x = clientX - hostRect.left;

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
      staff: null
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
    const target = e.target as HTMLElement;
    const hit = target.classList.contains('note-name')
      ? this.hitTestByX(e.clientX)
      : this.hitTest(e.clientX, e.clientY);

    if (hit) {
      this.selectionStaffKind = hit.staff;
      this.opts.onNoteClick?.(hit);
      // Only a real notehead can be dragged. A beat hit with no note resolved (a rest, or
      // a click in the beat's whitespace) selects and stops there.
      if (hit.note && hit.noteId && hit.staff && e.button === 0) {
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
   * The names row and the overlay live inside the scrolled stack, so they move by
   * themselves. What DOES need telling is anything drawn outside this element against the
   * same ruler — the piano roll — and that is one report per animation frame, not one per
   * scroll event, because a trackpad flick fires dozens of them per frame.
   */
  private onScroll = (): void => {
    if (this.viewportFrame) return;
    this.viewportFrame = requestAnimationFrame(() => {
      this.viewportFrame = 0;
      this.emitViewport();
    });
  };

  destroy(): void {
    if (this.viewportFrame) cancelAnimationFrame(this.viewportFrame);
    if (this.cursorFrame) cancelAnimationFrame(this.cursorFrame);
    this.viewportFrame = 0;
    this.cursorFrame = 0;
    this.detachDragListeners();
    this.drag = null;
    this.scroller.removeEventListener('pointerdown', this.onPointerDown);
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.scroller.removeEventListener('pointermove', this.onHoverMove);
    this.api.destroy();
  }
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
  if (tick <= ticks[0]) return lerp(ticks[0], xs[0], ticks[1], xs[1], tick);
  if (tick >= ticks[n - 1]) return lerp(ticks[n - 2], xs[n - 2], ticks[n - 1], xs[n - 1], tick);
  const i = bracket(ticks, tick);
  return lerp(ticks[i], xs[i], ticks[i + 1], xs[i + 1], tick);
}

/** x -> tick, the exact mirror of `axisXAt` so the two round-trip. */
function axisTickAt(axis: TickAxis, x: number): number {
  const { ticks, xs } = axis;
  const n = xs.length;
  if (n === 1) return ticks[0];
  if (x <= xs[0]) return lerp(xs[0], ticks[0], xs[1], ticks[1], x);
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
    accent: pick('--accent', '#e8734a'),
    danger: pick('--danger', '#e05252'),
    paper: pick('--paper', '#f8f6f0')
  };
}

// ---------------------------------------------------------------------------
// Selection rectangles
// ---------------------------------------------------------------------------

/** One highlight rectangle, inflated by `pad` and given its weight inline. See drawSelection. */
function selectionRect(
  r: { x: number; y: number; w: number; h: number },
  pad: number,
  style: { fill?: string; strokeWidth: string; opacity?: string }
): SVGRectElement {
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', String(r.x - pad));
  rect.setAttribute('y', String(r.y - pad));
  rect.setAttribute('width', String(r.w + pad * 2));
  rect.setAttribute('height', String(r.h + pad * 2));
  rect.setAttribute('rx', String(Math.min(4, pad)));
  rect.setAttribute('class', 'sel-rect');
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
