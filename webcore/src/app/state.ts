/**
 * Application state.
 *
 * Split by the same rule Basscribe used and which proved right: settings are serializable
 * and persisted; everything else is runtime and never written to disk.
 */

import { createStore, type Store } from '../ui/dom';
import { DEFAULT_TUNING, customTuning, tuningById, type TuningPreset } from '../score/tuning';
import type { InputNote, RiffScore } from '../pipeline';
import { DEFAULT_ROLL_HEIGHT_PX } from '../view/pianoroll';
import type { SynthVoice } from '../audio/synth';
import type { TrimResult } from '../audio/trim';
import type { HostInfo } from '../bridge';

/**
 * The musician-facing vocabulary. Deliberately NOT Team C's enum names — the pipeline
 * speaks 'bass4'/'1\u002f16'/'minMovement', the UI speaks 'bass'/'sixteenth'/'minimize-movement',
 * and src/pipeline/index.ts translates. Keeping them apart means a pipeline rename does
 * not ripple into every settings control.
 */
export type Instrument = 'bass' | 'guitar' | 'auto';
/** What is drawn under the staff. This is deliberately separate from what the listener hears. */
export type TabMode = 'off' | 'bass' | 'guitar' | 'custom';
export type ClefMode = 'auto' | 'treble' | 'bass' | 'grand';
/**
 * TWO GRIDS, AND THEY ARE NOT THE SAME GRID. This is the whole of the split; everything
 * else in this file is bookkeeping for it.
 *
 * `NotationGrid` is the transcription quantizer's brief: the note values the pipeline is
 * allowed to WRITE when it turns a performance into a page. 'auto' is the default and means
 * "work it out" — Team C's Viterbi weighs straight and triplet subdivisions against each
 * other per beat (pipeline/src/quantize.ts §statesFor), which is the only setting that can
 * write an eighth-note triplet and a straight sixteenth in the same bar. Naming a value here
 * is an OVERRIDE: '1/8' forbids the quantizer every state finer or other than an eighth, so a
 * triplet played against it loses its third note. That is the correct behaviour for an
 * override and the wrong behaviour for a default, which is how 16 of the flagship demo's 80
 * notes went missing.
 *
 * `RollGrid` is the piano roll's ruler and its manual-edit unit — where the vertical lines
 * are drawn, what a dragged note snaps to, and how long a hand-added note comes out. It has
 * NO 'auto' because there is nothing to infer: it is a stated size the player is asking new
 * notes to be. And it has no route into the pipeline at all. Changing it must never alter
 * one notehead of a transcription, which is the user's own rule for it: "it was supposed to
 * only help when added a new note manually... if it is transcribing from audio, it should
 * not quantize or snap at all."
 */
export type NotationGrid = 'auto' | 'quarter' | 'eighth' | 'sixteenth' | 'triplet' | 'free';
export type RollGrid = 'quarter' | 'eighth' | 'sixteenth' | 'triplet' | 'free';

/** The stored words each grid accepts. Exported so the UI and `migrate()` cannot drift apart. */
export const NOTATION_GRIDS: readonly NotationGrid[] = [
  'auto',
  'quarter',
  'eighth',
  'sixteenth',
  'triplet',
  'free'
];
export const ROLL_GRIDS: readonly RollGrid[] = ['quarter', 'eighth', 'sixteenth', 'triplet', 'free'];

export type FingeringStyle = 'low-positions' | 'minimize-movement';
/** Which MIDI file(s) the export button writes. Remembered between exports. */
export type MidiExportMode = 'quantized' | 'as-played' | 'both';
export type { TuningPreset };

