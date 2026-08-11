/**
 * The app shell.
 *
 * Two screens: the opening drop zone, and the main tri-view. One data flow:
 *
 *   audio / MIDI / captured take
 *     -> decode + auto-trim (audio only)
 *     -> transcribe (audio only; MIDI already carries notes)
 *     -> buildRiffScore(...)                       [Team C's pipeline, via src/pipeline]
 *     -> RiffScore
 *     -> TriView.load()  +  Transport.setScoreNotes()
 *
 * The two rebuild paths are deliberately different costs, and the difference is the whole
 * reason dragging the bar-1 marker feels instant:
 *   - rebuildNotation()  re-runs the pipeline over the notes we already have. Milliseconds.
 *   - runTranscription() listens to the audio again. Seconds. Only on new input.
 */

import { el, replace, formatTime, debounce, type Store } from './dom';
import { installTooltipLayer, t, TIPS } from './tips';
import {
  getBridge,
  importDroppedFileNative,
  isJuceHost,
  type AudioFileRef,
  type CaptureContext,
  type CaptureResult,
  type DroppedInputResult,
  type EngineListResult,
  type EngineStatus,
  type ExportPayload,
  type HostInfo,
  type NativeBridge,
  type TranscribeOptions,
  type TranscribeResult
} from '../bridge';
import { buildRiffScore, scoreOriginSec, type InputNote, type RiffScore } from '@pipeline';
import { TriView, MIN_ZOOM, MAX_ZOOM, type NoteHit } from '../view/triview';
import { alignOriginSec, coupledSheetScale } from '../view/timeAxis';
import {
  PianoRoll,
  rollEditNoteIds,
  setTransientReserve,
  timeWindowAnchors,
  type RollVerticalView,
  TIMELINE_GUTTER_PX,
  type PianoRollLiveModel,
  type TimeAnchor,
  type RollEdit,
  type SheetMap
} from '../view/pianoroll';
import { applyRollEditToNotes } from '../edit/rollPerformance';
import {
  addCut,
  applyCutsToPeaks,
  audioToEditedSec,
  cutTotalSec,
  detectTrimCuts,
  editedDurationSec,
  editedToAudioSec,
  mapNotesThroughCuts,
  mapTimesThroughCuts,
  MIN_CUT_SEC,
  nextKeptSec,
  normalizeCuts,
  type CutSpan
} from '../edit/cuts';
import {
  applyAutoEdits,
  planAutoEdits,
  revertAutoEdit,
  type AppliedAutoEdit,
  type AttentionMark
} from '../edit/autoEdits';
import { Transport } from '../audio/transport';
import { WaveformStrip } from './waveform';
import { Tuner } from './tuner';
import { selfTest as pitchSelfTest } from '../audio/pitch';
import { detectOnsets, type OnsetResult } from '../audio/onsets';
import { soundingMidi } from '../score/fromPipeline';
import { accidentalsForKey, midiToName } from '../score/notes';
import { TUNING_PRESETS, customTuning, parseTuning, tuningById, tuningLabel } from '../score/tuning';
import { transcribeRiffsheet } from '../audio/riffsheetEngine';
import { RIFFSHEET_ENGINE_ID } from '../bridge/types';
import { SettingsPanel, chipGroup, soundPicker } from './settings';
import { findTrim, computePeaks } from '../audio/trim';
import { isMidiFile, parseMidi } from '../import/midiFile';
import { isScoreFile, parseScoreFile, reinterpretWrittenOctave } from '../import/scoreFile';
import {
  SCORE_IMAGE_ACCEPT,
  SCORE_IMAGE_SCOPE,
  decodeRecognizedScore,
  isScoreImageFile
} from '../import/scoreImage';
import { buildPrintDocument, renderScorePdf } from '../export/pdf';
import { ExportBar } from './exportBar';
import { FINGER_BASS_SAMPLES, SampledBass, sampleStatus } from '../audio/sampler';
import { schedulePad } from '../audio/pad';
import { dropTunedRiff, straightRiff, tripletRiff } from '../score/fixtures';
import {
  applyDocumentSettings,
  createStores,
  FINGERING_STYLES,
  forgetRecent,
  loadRecent,
  sameSettingValue,
  saveSettings,
  pushRecent,
  type AppSettings,
  type RecentFile,
  type RuntimeState,
  type SourceAudio
} from '../app/state';
import {
  SESSION_VERSION,
  SessionStore,
  base64ToBytes,
  bytesToBase64,
  decodeSource,
  encodeSource,
  hasRestorableTake,
  isRiffsheetFile,
  audioEntryName,
  audioMimeForName,
  documentScoreText,
  encodeWavPcm16,
  originalPlaybackAfterLoad,
  portableAudioRef,
  readRiffsheetDocument,
  stagingNameForAudio,
  RIFFSHEET_DOCUMENT_VERSION,
  writeRiffsheetDocument,
  type EmbeddedAudio,
  type PersistedAudio,
  type PersistedSession,
  type RiffsheetDocument
} from '../app/persist';
// The snap layer's pure half. `App.performanceFeed()` is the only caller — see the tap point.
import {
  mergeEditedOntoRaw,
  rollSnapUnitSec,
  snapPerformanceToGrid,
  type RollPerformanceNote
} from '../app/snap';
import {
  ChangePitchAction,
  ChangeStringAction,
  DeleteNoteAction,
  CompositeAction,
  UndoStack,
  createEditAction,
  type ActionResult,
  type EditAction,
  type EditContext,
  type EditSpec
} from '../edit/actions';

/**
 * How many min/max pairs the waveform picture is reduced to.
 *
 * 2000 was fine while the strip always showed the WHOLE take. It does not any more: linked to the
 * sheet it shows a slice, and the buckets thin out with it. Measured at the 1180px design target,
 * 2000 buckets only reach native screen resolution while at least 57% of the take is on screen —
 * so a three-minute take zoomed to two bars got one peak every 25 pixels and drew a bar chart
 * rather than a waveform. 20000 moves that threshold to 5.7%.
 *
 * The cost is 160 KB of Float32 and one extra pass over samples that are already being read.
 */
const PEAK_BUCKETS = 20000;
/** alphaTab's internal ticks per quarter note (MidiUtils.QuarterTime). */
const ALPHATAB_QUARTER_TICKS = 960;

/**
 * ONE empty cut list, shared (F16).
 *
 * `editedSource()` memoises on the cut list BY REFERENCE, and a take with no cuts asks for that
 * list on every draw. Returning a fresh `[]` each time would miss the memo every time and
 * re-derive nothing, forever; returning this returns the same object and the memo holds.
 */
const NO_CUTS: CutSpan[] = Object.freeze([]) as unknown as CutSpan[];

/** Leading/trailing silence worth offering to trim, in seconds. Never acted on automatically. */
const TRIM_CHIP_THRESHOLD_SEC = 1.5;

/**
 * The undo and redo arrows, drawn rather than typed.
 *
 * `↶`/`↷` were the obvious first answer and they are wrong here: at 16px in the shell's UI
 * font they come out as a hairline a couple of pixels tall, sit off-centre in the button box,
 * and are missing outright from some fallback fonts — a control that is sometimes an empty
 * square. These are two paths at a 2.6px stroke in `currentColor`, so they inherit the chip
 * colour, the hover colour and the disabled colour with no extra styling, and they are the
 * same visual weight as the glyphs on the play and stop buttons beside them.
 *
 * `stroke-linecap="round"` on both: the arrowhead and the tail meet at the same radius the
 * chips are rounded to, which is what stops the pair reading as clip art next to them.
 */
const UNDO_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M4 9h11a5 5 0 0 1 0 10h-4"/><polyline points="8 5 4 9 8 13"/></svg>';
const REDO_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M20 9H9a5 5 0 0 0 0 10h4"/><polyline points="16 5 20 9 16 13"/></svg>';
/**
 * THE R MARK — F17/F18, modelled on the brand block in the owner's other app, BASAMAK.
 *
 * What was copied from it, deliberately and by measurement (Source/ui/PluginEditor.cpp):
 *
 *  - the mark is a VECTOR PATH, not a font glyph and not an image, so it is the same shape at
 *    every scale the header's zoom ladder puts it through;
 *  - it has NO container: no background plate, no border, no border-radius. BASAMAK's B is
 *    simply the first glyph of its wordmark sitting on the window fill, and a badge around
 *    ours would read as a different family of app;
 *  - the geometry is the same idiom — flat-sided, cap-height only, and CHAMFERED rather than
 *    curved, which is what BASAMAK's `L604 600` corner cuts are. 100 units of chamfer on a
 *    700-unit cap height, matched here;
 *  - the stem weight is BASAMAK's: its B runs x=65 to x=198, i.e. 133 of 700. Ours is 140.
 *
 * WHAT IS DELIBERATELY NOT COPIED: the colour. BASAMAK's wordmark is one flat off-white
 * (#F3F3F5) with its gold reserved for the version line; Riffsheet's accent is the orange in
 * `--accent`, and the mark takes it (`currentColor`, set on `.brand-mark`) while the wordmark
 * beside it stays in the off-white `--text` that is this app's equivalent of theirs.
 *
 * Three elements rather than one path with holes: the stem, the bowl and the leg overlap, and
 * a single path would have to cancel those overlaps under `evenodd` instead of unioning them.
 * Separate siblings union by construction, which is a thing that cannot be got subtly wrong.
 */
const RIFFSHEET_MARK_SVG =
  '<svg viewBox="0 0 640 700" width="17" height="18" fill="currentColor" ' +
  'aria-hidden="true" focusable="false">' +
  // The stem.
  '<rect x="0" y="0" width="140" height="700"/>' +
  // The bowl, as a ring: outer contour then counter, `evenodd` cutting the second out of the
  // first. Both corners on the right are chamfered at 100 units, as BASAMAK's are.
  '<path fill-rule="evenodd" d="M140 0H480L580 100V240L480 340H140Z' +
  'M240 100H445L480 135V205L445 240H240Z"/>' +
  // The leg. A slanted bar of the same weight as the stem, springing from under the bowl.
  '<path d="M300 340H470L620 700H455Z"/>' +
  '</svg>';

/**
 * Where "check updates" goes, and it is the RELEASES INDEX rather than `/latest`.
 *
 * BASAMAK made the same choice and wrote down why: somebody checking for an update wants to
 * see what changed and what they skipped, and `/latest` shows one release with no history.
 */
const RELEASES_URL = 'https://github.com/Kanebos9/riffsheet/releases';

/**
 * The version to show when the shell cannot be asked.
 *
 * A build-time constant, kept in step with `webcore/package.json` and `shell/CMakeLists.txt`
 * (`project(Riffsheet VERSION …)`). The shell's own number wins whenever `getAppVersion` exists
 * — that is the one stamped into the bundle a user actually installed — and this is what a
 * plain browser tab, and any shell too old for the call, shows instead of nothing.
 */
const BUILD_VERSION = '0.1.0';

const OPEN_FILE_ACCEPT = [
  'audio/*',
  '.mid,.midi',
  '.musicxml,.mxl,.xml',
  '.gp,.gp3,.gp4,.gp5,.gpx,.gp7',
  '.riffsheet',
  SCORE_IMAGE_ACCEPT
].join(',');

export function mountApp(root: HTMLElement): void {
  installTooltipLayer();
  void new App(root).start();
}

/**
 * Boot a second, independent app into `root` and resolve when it has settled.
 *
 * Only the harness uses this: it is how "destroy the editor and come back" is tested
 * without a DAW. A fresh App reads the persisted blob through the same bridge the real one
 * writes it to, so the round trip under test is the real one. See `__RIFFSHEET_PERSIST__`.
 */
export async function bootSecondApp(
  root: HTMLElement,
  options: { autoResume?: boolean } = {}
): Promise<{ probe: () => unknown; root: HTMLElement }> {
  const app = new App(root);
  // `autoResume` skips the "Resume previous work / Start fresh" prompt. The persistence probe
  // passes it because what that one is testing is the blob round trip; the resume probe does
  // NOT, because the prompt is the thing it is testing.
  await app.start({ secondary: true, autoResume: options.autoResume === true });
  return { probe: () => app.sessionProbe(), root };
}

/**
 * The fret counts real instruments have, for the "Highest fret" picker.
 *
 * A list rather than a free number box because this is a fact about somebody's instrument and
 * there are only so many answers: a short-scale bass stops at 20, a Strat at 21 or 22, a
 * shredder's neck at 24. The stored value is carried in whatever it is, on the same reasoning
 * as the time-signature picker in `ui/app.ts` — a `<select>` that cannot show its own value
 * silently snaps to the first option and reads as if the app had thrown the setting away.
 */
const FRET_COUNTS: readonly number[] = [12, 15, 17, 19, 20, 21, 22, 24];

function fretCountOptions(current: number): number[] {
  const list = [...FRET_COUNTS];
  if (Number.isFinite(current) && current > 0 && !list.includes(current)) list.push(current);
  return list.sort((a, b) => a - b);
}

/** What each fingering style is called on screen. */
const FINGERING_LABELS: Record<AppSettings["fingering"], string> = {
  "low-positions": "Low positions",
  "minimize-movement": "Least movement",
  "open-strings": "Open strings first",
  "around-fret": "Around fret N"
};

/**
 * How long the aligned window is held after a rebuild, in ms.
 *
 * Long enough to cover the re-engrave and the two or three viewport events it fires, short
 * enough that the player's next deliberate scroll is never the one that gets swallowed. It is a
 * quiet period, not a lock: nothing happens when it expires, and the window simply starts
 * following the sheet again on the next scroll.
 */
const ALIGN_HOLD_MS = 1500;

/** How much the sheet may move during a rebuild before it counts as the player scrolling. */
const ALIGN_HOLD_SLOP_PX = 8;

/**
 * The ArrayBuffer behind some bytes, without copying them when that can be helped.
 *
 * `AudioFileRef.bytes` is an ArrayBuffer, and reaching for `.buffer` is only correct when the view
 * covers the whole of it. A Uint8Array that is a WINDOW onto a larger buffer — which is what a zip
 * entry can be — would otherwise hand the decoder the entire file and call it audio. The copy is
 * the fallback, not the rule: the common case is exact and free.
 */
function audioArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);
}

class App {
  private root: HTMLElement;
  private bridge: NativeBridge;
  private ctx: AudioContext;
  private settings: Store<AppSettings>;
  private runtime: Store<RuntimeState>;
  private transport: Transport;
  private undoStack = new UndoStack();
  /** ALIGN: the stretch of recording the roll and the strip are showing. Null = whole take. */
  private alignedWindow: { fromSec: number; toSec: number } | null = null;
  /** While `performance.now()` is under this, the window is a memory. See §syncViewports. */
  private alignHoldUntil = 0;
  /** The ruler those two numbers came out as. Held with them, and pushed to both panes. */
  private alignedAnchors: TimeAnchor[] | null = null;
  /** Where the sheet was when the hold opened, so a real scroll can end it early. */
  private alignHoldScrollLeft = 0;

  private triview: TriView | null = null;
  private waveform: WaveformStrip | null = null;
  private pianoRoll: PianoRoll | null = null;
  private settingsPanel: SettingsPanel | null = null;
  private unsubCapture: (() => void) | null = null;
  private captureStopPending = false;
  private unsubHost: (() => void) | null = null;
  private transportUnsub: (() => void) | null = null;
  /** Printed number of the bar currently used as the loop range. */
  private loopBarNumber: number | null = null;
  private toastId = 0;
  private transcribeStartedAt = 0;
  private exportBar: ExportBar;

  // --- session persistence (see app/persist.ts) ------------------------------
  private session: SessionStore;
  /**
   * The user's edits, written down, mirroring `undoStack` exactly.
   *
   * The stack itself cannot be serialised — its mementos hold live alphaTab objects — but
   * every action IS its spec plus a stable note id, so the log replays. Mirrored rather
   * than derived because the stack does not publish its cursor; every mutation of one is
   * next to a mutation of the other in this file, and nothing else may touch `undoStack`.
   */
  private editLog: EditSpec[] = [];
  private editCursor = -1;
  /** How the take can be found again. Written on ingest, read on save. */
  private audioRef: PersistedAudio | null = null;
  /** Exact original playback for symbolic imports; used by the As played MIDI export. */
  private sourceMidi: Uint8Array | null = null;
  /**
   * The imported file's OWN bytes, kept so a `.riffsheet` can contain the recording (#34).
   *
   * Only ever set from bytes the app was actually handed — a browser drop, a picker, a document
   * that already had audio inside it. A native open gives a path and a token instead, and this
   * stays null there; `embeddedAudio()` falls back to encoding the decoded samples, so the
   * document is still self-contained, just re-encoded rather than copied.
   *
   * Held for the life of the take. That is a real cost — a 40 MB import is 40 MB resident — and
   * it is the price of being able to write the file at any moment without going back to disk for
   * something the user may since have moved.
   */
  private audioBytes: Uint8Array | null = null;
  private audioMime = '';
  /**
   * The shell has this document's recording in the page but not in its PLAYER, and owes it one
   * hand-off before the Original can sound. Set by `restoreEmbeddedAudio`, paid by
   * `ensureOriginalPlayable()` on the first press of play. See both for why it waits.
   */
  private nativeAudioPending = false;
  /** The hand-off in flight, so two presses of play cannot ship the recording twice. */
  private nativeAudioMinting: Promise<void> | null = null;
  /** True while rehydrating, so the restore cannot save over the blob it is reading. */
  private restoring = false;
  private restored = false;

  /**
   * The decoded mono samples of the original recording, and their rate.
   *
   * Held rather than thrown away after the waveform is drawn, because the tuner needs the real
   * audio: it measures the pitch of a stretch the player picks out and plays that stretch back.
   * Null for a MIDI import, and null when a restored take could not be reopened.
   */
  private pcm: Float32Array | null = null;
  private pcmRate = 0;
  private onsetResult: OnsetResult | null = null;
  private onsetGeneration = 0;
  /**
   * How the original recording was reopened after the editor was rebuilt, or why it was not.
   *
   * A single word that turns "it forgot my audio" into a diagnosis. Read by `sessionProbe()`
   * and by `__RIFFSHEET_AUDIO__`.
   */
  private originalRestoredBy = 'not-tried';
  private tuner: Tuner | null = null;
  /**
   * How far the piano roll is scrolled and zoomed vertically.
   *
   * An App field rather than a setting, because it is about THIS take, not a preference — and it
   * has to live out here because `renderMain()` destroys and rebuilds the roll on every change.
   * Without it the roll forgets where you scrolled every time anything else on screen updates.
   */
  private rollView: RollVerticalView | null = null;
  /** What the listener is doing and what it costs. Null until asked, or in a browser. */
  private engine: EngineStatus | null = null;
  private engineTimer = 0;
  /**
   * Every engine this build can drive, for the picker on the main menu.
   *
   * Null until the shell has answered, and null forever on a shell that only ever had one
   * engine — in which case the picker simply is not drawn, rather than being drawn with one
   * chip in it and implying a choice nobody has.
   */
  private engineList: EngineListResult | null = null;
  /**
   * The engine one refused take is being handed to, for that take only.
   *
   * Set when Riffsheet's own engine bows out (a chord, or nothing it could hear), read once by
   * `transcribeOptions()`, and cleared in `runTranscription`'s `finally`. It holds the id the
   * SHELL named rather than one derived here, so the engine the toast promised is the engine
   * that actually listens.
   */
  private fallbackEngineId: string | null = null;
  /** The stretch of the RECORDING the player is asking about, if any. */
  private selection: { fromSec: number; toSec: number } | null = null;
  /** A waveform selection opens the audio-check dock; note highlighting alone does not. */
  private tunerSelection: { fromSec: number; toSec: number } | null = null;
  /** Main-menu subview. Visiting it never mutates the current work. */
  private blankSetupOpen = false;

  // =========================================================================
  // Two layers of settings, and only one of them is the player's
  // =========================================================================
  /**
   * The player's own preferences, as they stand on disk.
   *
   * The `settings` store is the EFFECTIVE settings — what the open document is drawn and built
   * with — and the two are the same object right up until a .riffsheet carrying settings of its
   * own is opened. Keeping this copy is what lets a document be honoured on screen without the
   * act of opening it rewriting what the player will get tomorrow.
   */
  private globalSettings: AppSettings;
  /**
   * The keys the OPEN DOCUMENT is currently answering for.
   *
   * Written by `applyDocumentSettingsToStore`, and each one retires the instant the player
   * changes that key themselves — at which point it is their value, in the store and on disk.
   */
  private documentOverrides = new Set<keyof AppSettings>();
  /** Set only while a document's settings are being pushed into the store. See `persistSettings`. */
  private applyingDocumentSettings = false;

  /**
   * What the brand block prints. `BUILD_VERSION` until the shell answers with its own.
   *
   * Feature-detected rather than required: `getAppVersion` is a recent bridge call, a plain
   * browser tab has no shell at all, and a version line that says nothing is worse than one
   * that says the number this build was compiled as.
   */
  private appVersion = BUILD_VERSION;

  constructor(root: HTMLElement) {
    this.root = root;
    this.bridge = getBridge();
    this.ctx = new AudioContext();
    const stores = createStores();
    this.settings = stores.settings;
    this.runtime = stores.runtime;
    this.globalSettings = { ...this.settings.get() };
    // PERSISTENCE IS OWNED HERE, not by the store — see `createStores()` and `persistSettings`.
    // First subscriber on purpose: what goes on disk is decided before anything else reacts.
    this.settings.subscribe((next, previous) => this.persistSettings(next, previous));
    this.session = new SessionStore(this.bridge);
    // Every settings change is a meaningful change: the sound, the pane toggles, the grid,
    // the tuning. One subscription covers the lot, including anything added later.
    this.settings.subscribe(() => this.scheduleSave());
    this.transport = new Transport(this.bridge, this.ctx);
    this.exportBar = new ExportBar({
      bridge: this.bridge,
      settings: this.settings,
      getScore: () => this.runtime.get().score,
      getSourceMidi: () => this.sourceMidi,
      getBaseName: () => this.baseName(),
      isPlugin: () => this.runtime.get().host?.isPlugin ?? false,
      toast: (kind, title, message) => this.toast(kind, title, message),
      // The .riffsheet document joins the other three in the Export menu. Only this file can
      // serialise it, so it is handed over rather than moved.
      saveDocument: () => void this.saveRiffsheetDocument(),
      // …and the recording itself, which a document has carried since v2 with no way to get it
      // back out. Two calls rather than one: the menu asks the cheap question every time it
      // opens, and only builds the file when the item is actually picked.
      hasAudio: () => this.hasExportableAudio(),
      getAudio: () => this.audioExportPayload()
    });
  }

  /**
   * Show a document with the settings it was saved with, and write NOTHING to the player's.
   *
   * The reported bug in one line: `settings.set(mergeStoredSettings(document.settings))`. That
   * call did three wrong things at once — it replaced the player's preferences with the file's,
   * it persisted the replacement, and it re-ran the one-time v10 grid migration over a choice
   * the player had made since, so "I set Quantize to 1/4" survived exactly until the next old
   * document was opened. `applyDocumentSettings()` in app/state.ts answers the migration half;
   * this answers the persistence half by remembering which keys are on loan.
   */
  private applyDocumentSettingsToStore(stored: Partial<AppSettings>): void {
    const { effective, overridden } = applyDocumentSettings(this.globalSettings, stored);
    this.documentOverrides = new Set(overridden);
    this.applyingDocumentSettings = true;
    try {
      this.settings.set(effective);
    } finally {
      this.applyingDocumentSettings = false;
    }
  }

  /**
   * The brand block: mark, wordmark, version, and the way to check for a newer one.
   *
   * MODELLED ON BASAMAK, the owner's other app, measured off its editor rather than guessed
   * (Source/ui/PluginEditor.cpp §paintContent, §setupComponents, §layoutContent):
   *
   *   BASAMAK                                    here
   *   ------------------------------------------ --------------------------------------------
   *   wordmark as vector art, left-aligned,       the R is vector art (`RIFFSHEET_MARK_SVG`);
   *   x=8 in a 40px toolbar, 150x22               the wordmark is text, because we cannot copy
   *                                               somebody's letterforms — caps, 700, tracked
   *   version + caption stacked to its RIGHT,     same stack, same order, same side
   *   both centred on one axis, 1px apart
   *   version 11.5px bold, brand gold             version 10px bold, `--accent`
   *   caption 8.5px bold, DIMMER GOLD — the       caption 8.5px bold, accent at 72% — same
   *   dimming is a darker colour, never alpha     trick, expressed as a colour-mix so it works
   *                                               against either surface
   *   ONE invisible click target covering the     one <button> wrapping the whole block; the
   *   whole stack; the labels do not intercept    children are pointer-events: none
   *   opens <repo>/releases — the INDEX, not      same, `RELEASES_URL`
   *   /latest, so you can see what you skipped
   *
   * THE HARD CONSTRAINT, stated by the owner: THE TOP BAR MUST NOT GET TALLER. The tallest
   * thing in this header is an ordinary button — 12.5px text at line-height 1.45 inside 5px of
   * padding and a border, about 30px. This block is built to come in under that: 18px of mark
   * against a 19.5px two-line stack (10 + 1 + 8.5, all at line-height 1), inside 2px of
   * padding. `.brand-block` in styles.css states the same rule as a `max-height` so that a
   * later edit to any of those numbers fails visibly rather than silently pushing the sheet
   * down by a row.
   */
  private buildBrandBlock(): HTMLElement {
    return el(
      'button',
      {
        type: 'button',
        class: 'brand-block',
        'data-role': 'brand',
        'aria-label': `Riffsheet ${this.appVersion} — check for updates`,
        title: t(TIPS.brand),
        onClick: () => this.openReleasesPage()
      },
      el('span', { class: 'brand-mark', 'aria-hidden': 'true', html: RIFFSHEET_MARK_SVG }),
      el('span', { class: 'brand-wordmark', text: 'RIFFSHEET' }),
      el(
        'span',
        { class: 'brand-meta' },
        el('span', { class: 'brand-version', 'data-role': 'brand-version', text: `v${this.appVersion}` }),
        el('span', { class: 'brand-check', 'data-role': 'brand-check', text: 'Click to check updates' })
      )
    );
  }

  /**
   * Ask the shell for the version it was actually built as, and print it if it answers.
   *
   * Not awaited and never fatal: the block is already on screen with `BUILD_VERSION` in it, and
   * this replaces the text in place rather than re-rendering the header — a header rebuild
   * would throw away the export bar's popover anchor for the sake of six characters.
   */
  private adoptAppVersion(): void {
    this.bridge
      .getAppVersion?.()
      .then((version) => {
        const clean = (version ?? '').trim();
        if (!clean || clean === this.appVersion) return;
        this.appVersion = clean;
        const box = this.root.querySelector<HTMLElement>('[data-role="brand-version"]');
        if (box) box.textContent = `v${clean}`;
        const block = this.root.querySelector<HTMLElement>('[data-role="brand"]');
        block?.setAttribute('aria-label', `Riffsheet ${clean} — check for updates`);
      })
      .catch(() => undefined);
  }

  /**
   * Open a URL outside the app.
   *
   * Both halves are feature-detected. `openExternal` is the shell's, and it is the only one
   * that works in a plugin — a JUCE WebView has no browser to be a tab of, so `window.open`
   * there does nothing at all and does it silently. `window.open` is the fallback for a plain
   * browser tab, and also for a shell whose `openExternal` answers false.
   */
  private openExternalUrl(url: string): void {
    const pending = this.bridge.openExternal?.(url);
    if (!pending) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    void pending
      .then((ok) => {
        if (!ok) window.open(url, '_blank', 'noopener');
      })
      .catch(() => {
        window.open(url, '_blank', 'noopener');
      });
  }

  private openReleasesPage(): void {
    this.openExternalUrl(RELEASES_URL);
  }

  /** Hand the store back to the player's own preferences. Called when a document is closed. */
  private releaseDocumentSettings(): void {
    if (this.documentOverrides.size === 0) return;
    this.documentOverrides.clear();
    this.applyingDocumentSettings = true;
    try {
      this.settings.set({ ...this.globalSettings });
    } finally {
      this.applyingDocumentSettings = false;
    }
  }

  /**
   * Decide what goes on disk after every settings change.
   *
   * Three rules, and the whole of the fix is in the second two:
   *
   *  - a document being applied writes nothing at all (`applyingDocumentSettings`);
   *  - a key the document is answering for is written back as the PLAYER's value, not the
   *    document's, so the file cannot leak into the preferences one unrelated click later;
   *  - and a key the player has just changed themselves stops being the document's — detected
   *    from the store's own before/after pair rather than from a flag, so it works no matter
   *    which control did the changing.
   */
  private persistSettings(next: AppSettings, previous: AppSettings): void {
    if (this.applyingDocumentSettings) return;
    for (const key of [...this.documentOverrides]) {
      if (!sameSettingValue(next[key], previous[key])) this.documentOverrides.delete(key);
    }
    const global = { ...next } as Record<string, unknown>;
    for (const key of this.documentOverrides) {
      global[key] = (this.globalSettings as unknown as Record<string, unknown>)[key];
    }
    this.globalSettings = global as unknown as AppSettings;
    saveSettings(this.globalSettings);
  }

  /**
   * `secondary` means "this is a test clone, not the app the user is looking at": it skips
   * the window-wide handlers and the `window.__RIFFSHEET_*` hooks (which are global, and
   * would otherwise be re-pointed at the clone) and ignores `?demo=`, so it takes the same
   * boot path a reopened plugin editor takes. Only `bootSecondApp` passes it.
   */
  async start(options?: { secondary?: boolean; autoResume?: boolean }): Promise<void> {
    this.renderOpening();
    // The number in the brand block, from the shell if it can say. Fire-and-forget; the block
    // is already drawn with the build-time constant.
    this.adoptAppVersion();
    if (!options?.secondary) {
      this.installGlobalHandlers();
      this.bridge.onInputDropped?.((result) => {
        void this.openNativeDroppedInput(result);
      });
      // The harness owns powerful mutation/export probes. Keep them out of the shipping
      // plugin unless the verification URL explicitly asks for them.
      if (new URLSearchParams(location.search).get('verify') === '1') this.installTestHooks();
    }

    try {
      this.runtime.set({ host: await this.bridge.getHostInfo() });
      this.renderOpening();
    } catch (e) {
      this.toast('danger', 'Host', (e as Error).message);
    }

    if (!options?.secondary) this.watchHostTimeline();

    // Which engines exist, and which one is in charge. Asked once at boot rather than polled:
    // the settings panel keeps it fresh while it is open, and the main menu only needs to be
    // right when somebody is looking at it. Never fatal — an older shell has no such call and
    // the picker is simply absent.
    //
    // NOT awaited. `call()` in bridge/juce.ts has no timeout, so awaiting this put an
    // unbounded native round-trip directly in front of `restoreSession()` — a shell that
    // answered slowly, or not at all, would leave the player staring at the drop zone with
    // their last take unrestored and every control that depends on it absent. The picker is a
    // chip on the main menu; nothing below this line needs it, and `loadEngines` re-renders
    // when it lands.
    void this.loadEngines();

    // Vouch for the Recent list before anything can be clicked. The shell will only re-open a
    // path it knows this user chose, and entries made before it kept that record — everything
    // in the list on the day this shipped — have to be handed over or they answer "use Open to
    // import it first" forever. Never awaited into the critical path and never fatal: the worst
    // a failure costs is the old behaviour for old entries.
    if (!options?.secondary && this.bridge.authorizeRecentPaths) {
      const paths = loadRecent().map((r) => r.path).filter((p) => p.length > 0);
      if (paths.length > 0) await this.bridge.authorizeRecentPaths(paths).catch(() => 0);
    }

    const params = new URLSearchParams(location.search);
    if (!options?.secondary && params.has('demo')) {
      this.loadDemo(params.get('demo') || 'triplet');
      return;
    }

    // Nothing above this point can put a take on screen, so a restore cannot fight with
    // one. It is awaited: the drop zone is already rendered, and a session that arrives
    // after the user has started dropping a file would be worse than a slightly later boot.
    await this.restoreSession({ auto: options?.autoResume === true });
  }

  // =========================================================================
  // Opening screen
  // =========================================================================

  /**
   * Read the engine list, and let the SHELL win about which engine is chosen.
   *
   * The choice really lives in `<appSupport>/engine.json`, which is machine-wide and readable
   * from inside a DAW; `AppSettings.engineId` is a cache of it so the picker can draw before
   * the shell has answered and so the browser mock has something honest to show. When the two
   * disagree the file is right — it is the one another Riffsheet window, or the same one after
   * a reinstall, would also be reading.
   */
  private async loadEngines(): Promise<void> {
    if (!this.bridge.listEngines) return;
    const list = await this.bridge.listEngines().catch(() => null);
    if (!list) return;
    this.engineList = list;
    if (list.configuredEngine && list.configuredEngine !== this.settings.get().engineId) {
      this.settings.set({ engineId: list.configuredEngine });
    }
    this.renderOpening();
  }

  /**
   * Choose an engine from the main menu, and then USE it.
   *
   * A chip for something that is not installed selects it AND jumps to its card, because
   * "selected, and doing nothing visible" is the worst of the three possible outcomes: the
   * shell falls back to the built-in engine until the real one is there, and the card is where
   * that is explained and where the Install button lives.
   */
  private async pickEngine(id: string): Promise<void> {
    const refusal = await this.chooseEngine(id);
    if (refusal) this.toast('info', 'Engine', refusal);
    this.renderOpening();
  }

  /**
   * CHOOSING AN ENGINE MEANS TRANSCRIBING WITH IT.
   *
   * The old behaviour was to write the choice into `engine.json` and stop. On the main menu,
   * with nothing open, that is defensible. On a screen already showing a sheet it is a control
   * that does nothing visible: the take on screen was written by the old engine, stays exactly
   * as it was, and the only way to find out whether the new one is any better was to hunt down
   * "Listen again". Every press of a card now ends in one of three things happening, and never
   * in silence:
   *
   *   - a fresh transcription with the engine just chosen;
   *   - a sentence saying why not (nothing open, no recording behind this take, the shell
   *     refused the change);
   *   - the engine's own card, when what it needs is installing rather than running.
   *
   * ORDER MATTERS AND IS NOT NEGOTIABLE. Ask about unsaved work first — it is the only step
   * that can still be cancelled. Then cancel the running job, because `selectEngine` refuses
   * while anything on this machine is transcribing (BRIDGE.md §3.1) and doing this the other
   * way round produces a refusal the player caused by pressing the button. Then store the
   * choice. Then listen.
   *
   * Returns a refusal to show, or null when the choice went through.
   */
  private async chooseEngine(id: string): Promise<string | null> {
    const engine = this.engineList?.engines.find((e) => e.id === id);
    const needsSetup = !!engine && engine.state !== 'ready' && engine.state !== 'installed';
    const rt = this.runtime.get();
    const canListen = !!rt.source?.detected && !!this.audioRef && this.audioRef.kind !== 'midi';

    // 1. The one question that can still be answered "no". Only asked when there is something
    //    to lose AND we are actually going to re-listen; a choice made from the main menu with
    //    nothing open discards nothing.
    if (canListen && !needsSetup) {
      const edits = this.editCursor + 1 + this.perfIndex;
      if (edits > 0) {
        const name = engine?.name ?? 'that engine';
        const ok = await this.askConfirm(
          `Listening again with ${name} will replace the notes with a fresh reading, and the ${edits} ` +
            `change${edits === 1 ? '' : 's'} you have made will go with them. Carry on?`,
          'Listen again'
        );
        if (!ok) return null;
      }
    }

    // 2. Get out of the shell's way before asking it to change anything.
    if (rt.progress !== null) await this.bridge.transcribeCancel?.().catch(() => undefined);

    // 3. Store it.
    this.settings.set({ engineId: id });
    const result = await this.bridge.selectEngine?.(id).catch(() => null);
    await this.loadEngines();
    if (result && !result.ok) return result.error ?? 'The engine could not be changed.';

    // 4. And use it — or say, in one sentence, why this press could not end in a transcription.
    if (needsSetup) {
      this.openEngineSetup(id);
      return null;
    }
    if (!rt.source) {
      return `${engine?.name ?? 'That engine'} will do the listening. Open a recording and it will be used.`;
    }
    if (!canListen) {
      return `${engine?.name ?? 'That engine'} will do the listening from now on. This take has no recording behind it to re-read.`;
    }

    // Onto the sheet BEFORE it starts. The chip that was just pressed may have been on the
    // main menu, and a transcription running behind a menu is a wait with nothing to watch —
    // the progress row, the engine chip and the notes appearing are all on the other screen.
    if (this.runtime.get().screen !== 'main') this.resumeCurrentWork();
    await this.retranscribe({ confirmed: true });
    return null;
  }

  /**
   * The engine picker, on the screen where somebody chooses what to open.
   *
   * It goes HERE — above the drop zone, on the main menu — rather than behind the gear,
   * because which engine listens is a decision about the take you are about to make, and a
   * setting nobody finds is a setting nobody has. The full cards, with sizes, licences and
   * Install buttons, stay in Settings; this is the one-line version plus a way through to them.
   *
   * Returns null when there is nothing to choose between: a shell with one engine, or one too
   * old to be asked. A picker with a single chip in it would imply a choice that does not exist.
   */
  private enginePickSection(): HTMLElement | null {
    const list = this.engineList;
    if (!list || list.engines.length < 2) return null;

    const chosen = this.settings.get().engineId;
    const resolvedName = list.engines.find((e) => e.id === list.resolvedEngine)?.name ?? '';
    const options = [
      {
        value: 'auto',
        label: resolvedName ? `Auto — ${resolvedName}` : 'Auto',
        title: list.engineReason
      },
      ...list.engines.map((e) => {
        const installable = e.state !== 'ready' && e.state !== 'installed';
        return {
          value: e.id,
          // "· install" rather than a disabled chip: it IS selectable, and pressing it takes
          // you to the card that can do something about it.
          label: installable ? `${e.name} · install` : e.name,
          title: `${e.tier}. ${e.summary}`
        };
      })
    ];

    return el(
      'section',
      { class: 'engine-pick', 'data-role': 'engine-pick' },
      el('h2', { text: 'Transcription engine' }),
      chipGroup(
        chosen,
        options,
        (id) => void this.pickEngine(id),
        'Which engine listens to your audio. Auto picks the best one that is actually installed on this machine.',
        'data-engine-id'
      ),
      el('div', {
        class: 'status-row dim',
        'data-role': 'engine-pick-reason',
        text: list.engineReason
      }),
      el('button', {
        class: 'chip',
        'data-role': 'engine-pick-more',
        text: 'Engine setup →',
        onClick: () => this.openEngineSetup()
      })
    );
  }

  private renderOpening(): void {
    if (this.runtime.get().screen !== 'opening') return;
    const rt = this.runtime.get();
    const host = rt.host;
    const recent = loadRecent();
    const hasCurrent = !!rt.source;

    const dropzone = el(
      'div',
      {
        class: 'dropzone',
        'data-role': 'open-source',
        role: 'button',
        tabindex: '0',
        title: t(TIPS.drop),
        onClick: () => {
          if (!rt.busy) void this.chooseFileFromMenu();
        },
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!rt.busy) void this.chooseFileFromMenu();
          }
        }
      },
      el('div', {
        class: 'headline',
        text: rt.busy ?? 'Open audio, MIDI, MusicXML, Guitar Pro, PDF, or a score image'
      }),
      el('div', {
        class: 'explainer',
        text: rt.busy
          ? 'This can take a little while for a multi-page score.'
          : 'Everything becomes editable notation and MIDI. Printed recognition supports standard notation.'
      }),
      el('button', {
        class: 'primary',
        text: rt.busy ? 'Working' : 'Choose a file',
        disabled: !!rt.busy,
        title: t(TIPS.browse),
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          if (!rt.busy) void this.chooseFileFromMenu();
        }
      })
    );

    // Depth-counted drag tracking: dragleave fires for every child, so a plain boolean
    // flickers. Basscribe had no hover state at all; this is the fix.
    let depth = 0;
    dropzone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      dropzone.classList.add('dragging');
    });
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    dropzone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) dropzone.classList.remove('dragging');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      dropzone.classList.remove('dragging');
      const file = e.dataTransfer?.files?.[0];
      if (file) void this.openDroppedFile(file);
    });

    // In a plugin, capture is as prominent as the drop zone: the DAW user's loop is
    // drop plugin on track -> press capture -> hit play -> stop -> sheet.
    const captureButton =
      host?.isPlugin &&
      el(
        'button',
        {
          class: rt.capturing || rt.captureArmed || this.captureStopPending ? 'primary' : '',
          style: { fontSize: '15px', padding: '12px 22px' },
          disabled: this.captureStopPending,
          title: this.captureStopPending
            ? 'Saving captured audio…'
            : t(rt.capturing ? TIPS.captureStop : rt.captureArmed ? TIPS.captureArmed : TIPS.capture),
          onClick: () => void this.beginCaptureFromMenu()
        },
        this.captureStopPending
          ? 'Saving take…'
          : rt.capturing
          ? `■  Stop — ${rt.captureSec.toFixed(1)}s`
          : rt.captureArmed
            ? '●  Armed — waiting for your DAW'
            : '●  Capture from track'
      );

    replace(
      this.root,
      host &&
        !host.engineAvailable &&
        el(
          'div',
          { class: 'banner' },
          el('span', { text: 'Audio transcription needs a one-time setup' }),
          // Into the app's own setup screen, not straight out to a Finder window. The screen
          // says what to install, lists every place that was already looked in, and can look
          // again — which is the whole question somebody standing here has. Revealing a folder
          // is one of the buttons ON that screen, not the answer to this one.
          el('button', {
            text: 'Set up →',
            'data-role': 'engine-setup-open',
            title: t(TIPS.engineSetup),
            onClick: () => this.openEngineSetup()
          }),
          el('span', { class: 'dim', text: '· MIDI and score files still work' })
        ),
      el(
        'div',
        { class: 'dropzone-screen' },
        // TWO COLUMNS, AND THE PAGE DOES NOT SCROLL (F12).
        //
        // It was one centred 640px column with everything stacked in it, which had two faults
        // at once on any ordinary window: most of the width was empty margin, and the stack was
        // taller than the pane, so the main menu — the first screen anybody sees — arrived with
        // a scrollbar and its footer below the fold. The Recent list was the tallest thing in
        // it and the least urgent.
        //
        // So: what you DO on the left, what you have done BEFORE on the right, side by side.
        // Neither wrapper exists to be styled prettily — they exist because a grid cannot put
        // six flat siblings into two columns without naming every one of them, and a list of
        // `grid-row` numbers is a layout that breaks the next time a control is added.
        //
        // Below the breakpoint the two wrappers stack and the screen goes back to being one
        // column, which is the right answer for a narrow plugin window and is what the CSS
        // does with no help from here.
        el(
          'div',
          { class: 'menu-actions', 'data-role': 'menu-actions' },
        // Before the drop zone, deliberately: which engine listens is a decision about the
        // take you are about to make, so it reads before you choose a source rather than
        // after. INSIDE the scroller, though, and not a sibling of it — as a sibling it sat
        // outside the centred column, pinned to the left edge, and its height came out of the
        // scroller's, which pushed the top of everything below it past the fold.
        this.enginePickSection(),
        hasCurrent &&
          el(
            'section',
            { class: 'current-work', 'data-role': 'main-menu-current' },
            el('div', {}, el('strong', { text: rt.source?.name ?? 'Current work' }), el('div', { class: 'dim', text: 'Your current work is still open.' })),
            el('div', { class: 'row' },
              el('button', { class: 'primary', text: 'Resume current work', 'data-role': 'resume-current', onClick: () => this.resumeCurrentWork() }),
              // "Save as Riffsheet" moved into the Export menu in the header, with the other
        // three ways a file leaves Riffsheet. It was the only one living somewhere else.
        null,
              // START OVER, and it says so. This is what the header's "Listen again" became:
              // the same call, moved to where the other irreversible choices live and named
              // for what it costs rather than for what it does. Offered whenever there is a
              // RECORDING behind the take — `peaks` is what that means; a MIDI import has
              // none and re-running an engine on it would be theatre.
              //
              // It is NOT hidden when the audio handle has gone missing. That was the old
              // bug: the handle is dropped whenever the original cannot be re-opened, so the
              // button deleted itself in exactly the situation somebody would reach for it.
              // It stays, and `retranscribe()` explains — a control that says what is wrong
              // beats one that disappears.
              rt.source?.detected &&
                rt.source.peaks &&
                this.audioRef?.kind !== 'midi' &&
                el('button', {
                  text: '↻ Start over (re-transcribe)',
                  'data-role': 'retranscribe-menu',
                  title: t(TIPS.retranscribe),
                  onClick: () => void this.retranscribeFromMenu()
                }),
              el('button', { class: 'danger-text', text: 'Close current work', 'data-role': 'close-current', onClick: () => void this.closeCurrentWork() })
            )
          ),
        dropzone,
        el('button', {
          class: 'new-score-button',
          text: 'Create a blank score',
          'data-role': 'new-blank-score',
          disabled: !!rt.busy,
          onClick: () => {
            this.blankSetupOpen = !this.blankSetupOpen;
            this.renderOpening();
          }
        }),
        this.blankSetupOpen && this.buildBlankScoreSetup(),
        captureButton &&
          el(
            'div',
            { class: 'row', style: { gap: '10px' } },
            captureButton,
            rt.captureArmed &&
              !this.captureStopPending &&
              el('span', { class: 'dim', text: 'Press play in your DAW — recording starts by itself.' })
          )
        ),
        el(
          'div',
          { class: 'menu-side', 'data-role': 'menu-side' },
          recent.length > 0 &&
            el(
              'div',
              { class: 'recent' },
              el('h2', { text: 'Recent' }),
              // The items get a scroller of their OWN, capped at about six rows (styles.css
              // §.recent-list). Eight entries are remembered and eight are offered — the list
              // is not shortened, only the space it is allowed to take from the things above
              // it, which is what stopped the menu fitting on a screen in the first place.
              el(
                'div',
                { class: 'recent-list', 'data-role': 'recent-list' },
                ...recent.map((r) =>
                  el(
                    'div',
                    {
                      class: 'recent-item',
                      title: t(TIPS.recent),
                      // Actually opens it. This used to be a stub that answered the click with
                      // "re-opening by name needs the host bridge" — which was simply untrue: the
                      // path is stored right here and `loadAudioPath` has existed on the bridge all
                      // along. Nobody wired the two together.
                      onClick: () => void this.openRecentFromMenu(r)
                    },
                    el('span', { text: r.name }),
                    el('span', { class: 'when', text: relativeTime(r.at) })
                  )
                )
              )
            ),
          el(
            'footer',
            { class: 'opening-footer' },
            el('button', {
              class: 'ghost legal-link',
              text: 'About & licenses',
              'data-role': 'about-licenses',
              onClick: () => this.showAboutDialog()
            })
          )
        )
      ),
      this.toastLayer()
    );
  }

  /**
   * Start over from the Main menu: re-read the recording, then go back to the sheet.
   *
   * The menu is not where anybody wants to watch a progress bar, so this returns to the sheet
   * first and the transcription runs against the view it is changing. `retranscribe()` still
   * owns the questions — unsaved edits, a missing handle — because they are the same questions
   * wherever the gesture starts.
   */
  private async retranscribeFromMenu(): Promise<void> {
    if (!this.runtime.get().source) return;
    this.resumeCurrentWork();
    await this.retranscribe();
  }

  private resumeCurrentWork(): void {
    if (!this.runtime.get().source) return;
    this.blankSetupOpen = false;
    this.runtime.set({ screen: 'main' });
    this.renderMain();
  }

  private openMainMenu(): void {
    this.blankSetupOpen = false;
    this.runtime.set({ screen: 'opening', settingsOpen: false });
    this.settingsPanel?.setOpen(false);
    this.renderOpening();
    // Ask again on the way in. The engine can have been changed from the settings panel — or
    // by another Riffsheet window, since the choice is a file on disk — and the picker's
    // explanation is a sentence about a resolution only the shell can make. Drawing last
    // boot's sentence under a chip that has since moved would be a small, confident lie.
    void this.loadEngines();
  }

  /**
   * Ask a yes/no question, in the page.
   *
   * NOT `window.confirm`. A JUCE WebView is a WKWebView, and WKWebView only shows a JS dialog
   * if the host application implements `runJavaScriptConfirmPanelWithMessage`. The shell does
   * not, so `window.confirm()` returned false immediately, in silence, with no dialog and no
   * console error — and every caller reads a false as "the user said no". That is the whole of
   * the reported "the Listen again button does not work": the click ran, hit the confirm, was
   * told no by nobody, and returned. Three call sites were dead the same way (open over current
   * work, close current work, listen again), and only the ones reached AFTER an edit, which is
   * why it looked intermittent.
   *
   * Modelled on `askPart()` below: one overlay, one promise, resolved by whichever button is
   * pressed. Escape and a click on the backdrop both mean cancel, which is the safe answer for
   * every question asked through here.
   */
  private askConfirm(
    message: string,
    confirmText = 'Continue',
    /**
     * What the OTHER button says, and what it means.
     *
     * "Cancel" is right for a question about doing something irreversible, and wrong for a
     * question with two real answers — "Resume previous work" against "Start fresh" is a fork,
     * not a warning, and labelling one side Cancel would make the safe-looking button the one
     * that throws the work away. `dismissIs` says which answer Escape and a click on the
     * backdrop give, so a fork can default to the conservative side rather than to `false`.
     */
    options: { cancelText?: string; dismissIs?: boolean; role?: string } = {}
  ): Promise<boolean> {
    const cancelText = options.cancelText ?? 'Cancel';
    const dismissIs = options.dismissIs ?? false;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(value);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(dismissIs);
        }
      };
      const overlay = el(
        'div',
        {
          class: 'modal-backdrop',
          'data-role': 'confirm-dialog',
          // A second name for the same element when the caller wants one it can find
          // unambiguously — there is only ever one dialog on screen, but "the resume prompt"
          // and "some confirm" are different claims for a check to make.
          ...(options.role ? { 'data-dialog': options.role } : {}),
          role: 'dialog',
          'aria-modal': 'true',
          onClick: (e: MouseEvent) => {
            if (e.target === e.currentTarget) finish(dismissIs);
          }
        },
        el(
          'section',
          { class: 'part-picker confirm-dialog' },
          el('p', { 'data-role': 'confirm-message', text: message }),
          el(
            'div',
            { class: 'confirm-actions' },
            el('button', { text: cancelText, 'data-role': 'confirm-cancel', onClick: () => finish(false) }),
            el('button', {
              class: 'primary',
              text: confirmText,
              'data-role': 'confirm-ok',
              onClick: () => finish(true)
            })
          )
        )
      );
      document.addEventListener('keydown', onKey, true);
      this.root.appendChild(overlay);
      (overlay.querySelector('[data-role="confirm-ok"]') as HTMLButtonElement | null)?.focus();
    });
  }

  private async confirmReplaceCurrent(action: string): Promise<boolean> {
    const source = this.runtime.get().source;
    if (!source) return true;
    const edits = this.editCursor + 1 + this.perfIndex;
    const detail = edits > 0 ? ` and ${edits} unsaved change${edits === 1 ? '' : 's'}` : '';
    return this.askConfirm(`${action} will replace “${source.name}”${detail}. Continue?`);
  }

  private async chooseFileFromMenu(): Promise<void> {
    if (!(await this.confirmReplaceCurrent('Opening another file'))) return;
    await this.pickFile();
  }

  private async openDroppedFile(file: File): Promise<void> {
    if (!(await this.confirmReplaceCurrent(`Opening “${file.name}”`))) return;
    await this.openFile(file);
  }

  private async openNativeDroppedInput(result: DroppedInputResult): Promise<void> {
    if (!result.ok) {
      this.toast('danger', result.name, result.error);
      return;
    }

    const picked = result.input;
    const name = picked.kind === 'audio' ? picked.audio.name : picked.name;
    if (!(await this.confirmReplaceCurrent(`Opening “${name}”`))) return;

    if (picked.kind === 'audio') {
      await this.ingest(picked.audio);
      return;
    }

    const contents = picked.bytes.buffer.slice(
      picked.bytes.byteOffset,
      picked.bytes.byteOffset + picked.bytes.byteLength
    ) as ArrayBuffer;
    await this.openFile(new File([contents], picked.name));
  }

  private async openRecentFromMenu(entry: RecentFile): Promise<void> {
    if (!(await this.confirmReplaceCurrent(`Opening “${entry.name}”`))) return;
    await this.openRecent(entry);
  }

  private async beginCaptureFromMenu(): Promise<void> {
    const rt = this.runtime.get();
    if (!rt.capturing && !rt.captureArmed && !(await this.confirmReplaceCurrent('Starting a new capture'))) return;
    await this.toggleCapture();
  }

  private async closeCurrentWork(): Promise<void> {
    const source = this.runtime.get().source;
    if (!source) return;
    if (!(await this.askConfirm(`Close “${source.name}”? Unsaved changes will be lost.`, 'Close'))) return;
    await this.bridge.transcribeCancel?.().catch(() => undefined);
    await this.bridge.stopEngine?.().catch(() => undefined);
    await this.bridge.unloadOriginal?.().catch(() => undefined);
    await this.bridge.pcmRetain?.(null).catch(() => undefined);
    await this.session.clear();
    this.transport.setOriginalAvailable(false, 0);
    this.setPcm(null, 0);
    this.audioRef = null;
    this.forgetAudioBytes();
    this.sourceMidi = null;
    this.selection = null;
    this.undoStack.clear();
    this.editLog = [];
    this.editCursor = -1;
    this.resetHistories();
    // The document is gone, so anything it was answering for goes with it and the player's own
    // preferences are back in force. Without this, closing a document would leave its values on
    // screen with no document to explain them.
    this.releaseDocumentSettings();
    this.runtime.set({ screen: 'opening', source: null, score: null, selection: [], progress: null, busy: null });
    this.renderOpening();
  }

  private buildBlankScoreSetup(): HTMLElement {
    const s = this.settings.get();
    return el(
      'form',
      {
        class: 'blank-score-setup',
        'data-role': 'blank-score-setup',
        onSubmit: (event: SubmitEvent) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget as HTMLFormElement);
          void this.createBlankScore({
            title: String(data.get('title') ?? 'Untitled'),
            tempo: Number(data.get('tempo')),
            meter: String(data.get('meter') ?? '4/4'),
            bars: Number(data.get('bars')),
            keyFifths: Number(data.get('key')),
            clefMode: String(data.get('clef')) as AppSettings['clefMode'],
            tabMode: String(data.get('tab')) as AppSettings['tabMode']
          });
        }
      },
      el('h2', { text: 'Blank score' }),
      el(
        'div',
        { class: 'blank-score-grid' },
        field('Title', el('input', { name: 'title', value: 'Untitled', maxlength: '80', required: true })),
        field('Tempo', el('input', { name: 'tempo', type: 'number', min: '20', max: '400', value: '120', required: true })),
        field(
          'Meter',
          el(
            'select',
            { name: 'meter' },
            ...timeSigOptions(undefined).map((sig) => el('option', { value: sig, text: sig, selected: sig === '4/4' }))
          )
        ),
        field('Bars', el('input', { name: 'bars', type: 'number', min: '1', max: '512', value: '8', required: true })),
        field(
          'Key',
          el(
            'select',
            { name: 'key' },
            ...KEY_OPTIONS.map(([fifths, label]) =>
              el('option', { value: String(fifths), text: label, selected: fifths === 0 })
            )
          )
        ),
        field(
          'Clef',
          el(
            'select',
            { name: 'clef' },
            ...(['auto', 'treble', 'bass', 'grand'] as const).map((value) =>
              el('option', { value, text: titleCase(value), selected: value === s.clefMode })
            )
          )
        ),
        field(
          'Tablature',
          el(
            'select',
            { name: 'tab' },
            el('option', { value: 'off', text: 'Off', selected: s.tabMode === 'off' }),
            el('option', { value: 'bass', text: 'Bass', selected: s.tabMode === 'bass' }),
            el('option', { value: 'guitar', text: 'Guitar', selected: s.tabMode === 'guitar' }),
            el('option', { value: 'custom', text: 'Custom', selected: s.tabMode === 'custom' })
          )
        )
      ),
      el('div', { class: 'row' },
        el('button', { class: 'primary', type: 'submit', text: 'Create score' }),
        el('button', { type: 'button', text: 'Cancel', onClick: () => { this.blankSetupOpen = false; this.renderOpening(); } })
      )
    );
  }

  private async createBlankScore(options: {
    title: string;
    tempo: number;
    meter: string;
    bars: number;
    keyFifths: number;
    clefMode: AppSettings['clefMode'];
    tabMode: AppSettings['tabMode'];
  }): Promise<void> {
    if (!(await this.confirmReplaceCurrent('Creating a blank score'))) return;
    const title = options.title.trim() || 'Untitled';
    const tempo = Math.max(20, Math.min(400, Math.round(options.tempo) || 120));
    const [numerator, denominator] = options.meter.split('/').map(Number);
    const bars = Math.max(1, Math.min(512, Math.round(options.bars) || 8));
    const durationSec = bars * numerator * (4 / denominator) * (60 / tempo);
    this.settings.set({
      instrument: 'auto',
      tabMode: options.tabMode,
      ...((options.tabMode === 'bass' || options.tabMode === 'guitar') &&
      TUNING_PRESETS.find((preset) => preset.instrument === options.tabMode)
        ? { tuningId: TUNING_PRESETS.find((preset) => preset.instrument === options.tabMode)!.id }
        : {}),
      clefMode: options.clefMode,
      useHostGrid: false,
      tempoBpm: undefined,
      timeSignature: undefined,
      keyFifths: undefined
    });
    this.setSource({
      name: title,
      durationSec,
      peaks: null,
      trim: null,
      barOneSec: 0,
      tempoBpm: tempo,
      timeSignature: { numerator, denominator },
      keyFifths: Math.max(-7, Math.min(7, Math.round(options.keyFifths) || 0)),
      documentBars: bars,
      detected: { notes: [] }
    });
    this.audioRef = { kind: 'midi', name: title, path: '', durationSec };
    this.forgetAudioBytes();
    this.setPcm(null, 0);
    await this.bridge.unloadOriginal?.().catch(() => undefined);
    await this.bridge.pcmRetain?.(null).catch(() => undefined);
    this.transport.setOriginalAvailable(false, durationSec);
    this.blankSetupOpen = false;
    this.goMain(title);
    this.rebuildNotation({ keepEdits: false });
  }

  /**
   * The document the Save-as button would write, built but not saved.
   *
   * Split out from `saveRiffsheetDocument` so `__RIFFSHEET_DOCUMENT__` can round-trip the
   * REAL thing. A probe that assembled its own object would keep passing after this one
   * stopped carrying a field.
   */
  /**
   * Put a document's embedded recording back exactly as an import would have left it.
   *
   * Returns null — not a failure — when there is nothing embedded or it will not decode, which
   * is the signal for the caller to try the v1 path instead. A document whose audio is corrupt
   * should open as a document that has lost its audio, never as a document that will not open.
   *
   * THE SILENT ORIGINAL, and how it is avoided now.
   *
   * Everything that reads the SAMPLES — the waveform, the tuner — works from the bytes alone.
   * PLAYBACK does not: `Transport` plays the Original through `bridge.play()`, and the JUCE
   * shell addresses audio by TOKEN. This function used to call `loadOriginal(ref)` with a ref
   * that carried bytes and no token, which in the shell is a no-op returning `durationSec: 0`,
   * and then reported `available: true` anyway. The fader said the recording was there, the
   * play button ran, and nothing came out. In the browser the very same call DOES work, because
   * the mock bridge decodes `ref.bytes` directly — which is why this survived so long.
   *
   * So `loadOriginal`'s answer is now believed rather than ignored, and it is the thing that
   * tells the two hosts apart without either being named:
   *
   *   durationSec > 0  the host took the bytes. Playable now, nothing owed.
   *   durationSec == 0  the host wants a token. One is minted LAZILY, on the first press of
   *                     play, by `ensureOriginalPlayable()`.
   *
   * Lazily, because minting means shipping the whole recording to the shell — tens of megabytes,
   * base64'd across the bridge — and most opens of a document never press play at all. Paying
   * that on every open to serve the opens that do is the wrong trade. The one case where the
   * fader must go dark immediately is a host that has no `loadAudioBytes` to mint WITH: there the
   * Original can never sound, and saying so on open beats a dead play button.
   */
  private async restoreEmbeddedAudio(
    embedded: EmbeddedAudio | null | undefined,
    durationSec: number
  ): Promise<{ available: boolean; message?: string } | null> {
    // Whatever the last document owed the shell, this one does not owe.
    this.nativeAudioPending = false;
    if (!embedded) return null;
    try {
      const bytes = embedded.bytes;
      if (bytes.byteLength === 0) return null;
      const name = embedded.name || this.audioRef?.name || 'recording';
      const ref: AudioFileRef = {
        path: this.audioRef?.path ?? '',
        name,
        bytes: audioArrayBuffer(bytes),
        durationSec: embedded.durationSec || durationSec,
        ...(embedded.sampleRate ? { sampleRate: embedded.sampleRate } : {})
      };
      const decoded = await this.toPcm(ref);
      if (decoded.pcm.length === 0) return null;

      this.rememberAudioBytes(bytes, name);
      this.setPcm(decoded.pcm, decoded.sampleRate);
      // The take is genuinely here, so it must not keep the 'midi' stub the caller assigned for
      // a document with no `audio` block — that stub is what greys out everything audio-shaped.
      this.audioRef = {
        kind: 'file',
        name,
        path: this.audioRef?.path ?? '',
        durationSec: decoded.durationSec || durationSec
      };

      // A host that decodes bytes directly is done here. A host that failed outright is treated
      // exactly like one that wants a token: try the token route before giving up on sound.
      // `originalPlaybackAfterLoad` is the rule, and it is unit-tested — see persist.ts.
      const loaded = await this.bridge.loadOriginal(ref).catch(() => ({ durationSec: 0 }));
      const playback = originalPlaybackAfterLoad(loaded.durationSec, !!this.bridge.loadAudioBytes);
      if (playback.state === 'ready') {
        this.originalRestoredBy = 'embedded';
        return { available: true };
      }
      if (playback.state === 'needs-token') {
        this.nativeAudioPending = true;
        this.originalRestoredBy = 'embedded-token-pending';
        return { available: true };
      }
      this.originalRestoredBy = 'embedded-no-loadAudioBytes';
      return { available: false, message: playback.message };
    } catch (e) {
      // Named rather than swallowed: "the document had audio and it did not work" is a
      // different fault from "the document had none", and `sessionProbe` reports which.
      this.originalRestoredBy = `embedded-failed: ${(e as Error).message}`;
      return null;
    }
  }

  /**
   * Make sure the host can actually SOUND the original before the transport asks it to.
   *
   * Resolves immediately — no await worth the name — in every case except the one it exists for:
   * a document whose embedded recording has not yet been handed to a token-addressed shell. See
   * `restoreEmbeddedAudio`.
   */
  private ensureOriginalPlayable(): Promise<void> {
    // A press that arrives while the hand-off is already in flight waits for THAT one. Without
    // this the second press would ship the whole recording a second time.
    if (this.nativeAudioMinting) return this.nativeAudioMinting;
    if (!this.nativeAudioPending) return Promise.resolve();
    this.nativeAudioMinting = this.mintNativeOriginal().finally(() => {
      this.nativeAudioMinting = null;
    });
    return this.nativeAudioMinting;
  }

  /**
   * Hand the embedded recording to the shell and load it into the player.
   *
   * Cleared BEFORE the attempt, not after: if the shell will not take these bytes it will not
   * take them on the next press either, and retrying a 50 MB hand-off on every click of play is
   * how one bad document becomes an unusable app.
   */
  private async mintNativeOriginal(): Promise<void> {
    this.nativeAudioPending = false;
    const durationSec = this.runtime.get().source?.durationSec ?? 0;
    try {
      // `takeFromEmbeddedAudio` remembers the token it mints on `audioRef`, so a take that has
      // already been through "Listen again" is not re-staged here.
      const ref: AudioFileRef | null = this.audioRef?.token
        ? { path: this.audioRef.path, name: this.audioRef.name, token: this.audioRef.token }
        : await this.takeFromEmbeddedAudio();
      if (!ref?.token) throw new Error('the recording could not be handed to the player');
      const loaded = await this.bridge.loadOriginal(ref);
      if (!(loaded.durationSec > 0)) throw new Error('the player did not take the recording');
      this.originalRestoredBy = 'embedded-token';
      this.transport.setOriginalAvailable(true, loaded.durationSec || durationSec);
    } catch (e) {
      // THE RULE: never leave the fader claiming an Original that is going to be silent. The
      // sheet still plays; only the recording behind it is gone.
      this.originalRestoredBy = `embedded-token-failed: ${(e as Error).message}`;
      this.transport.setOriginalAvailable(false, durationSec);
      this.toast(
        'danger',
        'The recording could not be played',
        'This document carries its recording, but the player would not take it. The sheet still ' +
          'plays. Dropping the original file in again will restore it.'
      );
    }
  }

  /**
   * Play/pause, with the recording guaranteed to be where the player can reach it.
   *
   * The ONLY route to `transport.toggle()` in the app, so there is no press of play — button or
   * keyboard — that can outrun the hand-off above.
   */
  private async togglePlayback(): Promise<void> {
    await this.ensureOriginalPlayable();
    await this.transport.toggle();
  }

  private rememberAudioBytes(bytes: Uint8Array, name: string): void {
    this.audioBytes = bytes.byteLength > 0 ? bytes : null;
    this.audioMime = this.audioBytes ? audioMimeForName(name) : '';
  }

  private forgetAudioBytes(): void {
    this.audioBytes = null;
    this.audioMime = '';
    // There is no recording left to hand over, so nothing is owed.
    this.nativeAudioPending = false;
  }

  /**
   * The recording, ready to go inside the document (#34).
   *
   * Two sources, in order of honesty:
   *
   *  1. THE IMPORTED FILE ITSELF, byte for byte, whenever the app was given it. Copying beats
   *     re-encoding for the obvious reason — a document that quietly downgrades somebody's flac
   *     to 16-bit wav is a document that has lost something — and for a subtler one: the bytes
   *     that come back out decode to exactly what the transcription was run against.
   *  2. THE DECODED SAMPLES as WAV, for a recorded take (which never had a file of its own) and
   *     for a native open (where the shell holds the path and the page holds only samples).
   *
   * Null for a MIDI or score import, where there is no recording, and null when neither source
   * has anything — in both cases the document falls back to being a v1-style reference.
   */
  private embeddedAudio(): EmbeddedAudio | null {
    if (this.audioRef?.kind === 'midi') return null;
    const durationSec = this.runtime.get().source?.durationSec ?? 0;
    const name = this.audioRef?.name ?? this.runtime.get().source?.name ?? 'audio';

    if (this.audioBytes && this.audioBytes.byteLength > 0) {
      // Handed over, NOT copied. `writeRiffsheetDocument` only reads these on its way into the
      // zip, and copying 50 MB to hand it to something that will copy it again is how the old
      // base64 path got to seven times the recording.
      return { name, mime: this.audioMime, bytes: this.audioBytes, durationSec };
    }
    if (this.pcm && this.pcm.length > 0 && this.pcmRate > 0) {
      return {
        name: name.replace(/\.[^.]+$/, '') + '.wav',
        mime: 'audio/wav',
        bytes: encodeWavPcm16(this.pcm, this.pcmRate),
        durationSec,
        sampleRate: this.pcmRate
      };
    }
    return null;
  }

  /**
   * Is there a recording behind this sheet at all?
   *
   * Deliberately cheap and deliberately separate from `embeddedAudio()`: this answers the Export
   * menu's enabled/disabled question every time the menu opens, and `embeddedAudio()` may have to
   * encode the entire take to WAV to answer it. Same two sources, in the same order.
   */
  private hasExportableAudio(): boolean {
    if (this.audioRef?.kind === 'midi') return false;
    return (this.audioBytes?.byteLength ?? 0) > 0 || ((this.pcm?.length ?? 0) > 0 && this.pcmRate > 0);
  }

  /**
   * The take as a file the player can save (Export ▸ Audio).
   *
   * `embeddedAudio()` already encodes the rule this needs — the ORIGINAL FILE verbatim when there
   * was one, the decoded samples as WAV when there was not — so exporting the audio and embedding
   * it in a document hand out the identical bytes. Built on demand, only when the item is picked.
   */
  private audioExportPayload(): ExportPayload | null {
    const embedded = this.embeddedAudio();
    if (!embedded) return null;
    return {
      // The same sanitised, extension-bearing name the zip entry gets, so what lands on the desk
      // is called what it is called inside the document.
      name: audioEntryName(embedded.name, embedded.mime),
      bytes: embedded.bytes,
      mimeType: embedded.mime || 'application/octet-stream'
    };
  }

  private buildRiffsheetDocument(): RiffsheetDocument | null {
    const source = this.runtime.get().source;
    if (!source) return null;
    const encoded = encodeSource(source);
    if (!encoded) return null;
    return {
      app: 'riffsheet-document',
      version: RIFFSHEET_DOCUMENT_VERSION,
      savedAt: Date.now(),
      name: source.name,
      source: encoded,
      settings: this.settings.get(),
      edits: this.editLog,
      editCursor: this.editCursor,
      sourceMidi: this.sourceMidi ? bytesToBase64(this.sourceMidi) : undefined,
      // Which take this is OF. Without it the document reopens as a sheet with no recording
      // behind it: the fader has nothing on its Original side and Listen again is dead.
      // `portableAudioRef` drops the token and the sample URL, which name a decode inside the
      // process that wrote the file and are a lie anywhere else.
      audio: portableAudioRef(this.audioRef),
      // …and the take itself, so the document does not merely NAME a recording it cannot reach.
      // This is what makes the file portable in the sense users meant by the word.
      audioData: this.embeddedAudio()
    };
  }

  /**
   * WHAT THIS COSTS IN MEMORY, end to end, for a recording of size N.
   *
   *   this.audioBytes        N     the take, already resident
   *   writeRiffsheetDocument N     the zip, with the audio STORED into it — one copy, no base64
   *   bridge.exportFile     ~3.5N  juce.ts `toBase64`: a binary string (UTF-16, so 2N) and then
   *                                the base64 of it (4/3 × 2N ≈ 2.7N), briefly both at once
   *
   * The last line is the bridge's, not this file's: `exportFile` takes bytes and the WebView call
   * takes text, so something has to base64 it. It is the only amplification left on the path. The
   * v2 format added three more layers of its own on top of that one — base64 of the audio, the
   * JSON string containing it, and the UTF-8 encoding of THAT — which is what took the peak to
   * seven or eight times the recording. See the container note in app/persist.ts.
   *
   * The mime type is now the zip's: a `.riffsheet` IS one, and a host that sniffs the bytes would
   * otherwise be told a lie it can check.
   */
  private async saveRiffsheetDocument(): Promise<void> {
    const document = this.buildRiffsheetDocument();
    if (!document) return;
    try {
      const outcome = await this.bridge.exportFile(
        `${this.baseName() || 'Untitled'}.riffsheet`,
        // Throws, with a sentence, for a take over the 512 MB ceiling — caught below like any
        // other failure rather than left to die inside the allocator.
        writeRiffsheetDocument(document),
        'application/x-riffsheet+zip'
      );
      if (outcome.saved) this.toast('info', 'Riffsheet saved', 'The editable score document was saved.');
    } catch (e) {
      this.toast('danger', 'Could not save Riffsheet', (e as Error).message);
    }
  }

  private async ingestRiffsheetDocument(name: string, bytes: Uint8Array): Promise<void> {
    const document = readRiffsheetDocument(bytes);
    const source = decodeSource(document.source);
    if (!source) throw new Error('That Riffsheet document has no score data.');
    // The document's settings, for the document. NOT for the player's preferences file — see
    // `applyDocumentSettingsToStore`, which is the whole of the fix for the reported clobber.
    this.applyDocumentSettingsToStore(document.settings);
    this.setSource({ ...source, name: document.name || name.replace(/\.riffsheet$/i, '') });
    // A document made before documents carried a take, or made from a symbolic import, still
    // gets the old stub: no audio, and everything that depends on audio correctly switched off.
    this.audioRef = document.audio ?? { kind: 'midi', name, path: '', durationSec: source.durationSec };
    try {
      this.sourceMidi = document.sourceMidi ? base64ToBytes(document.sourceMidi) : null;
    } catch {
      this.sourceMidi = null;
    }
    // Drop whatever the PREVIOUS take left loaded BEFORE trying to reopen this one. Reversing
    // these two would leave the last recording audible under the newly opened sheet on every
    // path where the reopen fails, which is most of them — a moved file, another machine.
    this.setPcm(null, 0);
    await this.bridge.unloadOriginal?.().catch(() => undefined);
    await this.bridge.pcmRetain?.(null).catch(() => undefined);

    // v2 FIRST: the recording is inside the file, so there is nothing to go looking for and
    // nothing that can have moved since it was saved. A v1 document — and a v2 one whose
    // embedded audio will not decode — falls straight through to the old token-then-path
    // recovery, which is unchanged and still the only route for a document that never carried
    // its take.
    const original =
      (await this.restoreEmbeddedAudio(document.audioData, source.durationSec)) ??
      (await this.reopenOriginal(this.audioRef));
    this.transport.setOriginalAvailable(original.available, source.durationSec);

    this.goMain(source.name);
    this.rebuildNotation({ keepEdits: false });
    this.replayEdits(document.edits, document.editCursor);
    // Only when the document named a take and it could not be found. Silence would leave them
    // wondering why the Original side of the fader does nothing.
    if (original.message) this.toast('info', 'Opened without the recording', original.message);
  }

  // =========================================================================
  // Input
  // =========================================================================

  /**
   * Open something from the Recent list.
   *
   * The entry stores a real filesystem path (written by `pushRecent` on every successful
   * ingest), and `loadAudioPath` turns a path back into a take the shell holds. Both have
   * existed since v1.1; the click handler simply never called them and apologised instead.
   *
   * A path can of course be stale — the file moved, was renamed, or lives on a drive that is
   * not plugged in. That is reported as what it is rather than as a limitation of the app, and
   * the dead entry is dropped from the list so it stops being offered.
   */
  private async openRecent(entry: RecentFile): Promise<void> {
    if (!this.bridge.loadAudioPath) {
      this.toast(
        'info',
        entry.name,
        'This host cannot reopen a file by name. Drop the file in again and it will work.'
      );
      return;
    }
    try {
      const ref = await this.bridge.loadAudioPath(entry.path);
      if (!ref) throw new Error('the file could not be opened');
      await this.ingest(ref);
    } catch (e) {
      const detail = (e as Error).message;
      // Only forget an entry the filesystem has actually lost. Dropping it for ANY failure
      // meant a shell that refused to open the file also deleted the user's own record of it,
      // so a bad refusal destroyed the evidence one click at a time. Anything else — a refusal,
      // a decode failure, a busy shell — leaves the entry alone and says what went wrong.
      const gone = /no such file|could not be opened$/i.test(detail);
      if (gone) {
        forgetRecent(entry.path);
        this.renderOpening();
      }
      this.toast(
        'danger',
        entry.name,
        gone
          ? `That file could not be opened — it may have been moved, renamed, or be on a drive that is not connected. (${detail})`
          : `That file is still there, but opening it did not work. (${detail})`
      );
    }
  }

  private async pickFile(): Promise<void> {
    // HTML file inputs are unreliable inside DAW WebViews (and display:none inputs are ignored
    // by some engines altogether). The shell picker is the primary path there and accepts every
    // format shown on the opening screen, not only audio.
    if (this.bridge.pickInputFile) {
      try {
        const picked = await this.bridge.pickInputFile();
        if (!picked) return;
        if (picked.kind === 'audio') {
          await this.ingest(picked.audio);
        } else {
          const contents = picked.bytes.buffer.slice(
            picked.bytes.byteOffset,
            picked.bytes.byteOffset + picked.bytes.byteLength
          ) as ArrayBuffer;
          await this.openFile(new File([contents], picked.name));
        }
      } catch (e) {
        this.toast('danger', 'Could not open that', (e as Error).message);
      }
      return;
    }

    const file = await new Promise<File | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = OPEN_FILE_ACCEPT;
      // Keep it laid out: Safari/WebKit may refuse to open a picker for display:none controls.
      Object.assign(input.style, {
        position: 'fixed',
        left: '-10000px',
        top: '0',
        width: '1px',
        height: '1px',
        opacity: '0'
      });
      document.body.appendChild(input);
      const finish = (picked: File | null) => {
        input.remove();
        resolve(picked);
      };
      input.onchange = () => finish(input.files?.[0] ?? null);
      input.oncancel = () => finish(null);
      input.click();
    });
    if (file) await this.openFile(file);
  }

  private async openFile(file: File): Promise<void> {
    try {
      const bytes = await file.arrayBuffer();
      if (isRiffsheetFile(file.name)) {
        await this.ingestRiffsheetDocument(file.name, new Uint8Array(bytes));
        return;
      }
      // MIDI and score formats are parsed here in every host; no audio decoder round-trip.
      if (isMidiFile(file.name, bytes)) {
        await this.ingest({ path: file.name, name: file.name, bytes });
        return;
      }
      if (isScoreImageFile(file)) {
        await this.ingestPrintedScore(file.name, new Uint8Array(bytes));
        return;
      }
      if (isScoreFile(file.name, bytes)) {
        await this.ingestScoreFile(file.name, new Uint8Array(bytes));
        return;
      }
      if (isJuceHost()) {
        // Hand audio bytes to the shell so transcription and original playback get a token.
        await this.ingest(await importDroppedFileNative(file));
        return;
      }
      await this.ingest({ path: file.name, name: file.name, bytes });
    } catch (e) {
      this.toast('danger', 'Could not open that', (e as Error).message);
      if (this.runtime.get().screen === 'opening') this.renderOpening();
    }
  }

  private async ingestPrintedScore(name: string, bytes: Uint8Array): Promise<void> {
    if (!this.bridge.recognizeScoreImage) {
      throw new Error(`PDF/image score reading is not available in this build. ${SCORE_IMAGE_SCOPE}`);
    }

    this.runtime.set({ busy: 'Reading the printed score…' });
    if (this.runtime.get().screen === 'opening') this.renderOpening();
    this.toast('info', 'Reading printed score', 'Audiveris is turning the page into MusicXML.');
    try {
      const status = await this.bridge.omrStatus?.();
      if (status && !status.available) throw new Error(status.message);
      // MuScriptor and Audiveris are both memory-heavy. Give MuScriptor's idle weights back
      // before starting OMR when we own them; a busy/adopted engine simply refuses safely.
      await this.bridge.stopEngine?.().catch(() => null);
      const recognized = decodeRecognizedScore(await this.bridge.recognizeScoreImage(name, bytes));
      await this.ingestScoreFile(recognized.name, recognized.bytes, name, true);
      this.toast(
        'info',
        'Printed score imported',
        `Recognized in ${(recognized.elapsedMs / 1000).toFixed(1)}s. ${SCORE_IMAGE_SCOPE}`
      );
    } finally {
      this.runtime.set({ busy: null });
      if (this.runtime.get().screen === 'opening') this.renderOpening();
    }
  }

  private async ingestScoreFile(
    name: string,
    bytes: Uint8Array,
    displayName = name,
    printedScore = false
  ): Promise<void> {
    const parsed = parseScoreFile(bytes);
    const tracksWithNotes = parsed.tracks.filter((track) =>
      parsed.notes.some((note) => note.trackIndex === track.index)
    );
    const defaultTrack = tracksWithNotes.find((track) => !track.isPercussion) ?? tracksWithNotes[0];
    const chosenIndex =
      tracksWithNotes.length > 1
        ? await this.pickScorePart(tracksWithNotes, defaultTrack?.index ?? tracksWithNotes[0]?.index)
        : defaultTrack?.index;
    if (chosenIndex === null || chosenIndex === undefined) return;
    const primary = tracksWithNotes.find((track) => track.index === chosenIndex);
    if (!primary) throw new Error('That score file has no notes in it.');
    let notes = parsed.notes.filter((note) => note.trackIndex === primary.index);
    if (!notes.length) throw new Error('That score file has no playable notes in it.');
    const fretted = primary.staves.find((staff) => staff.tuningLowToHigh.length >= 2 && staff.showTablature);
    let reinterpretedOctave = false;
    if (printedScore) {
      const interpretation = await this.pickPrintedPitchInterpretation(!!fretted);
      if (interpretation === null) return;
      if (interpretation === 'written-octave') {
        notes = reinterpretWrittenOctave(notes, -12);
        reinterpretedOctave = true;
      }
    }

    this.settings.set({
      // A symbolic file describes its own pitches. Never let a Bass/Guitar
      // choice left over from the previous take invent tablature positions or
      // octave-fold a piano/violin part on import. The universal profile is a
      // concert-pitch staff; a future explicit "preserve source tab" choice can
      // opt back into the imported tuning deliberately.
      instrument: 'auto',
      tabMode: fretted ? 'custom' : 'off',
      capo: fretted?.capo ?? 0,
      ...(fretted ? { customTuningMidi: fretted.tuningLowToHigh } : {}),
      // A symbolic file brings its own grid; the current DAW tempo must not replace it.
      useHostGrid: false
    });
    this.setSource({
      name: displayName,
      durationSec: parsed.durationSec,
      peaks: null,
      trim: null,
      barOneSec: 0,
      tempoBpm: Math.round(parsed.tempoBpm),
      timeSignature: parsed.timeSignature,
      keyFifths: parsed.keyFifths,
      detected: { notes }
    });
    // Keep the original alphaTab playback graph for exact source MIDI: repeats, tempo map,
    // effects, and every source track. The on-screen Riffsheet remains one editable part.
    // Once the user explicitly reinterprets written bass/guitar notation, the recognized
    // file's original MIDI no longer represents the chosen sounding pitches. Export the live
    // canonical score instead of quietly restoring the unshifted source MIDI.
    this.sourceMidi = reinterpretedOctave ? null : parsed.midi();
    this.audioRef = { kind: 'midi', name: displayName, path: '', durationSec: parsed.durationSec };
    this.forgetAudioBytes();
    this.setPcm(null, 0);
    await this.bridge.unloadOriginal?.().catch(() => {});
    await this.bridge.pcmRetain?.(null).catch(() => {});
    this.transport.setOriginalAvailable(false, parsed.durationSec);
    this.goMain(displayName);
    this.rebuildNotation();

    if (tracksWithNotes.length > 1) {
      this.toast(
        'info',
        `Showing ${primary.name}`,
        `The editable sheet shows this one part. As played MIDI preserves all ${tracksWithNotes.length} source tracks.`
      );
    }
  }

  private pickPrintedPitchInterpretation(
    frettedSource: boolean
  ): Promise<'concert' | 'written-octave' | null> {
    return new Promise((resolve) => {
      const finish = (value: 'concert' | 'written-octave' | null) => {
        overlay.remove();
        resolve(value);
      };
      const option = (
        value: 'concert' | 'written-octave',
        title: string,
        detail: string,
        recommended: boolean
      ) =>
        el(
          'button',
          {
            class: `part-choice${recommended ? ' recommended' : ''}`,
            'data-pitch-interpretation': value,
            onClick: () => finish(value)
          },
          el('strong', { text: title }),
          el('span', { class: 'dim', text: detail })
        );
      const overlay = el(
        'div',
        { class: 'modal-backdrop', 'data-role': 'printed-pitch-picker', role: 'dialog', 'aria-modal': 'true' },
        el(
          'section',
          { class: 'part-picker' },
          el('h2', { text: 'How should the printed pitches sound?' }),
          el('p', { class: 'dim', text: 'Printed bass and guitar are often written an octave above how they sound. Choose explicitly; changing TAB later will not change pitch.' }),
          option('concert', 'Concert pitch', 'Use the recognized pitches exactly as printed and played.', !frettedSource),
          option('written-octave', 'Bass/guitar written octave', 'Keep the staff at the printed octave; playback and TAB sound one octave lower.', frettedSource),
          el('button', { text: 'Cancel import', onClick: () => finish(null) })
        )
      );
      this.root.appendChild(overlay);
      const recommended = frettedSource ? 'written-octave' : 'concert';
      (overlay.querySelector(`[data-pitch-interpretation="${recommended}"]`) as HTMLButtonElement | null)?.focus();
    });
  }

  private pickScorePart(
    tracks: Array<{ index: number; name: string; program: number; isPercussion: boolean; staves: Array<{ tuningLowToHigh: number[]; showTablature: boolean }> }>,
    defaultIndex: number
  ): Promise<number | null> {
    return new Promise((resolve) => {
      const finish = (value: number | null) => {
        overlay.remove();
        resolve(value);
      };
      const overlay = el(
        'div',
        { class: 'modal-backdrop', 'data-role': 'part-picker', role: 'dialog', 'aria-modal': 'true' },
        el(
          'section',
          { class: 'part-picker' },
          el('h2', { text: 'Choose the editable part' }),
          el('p', { class: 'dim', text: 'Riffsheet edits one part at a time. The original MIDI export will still keep every source track.' }),
          ...tracks.map((track) => {
            const fretted = track.staves.find((staff) => staff.showTablature && staff.tuningLowToHigh.length);
            return el(
              'button',
              {
                class: `part-choice${track.index === defaultIndex ? ' recommended' : ''}`,
                'data-track-index': String(track.index),
                onClick: () => finish(track.index)
              },
              el('strong', { text: track.name || `Part ${track.index + 1}` }),
              el('span', {
                class: 'dim',
                text: [
                  track.isPercussion ? 'Percussion' : `MIDI program ${track.program + 1}`,
                  `${track.staves.length} staff${track.staves.length === 1 ? '' : 's'}`,
                  fretted ? `TAB · ${tuningLabel(fretted.tuningLowToHigh)}` : 'Standard notation'
                ].join(' · ')
              })
            );
          }),
          el('button', { text: 'Cancel', onClick: () => finish(null) })
        )
      );
      this.root.appendChild(overlay);
      (overlay.querySelector(`[data-track-index="${defaultIndex}"]`) as HTMLButtonElement | null)?.focus();
    });
  }

  private async toggleCapture(): Promise<void> {
    // captureStop does not resolve until the worker has finished the durable WAV.
    // Ignore both another stop and a new start while that one request is pending.
    if (this.captureStopPending) return;

    const rt = this.runtime.get();

    if (rt.capturing || rt.captureArmed) {
      this.captureStopPending = true;
      this.renderOpening();

      try {
        const result = await this.bridge.captureStop();
        this.captureStopPending = false;
        this.unsubCapture?.();
        this.unsubCapture = null;
        this.runtime.set({ capturing: false, captureArmed: false, captureSec: 0 });
        if (result.durationSec < 0.25) {
          this.toast('danger', 'Capture', 'Nothing was recorded — is the track making sound?');
          this.renderOpening();
          return;
        }
        await this.ingest(result, 'Captured take');
      } catch (e) {
        this.captureStopPending = false;
        this.runtime.set({ capturing: false, captureArmed: false });
        this.toast('danger', 'Capture', (e as Error).message);
        this.renderOpening();
      }
      return;
    }

    try {
      this.unsubCapture = this.bridge.onCaptureState((state) => {
        this.runtime.set({
          capturing: state.phase === 'recording' || state.phase === 'finishing',
          captureArmed: state.phase === 'armed',
          captureSec: state.capturedSec
        });
        this.renderOpening();
      });
      // Armed by default — recording starts when the DAW transport rolls, so the user does
      // not have to catch it by hand.
      await this.bridge.captureStart({ armed: true });
    } catch (e) {
      this.unsubCapture?.();
      this.unsubCapture = null;
      this.runtime.set({ capturing: false, captureArmed: false });
      this.toast('danger', 'Capture', (e as Error).message);
      this.renderOpening();
    }
  }

  /** Everything that arrives — dropped file, picked file, captured take — funnels here. */
  private async ingest(input: AudioFileRef | CaptureResult, displayName?: string): Promise<void> {
    try {
      const name = displayName ?? ('name' in input ? input.name : 'Captured take');

      // --- MIDI: notes already known, no listening required -------------------
      if (!('pcm' in input) && input.bytes && isMidiFile(input.name, input.bytes)) {
        const parsed = parseMidi(input.bytes);
        if (parsed.notes.length === 0) throw new Error('That MIDI file has no notes in it.');
        const defaultTrack = parsed.tracks[0];
        if (!defaultTrack) throw new Error('That MIDI file has no playable tracks in it.');
        const chosenTrackIndex =
          parsed.tracks.length > 1
            ? await this.pickMidiPart(parsed.tracks, defaultTrack.index)
            : defaultTrack.index;
        if (chosenTrackIndex === null) return;
        const chosenTrack = parsed.tracks.find((track) => track.index === chosenTrackIndex);
        const notes = parsed.notes.filter((note) => note.sourceTrackIndex === chosenTrackIndex);
        if (!chosenTrack || notes.length === 0) {
          throw new Error('That MIDI track has no notes in it.');
        }
        this.settings.set({
          instrument: 'auto',
          tabMode: 'off',
          useHostGrid: false
        });
        this.setSource({
          name,
          durationSec: parsed.durationSec,
          peaks: null,
          trim: null,
          barOneSec: 0,
          tempoBpm: Math.round(parsed.tempoBpm),
          timeSignature: parsed.timeSignature,
          detected: { notes }
        });
        // A MIDI import has no audio behind it, so there is nothing to reopen on a restore
        // — the notes ARE the take, and they are in the blob.
        this.audioRef = { kind: 'midi', name, path: input.path, durationSec: parsed.durationSec };
        this.forgetAudioBytes();
        this.sourceMidi = new Uint8Array(input.bytes.slice(0));
        this.setPcm(null, 0);
        // Tell the shell to let the previous recording GO. Saying "there is no original" to our
        // own transport is not the same as saying it to the shell, and only this second one frees
        // anything: without it the audio side kept the last wav for the life of the plugin
        // instance — about 100 MB for a ten-minute take, stranded behind a MIDI import.
        await this.bridge.unloadOriginal?.().catch(() => {});
        await this.bridge.pcmRetain?.(null).catch(() => {});
        this.transport.setOriginalAvailable(false, parsed.durationSec);
        this.goMain(name);
        this.rebuildNotation();
        if (parsed.tracks.length > 1) {
          this.toast(
            'info',
            `Showing ${chosenTrack.name}`,
            `The editable sheet shows this one part. As played MIDI preserves all ${parsed.tracks.length} source tracks.`
          );
        }
        return;
      }

      // --- audio ---------------------------------------------------------------
      const pcm = await this.toPcm(input);
      const trim = pcm.pcm.length ? findTrim(pcm.pcm, pcm.sampleRate) : null;
      const peaks = pcm.pcm.length ? computePeaks(pcm.pcm, PEAK_BUCKETS) : null;
      const hostGrid = 'pcm' in input ? toHostGrid(input.captureContext) : undefined;
      // Anything the DAW was vague about during the take, said once and plainly. The shell
      // reports these as finished sentences precisely so they are shown rather than reduced
      // to a number nobody can question.
      const ambiguities = 'pcm' in input ? (input.captureContext?.ambiguities ?? []) : [];
      if (ambiguities.length > 0) {
        this.toast('info', 'About your DAW’s grid', ambiguities.join(' '));
      }

      this.setSource({
        name,
        durationSec: pcm.durationSec,
        peaks,
        trim,
        // Bar 1 defaults to the end of the leading silence; the marker overrides it.
        barOneSec: trim?.startOffsetSec ?? 0,
        hostGrid
      });

      // Both handles, because they expire differently: the token dies with the process, the
      // path outlives a saved project. Session restore tries them in that order.
      this.audioRef =
        'pcm' in input
          ? input.path
            ? {
                // Native captures are real 24-bit WAVs now. Treating one as an
                // ordinary file is what lets loadAudioPath() recover it after
                // the plugin process and its PCM token are both gone.
                kind: 'file',
                name,
                path: input.path,
                token: input.token,
                pcmUrl: input.pcmUrl,
                durationSec: pcm.durationSec
              }
            : {
                // Browser mock and old shells have no durable path. Keep the
                // legacy shape so those environments degrade honestly.
                kind: 'capture',
                name,
                path: '',
                token: input.token,
                pcmUrl: input.pcmUrl,
                durationSec: pcm.durationSec
              }
          : {
              kind: 'file',
              path: input.path,
              name,
              token: input.token,
              pcmUrl: input.pcmUrl,
              durationSec: pcm.durationSec
            };

      // Keep the decoded samples. The tuner analyses and plays them directly — it does not go
      // through the shell's transport, which can only play the whole take. They are also what
      // makes "what is ACTUALLY here?" answerable over a stretch the transcriber heard nothing
      // in, which is the entire point of the feature.
      this.setPcm(pcm.pcm, pcm.sampleRate);
      // The file's OWN bytes, when the app was handed them rather than a path, so a saved
      // document can carry the recording verbatim — an mp3 stays an mp3. A native open has only
      // a path here and leaves this null; `embeddedAudio()` re-encodes the decoded samples in
      // that case, which is a bigger file but still a self-contained one.
      if (!('pcm' in input) && input.bytes) this.rememberAudioBytes(new Uint8Array(input.bytes), name);
      else this.forgetAudioBytes();

      await this.bridge.loadOriginal(input);
      // Declare the take we are using. The shell no longer owns decoded audio — it keeps a take
      // alive exactly as long as somebody holds it — and a token is a string, not a reference,
      // so this is how the page says "still mine". Declarative: the full set every time, so a
      // swap interrupted halfway cannot leak the old one.
      if ('token' in input && input.token) await this.bridge.pcmRetain?.(input.token).catch(() => {});
      this.transport.setOriginalAvailable(true, pcm.durationSec);
      this.goMain(name);

      if ('name' in input) pushRecent({ name: input.name, path: input.path, at: Date.now() });

      await this.runTranscription(input, pcm.durationSec);
    } catch (e) {
      this.toast('danger', 'Could not open that', (e as Error).message);
      this.renderOpening();
    }
  }

  private pickMidiPart(
    tracks: Array<{ index: number; name: string; noteCount: number }>,
    defaultIndex: number
  ): Promise<number | null> {
    return new Promise((resolve) => {
      const finish = (value: number | null) => {
        overlay.remove();
        resolve(value);
      };
      const overlay = el(
        'div',
        { class: 'modal-backdrop', 'data-role': 'part-picker', role: 'dialog', 'aria-modal': 'true' },
        el(
          'section',
          { class: 'part-picker' },
          el('h2', { text: 'Choose the editable MIDI track' }),
          el('p', {
            class: 'dim',
            text: 'Riffsheet edits one track at a time. As played MIDI will still keep every source track.'
          }),
          ...tracks.map((track) =>
            el(
              'button',
              {
                class: `part-choice${track.index === defaultIndex ? ' recommended' : ''}`,
                'data-track-index': String(track.index),
                onClick: () => finish(track.index)
              },
              el('strong', { text: track.name }),
              el('span', {
                class: 'dim',
                text: `${track.noteCount} note${track.noteCount === 1 ? '' : 's'}`
              })
            )
          ),
          el('button', { text: 'Cancel', onClick: () => finish(null) })
        )
      );
      this.root.appendChild(overlay);
      (overlay.querySelector(`[data-track-index="${defaultIndex}"]`) as HTMLButtonElement | null)?.focus();
    });
  }

  private async toPcm(
    input: AudioFileRef | CaptureResult
  ): Promise<{ pcm: Float32Array; sampleRate: number; durationSec: number }> {
    if ('pcm' in input) {
      return { pcm: input.pcm, sampleRate: input.sampleRate, durationSec: input.durationSec };
    }
    if (input.pcmUrl) {
      // The shell keeps the decoded mono floats and serves them as binary — a few million
      // samples through the JSON bridge would be absurd.
      const pcm = new Float32Array(await (await fetch(input.pcmUrl)).arrayBuffer());
      return {
        pcm,
        sampleRate: input.sampleRate ?? 44100,
        durationSec: input.durationSec ?? pcm.length / (input.sampleRate ?? 44100)
      };
    }
    if (!input.bytes) {
      return { pcm: new Float32Array(0), sampleRate: 48000, durationSec: input.durationSec ?? 0 };
    }
    const buffer = await this.ctx.decodeAudioData(input.bytes.slice(0));
    if (buffer.duration < 0.25) throw new Error('That audio is shorter than a quarter of a second.');
    if (buffer.duration > 60 * 12) throw new Error('Longer than 12 minutes — split it in your DAW first.');
    return { pcm: buffer.getChannelData(0), sampleRate: buffer.sampleRate, durationSec: buffer.duration };
  }

  /**
   * Listen to the same recording again, and take whatever it says this time.
   *
   * Worth having because the engine is autoregressive: it does not necessarily give the same
   * answer twice on the same audio, so a second opinion is a real thing to ask for rather than
   * a pointless refresh. It is also the honest response to the transcriber's known failure
   * modes — it hallucinates past the end of the file, and it occasionally staples a run of
   * phantom notes onto a clip (design notes §3.5). When it does that, re-running costs nine
   * seconds; hand-editing sixty notes does not.
   *
   * Everything the player has done since is discarded, because it was made against notes that
   * are about to be replaced — so this asks first.
   */
  private async retranscribe(opts: { confirmed?: boolean } = {}): Promise<void> {
    const rt = this.runtime.get();
    const source = rt.source;
    const audio = this.audioRef;
    if (!source) return;
    // A job already running is CANCELLED rather than a reason to do nothing. This used to be a
    // bare `return`, which is the same silent no-op the engine cards had: press the control
    // while the previous run is still going and nothing at all happens, including no
    // explanation. Whoever pressed it wants this reading, not the one in flight.
    if (rt.progress !== null) {
      await this.bridge.transcribeCancel?.().catch(() => undefined);
    }
    // The handle is gone: a restore that could not re-open the original, or a file that has
    // moved since. This used to be a silent `return` behind a button that had already removed
    // itself, so the whole feature simply evaporated. Say so instead.
    if (!audio || audio.kind === 'midi') {
      this.toast(
        'danger',
        'Cannot listen again',
        'The original recording is not attached to this take any more, so there is nothing to re-read. Drop the file in again.'
      );
      return;
    }

    // `confirmed` is set by `chooseEngine()`, which has already asked this exact question and
    // named the engine in it. Asking twice for one gesture is how a confirm dialog gets
    // trained out of being read.
    const edits = this.editCursor + 1 + this.perfIndex;
    if (edits > 0 && !opts.confirmed) {
      const ok = await this.askConfirm(
        `Listening again will replace the notes with a fresh reading, and the ${edits} ` +
          `change${edits === 1 ? '' : 's'} you have made will go with them. Carry on?`,
        'Listen again'
      );
      if (!ok) return;
    }

    // Address the take the way ingest() did. The token is the ordinary case; the path is the
    // fallback after a project reload, exactly as `reopenOriginal` uses them.
    let ref: AudioFileRef | null = { path: audio.path, name: audio.name, token: audio.token };
    if (!audio.token && audio.path && this.bridge.loadAudioPath) {
      ref = await this.bridge.loadAudioPath(audio.path).catch(() => null);
    }
    // Neither handle answered, but a v2 document brought its recording WITH it — so the audio
    // is here even though the path is not (the file moved, or this is not the machine it was
    // made on). The path is still tried first because it is far cheaper than shipping tens of
    // megabytes across the bridge to re-stage bytes the shell may already hold.
    if (!ref?.token) ref = (await this.takeFromEmbeddedAudio()) ?? ref;
    if (!ref?.token) {
      const haveBytes = (this.audioBytes?.byteLength ?? 0) > 0;
      this.toast(
        'danger',
        'Cannot listen again',
        haveBytes && !this.bridge.loadAudioBytes
          ? 'This document still holds its recording, but this version of the app can only re-read a take from its original file, which could not be found. Update the app, or drop the file in again.'
          : 'The original recording is not available any more, so there is nothing to re-read. Drop the file in again.'
      );
      return;
    }

    await this.runTranscription(ref, source.durationSec);
  }

  /**
   * Mint a native take from the recording the document brought with it.
   *
   * THE GAP THIS CLOSES. A v2 `.riffsheet` embeds its audio, and everything that reads only
   * SAMPLES — waveform, the Original side of the fader, the tuner — has worked from those
   * bytes since. Transcription could not: it runs in the shell, the shell addresses audio by
   * token, and the only way to mint one was `loadAudioPath`. So "Listen again" still needed
   * the original file to be where the document said it was, which is precisely the assumption
   * embedding the audio existed to remove.
   *
   * Returns null — never throws — for all three ways this legitimately does not apply: no
   * embedded bytes, a shell too old to have the function, or bytes the shell will not decode.
   * The caller reports it; a failure here is a feature that is unavailable, not a broken app.
   */
  private async takeFromEmbeddedAudio(): Promise<AudioFileRef | null> {
    const bytes = this.audioBytes;
    // Feature-detected rather than assumed: the webview and the native shell are versioned
    // separately and skew in both directions.
    if (!bytes || bytes.byteLength === 0 || !this.bridge.loadAudioBytes) return null;

    const name = stagingNameForAudio(
      this.audioRef?.name || this.runtime.get().source?.name || 'recording',
      this.audioMime
    );
    const ref = await this.bridge.loadAudioBytes(name, bytes).catch(() => null);
    if (!ref?.token) return null;

    // A brand-new token, declared exactly as `reopenOriginal` declares the one it gets back
    // from a path reopen — otherwise nothing in the page holds the take we just made and it
    // could be swept out from under the transcription that is about to read it.
    await this.bridge.pcmRetain?.(ref.token).catch(() => {});
    // Remember it, so pressing Listen again twice does not re-ship the whole recording.
    if (this.audioRef) this.audioRef = { ...this.audioRef, token: ref.token, pcmUrl: ref.pcmUrl };
    return ref;
  }

  /**
   * Get the decoded samples back after the plugin window has been rebuilt.
   *
   * The shell serves them at a URL tied to the take's token, and the token outlives the editor —
   * the store lives on the processor, which the DAW does not destroy when you close the window.
   * A 404 means the token really has died (a project reload), and the caller has already fallen
   * back to reopening by path by then. Failure is silent on purpose: losing the tuner's audio is
   * not a reason to fail a restore that otherwise worked.
   */
  private async refetchPcm(pcmUrl: string | undefined): Promise<void> {
    if (!pcmUrl) return;
    try {
      const buffer = await (await fetch(pcmUrl)).arrayBuffer();
      const samples = new Float32Array(buffer);
      if (samples.length === 0) return;
      const duration = this.runtime.get().source?.durationSec ?? 0;
      // The rate is not in the URL; derive it from the length and the duration we already know.
      const rate = duration > 0 ? Math.round(samples.length / duration) : 44100;
      this.setPcm(samples, rate);
    } catch {
      /* the token died, or the shell is not serving it — the tuner will say there is no audio */
    }
  }

  private setPcm(pcm: Float32Array | null, sampleRate: number): void {
    this.pcm = pcm && pcm.length > 0 ? pcm : null;
    this.pcmRate = sampleRate;
    this.onsetResult = null;
    const generation = ++this.onsetGeneration;
    const samples = this.pcm;
    if (!samples || !(sampleRate > 0)) {
      this.waveform?.setOnsets(null);
      return;
    }

    // Let the decoded waveform paint first. The detector is fast for ordinary
    // riffs, but it is synchronous and a long take must not delay the first frame.
    window.setTimeout(() => {
      if (generation !== this.onsetGeneration) return;
      try {
        const result = detectOnsets(samples, sampleRate);
        if (generation !== this.onsetGeneration) return;
        this.onsetResult = result;
        this.waveform?.setOnsets(result);
        // The other half of the race: the attacks are what the pass reasons with, and they
        // arrive here rather than with the transcription.
        this.maybeRunAutoEditPass();
      } catch (e) {
        console.warn('[onsets] analysis failed', e);
      }
    }, 0);
  }

  /**
   * Open the tuner on a stretch of the recording.
   *
   * The one question it answers: *what is actually in this bit of audio, and does the sheet
   * agree?* The valuable case is a stretch the transcriber heard NOTHING in — which is why the
   * way in is dragging out a range on the waveform rather than clicking a note. There may be no
   * note to click, and that absence is the thing worth investigating.
   */
  private openTuner(fromSec: number, toSec: number): void {
    this.selection = { fromSec, toSec };
    this.tunerSelection = { fromSec, toSec };
    this.waveform?.setSelection(fromSec, toSec);
    this.mountTuner();
    // The span the player just dragged is what "Cut out" would act on (F16).
    this.refreshTakeEdits();
  }

  private closeTuner(): void {
    this.tunerSelection = null;
    this.refreshTakeEdits();
    this.tuner?.destroy();
    this.tuner = null;
    const host = this.root.querySelector<HTMLElement>('[data-role="tuner-host"]');
    if (host) {
      host.replaceChildren();
      host.hidden = true;
    }
    setTransientReserve(0);
    this.pianoRoll?.draw();
  }

  private mountTuner(): void {
    const range = this.tunerSelection;
    const host = this.root.querySelector<HTMLElement>('[data-role="tuner-host"]');
    if (!range || !host) return;
    this.tuner?.destroy();
    this.tuner = null;
    host.hidden = false;
    const empty = this.pianoRoll?.noteIdsInAudioRange(range.fromSec, range.toSec).length === 0;
    this.tuner = new Tuner(host, {
      getAudio: () => (this.pcm ? { pcm: this.pcm, sampleRate: this.pcmRate } : null),
      ctx: this.ctx,
      onClose: () => this.closeTuner(),
      onAddDetected: empty ? (midi) => this.addDetectedSegment(midi, range) : undefined
    });
    // THE PCM IS THE FILE, so the window handed to the tuner is the one place in this method
    // that speaks recording seconds — `range` is a selection on the edited page (F16).
    this.tuner.show(this.toAudioSec(range.fromSec), this.toAudioSec(range.toSec));
    this.tuner.setExpected(this.expectedMidiAt(range.fromSec));
    const measured = Math.round(host.getBoundingClientRect().height);
    // Halved with the panel itself (its CSS is 29-43px now, plus the host's 8px of padding).
    // These bounds exist so a measurement taken before layout settles cannot hand the roll a
    // silly number; they have to follow the panel or the roll would keep giving back twice the
    // room the strip is actually using.
    setTransientReserve(Math.max(29, Math.min(56, measured || 40)));
    this.pianoRoll?.draw();
  }

  private addDetectedSegment(midi: number, picked: { fromSec: number; toSec: number }): void {
    const score = this.runtime.get().score;
    if (!score) return;
    const segment = this.onsetBoundedSegment(picked);
    this.applyRollEdit({
      kind: 'add',
      startSec: segment.fromSec - this.originSec(score),
      durationSec: Math.max(0.04, segment.toSec - segment.fromSec),
      midi: Math.round(midi)
    });
    this.closeTuner();
  }

  private onsetBoundedSegment(picked: { fromSec: number; toSec: number }): { fromSec: number; toSec: number } {
    const duration = this.runtime.get().source?.durationSec ?? picked.toSec;
    const centre = (picked.fromSec + picked.toSec) / 2;
    const onsets = this.onsetResult?.onsets.map((o) => o.timeSec).sort((a, b) => a - b) ?? [];
    let fromSec = Math.max(0, picked.fromSec);
    let toSec = Math.min(duration, picked.toSec);
    for (const onset of onsets) {
      if (onset <= centre) fromSec = onset;
      else {
        toSec = onset;
        break;
      }
    }
    if (toSec <= fromSec + 0.04) toSec = Math.min(duration, fromSec + 0.1);
    return { fromSec, toSec };
  }

  /**
   * What the SHEET claims is sounding at a given moment of the recording.
   *
   * Both clocks are in play and mixing them up would make the tuner accuse the sheet of being
   * wrong every time (§4.13): the selection is in RECORDING seconds, the score is written from
   * bar 1. `scoreOriginSec` is the difference, and it is the same one the cursor, the synth and
   * the piano roll use.
   *
   * Returns null when nothing is written there — which is not a failure. "The sheet says
   * nothing is here, and here is what is actually here" is the most useful answer this feature
   * gives.
   */
  private expectedMidiAt(audioSec: number): number | null {
    const score = this.runtime.get().score;
    if (!score) return null;

    // THE PERFORMED LAYER, NOT THE ENGRAVED ONE.
    //
    // This used to walk the alphaTab graph and use `beat.absolutePlaybackStart` — the WRITTEN
    // position, the one the quantizer rounded onto a grid line. The player's click is on the
    // recording, and the two disagree by exactly as much as the quantizer moved the note: at a
    // 1/8 grid and 120 BPM that is up to 125 ms, which is more than the ±120 ms window below,
    // so the feature would name the NEIGHBOURING note — or nothing — precisely on the takes
    // whose timing is loose enough to be worth asking about.
    //
    // `synthNotesFor` is the same list the transport plays and the roll and the strip are drawn
    // against: engraved pitches, retimed onto the seconds they were actually played, already on
    // the recording's clock. Asking it means the note this names is the note you can hear under
    // the pointer, which is the entire promise of the feature.
    let best: { midi: number; gap: number } | null = null;
    for (const note of this.synthNotesFor(score)) {
      // Inside the note wins outright; otherwise take the nearest one, so clicking
      // just before an attack still tells you what is coming.
      const gap =
        audioSec >= note.startSec && audioSec < note.endSec
          ? 0
          : Math.min(Math.abs(audioSec - note.startSec), Math.abs(audioSec - note.endSec));
      if (gap > 0.12) continue;
      if (!best || gap < best.gap) best = { midi: note.midi, gap };
    }
    return best ? best.midi : null;
  }

  /**
   * Watch the listener, but only while there is something to watch.
   *
   * The engine is a Python process holding about a gigabyte, and the player's objection was
   * exactly that: it should not be sitting there when nothing is being transcribed. It now dies
   * the moment a transcription ends, and this is what makes that visible — a chip that appears
   * while it is up, says what it is costing, and disappears again on its own.
   *
   * The poll stops as soon as the engine does, so an idle plugin polls nothing — which is now
   * the normal state, not a five-minute exception. That is the whole reason it is gated on the
   * answer rather than on the screen being open.
   */
  private pollEngine(): void {
    if (!this.bridge.engineStatus) return;
    window.clearTimeout(this.engineTimer);
    void this.bridge
      .engineStatus()
      .then((status) => {
        const wasUp = this.engine?.state === 'ready' || this.engine?.state === 'starting';
        const isUp = status?.state === 'ready' || status?.state === 'starting';
        this.engine = status;
        if (wasUp !== isUp || (isUp && this.runtime.get().screen === 'main')) this.refreshEngineChip();
        // Only keep asking while it is actually running.
        if (isUp) this.engineTimer = window.setTimeout(() => this.pollEngine(), 10000);
      })
      .catch(() => {
        this.engine = null;
      });
  }

  /** Cheap in-place update — the header must not be rebuilt every ten seconds. */
  private refreshEngineChip(): void {
    const chip = this.root.querySelector<HTMLElement>('[data-role="engine-chip"]');
    if (!chip) {
      // A missing chip is only worth a rebuild when a rebuild could actually produce one.
      //
      // The header builds the chip on every main-screen render, but ONLY when the host can
      // also stop the engine. A host that offers `engineStatus` without `stopEngine` — the
      // browser mock, and any shell exposing one and not the other — therefore has no chip
      // to find, ever. Rebuilding anyway was an unbounded loop rather than a wasted render:
      // renderMain() ends by re-arming pollEngine(), whose promise resolves on a microtask
      // and calls straight back in here, so the renderer never yielded again. No paint, no
      // readiness flag, and no answer to the debugger — the whole tab simply stopped.
      //
      // The screen check is the other half: renderMain() paints the main screen without
      // setting `screen`, so reaching it from the opening screen replaced what the player
      // was looking at with a view the app did not believe it was showing.
      if (!this.bridge.stopEngine || this.runtime.get().screen !== 'main') return;
      this.renderMain();
      return;
    }
    const e = this.engine;
    const up = e && (e.state === 'ready' || e.state === 'starting');
    chip.style.display = up ? '' : 'none';
    if (!up || !e) return;
    const mb = typeof e.memoryMb === 'number' && e.memoryMb > 0 ? `${(e.memoryMb / 1024).toFixed(1)} GB` : 'running';
    chip.querySelector('[data-role="engine-text"]')!.textContent =
      e.state === 'starting' ? 'Listener starting…' : `Listener · ${mb}`;
    chip.classList.toggle('on', e.busy === true);
  }

  private async stopEngine(): Promise<void> {
    if (!this.bridge.stopEngine) return;
    const r = await this.bridge.stopEngine().catch(() => ({ stopped: false, reason: 'the engine did not answer' }));
    this.toast(
      // "Left running" is not a fault — it means somebody else is using it, or it is not ours
      // to stop — so it is never dressed as an error.
      'info',
      r.stopped ? 'Listener stopped' : 'Left running',
      r.stopped
        ? 'The transcription engine has been shut down and its memory given back. It starts again by itself the next time you transcribe something.'
        : r.reason,
      // AND A WAY OUT OF IT. "It is not Riffsheet's to stop" is a correct principle and, on its
      // own, a dead end: the person reading it is usually the same person who started that
      // server, they can see it holding well over a gigabyte, and the app has just explained
      // why it will not help. The refusal stays the default — nothing here happens without a
      // second, deliberate press — but the second press now exists.
      //
      // OFFERED FROM `canStopExternal`, AND FROM NOTHING ELSE. Not from `adopted`, not from
      // `externalServer` — BRIDGE.md is explicit about why: on Windows the listening process's
      // command line cannot be read, so the shell cannot prove what it is about to end and
      // refuses by design. There `externalServer` is true while `canStopExternal` is false, and
      // a button drawn from the first could only ever refuse. The capability test on the call
      // itself is the other half, for a shell that predates it.
      !r.stopped && this.bridge.stopExternalEngine && this.engine?.canStopExternal === true
        ? { label: 'Stop it anyway', role: 'stop-external-engine', run: () => void this.stopExternalEngine() }
        : undefined
    );
    this.pollEngine();
  }

  /**
   * Kill a listener Riffsheet did not start, having said so first.
   *
   * The only caller is the button on the "Left running" notice, and that is the whole safety
   * model: you cannot get here without having pressed Stop, read why it refused, and pressed
   * again. The shell still refuses mid-job — that rule has no override anywhere — so this can
   * come back with `stopped: false` and the reason is shown exactly as the first refusal was.
   */
  private async stopExternalEngine(): Promise<void> {
    if (!this.bridge.stopExternalEngine) return;
    const r = await this.bridge
      .stopExternalEngine()
      .catch(() => ({ stopped: false, reason: 'the engine did not answer' }));
    this.toast(
      'info',
      r.stopped ? 'Listener stopped' : 'Still running',
      r.stopped
        ? `${r.reason} Riffsheet starts its own the next time you transcribe something.`
        : r.reason
    );
    this.pollEngine();
  }

  /**
   * Everything the player's settings have to say about how the next take is listened to.
   *
   * One method rather than an object literal inside runTranscription() so that the test hook
   * below sends the same thing a real transcription sends. A probe that built its own options
   * would prove only that the probe can build options.
   */
  private transcribeOptions(): TranscribeOptions {
    const s = this.settings.get();
    return {
      preciseBeats: s.preciseBeats,
      // The two "before an engine listens" switches in Settings. They are real
      // transformations of the player's own recording, so they are the player's to
      // switch off — and the shell narrows them again per engine, because an engine
      // that normalises internally must be left alone whatever the switch says.
      normalizeBeforeTranscribe: s.normalizeBeforeTranscribe,
      correctTuningBeforeTranscribe: s.correctTuningBeforeTranscribe,
      // A HARD constraint on what the model may report, not a hint — so it is only set
      // when the player has actually said which instrument this is. Riffsheet used to pin
      // every take to `electric_bass` because it started life bass-first; the engine is
      // good across the board, and "Whatever it hears" must mean exactly that.
      instruments: [],
      // `engineId` is normally absent: which engine listens is a property of how somebody
      // works, not of one recording, so the shell resolves the global choice. See
      // TranscribeOptions.engineId.
      //
      // THE ONE EXCEPTION is a take the engine that runs in this page has just refused. It is
      // set for exactly that transcription and cleared afterwards, and it carries the id the
      // SHELL named (`nativeFallbackEngine`) rather than one guessed here — so the engine the
      // toast promised is the engine that listens.
      ...(this.fallbackEngineId ? { engineId: this.fallbackEngineId } : {})
    };
  }

  /**
   * Keep what the shell said it did to the audio before the engine heard it.
   *
   * Set from every finished run, including to '' when a run reported nothing: the sentence
   * describes the take that is on screen now, and a stale one would describe somebody else's.
   */
  private rememberPreprocess(result: TranscribeResult): void {
    this.runtime.set({ preprocessNote: result.preprocess?.note ?? '' });
  }

  private async runTranscription(
    input: AudioFileRef | CaptureResult,
    durationSec: number
  ): Promise<void> {
    const host = this.runtime.get().host;
    if (!host?.engineAvailable) {
      this.toast('info', 'No engine yet', 'Audio transcription needs a one-time setup. MIDI files work now.');
      return;
    }

    this.transcribeStartedAt = performance.now();
    // Honest ETA: measured rate x clip length, refined from real progress as it goes — not
    // a spinner pretending to know.
    const rate = host.transcribeRate ?? 0.4;
    this.runtime.set({ progress: 0, progressStage: 'listening', progressEtaSec: durationSec * rate });
    this.renderMain();

    try {
      // THE ENGINE THAT RUNS HERE. When the resolved engine is Riffsheet's own, the samples
      // are already on this side of the bridge and there is nothing to send anywhere: the
      // whole pass is a function call. It either produces notes in the same DTO shape the
      // bridge would have returned — in which case the rest of this method cannot tell the
      // difference — or it REFUSES, and the take is handed to the shell's next engine with a
      // sentence saying so. A refusal is a normal outcome, never an error.
      const local = await this.runLocalEngine(input, durationSec);
      if (local) {
        this.acceptTranscription(local);
        return;
      }

      const result = await this.bridge.transcribe(
        input,
        (p) => {
          const elapsed = (performance.now() - this.transcribeStartedAt) / 1000;
          const eta = p.progress > 0.03 ? elapsed / p.progress - elapsed : durationSec * rate;
          this.runtime.set({
            progress: p.progress,
            progressStage: p.stage ?? 'listening',
            // A queued job has not started, so an ETA built from elapsed-over-progress would
            // count the waiting as work and promise a finish time it cannot keep.
            progressEtaSec: p.stage === 'queued' ? null : Math.max(0, eta),
            progressQueuePosition: p.stage === 'queued' ? (p.queuePosition ?? 1) : 0
          });
          this.updateProgressUi();
        },
        this.transcribeOptions()
      );

      this.acceptTranscription(result);
    } catch (e) {
      this.runtime.set({ progress: null, progressEtaSec: null, progressQueuePosition: 0 });
      this.toast('danger', 'Transcription failed', (e as Error).message);
      this.renderMain();
    } finally {
      // One take, one fallback. Leaving it set would silently pin every later transcription to
      // the engine one chordal recording happened to need.
      this.fallbackEngineId = null;
    }
  }

  /**
   * Take a finished result — from the bridge or from the engine that runs here — and make it
   * the take on screen.
   *
   * Extracted so the two paths cannot drift. Everything below this line used to sit inside the
   * bridge call, and a second copy of it for the local engine would have been a second place to
   * forget to clear the undo stack.
   */
  private acceptTranscription(result: TranscribeResult): void {
    {
      this.runtime.set({ progress: null, progressEtaSec: null, progressQueuePosition: 0 });
      this.rememberPreprocess(result);
      const source = this.runtime.get().source;
      if (source) {
        const detectedBeatsPerBar = Number(result.beatGrid?.beatsPerBar);
        const detectedMeter =
          Number.isInteger(detectedBeatsPerBar) && detectedBeatsPerBar >= 1 && detectedBeatsPerBar <= 32
            ? { numerator: detectedBeatsPerBar, denominator: 4 }
            : undefined;
        this.runtime.set({
          source: {
            ...source,
            ...(result.tempoBpm ? { tempoBpm: Math.round(result.tempoBpm) } : {}),
            // Beat trackers detect periodic beats and their grouping, but not a notation
            // denominator. Riffsheet's audio convention is a quarter-note beat. An explicit
            // meter already attached to the source remains authoritative.
            timeSignature: source.timeSignature ?? detectedMeter,
            // Ids are assigned here from the detection index so they survive every later
            // pipeline re-run — the undo stack and the selection depend on that.
            detected: {
              notes: result.notes.map((n, i) => ({ ...n, id: `n${i}` })),
              beats: result.beats,
              downbeats: result.downbeats
            }
          }
        });
      }
      // A fresh engine result is a new canonical performance. Nothing from the old notation
      // graph or either undo layer may be replayed onto it, even when this was Listen again.
      this.undoStack.clear();
      this.editLog = [];
      this.editCursor = -1;
      this.perfStack = [];
      this.perfIndex = 0;
      this.history = [];
      this.historyIndex = -1;
      if (result.notes.length === 0) {
        this.toast('info', 'Nothing heard', 'No notes were detected. Try a louder or cleaner recording.');
      }
      // `keepEdits:false` also seeds performance undo from the notes that just arrived. Seeding
      // in setSource() happened before detection and made the first undo erase a transcription.
      this.rebuildNotation({ keepEdits: false });
      this.renderMain();
      // A fresh transcription clears every outstanding highlight and re-runs the pass over the
      // new performance — including on Listen again, which is exactly when somebody wants a
      // second opinion. It runs when the attack detector has also finished, in whichever order
      // the two land; see `maybeRunAutoEditPass`.
      this.clearAutoEdits();
      this.autoPassPending = true;
      this.maybeRunAutoEditPass();
    }
  }

  /**
   * Run Riffsheet's own engine, here, on the samples this page already holds.
   *
   * Returns a result in the bridge's own shape, or NULL meaning "not my job" — either because
   * the resolved engine is somebody else's, or because this one listened and refused. Both
   * cases send the caller down the ordinary bridge path; a refusal also names the engine that
   * is about to get the take and says so out loud, because a transcription that quietly came
   * from a different engine than the card says is the kind of surprise that costs trust.
   *
   * WHY THE PCM IS ALREADY HERE: `setPcm` holds the decoded mono samples for the tuner, the
   * waveform and the attack detector. The engine wants exactly those, so the local path sends
   * nothing over the bridge and answers in well under a second on a 30-second take.
   */
  private async runLocalEngine(
    input: AudioFileRef | CaptureResult,
    durationSec: number
  ): Promise<TranscribeResult | null> {
    if (this.engineList?.resolvedEngine !== RIFFSHEET_ENGINE_ID) return null;

    const pcm = this.pcm;
    const rate = this.pcmRate;
    if (!pcm || !(rate > 0)) {
      // The samples have not arrived (or this take came in as MIDI). Nothing is wrong; the
      // shell's engines read the file for themselves, so hand it over without a word.
      this.fallbackEngineId = this.engineList?.nativeFallbackEngine ?? null;
      return null;
    }

    const s = this.settings.get();
    const pass = transcribeRiffsheet(pcm, rate, {
      // The plausible-range prior, from what the player said they are holding. Empty when TAB
      // is off, and that is the point: nobody has told us what instrument this is, and an
      // invented range would be worse than no range — see the octave guard's own comment.
      tuningLowToHigh: this.engineTuningMidi(),
      maxFret: s.maxFret,
      durationSec: durationSec > 0 ? durationSec : undefined
    });

    if (!pass.ok) {
      const nextId = this.engineList?.nativeFallbackEngine ?? '';
      const nextName = this.engineList?.engines.find((e) => e.id === nextId)?.name ?? 'another engine';
      this.fallbackEngineId = nextId || null;
      this.toast(
        'info',
        pass.refusal.kind === 'polyphony' ? 'Sounded like chords' : 'Not a single-note line',
        `${pass.refusal.reason} Handed to ${nextName}.`
      );
      return null;
    }

    // Beats are not this engine's job and never were: the shell's tracker runs for every engine
    // and is better at it than anything here would be. `trackBeats` is the one call that reaches
    // it without starting a transcription nobody wants. A shell too old to have it, or a browser
    // with no shell at all, simply gets notes and no grid — which is what the mock has always
    // returned anyway.
    let beats: number[] | undefined;
    let downbeats: number[] | undefined;
    let tempoBpm: number | undefined;
    let beatsPerBar: number | null | undefined;
    if (this.settings.get().preciseBeats && this.bridge.trackBeats) {
      try {
        const grid = await this.bridge.trackBeats(input);
        if (grid.beats.length > 0) {
          beats = grid.beats;
          downbeats = grid.downbeats.length > 0 ? grid.downbeats : undefined;
          tempoBpm = grid.bpm ?? undefined;
          beatsPerBar = grid.beatsPerBar;
        }
      } catch {
        /* a missing grid is a worse sheet, not a failed transcription */
      }
    }

    return {
      notes: pass.notes.map((n) => ({
        startSec: n.startSec,
        endSec: n.endSec,
        midi: n.midi,
        confidence: n.confidence
      })),
      ...(beats ? { beats } : {}),
      ...(downbeats ? { downbeats } : {}),
      ...(tempoBpm ? { tempoBpm } : {}),
      ...(beats
        ? {
            beatGrid: {
              bpm: tempoBpm ?? 0,
              beatsPerBar: beatsPerBar ?? null,
              firstDownbeat: downbeats?.[0],
              beats
            }
          }
        : {}),
      durationSec
    };
  }

  /**
   * The open strings the local engine's octave guard reasons about, or nothing.
   *
   * NOTHING when TAB is off, deliberately: with no tab the player has not said what instrument
   * this is, and applying a bass range to a recording of something else would turn a correct
   * reading into a confident wrong one. The guard is written to do nothing at all with an empty
   * list, so "we were not told" and "we were told nothing useful" are the same answer.
   */
  private engineTuningMidi(): number[] {
    const s = this.settings.get();
    if (s.tabMode === 'off') return [];
    if (s.tabMode === 'custom') {
      const custom = customTuning(s.customTuningMidi);
      return custom.midiLowToHigh.length >= 2 ? custom.midiLowToHigh : [];
    }
    const remembered = tuningById(s.tuningId);
    if (remembered.instrument === s.tabMode) return remembered.midiLowToHigh;
    return TUNING_PRESETS.find((preset) => preset.instrument === s.tabMode)?.midiLowToHigh ?? [];
  }

  private setSource(source: SourceAudio): void {
    this.selection = null;
    this.tunerSelection = null;
    this.tuner?.destroy();
    this.tuner = null;
    // A new take is a new question (F16): whoever waved the offer away did so about the LAST
    // recording, and this one may be four seconds of hiss before the first note.
    this.trimChipDismissed = false;
    this.runtime.set({ source, selection: [] });
    this.transport.setLoop(false);
    this.transport.setLoopRange(null, null);
    this.loopBarNumber = null;
    this.undoStack.clear();
    // A new take is a new session. The edit log goes with the stack it mirrors, and the
    // audio handle is re-stated by whichever branch of ingest() we came from.
    this.editLog = [];
    this.editCursor = -1;
    this.audioRef = null;
    this.forgetAudioBytes();
    this.sourceMidi = null;
    // A different take has a different pitch range; keeping the old scroll position would open
    // the roll looking at empty air.
    this.rollView = null;
    // A new performance means the old note ids describe nothing. Both undo layers go with it,
    // and so does everything the auto-edit pass had to say about the take being replaced.
    this.addedNoteCount = 0;
    this.autoNoteCount = 0;
    this.autoPassPending = false;
    this.clearAutoEdits();
    this.resetHistories();
  }

  // =========================================================================
  // Session persistence — surviving the editor being destroyed
  //
  // In a DAW the plugin editor is destroyed whenever the user clicks another track, and
  // with it the WebView and every object in this file. The host's processor is not, so the
  // app writes itself down there on every meaningful change and reads itself back on boot.
  // The whole contract, and why the blob holds what it holds, is in app/persist.ts.
  // =========================================================================

  /** Everything worth keeping, as one blob. */
  private snapshot(): PersistedSession {
    return {
      v: SESSION_VERSION,
      app: 'riffsheet',
      savedAt: Date.now(),
      source: encodeSource(this.runtime.get().source),
      audio: this.audioRef,
      sourceMidi: this.sourceMidi ? bytesToBase64(this.sourceMidi) : undefined,
      settings: this.settings.get(),
      view: { blend: this.transport.blend },
      edits: this.editLog,
      editCursor: this.editCursor
    };
  }

  /**
   * Queue a save.
   *
   * Called from meaningful mutations only — a new take, a rebuilt sheet, an edit, an undo,
   * a setting, the fader. Deliberately NOT from the transport subscription, which fires
   * with every animation frame during playback and would turn a debounce into a treadmill.
   */
  private scheduleSave(): void {
    // Mid-restore the state is half-assembled; saving it would overwrite the good blob
    // with a worse one. Before there is a take there is nothing worth writing down.
    if (this.restoring || !this.runtime.get().source) return;
    this.session.save(this.snapshot());
  }

  /**
   * Put back whatever the last editor left behind — after asking.
   *
   * Note what does NOT happen here: no transcription. The detected notes came back in the
   * blob, so the sheet is rebuilt by the same cheap path a settings change uses.
   *
   * AND IT IS NEVER SILENT ANY MORE. This used to restore without a word, which is right
   * exactly once — the case it was built for, a DAW destroying the editor when you click
   * another track, where the work reappearing IS the fix. It is wrong every other time. Open
   * the plugin on a new track and last week's riff is on screen, apparently belonging to a
   * project it has nothing to do with; try to start something new and the app has already
   * decided what you are working on. Worst of all it is unclearable: the way to get rid of it
   * is to notice it is there and find "Close current work".
   *
   * So it asks, with two real answers and no default. "Start fresh" clears the stored copy for
   * good, because a fresh start that leaves the old work waiting to ambush the next boot is
   * not one. The Main menu's own "Resume current work" is untouched — that is about work
   * still open in this window, which is a different question with a different answer.
   */
  private async restoreSession(opts: { auto?: boolean } = {}): Promise<boolean> {
    if (!this.session.canLoad) return false;

    const blob = await this.session.load();
    if (!blob || !hasRestorableTake(blob)) return false;

    // The drop zone was already on screen while that call was in flight. If the user got in
    // first, their file wins: replacing something somebody just dropped with a take from an
    // hour ago would be the same bug wearing different clothes.
    if (this.runtime.get().source) return false;

    const source = decodeSource(blob.source);
    if (!source) return false;

    // `auto` is for the persistence probe only — `bootSecondApp()` is testing that a blob
    // written by one app comes back identically in another, and a dialog in the middle of
    // that is a different test wearing its clothes. Nothing a player can reach sets it; the
    // prompt itself is exercised by `__RIFFSHEET_RESUMEPROMPT__`, both ways.
    if (!opts.auto && !(await this.askResume(source.name, blob.savedAt))) {
      // Not "leave it and hope". A person who has said Start fresh has said it about this
      // blob, and a blob that survives is one that asks the same question again tomorrow.
      await this.session.clear();
      return false;
    }
    // A second check, because the question took time to answer: they may have dropped a file
    // while the prompt was up. Same rule as above — what they just did wins.
    if (this.runtime.get().source) return false;
    // v1 session blobs stored these globally. Move them onto the restored take once, then the
    // normal save path writes the per-take shape and they can never leak into another source.
    source.tempoBpm ??= blob.settings.tempoBpm;
    source.timeSignature ??= blob.settings.timeSignature;
    source.keyFifths ??= blob.settings.keyFifths;

    this.restoring = true;
    try {
      // Settings first: the sheet is built from them, so restoring them afterwards would
      // mean engraving twice and briefly showing the wrong one.
      //
      // Through the DOCUMENT path, not the preferences one. A session blob holds the effective
      // settings of the take that was on screen, which may themselves have come from a
      // .riffsheet — so restoring it must put that take back without deciding anything about
      // the player's preferences file, and without a blob's own version number re-arming a
      // migration this profile has already been through.
      this.applyDocumentSettingsToStore(blob.settings);
      this.audioRef = blob.audio;
      try {
        this.sourceMidi = blob.sourceMidi ? base64ToBytes(blob.sourceMidi) : null;
      } catch {
        this.sourceMidi = null;
      }
      this.runtime.set({ source, score: null, selection: [] });
      this.resetHistories();
      this.undoStack.clear();
      this.editLog = [];
      this.editCursor = -1;
      this.transport.setBlend(blob.view.blend);

      const original = await this.reopenOriginal(blob.audio);
      this.transport.setOriginalAvailable(original.available, source.durationSec);

      this.goMain(source.name);
      this.rebuildNotation();
      this.replayEdits(blob.edits, blob.editCursor);

      // Said once, plainly, and only when something really is missing. Silence would leave
      // the player wondering why the Original side of the fader does nothing.
      if (original.message) this.toast('info', 'Picked up where you left off', original.message);
      this.restored = true;

      // A restore does not otherwise rewrite the blob — nothing changed, and `savedAt`
      // churn is noise. The one exception is a take that had to be reopened by path: the
      // token is new, and without writing it down every future restore repeats the lookup.
      if (this.audioRef?.token !== blob.audio?.token) {
        this.restoring = false;
        this.scheduleSave();
      }
      return true;
    } catch (e) {
      // A restore is a convenience. If it goes wrong the app must still open.
      console.error('[riffsheet] session restore failed', e);
      this.runtime.set({ screen: 'opening', source: null, score: null });
      this.renderOpening();
      return false;
    } finally {
      this.restoring = false;
    }
  }

  /**
   * "You were working on X. Pick it up, or start fresh?"
   *
   * Named after the file and dated, because "previous work" on its own is not enough to decide
   * with — the answer changes completely depending on whether it is the riff from five minutes
   * ago or one from a fortnight back that has nothing to do with today.
   *
   * Escape and the backdrop resolve to RESUME (`dismissIs: true`), which is the conservative
   * side: dismissing a dialog is not consent to delete anything, and resuming is undoable by
   * closing the work while starting fresh is not undoable at all.
   */
  private askResume(name: string, savedAt: number): Promise<boolean> {
    const when = savedAt > 0 ? ` from ${relativeTime(savedAt)}` : '';
    return this.askConfirm(
      `You have unfinished work on “${name}”${when}. Pick up where you left off, or start fresh?`,
      'Resume previous work',
      { cancelText: 'Start fresh', dismissIs: true, role: 'resume-prompt' }
    );
  }

  /**
   * Get the original recording back behind the fader, if it can be got back at all.
   *
   * Two handles, tried in the order they expire. The token is the ordinary case — the
   * editor died, the processor did not, and the decoded audio is still sitting in it. The
   * path is the project-reload case, where nothing native survived but the filesystem.
   */
  private async reopenOriginal(audio: PersistedAudio | null): Promise<{ available: boolean; message?: string }> {
    this.originalRestoredBy = 'not-tried';
    if (!audio) {
      // The blob carried no audio handle at all. That is a DIFFERENT fault from "the handle
      // was there and did not work", and telling them apart is most of the diagnosis.
      this.originalRestoredBy = 'no-handle-in-blob';
      return { available: false };
    }
    if (audio.kind === 'midi') {
      this.originalRestoredBy = 'midi-import';
      return { available: false };
    }

    if (audio.token) {
      try {
        const state = await this.bridge.loadOriginal({ path: audio.path, name: audio.name, token: audio.token });
        if (state.durationSec > 0) {
          await this.refetchPcm(audio.pcmUrl);
          this.originalRestoredBy = 'token';
          return { available: true };
        }
        // Answered, but with nothing in it. Worth its own name: it means the shell no longer
        // holds that token, which is not the same as the call failing.
        this.originalRestoredBy = 'token-empty';
      } catch (e) {
        this.originalRestoredBy = `token-threw: ${(e as Error).message}`;
      }
    } else {
      this.originalRestoredBy = 'no-token';
    }

    if (audio.path && this.bridge.loadAudioPath) {
      try {
        const ref = await this.bridge.loadAudioPath(audio.path);
        if (ref) {
          // Remember the NEW token and the new sample URL, or the next restore repeats this.
          this.audioRef = { ...audio, token: ref.token, pcmUrl: ref.pcmUrl };
          // A brand-new token from a fresh decode: declare it, or the take we just reopened
          // would be held by nothing and could be swept.
          if (ref.token) await this.bridge.pcmRetain?.(ref.token).catch(() => {});
          const state = await this.bridge.loadOriginal(ref);
          if (state.durationSec > 0) {
            await this.refetchPcm(ref.pcmUrl);
            this.originalRestoredBy = 'path';
            return { available: true };
          }
          this.originalRestoredBy = 'path-empty';
        } else {
          this.originalRestoredBy = 'path-not-found';
        }
      } catch (e) {
        // Moved, renamed, or on a drive that is not plugged in — but say which, because
        // "the file is gone" and "the call failed" want different fixes.
        this.originalRestoredBy = `path-threw: ${(e as Error).message}`;
      }
    }

    return {
      available: false,
      message:
        audio.kind === 'capture'
          ? 'Your sheet and your edits are back. The captured audio itself is not — capture the track again to hear the original.'
          : 'Your sheet and your edits are back, but the original recording could not be reopened, so the Original side of the fader is silent.'
    };
  }

  /**
   * Re-apply the user's edits over a freshly built score.
   *
   * The redo tail beyond the cursor is dropped on purpose: redo needs actions that have
   * been performed and undone, and re-performing them just to undo them again would be
   * theatre the user could see.
   */
  private replayEdits(edits: EditSpec[], cursor: number): void {
    const upTo = Math.min(cursor, edits.length - 1);
    if (upTo < 0) return;

    const ctx = this.editContext();
    if (!ctx) return;

    for (let i = 0; i <= upTo; i++) {
      const action = createEditAction(edits[i]);
      if (!action) continue;
      const result = this.undoStack.perform(action, ctx);
      // An action that refused (a pitch off the end of the neck, a nudge into an occupied
      // beat) is not on the stack, so it must not be in the log either.
      if (result.requiresRerender || result.requiresMidiUpdate) this.editLog.push(edits[i]);
    }
    this.editCursor = this.editLog.length - 1;
    this.reconcileHistory();
    this.refreshUndoRedo();
    if (this.editCursor < 0) return;

    // One re-render for the lot, not one per edit.
    this.triview?.rerenderAfterEdit();
    // The roll is a second view of the same model and does not go through `applyResult` on
    // this path, so it is refreshed here for the same reason: it draws the LIVE sheet, and a
    // restored session that skipped this would come back showing the notes as transcribed
    // rather than as the player left them. See view/pianoroll.ts §2.
    this.pianoRoll?.refresh();
    this.triview?.refreshMidi();
    const score = this.runtime.get().score;
    if (score) {
      this.pushScoreNotes(score);
    }
  }

  /**
   * What the session looks like from outside, for the harness.
   *
   * Deliberately a FINGERPRINT rather than a screenshot: "the plugin came back" means the
   * same notes in the same places with the same edits on them, and pixels cannot say that
   * while a hash of every note's id, string, fret and beat can.
   */
  sessionProbe(): unknown {
    const rt = this.runtime.get();
    const score = rt.score;
    const s = this.settings.get();
    const r3 = (n: number) => Number(n.toFixed(3));
    const index = this.triview?.scoreIndex;
    const rows = index
      ? [...index.idToNote.entries()]
          .map(([id, n]) => `${id}:${n.string}:${n.fret}:${n.beat.voice.bar.index}:${n.beat.index}`)
          .sort()
      : [];

    return {
      restored: this.restored,
      canSave: this.session.canSave,
      canLoad: this.session.canLoad,
      screen: rt.screen,
      sourceName: rt.source?.name ?? null,
      durationSec: r3(rt.source?.durationSec ?? 0),
      barOneSec: r3(rt.source?.barOneSec ?? 0),
      detectedNotes: rt.source?.detected?.notes.length ?? 0,
      peakBuckets: rt.source?.peaks?.max.length ?? 0,
      bars: score?.ir.bars.length ?? 0,
      noteGlyphs: score?.ir.stats.noteGlyphs ?? 0,
      tempoBpm: score ? r3(score.tempoBpm) : null,
      timeSig: score ? `${score.timeSignature.numerator}/${score.timeSignature.denominator}` : null,
      midiBytes: score ? score.midi(true).length : 0,
      // Every note's identity AND its place on the neck. Pitch edits, string moves, nudges
      // and deletions all move this number; a re-render on its own does not.
      notesFingerprint: hashString(rows.join('|')),
      noteCount: rows.length,
      edits: this.editCursor + 1,
      editKinds: this.editLog.slice(0, this.editCursor + 1).map((e) => e.kind),
      blend: r3(this.transport.blend),
      // --- the original recording, and whether it came back --------------------------
      // The reported bug is "I closed the plugin window and it forgot the original sound".
      // The sheet demonstrably survives that (proved three ways in v1.1), so the fault is
      // somewhere in the handful of steps that reopen the AUDIO — and none of those steps were
      // observable from outside, which is exactly why the bug outlived two attempts to find it.
      // Every one of them is reported here, so the answer is a field rather than a theory.
      audioKind: this.audioRef?.kind ?? null,
      audioHasToken: !!this.audioRef?.token,
      audioHasPath: !!this.audioRef?.path,
      audioHasPcmUrl: !!this.audioRef?.pcmUrl,
      /** True when the shell says it is holding audio for us right now. */
      originalAvailable: this.transport.originalAvailable,
      /** How the reopen went, in one word. Set by `reopenOriginal`. */
      originalRestoredBy: this.originalRestoredBy,
      /** The decoded samples the tuner needs. 0 means the tuner has nothing to measure. */
      pcmSamples: this.pcm?.length ?? 0,
      settings: {
        playbackVoice: s.playbackVoice,
        showPianoRoll: s.showPianoRoll,
        showNoteNames: s.showNoteNames,
        grid: s.grid,
        rollGrid: s.rollGrid,
        rollSnapToGrid: s.rollSnapToGrid,
        tabMode: s.tabMode,
        tuningId: s.tuningId,
        customTuningMidi: [...s.customTuningMidi],
        clefMode: s.clefMode,
        maxFret: s.maxFret,
        capo: s.capo
      },
      // The two per-DOCUMENT knobs the notation toolbar writes, next to the tempo and meter
      // above. `keyFifths` is what the user asked for (undefined = Auto) and `scoreKeyFifths`
      // is what the sheet came out in, which is the only way to tell an accepted override
      // from an ignored one.
      keyFifths: rt.source?.keyFifths ?? null,
      scoreKeyFifths: score?.ir.key?.fifths ?? null,
      scoreCapo: score?.capo ?? null
    };
  }

  // =========================================================================
  // Demo (browser only)
  // =========================================================================

  /** Skip file intake, but run the REAL pipeline on a synthetic performance. */
  loadDemo(which: string): void {
    const params = new URLSearchParams(location.search);
    const bars = Number(params.get('bars') ?? 8);
    // Verification can ask for a specific notation surface without changing the product
    // default. The demo is the browser test fixture; making TAB explicit keeps that fixture
    // honest now that tablature is a user-selected view rather than a transcription mode.
    const demoTab = params.get('tab');
    if (demoTab === 'bass' || demoTab === 'guitar') {
      const tuning = TUNING_PRESETS.find((preset) => preset.instrument === demoTab);
      this.settings.set({ tabMode: demoTab, ...(tuning ? { tuningId: tuning.id } : {}) });
    }
    // 'droptuned' dips below the low E of the default tuning, so the pipeline has to fold
    // those tab positions up an octave — the case the 8va markers exist for.
    const performance =
      which === 'straight'
        ? straightRiff(bars)
        : which === 'droptuned'
          ? dropTunedRiff(bars)
          : tripletRiff(bars);
    const name = `demo — ${which} riff, ${bars} bars`;

    // A lead-in of silence, so the auto-trim region and the bar-1 marker are exercised too.
    const leadInSec = 0.9;
    const notes = performance.notes.map((n) => ({
      ...n,
      startSec: n.startSec + leadInSec,
      endSec: n.endSec + leadInSec
    }));
    const total = performance.durationSec + leadInSec;

    this.setSource({
      name,
      durationSec: total,
      peaks: synthPeaks(notes, total, PEAK_BUCKETS),
      trim: { startOffsetSec: leadInSec, endSec: total, durationSec: total, trivial: false },
      barOneSec: leadInSec,
      detected: { notes, beats: performance.beats.map((b) => b + leadInSec) }
    });
    this.transport.setOriginalAvailable(false, total);
    this.goMain(name);
    this.rebuildNotation();

    (window as unknown as { __RIFFSHEET_DEMO_READY__?: boolean }).__RIFFSHEET_DEMO_READY__ = true;
  }

  /**
   * Verification-only hooks, installed only for `?verify=1`.
   *
   * Most inspect the current score, while a small number deliberately drive edits, exports,
   * and persistence before restoring what they changed. None belong in the shipping plugin.
   */
  private installTestHooks(): void {
    /**
     * THE CLAIM: re-stating the tempo in a different beat must not change how fast it plays.
     *
     * The BPM box shows the tempo in the beat the signature is written in, so switching 4/4 to
     * 6/8 turns "120" into "240". That is a relabelling, and the way to prove it is a
     * relabelling rather than a speed change is to dump what the app would actually SCHEDULE
     * on either side of the switch and compare the two lists.
     *
     * `synthNotesFor()` is the exact list handed to `transport.setScoreNotes()` — the thing
     * that makes sound — so this is not a model of playback, it is playback's own input. The
     * signature is put back before returning, so the probe leaves the take as it found it.
     */
    /**
     * THE CLAIM (#36): the Quantize menu writes the SHEET and touches nothing else.
     *
     * It is checked the only way a claim about "and nothing else" can be: by walking the menu
     * through four values and dumping, at each one, the exact three things that could have
     * moved — what the roll is drawing, what the synth would play, and what the sheet came out
     * as. The first must not change, the third must, and the middle one is reported rather than
     * asserted (see `scheduleByGrid` below).
     *
     * `feedIsRawObjectWhenSnapOff` is the playback-unchanged proof, and it is a stronger one
     * than comparing two dumps: with Snap to grid off, `performanceFeed()` returns the take's
     * own array BY IDENTITY, so the fourth argument reaching `scoreToSynthNotes` is not merely
     * equal to what it was before this feature existed — it is the same object.
     *
     * Everything is put back before returning, so the probe leaves the take as it found it.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_SNAPFEED__ = () => {
      try {
        const source = this.runtime.get().source;
        if (!source?.detected || !this.runtime.get().score) return { error: 'no take' };
        const s = this.settings.get();
        const original = { grid: s.grid, rollGrid: s.rollGrid, rollSnapToGrid: s.rollSnapToGrid };
        const r6 = (n: number) => Number(n.toFixed(6));

        const readOut = () => {
          const score = this.runtime.get().score;
          return {
            feed: this.rollFeedNotes()
              .map((n) => `${n.id}@${r6(n.startSec)}-${r6(n.endSec)}:${n.midi}`)
              .join('|'),
            schedule: score
              ? this.synthNotesFor(score)
                  .map((n) => `${r6(n.startSec)}-${r6(n.endSec)}:${n.midi}`)
                  .join('|')
              : '',
            sheet: score ? `${score.ir.stats.noteGlyphs}/${score.ir.stats.restGlyphs}/${score.ir.bars.length}` : ''
          };
        };
        const at = (next: Partial<AppSettings>) => {
          this.settings.set(next);
          this.rebuildNotation({ keepEdits: true });
          return readOut();
        };

        // --- #36: four Quantize values over one performance ----------------------
        this.settings.set({ rollSnapToGrid: false });
        const grids = ['auto', 'quarter', 'free', 'thirtysecond'] as const;
        const byGrid = grids.map((grid) => ({ grid, ...at({ grid }) }));
        const feedIsRawObjectWhenSnapOff =
          this.performanceFeed() === this.runtime.get().source?.detected?.notes;

        // --- #41: the snap layer, switched on and off and re-sized ---------------
        const snapOff = at({ grid: original.grid, rollGrid: 'eighth', rollSnapToGrid: false });
        const snapOn = at({ rollSnapToGrid: true });
        const snapFine = at({ rollGrid: 'sixteenth' });
        const snapBack = at({ rollGrid: 'eighth' });
        const snapOffAgain = at({ rollSnapToGrid: false });

        this.settings.set(original);
        this.rebuildNotation({ keepEdits: true });

        return {
          // THE ACCEPTANCE TEST: the roll's note list is byte-identical at every Quantize value.
          feedStableAcrossGrids: new Set(byGrid.map((g) => g.feed)).size === 1,
          // …and the sheet is not, or the line above would be true for the wrong reason.
          sheetChangedAcrossGrids: new Set(byGrid.map((g) => g.sheet)).size > 1,
          // REPORTED, NOT ASSERTED. Playback is assembled from the engraved score and retimed to
          // the performance, so a Quantize value that engraves a different set of notes can
          // legitimately schedule a different set — that was true before #36 and is unchanged by
          // it. The invariant that IS asserted is the identity check below.
          scheduleByGrid: byGrid.map((g) => ({ grid: g.grid, schedule: g.schedule })),
          feedIsRawObjectWhenSnapOff,
          byGrid,
          snapMovesTheFeed: snapOn.feed !== snapOff.feed,
          snapChangesPlayback: snapOn.schedule !== snapOff.schedule,
          finerGridDiffers: snapFine.feed !== snapOn.feed,
          resnapFromRaw: snapBack.feed === snapOn.feed,
          snapRoundTripsToRaw: snapOffAgain.feed === snapOff.feed
        };
      } catch (e) {
        return { error: (e as Error).message };
      }
    };

    (window as unknown as Record<string, unknown>).__RIFFSHEET_TEMPOUNIT__ = (
      numerator: number,
      denominator: number
    ) => {
      try {
        const source = this.runtime.get().source;
        const score = this.runtime.get().score;
        if (!source || !score) return { error: 'no score' };
        const original = score.timeSignature;

        const readOut = () => {
          const s = this.runtime.get().score;
          const box = this.root.querySelector<HTMLInputElement>('[data-role="bpm"]');
          const unit = this.root.querySelector<HTMLElement>('[data-role="bpm-unit"]');
          return {
            storedBpm: s ? Number(s.tempoBpm.toFixed(6)) : null,
            shownBpm: box ? Number(box.value) : null,
            unit: unit ? (unit.textContent ?? '').trim() : null,
            timeSig: s ? `${s.timeSignature.numerator}/${s.timeSignature.denominator}` : null,
            // Rounded to the microsecond: this is a comparison of two schedules, and a float
            // that differs in its last bit is not a tempo change.
            schedule: s ? this.synthNotesFor(s).map((n) => Number(n.startSec.toFixed(6))) : []
          };
        };

        const before = readOut();
        this.runtime.set({ source: { ...source, timeSignature: { numerator, denominator } } });
        this.releaseHostGrid('time signature');
        this.rebuildNotation();
        this.renderMain();
        const after = readOut();

        // Put it back, by the same door.
        const restored = this.runtime.get().source;
        if (restored) this.runtime.set({ source: { ...restored, timeSignature: original } });
        this.rebuildNotation();
        this.renderMain();

        return {
          before,
          after,
          restored: readOut().timeSig,
          scheduleIdentical:
            before.schedule.length === after.schedule.length &&
            before.schedule.every((v, i) => v === after.schedule[i])
        };
      } catch (e) {
        return { error: String(e) };
      }
    };

    /**
     * Open a real recording, through the real door, so re-reading it can be tested.
     *
     * The demo fixtures are note lists with no audio behind them, which makes every gesture
     * that means "listen to this again" unreachable in a browser — including the one this wave
     * is about, where choosing an engine re-transcribes with it. This builds a couple of
     * seconds of WAV and hands it to `openFile()`, the same method a drop or a file dialog
     * calls, so what follows is the ordinary ingest: decode, transcribe, engrave, and an
     * `audioRef` the app can re-open by path.
     *
     * Nothing here is a shortcut around the code under test. It is a file, and the app opens
     * it the way it opens files.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_OPENAUDIO__ = async () => {
      try {
        const rate = 22050;
        const seconds = 2;
        const frames = rate * seconds;
        const pcm = new Int16Array(frames);
        for (let i = 0; i < frames; i++) {
          const sec = i / rate;
          // Four plucks a beat apart at 110 Hz, decaying — enough for the onset pass to find
          // something and quiet enough that the level switch has real work to do.
          const pluck = Math.floor(sec / 0.5);
          const since = sec - pluck * 0.5;
          const env = Math.exp(-since * 6);
          pcm[i] = Math.round(0.28 * env * Math.sin(2 * Math.PI * 110 * sec) * 32767);
        }
        const header = new ArrayBuffer(44);
        const view = new DataView(header);
        const ascii = (at: number, text: string) => {
          for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
        };
        ascii(0, 'RIFF');
        view.setUint32(4, 36 + pcm.byteLength, true);
        ascii(8, 'WAVE');
        ascii(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        ascii(36, 'data');
        view.setUint32(40, pcm.byteLength, true);

        const file = new File([header, pcm.buffer], 'harness-take.wav', { type: 'audio/wav' });
        await this.openFile(file);
        return {
          opened: this.runtime.get().source?.name ?? null,
          notes: this.runtime.get().source?.detected?.notes.length ?? 0,
          // What makes re-reading possible at all: a path the shell (or the mock) can serve back.
          hasHandle: !!this.audioRef && this.audioRef.kind !== 'midi',
          path: this.audioRef?.path ?? null
        };
      } catch (e) {
        return { error: String((e as Error).message ?? e) };
      }
    };

    /**
     * Start a re-transcription and DO NOT wait for it.
     *
     * The one state that cannot be reached by clicking, from outside: a job actually in
     * flight. Every control that claims to cancel one — Start over, and choosing an engine —
     * is only interesting while something is running, and awaiting the gesture that starts it
     * means it has already finished by the time the next line runs.
     *
     * It presses the same method the Main menu's row presses, with the question already
     * answered, and returns as soon as the app reports itself busy.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_STARTJOB__ = async () => {
      void this.retranscribe({ confirmed: true });
      // Up to a second for the bridge call to be made and `progress` to appear. Returning
      // before that would hand the harness a race rather than a running job.
      for (let i = 0; i < 40 && this.runtime.get().progress === null; i++) {
        await new Promise((ok) => setTimeout(ok, 25));
      }
      return { running: this.runtime.get().progress !== null };
    };

    // Exercise the export paths, so `npm run verify` covers them too.
    (window as unknown as Record<string, unknown>).__RIFFSHEET_SELFTEST__ = () => {
      try {
        const score = this.runtime.get().score;
        if (!score) return { error: 'no score was built' };
        const quantized = score.midi(true);
        const asPlayed = this.sourceMidi ?? score.midi(false);
        const xml = score.musicxml();
        return {
          bars: score.ir.bars.length,
          noteGlyphs: score.ir.stats.noteGlyphs,
          restDensity: Number(score.ir.stats.restDensity.toFixed(3)),
          tempoBpm: score.tempoBpm,
          timeSig: `${score.timeSignature.numerator}/${score.timeSignature.denominator}`,
          noteIds: [...(this.triview?.scoreIndex?.idToNote.keys() ?? [])].slice(0, 4),
          midiHeaderOk: String.fromCharCode(...quantized.slice(0, 4)) === 'MThd',
          midiQuantizedBytes: quantized.length,
          midiAsPlayedBytes: asPlayed.length,
          midiVariantsDiffer: quantized.length !== asPlayed.length,
          musicxmlOk: xml.includes('score-partwise'),
          musicxmlBytes: xml.length,
          // The beat track the sheet was actually built on. A steady grid is evenly
          // spaced; a tracked one is not — which is how "did preciseBeats reach the
          // pipeline?" can be answered from outside.
          beatCount: score.beatTimesSec?.length ?? 0,
          firstBeats: (score.beatTimesSec ?? []).slice(0, 8).map((b) => Number(b.toFixed(4))),
          diagnostics: score.diagnostics
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      }
    };
    /**
     * The engine that runs in this page, driven over two synthetic takes.
     *
     * The two facts worth protecting from outside, and neither can be seen any other way:
     * a MONOPHONIC take comes back as notes, and a CHORDAL one comes back as a REFUSAL rather
     * than as a tidy, confident, wrong single line. The second is the whole reason this engine
     * is allowed to be the default — a monophonic transcriber that cannot tell it is being
     * handed a chord produces its worst output in exactly the case it should decline.
     *
     * The fixtures are built here rather than shipped as WAVs because they have to be exact:
     * six plucks at known pitches, and the same six with a fifth on top of each. The hiss floor
     * is not decoration — `onsets.ts` documents a bare harmonic stack as its worst case (window
     * leakage becomes the detection function), and a fixture with no floor would be testing a
     * signal no microphone has ever produced.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_LOCALENGINE__ = () => {
      const rate = 44100;
      const roots = [45, 43, 41, 45, 43, 40];
      const amps = [0.4, 0.55, 0.3, 0.16, 0.09, 0.05];
      const phases = [0, 0.7, 1.9, 2.6, 0.4, 1.3];
      const take = (withFifth: boolean): Float32Array => {
        const pcm = new Float32Array(rate * 6);
        const pluck = (atSec: number, midi: number, gain: number) => {
          const from = Math.round(atSec * rate);
          const hz = 440 * Math.pow(2, (midi - 69) / 12);
          for (let k = 0; k + from < pcm.length; k++) {
            const t = k / rate;
            if (t > 0.8) break;
            const env = Math.exp(-t * 2.6) * (1 - Math.exp(-t * 300)) * Math.min(1, (0.8 - t) * 20);
            let v = 0;
            for (let p = 0; p < amps.length; p++) {
              v += amps[p] * Math.exp(-t * (1.2 + p * 0.9)) * Math.sin(2 * Math.PI * hz * (p + 1) * t + phases[p]);
            }
            pcm[from + k] += gain * env * v * 0.5;
          }
        };
        roots.forEach((midi, i) => {
          pluck(0.3 + i * 0.9, midi, 1);
          if (withFifth) pluck(0.3 + i * 0.9, midi + 7, 0.9);
        });
        // A deterministic hiss floor at about -55 dBFS. See the note above.
        let seed = 12345;
        for (let i = 0; i < pcm.length; i++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          pcm[i] += ((seed / 0x7fffffff) * 2 - 1) * 0.0018;
        }
        return pcm;
      };
      const describe = (pcm: Float32Array) => {
        const r = transcribeRiffsheet(pcm, rate, { tuningLowToHigh: [28, 33, 38, 43] });
        return r.ok
          ? {
              ok: true,
              notes: r.notes.length,
              midis: r.notes.map((n) => n.midi),
              minConfidence: Math.min(...r.notes.map((n) => n.confidence)),
              contested: r.stats.contested
            }
          : { ok: false, kind: r.refusal.kind, reason: r.refusal.reason, contested: r.stats.contested };
      };
      return { mono: describe(take(false)), chord: describe(take(true)) };
    };
    /**
     * One real transcription call, made the way the app makes it, reported both ways.
     *
     * Two things this proves that nothing else can. First, that the options the player's
     * settings describe — the two "before an engine listens" switches especially — actually
     * reach the bridge: `sent` is what the app handed over, and the mock writes down what it
     * received (`__RIFFSHEET_MOCKBRIDGE__`), so the harness compares two independent readings
     * of the same call rather than one side's opinion of itself. Second, that the receipt
     * coming back is kept: `note` is read out of the runtime store, which is where the
     * Settings panel reads it from.
     *
     * Deliberately does NOT touch the score. It runs the bridge call and the one line that
     * remembers the answer, and leaves the sheet, the undo stack and the source exactly as
     * they were, so this can sit anywhere in the harness run without disturbing what follows.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_TRANSCRIBEPROBE__ = async (
      engineId?: string
    ) => {
      try {
        // A short synthetic take: three plucks, loud enough to be heard and quiet enough
        // (about −20 dBFS) that a level pass has something real to correct.
        const sampleRate = 44100;
        const durationSec = 0.6;
        const pcm = new Float32Array(Math.round(sampleRate * durationSec));
        for (let i = 0; i < pcm.length; i++) {
          const sec = i / sampleRate;
          const pluck = Math.floor(sec / 0.2);
          const since = sec - pluck * 0.2;
          pcm[i] = 0.1 * Math.exp(-since * 12) * Math.sin(2 * Math.PI * 110 * (pluck + 1) * sec);
        }
        const options: TranscribeOptions = {
          ...this.transcribeOptions(),
          // Named only when the caller names one, which is what a per-take "listen again with
          // this engine" would do. Nothing in the product sends it yet (see transcribeOptions
          // above); this is what proves the field still survives the bridge for the day it does.
          ...(engineId ? { engineId } : {})
        };
        const result = await this.bridge.transcribe(
          { pcm, sampleRate, durationSec, path: '' },
          undefined,
          options
        );
        this.rememberPreprocess(result);
        return {
          notes: result.notes.length,
          // Per-note confidence used to be dropped at the bridge. Counted, not rendered.
          withConfidence: result.notes.filter((n) => typeof n.confidence === 'number').length,
          preprocess: result.preprocess ?? null,
          note: this.runtime.get().preprocessNote,
          sent: options,
          selectedEngineId: this.settings.get().engineId
        };
      } catch (e) {
        return { error: String((e as Error).message ?? e) };
      }
    };
    // The print path is the riskiest thing in the app to leave untested: it is a SECOND
    // alphaTab instance, and the spike found that a second worker-backed instance never
    // renders. This exercises it for real (build the document, do not open a dialog).
    (window as unknown as Record<string, unknown>).__RIFFSHEET_PDFTEST__ = async () => {
      try {
        const score = this.runtime.get().score;
        if (!score) return { error: 'no score' };
        const html = await buildPrintDocument(score, { title: 'spike' });
        return {
          bytes: html.length,
          svgCount: (html.match(/<svg/g) ?? []).length,
          hasInlinedBravura: html.includes('@font-face') && html.includes('data:font/woff2;base64,'),
          hasNoteGlyphs: (html.match(/<text/g) ?? []).length > 20,
          // Counting <text> elements is not enough, and that is how this shipped broken:
          // alphaTab leaves the music font to a document CSS rule, so a serialised SVG can
          // be full of glyph <text> and still print a page of empty boxes. What has to be
          // true is that the font travels WITH the markup. See export/pdf.ts.
          glyphsCarryFont: (html.match(/font-family: alphaTab/g) ?? []).length
        };
      } catch (e) {
        return { error: String((e as Error).message ?? e) };
      }
    };
    // The real PDF, byte for byte. This is the path the button takes in the plugin — the
    // print document above is only the browser fallback now — so it is the one that has to
    // be proven: a `%PDF` header, one page object per engraved page, and an image stream
    // big enough to actually contain a stave.
    (window as unknown as Record<string, unknown>).__RIFFSHEET_PDFBYTES__ = async (
      includeBytes = false
    ) => {
      try {
        const score = this.runtime.get().score;
        if (!score) return { error: 'no score' };
        const bytes = await renderScorePdf(score, { title: 'harness' });
        const head = String.fromCharCode(...bytes.subarray(0, 8));
        const tail = String.fromCharCode(...bytes.subarray(Math.max(0, bytes.length - 32)));
        // Scan as latin1 rather than decoding: the image streams are binary.
        let text = '';
        for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
        return {
          bytes: bytes.length,
          header: head.startsWith('%PDF-'),
          trailer: tail.includes('%%EOF'),
          pages: (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length,
          images: (text.match(/\/Subtype\s*\/Image/g) ?? []).length,
          filter: /\/Filter\s*\/(\w+)/.exec(text)?.[1] ?? null,
          // Off by default — a whole PDF through the debugger protocol on every run is
          // wasteful. An integration harness that wants to open the file asks for it.
          base64: includeBytes ? btoa(text) : undefined
        };
      } catch (e) {
        return { error: String((e as Error).message ?? e) };
      }
    };
    // Sound sources: which one is selected, whether the sampled bass actually loaded, and
    // — the part that matters — that a missing sample set degrades instead of throwing.
    // The fallback is silent by design, so without this the harness cannot tell a working
    // sampler from a working fallback.
    (window as unknown as Record<string, unknown>).__RIFFSHEET_SOUND__ = async () => {
      // Bad path first, so the real load leaves the status where the UI expects it.
      const broken = new SampledBass(this.ctx, new URL('samples/not-here/', document.baseURI).href);
      const brokenLoaded = await broken.load();
      const brokenNotes = broken.schedule(this.ctx.destination, 40, this.ctx.currentTime + 60, 0.5, 0.8);

      const probe = new SampledBass(this.ctx);
      const loaded = await probe.load();
      const status = sampleStatus();
      return {
        voice: this.settings.get().playbackVoice,
        expected: FINGER_BASS_SAMPLES.length,
        samplesLoaded: loaded,
        state: status.state,
        loaded: status.loaded ?? 0,
        message: status.message ?? null,
        fallbackLoaded: brokenLoaded,
        fallbackScheduled: brokenNotes.length,
        fallbackReady: broken.ready
      };
    };
    /**
     * Drive the MIDI export menu for real, with the save stubbed.
     *
     * This is the reported bug's regression test: cancelling the native panel used to
     * produce an "Exported" toast anyway. Stubbing the bridge rather than the UI means the
     * popover, the remembered choice and the toast rule are all exercised on the same path
     * a click takes.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_EXPORTPROBE__ = async (
      label: string,
      saved: boolean
    ) => {
      const bridge = this.bridge as unknown as Record<string, unknown>;
      const realOne = bridge.exportFile;
      const realMany = bridge.exportFiles;
      const names: string[] = [];
      // Counted separately from the file names: "one dialog, two files" is the whole point
      // of the Both option, and only a call count can tell them apart.
      let dialogs = 0;
      const outcome = (count: number) => (saved ? { saved: true, path: '/stub/riff', count } : { saved: false });

      bridge.exportFile = async (name: string) => {
        dialogs++;
        names.push(name);
        return outcome(1);
      };
      if (realMany) {
        bridge.exportFiles = async (files: Array<{ name: string }>) => {
          dialogs++;
          for (const f of files) names.push(f.name);
          return outcome(files.length);
        };
      }

      const toastsBefore = this.runtime.get().toasts.length;
      try {
        this.root.querySelector<HTMLElement>('[data-role="export-menu-button"]')?.click();
        const menu = document.querySelector('[data-role="export-menu"]');
        const items = [...(menu?.querySelectorAll<HTMLElement>('.menu-item') ?? [])];
        const item = items.find((i) => i.textContent?.includes(label));
        if (!item) return { error: `no menu item for ${label}`, items: items.map((i) => i.textContent) };
        item.click();
        // The click handler is fire-and-forget; give the promise chain a turn to settle.
        await new Promise((ok) => setTimeout(ok, 120));
        return {
          dialogs,
          names,
          toastsAdded: this.runtime.get().toasts.length - toastsBefore,
          remembered: this.settings.get().midiExportMode,
          menuClosed: !document.querySelector<HTMLElement>('[data-role="export-menu"]')?.offsetParent
        };
      } finally {
        bridge.exportFile = realOne;
        if (realMany) bridge.exportFiles = realMany;
      }
    };
    // Where the note-names row actually landed, measured from the rendered DOM rather
    // than recomputed. The row collided with the tab once (reported from the field, and
    // visible in the screenshot the harness writes); this is how the harness proves it
    // does not any more, at every viewport it tests.
    (window as unknown as Record<string, unknown>).__RIFFSHEET_LAYOUT__ = () =>
      this.triview?.layoutProbe() ?? null;
    // The piano roll's own view of itself, plus the transport position so a synthetic
    // click on the roll can be checked end to end.
    (window as unknown as Record<string, unknown>).__RIFFSHEET_PIANOROLL__ = () => {
      const pane = this.root.querySelector('.pianoroll-pane');
      const handle = this.root.querySelector<HTMLElement>('[data-role="roll-resize"]');
      return {
        pane: !!pane,
        visible: !!pane && !pane.classList.contains('off'),
        toggle: !!this.root.querySelector('.pianoroll-toggle'),
        paneHeight: pane ? Math.round(pane.getBoundingClientRect().height) : 0,
        // The drag handle, and whether it is really grabbable: a resize affordance with no
        // ns-resize cursor is one nobody discovers.
        handle: !!handle,
        handleCursor: handle ? getComputedStyle(handle).cursor : null,
        handleHeight: handle ? Math.round(handle.getBoundingClientRect().height) : 0,
        // What has actually been written down, as opposed to what is on screen right now.
        savedHeight: this.settings.get().pianoRollHeight,
        viewportH: window.innerHeight,
        // The pane's neighbour: the roll growing must never be the sheet disappearing.
        triviewHeight: Math.round(
          this.root.querySelector('.triview')?.getBoundingClientRect().height ?? 0
        ),
        roll: this.pianoRoll?.probe() ?? null,
        // The other two strips on the same ruler. All three together are what "they line up"
        // actually means, and a number is the only way to assert it without a pair of eyes.
        sheet: this.triview?.viewport() ?? null,
        wave: this.waveform?.probe() ?? null,
        zoom: this.triview?.getZoom() ?? null,
        positionSec: Number(this.transport.state.positionSec.toFixed(3))
      };
    };

    /**
     * Is a note drawn on the roll directly under the notehead that produced it?
     *
     * The user's first complaint, made checkable. For each of the first few notes it reports
     * the roll's x and the sheet's x for the SAME note id, on screen, and the gap between
     * them. Zero is the claim; anything else is the bug, in pixels.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_ALIGN__ = () => {
      const roll = this.pianoRoll;
      const tv = this.triview;
      const score = this.runtime.get().score;
      const map = this.sheetMap();
      if (!roll || !tv || !score || !map) return { error: 'nothing rendered yet' };
      const rollProbe = roll.probe();
      // Asked of the SHEET, by note id — not recomputed from the same map the roll used, which
      // would compare a number with itself and always agree.
      const noteX = (tv as unknown as { noteContentX?: (id: string) => number | null }).noteContentX;
      const rows = roll
        .paintedRects()
        .filter((r) => r.noteId !== null)
        .slice(0, 8)
        .map((r) => {
          const sheetX = noteX?.call(tv, r.noteId as string) ?? null;
          const sheetScreenX = sheetX === null ? null : sheetX - map.scrollLeft;
          return {
            noteId: r.noteId,
            // The rect's LEFT edge is its onset; the notehead is drawn centred on the same
            // onset, so the comparison is against the rect's left edge plus nothing. Any
            // constant offset here would be a fudge factor hiding a real disagreement.
            rollX: r.x,
            sheetX: sheetScreenX,
            deltaPx: sheetScreenX === null ? null : Number((r.x - sheetScreenX).toFixed(2))
          };
        });
      const deltas = rows.map((r) => r.deltaPx).filter((d): d is number => typeof d === 'number');
      return {
        linked: rollProbe.linkedActive,
        zoom: tv.getZoom(),
        scrollLeft: map.scrollLeft,
        compared: deltas.length,
        worstDeltaPx: deltas.length ? Math.max(...deltas.map(Math.abs)) : null,
        rows
      };
    };

    // Where the roll actually painted its rectangles, with note ids. Geometry rather than a
    // count, so a synthetic click can be aimed at a real note.
    (window as unknown as Record<string, unknown>).__RIFFSHEET_ROLLRECTS__ = () =>
      this.pianoRoll?.paintedRects() ?? null;

    // The tuner's own view of itself, and the pitch detector's accuracy measured HERE rather
    // than on the machine it was written on — the second one makes the accuracy table in the
    // report re-checkable from inside the plugin.
    (window as unknown as Record<string, unknown>).__RIFFSHEET_TUNER__ = () => this.tuner?.probe() ?? null;
    (window as unknown as Record<string, unknown>).__RIFFSHEET_WAVE__ = () => this.waveform?.probe() ?? null;

    /**
     * Tied notes — one note, several noteheads, one id.
     *
     * The reported bug was that the first of a tied pair "was not clickable" and editing the
     * second did nothing to the tab. Both were the same fault: the id map kept the LAST
     * notehead, and the last one of a tie carries no fret digit. This reports the shape so a
     * regression is a failed check rather than a bug report six weeks later.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_TIES__ = () => {
      const index = this.triview?.scoreIndex;
      if (!index) return { error: 'no score' };
      const chains = [...index.idToNotes.entries()].map(([id, notes]) => ({ id, count: notes.length }));
      const tied = chains.filter((c) => c.count > 1);
      const sample = tied[0] ? index.idToNotes.get(tied[0].id)! : null;

      // --- names belong to attacks, not to noteheads ------------------------------------
      // Counted from the SCORE, then compared with what the row actually drew. Two numbers
      // that must agree, and the second is measured off the DOM rather than recomputed, so a
      // disagreement between the rule and the rendering shows up as a number.
      let attacks = 0;
      let noteheads = 0;
      const model = this.triview?.model;
      if (model) {
        for (const track of model.tracks) {
          for (const staff of track.staves) {
            for (const bar of staff.bars) {
              for (const voice of bar.voices) {
                for (const beat of voice.beats) {
                  if (beat.isEmpty) continue;
                  for (const n of beat.notes) {
                    noteheads++;
                    if (!n.isTieDestination) attacks++;
                  }
                }
              }
            }
          }
        }
      }
      // A pitch struck again is NOT a tie destination, so it must still be counted as an
      // attack. This is the number that tells "fixed" apart from "labels deleted": if the
      // filter were wrong, restruck notes would vanish from the row too.
      let restruckAttacks = 0;
      if (model) {
        for (const track of model.tracks) {
          for (const staff of track.staves) {
            for (const bar of staff.bars) {
              for (const voice of bar.voices) {
                const beats = voice.beats;
                for (let i = 1; i < beats.length; i++) {
                  for (const n of beats[i].notes) {
                    const sameBefore = beats[i - 1].notes.some(
                      (p) => soundingMidi(index, p) === soundingMidi(index, n)
                    );
                    if (sameBefore && !n.isTieDestination) restruckAttacks++;
                  }
                }
              }
            }
          }
        }
      }

      // …AND THE NAMES THEY WERE GIVEN, measured off the DOM rather than argued for.
      //
      // The check that used to guard this was `attacks >= restruckAttacks`, which is true by
      // construction — a restruck attack IS an attack — so it passed whatever the row drew.
      // This is the claim it was trying to make: every re-struck pitch has its own name in the
      // row. Counted as a multiset so two identical names cannot cover for one missing one.
      const drawn = [...this.root.querySelectorAll('.note-name')].map((n) => n.textContent ?? '');
      const drawnCounts = new Map<string, number>();
      for (const text of drawn) drawnCounts.set(text, (drawnCounts.get(text) ?? 0) + 1);
      const accidentals = accidentalsForKey(this.runtime.get().score?.ir.key.fifths);
      let restruckNamed = 0;
      if (model) {
        for (const track of model.tracks) {
          for (const staff of track.staves) {
            for (const bar of staff.bars) {
              for (const voice of bar.voices) {
                const beats = voice.beats;
                for (let i = 1; i < beats.length; i++) {
                  for (const n of beats[i].notes) {
                    const sameBefore = beats[i - 1].notes.some(
                      (p) => soundingMidi(index, p) === soundingMidi(index, n)
                    );
                    if (!sameBefore || n.isTieDestination) continue;
                    const name = midiToName(soundingMidi(index, n), accidentals);
                    const left = drawnCounts.get(name) ?? 0;
                    if (left > 0) {
                      drawnCounts.set(name, left - 1);
                      restruckNamed++;
                    }
                  }
                }
              }
            }
          }
        }
      }

      return {
        attacks,
        noteheads,
        /** Tied continuations. Every one of these used to get its own name. */
        continuations: noteheads - attacks,
        restruckAttacks,
        /** How many of those actually have a name of their own in the row. Must equal the above. */
        restruckNamed,
        /** What the row actually drew. Must equal `attacks`. */
        labelsDrawn: drawn.length,
        ids: chains.length,
        tiedIds: tied.length,
        maxGlyphsPerId: chains.reduce((m, c) => Math.max(m, c.count), 0),
        // The first glyph of a tie must be the one that is NOT a tie destination, because that
        // is the one carrying the fret number. If this is ever true, the map is back to front.
        firstIsTieDestination: sample ? sample[0].isTieDestination === true : null,
        // And `idToNote` must agree with the head of the chain.
        headMatchesIdToNote: sample ? index.idToNote.get(tied[0].id) === sample[0] : null,
        // Every glyph of a held note must share one string and fret, or the sheet contradicts
        // itself. Checked across every tied note, not just the sample.
        chainsDisagreeing: tied.filter((c) => {
          const ns = index.idToNotes.get(c.id)!;
          return ns.some((n) => n.string !== ns[0].string || n.fret !== ns[0].fret);
        }).length
      };
    };

    /**
     * THE SETTINGS CLOBBER, driven end to end as it was reported.
     *
     * The scenario, in the reporter's own order: choose a Quantize setting, open a document
     * written by an older build, and find the choice gone — replaced by the document's value,
     * written to the preferences file, and in the v10 case flipped to 'free' by a one-time
     * migration re-firing off the document's version number.
     *
     * What this drives is the exact path `ingestRiffsheetDocument` takes (`applyDocumentSettingsToStore`)
     * rather than a re-implementation of it, and it reads the answer out of `localStorage`,
     * which is the only place "the user's preferences" actually lives. It then makes an
     * unrelated change WHILE the document is open, because the second half of the bug is a
     * delayed clobber: a blanket write-back would put the document's values on disk at the
     * next click rather than at the open.
     *
     * Everything is put back before it returns — the store, the overrides and the file — so a
     * verification run is not left holding somebody else's grid.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_DOCSETTINGS__ = () => {
      const readStored = (): Partial<AppSettings> => {
        try {
          return JSON.parse(localStorage.getItem('riffsheet.settings') ?? '{}') as Partial<AppSettings>;
        } catch {
          return {};
        }
      };
      const before = { ...this.settings.get() };
      const overridesBefore = new Set(this.documentOverrides);
      try {
        // 1. The player chooses. Deliberately NOT the default, and deliberately a value the
        //    v10 migration would overwrite if it ever ran again.
        this.settings.set({ grid: 'quarter' });
        const chosen = readStored().grid ?? null;

        // 2. They open a document written by a build old enough to predate every migration,
        //    carrying a grid of its own and one unrelated view setting.
        this.applyDocumentSettingsToStore({
          settingsVersion: 1,
          grid: 'auto',
          showNoteNames: !before.showNoteNames
        } as Partial<AppSettings>);
        const openedEffective = this.settings.get().grid;
        const openedStored = readStored().grid ?? null;

        // 3. They change something else while it is open.
        this.settings.set({ alignViews: !this.settings.get().alignViews });
        const afterUnrelatedEdit = readStored().grid ?? null;

        // 4. …and then set the grid themselves, which is the one thing that MAY write it.
        this.settings.set({ grid: 'sixteenth' });
        const afterOwnEdit = readStored().grid ?? null;

        return {
          /** What the player chose. */
          chosen,
          /** The document's own value, in force for the open document. */
          openedEffective,
          /** The preferences file, immediately after the open. Must still be the choice. */
          openedStored,
          /** …and after an unrelated change with the document still open. Still the choice. */
          afterUnrelatedEdit,
          /** The player setting it themselves DOES write. Anything else would be a dead panel. */
          afterOwnEdit,
          /** Proof the v10 case did not re-fire off the document's version number. */
          migrationRefired: openedEffective === 'free' && before.grid !== 'free',
          /** The floor that makes that true, as it stands on disk. */
          migrationFloor: Number(localStorage.getItem('riffsheet.settingsMigratedTo') ?? 0)
        };
      } finally {
        this.documentOverrides = overridesBefore;
        this.applyingDocumentSettings = true;
        try {
          this.settings.set(before);
        } finally {
          this.applyingDocumentSettings = false;
        }
        this.globalSettings = { ...before };
        saveSettings(this.globalSettings);
      }
    };

    /**
     * "It forgot the original sound" — answered as a fact rather than a theory.
     *
     * Reports the whole chain in one call: what the saved blob actually contains, what the
     * shell says it is still holding, and which branch of `reopenOriginal` ran. Run it in the
     * plugin after closing and reopening the window and the failing step names itself.
     *
     * It re-reads the blob from the host rather than trusting this app's copy, because "the
     * page lost it" and "it was never written down" are different bugs.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_AUDIO__ = async () => {
      const rt = this.runtime.get();
      let stored: PersistedSession | null = null;
      let storeError: string | null = null;
      try {
        stored = await this.session.load();
      } catch (e) {
        storeError = String((e as Error).message ?? e);
      }
      // What the shell believes, asked directly rather than inferred from our own flags.
      let shell: unknown = null;
      try {
        shell = this.audioRef?.token
          ? await this.bridge.loadOriginal({
              path: this.audioRef.path,
              name: this.audioRef.name,
              token: this.audioRef.token
            })
          : { durationSec: 0, note: 'no token to ask about' };
      } catch (e) {
        shell = { error: String((e as Error).message ?? e) };
      }
      return {
        restored: this.restored,
        restoredBy: this.originalRestoredBy,
        originalAvailable: this.transport.originalAvailable,
        pcmSamples: this.pcm?.length ?? 0,
        pcmRate: this.pcmRate,
        live: {
          kind: this.audioRef?.kind ?? null,
          token: this.audioRef?.token ?? null,
          path: this.audioRef?.path ?? null,
          pcmUrl: this.audioRef?.pcmUrl ?? null
        },
        // The blob is the thing that has to carry the handle across the editor being
        // destroyed. If the audio is missing HERE, nothing downstream could ever have worked.
        blob: stored
          ? {
              hasSource: !!stored.source,
              detectedNotes: stored.source?.detected?.notes.length ?? 0,
              peakBuckets: stored.source?.peaks?.buckets ?? 0,
              audio: stored.audio ?? null,
              bytes: JSON.stringify(stored).length
            }
          : null,
        storeError,
        shellSays: shell,
        sourceName: rt.source?.name ?? null,
        canSave: this.session.canSave,
        canLoad: this.session.canLoad
      };
    };
    (window as unknown as Record<string, unknown>).__RIFFSHEET_PITCH__ = () => pitchSelfTest();
    /**
     * F16, driven end to end: trim, cut, undo, redo — and what each one did to every layer.
     *
     * The claim this proves is that ONE model reaches all of them. A cut has to shorten the
     * strip, shorten the score, remove the notes under it from the sheet and the exports, and
     * leave `source.detected.notes` untouched — because that last one is what makes it
     * reversible. Reporting all five together is the only way "non-destructive" is a fact
     * rather than an intention.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_CUTS__ = (
      action: 'probe' | 'trim' | 'cut' | 'undo' | 'redo' | 'clear' = 'probe',
      fromSec = 0,
      toSec = 0
    ) => {
      const shot = () => {
        const source = this.runtime.get().source;
        const edited = this.editedSource();
        const score = this.runtime.get().score;
        const r3 = (n: number) => Number(n.toFixed(3));
        return {
          cuts: this.cuts().map((c) => ({ fromSec: r3(c.fromSec), toSec: r3(c.toSec) })),
          removedSec: r3(cutTotalSec(this.cuts())),
          // THE RECORDING, which must never move.
          takeSec: r3(source?.durationSec ?? 0),
          rawNotes: source?.detected?.notes.length ?? 0,
          rawPeakBuckets: source?.peaks?.min.length ?? 0,
          // THE PAGE, which must.
          editedSec: r3(edited?.durationSec ?? 0),
          editedNotes: edited?.detected?.notes.length ?? 0,
          editedPeakBuckets: edited?.peaks?.min.length ?? 0,
          scoreSec: score ? r3(score.durationSec) : null,
          feedNotes: this.performanceFeed().length,
          rollNotes: this.pianoRoll?.probe().notes ?? null,
          waveSec: this.waveform?.probe().durationSec ?? null,
          musicxmlBytes: score ? score.musicxml().length : null,
          midiBytes: score ? score.midi(false).length : null,
          // The offer, and the row that carries it.
          offerSec: r3(cutTotalSec(this.trimOffer())),
          chip: !!this.root.querySelector('[data-role="trim-chip"]'),
          cutButton: !!this.root.querySelector('[data-role="cut-out"]'),
          canUndo: this.canUndo(),
          canRedo: this.canRedo()
        };
      };
      const before = shot();
      if (action === 'trim') this.trimSilence();
      else if (action === 'cut') {
        this.openTuner(fromSec, toSec);
        this.cutOutSelection();
      } else if (action === 'undo') this.undo();
      else if (action === 'redo') this.redo();
      else if (action === 'clear') {
        const source = this.runtime.get().source;
        if (source?.detected) this.commitTakeCuts(NO_CUTS, 'Restore the take');
      }
      return { action, before, after: shot() };
    };

    // What the MIDI button would drag if you dragged it now. A real OS drag cannot be
    // synthesised from a page, so this is how the wiring is checked without a hand on a mouse.
    (window as unknown as Record<string, unknown>).__RIFFSHEET_DRAGPROBE__ = () =>
      this.exportBar.dragProbe();
    /**
     * Drive a real edit and report what the roll did about it.
     *
     * The reported bug was that it did nothing: the roll drew the pipeline's IR, which an
     * edit never touches, so a note changed pitch on the sheet and stayed put here. A
     * screenshot cannot catch that — the roll looks perfectly fine, it is just showing the
     * previous score — so the check has to be geometric, and it has to go through the SAME
     * `perform` / `undo` / `redo` path the popover buttons use rather than a private shortcut.
     *
     * Notes are tried in order because a transposition can be legitimately refused (no fret
     * for that pitch in this tuning), and a refused action is not an edit — it must not be
     * mistaken for a roll that failed to update.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_EDITPROBE__ = (semitones = 2) => {
      const ctx = this.editContext();
      const roll = this.pianoRoll;
      if (!ctx || !roll) return { error: 'no score or no roll' };

      const before = roll.probe();
      const ids = [...ctx.index.idToNote.keys()];
      let used: string | null = null;
      for (const id of ids.slice(0, 8)) {
        const wasMidi = roll.probe().firstNoteMidi;
        this.perform(new ChangePitchAction(id, semitones), id);
        if (roll.probe().firstNoteMidi !== wasMidi) {
          used = id;
          break;
        }
        // Refused, or it moved a note that is not the first rect. Undo and try the next one,
        // so the stack is left exactly as it was found.
        if (this.undoStack.canUndo) this.undo();
      }
      if (!used) return { error: 'no note could be transposed', tried: ids.slice(0, 8) };

      const after = roll.probe();
      this.undo();
      const undone = roll.probe();
      this.redo();
      const redone = roll.probe();
      // Leave the score as it was found: the harness runs more checks after this one.
      this.undo();
      const restored = roll.probe();

      const shape = (p: ReturnType<PianoRoll['probe']>) => ({
        midi: p.firstNoteMidi,
        y: p.firstNoteY,
        notes: p.notes,
        source: p.source,
        lowMidi: p.lowMidi,
        highMidi: p.highMidi
      });
      return {
        noteId: used,
        semitones,
        before: shape(before),
        after: shape(after),
        undone: shape(undone),
        redone: shape(redone),
        restored: shape(restored)
      };
    };
    /**
     * The two voices, actually rendered.
     *
     * `__RIFFSHEET_SOUND__` proves the sample set decoded; it does not prove the sampler is
     * wired to anything, and "the samples loaded" is not the same claim as "it sounds like a
     * bass now". This renders one note through each voice's real graph in an
     * OfflineAudioContext and reports what came out — a recorded note and a synthesised pad
     * cannot produce the same spectral centroid, so two numbers settle it.
     *
     * Offline because it must work inside the plugin, where nobody can hear the WebView.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_VOICEPROBE__ = async (
      midi = 41
    ) => {
      const measure = (buf: AudioBuffer) => {
        const d = buf.getChannelData(0);
        let sum = 0;
        let peak = 0;
        let crossings = 0;
        for (let i = 0; i < d.length; i++) {
          sum += d[i] * d[i];
          const a = Math.abs(d[i]);
          if (a > peak) peak = a;
          if (i > 0 && ((d[i - 1] < 0 && d[i] >= 0) || (d[i - 1] >= 0 && d[i] < 0))) crossings++;
        }
        return {
          rms: Number(Math.sqrt(sum / d.length).toFixed(5)),
          peak: Number(peak.toFixed(5)),
          // Zero crossings per second: a cheap, allocation-free stand-in for brightness.
          zcrHz: Math.round(crossings / buf.duration)
        };
      };
      const render = async (voice: 'finger-bass' | 'pad') => {
        const off = new OfflineAudioContext(1, 44100 * 2, 44100);
        const ctx = off as unknown as AudioContext;
        let sourcesScheduled = 0;
        let samplesLoaded: boolean | null = null;
        if (voice === 'finger-bass') {
          const sb = new SampledBass(ctx);
          samplesLoaded = await sb.load();
          sourcesScheduled = sb.schedule(off.destination, midi, 0.02, 1.2, 0.9).length;
        } else {
          sourcesScheduled = schedulePad(ctx, off.destination, midi, 0.02, 1.2, 0.9).length;
        }
        const buffer = await off.startRendering();
        return { info: { voice, sourcesScheduled, samplesLoaded, ...measure(buffer) }, buffer };
      };
      try {
        const a = await render('finger-bass');
        const b = await render('pad');
        // The decisive number. Both renders are the same note, same length, same context, so
        // if the sampler had quietly fallen through to the pad these would cancel to zero.
        const x = a.buffer.getChannelData(0);
        const y = b.buffer.getChannelData(0);
        let diff = 0;
        for (let i = 0; i < x.length; i++) diff += (x[i] - y[i]) * (x[i] - y[i]);
        const diffRms = Math.sqrt(diff / x.length);
        const loudest = Math.max(a.info.rms, b.info.rms);
        return {
          midi,
          sampled: a.info,
          pad: b.info,
          diffRms: Number(diffRms.toFixed(5)),
          /** 0 = the same sound, 1 = as different as either is loud. */
          differenceRatio: Number((diffRms / (loudest || 1)).toFixed(3)),
          audiblyDifferent:
            a.info.rms > 0.001 && b.info.rms > 0.001 && diffRms > 0.5 * loudest
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      }
    };
    /**
     * The three clocks, side by side: the sheet cursor's, the synth's, and the piano roll's.
     *
     * They are three consumers of ONE origin (`scoreOriginSec`), and in v1.1 two of them
     * were computing their own — the cursor and the MIDI voice ran ahead of the audio by the
     * whole count-in, agreeing with each other and with nothing else. Reporting the numbers
     * rather than a boolean is deliberate: if they ever drift apart again, the difference
     * IS the diagnosis.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_TIMEBASE__ = () => {
      const score = this.runtime.get().score;
      if (!score) return null;
      const origin = this.originSec(score);
      const barOneSec = this.runtime.get().source?.barOneSec ?? 0;
      const synth = this.synthNotesFor(score);
      // The same walk with the performance withheld — i.e. what playback USED to be. The two
      // side by side are what makes "playback follows the performance, not the grid" a
      // measurable claim rather than a comment.
      const engraved = scoreToSynthNotes(score, origin, this.liveSheet(), null);
      const played = new Map(
        (this.runtime.get().source?.detected?.notes ?? [])
          .filter((n) => n.id && !n.sourceTiming)
          .map((n) => [n.id!, n.startSec] as const)
      );
      // How far the grid would have moved the notes, and how many of them now land exactly
      // where they were played. Both lists are the same notes in the same order.
      let worstGridOffsetSec = 0;
      for (let i = 0; i < synth.length && i < engraved.length; i++) {
        worstGridOffsetSec = Math.max(worstGridOffsetSec, Math.abs(synth[i].startSec - engraved[i].startSec));
      }
      let followsPerformance = 0;
      for (const [, startSec] of played) {
        if (synth.some((n) => Math.abs(n.startSec - startSec) < 1e-6)) followsPerformance++;
      }
      const roll = this.pianoRoll?.probe() ?? null;
      const r3 = (n: number) => Number(n.toFixed(3));
      return {
        barOneSec: r3(barOneSec),
        // Written second 0, on the recording's clock. All three of these must match.
        cursorOriginSec: r3(origin),
        rollOriginSec: roll ? roll.originSec : null,
        // The audio second the cursor is at when it sits on the very first tick.
        cursorSecAtTick0: r3(tickToSeconds(score, 0, origin)),
        // ...and the tick it shows when the audio reaches bar 1. Zero, or it leads/lags.
        tickAtBarOne: r3(secondsToTick(score, barOneSec, origin)),
        // The audible note and the drawn note, both on the recording's clock.
        firstSynthNoteSec: synth.length ? r3(Math.min(...synth.map((n) => n.startSec))) : null,
        firstRollNoteSec: roll ? roll.firstNoteSec : null,
        synthNotes: synth.length,

        // --- playback follows the performance, not the grid ----------------------------
        // `playedNotes` is how many notes the recording knows about; `followsPerformance` is
        // how many of those the synth will strike at exactly the second they were played.
        // Equal means playback is the take rather than a quantized copy of it.
        playedNotes: played.size,
        followsPerformance,
        /**
         * The largest distance the grid would have moved a note, in ms.
         *
         * Zero on a machine-exact fixture — the grid and the performance agree there, so this
         * is not a measure of whether the feature is on. It is what the player would have been
         * hearing instead, and on a human take it is tens of milliseconds per note.
         */
        gridOffsetMs: Math.round(worstGridOffsetSec * 1000)
      };
    };
    /**
     * Align, in both states, with the two claims that pull against each other.
     *
     * ON, pointing at a moment has to move the SHEET. OFF, it must not. And with it ON —
     * exactly when the deleted engraved-axis design used to reflow — adding a note to the roll
     * must move NO other note on the roll by a single pixel. That last one is the player's own
     * acceptance test and the reason the old design is gone rather than defaulted off.
     */
    /**
     * VERTICAL CORRESPONDENCE: is a note's sheet x really the same column as its roll x?
     *
     * The claim Align makes on screen, measured rather than eyeballed. Three notes spread
     * across the visible span; for each, the sheet's own `noteContentX` (straight off alphaTab's
     * bounds, not re-derived) minus the sheet's scroll, against the rectangle the roll actually
     * painted. Both panes are full-width and stacked, so a viewport x in one is a viewport x in
     * the other and the two numbers are directly comparable.
     *
     * `windowSec` is reported alongside because the tolerance is only meaningful next to it:
     * the roll is linear in time across the window and alphaTab is not, so the residual is
     * whatever the engraving's own unevenness comes to over one screen of music.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_ALIGNX__ = async (
      mode: 'on' | 'off' = 'on'
    ) => {
      const settle = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
      const was = this.settings.get().alignViews;
      try {
        this.settings.set({ alignViews: mode === 'on' });
        this.renderMain();
        await settle(600);
        this.pianoRoll?.fitVertical();
        this.syncViewports();
        await settle(300);

        const view = this.triview?.viewport();
        const rects = (this.pianoRoll?.paintedRects() ?? []).filter((r) => r.noteId);
        const rows: Array<{ noteId: string; sheetX: number; rollX: number; deltaPx: number }> = [];
        // Spread across what is drawn rather than the first three: three neighbours would only
        // ever prove the two panes agree in one place.
        const picks = [0, Math.floor(rects.length / 2), rects.length - 1]
          .filter((i, at, all) => i >= 0 && i < rects.length && all.indexOf(i) === at);
        for (const i of picks) {
          const r = rects[i];
          const cx = this.triview?.noteContentX(r.noteId!);
          if (cx === null || cx === undefined || !view) continue;
          const sheetX = cx - view.scrollLeft;
          rows.push({
            noteId: r.noteId!,
            sheetX: Math.round(sheetX),
            rollX: Math.round(r.x),
            deltaPx: Math.round(Math.abs(sheetX - r.x))
          });
        }
        const window = this.alignedWindow;
        // WHAT THE ROLL IS ACTUALLY SHOWING, next to what Align asked it to show. The two are
        // the same claim in on-mode and must differ in off-mode: "the panes are independent"
        // means the roll went back to the whole take. Reported because the off-mode failure
        // this probe exists to catch is invisible in `worstDeltaPx` alone — a roll that never
        // released the window scores a small delta for the WRONG reason, and only these two
        // numbers side by side can say which of the two it was.
        const applied = this.pianoRoll?.getTimeWindow() ?? null;
        const r3 = (n: number) => Number(n.toFixed(3));
        return {
          mode,
          aligned: !!window,
          windowSec: window ? Number((window.toSec - window.fromSec).toFixed(3)) : null,
          appliedWindow: applied ? { fromSec: r3(applied.fromSec), toSec: r3(applied.toSec) } : null,
          appliedWindowSec: applied ? r3(applied.toSec - applied.fromSec) : null,
          rollZoomedOut: this.pianoRoll?.isTimeZoomedOut() ?? null,
          takeSec: r3(this.runtime.get().source?.durationSec ?? 0),
          paintedRects: rects.length,
          compared: rows.length,
          worstDeltaPx: rows.reduce((m, r) => Math.max(m, r.deltaPx), 0),
          rows
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      } finally {
        this.settings.set({ alignViews: was });
        this.renderMain();
      }
    };

    (window as unknown as Record<string, unknown>).__RIFFSHEET_ALIGN__ = async (
      mode: 'probe' | 'on' | 'off' = 'probe'
    ) => {
      const settle = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
      const enabled = this.settings.get().alignViews;
      if (mode === 'probe') {
        return { enabled, chipOn: !!this.root.querySelector('[data-role="roll-link"].on') };
      }
      try {
        const want = mode === 'on';
        this.settings.set({ alignViews: want });
        this.renderMain();
        await settle(500);

        const score = this.runtime.get().score;
        const notes = this.runtime.get().source?.detected?.notes ?? [];
        if (!score || notes.length < 4) return { error: 'no take to align' };

        // Every note on screen before anything is measured: `paintedRects()` reports what was
        // actually drawn, and a comparison over nine visible rectangles out of seventy-seven
        // would miss a reflow happening just off the top of the pane.
        this.pianoRoll?.fitVertical();
        await settle(250);
        // Put the sheet at the top, then point at a moment well into the take.
        this.triview?.setScrollLeft(0);
        await settle(300);
        const before = this.triview?.viewport()?.scrollLeft ?? 0;
        const targetSec = notes[Math.min(notes.length - 1, Math.floor(notes.length * 0.75))].startSec;
        const followed = this.followSeek(targetSec);
        await settle(400);
        const after = this.triview?.viewport()?.scrollLeft ?? 0;

        // How close it landed, measured against the sheet's own map rather than against a
        // number this file computed — the point is that the two agree.
        const map = this.sheetMap();
        const view = this.triview?.viewport();
        const wantedX = map?.writtenSecToContentX(targetSec - this.originSec(score)) ?? null;
        const sheetErrorPx =
          wantedX === null || !view ? null : Math.round(Math.abs(after + view.viewportWidth / 2 - wantedX));

        // Selection still crosses every view, either way.
        const ids = notes.slice(1, 3).map((n) => n.id!).filter(Boolean);
        this.selectNoteIds(ids);
        await settle(200);
        const selectionCrossed =
          (this.pianoRoll?.probe().selectionCount ?? 0) === ids.length &&
          (this.triview?.selection.length ?? 0) === ids.length;

        // THE ACCEPTANCE TEST: add a note, and measure every OTHER rectangle before and after.
        const key = (r: { noteId: string | null; x: number; w: number }) => r.noteId ?? '';
        const rectsBefore = new Map(
          (this.pianoRoll?.paintedRects() ?? []).filter((r) => r.noteId).map((r) => [key(r), r])
        );
        // INSIDE the take and at a pitch already on screen, so the new rectangle is really
        // drawn and the ones around it are really compared. A note parked past the end would
        // be clipped, and a clipped note proves nothing about reflow.
        const anchor = notes[Math.floor(notes.length / 2)];
        const notesBefore = (this.runtime.get().source?.detected?.notes ?? []).length;
        this.applyRollEdit({
          kind: 'add',
          midi: anchor.midi,
          startSec: anchor.endSec + 0.02 - this.originSec(score),
          durationSec: 0.2
        });
        await settle(700);
        const rectsAfter = new Map(
          (this.pianoRoll?.paintedRects() ?? []).filter((r) => r.noteId).map((r) => [key(r), r])
        );
        let otherNotesMovedPx = 0;
        for (const [id, b] of rectsBefore) {
          const a = rectsAfter.get(id);
          if (!a) continue;
          otherNotesMovedPx = Math.max(otherNotesMovedPx, Math.abs(a.x - b.x), Math.abs(a.w - b.w));
        }
        const noteAdded = (this.runtime.get().source?.detected?.notes ?? []).length > notesBefore;
        // Read BEFORE the restore below puts `alignViews` back: the window is what this mode
        // produced, and asking for it after the setting has been handed back would report the
        // other mode's answer.
        const alignedWindowSec = this.alignedWindow
          ? Number((this.alignedWindow.toSec - this.alignedWindow.fromSec).toFixed(3))
          : null;
        this.undo();
        await settle(500);
        this.selectNoteIds([]);
        this.settings.set({ alignViews: enabled });
        this.renderMain();
        await settle(300);

        return {
          mode,
          enabled: want,
          // Was the seek ROUTED to the sheet at all? The decisive fact, and the only one that
          // survives a sheet whose whole content already fits on screen — which is the normal
          // case for a short take and would otherwise make "it scrolled" untestable.
          followed,
          scrollBefore: Math.round(before),
          scrollAfter: Math.round(after),
          sheetMoved: Math.abs(after - before) > 4,
          // True when there was anywhere to scroll TO. Without it, "the sheet did not move"
          // reads as a failure on a take that fits in the window.
          sheetScrollable: !!view && view.contentWidth > view.viewportWidth + 8,
          sheetErrorPx,
          // ALIGN's actual geometry: the stretch of recording the roll and the strip were told
          // to show. Null in off mode, which is what "independent views" means.
          alignedWindowSec,
          // How many beats the shared ruler is pinned to. Two is the fallback (the plain
          // window); more means it is following the engraving beat by beat.
          alignAnchors: this.alignedAnchors?.length ?? 0,
          selectionCrossed,
          noteAdded,
          // Rounded to whole pixels: the roll re-derives its own layout, so a sub-pixel
          // difference is arithmetic noise and a whole pixel is a reflow.
          otherNotesMovedPx: Math.round(otherNotesMovedPx),
          comparedNotes: rectsBefore.size
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      }
    };

    /**
     * Every main-menu action, pressed, with its effect measured.
     *
     * This repository has shipped a menu whose rows opened a dialog that then did nothing, so
     * "the row exists" is not a claim worth making. Each action below is driven through the
     * REAL handler and answered with something observable: a screen change, a source appearing
     * or disappearing, a setup form on screen. The destructive confirmations are answered by
     * pressing the real button in the real dialog, which is the part that was dead before.
     *
     * It leaves the app on the opening screen; the harness reloads the demo afterwards.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_MENUACTIONS__ = async () => {
      const settle = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
      /**
       * Say yes to the in-page confirmation, if one appeared.
       *
       * `window.confirm` returns false in a WKWebView with no UI delegate, which is why these
       * are page dialogs — see `askConfirm`. Returns whether one was actually asked, because
       * "it did not even ask" is a different (and worse) failure from "it asked and ignored
       * the answer", and a destructive action that skips the question is its own bug.
       */
      const confirmIfAsked = async (): Promise<boolean> => {
        for (let i = 0; i < 20; i++) {
          const ok = document.querySelector<HTMLButtonElement>('[data-role="confirm-ok"]');
          if (ok) {
            ok.click();
            await settle(200);
            return true;
          }
          await settle(50);
        }
        return false;
      };
      try {
        const before = {
          screen: this.runtime.get().screen,
          hasSource: !!this.runtime.get().source
        };

        // MAIN MENU: it has to leave the sheet and land on the opening screen.
        this.openMainMenu();
        await settle(120);
        const openedMenu = this.runtime.get().screen === 'opening';
        const rows = [...document.querySelectorAll('.dropzone-screen button')]
          .map((b) => (b.textContent || '').trim())
          .filter(Boolean);

        // BLANK SCORE: the setup form has to appear, with real inputs in it.
        const blankButton = [...document.querySelectorAll('.dropzone-screen button')].find((b) =>
          /blank/i.test(b.textContent || '')
        ) as HTMLButtonElement | undefined;
        blankButton?.click();
        await settle(160);
        const blankForm = !!document.querySelector('[data-role="blank-score-setup"]');
        this.blankSetupOpen = false;
        this.renderOpening();
        await settle(120);

        // CAPTURE: offered ONLY in a plugin, because there is no track to record in a browser.
        // Both halves are the claim — a capture button on a web page would be a lie, and a
        // missing one inside a DAW is the bug. `isPlugin` is reported so the check can hold
        // whichever of the two applies rather than assuming the harness's host.
        const isPlugin = !!this.runtime.get().host?.isPlugin;
        const captureButton = [...document.querySelectorAll('.dropzone-screen button')].find((b) =>
          /capture/i.test(b.textContent || '')
        ) as HTMLButtonElement | undefined;
        let captureChanged = false;
        if (captureButton) {
          captureButton.click();
          await settle(400);
          const rt = this.runtime.get();
          captureChanged = rt.capturing || rt.captureArmed || this.captureStopPending;
          // Put it back down whatever state it reached.
          if (rt.capturing || rt.captureArmed) {
            await this.toggleCapture().catch(() => undefined);
            await settle(400);
          }
        }

        // CLOSE: the destructive one, and the one whose confirm used to lead nowhere. It has
        // to ASK, and then actually close.
        this.openMainMenu();
        await settle(120);
        const closeButton = [...document.querySelectorAll('.dropzone-screen button')].find((b) =>
          /^close/i.test(b.textContent || '')
        ) as HTMLButtonElement | undefined;
        let closeAsked = false;
        let closedIt = false;
        if (closeButton && this.runtime.get().source) {
          closeButton.click();
          closeAsked = await confirmIfAsked();
          await settle(500);
          closedIt = !this.runtime.get().source;
        }

        return {
          before,
          isPlugin,
          openedMenu,
          rows,
          rowCount: rows.length,
          blankFormOpened: blankForm,
          captureOffered: !!captureButton,
          captureChanged,
          closeOffered: !!closeButton,
          closeAsked,
          closedIt,
          screenAtEnd: this.runtime.get().screen
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      }
    };

    /** A blank score, created end to end, and read back off the engraved sheet. */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_BLANKSCORE__ = async () => {
      try {
        // `createBlankScore` asks before replacing an open take, and the question is a page
        // dialog waiting on a click (see `askConfirm`). Answer it from here, or this awaits a
        // button nobody is going to press.
        const answer = (async () => {
          for (let i = 0; i < 30; i++) {
            const ok = document.querySelector<HTMLButtonElement>('[data-role="confirm-ok"]');
            if (ok) {
              ok.click();
              return true;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        })();
        const created = this.createBlankScore({
          title: 'Harness blank',
          tempo: 100,
          meter: '3/4',
          bars: 6,
          keyFifths: 0,
          clefMode: 'auto',
          tabMode: 'bass'
        });
        await created;
        await answer;
        await new Promise((ok) => setTimeout(ok, 900));
        const score = this.runtime.get().score;
        return {
          created: !!score,
          screen: this.runtime.get().screen,
          bars: score?.ir.bars.length ?? 0,
          tempoBpm: score?.tempoBpm ?? 0,
          timeSig: score ? `${score.timeSignature.numerator}/${score.timeSignature.denominator}` : null,
          documentBars: this.runtime.get().source?.documentBars ?? null,
          // A blank score is bars of rests: no noteheads, but a real page.
          noteGlyphs: score?.ir.stats.noteGlyphs ?? -1,
          engravedStaves: document.querySelectorAll('.at-host svg').length,
          name: this.runtime.get().source?.name ?? null
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      }
    };

    /**
     * A custom TAB tuning, applied, and the tab actually re-fretted for it.
     *
     * The claim that matters is not that the setting stores a number — it is that the FRET
     * DIGITS on the page change, because a tuning that is remembered and not used is exactly
     * the bug this checks for. Dropping every string a whole tone moves every fret by two, so
     * the digits cannot come out the same unless nothing happened.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_CUSTOMTUNING__ = async () => {
      const settle = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
      const digits = () =>
        [...document.querySelectorAll('.at-host svg text')].map((t) => t.textContent).join('|');
      try {
        const beforeMode = this.settings.get().tabMode;
        const beforeTuning = [...this.settings.get().customTuningMidi];
        const beforeDigits = digits();

        // Standard bass, then the whole thing down a tone.
        this.settings.set({ tabMode: 'custom', customTuningMidi: [28, 33, 38, 43] });
        this.rebuildNotation({ keepEdits: true });
        this.renderMain();
        await settle(900);
        const standard = { digits: digits(), summary: (this.triview?.stringLetterTexts()[0] ?? []).join(' '), strings: this.runtime.get().score?.stringCount ?? 0 };

        this.settings.set({ customTuningMidi: [26, 31, 36, 41] });
        this.rebuildNotation({ keepEdits: true });
        this.renderMain();
        await settle(900);
        const dropped = { digits: digits(), summary: (this.triview?.stringLetterTexts()[0] ?? []).join(' '), strings: this.runtime.get().score?.stringCount ?? 0 };

        // A five-string, so the string COUNT is exercised as well as the pitches.
        this.settings.set({ customTuningMidi: [23, 28, 33, 38, 43] });
        this.rebuildNotation({ keepEdits: true });
        this.renderMain();
        await settle(900);
        const five = { summary: (this.triview?.stringLetterTexts()[0] ?? []).join(' '), strings: this.runtime.get().score?.stringCount ?? 0 };

        this.settings.set({ tabMode: beforeMode, customTuningMidi: beforeTuning });
        this.rebuildNotation({ keepEdits: true });
        this.renderMain();
        await settle(900);

        return {
          hadDigits: beforeDigits.length > 0,
          standard,
          dropped,
          five,
          digitsChanged: standard.digits !== dropped.digits,
          summaryChanged: standard.summary !== dropped.summary,
          restoredMode: this.settings.get().tabMode
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      }
    };

    /**
     * A stretch picked on the waveform has to light up the same notes on the ROLL and on the
     * SHEET.
     *
     * The player's complaint in their own words was that the panes were "two pictures of one
     * set of notes that could not point at the same one". This drives the strip's own listener
     * and then reads the other two views back.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_CROSSHIGHLIGHT__ = () => {
      try {
        const notes = this.runtime.get().source?.detected?.notes ?? [];
        if (notes.length < 3) return { error: 'not enough notes' };
        const from = notes[1].startSec - 0.01;
        const to = notes[2].endSec + 0.01;
        const ids = this.pianoRoll?.noteIdsInAudioRange(from, to) ?? [];
        this.selectNoteIds(ids);
        const rollProbe = this.pianoRoll?.probe();
        return {
          askedFor: ids.length,
          rollSelected: rollProbe?.selectionCount ?? 0,
          runtimeSelected: this.runtime.get().selection.length,
          // The engraving's own answer: how many noteheads the tri-view is showing as picked.
          sheetSelected: document.querySelectorAll('.at-host .at-selection, .at-host [data-selected="1"], .note-name.selected').length,
          sheetKnowsIds: (this.triview?.selection ?? []).length,
          waveFrom: this.waveform?.probe().selectionFromSec ?? null,
          waveTo: this.waveform?.probe().selectionToSec ?? null
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      }
    };

    /**
     * The auto-split / gap-fill pass, run against SYNTHESISED takes with known answers.
     *
     * The planner is pure (`edit/autoEdits.ts`), so the guardrails can be exercised directly
     * rather than inferred from what a real transcription happened to contain. Each fixture is
     * built here so the check and the audio it is about live in one place:
     *
     *   merged      two 250 ms hits the engine returned as one 500 ms note, with a real attack
     *               between them. THE REPORTED CASE. Must split, once, at the attack.
     *   ghost       the same note with a detection 40 ms before its END. Must refuse: the
     *               second fragment would be a sliver.
     *   cluster     two detections 40 ms apart in the middle. Must collapse to ONE split.
     *   fill        a stretch the engine left empty with one steady pitch in it. Must add one.
     *   noisy       the same stretch filled with noise. Must refuse and highlight instead.
     *   quiet       the same stretch at -55 dB under the take. Must refuse: nobody records a
     *               real note down there.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_AUTOPLAN__ = () => {
      try {
        const rate = 44100;
        const tone = (pcm: Float32Array, fromSec: number, toSec: number, hz: number, amp: number) => {
          const a = Math.round(fromSec * rate);
          const b = Math.min(pcm.length, Math.round(toSec * rate));
          for (let i = a; i < b; i++) {
            const age = (i - a) / rate;
            pcm[i] += amp * Math.exp(-age * 2.5) * Math.sin(2 * Math.PI * hz * (i / rate));
          }
        };
        // Deterministic pseudo-noise: `Math.random` would make a check that fails once a month.
        const noise = (pcm: Float32Array, fromSec: number, toSec: number, amp: number) => {
          let seed = 22222;
          const a = Math.round(fromSec * rate);
          const b = Math.min(pcm.length, Math.round(toSec * rate));
          for (let i = a; i < b; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            pcm[i] += amp * (seed / 0x7fffffff - 0.5) * 2;
          }
        };
        const strength = (timeSec: number, s = 1) => ({ timeSec, strength: s });
        const plan = (o: Parameters<typeof planAutoEdits>[0]) => planAutoEdits(o);

        // --- splits: no audio needed, the notes and the attacks are the whole question ---
        const merged = plan({
          notes: [{ id: 'n0', startSec: 1, endSec: 1.5, midi: 40 }],
          onsets: [strength(1), strength(1.25)],
          pcm: null,
          sampleRate: rate,
          snapSec: 0.25,
          durationSec: 3
        });
        const ghost = plan({
          notes: [{ id: 'n0', startSec: 1, endSec: 1.5, midi: 40 }],
          onsets: [strength(1), strength(1.46)],
          pcm: null,
          sampleRate: rate,
          snapSec: 0.25,
          durationSec: 3
        });
        const cluster = plan({
          notes: [{ id: 'n0', startSec: 1, endSec: 1.5, midi: 40 }],
          onsets: [strength(1), strength(1.25, 0.4), strength(1.29, 0.9)],
          pcm: null,
          sampleRate: rate,
          snapSec: 0.25,
          durationSec: 3
        });
        const exempt = plan({
          notes: [{ id: 'n0', startSec: 1, endSec: 1.5, midi: 40 }],
          onsets: [strength(1), strength(1.25)],
          pcm: null,
          sampleRate: rate,
          snapSec: 0.25,
          durationSec: 3,
          userTouchedIds: new Set(['n0'])
        });
        // Re-running the pass over its own output must change nothing: the boundary attack is
        // no longer INSIDE either fragment.
        const rerun = plan({
          notes: [
            { id: 'n0', startSec: 1, endSec: 1.25, midi: 40 },
            { id: 'auto1', startSec: 1.25, endSec: 1.5, midi: 40 }
          ],
          onsets: [strength(1), strength(1.25)],
          pcm: null,
          sampleRate: rate,
          snapSec: 0.25,
          durationSec: 3
        });

        // --- gap fills: these need real samples, because the gates are about the audio ---
        // A gap BETWEEN two notes the engine did write, which is the shape a real missed note
        // has. Bounding it on both sides matters: the region a fill is judged over runs to the
        // next attack or the next note, and a region left running to the end of the take would
        // be mostly silence — which the agreement gate correctly refuses, for the right reason
        // and the wrong fixture.
        const played = [
          { id: 'n0', startSec: 0.2, endSec: 0.7, midi: 40 },
          { id: 'n1', startSec: 1.8, endSec: 2.3, midi: 40 }
        ];
        const around = (pcm: Float32Array) => {
          tone(pcm, 0.2, 0.7, 82.41, 0.9);
          tone(pcm, 1.8, 2.3, 82.41, 0.9);
        };
        const heard = [strength(0.2), strength(1.2), strength(1.8)];

        const steady = new Float32Array(rate * 3);
        around(steady);
        tone(steady, 1.2, 1.78, 110, 0.6);
        const fill = plan({ notes: played, onsets: heard, pcm: steady, sampleRate: rate, snapSec: 0.25, durationSec: 3 });

        const noisy = new Float32Array(rate * 3);
        around(noisy);
        noise(noisy, 1.2, 1.78, 0.6);
        const noisyPlanResult = plan({ notes: played, onsets: heard, pcm: noisy, sampleRate: rate, snapSec: 0.25, durationSec: 3 });

        const faint = new Float32Array(rate * 3);
        around(faint);
        tone(faint, 1.2, 1.78, 110, 0.0012);
        const quiet = plan({ notes: played, onsets: heard, pcm: faint, sampleRate: rate, snapSec: 0.25, durationSec: 3 });

        const sum = (p: ReturnType<typeof planAutoEdits>) => ({
          splits: p.splits.length,
          splitAtMs: p.splits.length ? Math.round(p.splits[0].atSec * 1000) : null,
          fills: p.fills.length,
          fillMidi: p.fills.length ? p.fills[0].midi : null,
          fillFromMs: p.fills.length ? Math.round(p.fills[0].fromSec * 1000) : null,
          attention: p.attention.length,
          clustered: p.clusteredOnsets.length
        });
        return {
          merged: sum(merged),
          ghost: sum(ghost),
          cluster: sum(cluster),
          exempt: sum(exempt),
          rerun: sum(rerun),
          fill: sum(fill),
          noisy: sum(noisyPlanResult),
          quiet: sum(quiet),
          params: merged.params
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      }
    };

    /**
     * The review flow, driven the way a mouse would drive it.
     *
     * Manufactures one auto edit against the live take (the fixtures are clean, so a real pass
     * finds nothing in them — which is itself the no-false-positives claim), then exercises the
     * whole loop: highlight on the roll, region on the strip, counter chip, popover, Keep, and
     * Revert. It puts the performance back at the end.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_AUTOREVIEW__ = (
      action: 'keep' | 'revert' = 'keep'
    ) => {
      try {
        const source = this.runtime.get().source;
        const notes = source?.detected?.notes ?? [];
        if (notes.length === 0) return { error: 'no performance' };
        const before = notes.length;

        // A real merged note: take one and pretend the engine returned it whole, with an
        // attack in the middle. That is the reported case, expressed against this take.
        const target = notes[Math.min(3, notes.length - 1)];
        const widened = notes.map((n) =>
          n.id === target.id ? { ...n, endSec: n.startSec + 0.5 } : n
        );
        const plan = planAutoEdits({
          notes: widened,
          onsets: [
            { timeSec: target.startSec, strength: 1 },
            { timeSec: target.startSec + 0.25, strength: 0.9 }
          ],
          pcm: null,
          sampleRate: this.pcmRate || 44100,
          snapSec: this.pianoRoll?.probe().snapSec ?? 0.25,
          durationSec: source?.durationSec ?? 10
        });
        const applied = applyAutoEdits(widened, plan, () => `auto${++this.autoNoteCount}`);
        this.autoEdits = applied.applied.map((edit, i) => ({ ...edit, id: `probe${i}`, reviewed: false }));
        this.autoAttention = plan.attention;
        this.autoReviewCursor = 0;
        this.commitPerformance(applied.notes, 'Auto edit');

        // Fit the pitch window first, or the halo may be painted on a row that is scrolled
        // out of view and `autoMarksDrawn` would report zero for a highlight that is working.
        this.pianoRoll?.fitVertical();
        const afterSplit = {
          notes: this.runtime.get().source?.detected?.notes.length ?? 0,
          rollMarks: this.pianoRoll?.probe().autoMarks ?? 0,
          rollMarksDrawn: this.pianoRoll?.probe().autoMarksDrawn ?? 0,
          waveRegions: this.waveform?.probe().attentionRegions ?? 0,
          chipShown: this.chipVisible(),
          chipText: this.chipText()
        };

        // The chip's own gesture: step to the next unreviewed edit and open its popover.
        this.focusNextAutoEdit();
        const popover = document.querySelector('[data-role="auto-popover"]');
        const popoverTitle = popover?.querySelector('[data-role="auto-popover-title"]')?.textContent ?? null;
        const hasKeep = !!popover?.querySelector('[data-role="auto-keep"]');
        const hasRevert = !!popover?.querySelector('[data-role="auto-revert"]');

        // Press it for real, so the button and its handler are what is under test.
        popover
          ?.querySelector<HTMLButtonElement>(action === 'keep' ? '[data-role="auto-keep"]' : '[data-role="auto-revert"]')
          ?.click();

        // APPLIED marks are what a review clears. Attention marks — things the pass noticed
        // and did NOT act on — are not the player's to review and legitimately stay put, so
        // they are counted separately rather than expected to vanish.
        const afterReview = {
          notes: this.runtime.get().source?.detected?.notes.length ?? 0,
          rollMarks: this.pianoRoll?.probe().autoMarks ?? 0,
          rollMarksApplied: this.pianoRoll?.probe().autoMarksApplied ?? 0,
          waveRegions: this.waveform?.probe().attentionRegions ?? 0,
          waveApplied: this.waveform?.probe().attentionApplied ?? 0,
          chipShown: this.chipVisible(),
          popoverOpen: !!document.querySelector('[data-role="auto-popover"]')
        };

        // Put the take back: undo whatever this left behind, then forget the marks.
        while (this.historyIndex >= 0 && this.perfIndex > 0) this.undo();
        this.clearAutoEdits();

        return {
          action,
          beforeNotes: before,
          appliedEdits: applied.applied.length,
          splitAtMs: plan.splits.length ? Math.round(plan.splits[0].atSec * 1000) : null,
          afterSplit,
          popoverTitle,
          hasKeep,
          hasRevert,
          afterReview,
          restoredNotes: this.runtime.get().source?.detected?.notes.length ?? 0
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      }
    };

    /**
     * The switched-OFF state, which is not the same thing as the feature being absent.
     *
     * "Do not touch my notes" is a different instruction from "do not tell me". With the
     * setting off the pass still runs, still reaches the same conclusions, and still shows
     * them — as attention highlights on the roll and the strip, with no counter chip, because
     * there is nothing to review. The useful half of the feature is that the app stops
     * disagreeing with itself in silence, and that half survives the switch.
     *
     * Drives the REAL path: the setting, the real `runAutoEditPass`, its disabled branch.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_AUTOOFF__ = async () => {
      const settle = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
      const wasEnabled = this.settings.get().autoSplitAtAttacks;
      const savedOnsets = this.onsetResult;
      try {
        const notes = this.runtime.get().source?.detected?.notes ?? [];
        if (notes.length < 2) return { error: 'no performance' };
        const before = notes.length;
        // A note the engine returned whole, with an attack in the middle of it — the reported
        // case, expressed against this take.
        const target = notes[Math.min(3, notes.length - 1)];
        const widened = notes.map((n) => (n.id === target.id ? { ...n, endSec: n.startSec + 0.5 } : n));
        this.runtime.set({
          source: { ...this.runtime.get().source!, detected: { ...this.runtime.get().source!.detected!, notes: widened } }
        });
        this.onsetResult = {
          onsets: [
            { timeSec: target.startSec, strength: 1 },
            { timeSec: target.startSec + 0.25, strength: 0.9 }
          ],
          envelope: new Float32Array(0),
          envelopeHopSec: 0.0058,
          params: {}
        };

        this.settings.set({ autoSplitAtAttacks: false });
        this.runAutoEditPass();
        await settle(300);

        const after = this.runtime.get().source?.detected?.notes.length ?? 0;
        return {
          applied: this.autoEdits.length,
          attention: this.autoAttention.length,
          rollMarks: this.pianoRoll?.probe().autoMarks ?? 0,
          rollMarksApplied: this.pianoRoll?.probe().autoMarksApplied ?? 0,
          waveRegions: this.waveform?.probe().attentionRegions ?? 0,
          waveApplied: this.waveform?.probe().attentionApplied ?? 0,
          chipShown: this.chipVisible(),
          notesUnchanged: after === before
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      } finally {
        this.settings.set({ autoSplitAtAttacks: wasEnabled });
        this.onsetResult = savedOnsets;
        this.clearAutoEdits();
        // Put the widened note back the way the engine reported it.
        const src = this.runtime.get().source;
        if (src?.detected) {
          this.setPerformance(
            this.perfStack[this.perfIndex] ?? src.detected.notes,
            this.perfCuts[this.perfIndex] ?? NO_CUTS
          );
        }
      }
    };

    /** What the pass has to say right now, without touching anything. */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_AUTOEDITS__ = () => ({
      enabled: this.settings.get().autoSplitAtAttacks,
      applied: this.autoEdits.length,
      unreviewed: this.unreviewedAutoEdits().length,
      attention: this.autoAttention.length,
      chipShown: this.chipVisible(),
      chipText: this.chipText(),
      rollMarks: this.pianoRoll?.probe().autoMarks ?? 0,
      waveRegions: this.waveform?.probe().attentionRegions ?? 0,
      userTouched: this.userTouchedIds.size,
      onsets: this.onsetResult?.onsets.length ?? 0
    });

    /**
     * Does the pass find anything in a CLEAN take?
     *
     * The no-false-positives claim, asked of the real detector against the real fixture rather
     * than of a synthesised one: run the detector over a take built from the demo's own notes
     * and count what the pass would do. The answer has to be nothing.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_AUTOCLEAN__ = () => {
      try {
        const source = this.runtime.get().source;
        const notes = source?.detected?.notes ?? [];
        if (notes.length === 0) return { error: 'no performance' };
        const rate = 22050;
        const pcm = new Float32Array(Math.ceil((source!.durationSec + 0.5) * rate));
        // One clean decaying tone per note, at its own pitch: an honest rendering of the take
        // the sheet claims, which is exactly the case that must produce zero edits.
        for (const n of notes) {
          const hz = 440 * Math.pow(2, (n.midi - 69) / 12);
          const a = Math.round(n.startSec * rate);
          const b = Math.min(pcm.length, Math.round(n.endSec * rate));
          for (let i = a; i < b; i++) {
            const age = (i - a) / rate;
            pcm[i] += 0.7 * Math.exp(-age * 3) * Math.sin(2 * Math.PI * hz * (i / rate));
          }
        }
        const detected = detectOnsets(pcm, rate);
        const plan = planAutoEdits({
          notes,
          onsets: detected.onsets,
          pcm,
          sampleRate: rate,
          snapSec: this.pianoRoll?.probe().snapSec ?? 0.25,
          durationSec: source!.durationSec
        });
        return {
          noteCount: notes.length,
          rawOnsets: detected.onsets.length,
          clusteredOnsets: plan.clusteredOnsets.length,
          splits: plan.splits.length,
          fills: plan.fills.length,
          attention: plan.attention.length
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      }
    };

    /**
     * Does playback follow the PERFORMANCE or the grid?
     *
     * The fixtures are machine-exact, so on them the two answers are the same number and any
     * check would pass vacuously. This manufactures the disagreement: it nudges one note by 37
     * ms — deliberately not a fraction of any beat, so the quantizer must round it back — and
     * then asks both sides where that note is.
     *
     *   the SHEET must snap it back:      an off-grid note is not engravable, and a sheet that
     *                                     drew notes 37 ms late would be unreadable.
     *   the SYNTH must not:               it plays what was played. This is the whole of the
     *                                     "playback sounds robotic" fix, and before it the
     *                                     synth followed the sheet and struck the note early.
     *
     * Puts the performance back through the ordinary undo path, so everything after this runs
     * against the same take it would have.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_PLAYBACKTIMING__ = () => {
      try {
        const score = this.runtime.get().score;
        const notes = this.runtime.get().source?.detected?.notes ?? [];
        if (!score || notes.length === 0) return { error: 'no performance' };
        // A note in the middle: the first one sits under the bar-1 marker and a nudge there
        // moves the anacrusis rather than the note.
        const target = notes[Math.min(4, notes.length - 1)];
        if (!target.id) return { error: 'the performance has no ids' };

        const nudgeSec = 0.037;
        const beatSec = 60 / (score.tempoBpm || 100);
        const before = this.synthNotesFor(score);
        const beforeAt = before.find((n) => Math.abs(n.startSec - target.startSec) < 1e-6)?.startSec ?? null;

        this.applyRollEdit({ kind: 'move', noteId: target.id, deltaSec: nudgeSec, deltaSemitones: 0 });

        const after = this.runtime.get().score;
        const moved = (this.runtime.get().source?.detected?.notes ?? []).find((n) => n.id === target.id);
        const synth = after ? this.synthNotesFor(after) : [];
        const engraved = after ? scoreToSynthNotes(after, this.originSec(after), this.liveSheet(), null) : [];
        const at = (list: typeof synth, sec: number): number | null => {
          let best: number | null = null;
          for (const n of list) {
            if (best === null || Math.abs(n.startSec - sec) < Math.abs(best - sec)) best = n.startSec;
          }
          return best;
        };
        const wanted = moved?.startSec ?? target.startSec + nudgeSec;
        const synthAt = at(synth, wanted);
        const engravedAt = at(engraved, wanted);

        this.undo();

        const ms = (v: number | null) => (v === null ? null : Math.round(v * 1000));
        return {
          nudgeMs: Math.round(nudgeSec * 1000),
          beatMs: Math.round(beatSec * 1000),
          beforeAtMs: ms(beforeAt),
          playedAtMs: ms(wanted),
          // Where the synth will actually strike it. Must equal `playedAtMs`.
          synthAtMs: ms(synthAt),
          // Where the ENGRAVING put it — the old playback position. Must NOT equal it.
          engravedAtMs: ms(engravedAt),
          synthFollowsPerformance: synthAt !== null && Math.abs(synthAt - wanted) < 0.002,
          engravingSnappedBack: engravedAt !== null && Math.abs(engravedAt - wanted) > 0.005,
          restoredNotes: this.runtime.get().source?.detected?.notes.length ?? 0
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      }
    };
    /**
     * Reopening a file that has saved work must ASK, and both answers must be real.
     *
     * Three claims, driven against the real blob and a real second app:
     *
     *  1. a boot that finds restorable work puts a prompt on screen and restores NOTHING
     *     until it is answered;
     *  2. "Start fresh" leaves the second app with no take AND clears the stored copy, so
     *     the same question is not waiting at the next boot;
     *  3. "Resume previous work" brings the take back, with its notes.
     *
     * Run twice against two throwaway apps because the two answers are destructive in
     * opposite directions — fresh deletes the blob, resume needs it — so the blob is written
     * again between them. The live app is never touched: everything happens in an off-screen
     * root, and the blob is put back the way it was found on the way out.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_RESUMEPROMPT__ = async () => {
      const settled = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
      const roots: HTMLElement[] = [];
      const makeRoot = () => {
        const node = document.createElement('div');
        Object.assign(node.style, {
          position: 'fixed',
          left: '-20000px',
          top: '0',
          width: '1200px',
          height: '800px'
        });
        document.body.appendChild(node);
        roots.push(node);
        return node;
      };
      /** What the prompt looks like inside one app's own root. */
      const readPrompt = (root: HTMLElement) => {
        const dialog = root.querySelector('[data-dialog="resume-prompt"]');
        return {
          shown: !!dialog,
          message: dialog?.querySelector('[data-role="confirm-message"]')?.textContent?.trim() ?? null,
          resumeLabel: dialog?.querySelector('[data-role="confirm-ok"]')?.textContent?.trim() ?? null,
          freshLabel: dialog?.querySelector('[data-role="confirm-cancel"]')?.textContent?.trim() ?? null
        };
      };
      const press = (root: HTMLElement, role: string) => {
        const button = root.querySelector<HTMLButtonElement>(`[data-dialog="resume-prompt"] [data-role="${role}"]`);
        button?.click();
        return !!button;
      };

      const original = await this.session.load();
      try {
        if (!this.session.canSave) return { error: 'this host cannot persist state' };
        // A blob with a real take in it, written by the live app through the real bridge.
        this.scheduleSave();
        await this.session.flush();
        const saved = await this.session.load();
        if (!saved) return { error: 'nothing was saved to reopen' };
        const savedNotes = saved.source?.detected?.notes.length ?? 0;

        // --- 1 + 2: the prompt appears, and Start fresh is truly fresh ---------
        const freshRoot = makeRoot();
        const freshApp = bootSecondApp(freshRoot);
        await settled(900);
        const promptOnFresh = readPrompt(freshRoot);
        const pressedFresh = press(freshRoot, 'confirm-cancel');
        await freshApp;
        await settled(400);
        const afterFresh = (await bootSecondApp(makeRoot(), { autoResume: true })).probe() as Record<string, unknown>;
        const blobAfterFresh = await this.session.load();

        // --- 3: and Resume brings it back --------------------------------------
        await this.bridge.setPersistedState?.(JSON.stringify(saved));
        const resumeRoot = makeRoot();
        const resumeApp = bootSecondApp(resumeRoot);
        await settled(900);
        const promptOnResume = readPrompt(resumeRoot);
        const pressedResume = press(resumeRoot, 'confirm-ok');
        const resumed = (await resumeApp).probe() as Record<string, unknown>;
        await settled(600);

        return {
          savedNotes,
          promptOnFresh,
          pressedFresh,
          // Fresh means fresh: no take on the app that answered, and no blob left behind for
          // the next one to find.
          freshHasTake: (afterFresh.noteCount as number) > 0,
          blobClearedByFresh: blobAfterFresh === null,
          promptOnResume,
          pressedResume,
          resumedNotes: (resumed.noteCount as number) ?? 0
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      } finally {
        // Put the store back exactly as it was found, whatever happened above.
        await this.bridge.setPersistedState?.(original ? JSON.stringify(original) : '').catch(() => undefined);
        for (const node of roots) node.remove();
      }
    };

    /**
     * Plugin amnesia, reproduced and disproved without a DAW.
     *
     * The reported bug is that switching REAPER tracks destroys the plugin editor and
     * everything on it. There is no way to destroy a WebView from inside it, but the thing
     * that actually has to be true is testable: after a mutation, a SECOND app that has
     * only the persisted blob to go on must come up showing exactly the same thing.
     *
     * So: mutate → save through the real bridge → boot a fresh App into a fresh root →
     * compare fingerprints. Both apps are real, the blob is real, and the second one has
     * no access to the first one's memory.
     *
     * IT MUTATES THE LIVE APP, so the harness runs it last. It puts back what it changed,
     * but an edit and a re-render have happened by the time it does.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_PERSIST__ = async () => {
      const clone = document.createElement('div');
      // Off-screen but really laid out: alphaTab engraves nothing in a zero-sized box, and
      // an engraving that never happened would pass a fingerprint check by accident.
      Object.assign(clone.style, {
        position: 'fixed',
        left: '-20000px',
        top: '0',
        width: '1200px',
        height: '800px'
      });

      const settled = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

      try {
        if (!this.session.canSave) return { error: 'this host cannot persist state' };

        const ids = [...(this.triview?.scoreIndex?.idToNote.keys() ?? [])];
        if (ids.length < 3) return { error: 'not enough notes to edit' };

        const before = this.sessionProbe() as Record<string, unknown>;
        const beforeVoice = this.settings.get().playbackVoice;
        const beforeBlend = this.transport.blend;

        // Mutations that persist by three different routes: the edit log, the settings
        // block, the view block.
        //
        // A pitch change and a deletion, because both always apply and they fail
        // differently if the log is wrong — a lost pitch edit shows up as the wrong fret,
        // a lost deletion as a note that should not be there at all. The string move is
        // attempted between them and is EXPECTED to be refused on some fixtures (string 2
        // of a 4-string bass is not reachable from every fret). That a refused action never
        // reaches the log is exactly the mirror behaviour worth exercising.
        // NOTATION EDITS, NAMED AS SUCH. What this probe is testing is the EDIT LOG — the
        // route by which a change to the written page survives the editor being destroyed —
        // so it asks for the notation layer explicitly. F7 sends a pitch dragged on the sheet
        // to the PERFORMANCE instead, and that route persists by a different and already
        // covered mechanism (the take is in the blob; see `storedDetectedNotes`), so leaving
        // this on 'auto' would quietly stop exercising the log at all.
        this.perform(new ChangePitchAction(ids[0], 1), null, 'notation');
        this.perform(new ChangeStringAction(ids[1], 1), null, 'notation');
        this.perform(new DeleteNoteAction(ids[2]), null);
        // A RECORDED voice, because `sanitizeSettings` resets anything outside the sampled set
        // back to the default on load. 'pad' is compatibility-only now that the oscillator
        // choices are gone, so mutating to it made this probe assert that a setting the app
        // deliberately refuses to restore comes back anyway.
        this.settings.set({ playbackVoice: 'marimba' });
        this.transport.setBlend(0.8);
        this.scheduleSave();

        const mutated = this.sessionProbe() as Record<string, unknown>;
        // Hand it over for real rather than trusting the debounce to have fired.
        await this.session.flush();

        const stored = await this.session.load();
        if (!stored) return { error: 'nothing came back out of the store' };

        document.body.appendChild(clone);
        const second = await bootSecondApp(clone, { autoResume: true });
        // alphaTab engraves asynchronously; the model is there at once but let it draw.
        await settled(1200);
        const restored = second.probe() as Record<string, unknown>;

        // Put the live app back the way it was, so nothing downstream inherits the probe's
        // edits. One undo per edit that actually landed. (The harness runs this last
        // anyway — belt and braces.)
        for (let i = 0; i < ((mutated.edits as number) ?? 0); i++) this.undo();
        this.settings.set({ playbackVoice: beforeVoice });
        this.transport.setBlend(beforeBlend);

        const same = (key: string) => JSON.stringify(mutated[key]) === JSON.stringify(restored[key]);
        return {
          before,
          mutated,
          restored,
          blobBytes: JSON.stringify(stored).length,
          storedEdits: stored.edits.length,
          storedCursor: stored.editCursor,
          // The blob must be enough on its own — a restore that re-transcribed would be a
          // different (and much slower) fix than the one being claimed.
          storedDetectedNotes: stored.source?.detected?.notes.length ?? 0,
          storedPeakBuckets: stored.source?.peaks?.buckets ?? 0,
          identical: [
            'notesFingerprint',
            'noteCount',
            'bars',
            'noteGlyphs',
            'tempoBpm',
            'timeSig',
            'midiBytes',
            'barOneSec',
            'detectedNotes',
            'peakBuckets',
            'sourceName',
            'edits',
            'editKinds',
            'blend',
            'settings'
          ].filter((k) => !same(k)),
          // The edit really did change something, or "identical" would be a tautology.
          mutationChangedTheScore: before.notesFingerprint !== mutated.notesFingerprint
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      } finally {
        clone.remove();
      }
    };
    // The exact bytes the export buttons would write. Lets an integration harness parse a
    // real export without driving a native save dialog.
    (window as unknown as Record<string, unknown>).__RIFFSHEET_EXPORTS__ = () => {
      const score = this.runtime.get().score;
      if (!score) return null;
      const b64 = (bytes: Uint8Array) => {
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      };
      return {
        musicxml: score.musicxml(),
        midiQuantizedB64: b64(score.midi(true)),
        midiAsPlayedB64: b64(this.sourceMidi ?? score.midi(false))
      };
    };

    /**
     * What a `.riffsheet` file actually carries, proved by a real round trip.
     *
     * The document is meant to be the portable form of a session: the take it is OF, the
     * PERFORMED notes, the user's edits, and the settings the sheet was engraved with. Three
     * of those four were carried and one was not — the audio reference was missing, and the
     * loader replaced it with a MIDI stub, so a reopened document could never play or
     * re-listen to its own recording. Nothing caught it because the persistence probe above
     * tests the session BLOB, which does carry `audio`.
     *
     * So this goes through `buildRiffsheetDocument` → `writeRiffsheetDocument` →
     * `readRiffsheetDocument`, the same three the button and the open path use.
     *
     * The second half swaps in a synthetic FILE reference before building, because the demo
     * fixture has no recording behind it: without it the audio assertions would only ever see
     * `kind: 'midi'` and would pass while carrying nothing. It also proves the two volatile
     * handles are dropped — a token names a decode inside the process that wrote the file, and
     * writing it into a document that can be opened on another machine is a lie.
     *
     * Read-only apart from that swap, which is put back before returning.
     */
    (window as unknown as Record<string, unknown>).__RIFFSHEET_DOCUMENT__ = () => {
      const roundTrip = (doc: RiffsheetDocument) => {
        const bytes = writeRiffsheetDocument(doc);
        return {
          back: readRiffsheetDocument(bytes),
          // The document is a ZIP now, so the score is DEFLATE'd and searching the FILE for a
          // string would answer "absent" for every string on earth — including the dead token
          // this probe exists to prove is absent. `documentScoreText` unpacks score.json.
          text: documentScoreText(bytes),
          bytes,
          isZip: bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
        };
      };
      try {
        const live = this.buildRiffsheetDocument();
        if (!live) return { error: 'no source loaded' };
        const liveTrip = roundTrip(live);

        const before = this.audioRef;
        let synthetic: ReturnType<typeof roundTrip> | null = null;
        let syntheticDoc: RiffsheetDocument | null = null;
        try {
          this.audioRef = {
            kind: 'file',
            name: 'take.wav',
            path: '/takes/probe take.wav',
            token: 'tok-should-not-survive',
            pcmUrl: 'http://127.0.0.1:1/pcm/should-not-survive',
            durationSec: 12.5
          };
          syntheticDoc = this.buildRiffsheetDocument();
          if (syntheticDoc) synthetic = roundTrip(syntheticDoc);
        } finally {
          this.audioRef = before;
        }

        const settings = this.settings.get();
        const restoredSettings = liveTrip.back.settings as Record<string, unknown>;
        return {
          // (1) audio reference
          liveAudioKind: liveTrip.back.audio?.kind ?? null,
          syntheticAudio: synthetic?.back.audio ?? null,
          tokenInBytes: synthetic ? synthetic.text.includes('should-not-survive') : true,
          // (2) performed layer — the detections, not the engraved score
          performedNotes: liveTrip.back.source.detected?.notes.length ?? 0,
          performedNotesMatchLive: JSON.stringify(liveTrip.back.source.detected?.notes ?? null)
            === JSON.stringify(this.runtime.get().source?.detected?.notes ?? null),
          performedBeats: liveTrip.back.source.detected?.beats?.length ?? 0,
          // (3) user edits
          edits: liveTrip.back.edits.length,
          liveEdits: this.editLog.length,
          editCursor: liveTrip.back.editCursor,
          liveEditCursor: this.editCursor,
          editKinds: liveTrip.back.edits.map((e) => e.kind),
          // (4) settings
          settingsKeys: Object.keys(restoredSettings).length,
          settingsMatch: JSON.stringify(restoredSettings) === JSON.stringify(settings),
          // The version must NOT move for an additive field: the reader rejects any version it
          // does not know, so a bump would make every document written before it unopenable. It
          // moved to 3 for the ZIP container, which is not additive — the whole file changed
          // shape — and the reader takes v1 and v2 by their magic bytes instead.
          version: liveTrip.back.version,
          sourceName: liveTrip.back.source.name,
          peakBuckets: liveTrip.back.source.peaks?.buckets ?? 0,
          // (5) the container itself
          container: liveTrip.isZip ? 'zip' : 'json',
          bytes: liveTrip.bytes.byteLength,
          scoreJsonChars: liveTrip.text.length,
          // The recording, in and out. Equal lengths here and a `true` in `audioIdentical` is the
          // claim the format is for: STORE'd bytes come back exactly as they went in.
          audioIn: this.embeddedAudio()?.bytes.byteLength ?? 0,
          audioOut: liveTrip.back.audioData?.bytes.byteLength ?? 0,
          // …and the reviewer's scenario: is what the fader is about to claim actually true?
          originalAvailable: this.transport.originalAvailable,
          nativeAudioPending: this.nativeAudioPending,
          restoredBy: this.originalRestoredBy
        };
      } catch (e) {
        return { error: String((e as Error).stack ?? e) };
      }
    };
  }

  // =========================================================================
  // The notation build — cheap, and re-runnable
  // =========================================================================

  /**
   * Rebuild the sheet from the notes we already have.
   *
   * Runs on every settings change and on every release of the bar-1 marker. It never
   * re-listens to the audio, which is why moving the marker is instant.
   */
  /**
   * The DAW grid the sheet should actually be built on, or nothing.
   *
   * Two sources, and the capture's wins because it is strictly better information: it knows
   * where the DAW's bar lines fell *inside this recording*, where the live one only knows the
   * tempo and the meter. The live one exists so that dropping a wav onto a plugin can still
   * borrow the DAW's tempo, which is what the user was asking for and what the app could not
   * do at all before.
   *
   * Note what is NOT here: `settings.useHostGrid`. This answers "is there a grid available",
   * and the pipeline answers "should it be used" — one switch, read in one place
   * (pipeline/index.ts), so the chip and the sheet cannot disagree about whether it is on.
   */
  /**
   * Follow the DAW's tempo and meter while the plugin is open.
   *
   * The old behaviour took one snapshot at capture time and never looked again, so changing
   * REAPER's tempo afterwards left the chip lit and the sheet wrong with nothing to say it had
   * gone stale. The shell change-gates this event and caps it at 20 Hz, so an idle plugin
   * costs nothing.
   *
   * Gated hard on a REAL change to the two numbers we use. `hostInfo` also carries the
   * playhead, which moves constantly during playback; rebuilding a sheet on that would be a
   * pipeline run per frame.
   */
  private watchHostTimeline(): void {
    if (!this.bridge.onHostInfo) return;
    this.unsubHost?.();
    let last = '';
    this.unsubHost = this.bridge.onHostInfo((info) => {
      const signature = `${info.bpm ?? ''}|${info.timeSignature?.numerator ?? ''}/${
        info.timeSignature?.denominator ?? ''
      }|${info.hasHostTimeline ?? false}`;
      if (signature === last) return;
      last = signature;

      const before = this.runtime.get().host;
      this.runtime.set({ host: { ...(before ?? info), ...info } });
      if (this.runtime.get().screen !== 'main') return;

      // Only touch the sheet when the DAW's grid is actually what it is being built on. A
      // captured take carries its own measured bar lines and is NOT re-derived from the live
      // tempo — those bar lines are better information and they belong to that recording.
      const usingLive = this.settings.get().useHostGrid && !this.runtime.get().source?.hostGrid;
      if (usingLive && this.runtime.get().source?.detected) this.rebuildNotation({ keepEdits: true });
      this.renderMain();
    });
  }

  private effectiveHostGrid(): SourceAudio['hostGrid'] {
    return this.runtime.get().source?.hostGrid ?? liveHostGrid(this.runtime.get().host);
  }

  /**
   * One performance in, one sheet out. Both the real rebuild and the snap's measuring pass go
   * through here so they cannot disagree about anything except the notes they were handed.
   */
  private buildScoreFrom(source: SourceAudio, notes: InputNote[]): RiffScore {
    return buildRiffScore(
      {
        notes,
        beats: source.detected?.beats,
        downbeats: source.detected?.downbeats,
        audioDurationSec: source.durationSec,
        blankBars: source.documentBars,
        // The pipeline anchors bar 1 / beat 1 here and KEEPS anything before it as an
        // anacrusis, so auto-trim and the user's marker are the same knob.
        startOffsetSec: source.barOneSec,
        hostGrid: this.effectiveHostGrid(),
        title: source.name.replace(/\.[^.]+$/, '')
      },
      {
        ...this.settings.get(),
        tempoBpm: source.tempoBpm,
        timeSignature: source.timeSignature,
        keyFifths: source.keyFifths
      }
    );
  }

  /**
   * What the snap measures against: a tempo and a written origin, taken from a build of the
   * RAW take and never of a snapped one.
   *
   * This is the loop-breaker. The snap needs a tempo; the tempo comes out of a build; the build
   * is fed by the snap. Feeding that build the snapped notes would let a snap change the tempo
   * that decides the snap — different lines on the second pass, different notes on the third.
   * Measuring the basis off the recording makes it a property of the PERFORMANCE, so it is the
   * same number whether the switch is on or off and however many times the grid is changed.
   *
   * Memoised on the take rather than recomputed per call: `setPerformance` replaces the notes
   * array on every edit, so reference identity is exactly the right invalidation signal, and
   * the scalars beside it are the other inputs that can move a bar line.
   */
  private snapBasisNotes: InputNote[] | null = null;
  private snapBasisKey = '';
  private snapBasisValue: { tempoBpm: number; originSec: number } | null = null;

  private snapBasis(source: SourceAudio, raw: InputNote[]): { tempoBpm: number; originSec: number } | null {
    const hostGrid = this.effectiveHostGrid();
    const s = this.settings.get();
    // EVERY INPUT `buildScoreFrom` CAN SEE, or the memo hands back a basis measured under
    // different conditions. The three that were missing are the three that decide whether the
    // DAW's numbers are used at all:
    //
    //  - `useHostGrid` is the switch the pipeline reads (pipeline/index.ts §hostGrid). The key
    //    carried the DAW's tempo but not whether it was being applied, so turning the tempo
    //    source off and on again reused a basis built the other way and snapped the take to
    //    lines that were no longer on the page. That is the reported bug.
    //  - `hostGrid.source` decides whether the grid brings measured bar lines or only a tempo,
    //    which moves the ORIGIN even when the bpm and meter are identical.
    //  - `grid` reaches the build as the quantizer's brief. It has no business changing a tempo
    //    and in practice does not, but a memo key that omits an input the build reads is a bet
    //    rather than a cache, and this one is free to stop making.
    const key = JSON.stringify([
      source.barOneSec,
      source.durationSec,
      source.tempoBpm ?? null,
      source.timeSignature ?? null,
      source.keyFifths ?? null,
      source.documentBars ?? null,
      s.useHostGrid,
      s.grid,
      hostGrid
        ? [hostGrid.hostBpm, hostGrid.hostTimeSig, hostGrid.barStartsSec?.length ?? 0, hostGrid.source]
        : null,
      source.detected?.beats?.length ?? 0,
      source.detected?.downbeats?.length ?? 0
    ]);
    if (this.snapBasisNotes === raw && this.snapBasisKey === key && this.snapBasisValue) {
      return this.snapBasisValue;
    }
    try {
      const score = this.buildScoreFrom(source, raw);
      this.snapBasisNotes = raw;
      this.snapBasisKey = key;
      this.snapBasisValue = { tempoBpm: score.tempoBpm, originSec: this.originSec(score) };
      return this.snapBasisValue;
    } catch {
      // A take the pipeline cannot build is a take with no grid to snap to. The raw notes are
      // still perfectly drawable, so this costs the snap and nothing else.
      return null;
    }
  }

  /**
   * ============================ THE TAP POINT ============================
   *
   * The performance layer as everything downstream should see it: raw when Snap to grid is off,
   * snapped when it is on. The roll draws this, the sheet is built from this, playback is
   * retimed to this, and every export comes off the sheet — so there is exactly ONE arrow out
   * of the performance and no way for the page to disagree with the file.
   *
   * TWO THINGS THIS DELIBERATELY IS NOT.
   *
   * It is not where the Quantize menu lives. Quantize (`AppSettings.grid`) is handed to the
   * pipeline inside `buildScoreFrom` and reaches the SHEET only; it cannot touch this value, so
   * changing it repaints the page and leaves every rectangle on the roll exactly where it was.
   * That is #36, and the check is that this function does not read `settings.grid`.
   *
   * It is not a mutation. `source.detected.notes` stays the recording, whatever the switch says,
   * which is what makes switching the snap off restore the take to the bit rather than to
   * something that has been rounded and un-rounded.
   */
  /**
   * The player's cuts on this take, normalized. Empty on every take that has never been cut.
   *
   * MEMOISED, and not for the arithmetic — `normalizeCuts` is a sort of a two-entry list. It is
   * memoised because the RESULT'S IDENTITY is what `editedSource()` keys its own memo on, and
   * that one re-splices twenty thousand peak buckets. Handing back a fresh array here would
   * miss that memo on every frame of every drag.
   */
  private cutsFor: CutSpan[] | null = null;
  private cutsValue: CutSpan[] = NO_CUTS;

  private cuts(): CutSpan[] {
    const source = this.runtime.get().source;
    const raw = source?.cuts;
    if (!raw?.length || !source) return NO_CUTS;
    if (this.cutsFor === raw) return this.cutsValue;
    this.cutsFor = raw;
    this.cutsValue = normalizeCuts(raw, source.durationSec);
    return this.cutsValue;
  }

  /**
   * ==================== THE TAKE AS THE PAGE SEES IT (F16) ====================
   *
   * The recording with the player's cuts closed up: shorter, with the removed spans gone from
   * its peaks, its notes, its beats and its length. Everything that draws or writes the take
   * reads it from HERE rather than from `runtime.source`, which stays the whole recording for
   * as long as the document exists.
   *
   * ONE ACCESSOR RATHER THAN A MAPPING AT EVERY CONSUMER, because the consumers are the sheet
   * (via `buildScoreFrom`, which reads the beats and the duration as well as the notes), the
   * roll, the strip and every export — and a cut that reached four of those five would be a
   * page whose parts disagreed about how long the music is.
   *
   * IDENTITY WHEN THERE ARE NO CUTS. Not an optimisation: `performanceFeed()` promises to hand
   * playback the take's OWN array while the snap is off (proved by `__RIFFSHEET_SNAPFEED__`),
   * and that promise is kept by this returning the very object it was given. The whole feature
   * is inert on a take nobody has cut.
   *
   * Memoised on the take and the cut list by reference, which is exact: both are replaced
   * wholesale on every edit and never mutated in place.
   */
  private editedSourceFor: SourceAudio | null = null;
  private editedSourceCuts: CutSpan[] | null = null;
  private editedSourceValue: SourceAudio | null = null;

  private editedSource(): SourceAudio | null {
    const source = this.runtime.get().source;
    if (!source) return null;
    const cuts = this.cuts();
    if (!cuts.length) return source;
    if (this.editedSourceFor === source && this.editedSourceCuts === cuts && this.editedSourceValue) {
      return this.editedSourceValue;
    }
    const detected = source.detected;
    const value: SourceAudio = {
      ...source,
      durationSec: editedDurationSec(cuts, source.durationSec),
      peaks: applyCutsToPeaks(source.peaks, source.durationSec, cuts),
      // The auto-trim overlay dims the head and tail of the RECORDING. Once the player has
      // actually cut, that dimming is describing tape which is no longer on screen, so it is
      // dropped rather than remapped — a trim they have accepted is not still "trimmable".
      trim: null,
      barOneSec: audioToEditedSec(source.barOneSec, cuts),
      // Cuts are not part of the edited view of the take; carrying them would invite a second
      // application of the same mapping.
      cuts: undefined,
      ...(detected
        ? {
            detected: {
              notes: mapNotesThroughCuts(detected.notes, cuts),
              beats: mapTimesThroughCuts(detected.beats, cuts),
              downbeats: mapTimesThroughCuts(detected.downbeats, cuts)
            }
          }
        : {})
    };
    this.editedSourceFor = source;
    this.editedSourceCuts = cuts;
    this.editedSourceValue = value;
    return value;
  }

  private performanceFeed(): InputNote[] {
    const source = this.editedSource();
    const raw = source?.detected?.notes ?? [];
    const s = this.settings.get();
    // The same reference when the switch is off, so nothing downstream can tell this function
    // was added — see the playback-unchanged proof in `__RIFFSHEET_SNAPFEED__`.
    if (!s.rollSnapToGrid || s.rollGrid === 'free' || raw.length === 0 || !source) return raw;
    const basis = this.snapBasis(source, raw);
    if (!basis) return raw;
    const unitSec = rollSnapUnitSec(s.rollGrid, basis.tempoBpm);
    return snapPerformanceToGrid(raw, unitSec, basis.originSec, basis.tempoBpm);
  }

  /**
   * The same feed in the roll's own shape.
   *
   * A note with no id keeps its rectangle but gets a prefixed stand-in, so it is drawable and
   * simply not selectable — the roll's own rule for an unresolvable id (see `PianoRollNote`).
   * The prefix contains a colon, which neither the engine's `n<index>` nor the app's `add<N>`
   * can produce, so a stand-in can never collide with a real identity.
   */
  private rollFeedNotes(): RollPerformanceNote[] {
    return this.performanceFeed().map((n, i) => ({
      id: n.id ?? `raw:${i}`,
      midi: n.midi,
      startSec: n.startSec,
      endSec: n.endSec,
      ...(n.velocity !== undefined ? { velocity: n.velocity } : {})
    }));
  }

  private rebuildNotation(options?: { keepEdits?: boolean }): void {
    // THE EDITED TAKE (F16), so the beats, the duration and the bar-1 anchor the pipeline is
    // handed all describe the same music as the notes it is handed. Identical to
    // `runtime.source` until the player cuts something out.
    const source = this.editedSource();
    if (!source?.detected) return;

    try {
      // THE FEED, not the raw notes. With the snap off these are the same array; with it on the
      // sheet is written from what the roll is showing, which is the whole of "the sheet follows
      // the roll" and the reason there is no second path from the performance to the pipeline.
      const score = this.buildScoreFrom(source, this.performanceFeed());
      this.runtime.set({ score, selection: [] });

      // The undo stack keys on note ids, but the alphaTab objects those ids resolved to have
      // just been replaced wholesale, so the stack itself cannot survive a rebuild.
      const log = this.editLog;
      const cursor = this.editCursor;
      this.undoStack.clear();
      this.editLog = [];
      this.editCursor = -1;
      this.applyScoreToViews(score);

      // Put the player's notation edits back on top.
      //
      // This used to be unconditional destruction: any rebuild — a settings change, a new
      // tempo, a nudge of the bar-1 marker, and now every piano-roll edit — threw away every
      // correction the player had made, without saying so. That was survivable when a rebuild
      // was rare; it is not survivable now that dragging a rectangle causes one.
      //
      // Replaying is safe because the edits are keyed on note ids, and ids are stable across a
      // rebuild by construction (design notes §4.8) — the same property session restore has
      // relied on since v1.1, through this same code path. An edit that no longer applies (a
      // nudge into a beat that a re-quantize filled) is refused by the action itself and
      // quietly dropped from the log rather than half-applied.
      //
      // `keepEdits: false` is for a genuinely new performance, where the old ids mean nothing.
      if (options?.keepEdits !== false && log.length > 0) this.replayEdits(log, cursor);
      else if (options?.keepEdits === false) this.resetHistories();

      // A new sheet is the biggest change there is; this is the save that matters most.
      this.scheduleSave();
    } catch (e) {
      // The stack matters here: this path spans three teams' code, so a bare message
      // ("cannot read 'tracks' of undefined") is not enough to tell whose it is.
      console.error('[riffsheet] rebuildNotation failed', e);
      this.toast('danger', 'Could not write the sheet', (e as Error).message);
    }
  }

  /**
   * Written second 0 on the recording's clock, for the score on screen.
   *
   * The sheet cursor, the synth and the piano roll all ask this same question and must get
   * the same answer — that is the whole of the v1.1 cursor-leads-audio fix.
   *
   * F13. IT IS PINNED TO THE FIRST ATTACK, not to the bar-1 marker.
   *
   * `scoreOriginSec()` derives the answer from `barOneSec`, which is 0 unless somebody has
   * dragged the marker, so a take with leading silence claimed bar 1 was at second 0 while the
   * roll and the strip drew that same first attack where it was actually played. Every mapping
   * on the page was then uniformly wrong by the length of the silence, and Align had nothing to
   * bring the two together with. One attack pins the two clocks, and the first one is the only
   * event both pictures are certain to contain — see `alignOriginSec()` in view/timeAxis.ts,
   * which is the pure half and is unit-tested there.
   *
   * `scoreOriginSec()` remains the FALLBACK, so a blank document, a symbolic import with no
   * performance behind it, and a score whose IR carries no note at all keep exactly the answer
   * they had before this existed.
   */
  private originSec(score: RiffScore): number {
    return alignOriginSec(
      firstWrittenSecOf(score),
      this.firstPerformedSec(),
      scoreOriginSec(score, this.runtime.get().source?.barOneSec ?? 0)
    );
  }

  /**
   * The earliest second the performance layer reports, on the recording's clock.
   *
   * THE RAW TAKE, deliberately, and not `performanceFeed()`. The feed's snap layer asks
   * `snapBasis()` for a grid to round onto, `snapBasis()` builds a score to measure it, and
   * measuring it calls `originSec()` — reading the feed here would close that ring into an
   * infinite recursion. The raw first attack is also the more honest of the two answers: the
   * origin ties the page to the RECORDING, and the recording is where the note was played
   * rather than where a grid would have preferred it.
   */
  private firstPerformedSec(): number | null {
    // The EDITED take (F16): the origin ties the page's two clocks together, and after a cut
    // the page's audio clock is the edited one. Un-cut, this is `runtime.source` itself.
    const notes = this.editedSource()?.detected?.notes;
    if (!notes || notes.length === 0) return null;
    let first: number | null = null;
    for (const n of notes) {
      if (!Number.isFinite(n.startSec)) continue;
      if (first === null || n.startSec < first) first = n.startSec;
    }
    return first;
  }

  /**
   * The live sheet: the alphaTab graph on screen plus the identity map that gives each note
   * its sounding pitch. Null until the tri-view has built one.
   *
   * This is what an edit mutates, and therefore the only honest source for any second view of
   * the same notes. `RiffScore.ir` is a build-time copy that no edit ever reaches.
   */
  /**
   * The sheet's own x-axis, handed to the piano roll so the two draw on ONE ruler.
   *
   * This is the whole of "the MIDI notes and the sheet notes must line up". The roll used to
   * spread the take linearly across its pane while the sheet engraved it with alphaTab's
   * uneven bar spacing and scrolled it, so the two could agree only by accident, and never
   * for more than one bar at a time. Now a rectangle's x comes from the same bounds lookup the
   * notehead's x came from, minus the same scroll offset — they cannot disagree, because there
   * is only one answer to ask for.
   *
   * Written seconds in, sheet content pixels out. `tickToContentX` is TriView's; the tick
   * conversion is alphaTab's own 960-per-quarter, exactly as `secondsToTick` uses below.
   */
  private sheetMap(): SheetMap | null {
    const tv = this.triview;
    const score = this.runtime.get().score;
    if (!tv || !score) return null;
    const view = tv.viewport();
    if (!view) return null;
    const ticksPerSec = (score.tempoBpm / 60) * ALPHATAB_QUARTER_TICKS;
    return {
      writtenSecToContentX: (sec) => tv.tickToContentX(sec * ticksPerSec),
      contentXToWrittenSec: (x) => {
        const tick = tv.contentXToTick(x);
        return tick === null ? null : tick / ticksPerSec;
      },
      scrollLeft: view.scrollLeft,
      viewportWidth: view.viewportWidth,
      contentWidth: view.contentWidth
    };
  }

  // `resetSheetView()` stood here, behind the "Reset view" chip. Both are gone: the chip
  // retired with "Fit" (see §viewToolChips), and what it did — put the sheet's zoom back and
  // fit the roll's pitch window — is now a double-click on the roll's gutter, which fits, and
  // nothing at all for the sheet, whose zoom has never been movable from the UI.


  /**
   * Repaint everything whose x-axis depends on the sheet's scroll and zoom.
   *
   * Called from TriView's viewport events, which fire on scroll and after every render — a
   * re-render can change the content width, and a roll that only listened for scrolls would
   * quietly go stale after a zoom. Nothing here polls.
   */
  private syncViewports(): void {
    // The strip is on the sheet's axis too now. `setViewportRange` early-returns when the span is
    // unchanged, so a zoom that happens to preserve the span would leave the envelope stale.
    this.waveform?.draw();
    this.updateScrollbar();
    const tv = this.triview;
    const score = this.runtime.get().score;
    if (!tv) return;
    // The roll has a stable recording-time axis; it only needs to be told to paint again.
    this.pianoRoll?.draw();

    if (!this.waveform || !score) return;
    const view = tv.viewport();
    if (!view) {
      this.waveform.setViewportRange(null, null);
      this.setAlignedWindow(null);
      return;
    }
    // The waveform is the whole-take overview and speaks RECORDING seconds, so the bracket
    // has to come back across the bar-1 origin — the sheet's clock starts at bar 1 and the
    // recording's starts at the top of the file (§4.13). Getting this wrong would put the
    // bracket a count-in adrift of the music it claims to be showing.
    const map = this.sheetMap();
    const origin = this.originSec(score);
    const from = map?.contentXToWrittenSec(view.scrollLeft);
    const to = map?.contentXToWrittenSec(view.scrollLeft + view.viewportWidth);
    this.waveform.setViewportRange(
      from === null || from === undefined ? null : from + origin,
      to === null || to === undefined ? null : to + origin
    );
    // The ALIGNED window is measured between the same two x's the roll and the strip put their
    // PLOT between, not between the viewport's own edges: both panes spend their first
    // TIMELINE_GUTTER_PX on pitch labels, and the sheet spends exactly the same column on page
    // padding (view/triview.ts §D). Measuring edge-to-edge would hand the roll a span it draws
    // 34px narrower than the sheet does, and every note would sit a little left of its notehead.
    const plotFrom = map?.contentXToWrittenSec(view.scrollLeft + TIMELINE_GUTTER_PX);
    const plotTo = to;
    const fromSec = plotFrom === null || plotFrom === undefined ? null : plotFrom + origin;
    const toSec = plotTo === null || plotTo === undefined ? null : plotTo + origin;
    // THE WHOLE OF ALIGN'S GEOMETRY, and it is two numbers.
    //
    // The sheet's visible span, mapped back through alphaTab's own bounds, handed to the roll
    // and the strip so all three panes draw the same seconds across the same pixels. What is
    // NOT handed over is the sheet's x-axis: inside the window each pane stays linear in time,
    // which is what keeps the picture of a performance honest and what makes adding a note
    // unable to move any other note. See view/pianoroll.ts §setTimeWindow.
    // HELD ACROSS A REBUILD, and this is the hard rule rather than an optimisation.
    //
    // A roll edit re-runs the pipeline and re-engraves, which moves the sheet's own geometry:
    // the same scroll position now shows slightly different music, so a window re-derived from
    // it would be a slightly different window — and every rectangle on the roll would shift
    // under the hand that had just added one note. That is precisely the reflow the old linked
    // mode was deleted for, arriving through a different door.
    //
    // So the window is a memory, not a live read. It follows the sheet when the PLAYER moves
    // the sheet, and it is left exactly where it was through a rebuild. applyScoreToViews()
    // opens the hold; the next scroll after it expires picks the sheet up again.
    // The hold covers a REBUILD, not a scroll. `restoreScrollAnchor` puts the sheet back within
    // a pixel or two of where it was, so a few pixels of drift is the rebuild; anything more is
    // the player moving the page, and that must pick the ruler up again immediately or the roll
    // would sit at a stale offset for a second and a half.
    const scrolled = Math.abs(view.scrollLeft - this.alignHoldScrollLeft) > ALIGN_HOLD_SLOP_PX;
    const holding =
      this.alignedWindow !== null && performance.now() < this.alignHoldUntil && !scrolled;
    if (!holding) {
      this.setAlignedWindow(
        this.settings.get().alignViews && fromSec !== null && toSec !== null && toSec > fromSec
          ? { fromSec, toSec }
          : null
      );
    } else if (!this.settings.get().alignViews) {
      // Switching Align off is the player speaking; it outranks the hold.
      this.setAlignedWindow(null);
    } else {
      // Held — but still PUSHED. `renderMain()` builds a fresh roll and a fresh strip, and a
      // pane that has just been constructed knows nothing; without this it would draw the whole
      // take for as long as the hold lasted and then jump. Idempotent on both sides.
      this.setAlignedWindow(this.alignedWindow);
    }
  }

  /** One writer for both panes, so they cannot end up looking at different moments. */
  private setAlignedWindow(w: { fromSec: number; toSec: number } | null): void {
    this.alignedWindow = w;
    const anchors = w ? this.alignAnchors(w) : null;
    this.alignedAnchors = anchors;
    this.pianoRoll?.setTimeAnchors(anchors);
    // THE STRIP TAKES THE ROLL'S WINDOW, not the sheet's, and the difference is a clamp.
    //
    // The window derived from the sheet can start before the recording does — a count-in puts
    // written second 0 a tenth of a second into the file, so the sheet's left edge maps to a
    // NEGATIVE audio second. The roll refuses that (`clampWindow`, against the take's own
    // length); the strip, handed the raw anchors, did not, and the two ended up drawing rulers
    // 0.1 s apart while both believed they were aligned. Reading back what the roll actually
    // applied is what makes "all three panes show the same seconds" true rather than intended.
    const applied = anchors && this.pianoRoll ? timeWindowAnchors(this.pianoRoll.getTimeWindow()) : anchors;
    this.waveform?.setTimeAnchors(applied);
  }

  /**
   * THE SHARED RULER: the sheet's visible span, and nothing finer.
   *
   * The anchor list is deliberately the two ends. A finer ruler is possible in principle — one
   * anchor per beat, taken from alphaTab's bounds — and it was built and measured, because two
   * ends and a straight line between them cannot follow an engraving that spaces a dense bar
   * wider than a sparse one. It is not shipped, and the reason is the hard rule rather than the
   * effort: every additional anchor is another number that comes from the ENGRAVING'S GEOMETRY,
   * and engraving geometry moves when a note is added. Pinning the roll to it re-space the
   * picture of a performance around the note the player just drew — the exact failure the old
   * linked mode was deleted for (view/pianoroll.ts §1), arriving through a different door.
   *
   * So the ruler stays made of two TIMES. Inside them the roll is perfectly linear, which is
   * what a picture of a recording has to be, and adding a note changes no other note's time, so
   * no other rectangle can move. What alignment buys is real and checked: all three panes show
   * the same seconds across the same pixels, the same moment is in the same horizontal band, and
   * a note's roll x sits an order of magnitude closer to its notehead than it does unaligned.
   *
   * The shape stays a list so a future ruler that solves the reflow problem has somewhere to
   * land without changing either pane.
   *
   * Held across a rebuild with the window it belongs to; see §syncViewports.
   */
  private alignAnchors(w: { fromSec: number; toSec: number }): TimeAnchor[] | null {
    return [
      { sec: w.fromSec, frac: 0 },
      { sec: w.toSec, frac: 1 }
    ];
  }

  /** Centre the sheet (and therefore the roll) on a moment in the RECORDING. */
  /**
   * Point at a moment in one view; take the sheet there too.
   *
   * The whole of what the Align chip does. It moves ONLY the sheet's horizontal scroll — the
   * roll and the strip already show the whole take, so there is nothing of theirs to move, and
   * that asymmetry is the point rather than an omission: the sheet is the only view that can
   * be looking somewhere else.
   *
   * Nothing here touches geometry. The predecessor of this chip did, and adding one note to
   * the roll re-spaced its neighbours as a result. This cannot: it is a scroll position.
   */
  private followSeek(audioSec: number): boolean {
    if (!this.settings.get().alignViews) return false;
    this.scrollSheetToAudioSec(audioSec);
    return true;
  }

  private scrollSheetToAudioSec(audioSec: number): void {
    const tv = this.triview;
    const score = this.runtime.get().score;
    const map = this.sheetMap();
    const view = tv?.viewport();
    if (!tv || !score || !map || !view) return;
    const x = map.writtenSecToContentX(audioSec - this.originSec(score));
    if (x === null) return;
    tv.setScrollLeft(Math.max(0, x - view.viewportWidth / 2));
  }

  private liveSheet(): PianoRollLiveModel | null {
    const model = this.triview?.model;
    const index = this.triview?.scoreIndex;
    return model && index ? { model, index } : null;
  }

  /**
   * The one place playback notes are made, so all four callers stay in step.
   *
   * There were four copies of this expression and they agreed only by luck; the moment the
   * performance became an input, one of them forgetting it would have meant playback that was
   * human until you edited a note and mechanical afterwards. See `scoreToSynthNotes`.
   */
  /**
   * Hand the transport what to play, on the clock the transport counts in.
   *
   * ONE PLACE, because there are three callers and they must not drift — the whole reason
   * `synthNotesFor` exists one level down.
   *
   * `synthNotesFor()` speaks the PAGE's clock: it reads the engraving, which is written from
   * the take with the cuts closed up. The transport plays the file, so both the notes and the
   * length come back to recording seconds here (F16). The removed spans hold no notes by
   * construction, so on the audio clock they are simply silent stretches — and
   * `skipCutsDuringPlayback` is what stops the playhead sitting through them. The take's own
   * duration rather than the score's, so a trailing trim still has tape behind it for the
   * playhead to be seeked across rather than an end the transport has already passed.
   *
   * Un-cut, this is `setScoreNotes(synthNotesFor(score), score.durationSec)` exactly as before,
   * down to the array identity playback has always been handed.
   */
  private pushScoreNotes(score: RiffScore): void {
    const notes = this.synthNotesFor(score);
    const cuts = this.cuts();
    if (!cuts.length) {
      // `score.durationSec` is already on the recording's clock (the pipeline's beat times
      // are), so it takes no shift — only the notes do.
      this.transport.setScoreNotes(notes, score.durationSec);
      return;
    }
    this.transport.setScoreNotes(
      notes.map((n) => ({
        ...n,
        startSec: editedToAudioSec(n.startSec, cuts),
        endSec: editedToAudioSec(n.endSec, cuts)
      })),
      this.runtime.get().source?.durationSec ?? score.durationSec
    );
  }

  private synthNotesFor(score: RiffScore): ReturnType<typeof scoreToSynthNotes> {
    // `performanceFeed()` returns the raw array ITSELF while the snap is off, so this is the
    // same argument it has always been and playback is unchanged to the last bit — proved by
    // `__RIFFSHEET_SNAPFEED__`, which dumps this schedule either side of a Quantize change.
    // With the snap on it is the snapped take, because playback must agree with the page.
    return scoreToSynthNotes(
      score,
      this.originSec(score),
      this.liveSheet(),
      this.runtime.get().source?.detected ? this.performanceFeed() : null
    );
  }

  private applyScoreToViews(score: RiffScore): void {
    // See §syncViewports: the aligned window must survive this rebuild unchanged, or adding one
    // note re-spaces the picture of the performance around it.
    if (this.alignedWindow) {
      this.alignHoldUntil = performance.now() + ALIGN_HOLD_MS;
      this.alignHoldScrollLeft = this.triview?.viewport()?.scrollLeft ?? this.alignHoldScrollLeft;
    }
    this.refreshTempoBox();
    this.triview?.load(score);
    // Bar 1 is the roll's time origin — without it a count-in slides the whole roll off
    // the waveform above it. See view/pianoroll.ts.
    this.pianoRoll?.setBarOne(this.runtime.get().source?.barOneSec ?? 0);
    this.waveform?.setScoreOrigin(this.originSec(score));
    // Hand over the graph the tri-view has just built, BEFORE the score: the roll draws from
    // the LIVE sheet, not from `score.ir`, and in the other order it would read the snapshot
    // once for nothing. `load()` builds the graph synchronously, so it exists by now.
    this.pianoRoll?.setLiveModel(this.liveSheet());
    this.pianoRoll?.setScore(score);
    // #36: THE ROLL SHOWS THE PERFORMANCE, NOT THE PAGE.
    //
    // The two calls above still happen and still matter — the roll takes its bar lines, its
    // tempo and its origin from the score, and the live model is what it falls back to if this
    // third call is not there. What changes is where the RECTANGLES come from: handed the feed,
    // the roll draws the notes at the seconds they were played, so the Quantize menu — which
    // reaches the pipeline and nothing else — cannot move one of them. Before this, every
    // rectangle was a walk of the engraved sheet, and choosing 1/4 visibly re-timed the
    // player's own recording in the one view that is supposed to be a picture of it.
    //
    // `RollPerformanceNote` (app/snap.ts) is the app's half of this contract and the roll's
    // `PerformanceNote` is the other; they are structurally compatible on purpose, so the two
    // files agree without either importing the other's types.
    this.pianoRoll?.setPerformanceNotes(this.rollFeedNotes());
    this.pushScoreNotes(score);
    this.transport.setVoice(this.settings.get().playbackVoice);
    this.syncKeyPicker();
  }

  /**
   * Push the sheet's own key back onto the Key picker.
   *
   * Its Auto option says what Auto came out AS, and the score does not exist yet the first
   * time the toolbar is drawn — `goMain` builds the screen and `rebuildNotation` fills the
   * score in afterwards. Rather than re-render the whole screen on every rebuild (one happens
   * on every piano-roll drag), the one option that can go stale is updated in place, exactly
   * as the roll's grid chip is in `onViewSettingsChanged`.
   */
  private syncKeyPicker(): void {
    const select = this.root.querySelector<HTMLSelectElement>('[data-role="doc-key"]');
    if (!select) return;
    const auto = select.querySelector('option[value="auto"]');
    if (auto) auto.textContent = autoKeyLabel(this.runtime.get().score);
    const chosen = this.runtime.get().source?.keyFifths;
    const value = chosen === undefined ? 'auto' : String(chosen);
    if (select.value !== value) select.value = value;
  }

  // =========================================================================
  // Main screen
  // =========================================================================

  private goMain(name: string): void {
    this.runtime.set({ screen: 'main' });
    this.renderMain(name);
  }

  /**
   * The view chips: the piano roll's switches and the DAW-grid switch.
   *
   * They live in the HEADER, in the wide empty gap between the filename and the export
   * buttons, and both of those placements were reported problems:
   *
   *  - the roll's chips were overlaid on the roll itself, top right, where they sat on top of
   *    the notes. A pane whose controls cover its content is a pane you cannot read.
   *  - the DAW-grid chip had a whole row of its own, for one chip, in a window that is already
   *    more chrome than music.
   *
   * One group, no new rows, and nothing covering anything.
   */
  private viewToolChips(): HTMLElement {
    const s = this.settings.get();
    const rollOn = s.showPianoRoll;

    return el(
      'div',
      { class: 'view-tools' },
      el('button', {
        class: `chip pianoroll-toggle${rollOn ? ' on' : ''}`,
        'data-setting': 'showPianoRoll',
        text: 'Piano roll',
        'aria-pressed': String(rollOn),
        title: t(TIPS.pianoRoll),
        onClick: () => {
          this.settings.set({ showPianoRoll: !rollOn });
          this.renderMain();
        }
      }),
      // ALIGN THE FOUR VIEWS on the same moment. Reported as "the link button disappeared. i
      // cant link midi/musicsheet/tab/soundwave".
      //
      // It came back once as the OLD design — the roll borrowing the sheet's x-geometry — and
      // that design is now deleted rather than defaulted off. alphaTab gives rhythmically
      // dense bars more pixels, so a roll drawn on that axis re-spaced its own notes whenever
      // one was added: the player's picture of their performance moved because they edited a
      // different part of it. No switch makes that acceptable.
      //
      // What is left is what the player actually asked for: point at a moment anywhere, and
      // every view goes to it. Nothing moves that was not already going to move — the roll's
      // geometry is a linear time ruler, always, and this cannot touch it.
      rollOn &&
        el('button', {
          class: `chip${s.alignViews ? ' on' : ''}`,
          text: 'Align',
          'data-role': 'roll-link',
          'data-setting': 'alignViews',
          'aria-pressed': String(s.alignViews),
          title: t(TIPS.alignViews),
          onClick: () => {
            const on = !this.settings.get().alignViews;
            this.settings.set({ alignViews: on });
            this.syncViewports();
            this.renderMain();
          }
        }),
      // ZOOM, VISIBLE. A minus and a plus, because a wheel and a pinch are both invisible and
      // somebody on a mouse with no wheel, or reading this on a tablet, still has to be able to
      // make the rows bigger. The wheel over the gutter and a trackpad pinch do the same thing
      // — see view/pianoroll.ts §onWheel — and double-clicking the gutter fits, which is what
      // the two chips that used to sit here ("Fit", "Reset view") were for.
      rollOn &&
        el(
          'span',
          { class: 'zoom-pair', 'data-role': 'roll-zoom' },
          // WHICH AXIS (F4). Four unlabelled minus/plus buttons in a row is a guessing game: nothing
          // said that the first pair made the rows taller and the second made the take wider,
          // and people found out by pressing one.
          //
          // A glyph rather than the words "Pitch" and "Time", and that is the constraint doing
          // the choosing: this bar has to survive a 390px docked FX window, the words cost
          // ~60px between them, and the header is forbidden from growing a second row. The
          // glyph carries the axis, the tooltip carries the word, and the buttons themselves
          // already carry the accessible names ("Bigger rows", "Show more time").
          el('span', {
            class: 'zoom-label',
            'data-role': 'roll-zoom-label',
            'aria-hidden': 'true',
            text: '\u2195',
            title: t(`Pitch \u2014 ${TIPS.rollZoom}`)
          }),
          el('button', {
            class: 'chip icon',
            text: '\u2212',
            'data-role': 'roll-zoom-out',
            'aria-label': 'Smaller rows',
            title: t(TIPS.rollZoom),
            onClick: () => this.pianoRoll?.zoomVerticalOut()
          }),
          el('button', {
            class: 'chip icon',
            text: '+',
            'data-role': 'roll-zoom-in',
            'aria-label': 'Bigger rows',
            title: t(TIPS.rollZoom),
            onClick: () => this.pianoRoll?.zoomVerticalIn()
          }),
          // TIME, the other axis (#29). The pair above makes the ROWS taller; this one makes
          // the recording WIDER, which is the zoom anybody actually means when they say they
          // cannot see where a note starts. Same reasoning as the vertical pair for being
          // visible at all: the wheel over the ruler does it, and a wheel is invisible.
          //
          // "Fit" is a button here rather than a double-click, unlike the vertical axis: the
          // time window is the one Align keeps in step with the sheet, so getting back to the
          // whole take is a thing players reach for repeatedly rather than once a session.
          el('span', {
            class: 'zoom-label',
            'data-role': 'roll-time-zoom-label',
            'aria-hidden': 'true',
            text: '↔',
            title: t(`Time — ${TIPS.rollTimeZoom}`)
          }),
          el('button', {
            class: 'chip icon',
            text: '−',
            'data-role': 'roll-time-zoom-out',
            'aria-label': 'Show more time',
            title: t(TIPS.rollTimeZoom),
            onClick: () => this.pianoRoll?.zoomTimeOut()
          }),
          el('button', {
            class: 'chip icon',
            text: '+',
            'data-role': 'roll-time-zoom-in',
            'aria-label': 'Show less time',
            title: t(TIPS.rollTimeZoom),
            onClick: () => this.pianoRoll?.zoomTimeIn()
          }),
          el('button', {
            class: 'chip icon',
            text: 'Fit',
            'data-role': 'roll-time-fit',
            'aria-label': 'Fit the whole take',
            title: t(TIPS.rollTimeFit),
            onClick: () => this.pianoRoll?.fitTime()
          })
        ),
      // How many edits the app made on its own evidence and nobody has looked at yet.
      //
      // It cycles rather than opening a list: there are usually one or two, the player wants to
      // see each one IN CONTEXT on the roll, and a list would be a second place to look at
      // notes when the roll is already the place. Hidden at zero, which is nearly always — see
      // `updateAutoChip`, which is also why this is built with `display:none` rather than being
      // conditional on a count the header does not have yet.
      rollOn &&
        el(
          'button',
          {
            class: 'chip auto-edits-chip',
            'data-role': 'auto-edits',
            style: { display: 'none' },
            title: t(TIPS.autoEdits),
            onClick: () => this.focusNextAutoEdit()
          },
          el('span', { 'aria-hidden': 'true', text: '◈ ' }),
          el('span', { 'data-role': 'auto-edits-text', text: '0 auto edits' })
        ),
      // "Fit" stood here. Fitting is still exactly as available and still not the default —
      // fitting by default is what squashed a wide-range take into unreadable slivers — but it
      // is a DOUBLE-CLICK ON THE GUTTER now rather than a permanent chip. Two chips for a
      // gesture used once a session is a poor trade on a bar that has to survive 360 px.
      // The ROLL's own ruler. It lives with the roll's other controls and not in the notation
      // toolbar because it is not a notation setting: it moves the vertical lines and sizes a
      // hand-added note, and that is all it is allowed to do.
      //
      // Note what it does NOT call: `rebuildNotation`. There is nothing to rebuild — the
      // pipeline never sees this value — and calling it anyway is precisely the coupling the
      // split exists to remove. `setEditGrid` redraws the roll's own canvas and stops there,
      // so the sheet on screen is not even re-engraved, let alone re-quantized.
      rollOn &&
        el(
          'select',
          {
            'aria-label': 'Piano roll grid',
            'data-role': 'roll-grid',
            'data-setting': 'rollGrid',
            // `.view-tools select.chip` already exists in styles.css — a pill that matches
            // the buttons either side of it rather than a raw platform dropdown.
            class: 'chip',
            title: t(TIPS.rollGrid),
            onChange: (e: Event) => {
              const rollGrid = (e.target as HTMLSelectElement).value as AppSettings['rollGrid'];
              this.settings.set({ rollGrid });
              this.pianoRoll?.setEditGrid(rollGrid);
              // …UNLESS the notes are standing on it. With Snap to grid on, the columns ARE the
              // note positions, so a new size has to re-derive them — from the RAW take, which
              // is what `performanceFeed()` measures and why changing size repeatedly cannot
              // walk a note further and further from where it was played.
              if (this.settings.get().rollSnapToGrid) this.rebuildNotation({ keepEdits: true });
            }
          },
          ...(['quarter', 'eighth', 'sixteenth', 'triplet', 'free'] as const).map((value) =>
            el('option', { value, text: `Grid: ${ROLL_GRID_LABELS[value]}`, selected: s.rollGrid === value })
          )
        ),
      // SNAP TO GRID (#41) — the second half of the roll's grid control. The menu above says
      // where the columns are; this says whether the notes stand on them.
      //
      // Its own chip rather than another section inside that menu, because the menu answers
      // "how big is a cell" with ONE value, and a second unrelated answer sharing the widget
      // would make the value it displays a lie about one of the two. It also has to stay a
      // plain list of grid words: `scripts/verify.mjs` drives it by value.
      //
      // Everything it changes goes through `performanceFeed()`, so one rebuild moves the roll,
      // the sheet, the playback and every export together — and switching it back off restores
      // the recording exactly, because nothing was ever written over.
      rollOn &&
        el('span', {
          class: `chip${s.rollSnapToGrid ? ' on' : ''}`,
          role: 'switch',
          'aria-checked': String(s.rollSnapToGrid),
          'data-role': 'roll-snap',
          'data-setting': 'rollSnapToGrid',
          text: 'Snap to grid',
          title: t(TIPS.rollSnap),
          onClick: () => {
            this.settings.set({ rollSnapToGrid: !s.rollSnapToGrid });
            this.rebuildNotation({ keepEdits: true });
            this.renderMain();
          }
        }),
      // THE "USE DAW GRID" CHIP IS GONE FROM HERE (F19), and it is not merely moved.
      //
      // It was one half of a control whose other half — the BPM box and the time signature —
      // lived two rows away in the transport, and the two disagreed by design: the chip said
      // "follow the DAW", the box let you type a number, and typing one silently unlit the chip
      // through `releaseHostGrid`. Nothing on screen said the two were the same question.
      //
      // They are now one control, in the transport row beside the numbers it governs: a tempo
      // SOURCE (Follow DAW / Manual / From recording) with only the fields that source can
      // honestly answer for. See `buildTempoSource`.
      null
    );
  }

  /**
   * ONE horizontal scrollbar, governing the sheet and the roll together.
   *
   * They share an x-axis when linked, so two scrollbars could disagree — and a disagreement here
   * is exactly the "nothing lines up" complaint this whole round is about. So: one bar, one
   * writer (`triview.setScrollLeft`), one reader (`triview.viewport()`). The roll's own
   * `onScrollRequest` routes to the same setter, so drag-panning and Shift+wheel move this bar
   * too rather than fighting it.
   *
   * The sheet's native scrollbar is hidden in CSS, because it sits at the very bottom of the
   * window and does not read as governing the pane two rows above it.
   */
  private buildScrollbar(): HTMLElement {
    const track = el('div', { class: 'hscroll', 'data-role': 'hscroll' }, el('i', { class: 'hscroll-thumb' }));

    const seekTo = (clientX: number, fromThumb: number) => {
      const tv = this.triview;
      const v = tv?.viewport();
      if (!tv || !v || v.contentWidth <= v.viewportWidth) return;
      const rect = track.getBoundingClientRect();
      const usable = Math.max(1, rect.width);
      const frac = Math.min(1, Math.max(0, (clientX - rect.left - fromThumb) / usable));
      tv.setScrollLeft(frac * (v.contentWidth - v.viewportWidth));
      this.syncViewports();
    };

    track.addEventListener('pointerdown', (e: PointerEvent) => {
      const thumb = track.querySelector<HTMLElement>('.hscroll-thumb');
      const tRect = thumb?.getBoundingClientRect();
      // Grabbing the thumb keeps the pointer where it landed on it; pressing the track jumps.
      const grabbed = !!tRect && e.clientX >= tRect.left && e.clientX <= tRect.right;
      const offset = grabbed && tRect ? e.clientX - tRect.left : (tRect?.width ?? 0) / 2;
      track.setPointerCapture?.(e.pointerId);
      seekTo(e.clientX, offset);
      const move = (m: PointerEvent) => seekTo(m.clientX, offset);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    return track;
  }

  /** Size and place the thumb from the sheet's own viewport. Called from `syncViewports`. */
  private updateScrollbar(): void {
    const bar = this.root.querySelector<HTMLElement>('[data-role="hscroll"]');
    if (!bar) return;
    const v = this.triview?.viewport();
    const scrollable = !!v && v.contentWidth > v.viewportWidth + 1;
    bar.style.display = scrollable ? '' : 'none';
    if (!scrollable || !v) return;
    const thumb = bar.querySelector<HTMLElement>('.hscroll-thumb');
    if (!thumb) return;
    const frac = v.viewportWidth / v.contentWidth;
    const maxScroll = Math.max(1, v.contentWidth - v.viewportWidth);
    thumb.style.width = `${Math.max(6, frac * 100)}%`;
    thumb.style.left = `${(v.scrollLeft / maxScroll) * (100 - Math.max(6, frac * 100))}%`;
  }

  /** Controls that change the written page live with the written page, not in the app header. */
  private buildNotationToolbar(): HTMLElement {
    const s = this.settings.get();
    const source = this.runtime.get().source;
    const tabOn = s.tabMode !== 'off';
    // `freeGridUsable` stood here — "every note carries source ticks, so this is a symbolic
    // import and 'free' is safe" — and it gated the Quantize menu's Free option. It is gone with
    // the gate: Free is offered for every take now and is the default. See the <select> below
    // for the re-measurement that retired it.
    const presets = TUNING_PRESETS.filter((preset) => preset.instrument === s.tabMode);

    const rebuild = (patch: Partial<AppSettings>) => {
      this.settings.set({ ...patch, instrument: 'auto' });
      this.rebuildNotation({ keepEdits: true });
      this.renderMain();
    };

    return el(
      'div',
      { class: 'notation-toolbar', 'data-role': 'notation-toolbar' },
      el('span', { class: 'toolbar-label', text: 'Notation' }),
      el(
        'select',
        {
          'aria-label': 'Clef',
          'data-role': 'clef-view',
          'data-setting': 'clefMode',
          title: t(TIPS.clef),
          onChange: (e: Event) => rebuild({ clefMode: (e.target as HTMLSelectElement).value as AppSettings['clefMode'] })
        },
        ...(['auto', 'treble', 'bass', 'grand'] as const).map((value) =>
          el('option', { value, text: value === 'auto' ? 'Clef: Auto' : `Clef: ${titleCase(value)}`, selected: s.clefMode === value })
        )
      ),
      // THE KEY SIGNATURE, and it belongs to the take rather than to the app — the same rule
      // the tempo and the meter follow, and for the same reason: a key chosen for one riff must
      // not be waiting for the next one. It could be set at exactly two moments before this
      // (creating a blank score, or opening a file that carried one) and never afterwards, so a
      // transcription that came back spelled in the wrong key had no way back. `undefined` is
      // not "C major": it means the pipeline reads the key off the notes, which is what Auto
      // restores. Nothing is transposed either way — this is spelling, not pitch.
      source &&
        el(
          'select',
          {
            'aria-label': 'Key signature',
            'data-role': 'doc-key',
            title: t(TIPS.documentKey),
            onChange: (e: Event) => this.setDocumentKey((e.target as HTMLSelectElement).value)
          },
          el('option', {
            value: 'auto',
            text: autoKeyLabel(this.runtime.get().score),
            selected: source.keyFifths === undefined
          }),
          ...KEY_OPTIONS.map(([fifths, label]) =>
            el('option', { value: String(fifths), text: `Key: ${label}`, selected: source.keyFifths === fifths })
          )
        ),
      // QUANTIZE. It is the quantizer's brief: how much the sheet rounds what was played. The
      // menu used to be called "Notation", which named the bar it sits on rather than the thing
      // it does, and "Notation: 1/8" reads as a fact about the page instead of an instruction
      // to round to eighths — the player could not tell from the words that choosing a size
      // FORBIDS everything finer. The `data-role` and the stored values are untouched: this is
      // a change of vocabulary, not of wiring.
      //
      // The piano roll's ruler is a separate control (see `viewToolChips`) and deliberately
      // does not rebuild anything.
      el(
        'select',
        {
          'aria-label': 'Quantize',
          'data-role': 'notation-grid',
          'data-setting': 'grid',
          title: t(TIPS.grid),
          onChange: (e: Event) => rebuild({ grid: (e.target as HTMLSelectElement).value as AppSettings['grid'] })
        },
        ...(['auto', 'quarter', 'eighth', 'sixteenth', 'thirtysecond', 'triplet', 'free'] as const)
          // FREE IS OFFERED FOR EVERYTHING NOW, and it is the default (settings v10).
          //
          // It used to be hidden from audio takes, and the reasoning was a measurement rather
          // than a taste: 'free' meant "write exactly what was played, snapped to nothing", and
          // for a performance — which has no exact note values — that produced a chain of tied
          // fragments per note. The number recorded here was 64 played notes coming out as 192
          // GLYPHS WITH 192 TIES, three noteheads each, plus 64 rests nobody played. Offering
          // that beside five settings that work was offering a trap, and hiding it was right.
          //
          // THAT MEASUREMENT IS NO LONGER TRUE. The pipeline's 'free' is a 1:1 pass-through now:
          // it never mutates its input and writes the simplest symbol that fits. Re-measured on
          // the same fixtures (`scripts/roll-snap-test.ts` §8 keeps this honest):
          //
          //     straight riff — auto: 64 played -> 64 glyphs, 0 rests, 0 ties
          //                     free: 64 played -> 64 glyphs, 0 rests, 0 ties   (identical)
          //     triplet riff  — auto: 77 played -> 70 glyphs, 0 rests, 2 ties
          //                     free: 77 played -> 78 glyphs, 38 rests, 34 ties
          //
          // Straight material is now indistinguishable from 'auto'. Triplet material is busier
          // under 'free' — the rests are the real gaps between notes and the ties are held notes
          // crossing a beat — but that is a page that is fussier than you played, which is what
          // the tip tells you to reach for 'auto' about. It is not a trap any more, and a
          // setting that is the DEFAULT cannot be one the player is unable to return to.
          .map((value) =>
            el('option', { value, text: `Quantize: ${GRID_LABELS[value]}`, selected: s.grid === value })
          )
      ),
      this.coarseGridWarning(),
      // THE TAB MENU — one dropdown, three sections.
      //
      // Everything about the tablature that is a CHOICE now lives here: which instrument it is
      // written for, how the fingering is planned, and how far up the neck the app may go.
      // They were in three places (this select, a chip group buried in Settings, and a second
      // Settings row) and they are one subject, so a player deciding "how should this tab
      // read?" had to know to look in two panels.
      //
      // A `<select>` with `<optgroup>`s rather than three selects, because that is what "one
      // menu, three sections" is in a form control, and because the toolbar has to survive a
      // 360px window. Only the INSTRUMENT section carries plain values, so `select.value` is
      // still the tab mode and nothing reading it has to learn a new vocabulary; the other two
      // sections use prefixed values, apply their own setting, and mark the current choice with
      // a tick because a select can only really select one thing.
      //
      // `data-setting` on the groups, not only on the select: each group IS the control for
      // that key, and the settings census counts controls, not selects.
      el(
        'select',
        {
          'data-role': 'tab-view',
          'data-setting': 'tabMode',
          'aria-label': 'Tablature',
          title: t(TIPS.instrument),
          onChange: (e: Event) => {
            const raw = (e.target as HTMLSelectElement).value;
            if (raw.startsWith('fingering:')) {
              rebuild({ fingering: raw.slice(10) as AppSettings['fingering'] });
              return;
            }
            if (raw.startsWith('maxFret:')) {
              rebuild({ maxFret: Number(raw.slice(8)) });
              return;
            }
            const tabMode = raw as AppSettings['tabMode'];
            const current = TUNING_PRESETS.find((preset) => preset.id === s.tuningId);
            const tuningId =
              tabMode === 'bass' || tabMode === 'guitar'
                ? current?.instrument === tabMode
                  ? current.id
                  : (TUNING_PRESETS.find((preset) => preset.instrument === tabMode)?.id ?? s.tuningId)
                : s.tuningId;
            rebuild({ tabMode, tuningId });
          }
        },
        el(
          'optgroup',
          { label: 'Instrument' },
          el('option', { value: 'off', text: 'Tab: Off', selected: s.tabMode === 'off' }),
          el('option', { value: 'bass', text: 'Tab: Bass', selected: s.tabMode === 'bass' }),
          el('option', { value: 'guitar', text: 'Tab: Guitar', selected: s.tabMode === 'guitar' }),
          el('option', { value: 'custom', text: 'Tab: Custom', selected: s.tabMode === 'custom' })
        ),
        tabOn &&
          el(
            'optgroup',
            { label: 'Fingering', 'data-setting': 'fingering', 'data-role': 'tab-fingering' },
            ...FINGERING_STYLES.map((style) =>
              el('option', {
                value: `fingering:${style}`,
                text: `${s.fingering === style ? '✓ ' : '   '}${FINGERING_LABELS[style]}`
              })
            )
          ),
      ),
      // FRET COUNT — the third section of the same subject, kept as its own control because it
      // is a NUMBER and a tick beside "24 frets" in a menu is a worse way to read a number than
      // a box showing 24. It moved here from the settings panel, where it was two panels away
      // from the tab it describes.
      tabOn &&
        el(
          'select',
          {
            'aria-label': 'Highest fret',
            'data-role': 'max-fret',
            'data-setting': 'maxFret',
            title: t(TIPS.maxFret),
            onChange: (e: Event) => rebuild({ maxFret: Number((e.target as HTMLSelectElement).value) })
          },
          ...fretCountOptions(s.maxFret).map((fret) =>
            el('option', { value: String(fret), text: `${fret} frets`, selected: fret === s.maxFret })
          )
        ),
      // The anchor for "Around fret N", and only then — every other style ignores it, and a
      // number box that changes nothing is the kind of control this whole pass is removing.
      tabOn && s.fingering === 'around-fret' &&
        el('label', { class: 'string-count', title: t(TIPS.fingering) },
          el('span', { class: 'dim', text: 'Around fret' }),
          el('input', {
            type: 'number',
            min: '0',
            max: '24',
            'data-role': 'anchor-fret',
            'data-setting': 'anchorFret',
            'aria-label': 'Anchor fret',
            value: String(s.anchorFret),
            onChange: (e: Event) =>
              rebuild({ anchorFret: Math.max(0, Math.min(24, Math.round(Number((e.target as HTMLInputElement).value)) || 0)) })
          })
        ),
      tabOn && s.tabMode !== 'custom' &&
        el(
          'select',
          {
            'aria-label': 'Tab tuning',
            'data-role': 'tab-tuning',
            'data-setting': 'tuningId',
            title: t(TIPS.tuning),
            onChange: (e: Event) => rebuild({ tuningId: (e.target as HTMLSelectElement).value })
          },
          ...presets.map((preset) =>
            el('option', { value: preset.id, text: preset.name, selected: preset.id === s.tuningId })
          )
        ),
      tabOn && s.tabMode === 'custom' &&
        el('input', {
          class: 'custom-tuning',
          value: tuningLabel(s.customTuningMidi),
          spellcheck: 'false',
          'data-role': 'custom-tuning',
          'data-setting': 'customTuningMidi',
          'aria-label': 'Custom tuning, lowest string to highest',
          title: 'Type open strings from low to high, for example B0 E1 A1 D2 G2',
          onChange: (e: Event) => {
            const notes = parseTuning((e.target as HTMLInputElement).value);
            if (!notes) {
              this.toast('danger', 'Tuning not changed', 'Use pitch names with octaves, from low to high: B0 E1 A1 D2 G2.');
              (e.target as HTMLInputElement).value = tuningLabel(s.customTuningMidi);
              return;
            }
            rebuild({ customTuningMidi: notes });
          }
        }),
      tabOn && s.tabMode === 'custom' &&
        el('label', { class: 'string-count' },
          el('span', { class: 'dim', text: 'Strings' }),
          el('input', {
            type: 'number',
            min: '2',
            max: '12',
            'data-role': 'string-count',
            value: String(s.customTuningMidi.length),
            onChange: (e: Event) => rebuild({ customTuningMidi: resizeTuning(s.customTuningMidi, Number((e.target as HTMLInputElement).value)) })
          })
        ),
      // The capo, next to the tuning because it is the other half of the same fact: what the
      // open strings sound like. It already reached the pipeline (`toBuildSettings`), which
      // writes every fret relative to it and prints it in the MusicXML — but the only way to
      // set it was to open a Guitar Pro file that happened to have one, which then stayed put
      // silently. Tab-only, because a capo has nothing to say about a plain staff: the pitches
      // are unchanged, only the fret numbers under them move.
      tabOn &&
        el('label', { class: 'string-count', title: t(TIPS.capo) },
          el('span', { class: 'dim', text: 'Capo' }),
          el('input', {
            type: 'number',
            min: '0',
            max: '12',
            'data-role': 'capo',
            'data-setting': 'capo',
            'aria-label': 'Capo fret',
            value: String(s.capo),
            onChange: (e: Event) =>
              rebuild({ capo: Math.max(0, Math.min(12, Math.round(Number((e.target as HTMLInputElement).value)) || 0)) })
          })
        ),
      // The "Tuning low → high: E1 A1 D2 G2" row stood here. It said the right thing in the
      // wrong place: on the screen but never on the paper, once for a whole document, and as
      // prose you had to count against the lines. The letters are on the staff now, on every
      // system and in the PDF — see view/stringLetters.ts.
      source?.documentBars !== undefined &&
        el('div', { class: 'document-bars' },
          el('button', { text: '− Bar', title: 'Remove the last empty bar', onClick: () => this.changeDocumentBars(-1) }),
          el('span', { text: `${source.documentBars} bars` }),
          el('button', { text: '+ Bar', title: 'Add one bar', onClick: () => this.changeDocumentBars(1) })
        )
    );
  }

  /**
   * Set — or stop setting — the key this take is written in.
   *
   * On the SOURCE and not on the settings, exactly like the tempo and the meter: those three
   * moved off `AppSettings` when a preference saved by one take started leaking into whatever
   * was opened next, and a key signature is the same kind of fact. `undefined` is not a value
   * here, it is the absence of an override, and only that makes the pipeline go back to
   * reading the key off the notes (`BuildSettings.keyFifths` is checked with `!== undefined`).
   *
   * A rebuild, keeping edits: the notes do not change, their spelling does.
   */
  private setDocumentKey(value: string): void {
    const source = this.runtime.get().source;
    if (!source) return;
    const keyFifths =
      value === 'auto' ? undefined : Math.max(-7, Math.min(7, Math.round(Number(value)) || 0));
    if (keyFifths === source.keyFifths) return;
    this.runtime.set({ source: { ...source, keyFifths } });
    this.rebuildNotation({ keepEdits: true });
    this.renderMain();
  }

  private changeDocumentBars(delta: number): void {
    const source = this.runtime.get().source;
    if (!source?.documentBars || !source.tempoBpm || !source.timeSignature) return;
    const bars = Math.max(1, Math.min(512, source.documentBars + delta));
    if (bars === source.documentBars) return;
    const { numerator, denominator } = source.timeSignature;
    const durationSec = bars * numerator * (4 / denominator) * (60 / source.tempoBpm);
    if (delta < 0 && source.detected?.notes.some((note) => note.startSec >= durationSec - 1e-6)) {
      this.toast('danger', 'Bar not removed', 'The last bar contains notes. Delete or move them first.');
      return;
    }
    this.runtime.set({ source: { ...source, documentBars: bars, durationSec } });
    if (this.audioRef) this.audioRef = { ...this.audioRef, durationSec };
    this.rebuildNotation({ keepEdits: true });
    this.renderMain();
  }

  private renderMain(nameOverride?: string): void {
    const rt = this.runtime.get();
    if (rt.screen !== 'main') return;
    const name = nameOverride ?? rt.source?.name ?? 'Untitled';

    const header = el(
      'header',
      { class: 'app-header' },
      // TOP-LEFT IS THE BRAND, and the take's name sits beside it — F17/F18. See
      // `buildBrandBlock` for the layout it is modelled on and for the height rule it keeps.
      this.buildBrandBlock(),
      el('span', { class: 'filename', text: name }),
      el('button', {
        text: 'Main menu',
        'data-role': 'main-menu',
        title: 'Choose a source, start a blank score, or return to recent work',
        onClick: () => this.openMainMenu()
      }),
      // The gap in the middle of the header was empty and the controls were fighting for space
      // elsewhere. See `viewToolChips`.
      this.viewToolChips(),
      el('div', { class: 'spacer' }),
      // Listen again. Only offered when there is a recording to re-read — a MIDI import has
      // nothing to listen to, and re-running the engine on it would be theatre.
      // What the listener is costing, and a way to stop it early — in the header rather than
      // buried in the settings panel, because the player's complaint was that it sits there
      // eating memory and there was nothing in front of him about it. Hidden entirely when the
      // engine is down, which is now nearly always: it dies at the end of every job, so the chip
      // is really only on screen while a transcription is in flight.
      this.bridge.stopEngine &&
        el(
          'button',
          {
            class: 'chip engine-chip',
            'data-role': 'engine-chip',
            style: {
              display:
                this.engine && (this.engine.state === 'ready' || this.engine.state === 'starting') ? '' : 'none'
            },
            title: t(TIPS.engineChip),
            onClick: () => void this.stopEngine()
          },
          el('span', { 'data-role': 'engine-text', text: 'Listener' }),
          el('span', { class: 'chip-detail', text: '✕' })
        ),
      // "LISTEN AGAIN" IS NOT IN THIS HEADER ANY MORE.
      //
      // It was a permanent button for a rare gesture, sitting in the row somebody reads on
      // every take, and the thing it did is now the ordinary consequence of choosing an
      // engine — which is what people were reaching for it to do. What is left of it, "read
      // this recording again from scratch", is a deliberate start-over and lives in the Main
      // menu next to the other deliberate acts (Save as, Close), as `retranscribe-menu`.
      //
      // The header is where a plugin window pays for chrome first: it is the row that has to
      // survive REAPER's 390px-wide docked FX window, and every button in it costs the ones
      // beside it.
      // Fresh elements every render — the header is rebuilt wholesale, so the bar hands
      // back new buttons and re-binds its own popover anchor.
      ...this.exportBar.buttons(),
      // THE GEAR, BIGGER AND NAMED. It was a bare glyph at icon size, indistinguishable at a
      // glance from the export buttons beside it. A settings panel is the one control in a
      // header somebody actively hunts for, so it says what it is; the word collapses on the
      // narrowest layouts (styles.css §.settings-gear) and the glyph stays.
      el(
        'button',
        {
          class: 'settings-gear',
          // Named so the panel's outside-click dismissal can exempt it. Without that, pressing
          // the gear while the panel is open would close it on the way down and reopen it on
          // the way up, and the button would look broken.
          'data-role': 'settings-gear',
          'aria-label': 'Settings',
          title: t(TIPS.settings),
          onClick: () => this.toggleSettings()
        },
        el('span', { class: 'gear-glyph', 'aria-hidden': 'true', text: '⚙' }),
        el('span', { class: 'gear-label', text: 'Settings' })
      )
    );

    // No waveform for a MIDI import — there is no audio, and an empty strip is a lie about
    // what the app has.
    const waveCanvas = rt.source?.peaks ? el('canvas', { class: 'waveform', title: t(TIPS.waveform) }) : null;
    const sheet = el('div', { class: 'triview' });

    // The piano roll sits directly under the waveform because the two share one ruler —
    // see view/pianoroll.ts. Its chip lives on the pane itself so the pane owns its own
    // switch; the settings panel has a matching checkbox on the same setting. The pane's
    // height is the player's, dragged from the handle on its bottom edge and remembered.
    const rollOn = this.settings.get().showPianoRoll;
    const rollCanvas = el('canvas', { class: 'pianoroll', title: t(TIPS.pianoRoll) });
    const rollHandle = el('div', {
      class: 'pianoroll-resize',
      'data-role': 'roll-resize',
      // The height is a setting, and this handle is its control — the player drags it. Named
      // so the settings sweep in scripts/verify.mjs can find the one adjustable on this screen
      // that is a gesture rather than a widget.
      'data-setting': 'pianoRollHeight',
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-label': 'Resize the piano roll',
      tabindex: '0',
      title: t(TIPS.pianoRollResize)
    });
    const rollPane = el(
      'div',
      { class: `pianoroll-pane${rollOn ? '' : ' off'}` },
      rollOn && rollCanvas,
      rollOn && rollHandle,
      // The pane's chips are NOT here any more — they are in the header, built by
      // `viewToolChips()`. Overlaid top-right, they sat directly on top of the notes in the
      // roll; reported from the field with a screenshot showing exactly that. The header had a
      // wide empty gap in the middle doing nothing, so they went there rather than steal a row.
      null
    );

    // The tuner is only on screen while a stretch is selected, and it takes the space rather
    // than being given a permanent row of its own — this window is already more chrome than
    // music (idea notes §3), and a readout with nothing to read would be the worst of both.
    const tunerHost = el('div', {
      class: 'tuner-host',
      'data-role': 'tuner-host',
      hidden: !this.tunerSelection
    });

    replace(
      this.root,
      header,
      waveCanvas,
      this.buildTakeEdits(),
      tunerHost,
      rollPane,
      this.buildScrollbar(),
      this.buildTransport(),
      this.buildNotationToolbar(),
      sheet,
      this.toastLayer()
    );

    this.waveform?.destroy();
    this.waveform = null;
    if (waveCanvas && rt.source) {
      this.waveform = new WaveformStrip({
        canvas: waveCanvas,
        // Seeking here takes the sheet with it when Align is on. `sheetMap` is deliberately
        // NOT handed in any more — see the note on the Align chip: the strip's own axis is
        // always linear recording time, and nothing may put it on the engraving's.
        // The strip draws the EDITED take, so `sec` is a page second: the transport gets it
        // back on the recording's clock, the sheet gets it as it came (F16).
        onSeek: (sec) => {
          void this.transport.seek(this.toAudioSec(sec));
          this.followSeek(sec);
        },
        onBarOneChange: (sec, commit) => this.onBarOneChange(sec, commit),
        // The strip is now the whole-take overview: it shows the entire recording and brackets
        // the slice the sheet and the roll are looking at. Dragging that bracket scrolls them.
        onViewportScrub: (centreSec) => this.scrollSheetToAudioSec(centreSec),
        // Drag out a stretch and ask what is really in it. Only the committed gesture opens the
        // tuner — analysing on every frame of a drag would be a pitch track per mousemove.
        onSelectionChange: (sel, commit) => {
          if (!sel) {
            this.closeTuner();
            this.selection = null;
            this.waveform?.setSelection(null, null);
            this.selectNoteIds([], false);
            return;
          }
          this.selection = { fromSec: sel.fromSec, toSec: sel.toSec };
          const ids = this.pianoRoll?.noteIdsInAudioRange(sel.fromSec, sel.toSec) ?? [];
          this.selectNoteIds(ids, false);
          if (!commit) return;
          this.openTuner(sel.fromSec, sel.toSec);
        }
      });
      // THE EDITED TAKE (F16): shorter peaks, shorter duration, no auto-trim dimming once the
      // player has actually cut. Identical to `rt.source` on a take nobody has cut.
      const shown = this.editedSource() ?? rt.source;
      this.waveform.setAudio(shown.peaks, shown.durationSec, shown.trim);
      // THE ONSET LAYER IS ABOUT THE RECORDING, so a cut retires it rather than remapping it.
      // The attack marks could be moved one by one, but the detection ENVELOPE beside them is a
      // uniform-hop array of the whole file; re-sampling it across the seams to keep a
      // diagnostic overlay would be a lot of arithmetic in service of a picture that is only
      // ever an explanation of what the engine heard. Better nothing than a curve drawn half a
      // second away from the sound it is describing.
      this.waveform.setOnsets(this.cuts().length ? null : this.onsetResult);
      this.waveform.setBarOne(shown.barOneSec);
      // Written second 0 on the recording's clock. The strip's peaks speak recording seconds and
      // the sheet map speaks written ones; without this the envelope is adrift by the whole
      // count-in — the same trap that once had the cursor running ahead of the audio.
      if (rt.score) this.waveform.setScoreOrigin(this.originSec(rt.score));
      // A re-render rebuilds the strip from nothing, so the selection has to be put back or the
      // tuner would be showing a stretch the waveform no longer highlights.
      if (this.selection) this.waveform.setSelection(this.selection.fromSec, this.selection.toSec);
    }

    // Rebuilt with the rest of the screen, for the same reason: the old one's host element has
    // just been thrown away, and a Tuner still holding it would leak a panel per render.
    this.tuner?.destroy();
    this.tuner = null;
    // Tell the roll's clamp that a band has appeared, before it is asked for a height. The roll
    // is built further down this same function and would otherwise claim its full share of a
    // window that has just got shorter, at the sheet's expense.
    setTransientReserve(0);
    if (this.tunerSelection) this.mountTuner();

    this.pianoRoll?.destroy();
    this.pianoRoll = null;
    if (rollOn) {
      const s = this.settings.get();
      this.pianoRoll = new PianoRoll({
        canvas: rollCanvas,
        pane: rollPane,
        handle: rollHandle,
        height: s.pianoRollHeight,
        // The ROLL's grid, never the notation one. See AppSettings.rollGrid.
        editGrid: s.rollGrid,
        // NO `sheetMap`. The roll is a linear time ruler and there is no longer any way to put
        // it on the engraving's x-axis, because doing so made adding one note re-space its
        // neighbours. See the Align chip.
        //
        // Where the roll is scrolled and zoomed vertically. Restored across the full rebuild
        // renderMain does on every change, or it would jump back to the notes every time
        // anything else on screen updated.
        verticalView: this.rollView,
        onVerticalViewChange: (view) => {
          this.rollView = view;
        },
        // Only on release. A drag fires this on every pointermove, and writing localStorage
        // sixty times a second to remember a number the player has not finished choosing
        // would be the one expensive thing on an otherwise free gesture.
        onHeightChange: (px, commit) => {
          if (commit) this.settings.set({ pianoRollHeight: px });
        },
        onSeek: (sec) => {
          void this.transport.seek(this.toAudioSec(sec));
          this.followSeek(sec);
        },

        // --- selection ------------------------------------------------------------------
        // Clicking a rectangle lights the same note on the staff AND on the tab. That was the
        // second half of the user's report: the roll and the sheet were two pictures of one
        // set of notes that could not point at the same one.
        onNoteSelect: (noteId) => {
          this.selectNoteIds(noteId ? [noteId] : []);
          // Clicking a HIGHLIGHTED note is the review gesture. Any other note closes whatever
          // was open, so the popover never outlives the thing it is about.
          const edit = noteId ? this.autoEditForNote(noteId) : null;
          if (edit) this.openAutoPopover(edit);
          else this.closeAutoPopover();
        },

        // A group selection lights up on the staff and the tab too. Deliberately separate from
        // `onNoteSelect`, which fires only when the player pointed at exactly one note — the
        // sheet must never show one note highlighted while the roll is holding five.
        onSelectionChange: (ids) => {
          this.selectNoteIds(ids);
        },

        // --- editing ---------------------------------------------------------------------
        onEdit: (edit) => this.applyRollEdit(edit),

        // #30d: pointing at a rectangle rings the notehead that made it. One direction only
        // from here — `TriView.setHover` never echoes back through its own `onNoteHover`, and
        // neither does this, or the pair would loop.
        onNoteHover: (id) => this.triview?.setHover(id ? [id] : []),

        // #29/#30: THE ROLL'S TIME AXIS MOVED.
        //
        // The strip is not optional — it draws the same seconds directly above the roll, so it
        // follows on every call, cheap and live. The SHEET follows only on `commit` and only
        // with Align on, because bringing it along means a re-engrave at a new `display.scale`.
        //
        // The scale change is `coupledSheetScale`'s inverse-proportionality law against the
        // PREVIOUS span (`this.alignedWindow`), which is why the new window is remembered here:
        // without a previous span there is no ratio to apply, and the sheet would jump to an
        // absolute guess instead of tracking the notch the player just turned.
        onTimeWindowChange: (win, commit) => {
          this.waveform?.setTimeAnchors(timeWindowAnchors(win));
          if (!this.settings.get().alignViews || !commit) return;
          const tv = this.triview;
          if (!tv) return;
          const prev = this.alignedWindow;
          // THE ECHO GUARD, and without it Align eats itself.
          //
          // The sheet writes the roll's window (`setAlignedWindow`) and the roll reports every
          // window it applies — including that one, on the trailing commit. Answering that
          // report by scrolling and re-scaling the SHEET closes the circle: the sheet moves,
          // `syncViewports` derives a slightly different window from its new scroll, hands it
          // back to the roll, and every rectangle shifts. Measured, before this line: adding
          // one note moved its five neighbours by 555 px with Align on — the exact reflow the
          // old linked mode was deleted for, arriving through the new door.
          //
          // The test is "is this window already the sheet's?", because if it is there is
          // nothing to drive. A zoom notch changes the span by a fifth (see TIME_ZOOM_*), so
          // 2% separates a real gesture from the sheet's own value coming back with a little
          // clamping on it.
          if (prev && sameTimeWindow(prev, win)) return;
          if (prev) {
            tv.setZoom(
              coupledSheetScale(
                tv.getZoom(),
                prev.toSec - prev.fromSec,
                win.toSec - win.fromSec,
                MIN_ZOOM,
                MAX_ZOOM
              )
            );
          }
          // `secondsToTick` is the app's own helper and takes the score and the recording
          // origin explicitly — see its note on the two clocks.
          const score = this.runtime.get().score;
          tv.alignScrollToTick(
            score ? secondsToTick(score, win.fromSec, this.originSec(score)) : null
          );
          this.alignedWindow = { ...win };
        }
      });
      // LITERALS, NOT SETTINGS. Naming every row and being editable are what the roll IS —
      // both switches were taken out of the settings panel (#39) because neither was a question
      // anybody wanted to be asked, and a roll that quietly refuses to be dragged, with no
      // control left anywhere to explain why, is the failure mode of reading a dead field.
      // `AppSettings.rollAllNoteNames` and `.rollEditing` survive for old blobs only and
      // `migrate()` v9 pins both true; nothing reads them now. The roll thins the names out by
      // itself when it is too short for them (view/pianoroll.ts §labelMode), so "all" is a
      // request rather than a promise and a 46px pane is still legible.
      this.pianoRoll.setShowAllNames(true);
      this.pianoRoll.setEditable(true);
      this.pianoRoll.setDuration(rt.source?.durationSec ?? rt.score?.durationSec ?? 0);
      this.pianoRoll.setBarOne(rt.source?.barOneSec ?? 0);
      if (rt.score) this.pianoRoll.setScore(rt.score);
    }
    // The roll and the strip are both brand new objects at this point. Restating the marks is
    // what makes a highlight survive opening the settings panel, switching a chip, or anything
    // else that re-renders the screen — which was a stated requirement, not a nicety.
    this.refreshAutoMarks();

    this.triview?.destroy();
    this.triview = new TriView({
      container: sheet,
      // useWorkers stays false — a worker-backed renderer draws nothing at all inside the
      // JUCE WebView. See the note on ViewSettings.useWorkers in view/atSettings.ts.
      //
      // lazyLoading is now false as well, and for a related reason: with it on, alphaTab only
      // publishes bounds for the partials it has actually painted, so the piano roll — which
      // now takes its x-axis from those bounds — would have nothing to draw with past the edge
      // of the viewport. Measured cost of turning it off: a whole 32-bar render is 7-27 ms on
      // the UI thread (Phase 0 spike).
      view: { horizontal: true, lazyLoading: false, useWorkers: false, player: 'external-media' },
      namesPlacement: 'between',
      showNames: this.settings.get().showNoteNames,
      // A string move is only offered where the neck can reach it, so the renderer needs the
      // same fret limit the edit actions are checked against — one number, two users.
      maxFret: this.settings.get().maxFret,
      onNoteClick: (hit) => this.onNoteClick(hit),
      onSeekRequest: (tick) => this.seekToTick(tick),
      // Scroll and zoom both land here, and so does the end of every render — a re-engrave
      // changes the content width, and a roll that only watched scrolls would go stale after
      // a zoom without ever looking wrong enough to notice.
      onViewportChange: () => this.syncViewports(),
      onRenderComplete: () => this.syncViewports(),
      // Direct manipulation, in place of the old popover: drag a notehead on the STAFF to
      // change its pitch, drag a fret digit on the TAB to move it to another string. Moving a
      // note in time is deliberately not offered here — that is the piano roll's job, where a
      // note has a start and a length rather than a place in a bar.
      onNoteDragCommit: (p) => this.applySheetDrag(p),
      // #30d, the other half: pointing at a notehead lights the rectangle that made it. The
      // roll's `setHover` is the inward door and never reports back — see the roll's option.
      onNoteHover: (id) => this.pianoRoll?.setHover(id ? [id] : [])
    });
    this.transport.attachAlphaTab(this.triview.api);
    if (rt.score) this.applyScoreToViews(rt.score);

    if (rt.progress !== null) this.showProgressOverlay(sheet);

    this.ensureSettingsPanel().setOpen(rt.settingsOpen);

    this.bindTransportUi();
    // Ask once when the screen appears; the poll re-arms itself only while the engine is up.
    this.pollEngine();
  }

  /**
   * Say so when the chosen grid is too coarse to hold this riff.
   *
   * THE CASE THIS EXISTS FOR. The demo is a triplet figure. Ask for a 1/4 notation grid and
   * the quantizer has nowhere to put the second and third note of each triplet: they land on
   * the same quarter as the first, and what comes out of the pipeline is one note where the
   * player played three. The sheet was simply wrong, quietly, and the only clue was that it
   * looked too empty — which is indistinguishable from a bad transcription.
   *
   * The count is not a heuristic and not a prediction: it is the engine's own note count
   * minus what actually got engraved, measured on the score that is on screen right now.
   * `noteGlyphs` counts noteheads, so a chord of three is three, which is the same unit
   * `detected.notes` is in. Ties do not double-count — the IR's stats already fold them.
   *
   * Nothing is prevented. The player asked for quarter notes and may have meant it (a
   * simplified lead sheet is a legitimate thing to want); this only refuses to let the app
   * lose notes without mentioning it. Silent on `auto` and `free`, which are the settings that
   * mean "work it out" and "do not quantize" — neither can be the wrong choice in this sense.
   */
  private coarseGridWarning(): HTMLElement | null {
    const s = this.settings.get();
    if (s.grid === 'auto' || s.grid === 'free') return null;

    const detected = this.runtime.get().source?.detected?.notes;
    const score = this.runtime.get().score;
    if (!detected || detected.length === 0 || !score) return null;

    const engraved = score.ir.stats.noteGlyphs;
    const lost = detected.length - engraved;

    // TWO THRESHOLDS, AND THE PROPORTIONAL ONE IS THE IMPORTANT HALF.
    //
    // An absolute floor on its own ("two or more notes went missing") fires on grids that are
    // perfectly reasonable: engraving a real performance always folds a few things — a note
    // clipped by the trim, two attacks inside one grid cell that genuinely were one note. On
    // the triplet demo a 1/4 grid loses 44 of 77 notes and a triplet grid loses 7, and only
    // the first of those is a grid that cannot hold the riff. A warning that appears on both
    // is a warning that gets ignored on both.
    //
    // A tenth is the line: below it the engraving is doing its ordinary job, above it the
    // grid is the reason the page disagrees with the recording.
    if (lost < 2 || lost / detected.length <= 0.1) return null;

    return el('span', {
      class: 'status-row warn-row',
      'data-role': 'grid-too-coarse',
      // The sentence names the SIZE, not the control: "1/4 would merge 12 notes" is the fact,
      // and it stays word for word what it has always been. The tooltip is where the control
      // is named, and it is Quantize now — a warning that sends somebody looking for a "grid"
      // beside a menu labelled Quantize is a warning about a control they cannot find.
      text: `${GRID_LABELS[s.grid]} would merge ${lost} notes — too coarse for this riff`,
      title: t(
        `The engine heard ${detected.length} notes and this Quantize setting can only write ${engraved} ` +
          'of them, because the rest fall between its lines. Try a finer size, or Auto, which picks one ' +
          'that fits.'
      )
    });
  }

  /**
   * The tempo as the BOX shows it — in the beat the time signature is written in.
   *
   * `tempoBpm` is quarter-notes per minute everywhere else in this app, without exception: the
   * pipeline, `secondsToTick`, `synthNotesFor` and `documentDuration` all divide 60 by it and
   * multiply by 960 ticks per quarter, and `documentDuration` carries the `4 / denominator`
   * factor that converts a signature's beats into quarters. So in 6/8 a stored 120 is 120
   * quarters a minute, which is 240 eighths a minute — and a box that printed "120" beside a
   * ♪ glyph would be out by a factor of two.
   *
   * The conversion is presentation only, in both directions, and the stored value never moves
   * when the signature does. That is the property worth stating out loud: switching 4/4 to 6/8
   * changes this number from 120 to 240 and changes NOTHING about how fast the take plays. The
   * playback clock never reads a tempo at all — `audio/transport.ts` schedules absolute
   * seconds computed once, and contains no reference to bpm or to a signature.
   */
  private displayedBpm(): number {
    const rt = this.runtime.get();
    const quarters = rt.score?.tempoBpm ?? rt.source?.tempoBpm ?? 100;
    return Math.round(quarters * beatUnit(rt.score?.timeSignature ?? rt.source?.timeSignature).perQuarter);
  }

  /**
   * Put the live tempo, and its unit, into the boxes that are already on screen.
   *
   * THE BOX COULD LIE, and it could do so before any of this wave's work: its value is written
   * once, when the transport is built, from `score?.tempoBpm ?? source?.tempoBpm ?? 100`. The
   * demo path builds the transport BEFORE the first engraving exists, so the fallback 100 was
   * drawn over a take the pipeline had put at 96 and nothing ever corrected it. Harmless-looking
   * until the unit arrived beside it: "100 ♩/min" next to a sheet engraved at 96 is a specific,
   * checkable, wrong claim rather than a vague one.
   *
   * Called from `applyScoreToViews`, which is the one place every rebuild goes through. In
   * place rather than by re-rendering, and never while the box has focus — overwriting somebody
   * mid-keystroke is its own bug.
   */
  private refreshTempoBox(): void {
    const box = this.root.querySelector<HTMLInputElement>('[data-role="bpm"]');
    if (box && document.activeElement !== box) box.value = String(this.displayedBpm());
    const unit = this.root.querySelector<HTMLElement>('[data-role="bpm-unit"]');
    if (unit) {
      const rt = this.runtime.get();
      unit.textContent = `${beatUnit(rt.score?.timeSignature ?? rt.source?.timeSignature).glyph}/min`;
    }
  }

  private buildTransport(): HTMLElement {
    return el(
      'div',
      { class: 'transport' },
      el('button', {
        class: 'primary',
        text: '⏵',
        'data-role': 'play',
        'aria-label': 'Play',
        title: t(TIPS.play),
        onClick: () => void this.togglePlayback()
      }),
      el('button', { text: '⏹', 'aria-label': 'Stop', title: t(TIPS.stop), onClick: () => void this.transport.stop() }),

      // UNDO AND REDO, ON SCREEN. ⌘Z has always worked and has always been invisible, which
      // makes it a feature for people who already knew about it. The player has to be able to
      // see that a mistake is undoable BEFORE making one — that is most of what makes an
      // editable sheet feel safe to touch — so the pair sits in the transport row, next to the
      // controls a hand is already on.
      //
      // Drawn arrows, not "↶". The text glyph renders as a hairline at this size in the
      // shell's font and reads as decoration; a 2.6px stroke reads as a button. Same box and
      // same weight as the chips beside them.
      el(
        'div',
        { class: 'row undo-redo' },
        el('button', {
          class: 'icon undo-btn',
          'data-role': 'undo',
          'aria-label': 'Undo',
          html: UNDO_SVG,
          disabled: !this.canUndo(),
          title: t(this.undoTitle()),
          onClick: () => this.undo()
        }),
        el('button', {
          class: 'icon undo-btn',
          'data-role': 'redo',
          'aria-label': 'Redo',
          html: REDO_SVG,
          disabled: !this.canRedo(),
          title: t(this.redoTitle()),
          onClick: () => this.redo()
        })
      ),

      el('button', {
        class: 'chip',
        text: this.transport.loop && this.loopBarNumber !== null ? `Bar ${this.loopBarNumber}` : 'Loop bar',
        'data-role': 'loop',
        title: t(TIPS.loop),
        onClick: () => this.toggleBarLoop()
      }),
      el('span', { class: 'position mono', 'data-role': 'position', title: t(TIPS.position), text: '0:00.00' }),

      el(
        'div',
        { class: 'fader', title: t(TIPS.fader) },
        el('span', { class: 'end', 'data-role': 'end-original', text: 'Original' }),
        el('input', {
          type: 'range',
          min: '0',
          max: '1',
          step: '0.01',
          value: String(this.transport.blend),
          'aria-label': 'Original to MIDI balance',
          onInput: (e: Event) => {
            this.transport.setBlend(Number((e.target as HTMLInputElement).value));
            this.bindTransportUi();
            // Where the fader was left is part of coming back to the same app. Saved from
            // here rather than from the transport's own state stream, which also ticks 60
            // times a second during playback.
            this.scheduleSave();
          }
        }),
        el('span', { class: 'end', 'data-role': 'end-midi', text: 'MIDI' })
      ),

      // The sound the MIDI side plays, right next to the fader that blends it against your
      // recording — which is the only place somebody comparing two sounds is looking. It was
      // in the settings panel, several groups down behind the gear, and the report was simply
      // "there is no option to choose sounds in the ui". There was; nobody could find it.
      // The settings panel keeps its copy: both read and write the one `playbackVoice`.
      soundPicker({
        settings: this.settings,
        // The picker redraws itself from the store and from the sample loader, so re-rendering
        // the header here would only destroy the element that is handling the event.
        onChange: () => {
          this.onViewSettingsChanged();
          this.scheduleSave();
        }
      }),

      this.buildTempoSource()
    );
  }

  /**
   * WHERE THE TEMPO COMES FROM — one control, in the row with the numbers it governs (F19).
   *
   * It replaces two controls that were the same question asked twice, two rows apart:
   *
   *   - a "Use DAW grid" chip in the header, which said nothing about what it would be applying
   *     beyond a dimmed detail string; and
   *   - a BPM box and a time-signature menu in the transport, which were always editable, even
   *     while the DAW's grid was overriding both of them. Typing into them un-lit the chip
   *     upstairs through `releaseHostGrid`, which is a correct behaviour that nothing on screen
   *     explained.
   *
   * Now the source is stated first and the fields follow from it, so the app cannot offer an
   * edit it is about to overrule:
   *
   *   Follow DAW     — the host's tempo and meter, read-only, with the sub-choice the app has
   *                    always made silently said out loud: a CAPTURED take carries the DAW's
   *                    measured bar lines ("bar lines"), a dropped file can only borrow its
   *                    tempo ("tempo only"). That is `describeHostGrid`, moved here from the
   *                    chip, and it is why the two are not separate options: the app does not
   *                    choose between them, the recording does.
   *   Manual         — the BPM box and the signature menu, editable, exactly as before.
   *   From recording — what the app worked out by ear, read-only, with a re-detect that throws
   *                    away the per-take overrides and measures again.
   *
   * NOTHING REACHABLE BEFORE HAS BEEN REMOVED. The two host-grid modes are both still reachable
   * (they were never a choice), typing a BPM still rebuilds, `releaseHostGrid` still fires when
   * somebody types under a DAW grid, and the settings panel keeps its own `useHostGrid` switch.
   * One `<select>` in the row that already existed: no new row, and the header is one chip
   * shorter than it was.
   */
  private tempoSourceMode(): 'daw' | 'manual' | 'recording' {
    const source = this.runtime.get().source;
    if (this.settings.get().useHostGrid && this.effectiveHostGrid()) return 'daw';
    // A take with no detection behind it — a blank score, a MIDI import — has nothing to hear,
    // so "from recording" is not a state it can be in however empty its tempo field is.
    if (source?.tempoBpm !== undefined || !source?.detected) return 'manual';
    return 'recording';
  }

  private setTempoSource(next: 'daw' | 'manual' | 'recording'): void {
    const source = this.runtime.get().source;
    if (next === 'daw') {
      this.settings.set({ useHostGrid: true });
    } else {
      if (this.settings.get().useHostGrid) this.settings.set({ useHostGrid: false });
      if (source && next === 'manual') {
        // Freeze what is on screen rather than reverting to a stored number. Choosing where a
        // tempo comes from must not, by itself, change the tempo — otherwise the sheet re-flows
        // under a control the player pressed to STOP it moving.
        const rt = this.runtime.get();
        this.runtime.set({
          source: {
            ...source,
            tempoBpm: rt.score?.tempoBpm ?? source.tempoBpm ?? 100,
            timeSignature: source.timeSignature ?? rt.score?.timeSignature
          }
        });
      } else if (source) {
        // Back to the app's own ears: drop the per-take overrides so the build re-derives both.
        this.runtime.set({ source: { ...source, tempoBpm: undefined, timeSignature: undefined } });
      }
    }
    this.rebuildNotation();
    this.renderMain();
    this.scheduleSave();
  }

  private buildTempoSource(): HTMLElement {
    const rt = this.runtime.get();
    const grid = this.effectiveHostGrid();
    const mode = this.tempoSourceMode();
    const manual = mode === 'manual';
    const unit = beatUnit(rt.score?.timeSignature ?? rt.source?.timeSignature);
    // Only sources this take can actually be in. A browser tab has no DAW, and a blank score
    // has nothing to have been heard in — an option that cannot be honoured is a control that
    // lies about what the app knows.
    const options: Array<{ value: 'daw' | 'manual' | 'recording'; label: string }> = [];
    if (grid) options.push({ value: 'daw', label: 'Follow DAW' });
    options.push({ value: 'manual', label: 'Manual' });
    if (rt.source?.detected) options.push({ value: 'recording', label: 'From recording' });

    return el(
      'div',
      { class: 'row tempo-source', 'data-role': 'tempo-source-row' },
      el(
        'select',
        {
          class: 'tempo-source-select',
          'data-role': 'tempo-source',
          'data-setting': 'useHostGrid',
          'aria-label': 'Where the tempo comes from',
          title: t(TIPS.tempoSource),
          onChange: (e: Event) => {
            this.setTempoSource((e.target as HTMLSelectElement).value as 'daw' | 'manual' | 'recording');
          }
        },
        ...options.map((o) => el('option', { value: o.value, text: o.label, selected: o.value === mode }))
      ),
      el('input', {
        type: 'number',
        min: '20',
        max: '400',
        style: { width: '62px' },
        'data-role': 'bpm',
        value: String(this.displayedBpm()),
        // Read-only rather than absent under the other two sources. The number is the thing
        // somebody came to this row to READ, and a field that disappears when it is not yours
        // to type into takes the answer away with the control.
        readonly: !manual,
        'aria-readonly': String(!manual),
        title: t(manual ? TIPS.bpm : TIPS.tempoSource),
        'aria-label': `Tempo in ${unit.name}s per minute`,
        onChange: (e: Event) => {
          if (!manual) return;
          const v = Number((e.target as HTMLInputElement).value);
          if (v >= 20 && v <= 400) {
            const source = this.runtime.get().source;
            // Back into quarter-notes per minute, which is the ONLY unit `tempoBpm` is ever
            // in. See `displayedBpm()` for why the box is not always in that unit.
            const quarters =
              v / beatUnit(this.runtime.get().score?.timeSignature ?? source?.timeSignature).perQuarter;
            if (source) this.runtime.set({ source: { ...source, tempoBpm: quarters } });
            this.releaseHostGrid('tempo');
            this.rebuildNotation();
            this.renderMain();
          }
        }
      }),
      // THE UNIT, next to the number. "120" on its own is ambiguous the moment the sheet is
      // in anything but a /4 meter, and the app was showing quarter-notes-per-minute under a
      // 6/8 signature with nothing to say so.
      el('span', {
        class: 'dim bpm-unit',
        'data-role': 'bpm-unit',
        text: `${unit.glyph}/min`,
        title: t(
          `The beat this tempo counts — ${unit.name}s per minute, which is the beat the time ` +
            'signature beside it is written in. Changing the signature re-states the same tempo in ' +
            'the new beat; it never plays back faster or slower.'
        )
      }),
      el(
        'select',
        {
          'data-role': 'timesig',
          title: t(manual ? TIPS.timesig : TIPS.tempoSource),
          'aria-label': 'Time signature',
          disabled: !manual,
          onChange: (e: Event) => {
            const [n, d] = (e.target as HTMLSelectElement).value.split('/').map(Number);
            const source = this.runtime.get().source;
            if (source) this.runtime.set({ source: { ...source, timeSignature: { numerator: n, denominator: d } } });
            this.releaseHostGrid('time signature');
            this.rebuildNotation();
            this.renderMain();
          }
        },
        // The preset list plus whatever the sheet is actually in, because a DAW can hand us
        // a meter nobody would have thought to put in a list — the user's own reproduction
        // was 3/6 — and a picker that cannot show the current value reads as if the app had
        // ignored the DAW.
        ...timeSigOptions(rt.score?.timeSignature).map((sig) => {
          const cur = rt.score?.timeSignature;
          return el('option', {
            value: sig,
            text: sig,
            selected: cur ? `${cur.numerator}/${cur.denominator}` === sig : sig === '4/4'
          });
        })
      ),
      // What the chosen source is actually supplying, in the fewest words that are still true.
      // Under Follow DAW this is the sub-choice the app makes on the recording's behalf — see
      // `describeHostGrid` — and it is the sentence that stopped a sheet sitting at 102 BPM
      // under a lit chip while REAPER was at 222.
      mode === 'daw' &&
        grid &&
        el('span', { class: 'dim tempo-detail', 'data-role': 'tempo-detail', text: describeHostGrid(grid) }),
      mode === 'recording' &&
        el('span', { class: 'dim tempo-detail', 'data-role': 'tempo-detail', text: 'heard in your playing' }),
      // RE-DETECT, and only where it means anything. It throws away the per-take tempo and
      // meter and rebuilds from the detection, which is what "measure it again" is once the
      // beats are already on disk — it never re-runs the listening engine (that is Start over,
      // in the Main menu, and it costs minutes rather than milliseconds).
      mode === 'recording' &&
        el('button', {
          class: 'chip',
          'data-role': 'tempo-redetect',
          text: 'Re-detect',
          title: t(TIPS.tempoRedetect),
          onClick: () => this.setTempoSource('recording')
        })
    );
  }

  /**
   * Turn the DAW sync off because the player just typed a number of their own.
   *
   * The pipeline resolves the contradiction in the grid's favour and says nothing (see
   * pipeline/index.ts), so without this, typing a tempo while the DAW source is chosen does
   * visibly nothing — which is the worst of the three possible behaviours. Saying so once,
   * plainly, is better than either ignoring the typing or silently discarding the DAW's grid.
   *
   * Still reachable after F19: the BPM box is read-only under Follow DAW, but the time
   * signature and every other caller can still contradict the grid, and a host that changes
   * tempo mid-session can land here too.
   */
  private releaseHostGrid(what: string): void {
    if (!this.settings.get().useHostGrid || !this.effectiveHostGrid()) return;
    this.settings.set({ useHostGrid: false });
    this.toast(
      'info',
      'Using your number',
      `The sheet was following your DAW's grid. You have just set the ${what} by hand, so it is ` +
        'using yours instead — set the tempo source back to "Follow DAW" to go back.'
    );
  }

  /** Cheap imperative updates — the toolbar must not re-render at 60fps during playback. */
  private toggleBarLoop(): void {
    if (this.transport.loop) {
      this.transport.setLoop(false);
      this.loopBarNumber = null;
      this.bindTransportUi();
      return;
    }

    const score = this.runtime.get().score;
    if (!score || score.ir.bars.length === 0) {
      this.transport.setLoopRange(null, null);
      this.transport.setLoop(true);
      this.bindTransportUi();
      return;
    }

    const origin = this.originSec(score);
    const secPerTick = 60 / (score.tempoBpm || 100) / (score.ir.divisions || 12);
    const at = this.transport.state.positionSec;
    const bars = score.ir.bars;
    const bar =
      bars.find((b) => {
        const from = origin + b.startTick * secPerTick;
        const to = from + b.durTicks * secPerTick;
        return at >= from && at < to;
      }) ?? bars.find((b) => !b.implicit) ?? bars[0];
    const from = Math.max(0, origin + bar.startTick * secPerTick);
    const to = Math.min(score.durationSec, from + bar.durTicks * secPerTick);
    this.transport.setLoopRange(from, to);
    this.transport.setLoop(true);
    this.loopBarNumber = bar.number;
    this.bindTransportUi();
  }

  /** Cheap imperative updates — the toolbar must not re-render at 60fps during playback. */
  private bindTransportUi(): void {
    const play = this.root.querySelector<HTMLElement>('[data-role="play"]');
    const loop = this.root.querySelector<HTMLElement>('[data-role="loop"]');
    const position = this.root.querySelector<HTMLElement>('[data-role="position"]');
    const endOriginal = this.root.querySelector<HTMLElement>('[data-role="end-original"]');
    const endMidi = this.root.querySelector<HTMLElement>('[data-role="end-midi"]');

    this.transportUnsub?.();
    this.transportUnsub = this.transport.subscribe((state) => {
      if (play) {
        play.textContent = state.mode === 'playing' ? '⏸' : '⏵';
        play.setAttribute('aria-label', state.mode === 'playing' ? 'Pause' : 'Play');
      }
      if (loop) {
        loop.classList.toggle('on', state.loop);
        loop.textContent = state.loop && this.loopBarNumber !== null ? `Bar ${this.loopBarNumber}` : 'Loop bar';
        loop.title = state.loop
          ? `Looping ${this.loopBarNumber !== null ? `bar ${this.loopBarNumber}` : 'the take'} — click to stop looping`
          : 'Loop the bar under the playhead';
      }
      if (position) position.textContent = `${formatTime(state.positionSec)} / ${formatTime(state.durationSec)}`;
      endOriginal?.classList.toggle('active', state.blend < 0.5);
      endMidi?.classList.toggle('active', state.blend > 0.5);

      // THE TRANSPORT COUNTS RECORDING SECONDS; THE PAGE DRAWS EDITED ONES (F16).
      //
      // Everything on screen is a picture of the take with the cuts closed up, so the playhead
      // is converted once, here, at the single place the transport's position enters the UI.
      // Un-cut the two clocks are the same number and this is the call it always was.
      const shown = this.toEditedSec(state.positionSec);
      if (state.mode === 'playing') this.skipCutsDuringPlayback(state.positionSec);
      this.waveform?.setPosition(shown);
      this.pianoRoll?.setPosition(shown);
      if (state.mode === 'playing') this.updatePlayhead(shown);
      else this.triview?.hidePlayhead();
    });
  }

  /** A recording second as the page's second. Identity on a take with no cuts. */
  private toEditedSec(audioSec: number): number {
    const cuts = this.cuts();
    return cuts.length ? audioToEditedSec(audioSec, cuts) : audioSec;
  }

  /** A page second as the recording's second, for anything about to reach the transport. */
  private toAudioSec(editedSec: number): number {
    const cuts = this.cuts();
    return cuts.length ? editedToAudioSec(editedSec, cuts) : editedSec;
  }

  /**
   * ================ HONOURING A CUT DURING ORIGINAL PLAYBACK (F16) ================
   *
   * WHAT THIS IS AND IS NOT. The transport plays the file off the disk, from one contiguous
   * position, and it holds ONE loop region — there is no skip-list for it to schedule and
   * teaching it one means editing `audio/transport.ts`, which this work is not allowed to do
   * and should not want to: the cut list is a document-level idea and the transport is a
   * clock. So the cut is honoured from OUT HERE, with the public API the transport already
   * has: when the playhead walks into a span the player removed, it is seeked to the far side
   * of it, exactly as a seek from a click on the strip would be.
   *
   * WHAT THAT COSTS, STATED HONESTLY. The transport reports its position on an animation
   * frame, so between the tape entering a cut and this seek landing there is up to one frame
   * of the removed audio — a few tens of milliseconds at the seam, audible as a click on a
   * loud edit. The MIDI voice has no such seam, because its notes are scheduled from the
   * edited take and the cut spans simply contain no notes. The transport tooltip says so
   * rather than implying the two are equally clean.
   *
   * `seekingPastCut` is the re-entrancy guard. A seek is async and the subscription keeps
   * firing while it is queued, so without it every frame in a cut would queue another seek —
   * the same stutter storm `Transport.seek` guards its own loop against.
   */
  private seekingPastCut = false;

  private skipCutsDuringPlayback(audioSec: number): void {
    const cuts = this.cuts();
    if (!cuts.length || this.seekingPastCut) return;
    const target = nextKeptSec(audioSec, cuts);
    if (target === audioSec) return;
    this.seekingPastCut = true;
    void this.transport
      .seek(target)
      .finally(() => {
        this.seekingPastCut = false;
      });
  }

  private updatePlayhead(editedSec: number): void {
    const score = this.runtime.get().score;
    if (!score || !this.triview) return;
    this.triview.setPlayheadTick(secondsToTick(score, editedSec, this.originSec(score)));
  }

  private seekToTick(tick: number): void {
    const score = this.runtime.get().score;
    if (!score) return;
    // The tick is the SHEET's, so the second it converts to is a page second and has to come
    // back to the recording's clock before the transport sees it (F16).
    void this.transport.seek(this.toAudioSec(tickToSeconds(score, tick, this.originSec(score))));
  }

  private onViewSettingsChanged(): void {
    const s = this.settings.get();
    this.triview?.setNamesVisible(s.showNoteNames);
    // The fret limit the sheet's drag handling checks against. It has to be pushed on change
    // rather than only at construction, or the panel's "Highest fret" would not take effect
    // until something else happened to rebuild the view — which is what `setFretLimit()` was
    // written for and, until the control existed, had no caller.
    this.triview?.setFretLimit(s.maxFret);
    this.transport.setVoice(s.playbackVoice);
    // The roll's ruler is a VIEW setting and belongs on this side of the line, not with the
    // rebuilding ones: it redraws one canvas. The panel and the header chip write the same
    // setting, so whichever the player reaches for, the other follows — which is why the
    // chip's own value is pushed back here rather than waiting for the next full render.
    this.pianoRoll?.setEditGrid(s.rollGrid);
    const rollGridChip = this.root.querySelector<HTMLSelectElement>('[data-role="roll-grid"]');
    if (rollGridChip && rollGridChip.value !== s.rollGrid) rollGridChip.value = s.rollGrid;
    // The snap chip is the one view control that is NOT just a redraw — it moves notes — so it
    // is restated here for the same reason the grid menu is, and no more than that: the value
    // is pushed onto the chip, and the rebuild that acts on it belongs to whoever changed it.
    const rollSnapChip = this.root.querySelector<HTMLElement>('[data-role="roll-snap"]');
    if (rollSnapChip) {
      rollSnapChip.classList.toggle('on', s.rollSnapToGrid);
      rollSnapChip.setAttribute('aria-checked', String(s.rollSnapToGrid));
    }
  }

  // =========================================================================
  // Bar-1 marker
  // =========================================================================

  /**
   * Dragging the marker moves where bar 1 sits. Nothing expensive happens during the drag;
   * on release the notation is rebuilt (never the transcription).
   */
  private onBarOneChange(sec: number, commit: boolean): void {
    const source = this.runtime.get().source;
    if (!source) return;
    this.runtime.set({ source: { ...source, barOneSec: sec } });
    // On release only. Saving every pixel of the drag would be a save per mousemove.
    if (commit) {
      this.rebuildNotationDebounced();
      this.scheduleSave();
    }
  }

  private rebuildNotationDebounced = debounce(() => this.rebuildNotation(), 60);

  // =========================================================================
  // Editing
  // =========================================================================

  private editContext(): EditContext | null {
    const index = this.triview?.scoreIndex;
    const score = this.runtime.get().score;
    if (!index || !score) return null;
    return {
      index,
      tuningLowToHigh: score.tuningLowToHigh,
      maxFret: this.settings.get().maxFret,
      capo: score.capo
    };
  }

  /**
   * A click on the sheet selects a note. Nothing opens.
   *
   * There used to be a popover here with pitch, string and timing steppers on it. The verdict
   * was "not very practical" and it was right: it covered the music you were reading, it took
   * a click to open and another to act, and it offered "move in time" on a staff where time is
   * a bar position rather than a number of seconds. Every one of those controls now has a
   * direct gesture — drag a notehead to change its pitch, drag a fret digit to change its
   * string, drag a rectangle on the piano roll to move it in time — so a click can go back to
   * meaning "this one".
   */
  private onNoteClick(hit: NoteHit): void {
    if (!hit.noteId || !hit.note) {
      this.seekToTick(hit.beat.absolutePlaybackStart);
      return;
    }
    const noteId = hit.noteId;
    this.selectNoteIds([noteId]);
  }

  /** One selection writer for waveform, roll, staff and TAB. */
  private selectNoteIds(ids: string[], updateWaveform = true): void {
    const unique = [...new Set(ids.filter(Boolean))];
    this.runtime.set({ selection: unique });
    this.triview?.setSelection(unique);
    this.pianoRoll?.setSelection(unique);
    if (!updateWaveform) return;
    const range = this.pianoRoll?.audioRangeForIds(unique) ?? this.audioRangeForSourceIds(unique);
    this.selection = range;
    this.tunerSelection = null;
    this.closeTuner();
    this.waveform?.setSelection(range?.fromSec ?? null, range?.toSec ?? null);
  }

  private audioRangeForSourceIds(ids: string[]): { fromSec: number; toSec: number } | null {
    if (!ids.length) return null;
    const wanted = new Set(ids);
    // The EDITED take (F16). This range is handed to the strip and to the tuner's window, both
    // of which are on the page's clock; reading the recording here would put the bracket a cut
    // away from the notes it is bracketing.
    const notes = this.editedSource()?.detected?.notes.filter((n) => n.id && wanted.has(n.id)) ?? [];
    if (!notes.length) return null;
    return {
      fromSec: Math.min(...notes.map((n) => n.startSec)),
      toSec: Math.max(...notes.map((n) => n.endSec))
    };
  }

  /**
   * A drag that finished on the engraving.
   *
   * The staff and the tab mean different things and this is where that is enforced: a staff
   * drag changes the PITCH, a tab drag changes only WHICH STRING the same pitch is played on. A
   * string move that the neck cannot reach is refused by the action itself and says so, rather
   * than sliding the note somewhere playable and lying about where your finger goes.
   *
   * The two therefore land in DIFFERENT LAYERS, and that is F7. A pitch is a claim about what
   * was played, so it is written into the performance and the rebuild re-frets it and carries
   * it to the roll and the exports (`commitPitchToPerformance`, reached through `perform`). A
   * string move is a claim about how to READ the same pitch — the performance is unchanged by
   * construction — so it stays notation-only, exactly as it always was.
   */
  private applySheetDrag(
    p:
      | { noteId: string; kind: 'pitch'; semitones: number }
      | { noteId: string; kind: 'string'; direction: 1 | -1; steps: number }
  ): void {
    if (p.kind === 'pitch') {
      if (p.semitones === 0) return;
      this.perform(new ChangePitchAction(p.noteId, p.semitones), p.noteId);
      return;
    }
    if (p.steps <= 0) return;
    // One action per string crossed, bundled into a single undo step: the player made one
    // gesture and ⌘Z has to put back one gesture.
    const parts = Array.from(
      { length: p.steps },
      () => new ChangeStringAction(p.noteId, p.direction)
    );
    this.perform(
      parts.length === 1 ? parts[0] : new CompositeAction('Change string', parts),
      p.noteId
    );
  }

  /**
   * F7 — A PITCH DRAGGED ON THE SHEET IS WRITTEN INTO THE PERFORMANCE.
   *
   * THE REPORTED BUG. `ChangePitchAction` mutates the alphaTab graph and nothing else, so the
   * page moved the notehead and the piano roll went on drawing the rectangle at the pitch the
   * engine had heard. The roll is not a second rendering of the sheet — it is a picture of
   * `source.detected.notes` (see §"Performance edits") — so a change that never reaches that
   * array is a change the roll cannot know about. The MIDI the export button writes comes off
   * the same layer, which is why the exported file disagreed with the page as well.
   *
   * THE IDENTITY IS THE ONE PLAYBACK ALREADY USES. An engraved note and the note that was
   * played carry the same stable id — `scoreToSynthNotes` matches them on exactly this to give
   * the sheet's pitches the performance's timing — so no new correspondence is invented here.
   *
   * IT IS A PERFORMANCE EDIT, NOT A NOTATION EDIT ALSO. Committing to both layers would be a
   * double transposition and not a redundant one: `setPerformance` re-runs the pipeline and
   * REPLAYS the notation log on top, so the same two semitones would be applied to the already
   * shifted note. So the pitch is written once, in the layer it belongs to, and the rebuild
   * carries it out to the engraving, the roll, the synth and every export — which is also what
   * makes it one undo step on the interleaved history, undoable exactly like a roll drag.
   *
   * Returns false when it does not apply, and the caller falls back to the notation action:
   *
   *   - a note the performance has never heard of — one DRAWN on the sheet, or a symbolic
   *     import (MIDI, MusicXML, Guitar Pro) where the written ticks are the truth and there is
   *     no take behind them. `sourceTiming` marks that case and `scoreToSynthNotes` already
   *     honours it;
   *   - a target off the ends of MIDI, which `ChangePitchAction` refuses too.
   *
   * A TAB DRAG DOES NOT COME HERE. Moving a note to another string is the same pitch played
   * somewhere else on the neck: the performance is unchanged by construction and the edit is
   * notation-only, which is `applySheetDrag`'s existing split and stays that way.
   */
  private commitPitchToPerformance(
    noteId: string,
    semitones: number,
    keepSelected: string | null
  ): boolean {
    if (!semitones) return false;
    const source = this.runtime.get().source;
    const notes = source?.detected?.notes;
    if (!notes?.length) return false;

    const at = notes.findIndex((n) => n.id === noteId);
    if (at < 0) return false;
    const played = notes[at];
    // A symbolic import's written ticks ARE its performance; there is nothing recorded behind
    // them to correct, so the notation action is the honest owner of the change.
    if (played.sourceTiming) return false;

    const target = played.midi + semitones;
    if (!Number.isFinite(target) || target < 0 || target > 127) return false;

    const next = notes.slice();
    next[at] = { ...played, midi: target };
    // The player has now decided about this note, so the auto-edit pass leaves it alone from
    // here on — the same rule a roll drag obeys. See `userTouchedIds`.
    this.userTouchedIds.add(noteId);
    this.commitPerformance(next, semitones > 0 ? 'Pitch up' : 'Pitch down');
    // The rebuild inside `commitPerformance` cleared the selection along with the old graph;
    // ids survive it (§4.8), so the note the player was dragging is still the note they meant.
    this.selectNoteIds(keepSelected ? [keepSelected] : []);
    return true;
  }

  /**
   * The one door every edit goes through.
   *
   * It is also where the edit is written down. Anything that edits the score MUST come
   * through here rather than reaching for `undoStack` directly, or the log and the stack
   * drift apart and a restored session shows edits the user never made (or misses ones
   * they did).
   */
  private perform(
    action: EditAction,
    keepSelected: string | null,
    layer: 'auto' | 'notation' = 'auto'
  ): void {
    const ctx = this.editContext();
    if (!ctx) return;
    // F7. A PITCH CHANGE IS A CHANGE TO WHAT WAS PLAYED, so it is written where what was
    // played lives. Everything else on this method is unchanged.
    //
    // `layer: 'notation'` forces the old route, and it is not a test hatch: it is the caller
    // saying "this is a change to how the music is WRITTEN, not a claim about what was played".
    // The performance layer has no opinion about spelling, and a take that has no performance
    // behind it at all (a symbolic import) reaches the same route through
    // `commitPitchToPerformance` declining — see its note.
    if (
      layer === 'auto' &&
      action.spec.kind === 'pitch' &&
      this.commitPitchToPerformance(action.spec.noteId, action.spec.semitones, keepSelected)
    ) {
      return;
    }
    const result = this.undoStack.perform(action, ctx);
    // Mirrors UndoStack.perform: a refused action is not pushed, and a new action after an
    // undo drops the redo tail.
    if (result.requiresRerender || result.requiresMidiUpdate) {
      this.editLog = this.editLog.slice(0, this.editCursor + 1);
      this.editLog.push(action.spec);
      this.editCursor = this.editLog.length - 1;
      // The interleaving record, so one ⌘Z walks back through sheet edits and roll edits in
      // the order they were actually made.
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push('score');
      this.historyIndex = this.history.length - 1;
      this.scheduleSave();
    }
    this.applyResult(result, keepSelected);
    this.refreshUndoRedo();
  }

  /**
   * The single place that turns an action result into visible change.
   *
   * Note what is NOT here: no `firstChangedMasterBar`. The Phase 0 spike measured that hint
   * as a 6x median / 17x p90 pessimization at 32 bars. Edits land in ~9ms at 16 bars without
   * it, which is also why there is no debounce on this path.
   */
  private applyResult(result: ActionResult, keepSelected: string | null): void {
    if (!result.requiresRerender && !result.requiresMidiUpdate) return;
    if (result.requiresRerender) this.triview?.rerenderAfterEdit();
    // The piano roll is a second view of the SAME model, so it re-reads on the same event —
    // no polling, no snapshot of its own. It used to hold the pipeline's IR, which an edit
    // never touches, so changing a pitch on the sheet left the roll showing the old note.
    // Undo and redo come through here too, which is why they are covered by construction.
    this.pianoRoll?.refresh();
    if (result.requiresMidiUpdate) {
      this.triview?.refreshMidi();
      const score = this.runtime.get().score;
      if (score) {
        this.pushScoreNotes(score);
      }
    }
    if (keepSelected) {
      this.selectNoteIds([keepSelected]);
    } else {
      this.selectNoteIds([]);
    }
  }

  // =========================================================================
  // Performance edits — what the piano roll changes
  //
  // There are two editable layers in this app and conflating them is how a piano roll ends up
  // unable to lengthen a note:
  //
  //   THE NOTATION — an alphaTab beat has a written duration, and its bar has to add up. You
  //   can move a note to the next beat or transpose it (edit/actions.ts does exactly that),
  //   but "make this one 40 ms longer" has no meaning there: it would leave the bar over-full
  //   and every following beat in the wrong place.
  //
  //   THE PERFORMANCE — `source.detected.notes`, the times and pitches the engine reported.
  //   Free-form: a note can start anywhere and last anything. This is what a piano roll is a
  //   picture OF, so it is what the piano roll edits.
  //
  // A performance edit therefore re-runs the pipeline (~10 ms, measured — design notes §4.12)
  // and replays the notation edits on top, which works because note ids are stable across a
  // rebuild by construction (§4.8). Persistence comes free: the detected notes are already in
  // the session blob, so a roll edit survives the plugin window being destroyed without a
  // single new field.
  //
  // Undo spans both layers. `history` records only WHICH layer each step belongs to; the two
  // stacks hold the steps themselves.
  // =========================================================================

  // =========================================================================
  // The auto-edit pass — the app acting on its own ears
  //
  // `edit/autoEdits.ts` decides WHAT; this decides WHEN, remembers what was done, and puts it
  // in front of the player. Three rules shape everything below:
  //
  //   1. THE EDITS ARE ORDINARY PERFORMANCE EDITS. They go through `commitPerformance` like a
  //      drag on the roll does, so undo, the rebuild, the session blob and the sheet all treat
  //      them as edits — because that is what they are. Nothing here is a special case
  //      downstream of this section.
  //   2. NOTHING IS SILENT. Every edit carries provenance until the player has looked at it.
  //   3. IT NEVER ARGUES WITH SOMEBODY WHO HAS ALREADY DECIDED. A note the player has touched
  //      by hand is exempt from every later pass.
  // =========================================================================

  /** What the pass did, kept until reviewed. Empty except right after a transcription. */
  private autoEdits: Array<AppliedAutoEdit & { id: string; reviewed: boolean }> = [];
  /** What it noticed and did NOT act on — the toggle being off, or a guardrail refusing. */
  private autoAttention: AttentionMark[] = [];
  /** Ids for the notes it creates. A namespace of its own, so nothing can collide. */
  private autoNoteCount = 0;
  /** Set once a transcription lands; cleared when the pass has run against it. */
  private autoPassPending = false;
  /**
   * Notes the player has edited by hand.
   *
   * Written by every path that commits a performance edit or a notation edit. It is the whole
   * of rule 3: the pass reads it and skips those notes, so an automatic re-run can never undo
   * a decision somebody has already made about a particular note.
   */
  private userTouchedIds = new Set<string>();
  /** Which unreviewed edit the counter chip is pointing at. */
  private autoReviewCursor = 0;
  private autoPopover: HTMLElement | null = null;

  /** Snapshots of the whole performance, one per roll edit. Entry 0 is "as transcribed". */
  private perfStack: InputNote[][] = [];
  private perfIndex = 0;
  /**
   * What each performance step WAS, parallel to `perfStack`.
   *
   * Index 0 is the take as the engine returned it and has no label, so `perfLabels[i]` names
   * the step that produced `perfStack[i]`. Only the undo/redo tooltips read it — the notation
   * stack has carried labels all along and the performance stack was the half that could not
   * say what it would put back.
   */
  private perfLabels: Array<string | null> = [null];
  /**
   * The CUT LIST at each performance step, parallel to `perfStack` (F16).
   *
   * A cut is a performance edit — it changes what was played, by removing some of it — so it
   * belongs on this stack and not on a third one, and it rides the same interleaved `history`
   * that lets one ⌘Z walk back through roll drags and sheet edits in the order they were made.
   * It is a parallel array for the same reason `perfLabels` is: the two move together on every
   * push, every truncation and every step, and keeping them in step is one line each.
   */
  private perfCuts: CutSpan[][] = [NO_CUTS];
  /** The order the two layers were edited in, so one ⌘Z walks back through both. */
  private history: Array<'perf' | 'score'> = [];
  private historyIndex = -1;
  /** Ids for notes the player adds. Never collides with the engine's `n<index>` ids. */
  private addedNoteCount = 0;

  /**
   * Keep the interleaving record honest after a replay.
   *
   * `replayEdits` can legitimately drop an edit that no longer applies, at which point the
   * record of "which layer was edited when" no longer matches the two stacks it describes.
   * When that happens the exact interleaving is not recoverable, so it falls back to the one
   * order that is definitely coherent — the performance underneath, the notation on top —
   * rather than leaving ⌘Z pointing at a step that is not there. Rare enough that the lost
   * ordering is a better trade than a broken undo.
   */
  private reconcileHistory(): void {
    const scoreSteps = this.editCursor + 1;
    const perfSteps = this.perfIndex;
    const done = this.history.slice(0, this.historyIndex + 1);
    if (
      done.filter((h) => h === 'score').length === scoreSteps &&
      done.filter((h) => h === 'perf').length === perfSteps
    ) {
      return;
    }
    this.history = [
      ...(Array<'perf'>(perfSteps).fill('perf') as Array<'perf' | 'score'>),
      ...(Array<'score'>(scoreSteps).fill('score') as Array<'perf' | 'score'>)
    ];
    this.historyIndex = this.history.length - 1;
  }

  /** Start over from a fresh performance: a new take, or a rebuild that dropped the edits. */
  private resetHistories(): void {
    const notes = this.runtime.get().source?.detected?.notes ?? [];
    this.perfStack = [notes];
    this.perfLabels = [null];
    this.perfCuts = [this.cuts()];
    this.perfIndex = 0;
    this.history = [];
    this.historyIndex = -1;
    this.refreshUndoRedo();
  }

  /**
   * Turn a gesture on the roll into a new performance, and redraw everything from it.
   *
   * The transform itself lives in `edit/rollPerformance.ts` so it can be exercised without a
   * DOM; this method only supplies the two numbers it needs from the live score and commits
   * the result.
   */
  private applyRollEdit(edit: RollEdit): void {
    const source = this.runtime.get().source;
    const score = this.runtime.get().score;
    if (!source?.detected || !score) return;

    const raw = source.detected.notes;
    // APPLIED TO WHAT THE PLAYER WAS LOOKING AT. A drag is a delta from the rectangle under the
    // pointer, and while the snap is on that rectangle is at a snapped second — so applying the
    // delta to the raw note would land it a fraction of a beat from where it was dropped. With
    // the snap off the feed IS the raw take and this is the call it always was.
    const feed = this.performanceFeed();
    const result = applyRollEditToNotes(feed, edit, {
      originSec: this.originSec(score),
      tempoBpm: score.tempoBpm,
      newNoteId: () => `add${++this.addedNoteCount}`
    });
    if (!result) return;

    // The player has now decided about these notes, so the auto-edit pass leaves them alone
    // from here on. See `userTouchedIds`.
    const touched = new Set(rollEditNoteIds(edit));
    for (const id of touched) this.userTouchedIds.add(id);

    // A CUT TAKE MERGES DIFFERENTLY (F16), for two reasons that both cost data if ignored.
    //
    // The clock: the roll draws the take with the cuts closed up, so a rectangle dropped at
    // edited second 4 is at a LATER audio second whenever anything before it was cut, and
    // `source.detected.notes` is stated in audio seconds — permanently, because that is what
    // makes a cut undoable.
    //
    // The census: the feed does not contain the notes whose attacks are inside a cut. Merging
    // by rebuilding the take out of the feed, as the un-cut path does, would therefore delete
    // every one of them the first time the player dragged anything — a cut would silently
    // become destructive after all. So the cut path starts from the RECORDING and writes only
    // the named notes into it.
    const cuts = this.cuts();
    this.commitPerformance(
      cuts.length
        ? mergeRollEditOntoCutTake(raw, result.notes, touched, cuts)
        : // Only the notes the gesture NAMED keep their edited position; every other note goes
          // back to the recording. Committing `result.notes` wholesale would quietly promote the
          // snapped position of every untouched note into the raw take, and one drag would cost
          // the player the ability to ever switch the snap off again.
          feed === raw
          ? result.notes
          : mergeEditedOntoRaw(raw, result.notes, touched),
      result.label
    );
  }

  // -------------------------------------------------------------------------
  // Running it
  // -------------------------------------------------------------------------

  /**
   * Run the pass, if there is anything to run it against.
   *
   * Called from two places that arrive in either order — the transcription finishing, and the
   * attack detector finishing its (deliberately deferred) analysis of the same take. Whichever
   * is second is the one that actually runs it, which is why this is a "maybe" rather than a
   * step in a sequence.
   */
  /** Forget every outstanding highlight. A fresh take is a fresh argument. */
  private clearAutoEdits(): void {
    this.autoEdits = [];
    this.autoAttention = [];
    this.autoReviewCursor = 0;
    this.userTouchedIds.clear();
    this.closeAutoPopover();
    this.refreshAutoMarks();
  }

  private maybeRunAutoEditPass(): void {
    if (!this.autoPassPending) return;
    const source = this.runtime.get().source;
    if (!source?.detected || !this.onsetResult) return;
    this.autoPassPending = false;
    this.runAutoEditPass();
  }

  /**
   * Look at the take with the app's own ears, and act if the setting allows it.
   *
   * The thinking happens either way, and with the setting OFF the result is now NOTHING on
   * screen: no edits, no marks, no chip. That is a reversal. The old behaviour drew the
   * refusals as yellow highlights on the argument that "do not touch my notes" is a different
   * instruction from "do not tell me" — which is true, and still produced a take speckled
   * with marks the player could neither act on nor clear. Switching the feature off now
   * means what it says. The plan is still computed and still recorded on `autoAttention`,
   * because the probes and the guardrail checks read it; it is simply never painted.
   */
  private runAutoEditPass(): void {
    const source = this.runtime.get().source;
    const onsets = this.onsetResult;
    if (!source?.detected || !onsets) return;

    const enabled = this.settings.get().autoSplitAtAttacks;
    const plan = planAutoEdits({
      notes: source.detected.notes,
      onsets: onsets.onsets,
      pcm: this.pcm,
      sampleRate: this.pcmRate,
      // The ROLL's cell, which is what "sane vs the grid" is measured against. Read live
      // rather than captured, so changing the ruler changes the next pass and not this one.
      snapSec: this.pianoRoll?.probe().snapSec ?? 0.25,
      userTouchedIds: this.userTouchedIds,
      durationSec: source.durationSec
    });

    if (!enabled) {
      // Everything the pass WOULD have done becomes something it noticed. A split it would
      // have made is still a note worth a second look, so it joins the refusals rather than
      // being thrown away.
      this.autoEdits = [];
      this.autoAttention = [
        ...plan.attention,
        ...plan.splits.map((s) => ({
          kind: 'split' as const,
          noteId: s.noteId,
          atSec: s.atSec,
          fromSec: s.fromSec,
          toSec: s.toSec,
          reason: 'A second attack was heard inside this note. Auto-split is switched off, so it was left alone.'
        })),
        ...plan.fills.map((f) => ({
          kind: 'fill' as const,
          atSec: f.fromSec,
          fromSec: f.fromSec,
          toSec: f.toSec,
          reason: `A steady ${midiToName(f.midi)} was heard here that the engine missed. Auto-fill is switched off, so nothing was added.`
        }))
      ];
      this.autoReviewCursor = 0;
      this.refreshAutoMarks();
      return;
    }

    const applied = applyAutoEdits(source.detected.notes, plan, () => `auto${++this.autoNoteCount}`);
    this.autoAttention = plan.attention;
    this.autoEdits = applied.applied.map((edit, i) => ({
      ...edit,
      id: `ae${Date.now().toString(36)}-${i}`,
      reviewed: false
    }));
    this.autoReviewCursor = 0;

    if (applied.applied.length > 0) {
      // ONE undo step for the whole pass. It happened as one event from the player's point of
      // view, so one ⌘Z has to put back one event — the same rule a group drag on the roll
      // follows. Reverting them individually is what the popover is for.
      this.commitPerformance(
        applied.notes,
        applied.applied.length === 1 ? 'Auto edit' : `${applied.applied.length} auto edits`
      );
    } else {
      this.refreshAutoMarks();
    }
  }

  /**
   * Push the current marks into the two views that are allowed to show them.
   *
   * ONLY EDITS THAT WERE ACTUALLY MADE. `this.autoAttention` — everything the pass noticed
   * and refused — is deliberately NOT drawn any more, on either view. It is still recorded,
   * still counted by the probes, and still the reason a guardrail can be shown to have
   * fired; it simply has no ink.
   *
   * Why: a yellow highlight is a request for attention that comes with nothing to do about
   * it. Every take had a scattering of them, on notes that were correct, and the cost was
   * paid by the green marks — the ones that mean "the app changed this, check it" — which
   * the eye learned to skim along with the rest. One kind of mark, one meaning, one action.
   */
  private refreshAutoMarks(): void {
    const marks: Array<{ noteId: string }> = [];
    for (const edit of this.autoEdits) {
      if (edit.reviewed) continue;
      for (const id of edit.noteIds) marks.push({ noteId: id });
    }
    this.pianoRoll?.setAutoMarks(marks);
    // The pass reads the RECORDING (see `runAutoEditPass`), so its spans are audio seconds and
    // the strip they are painted on draws edited ones. A mark whose whole span was cut out
    // collapses to nothing and is dropped rather than drawn as a hairline over the seam.
    this.waveform?.setAttentionRegions(
      this.autoEdits
        .filter((e) => !e.reviewed)
        .map((e) => ({ fromSec: this.toEditedSec(e.fromSec), toSec: this.toEditedSec(e.toSec) }))
        .filter((r) => r.toSec > r.fromSec)
    );
    this.updateAutoChip();
  }

  /** Is the counter chip on screen? Read off the element, not off the count it was built from. */
  private chipVisible(): boolean {
    const chip = this.root.querySelector<HTMLElement>('[data-role="auto-edits"]');
    return !!chip && chip.style.display !== 'none';
  }

  private chipText(): string | null {
    return this.root.querySelector<HTMLElement>('[data-role="auto-edits-text"]')?.textContent ?? null;
  }

  /** The unreviewed edits, in the order they happen in the take. */
  private unreviewedAutoEdits(): Array<AppliedAutoEdit & { id: string; reviewed: boolean }> {
    return this.autoEdits.filter((e) => !e.reviewed).sort((a, b) => a.fromSec - b.fromSec);
  }

  /**
   * The counter chip in the roll's controls.
   *
   * Updated in place rather than by re-rendering the header: a full render rebuilds the roll,
   * the waveform and the tri-view, and doing that on every Keep would throw away the scroll
   * position and the selection the player is working with.
   */
  private updateAutoChip(): void {
    const chip = this.root.querySelector<HTMLElement>('[data-role="auto-edits"]');
    if (!chip) return;
    const count = this.unreviewedAutoEdits().length;
    // Hidden at zero — a chip reading "0 auto edits" is chrome about nothing.
    chip.style.display = count > 0 ? '' : 'none';
    const label = chip.querySelector<HTMLElement>('[data-role="auto-edits-text"]');
    if (label) label.textContent = count === 1 ? '1 auto edit' : `${count} auto edits`;
  }

  // =========================================================================
  // F16 — TRIMMING AND CUTTING THE TAKE
  //
  // Two gestures, one model. Everything either of them does is `commitPerformance` with a new
  // cut list (see `perfCuts`), so both are ordinary performance edits: one ⌘Z, one entry on the
  // interleaved history, saved with the session, and the whole page redrawn from the mapping in
  // edit/cuts.ts. Nothing here knows how to remove audio, because nothing removes any.
  //
  // NOTHING IS AUTOMATIC. The chip is an offer and it can be dismissed; a take is never trimmed
  // because the app thought it should be. That is the rule the whole feature was asked for
  // under, and it is why `detectTrimCuts` is only ever consulted to decide whether to ASK.
  // =========================================================================

  /** Set once the player has waved the trim offer away. Per take: a new take asks again. */
  private trimChipDismissed = false;

  /** The lead-in and tail this take would lose, or none. Empty once they have been cut. */
  private trimOffer(): CutSpan[] {
    const source = this.runtime.get().source;
    const notes = source?.detected?.notes;
    if (!source || !notes?.length) return NO_CUTS;
    let first: number | null = null;
    let last: number | null = null;
    for (const n of notes) {
      if (!Number.isFinite(n.startSec)) continue;
      if (first === null || n.startSec < first) first = n.startSec;
      if (last === null || n.endSec > last) last = n.endSec;
    }
    const offer = detectTrimCuts(first, last, source.durationSec, TRIM_CHIP_THRESHOLD_SEC);
    if (!offer.length) return NO_CUTS;
    // Already cut there? Then there is nothing to offer, and re-offering it would let one click
    // trim the same silence twice.
    const already = this.cuts();
    const wanted = offer.filter((o) => !already.some((c) => c.fromSec <= o.fromSec && c.toSec >= o.toSec));
    return wanted.length ? wanted : NO_CUTS;
  }

  /**
   * The strip's own edit row: the trim offer, and what to do with a selected span.
   *
   * Built empty and filled by `refreshTakeEdits`, which is also what every later change calls —
   * the row sits between the waveform and the tuner and re-rendering the screen to show a
   * button would throw the strip's canvas away mid-gesture.
   */
  private buildTakeEdits(): HTMLElement {
    // Hidden until it is filled: the row has padding and a rule under it, and a screen that
    // rendered an empty bar for one frame would jump.
    const row = el('div', { class: 'take-edits', 'data-role': 'take-edits', hidden: true });
    queueMicrotask(() => this.refreshTakeEdits());
    return row;
  }

  private refreshTakeEdits(): void {
    const row = this.root.querySelector<HTMLElement>('[data-role="take-edits"]');
    if (!row) return;
    const children: HTMLElement[] = [];

    const offer = this.trimChipDismissed ? NO_CUTS : this.trimOffer();
    if (offer.length) {
      const seconds = cutTotalSec(offer);
      children.push(
        el(
          'div',
          { class: 'take-chip', 'data-role': 'trim-chip' },
          el('button', {
            class: 'chip take-chip-go',
            'data-role': 'trim-go',
            // The NUMBER, because "trim the silence" is a question the player cannot answer
            // without it — a tenth of a second and four seconds are different decisions.
            text: `Trim ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s of silence?`,
            title: t(TIPS.trimSilence),
            onClick: () => this.trimSilence()
          }),
          el('button', {
            class: 'chip take-chip-dismiss',
            'data-role': 'trim-dismiss',
            'aria-label': 'Leave the silence alone',
            text: '✕',
            title: 'Leave it. The offer will not come back for this take.',
            onClick: () => {
              this.trimChipDismissed = true;
              this.refreshTakeEdits();
            }
          })
        )
      );
    }

    // A span dragged on the strip is already the tuner's window; it is also the thing "Cut out"
    // acts on, so the button appears with the selection rather than needing a mode.
    const picked = this.tunerSelection;
    if (picked && picked.toSec - picked.fromSec >= MIN_CUT_SEC) {
      children.push(
        el('button', {
          class: 'chip take-cut',
          'data-role': 'cut-out',
          text: `Cut out ${(picked.toSec - picked.fromSec).toFixed(1)}s`,
          title: t(TIPS.cutOut),
          onClick: () => this.cutOutSelection()
        })
      );
    }

    if (this.cuts().length) {
      children.push(
        el('span', {
          class: 'take-cut-note',
          'data-role': 'cut-summary',
          text: `${this.cuts().length} cut${this.cuts().length === 1 ? '' : 's'} — ${cutTotalSec(this.cuts()).toFixed(1)}s removed`,
          title: t(TIPS.cutSummary)
        })
      );
    }

    row.replaceChildren(...children);
    row.hidden = children.length === 0;
  }

  /** Accept the offer. One click, one undo step, and never anything the app did on its own. */
  private trimSilence(): void {
    const source = this.runtime.get().source;
    const offer = this.trimOffer();
    if (!source || !offer.length) return;
    this.commitTakeCuts(
      normalizeCuts([...this.cuts(), ...offer], source.durationSec),
      'Trim silence'
    );
  }

  /**
   * Remove the selected span and ripple the timeline closed.
   *
   * The selection is on the EDITED clock — it was dragged on a strip that is already showing
   * earlier cuts closed up — which is exactly what `addCut` takes and why the conversion is not
   * done here. Repeatable by construction: the result is a normalized, disjoint list, so the
   * fifth cut is the same operation as the first.
   */
  private cutOutSelection(): void {
    const source = this.runtime.get().source;
    const picked = this.tunerSelection;
    if (!source || !picked) return;
    const next = addCut(this.cuts(), picked, source.durationSec);
    if (next.length === this.cuts().length && cutTotalSec(next) <= cutTotalSec(this.cuts())) return;
    this.closeTuner();
    this.selectNoteIds([]);
    this.commitTakeCuts(next, 'Cut out');
  }

  /**
   * One writer for the cut list.
   *
   * The NOTES are handed through unchanged — cutting does not edit them, it changes which of
   * them the page can see, and that is `editedSource()`'s job. Committing them by identity is
   * what keeps a cut reversible down to the bit: undo restores the old list and every note is
   * still stamped with the second it was actually played at.
   */
  private commitTakeCuts(cuts: CutSpan[], label: string): void {
    const source = this.runtime.get().source;
    if (!source?.detected) return;
    this.commitPerformance(source.detected.notes, label, cuts);
    // The playhead may be standing on tape that no longer exists.
    const at = this.transport.state.positionSec;
    if (cuts.length) {
      const moved = nextKeptSec(at, cuts);
      if (moved !== at) void this.transport.seek(moved);
    }
    this.refreshTakeEdits();
  }

  /**
   * Step to the next unreviewed auto edit: select it, show it, and open its popover.
   *
   * MOUSE-FIRST, and that is not a style preference. The player runs this inside REAPER, which
   * swallows most keystrokes before the plugin sees them — so a review flow that needed ⌘Z or
   * an arrow key would be a review flow they could not use.
   */
  private focusNextAutoEdit(): void {
    const list = this.unreviewedAutoEdits();
    if (list.length === 0) return;
    const edit = list[this.autoReviewCursor % list.length];
    this.autoReviewCursor = (this.autoReviewCursor + 1) % list.length;
    this.selectNoteIds([edit.noteIds[0]]);
    void this.transport.seek(Math.max(0, edit.fromSec));
    this.openAutoPopover(edit);
  }

  // -------------------------------------------------------------------------
  // Reviewing it
  // -------------------------------------------------------------------------

  private autoEditForNote(noteId: string): (AppliedAutoEdit & { id: string; reviewed: boolean }) | null {
    return this.autoEdits.find((e) => !e.reviewed && e.noteIds.includes(noteId)) ?? null;
  }

  /**
   * "Split by Riffsheet — Keep / Revert", over the note it is about.
   *
   * Two buttons and a sentence. Keep clears the highlight and nothing else; Revert undoes that
   * one edit — merging the fragments back into the note the engine returned, or removing the
   * note that was added — and marks it as the player's, so no later pass makes it again.
   */
  private openAutoPopover(edit: AppliedAutoEdit & { id: string; reviewed: boolean }): void {
    this.closeAutoPopover();
    const canvas = this.root.querySelector<HTMLCanvasElement>('.pianoroll');
    const rect = this.pianoRoll
      ?.paintedRects()
      .find((r) => r.noteId && edit.noteIds.includes(r.noteId));

    const pop = el(
      'div',
      { class: 'popover auto-popover', 'data-role': 'auto-popover', role: 'dialog', 'aria-label': edit.title },
      el('div', { class: 'pop-title', 'data-role': 'auto-popover-title', text: edit.title }),
      el('div', {
        class: 'auto-popover-why dim',
        text:
          edit.kind === 'split'
            ? 'The recording has a second attack inside this note, so it was divided there.'
            : 'The engine wrote nothing here, but a steady note was heard. It was added.'
      }),
      el(
        'div',
        { class: 'pop-row' },
        el('button', {
          class: 'chip',
          'data-role': 'auto-keep',
          text: 'Keep',
          title: 'Keep this edit and clear its highlight',
          onClick: () => this.resolveAutoEdit(edit.id, 'keep')
        }),
        el('button', {
          class: 'chip',
          'data-role': 'auto-revert',
          text: 'Revert',
          title: edit.kind === 'split' ? 'Put the note back together' : 'Remove the added note',
          onClick: () => this.resolveAutoEdit(edit.id, 'revert')
        })
      )
    );
    document.body.appendChild(pop);
    this.autoPopover = pop;

    // Over the note when it is on screen, and over the roll's top-left when it is not — a
    // popover placed off screen because the player has scrolled elsewhere is a dead end.
    const host = canvas?.getBoundingClientRect();
    const size = pop.getBoundingClientRect();
    const left = host && rect ? host.left + rect.x + rect.w / 2 - size.width / 2 : (host?.left ?? 8) + 12;
    const top = host && rect ? host.top + rect.y - size.height - 8 : (host?.top ?? 8) + 12;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - size.width - 8, left))}px`;
    pop.style.top = `${Math.max(8, top)}px`;
  }

  private closeAutoPopover(): void {
    this.autoPopover?.remove();
    this.autoPopover = null;
  }

  /**
   * Keep or revert one auto edit.
   *
   * Either way the note stops being the app's business: `userTouchedIds` gains its ids, so a
   * later pass over the same take leaves it exactly as the player left it.
   */
  private resolveAutoEdit(id: string, action: 'keep' | 'revert'): void {
    const edit = this.autoEdits.find((e) => e.id === id);
    if (!edit) return;
    this.closeAutoPopover();

    if (action === 'revert') {
      const source = this.runtime.get().source;
      const next = source?.detected ? revertAutoEdit(source.detected.notes, edit) : null;
      if (next) {
        // Through the ordinary door, so this is one more step in the same undo history rather
        // than a hidden mutation the player cannot walk back.
        this.commitPerformance(next, edit.kind === 'split' ? 'Undo auto split' : 'Remove auto note');
      }
    }
    for (const noteId of edit.noteIds) this.userTouchedIds.add(noteId);
    edit.reviewed = true;
    this.refreshAutoMarks();
    this.scheduleSave();
  }

  /**
   * `cuts` defaults to the ones already in force, so every existing caller pushes a step that
   * changes the notes and leaves the cut list alone — and the two cut gestures (F16) push a
   * step that does the reverse. Both are ordinary performance edits either way.
   */
  private commitPerformance(notes: InputNote[], label: string, cuts: CutSpan[] = this.cuts()): void {
    const source = this.runtime.get().source;
    if (!source?.detected) return;

    // Drop the redo tail on both stacks — a new edit after an undo replaces the future.
    this.perfStack = this.perfStack.slice(0, this.perfIndex + 1);
    this.perfLabels = this.perfLabels.slice(0, this.perfIndex + 1);
    this.perfCuts = this.perfCuts.slice(0, this.perfIndex + 1);
    this.perfStack.push(notes);
    this.perfLabels.push(label);
    this.perfCuts.push(cuts);
    this.perfIndex = this.perfStack.length - 1;
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push('perf');
    this.historyIndex = this.history.length - 1;

    this.setPerformance(notes, cuts);
    this.refreshUndoRedo();
  }

  /** Put a performance on screen: new notes in, pipeline re-run, notation edits replayed. */
  private setPerformance(notes: InputNote[], cuts: CutSpan[] = this.cuts()): void {
    const source = this.runtime.get().source;
    if (!source?.detected) return;
    this.runtime.set({
      source: {
        ...source,
        detected: { ...source.detected, notes },
        ...(cuts.length ? { cuts } : { cuts: undefined })
      }
    });
    this.rebuildNotation({ keepEdits: true });
    // The rebuild replaces the roll's model, and with it every mark it was drawing. Restated
    // here rather than inside the roll, because the marks belong to the pass and not to the
    // view: the roll is told what to highlight, it does not remember it.
    this.refreshAutoMarks();
    // Undo and redo come through here, so the cut summary and the trim offer follow the cut
    // list wherever the history moves it (F16).
    this.refreshTakeEdits();
    this.scheduleSave();
  }

  /**
   * Is there anything to walk back? Asked of BOTH layers, not of one.
   *
   * `undo()` below prefers the interleaved history and falls through to the notation stack, so
   * the button has to be lit whenever either of them would do something. Reading only
   * `undoStack.canUndo` would grey the button out after a roll edit — which is a performance
   * step, lives on the other stack, and is undoable.
   */
  private canUndo(): boolean {
    return this.historyIndex >= 0 || this.undoStack.canUndo;
  }

  private canRedo(): boolean {
    return this.historyIndex < this.history.length - 1 || this.undoStack.canRedo;
  }

  /** "Undo — move note" beats "Undo", and it costs one lookup. */
  private undoTitle(): string {
    if (!this.canUndo()) return 'Nothing to undo yet.';
    const next = this.historyIndex >= 0 ? this.history[this.historyIndex] : 'score';
    const label = next === 'perf' ? (this.perfLabels[this.perfIndex] ?? null) : this.undoStack.undoLabel;
    return label ? `Undo — ${label.toLowerCase()}` : 'Undo the last change (⌘Z).';
  }

  private redoTitle(): string {
    if (!this.canRedo()) return 'Nothing to redo.';
    const next = this.historyIndex < this.history.length - 1 ? this.history[this.historyIndex + 1] : 'score';
    const label = next === 'perf' ? (this.perfLabels[this.perfIndex + 1] ?? null) : this.undoStack.redoLabel;
    return label ? `Redo — ${label.toLowerCase()}` : 'Redo the change you just undid (⇧⌘Z).';
  }

  /**
   * Light or grey the pair, in place.
   *
   * In place rather than by re-rendering the transport: an edit that rebuilt the row would
   * throw away the fader element mid-drag and take the sound picker's open menu with it.
   */
  private refreshUndoRedo(): void {
    const undo = this.root.querySelector<HTMLButtonElement>('[data-role="undo"]');
    const redo = this.root.querySelector<HTMLButtonElement>('[data-role="redo"]');
    if (undo) {
      undo.disabled = !this.canUndo();
      const title = this.undoTitle();
      if (t(title)) undo.title = title;
    }
    if (redo) {
      redo.disabled = !this.canRedo();
      const title = this.redoTitle();
      if (t(title)) redo.title = title;
    }
  }

  private undo(): void {
    // One ⌘Z, two layers. Which one is decided by what was done last, not by which panel has
    // focus — the player is undoing "the last thing I did", not "the last thing I did here".
    if (this.historyIndex >= 0 && this.history[this.historyIndex] === 'perf') {
      this.historyIndex--;
      this.perfIndex = Math.max(0, this.perfIndex - 1);
      // Both halves of the step, or undoing a cut would put the notes back and leave the tape
      // still cut — see `perfCuts`.
      this.setPerformance(this.perfStack[this.perfIndex], this.perfCuts[this.perfIndex] ?? NO_CUTS);
      this.refreshUndoRedo();
      return;
    }

    const ctx = this.editContext();
    if (!ctx) return;
    if (this.historyIndex >= 0) this.historyIndex--;
    const result = this.undoStack.undo(ctx);
    // The cursor moves whenever the stack's does — which UndoStack does on any non-empty
    // stack, whether or not the action found anything left to undo.
    if (this.editCursor >= 0) {
      this.editCursor--;
      this.scheduleSave();
    }
    this.applyResult(result, null);
    this.refreshUndoRedo();
  }

  private redo(): void {
    if (this.historyIndex < this.history.length - 1 && this.history[this.historyIndex + 1] === 'perf') {
      this.historyIndex++;
      this.perfIndex = Math.min(this.perfStack.length - 1, this.perfIndex + 1);
      this.setPerformance(this.perfStack[this.perfIndex], this.perfCuts[this.perfIndex] ?? NO_CUTS);
      this.refreshUndoRedo();
      return;
    }

    const ctx = this.editContext();
    if (!ctx) return;
    if (this.historyIndex < this.history.length - 1) this.historyIndex++;
    const result = this.undoStack.redo(ctx);
    if (this.editCursor < this.editLog.length - 1) {
      this.editCursor++;
      this.scheduleSave();
    }
    this.applyResult(result, null);
  }

  // =========================================================================
  // Export — the bar itself lives in ui/exportBar.ts
  // =========================================================================

  private baseName(): string {
    return (this.runtime.get().source?.name ?? 'riff').replace(/\.[^.]+$/, '');
  }

  // =========================================================================
  // Chrome
  // =========================================================================

  /**
   * A short, offline-readable licence summary. The detailed notice is part of the embedded
   * web bundle too; opening it here never depends on a browser or an internet connection.
   */
  private showAboutDialog(): void {
    let loadedNotices = false;
    const notices = el('pre', {
      class: 'legal-notices',
      hidden: true,
      tabindex: '0',
      'aria-label': 'Detailed third-party notices'
    });

    const close = () => overlay.remove();
    const showNotices = async (event: MouseEvent) => {
      event.preventDefault();
      notices.hidden = false;
      if (!loadedNotices) {
        notices.textContent = 'Loading bundled notices…';
        try {
          const response = await fetch('./THIRD_PARTY_NOTICES.txt');
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          notices.textContent = await response.text();
          loadedNotices = true;
        } catch {
          notices.textContent = 'The detailed notice could not be displayed. It is also included as THIRD_PARTY_NOTICES.txt in the Riffsheet application bundle.';
        }
      }
      notices.focus();
    };

    const overlay = el(
      'div',
      {
        class: 'modal-backdrop',
        'data-role': 'about-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'about-title',
        onClick: (event: MouseEvent) => {
          if (event.target === overlay) close();
        },
        onKeydown: (event: KeyboardEvent) => {
          if (event.key === 'Escape') close();
        }
      },
      el(
        'section',
        { class: 'about-card' },
        el(
          'header',
          {},
          el('div', {}, el('h2', { id: 'about-title', text: 'Riffsheet' }), el('p', { class: 'dim', text: 'Music transcription and score editing' })),
          el('button', { class: 'ghost icon', text: '✕', 'aria-label': 'Close About and licenses', onClick: close })
        ),
        el('p', { text: 'Copyright © 2026 Oğuzhan Yazıcı.' }),
        el(
          'p',
          {},
          'Riffsheet is free software licensed under the ',
          el('strong', { text: 'GNU Affero General Public License, version 3 only (AGPL-3.0-only)' }),
          '. The matching public source release contains the complete source and full license text.'
        ),
        el('h3', { text: 'Included work' }),
        el(
          'ul',
          { class: 'legal-components' },
          el('li', {}, el('strong', { text: 'Notation pipeline' }), ' — GPL-3.0-only; includes MuseScore-derived work.'),
          el('li', {}, el('strong', { text: 'alphaTab' }), ' — MPL-2.0; notation rendering.'),
          el('li', {}, el('strong', { text: 'JUCE' }), ' — used under its AGPLv3 option for the native application.'),
          el('li', {}, el('strong', { text: 'Bravura' }), ' — SIL Open Font License 1.1.'),
          el('li', {}, el('strong', { text: 'Playback samples' }), ' — FluidR3 GM (MIT) and VCSL (CC0 1.0).')
        ),
        el(
          'p',
          { class: 'legal-note dim' },
          'Audiveris is optional and separately installed. MuScriptor model weights are not bundled and retain their separate terms.'
        ),
        el('h3', { text: 'Support the makers' }),
        el(
          'p',
          { class: 'dim' },
          'Three of the projects Riffsheet is built on ask for money. The others either have no way to take it or have decided not to, so those lines say what helps instead.'
        ),
        el(
          'div',
          { 'data-role': 'support-makers' },
          supportGroup(null, SUPPORT_PRIMARY),
          supportGroup('Further upstream', SUPPORT_UPSTREAM),
          supportGroup('Cite the paper or star the repo', SUPPORT_RESEARCH),
          supportGroup('Licences, not donations', SUPPORT_LICENSED)
        ),
        el('a', {
          class: 'legal-notice-link',
          href: './THIRD_PARTY_NOTICES.txt',
          text: 'Read detailed bundled notices',
          onClick: showNotices
        }),
        notices
      )
    );

    this.root.appendChild(overlay);
    (overlay.querySelector('[aria-label="Close About and licenses"]') as HTMLButtonElement | null)?.focus();
  }

  private toggleSettings(force?: boolean): void {
    const open = force ?? !this.runtime.get().settingsOpen;
    this.runtime.set({ settingsOpen: open });
    this.ensureSettingsPanel().setOpen(open);
  }

  /**
   * The settings panel, built on first use.
   *
   * It used to be created only by `renderMain()`, which was fine while the gear was the only
   * way in. The engine setup banner is on the OPENING screen — the screen somebody with no
   * engine installed is looking at — and from there `this.settingsPanel` was still null, so
   * the button did nothing at all.
   */
  private ensureSettingsPanel(): SettingsPanel {
    if (!this.settingsPanel) {
      this.settingsPanel = new SettingsPanel({
        settings: this.settings,
        runtime: this.runtime,
        onRebuild: () => this.rebuildNotation(),
        onViewChange: () => this.onViewSettingsChanged(),
        onClose: () => this.toggleSettings(false),
        // Pressing "Use this engine" on a card is the same gesture as pressing a chip on the
        // main menu, and it must have the same consequence — see `chooseEngine()`. The panel
        // closes on the way, because what happens next is a transcription of the sheet the
        // panel is covering.
        onChooseEngine: async (id: string) => {
          this.toggleSettings(false);
          return this.chooseEngine(id);
        }
      });
    }
    return this.settingsPanel;
  }

  /**
   * Open Settings on the Engine setup group, and put it in front of the player.
   *
   * With an engine id it scrolls to THAT card instead of to the top of the group — which is
   * what a "· install" chip on the main menu needs, since the card is where the Install button
   * and the reason it is not installed both live. The cards are drawn by the panel's own poll,
   * so the card may not exist for a tick; falling back to the group means the player always
   * lands somewhere useful rather than nowhere.
   */
  private openEngineSetup(engineId?: string): void {
    this.toggleSettings(true);
    // After the panel has drawn: the group is built by the same render `setOpen(true)` kicks
    // off, so scrolling before that has nothing to scroll to.
    const scroll = () => {
      const card = engineId
        ? document.querySelector(`[data-role="engine-card"][data-engine-id="${CSS.escape(engineId)}"]`)
        : null;
      (card ?? document.querySelector('[data-role="engine-setup-group"]'))?.scrollIntoView({
        block: 'start',
        behavior: 'smooth'
      });
      return !!card;
    };
    window.setTimeout(() => {
      // One retry after the panel's first engine poll has had a moment to land, and only when
      // a card was actually asked for and not found.
      if (!scroll() && engineId) window.setTimeout(scroll, 400);
    }, 0);
  }

  private showProgressOverlay(parent: HTMLElement): void {
    parent.appendChild(
      el(
        'div',
        { class: 'progress-overlay', 'data-role': 'progress' },
        el('div', {
          text: stageText(this.runtime.get().progressStage, this.runtime.get().progressQueuePosition),
          'data-role': 'progress-stage'
        }),
        el('div', { class: 'progress-bar' }, el('i', { 'data-role': 'progress-bar' })),
        el('div', { class: 'progress-note', 'data-role': 'progress-eta' }),
        el('div', { class: 'progress-note', text: 'You can play the original while you wait.' }),
        // Waiting for another Riffsheet is a wait you must be able to walk away from.
        this.bridge.transcribeCancel &&
          el('button', {
            text: 'Stop waiting',
            'data-role': 'progress-cancel',
            onClick: () => {
              void this.bridge.transcribeCancel?.();
              this.runtime.set({ progress: null, progressEtaSec: null, progressQueuePosition: 0 });
              this.updateProgressUi();
            }
          })
      )
    );
    this.updateProgressUi();
  }

  private updateProgressUi(): void {
    const rt = this.runtime.get();
    const overlay = this.root.querySelector<HTMLElement>('[data-role="progress"]');
    if (!overlay) return;
    if (rt.progress === null) {
      overlay.remove();
      return;
    }
    const bar = overlay.querySelector<HTMLElement>('[data-role="progress-bar"]');
    if (bar) bar.style.width = `${Math.round(rt.progress * 100)}%`;
    const stage = overlay.querySelector<HTMLElement>('[data-role="progress-stage"]');
    if (stage) stage.textContent = stageText(rt.progressStage, rt.progressQueuePosition);
    const eta = overlay.querySelector<HTMLElement>('[data-role="progress-eta"]');
    if (eta) {
      // While queued there is nothing honest to say about how long it will take — the answer
      // depends on somebody else's recording. Say what is actually happening instead.
      eta.textContent =
        rt.progressStage === 'queued'
          ? 'The engine can only listen to one recording at a time.'
          : etaText(rt.progressEtaSec);
    }
  }

  private toastLayer(): HTMLElement {
    const dismiss = (id: number) => {
      this.runtime.set({ toasts: this.runtime.get().toasts.filter((x) => x.id !== id) });
      this.refreshToasts();
    };
    return el(
      'div',
      { class: 'toasts', 'aria-live': 'polite' },
      ...this.runtime.get().toasts.map((toast) =>
        el(
          'div',
          { class: `toast ${toast.kind}` },
          el(
            'div',
            {},
            el('strong', { text: toast.title }),
            el('div', { text: toast.message }),
            // A NOTICE THAT CAN BE ACTED ON. Some of these say something the player would
            // immediately want to do something about — "the listener is still running and
            // holding 1.5 GB" being the one this was built for — and until now the only
            // control on a toast was the one that made it go away.
            toast.action &&
              el('button', {
                class: 'chip toast-action',
                text: toast.action.label,
                'data-role': toast.action.role,
                onClick: () => {
                  dismiss(toast.id);
                  toast.action?.run();
                }
              })
          ),
          el('button', {
            text: '✕',
            'aria-label': 'Dismiss',
            onClick: () => dismiss(toast.id)
          })
        )
      )
    );
  }

  private refreshToasts(): void {
    this.root.querySelector('.toasts')?.replaceWith(this.toastLayer());
  }

  private toast(
    kind: 'info' | 'danger',
    title: string,
    message: string,
    action?: { label: string; role: string; run: () => void }
  ): void {
    const id = ++this.toastId;
    this.runtime.set({ toasts: [...this.runtime.get().toasts, { id, kind, title, message, action }] });
    this.refreshToasts();
    // Errors stay until acknowledged; info fades. That split proved right in Basscribe.
    if (kind === 'info') {
      setTimeout(() => {
        this.runtime.set({ toasts: this.runtime.get().toasts.filter((x) => x.id !== id) });
        this.refreshToasts();
      }, 4500);
    }
  }

  private installGlobalHandlers(): void {
    // Window-wide drop, so a file dropped anywhere works — and so the browser never
    // navigates away to the dropped file, which is what happens without preventDefault.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) void this.openDroppedFile(file);
    });

    window.addEventListener('keydown', (e) => {
      const inField = e.target instanceof HTMLElement && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
        return;
      }
      if (e.key === ' ' && !inField) {
        e.preventDefault();
        void this.togglePlayback();
        return;
      }
      // Delete the selected note. The popover's bin button used to be the only way to do this;
      // with the popover gone, the key IS the way, and it has to work whether the note was
      // picked on the sheet, on the tab or on the piano roll.
      //
      // ONE handler must own this key, or a note gets deleted twice. The piano roll listens for
      // Delete itself and emits a performance edit; this listener performed a notation delete on
      // the same note in the same keystroke. With a single selection that was invisible (the
      // second delete found nothing left to remove); with a group selection it would have
      // deleted N notes from the performance AND one more from the notation. So when the roll
      // has the selection and can act on it, this stands aside.
      if ((e.key === 'Backspace' || e.key === 'Delete') && !inField) {
        if (this.pianoRoll?.selectionCount) return;
        const selected = this.runtime.get().selection[0];
        if (!selected) return;
        e.preventDefault();
        this.perform(new DeleteNoteAction(selected), null);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * AUDIO seconds <-> alphaTab ticks.
 *
 * Two things are going on and both used to be got wrong here:
 *
 *  1. alphaTab's internal resolution is its own quarter-note tick count, not the pipeline's
 *     `divisions` (which is 12). The two must not be conflated.
 *  2. Ticks are on the SCORE's clock, which starts at bar 1; `seconds` here is on the
 *     RECORDING's clock, which starts at the top of the file. `originSec` is the difference
 *     — see `scoreOriginSec()` in src/pipeline. It is a required argument and deliberately
 *     not defaulted: v1.1 shipped with it silently missing, and the cursor led the audio,
 *     the waveform and the piano roll by the whole count-in.
 */
/**
 * Are these two time windows the same stretch of recording, to within a clamp?
 *
 * Used by exactly one caller — the roll's `onTimeWindowChange` echo guard — and the tolerance
 * is relative because the only thing it has to separate is "the value we just pushed, come
 * back with the roll's own clamping on it" from "the player turned a zoom notch", and a notch
 * is a fifth of the span. Absolute seconds would be wrong at both ends of the zoom range.
 */
function sameTimeWindow(a: { fromSec: number; toSec: number }, b: { fromSec: number; toSec: number }): boolean {
  const span = a.toSec - a.fromSec;
  if (!(span > 0)) return false;
  const slack = span * 0.02;
  return Math.abs(a.fromSec - b.fromSec) < slack && Math.abs(a.toSec - b.toSec) < slack;
}

function secondsToTick(score: RiffScore, audioSec: number, originSec: number): number {
  return (((audioSec - originSec) * score.tempoBpm) / 60) * ALPHATAB_QUARTER_TICKS;
}

function tickToSeconds(score: RiffScore, tick: number, originSec: number): number {
  return (tick / ALPHATAB_QUARTER_TICKS) * (60 / score.tempoBpm) + originSec;
}

/**
 * A roll gesture, written back into a take that has cuts in it (F16).
 *
 * `mergeEditedOntoRaw` cannot do this job and must not be taught to: it rebuilds the take out
 * of the FEED, keeping the edited position of the named notes and taking every other note from
 * the recording. On an un-cut take the two lists hold the same notes and that is exactly right.
 * On a cut take the feed is missing every note whose attack the player removed, so rebuilding
 * from it would delete them — turning a non-destructive cut into a destructive one, one drag
 * later, silently.
 *
 * So this walks the RECORDING instead and writes into it:
 *
 *   - a note the gesture NAMED takes the gesture's times, mapped back to audio seconds;
 *   - a named note the gesture no longer has is one it deleted, and it goes;
 *   - everything else — including every note under a cut — is left exactly as recorded;
 *   - a note the gesture INVENTED is appended, on the audio clock like the rest.
 *
 * Mapping a time back through `editedToAudioSec` resolves a seam FORWARD, so a note dragged to
 * end exactly where a cut begins is recorded as ending where the cut ENDS. That is the answer
 * that survives the cut being undone — the note comes back whole — and the alternative would
 * have the note shrink permanently the moment the player restored the tape it was pinned to.
 */
function mergeRollEditOntoCutTake(
  raw: ReadonlyArray<InputNote>,
  edited: ReadonlyArray<InputNote>,
  touched: ReadonlySet<string>,
  cuts: ReadonlyArray<CutSpan>
): InputNote[] {
  const editedById = new Map<string, InputNote>();
  for (const n of edited) if (n.id) editedById.set(n.id, n);
  const toAudio = (n: InputNote): InputNote => ({
    ...n,
    startSec: editedToAudioSec(n.startSec, cuts),
    endSec: editedToAudioSec(n.endSec, cuts)
  });

  const out: InputNote[] = [];
  const kept = new Set<string>();
  for (const n of raw) {
    const id = n.id;
    if (id && touched.has(id)) {
      const e = editedById.get(id);
      kept.add(id);
      if (e) out.push(toAudio(e));
      continue;
    }
    out.push(n);
    if (id) kept.add(id);
  }
  for (const n of edited) {
    if (n.id && !kept.has(n.id)) out.push(toAudio(n));
  }
  out.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  return out;
}

/**
 * The WRITTEN second of the score's first sounding note — half of F13's origin.
 *
 * Read off the IR rather than off the live alphaTab graph, because this is asked during
 * `rebuildNotation` before the graph exists, and because the IR's ticks are the same ones
 * `scoreOriginSec()` measures the bar-1 anchor in. Written second 0 is IR tick 0, which is what
 * makes `bar.startTick + beat.startTick` directly convertible — the same relation
 * `scoreOriginSec()` relies on when it subtracts the pickup out of `barOneSec`.
 *
 * Rests are skipped: a bar of silence engraved before the music is not an attack, and pinning
 * the clocks to it would put the origin a bar out. Returns null when nothing is engraved yet,
 * which is `alignOriginSec`'s signal to fall back.
 */
function firstWrittenSecOf(score: RiffScore): number | null {
  const divisions = score.ir?.divisions || score.divisions || 24;
  const secPerTick = 60 / (score.tempoBpm || 100) / divisions;
  let firstTick: number | null = null;
  for (const bar of score.ir?.bars ?? []) {
    // Bars are in order, so the first bar carrying a note settles it — but `startTick` is
    // read rather than assumed, so an IR that ever stops being ordered cannot silently lie.
    for (const voice of bar.voices ?? []) {
      for (const beat of voice.beats ?? []) {
        if (beat.isRest || (beat.notes?.length ?? 0) === 0) continue;
        const tick = bar.startTick + beat.startTick;
        if (!Number.isFinite(tick)) continue;
        if (firstTick === null || tick < firstTick) firstTick = tick;
        // Nothing earlier can be in this bar, and later bars start later.
        break;
      }
    }
    if (firstTick !== null) break;
  }
  return firstTick === null ? null : firstTick * secPerTick;
}

/**
 * The score as scheduleable notes for the MIDI side of the fader.
 *
 * Read off the same alphaTab data the screen is drawn from, so what you hear cannot
 * disagree with what you see — and shifted onto the recording's clock by `originSec`,
 * because the transport that schedules them is counting recording seconds. The cursor and
 * these notes have to move together: shift one without the other and the MIDI voice starts
 * disagreeing with the sheet instead of with the audio.
 */
/**
 * What the MIDI side of the fader actually plays.
 *
 * TWO CLOCKS LIVE IN A TRANSCRIPTION AND THIS FUNCTION IS WHERE THEY MEET.
 *
 *   THE ENGRAVING is what the sheet shows: quantized note values on a metric grid. Reading it
 *   off the live alphaTab model is what makes playback agree with the notation edits the
 *   player has made — a pitch dragged on the staff mutates that model, and nothing else knows
 *   about it — and it is what groups the fragments of a tied note back into one sounding note.
 *
 *   THE PERFORMANCE is `source.detected.notes`: the seconds the engine actually reported,
 *   which is what the player played. It carries no pitch edits and no ties.
 *
 * Until now playback used the engraving for BOTH pitch and time, and that is what "the
 * playback sounds robotic" was. Measured on this repository's own triplet fixture with
 * ordinary human timing applied (±15 to ±40 ms), the engraved attack sits a median of 7 to 26
 * ms and as much as 77 ms away from the note that was played — every note nudged onto a grid
 * line, which is the definition of mechanical. The MIDI the export button writes by default is
 * the AS-PLAYED variant, so it has none of that, and it is exactly why the same take dragged
 * into a DAW and played through somebody else's sampler sounds fine while the app does not.
 *
 * So: PITCH, IDENTITY, VELOCITY AND TIE GROUPING FROM THE ENGRAVING, TIMING FROM THE
 * PERFORMANCE. Every property the sampler depends on is untouched — this only replaces two
 * numbers per note, and only for notes the performance actually knows about.
 *
 * Three things are deliberately left engraved:
 *   - a note the player DREW on the sheet, which the performance has never heard of;
 *   - a symbolic import (MIDI, MusicXML, Guitar Pro), where `sourceTiming` says the written
 *     ticks ARE the truth and there is no performance behind them to prefer;
 *   - anything whose as-played span came out degenerate, which would cost the note its attack.
 */

function scoreToSynthNotes(
  score: RiffScore,
  originSec: number,
  live: PianoRollLiveModel | null = null,
  performance: ReadonlyArray<InputNote> | null = null
): Array<{ startSec: number; endSec: number; midi: number; velocity?: number }> {
  type Scheduled = { id?: string; startSec: number; endSec: number; midi: number; velocity?: number };
  const out: Scheduled[] = [];
  const byId = new Map<string, Scheduled>();

  /** The shortest as-played span worth preferring. Below it, keep what was engraved. */
  const MIN_AS_PLAYED_SEC = 0.03;

  const retime = (notes: Scheduled[]): Array<{ startSec: number; endSec: number; midi: number; velocity?: number }> => {
    if (performance) {
      const played = new Map<string, { startSec: number; endSec: number }>();
      for (const n of performance) {
        // `sourceTiming` marks a note whose written ticks are its source of truth. Preferring
        // reconstructed seconds there would fight the one path in the pipeline that is exact.
        if (!n.id || n.sourceTiming) continue;
        played.set(n.id, { startSec: n.startSec, endSec: n.endSec });
      }
      for (const s of notes) {
        const p = s.id ? played.get(s.id) : undefined;
        if (!p || p.endSec - p.startSec < MIN_AS_PLAYED_SEC) continue;
        s.startSec = p.startSec;
        s.endSec = p.endSec;
      }
    }
    // Re-sorted AFTER retiming: the performance can legitimately reorder two notes the grid
    // had rounded onto the same beat, and everything downstream reads this in time order.
    notes.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
    return notes.map(({ startSec, endSec, midi, velocity }) =>
      velocity === undefined ? { startSec, endSec, midi } : { startSec, endSec, midi, velocity }
    );
  };

  // Every engraved fragment of one held source note carries the same stable id. Coalescing
  // by that id extends ties through their final destination while keeping real simultaneous
  // notes separate (they have different ids).
  const add = (id: string | undefined, fragment: Scheduled): void => {
    const held = id ? byId.get(id) : undefined;
    if (held) {
      held.startSec = Math.min(held.startSec, fragment.startSec);
      held.endSec = Math.max(held.endSec, fragment.endSec);
      held.midi = fragment.midi;
      if (fragment.velocity !== undefined) held.velocity = fragment.velocity;
      return;
    }
    out.push(fragment);
    if (id) byId.set(id, fragment);
  };

  if (live) {
    const secPerTick = 60 / score.tempoBpm / ALPHATAB_QUARTER_TICKS;
    for (const track of live.model.tracks) {
      for (const staff of track.staves) {
        for (const bar of staff.bars) {
          for (const voice of bar.voices) {
            for (const beat of voice.beats) {
              if (beat.isEmpty || beat.notes.length === 0) continue;
              const startSec = beat.absolutePlaybackStart * secPerTick + originSec;
              const endSec = startSec + beat.playbackDuration * secPerTick;
              for (const note of beat.notes) {
                const info = live.index.noteToInfo.get(note);
                add(info?.id, {
                  ...(info?.id !== undefined ? { id: info.id } : {}),
                  startSec,
                  endSec,
                  midi: soundingMidi(live.index, note),
                  ...(info?.velocity !== undefined ? { velocity: info.velocity } : {})
                });
              }
            }
          }
        }
      }
    }
    return retime(out);
  }

  // The live graph is unavailable only during early boot. Keep that path correct too.
  const secPerTick = 60 / score.tempoBpm / score.divisions;
  const barStart = new Map<number, number>();
  for (const mb of score.data.masterBars) barStart.set(mb.index, mb.startTick);
  for (const track of score.data.tracks) {
    for (const staff of track.staves) {
      for (const bar of staff.bars) {
        const base = barStart.get(bar.index) ?? 0;
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            if (beat.isEmpty || beat.notes.length === 0) continue;
            const startSec = (base + beat.startTick) * secPerTick + originSec;
            const endSec = startSec + beat.durTicks * secPerTick;
            for (const note of beat.notes) {
              add(note.id, {
                ...(note.id !== undefined ? { id: note.id } : {}),
                startSec,
                endSec,
                midi: note.midi,
                // RAW MIDI VELOCITY, not alphaTab's DynamicValue enum. `ScoreSynth` divides it
                // by 127 exactly once; converting it here would destroy the level. This was
                // diagnosed wrongly once and the diagnosis was withdrawn — do not redo it.
                ...(note.dynamics !== undefined ? { velocity: note.dynamics } : {})
              });
            }
          }
        }
      }
    }
  }
  return retime(out);
}

/** A plausible-looking envelope for the demo's waveform strip. Not audio — a drawing. */
function synthPeaks(
  notes: InputNote[],
  totalSec: number,
  buckets: number
): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const at = (b / buckets) * totalSec;
    let amp = 0;
    for (const n of notes) {
      if (at < n.startSec || at > n.startSec + 0.45) continue;
      amp = Math.max(amp, 0.85 * Math.exp(-(at - n.startSec) * 7));
    }
    const jitter = amp * (0.55 + 0.45 * Math.abs(Math.sin(b * 12.9898)));
    max[b] = jitter;
    min[b] = -jitter;
  }
  return { min, max };
}

/**
 * The DAW's grid as measured during a capture — bar lines and all.
 *
 * The strong form: the shell wrote the host's playhead down block by block while the take was
 * rolling, so these bar starts are where the DAW's bar lines actually fell inside this
 * recording. Nothing is inferred and nothing is defaulted — a host that reported no tempo
 * yields no grid rather than a plausible one.
 */
function toHostGrid(ctx: CaptureContext | undefined): SourceAudio['hostGrid'] {
  if (!ctx || !(ctx.hostBpm > 0)) return undefined;
  return {
    hostBpm: ctx.hostBpm,
    hostTimeSig: ctx.hostTimeSig,
    ...(ctx.barStartsSec?.length ? { barStartsSec: ctx.barStartsSec } : {}),
    source: 'capture'
  };
}

/**
 * The DAW's grid as it stands RIGHT NOW, for audio that was not captured here.
 *
 * The weak form, and the fix for the reported bug. Until now "synced to DAW grid" only existed
 * for a captured take, so a wav dropped onto the plugin had nowhere to get a tempo from and the
 * sheet fell back to whatever it could hear — the user set REAPER to 222 BPM in 3/6 and got a
 * sheet at 102 in 4/4, with a chip on screen implying otherwise.
 *
 * What this knows: the tempo and the meter. What it does NOT know: where the file sits on the
 * DAW's timeline, so it supplies no bar starts and the pipeline lays the grid down from the
 * bar-1 marker instead. That is the honest reading of "use my DAW's tempo".
 */
function liveHostGrid(host: HostInfo | null): SourceAudio['hostGrid'] {
  if (!host?.isPlugin || !host.hasHostTimeline) return undefined;
  if (typeof host.bpm !== 'number' || !(host.bpm > 0)) return undefined;
  // No time signature from the host is not a reason to invent 4/4 — but it is also not a
  // reason to throw away a perfectly good tempo, so 4/4 is used and `hostTimeSigKnown` on the
  // chip says which half is real. (The shell reports nulls, never zeros, precisely so this
  // distinction survives — see bridge/juce.ts toHostTimeline.)
  return {
    hostBpm: host.bpm,
    hostTimeSig: host.timeSignature ?? { numerator: 4, denominator: 4 },
    source: 'host'
  };
}

/**
 * The QUANTIZE menu's words. The control is named for what it does to the page — round it —
 * rather than for the part of the app it lives on, which is what "Notation" was naming.
 *
 * 'Triplet (1/12)' rather than 'Triplet': a triplet is a division, not a note value, and the
 * one thing somebody comparing it against 1/8 and 1/16 needs to know is how FINE it is. An
 * eighth-note triplet divides the beat in three, so its cell is a twelfth of a bar in 4/4 —
 * finer than 1/8 and coarser than 1/16, which is exactly where the number puts it in the list.
 */
const GRID_LABELS: Record<AppSettings['grid'], string> = {
  auto: 'Auto',
  quarter: '1/4',
  eighth: '1/8',
  sixteenth: '1/16',
  thirtysecond: '1/32',
  triplet: 'Triplet (1/12)',
  free: 'Free'
};

/** The roll's ruler has no 'auto': a cell has to be a stated size to draw a note into. */
const ROLL_GRID_LABELS: Record<AppSettings['rollGrid'], string> = {
  quarter: '1/4',
  eighth: '1/8',
  sixteenth: '1/16',
  triplet: 'Triplet',
  free: 'Free'
};

/**
 * What "Auto" actually came out as, said in the option itself.
 *
 * A picker sitting on Auto tells you nothing about the page you are looking at, and "is this
 * in G or has it just not decided?" is the whole question somebody opens this control to
 * answer. The major name alone — the pair is in every other option and would not fit here.
 */
function autoKeyLabel(score: RiffScore | null): string {
  const fifths = score?.ir.key?.fifths;
  const found = KEY_OPTIONS.find(([value]) => value === fifths)?.[1];
  return found ? `Key: Auto — ${found.split(' / ')[0]}` : 'Key: Auto';
}

const KEY_OPTIONS: ReadonlyArray<readonly [number, string]> = [
  [-7, 'C♭ major / A♭ minor'],
  [-6, 'G♭ major / E♭ minor'],
  [-5, 'D♭ major / B♭ minor'],
  [-4, 'A♭ major / F minor'],
  [-3, 'E♭ major / C minor'],
  [-2, 'B♭ major / G minor'],
  [-1, 'F major / D minor'],
  [0, 'C major / A minor'],
  [1, 'G major / E minor'],
  [2, 'D major / B minor'],
  [3, 'A major / F♯ minor'],
  [4, 'E major / C♯ minor'],
  [5, 'B major / G♯ minor'],
  [6, 'F♯ major / D♯ minor'],
  [7, 'C♯ major / A♯ minor']
];

function field(label: string, control: HTMLElement): HTMLElement {
  return el('label', {}, el('span', { text: label }), control);
}

function titleCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function resizeTuning(current: number[], requested: number): number[] {
  const count = Math.max(2, Math.min(12, Math.round(requested) || current.length));
  let notes = [...current].sort((a, b) => a - b);
  while (notes.length < count) notes.unshift(Math.max(0, notes[0] - 5));
  if (notes.length > count) notes = notes.slice(notes.length - count);
  return notes;
}

/**
 * The time signatures the picker offers: the usual ones, plus whatever the sheet is in.
 *
 * A DAW can hand over a meter nobody would have put in a list — the user's own reproduction
 * case was 3/6 — and a `<select>` that cannot represent its own value silently snaps to the
 * first option, which reads as the app having thrown the DAW's answer away.
 */
/**
 * The note that gets one beat in this signature: its glyph, its name, and how many fit in a
 * quarter.
 *
 * ONE FUNCTION FOR ALL THREE, because they are one fact and splitting them is how a label
 * ends up disagreeing with the number beside it. That is not hypothetical: a DAW really does
 * hand us meters like 3/6 (the user's own reproduction case), and a version of this that
 * scaled by `denominator / 4` unconditionally while only naming a glyph for 1, 2, 4, 8 and 16
 * would have printed a quarter-note glyph next to a number multiplied by one and a half.
 *
 * So the rule is: a denominator this can NAME is one it scales by, and a denominator it
 * cannot name is left in quarters — which is the unit `tempoBpm` is stored in, so the pair
 * stays true rather than blank or invented.
 *
 * Textbook reading of the denominator otherwise: /4 counts quarters, /8 counts eighths, /2
 * counts halves. Compound meters are the known simplification — 6/8 is usually FELT in dotted
 * quarters, and this calls its beat the eighth, which is what the signature literally says and
 * what a metronome mark in 6/8 is normally written against. Being literal is the right kind of
 * wrong here: it is the reading somebody can check against the number on screen.
 */
function beatUnit(sig: { numerator: number; denominator: number } | undefined): {
  glyph: string;
  name: string;
  perQuarter: number;
} {
  switch (sig?.denominator) {
    case 1:
      return { glyph: '𝅝', name: 'whole note', perQuarter: 0.25 };
    case 2:
      return { glyph: '𝅗𝅥', name: 'half note', perQuarter: 0.5 };
    case 8:
      return { glyph: '♪', name: 'eighth note', perQuarter: 2 };
    case 16:
      return { glyph: '𝅘𝅥𝅯', name: 'sixteenth note', perQuarter: 4 };
    default:
      return { glyph: '♩', name: 'quarter note', perQuarter: 1 };
  }
}

function timeSigOptions(current: { numerator: number; denominator: number } | undefined): string[] {
  const presets = ['4/4', '3/4', '6/8', '5/4', '7/8', '12/8'];
  if (!current) return presets;
  const label = `${current.numerator}/${current.denominator}`;
  return presets.includes(label) ? presets : [label, ...presets];
}

/** What the DAW-grid chip says about itself, in the fewest words that are still true. */
function describeHostGrid(grid: NonNullable<SourceAudio['hostGrid']>): string {
  const sig = `${grid.hostTimeSig.numerator}/${grid.hostTimeSig.denominator}`;
  const bpm = Math.round(grid.hostBpm);
  // A capture knows where the bar lines fell; the live tempo does not, and saying so is the
  // difference between a promise the app keeps and one it cannot.
  return grid.source === 'capture' ? `${bpm} · ${sig} · bar lines` : `${bpm} · ${sig} · tempo only`;
}

/**
 * What the progress overlay says it is doing.
 *
 * The 'queued' case is the one that matters: MuScriptor is a single Python process that
 * listens to one recording at a time and eats about a gigabyte, so a second Riffsheet in the
 * same project has to wait its turn. Before the queue existed, that second plugin either got
 * a bare "busy with another job" or simply sat there. Naming the wait — and saying how many
 * are ahead — is the difference between waiting and looking broken.
 */
function stageText(stage: string, queuePosition: number): string {
  if (stage === 'queued') {
    return queuePosition > 1
      ? `Waiting for another Riffsheet to finish — ${queuePosition - 1} ahead of you…`
      : 'Waiting for another Riffsheet to finish — you are next…';
  }
  return stage === 'writing' ? 'Writing the notes…' : 'Listening to your playing…';
}

function etaText(eta: number | null): string {
  if (eta === null) return '';
  if (eta < 1.5) return 'Almost there…';
  if (eta < 60) return `About ${Math.ceil(eta)} seconds left`;
  return `About ${Math.ceil(eta / 60)} minutes left`;
}

/**
 * djb2, as an unsigned 32-bit hex string.
 *
 * Not a checksum with any security property — a short, stable way to say "these two score
 * states are the same one" in a test report, where printing every note would be unreadable.
 */
function hashString(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function relativeTime(at: number): string {
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

// ---------------------------------------------------------------------------
// Support the makers
// ---------------------------------------------------------------------------

/**
 * One upstream, and the truth about whether it takes money.
 *
 * `money: true` means the href IS that project's own funding channel, taken from their own
 * site. `money: false` means no such channel exists — either the project has none, or it has
 * looked at the question and said no — and the row then carries the support that is actually
 * available instead. The distinction is load-bearing rather than cosmetic: pointing a payment
 * link at a project that declined donations would be putting words in their mouth, so the
 * harness asserts that no `money: false` row ever grows a wallet link.
 */
interface SupportEntry {
  id: string;
  name: string;
  /** What of theirs is in Riffsheet, in one clause. */
  what: string;
  money: boolean;
  href?: string;
  linkText?: string;
  /** The condition on the money, or the honest alternative to it. */
  note?: string;
}

/**
 * Checked against each project's OWN funding declaration, not against a package registry's
 * guess. Three channels exist. The rest of this list is here precisely because it does not
 * have one, and a credits screen that quietly omitted them would read as if it did.
 */
const SUPPORT_PRIMARY: readonly SupportEntry[] = [
  {
    id: 'versilian',
    name: 'Versilian Studios',
    what: 'the upright piano and marimba you hear',
    money: true,
    href: 'https://paypal.me/versilian',
    linkText: 'paypal.me/versilian',
    note: 'Write “VCSL” in the payment description. Their instruction, and how the money reaches that library.'
  },
  {
    id: 'musescore',
    name: 'MuseScore',
    what: 'the engraving rules the notation pipeline owes most to',
    money: false,
    href: 'https://musescore.org/en/contribute',
    linkText: 'musescore.org/en/contribute',
    note: 'They decline money outright: “The most valuable donation you can give us is your time.”'
  },
  {
    id: 'alphatab',
    name: 'alphaTab',
    what: 'the renderer behind every stave and every tab number on this screen',
    money: false,
    href: 'https://github.com/CoderLine/alphaTab',
    linkText: 'github.com/CoderLine/alphaTab',
    note: 'No funding channel exists. Starring the repository is the support that is on offer.'
  }
];

/** Dependencies of our dependencies. Both of these do take money. */
const SUPPORT_UPSTREAM: readonly SupportEntry[] = [
  {
    id: 'haxe',
    name: 'Haxe Foundation',
    what: 'the language alphaTab’s engine is built in',
    money: true,
    href: 'https://opencollective.com/haxe',
    linkText: 'opencollective.com/haxe'
  },
  {
    id: 'xiph',
    name: 'Xiph.Org Foundation',
    what: 'the Vorbis codec work inside our audio bundle',
    money: true,
    href: 'https://xiph.org/donate/',
    linkText: 'xiph.org/donate'
  }
];

/** Research and corporate releases. None of them has a donation channel; all of them have a paper. */
const SUPPORT_RESEARCH: readonly SupportEntry[] = [
  {
    id: 'basic-pitch',
    name: 'Basic Pitch',
    what: 'the built-in transcription engine, from Spotify',
    money: false,
    href: 'https://github.com/spotify/basic-pitch',
    linkText: 'github.com/spotify/basic-pitch'
  },
  {
    id: 'beat-this',
    name: 'beat_this',
    what: 'the beat grid, from CPJKU at JKU Linz',
    money: false,
    href: 'https://github.com/CPJKU/beat_this',
    linkText: 'github.com/CPJKU/beat_this'
  },
  {
    id: 'transkun',
    name: 'Transkun',
    what: 'the piano engine, by Yujia Yan',
    money: false,
    href: 'https://github.com/Yujia-Yan/Transkun',
    linkText: 'github.com/Yujia-Yan/Transkun'
  },
  {
    id: 'muscriptor',
    name: 'MuScriptor',
    what: 'the best-quality engine, by Kyutai and Mirelo',
    money: false,
    href: 'https://pypi.org/project/muscriptor/',
    linkText: 'pypi.org/project/muscriptor'
  },
  {
    id: 'bass-v2',
    name: 'Instrument-Agnostic AMT',
    what: 'the bass engine, by anime-song',
    money: false,
    href: 'https://github.com/anime-song/instrument-agnostic-amt',
    linkText: 'github.com/anime-song/instrument-agnostic-amt'
  }
];

/** Paid for, or given away under a licence. Neither one wants a donation. */
const SUPPORT_LICENSED: readonly SupportEntry[] = [
  {
    id: 'juce',
    name: 'JUCE',
    what: 'the framework the native plugin is built with',
    money: false,
    href: 'https://juce.com/get-juce/',
    linkText: 'juce.com/get-juce',
    note: 'We use the free option. If JUCE earns your money, buy a licence.'
  },
  {
    id: 'bravura',
    name: 'Bravura',
    what: 'Steinberg’s music font, which every glyph on the page is drawn from',
    money: false,
    note: 'No channel to point at. The Open Font License notice above is the whole of it.'
  }
];

/**
 * An outbound link.
 *
 * webcore had no such thing before this screen: the only URLs it held were engine `sourceUrl`
 * strings that nothing rendered. No bridge call is needed either — the JUCE shell already
 * hands http(s) navigation to the system browser, and in a plain browser `target=_blank` is
 * exactly the same gesture. `rel` is set because the WebView shares an origin with the app.
 */
function externalLink(href: string, text: string): HTMLAnchorElement {
  return el('a', {
    class: 'support-link',
    'data-role': 'support-link',
    href,
    // NO `target="_blank"` in the plugin. It reads like the safe choice and it is the reason
    // every one of these links was a dead click there: `_blank` asks the WebView for a new
    // window, which lands in `newWindowAttemptingToLoad`, which the shell does not override —
    // so JUCE drops it and nothing at all happens. Same-frame navigation instead goes through
    // `pageAboutToLoad`, which the shell DOES override: it hands http(s) to the system browser
    // and returns false, so the page never actually leaves.
    //
    // In a plain browser there is no such override, so `_blank` is still what keeps the app
    // from navigating away from itself. `window.__JUCE__` is the same signal bridge/juce.ts
    // uses to decide it is running in the shell.
    ...(inJuceShell() ? {} : { target: '_blank' }),
    rel: 'noreferrer noopener',
    text
  });
}

/** True inside the JUCE WebView. See `externalLink` — the two hosts open a link differently. */
function inJuceShell(): boolean {
  return !!(window as unknown as { __JUCE__?: unknown }).__JUCE__;
}

function supportRow(entry: SupportEntry): HTMLElement {
  return el(
    'li',
    {
      class: 'support-row',
      'data-role': 'support-entry',
      'data-support-id': entry.id,
      'data-support-money': entry.money ? 'yes' : 'no'
    },
    el('strong', { text: entry.name }),
    ` — ${entry.what}.`,
    entry.href && entry.linkText ? el('span', { class: 'support-link-wrap' }, externalLink(entry.href, entry.linkText)) : null,
    entry.note ? el('div', { class: 'support-note dim', text: entry.note }) : null
  );
}

function supportGroup(heading: string | null, entries: readonly SupportEntry[]): HTMLElement {
  return el(
    'div',
    { class: 'support-group' },
    heading ? el('h4', { class: 'support-heading', text: heading }) : null,
    el('ul', { class: 'support-list' }, ...entries.map(supportRow))
  );
}