export interface AppSettings {
  /** Engine-only legacy hint. Engraving must use `tabMode`, never this field. */
  instrument: Instrument;
  tabMode: TabMode;
  tuningId: string;
  /** Open-string MIDI notes, lowest string first, used only while `tabMode === 'custom'`. */
  customTuningMidi: number[];
  clefMode: ClefMode;
  /** The transcription quantizer's brief. Reaches the pipeline; see `NotationGrid`. */
  grid: NotationGrid;
  /**
   * The piano roll's ruler and manual-edit unit. Never reaches the pipeline — deliberately
   * absent from `toBuildSettings()`, and there is a browser check that keeps it that way.
   */
  rollGrid: RollGrid;
  fillGaps: boolean;
  fingering: FingeringStyle;
  /** The playback sound AND the source behind it — see audio/synth.ts §SynthVoice. */
  playbackVoice: SynthVoice;
  midiExportMode: MidiExportMode;
  metronome: boolean;
  showNoteNames: boolean;
  /** The piano-roll strip under the waveform. Owned by view/pianoroll.ts (W1). */
  showPianoRoll: boolean;
  /**
   * How tall that strip is, in px — the player drags its bottom edge.
   *
   * Stored as the height ASKED FOR, not the one in force: a short window clamps it (see
   * `clampRollHeight`) and writing the clamped value back would shrink the pane permanently
   * for anyone who once opened the plugin in a small FX window.
   */
  pianoRollHeight: number;
  /** Name every row in the roll's gutter, not only the octave C's. C's stay emphasised either way. */
  rollAllNoteNames: boolean;
  /**
   * Drag-to-edit on the roll.
   *
   * Roll edits change the PERFORMANCE the sheet is written from, so they re-run the pipeline —
   * see `App.applyRollEdit`. That is what makes "make this note longer" possible at all.
   */
  rollEditing: boolean;
  /**
   * Keep the four views pointing at the same moment.
   *
   * ON — the default — clicking or seeking anywhere (the waveform, the piano roll, the
   * transport) scrolls the sheet to that moment as well, so the page you are reading follows
   * the sound you are pointing at. Selection already crosses all four views and always has.
   *
   * OFF leaves them independent: the sheet stays where you put it and only the playhead moves.
   *
   * WHAT THIS IS NOT, because the name used to mean something else and the difference is the
   * whole reason the old one was removed. It does NOT put the roll on the sheet's x-axis.
   * alphaTab deliberately gives rhythmically dense bars more pixels, so borrowing that
   * geometry made ADDING ONE NOTE widen the space between unrelated notes — the roll reflowed
   * under the player's hand. The roll is a linear time ruler, always, linked or not, and that
   * is not a setting. See view/pianoroll.ts §1.
   */
  alignViews: boolean;
  /**
   * After a transcription, let the app act on its OWN ears where the engine disagreed.
   *
   * The engines merge fast repeated notes — the reported case is two quarter-second hits
   * returned as one half-second note, with the app's own attack detector already drawing a
   * line at the join. With this on, a pass runs client-side after every transcription and
   * Listen again: it divides a note that contains a confirmed internal attack, and writes in a
   * note where the detector and the pitch tracker both say one was played and the engine wrote
   * nothing. Every such edit is HIGHLIGHTED on the piano roll and the waveform until the
   * player has looked at it — never on the sheet or the tab, which show results.
   *
   * With this OFF nothing is edited, but the same detections still appear as highlights. That
   * is deliberate: the useful half of the feature is the app no longer disagreeing with itself
   * in silence, and switching it off should mean "do not touch my notes", not "do not tell me".
   *
   * See `edit/autoEdits.ts` for the guardrails. It refuses far more often than it acts.
   */
  autoSplitAtAttacks: boolean;
  /**
   * Which MuScriptor weights to ask for.
   *
   * 'auto' lets the shell pick the largest set that is both installed and sensible for this
   * machine's memory. The shell reports what it actually resolved to; see `engineStatus()`.
   */
  engineModel: 'auto' | 'small' | 'medium' | 'large';
  /**
   * Which transcription engine listens: 'auto', or a concrete engine id.
   *
   * A free string rather than a union, because the list of engines is compiled into the SHELL
   * and a build of webcore must not be the thing that decides which ones exist. 'auto' resolves
   * on the native side — MuScriptor when it is installed, the built-in Basic Pitch otherwise.
   *
   * THE NATIVE FILE IS THE TRUTH. The choice really lives in `<appSupport>/engine.json`, which
   * is machine-wide and readable from inside a DAW; this is a cache of it so the browser mock
   * has something honest to show and so the opening screen can draw the picker before the
   * shell has answered. `App.start()` adopts the native value on boot when the two disagree.
   */
  engineId: string;
  /**
   * Bring the audio to −12 dBFS peak before handing it to an engine that wants it.
   *
   * A real transformation of the player's audio with an observable effect on the result, which
   * is why it is theirs to switch off. Applied per engine: the manifest says whether an engine
   * needs it, and the ones that normalise internally are left alone. The recording itself is
   * never touched — the shell writes a separate file for the engine and deletes it afterwards.
   */
  normalizeBeforeTranscribe: boolean;
  /**
   * Correct a recording that is not at A440 before handing it to an engine that wants it.
   *
   * Same rule: applied only before engines whose manifest asks for it, only when the estimate
   * is confident, and never in place. Time and pitch move together when you resample, so the
   * shell maps the returned note times back — see engine-architecture.md §7.3.
   */
  correctTuningBeforeTranscribe: boolean;
  maxFret: number;
  capo: number;
  /**
   * Legacy session fields. Tempo and meter now live on SourceAudio so opening one take cannot
   * silently change the next one. They remain optional here only so older blobs can migrate.
   */
  tempoBpm?: number;
  timeSignature?: { numerator: number; denominator: number };
  /** Per-document key override is supplied through an effective settings copy at build time. */
  keyFifths?: number;
  /** Prefer the DAW's grid when the capture supplied one. */
  useHostGrid: boolean;
  /**
   * Track a drifting tempo instead of assuming one steady one.
   *
   * The shell runs a second listening pass for this (BRIDGE.md §3), so it is off by
   * default and only affects the NEXT transcription — changing it does not rebuild the
   * sheet you already have.
   */
  preciseBeats: boolean;
  /**
   * Bumped when a stored default has to be re-defaulted rather than merged. Not a user
   * knob; see `loadSettings()`.
   */
  settingsVersion: number;
}

/** Raise this AND add a case in `migrate()` when a default has to change under people. */
export const SETTINGS_VERSION = 8;

export const DEFAULT_SETTINGS: AppSettings = {
  // 'auto', NOT 'bass'. This is sent to the model as a HARD CONSTRAINT on what it is allowed to
  // report (design notes §2.1), not as a hint — so a recording that is not purely electric bass had
  // to be answered in bass notes anyway, and one very natural way for a model to do that is to
  // drone one low note over and over. That is a live suspect for the phantom repeated notes
  // reported from the field. The project doc has carried the owner's own correction on this for a
  // while ("muscriptor is good at every type so we are not doing just bass-first") and the default
  // never followed it.
  instrument: 'auto',
  tabMode: 'off',
  tuningId: DEFAULT_TUNING.id,
  customTuningMidi: [40, 45, 50, 55, 59, 64],
  clefMode: 'auto',
  // 'auto', NOT a named note value. See `NotationGrid`: a named value is an override that
  // FORBIDS the quantizer everything else, and the one thing a default must never do is
  // forbid a subdivision the player actually played.
  grid: 'auto',
  // A stated size, because a manually added note has to come out some length and 1/8 is the
  // one that makes a riff. It is only ever consulted for hand edits and for drawing the ruler.
  rollGrid: 'eighth',
  fillGaps: true,
  fingering: 'low-positions',
  // Recorded multisamples only; oscillator voices are no longer user-facing choices.
  playbackVoice: 'finger-bass',
  // Dragging the MIDI button onto a DAW track drops THIS variant, and "exactly what I played" is
  // what somebody reaching for a drag almost always means — they are putting the take back into
  // their session, not filing a tidy chart. The tidied-up one is one click away in the menu.
  midiExportMode: 'as-played',
  metronome: false,
  showNoteNames: true,
  showPianoRoll: true,
  pianoRollHeight: DEFAULT_ROLL_HEIGHT_PX,
  rollAllNoteNames: true,
  rollEditing: true,
  // ON, at the player's explicit request. It was safe to default this on only once the
  // setting stopped meaning "borrow the sheet's geometry": following a moment has no effect on
  // where anything is drawn, so there is no reflow for a default to inflict on anybody.
  alignViews: true,
  // ON. It is the answer to a bug the player can see on their own screen — the waveform draws
  // an attack line inside a note the engine returned whole — and a fix nobody switches on is a
  // fix nobody gets. The guardrails in `edit/autoEdits.ts` are what make that defensible: the
  // pass refuses far more often than it acts, and every edit it does make is highlighted for
  // review rather than slipped in.
  autoSplitAtAttacks: true,
  engineModel: 'auto',
  // 'auto', for the same reason `engineModel` is: the shell knows what is installed on this
  // machine and the page does not. It resolves to MuScriptor when that is here and to the
  // built-in engine when it is not, so a fresh machine works with no setup at all.
  engineId: 'auto',
  // BOTH OFF. They were introduced on, on the reasoning that they are what the models were
  // trained to expect and that neither touches the audio the player hears — and while the
  // shell had not yet applied them, that was true and cost nothing.
  //
  // Once the shell did apply them, every existing take started being mono-downmixed, level
  // shifted, and resampled when the tuning estimate fired, before any engine heard it. The
  // engine therefore answered with different notes than it had that morning, which is what
  // "serious regression in the way how the built in sounds sound" was: not the samples — the
  // notes they were asked to play. Nobody chose that, because the keys were added to an
  // existing settings blob and inherited these defaults in silence.
  //
  // Off is the honest default for anything that rewrites somebody's recording. The switches
  // stay, in Settings, for whoever wants them.
  normalizeBeforeTranscribe: false,
  correctTuningBeforeTranscribe: false,
  maxFret: 17,
  capo: 0,
  useHostGrid: true,
  preciseBeats: false,
  settingsVersion: SETTINGS_VERSION
};

/**
 * The DAW's own grid, when a capture supplied one.
 * Preferred over detected beats because it cannot be wrong — it is the project's truth.
 */
export interface HostGrid {
  hostBpm: number;
  hostTimeSig: { numerator: number; denominator: number };
  /**
   * Absolute seconds, relative to the start of the captured audio.
   *
   * Only a capture knows these — the shell wrote the DAW's bar lines down block by block while
   * the take was rolling. A wav dropped onto a plugin has a tempo but no known alignment to the
   * DAW's timeline, so it carries no bar starts at all rather than invented ones.
   */
  barStartsSec?: number[];
  /**
   * Where these numbers came from, so the UI can say so instead of implying more than it knows.
   *
   * 'capture' — measured off the DAW's playhead while recording this very take.
   * 'host'    — the DAW's tempo and meter as they are right now.
   */
  source: 'capture' | 'host';
}

export interface SourceAudio {
  name: string;
  durationSec: number;
  peaks: { min: Float32Array; max: Float32Array } | null;
  trim: TrimResult | null;
  /** Where the user says bar 1 begins. Starts at the auto-trim point. */
  barOneSec: number;
  hostGrid?: HostGrid;
  /** Tempo and meter belong to this take/document, not to global preferences. */
  tempoBpm?: number;
  timeSignature?: { numerator: number; denominator: number };
  keyFifths?: number;
  /** Empty documents use this to keep full-rest bars after every rebuild. */
  documentBars?: number;
  /** Raw detections, kept so the notation can be rebuilt without re-transcribing. */
  detected?: { notes: InputNote[]; beats?: number[]; downbeats?: number[] };
}

export type Screen = 'opening' | 'main';

export interface RuntimeState {
  screen: Screen;
  host: HostInfo | null;
  source: SourceAudio | null;
  score: RiffScore | null;
  selection: string[];
  settingsOpen: boolean;
  /** 0..1 while transcribing, null otherwise. */
  progress: number | null;
  progressStage: string;
  progressEtaSec: number | null;
  /**
   * Our place in the machine-wide transcription queue while `progressStage` is 'queued'.
   * 1 = next in line. 0 = not waiting.
   */
  progressQueuePosition: number;
  capturing: boolean;
  captureSec: number;
  captureArmed: boolean;
  toasts: Array<{ id: number; kind: 'info' | 'danger'; title: string; message: string }>;
  busy: string | null;
  /**
   * What the shell said it did to the audio before the last engine heard it, in one sentence.
   *
   * Empty until a transcription reports one, and replaced by every transcription after that —
   * including with '' when the run had nothing to report, so the panel can never show a
   * sentence about a take that is no longer on screen. It lives here rather than inside the
   * Settings panel because the panel is built lazily, the first time somebody opens it, and
   * re-renders itself from the stores — a player who transcribes and then goes looking for
   * "what did it do to my recording?" opens that panel AFTER the fact, often for the first
   * time, and a note kept in the panel would not have existed yet to be told.
   */
  preprocessNote: string;
}

export const INITIAL_RUNTIME: RuntimeState = {
  screen: 'opening',
  host: null,
  source: null,
  score: null,
  selection: [],
  settingsOpen: false,
  progress: null,
  progressStage: '',
  progressEtaSec: null,
  progressQueuePosition: 0,
  capturing: false,
  captureSec: 0,
  captureArmed: false,
  toasts: [],
  busy: null,
  preprocessNote: ''
};

const SETTINGS_KEY = 'riffsheet.settings';
const RECENT_KEY = 'riffsheet.recent';

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return mergeStoredSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Settings that came from outside this run, made safe to use.
 *
 * Two callers, one implementation: the settings file above, and the per-instance session
 * blob the host hands back when a destroyed editor is rebuilt (app/persist.ts). Both can be
 * older than this build, and a restored session that skipped `migrate()` would quietly pin
 * the player to a default that has since been changed out from under them.
 */
export function mergeStoredSettings(stored: Partial<AppSettings>): AppSettings {
  // Merge over defaults so settings written by an older build never yield undefined.
  return migrate({ ...DEFAULT_SETTINGS, ...stored }, stored);
}

/**
 * Carry stored settings across a change of default.
 *
 * Merging alone cannot do this: a value that was written *because* it was the old default is
 * indistinguishable from one the player chose, so it would pin them to the old behaviour
 * forever. The version number is what tells the two apart.
 */
function migrate(settings: AppSettings, stored: Partial<AppSettings>): AppSettings {
  const from = stored.settingsVersion ?? 1;

  // v1 -> v2: playback grew real sampled sounds. 'bass' was v1's default oscillator voice,
  // so anyone still on it never picked it — move them to the sampled bass. A player who
  // actually chose guitar/piano/plain tone keeps it.
  if (from < 2 && stored.playbackVoice === 'bass') settings.playbackVoice = 'finger-bass';

  // v2 -> v3: the MIDI button became draggable, and a drag drops whichever variant is remembered.
  // 'quantized' was v2's default, so anyone still on it never chose it — move them to the as-played
  // variant, which is what somebody dragging a take back into their session means. A player who
  // actually picked 'as-played' or 'both' keeps it.
  if (from < 3 && stored.midiExportMode === 'quantized') settings.midiExportMode = 'as-played';

  // v3 -> v4: 'bass' was the old default and it is a HARD constraint on the model, not a hint —
  // a recording that was not purely electric bass had to be answered in bass notes anyway. Anyone
  // still on 'bass' never chose it, so move them to 'auto'. A player who picked guitar keeps it.
  if (from < 4 && stored.instrument === 'bass') settings.instrument = 'auto';

  // v4 -> v5: TAB is a view, not a hard constraint on the transcription model. Preserve what
  // an existing player was looking at, then make the listener universal from here on.
  if (from < 5) {
    settings.tabMode =
      stored.instrument === 'bass' ? 'bass' : stored.instrument === 'guitar' ? 'guitar' : 'off';
    settings.instrument = 'auto';
  }

  // v5 -> v6: the one grid became two.
  //
  // Up to v5 a single `grid` drove BOTH the transcription quantizer and the piano roll's
  // ruler, so a player who wanted 1/4 cells to draw notes into was also, unavoidably,
  // telling the quantizer that quarter notes were the only thing it might write. Two
  // settings now; this decides what each of them inherits.
  //
  //  - The ROLL keeps whatever was on screen. `grid` and `rollGrid` share five of their six
  //    words, so for anything but 'auto' the ruler the player was looking at is carried over
  //    verbatim; 'auto' was never a roll size and falls back to the roll's own default.
  //  - NOTATION goes back to 'auto' if and only if the stored value is v5's 'eighth'. v5 is
  //    the build in which 'auto' did not exist as a choice AND 'eighth' was the default, so
  //    an 'eighth' written by it cannot be a deliberate preference — there was no other way
  //    to be. Every other value, and 'eighth' from any other version (where 'auto' was the
  //    default and 'eighth' had to be picked), is left exactly as the player set it.
  if (from < 6) {
    const storedGrid = stored.grid as string | undefined;
    settings.rollGrid = (ROLL_GRIDS as readonly string[]).includes(storedGrid ?? '')
      ? (storedGrid as RollGrid)
      : DEFAULT_SETTINGS.rollGrid;
    if (from === 5 && storedGrid === 'eighth') settings.grid = 'auto';
  }

  // v6 -> v7: the two "before an engine listens" switches go off.
  //
  // They were added in v6 as purely additive keys defaulting to TRUE, so every settings blob
  // already on disk adopted them without anybody being asked. That was harmless while the
  // shell ignored them and stopped being harmless the moment it did not: takes that had been
  // transcribed one way that morning came back different in the afternoon, because the audio
  // reaching the engine was now downmixed, levelled and — when the tuning estimate fired —
  // resampled. A default nobody chose must not be able to change what the engine hears.
  //
  // Forced rather than merged, and for both values: a `true` written by v6 is indistinguishable
  // from a `true` somebody typed, and only the version number can tell them apart. Anyone who
  // does want them switches them back on in Settings, where they now read as opt-in.
  if (from < 7) {
    settings.normalizeBeforeTranscribe = false;
    settings.correctTuningBeforeTranscribe = false;
  }

  // v7 -> v8: the auto-split / gap-fill pass arrives, and it arrives ON.
  //
  // Additive keys normally need no case at all — `mergeStoredSettings` spreads over
  // DEFAULT_SETTINGS, so an older blob would pick the default up by construction, and the
  // comment on `engineId` below argues against bumping the version for that. This one is
  // different in the way that matters: it CHANGES WHAT APPEARS ON SOMEBODY'S SHEET after the
  // next transcription. A player who transcribes the same take twice across an update and gets
  // a different note count deserves for that to be a recorded decision rather than a silent
  // side effect of a spread, so it is written down here where the next person looking for
  // "when did this start happening?" will find it.
  //
  // Forced rather than merged, so a `false` written by a build that had no such switch — there
  // were none, but stored JSON is untrusted and dev builds exist — cannot pin somebody to off
  // without them ever having chosen it. Anyone who does not want it turns it off in Settings.
  if (from < 8) settings.autoSplitAtAttacks = DEFAULT_SETTINGS.autoSplitAtAttacks;

  // v7 -> v8, second half: `rollFollowSheet` becomes `alignViews`, and the meaning changes.
  //
  // Not a rename. The old switch put the piano roll on the SHEET's x-axis, which meant adding
  // one note re-spaced its neighbours — the roll reflowed under the player's hand. That design
  // is gone; the roll is a linear time ruler now and always, and no setting can change it.
  // What the chip does instead is keep the four views pointing at the same MOMENT, which has
  // no effect on where anything is drawn.
  //
  // So the stored value is NOT carried over: a `true` written by an older build was consent to
  // a different feature, and a `false` was a refusal of one. Everybody arrives at the new
  // default, which the player asked to be ON, and the old key is deleted below so it cannot
  // keep being written back forever.
  if (from < 8) settings.alignViews = DEFAULT_SETTINGS.alignViews;

  const sampled = new Set([
    'finger-bass',
    'upright-piano',
    'electric-piano',
    'steel-guitar',
    'electric-guitar',
    'marimba'
  ]);
  if (!sampled.has(settings.playbackVoice)) settings.playbackVoice = DEFAULT_SETTINGS.playbackVoice;

  // Stored JSON is untrusted and older development builds wrote experimental grid words.
  // Each grid is checked against its OWN vocabulary: 'auto' is a real notation setting and
  // a meaningless roll one, so the two lists are not interchangeable.
  if (!(NOTATION_GRIDS as readonly string[]).includes(settings.grid)) {
    settings.grid = DEFAULT_SETTINGS.grid;
  }
  if (!(ROLL_GRIDS as readonly string[]).includes(settings.rollGrid)) {
    settings.rollGrid = DEFAULT_SETTINGS.rollGrid;
  }
  // `engineId` needs no migration case and SETTINGS_VERSION stays where it is: the field is
  // purely additive and `mergeStoredSettings` spreads over DEFAULT_SETTINGS, so an older blob
  // arrives as 'auto' by construction. Bumping the version for that would be noise, and every
  // bump costs a migration case somebody later has to read. It is still SANITISED, because
  // stored JSON is untrusted and an engine id ends up in a native call.
  if (typeof settings.engineId !== 'string' || settings.engineId.length === 0) {
    settings.engineId = DEFAULT_SETTINGS.engineId;
  }
  if (typeof settings.alignViews !== 'boolean') {
    settings.alignViews = DEFAULT_SETTINGS.alignViews;
  }
  if (typeof settings.normalizeBeforeTranscribe !== 'boolean') {
    settings.normalizeBeforeTranscribe = DEFAULT_SETTINGS.normalizeBeforeTranscribe;
  }
  if (typeof settings.correctTuningBeforeTranscribe !== 'boolean') {
    settings.correctTuningBeforeTranscribe = DEFAULT_SETTINGS.correctTuningBeforeTranscribe;
  }
  if (typeof settings.autoSplitAtAttacks !== 'boolean') {
    settings.autoSplitAtAttacks = DEFAULT_SETTINGS.autoSplitAtAttacks;
  }

  if (!['off', 'bass', 'guitar', 'custom'].includes(settings.tabMode)) settings.tabMode = 'off';
  if (!['auto', 'treble', 'bass', 'grand'].includes(settings.clefMode)) settings.clefMode = 'auto';
  settings.customTuningMidi = sanitizeCustomTuning(settings.customTuningMidi);

  // Removed controls must also disappear from the actual object produced by spreading older
  // JSON, otherwise they keep being written back forever despite no longer existing in the type.
  delete (settings as unknown as Record<string, unknown>).swing;
  delete (settings as unknown as Record<string, unknown>).rollFollowSheet;

  // Tempo/meter are per-document now. Do not let a preference saved by an older take leak into
  // whatever the user opens next; restoreSession migrates the old values onto its source.
  settings.tempoBpm = undefined;
  settings.timeSignature = undefined;
  settings.keyFifths = undefined;

  settings.settingsVersion = SETTINGS_VERSION;
  return settings;
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private browsing or quota — settings just do not persist */
  }
}

export interface RecentFile {
  name: string;
  path: string;
  at: number;
}

export function loadRecent(): RecentFile[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as RecentFile[];
  } catch {
    return [];
  }
}

/**
 * Drop an entry that turned out to be unopenable.
 *
 * A recent list that keeps offering a file which has been moved or deleted is worse than a
 * short one: every click is a fresh disappointment. Called from the failure path in
 * `App.openRecent`, never speculatively — the file is only forgotten once opening it has
 * actually been tried and failed.
 */
export function forgetRecent(path: string): RecentFile[] {
  const list = loadRecent().filter((r) => r.path !== path);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}

export function pushRecent(file: RecentFile): RecentFile[] {
  const list = [file, ...loadRecent().filter((r) => r.path !== file.path)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}

export function currentTuning(settings: AppSettings): TuningPreset {
  return settings.tabMode === 'custom'
    ? customTuning(settings.customTuningMidi)
    : tuningById(settings.tuningId);
}

function sanitizeCustomTuning(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.customTuningMidi];
  const notes = value
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 127)
    .slice(0, 12)
    .sort((a, b) => a - b);
  return notes.length >= 2 ? notes : [...DEFAULT_SETTINGS.customTuningMidi];
}

export interface AppStores {
  settings: Store<AppSettings>;
  runtime: Store<RuntimeState>;
}

export function createStores(): AppStores {
  const settings = createStore<AppSettings>(loadSettings());
  settings.subscribe((s) => saveSettings(s));
  return { settings, runtime: createStore<RuntimeState>({ ...INITIAL_RUNTIME }) };
}
