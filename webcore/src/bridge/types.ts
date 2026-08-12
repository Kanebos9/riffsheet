/**
 * The native bridge contract (Team A owns the implementation; see shell/BRIDGE.md).
 *
 * Everything webcore needs from the host lives behind this interface, and webcore never
 * touches `window.webkit` / `window.riffsheet` directly — see ./index.ts. That keeps the
 * browser dev path and the JUCE path on exactly one code path.
 *
 * If BRIDGE.md and this file disagree, they must be reconciled before shipping; these are
 * the signatures webcore was coded against.
 */

import type { NativeOmrResult, OmrStatus } from '../import/scoreImage';

/**
 * THE IMPORT/EXPORT SIZE LIMITS — one definition for the whole web side, paired byte for
 * byte with `shell/Source/bridge/TransferLimits.h`.
 *
 * They used to be four different numbers in four places that did not know about each other:
 * the native picker refused anything over 64 MB, the base64 hand-off allowed ~412 MB of
 * decoded payload, the document writer permitted a 512 MB audio entry, and the document
 * reader rejected any container over 512 MB — so the writer could produce a `.riffsheet`
 * it would not itself reopen, and which limit a user met depended on which door they came
 * through. Every one of those call sites reads these constants now.
 *
 * If you change a number here, change it in TransferLimits.h in the same commit. The two
 * halves guard the two ends of one pipe and a limit only one end believes in is not a limit.
 *
 * 128 MB is a working ceiling, not a moral position: an 8 GB machine running a DAW, a
 * WebView and a transcription engine cannot afford a half-gigabyte document, and 128 MB is
 * about twelve minutes of 24-bit stereo 48 kHz WAV — longer than any riff this is for.
 */
export const RIFFSHEET_LIMITS = {
  /** Biggest file read into memory: a `.riffsheet`, a MusicXML/MIDI/GP import, a drop. */
  containerBytes: 128 * 1024 * 1024,
  /** Biggest single decoded audio payload. Deliberately the SAME number as the container:
      a container that could hold audio it may not then decode would be a limit that lies. */
  decodedAudioBytes: 128 * 1024 * 1024,
  /** The base64 hand-off ceiling, in characters — 4 per 3 bytes, plus padding slack. */
  base64PayloadBytes: Math.ceil((128 * 1024 * 1024) / 3) * 4 + 1024
} as const;

export interface HostInfo {
  /** 'juce-standalone' | 'juce-plugin' | 'browser' */
  host: string;
  /**
   * True when running as an audio plugin inside a DAW. Unlocks "Capture from track",
   * because in a plugin we can read the track's audio directly.
   */
  isPlugin: boolean;
  /** e.g. "REAPER 7.22". Shown in the settings' engine row. */
  hostName?: string;
  version?: string;
  /** False when the transcription engine is not installed yet -> quiet setup banner. */
  engineAvailable: boolean;
  /** Human-readable reason when engineAvailable is false. */
  engineMessage?: string;
  /**
   * Measured seconds of transcription per second of audio, if the host knows it from a
   * previous run. Drives the honest ETA. Absent on first run.
   */
  transcribeRate?: number;
  /** Host sample rate, when known. */
  sampleRate?: number;

  // --- the DAW's own timeline ----------------------------------------------------------
  /**
   * The DAW's tempo, time signature and playhead, RIGHT NOW.
   *
   * `null` means "the host said nothing", which is deliberately different from 0 — a
   * standalone app has no tempo at all, and the difference decides whether the sheet may
   * borrow the DAW's grid. See app.ts `liveHostGrid()`.
   *
   * These arrive both from `getHostInfo()` and, change-gated at 20 Hz, from the `hostInfo`
   * event, so the "synced to DAW grid" chip can show the live numbers instead of a snapshot
   * taken at capture time. That snapshot was the reported bug: the user changed REAPER's
   * tempo after capturing and Riffsheet kept using the old one.
   */
  bpm?: number | null;
  timeSignature?: { numerator: number; denominator: number } | null;
  /** True when the host gave a usable playhead at all. */
  hasHostTimeline?: boolean;
  isPlaying?: boolean;
  /** Quarter notes since the start of the project, and of the bar the playhead is in. */
  ppqPosition?: number | null;
  ppqOfLastBarStart?: number | null;
}

/**
 * What the transcription engine is doing, machine-wide.
 *
 * "Machine-wide" is the point. MuScriptor is one Python process that does ONE transcription
 * at a time and eats about a gigabyte, and a DAW project can easily hold several Riffsheets.
 * Without this the second instance to press go just sat there looking broken. The shell now
 * queues them and reports through here; see shell/BRIDGE.md.
 *
 * Everything is optional-ish in spirit: a browser has no engine at all, so the whole call is
 * absent and the UI shows nothing rather than inventing a status.
 */
export interface EngineStatus {
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  /** 0 when nothing is listening. */
  port: number;
  /** True when we joined a server somebody else started — our model setting cannot change it. */
  adopted: boolean;
  /** The weights actually in use, as far as can be known. */
  model: string;
  /** What we asked for. 'auto' has already been resolved by the time this is reported. */
  configuredModel?: string;
  /** Which weights are on this machine, e.g. ["small","medium"]. */
  installedModels: string[];
  /** True when a transcription is running anywhere on this machine. */
  busy: boolean;
  busyOwner?: 'self' | 'other' | null;
  /** How many jobs are waiting, this process included. */
  queueLength: number;
  /** Our own place in the queue; 0 means "not waiting". */
  queuePosition: number;
  ramTotalMb?: number;
  ramFreeMb?: number;
  /**
   * How the engine's memory gets given back.
   *
   * The listener is a Python process holding about a gigabyte of model weights, and it used to
   * stay resident forever once started, then for five idle minutes. It now dies the moment a
   * transcription ends — success, failure or cancel — and the next one cold-starts it. So
   * `state: 'stopped'` is the NORMAL resting state and must never be drawn as a fault.
   * `memoryMb` is what it is actually costing right now, while it is up.
   */
  stopsAfterEachJob?: boolean;
  idleSeconds?: number;
  canStop?: boolean;
  /** A server is up that Riffsheet did NOT start. See `stopExternalEngine`. */
  externalServer?: boolean;
  /**
   * `stopExternalEngine()` would actually try, on this machine, right now.
   *
   * THE BUTTON IS DRAWN FROM THIS AND FROM NOTHING ELSE — not from `adopted`, not from
   * `externalServer`. On Windows the listening process's command line cannot be read, so the
   * shell cannot prove a server is a MuScriptor before ending it and refuses by design:
   * `externalServer` is true there while this is false, and a button drawn from the first
   * could only ever refuse. See BRIDGE.md.
   */
  canStopExternal?: boolean;
  memoryMb?: number | null;

  /**
   * The whole model size table — not only what is on disk.
   *
   * `installedModels` above answers "what is here"; this answers "what are the choices, what
   * would each cost, and which of them can this machine actually run". `fits` is the `auto`
   * rule's own answer (a size needing more than 40% of physical RAM is dropped), so a chooser
   * built on it agrees with what `auto` would do rather than second-guessing it.
   *
   * Optional: a shell older than the model table does not send it, and the card falls back to
   * the figures BRIDGE.md documents.
   */
  models?: Array<{
    name: string;
    /** Loaded, Python and the GPU buffers included: 900 | 1800 | 5000. */
    approxResidentMb: number;
    installed: boolean;
    /** Within the auto rule's 40%-of-physical-RAM ceiling. */
    fits: boolean;
  }>;
  /**
   * Engine setup, for the guide-and-detect screen.
   *
   * `searchedPaths` is every venv location discovery looked in, in order — the answer to "it
   * says not installed and I definitely installed it". `engineConfigPath` is the one setting a
   * DAW-hosted plugin can actually read (a Finder-launched host never sees the shell's
   * environment), so it is shown whether or not the file exists yet: creating it IS the
   * instruction for a custom install.
   */
  searchedPaths?: string[];
  venv?: string;
  executable?: string;
  engineInstalled?: boolean;
  setupDirectory?: string;
  engineConfigPath?: string;
  engineConfigExists?: boolean;
  error?: string | null;

  // --- multi-engine (shell/BRIDGE.md §3.2) ----------------------------------------------
  //
  // Every one of these is OPTIONAL, and that is load-bearing rather than defensive: a shell
  // built before the engine registry existed answers with exactly the payload above, and the
  // whole screen has to keep rendering off it. `undefined` here means "this shell has one
  // engine and it is MuScriptor", which is the truth about that shell.

  /** Which engine this payload describes. Absent on a single-engine shell. */
  id?: string;
  /** What the user asked for: 'auto' or a concrete id. */
  configuredEngine?: string;
  /** What 'auto' means right now. Always a real id when present. */
  resolvedEngine?: string;
  /** A plain sentence explaining the resolution, in `modelReason`'s shape. */
  engineReason?: string;
  install?: EngineInstall;
  /**
   * How a guided engine is installed by hand, straight from the engine's own manifest.
   *
   * This USED to be a copy in `webcore/src/ui/settings.ts`, and two copies of an install guide
   * is one copy too many — the shell's is the one the engine ships with, so it wins and the
   * page renders it. Empty for anything that is not a `guide` engine.
   *
   * Both shapes are accepted deliberately. BRIDGE.md §3.2 types it `string[]`, but a step is a
   * heading AND a detail line (the renderer draws them as `<strong>` + `<div class="dim">`),
   * and flattening that would silently lose half of every step. A bare string is treated as a
   * heading with no detail rather than refused.
   */
  guideSteps?: Array<string | GuideStep>;
}

/** One step of a hand-install guide: a heading, and the line you actually type. */
export interface GuideStep {
  what: string;
  detail: string;
}

/** How an engine gets onto the machine. `guide` engines are never installed by Riffsheet. */
export type EngineInstall = 'bundled' | 'one-click' | 'guide';

/** What an engine is right now. `installed` is "on disk but not warmed"; `ready` is usable. */
export type EngineState = 'ready' | 'installed' | 'not-installed' | 'broken';

/**
 * One engine on the picker, as the shell describes it (BRIDGE.md §3.1).
 *
 * Read-only and cheap: it is the compiled-in manifest row plus that adapter's cached status,
 * so the settings panel can poll it beside `engineStatus()` on the same two-second tick.
 *
 * Engines whose weights Riffsheet has no right to redistribute never appear in this array at
 * all — the filtering happens in the shell's catalog, not here, so there is no way for the
 * page to offer an install that must not exist.
 */
export interface EngineSummary {
  id: string;
  name: string;
  /** "Built in" | "Best quality — guided setup" | "One-click". Shown on the card. */
  tier: string;
  summary: string;
  sourceUrl: string;
  install: EngineInstall;
  state: EngineState;
  /** True when this is the engine `auto` currently resolves to. */
  selected: boolean;
  /** What it is actually good at, e.g. ["Bass"]. The card's capability line. */
  instrumentStrengths: string[];
  acceptsInstrumentConstraint: boolean;
  producesBeatGrid: boolean;
  producesConfidence: boolean;
  producesVelocity: boolean;
  /** 0 when nothing is downloaded. */
  approxDiskBytes: number;
  approxPeakRssMb: number;
  /** True while an install job for this id is in flight. */
  installing: boolean;
  detail: string;
  error: string | null;

  /**
   * The engine's licence, as a short SPDX-ish string ("MIT", "Apache-2.0", "Non-commercial").
   *
   * OPTIONAL, and it is optional on purpose: a shell built before this field existed simply
   * does not send it, and the card then names the source without claiming a licence it was
   * never told. Never guessed from the URL — "it is on GitHub" says nothing about the terms,
   * and the one thing this line exists to be is right.
   */
  license?: string;

  // NOTE: there is deliberately no per-model RAM field here. The size table belongs to the
  // ENGINE'S STATUS, not to its catalogue row — see `EngineStatus.models`, which the shell
  // sends with `installed` and `fits` alongside each figure. This was designed as
  // `modelRamMb` here before that landed and moved once the real contract existed, rather
  // than being kept as a second, weaker copy of the same fact.
}

/** The answer to `listEngines()` (BRIDGE.md §3.1). */
export interface EngineListResult {
  configuredEngine: string;
  resolvedEngine: string;
  engineReason: string;
  /**
   * What the SHELL would use if the engine that runs in this page bowed out.
   *
   * Riffsheet's own engine (`riffsheet`) transcribes here, in the web view, and it can refuse a
   * take it hears as chordal. When it does, the take is handed on — and this is the id it is
   * handed to, together with the name to put in the sentence the player reads. It comes from the
   * shell rather than from an order written out again here, because "which engine is next" is
   * one decision and two copies of it would drift and then lie to somebody.
   *
   * OPTIONAL, like every multi-engine field: a shell that predates the in-page engine does not
   * send it, and on such a shell `resolvedEngine` is never `riffsheet` so nothing ever needs it.
   */
  nativeFallbackEngine?: string;
  engines: EngineSummary[];
}

/**
 * The id of the engine that runs in this page rather than in the shell.
 *
 * Spelled once. `app.ts` compares `resolvedEngine` against it to decide whether to run the local
 * pass or call the bridge, and the mock's catalogue uses it for its row — so a rename is one
 * edit here and one in `shell/Source/engines/EngineCatalog.cpp`, which is the coupling the
 * shell's own comment describes.
 */
export const RIFFSHEET_ENGINE_ID = 'riffsheet';

/**
 * An install in flight.
 *
 * NO BYTES EVER CROSS THE BRIDGE. The download streams to disk in C++ and these frames carry
 * integers and short strings, which is why a 400 MB engine is not a payload-ceiling problem.
 * Change-gated and capped at 5 Hz on the native side.
 */
export interface EngineInstallProgress {
  jobId: number;
  id: string;
  stage: 'checking' | 'downloading' | 'verifying' | 'extracting' | 'installing' | 'probing';
  /** Set for every stage except `downloading`, which reports bytes instead. */
  message?: string;
  receivedBytes?: number;
  totalBytes?: number;
  /** 0..1 while downloading. */
  fraction?: number;
  bytesPerSec?: number;
  etaSec?: number;
}

/**
 * How an install ended.
 *
 * `guideSteps` on a failure is the point of the whole shape: an engine that cannot be
 * installed here (no Python, say) degrades into the same hand-install guide MuScriptor uses,
 * rendered by the same code, rather than into a dead end.
 */
export interface EngineInstallResult {
  jobId: number;
  id: string;
  ok: boolean;
  bytesOnDisk?: number;
  elapsedMs?: number;
  location?: string;
  error?: string;
  cancelled?: boolean;
  guideSteps?: Array<string | GuideStep>;
}

export interface DetectedNoteDTO {
  startSec: number;
  endSec: number;
  midi: number;
  /**
   * How sure the engine was about this note, 0..1 — when it says at all.
   *
   * Engines differ and the difference is real: Basic Pitch reports the mean frame probability
   * over the note, while MuScriptor's model emits a binary on/off and reports nothing. Carried
   * rather than drawn: nothing on screen reads it yet, but a bridge that drops the field means
   * any later use of it starts by going back to the shell, so it is kept from here on.
   */
  confidence?: number;
  velocity?: number;
}

/**
 * What the shell did to a COPY of the recording before an engine heard it.
 *
 * A receipt, not work for the caller. Every time in the result beside it is already back in
 * the original recording's timebase (BRIDGE.md, "Before an engine hears it"), so nothing here
 * has to be applied to anything — it exists so the player can be told, in one sentence, that
 * their flat guitar was nudged to A440 or that it was left exactly as played.
 *
 * Absent means the question never came up: this engine asked for no preparation, or the
 * player switched both options off. It does not mean "nothing was done".
 */
export interface PreprocessReceipt {
  /** A prepared copy was made. False means the engine was handed the original file. */
  applied: boolean;
  /** One sentence for the player, never empty. This is the only field the UI shows. */
  note: string;
  /** What the tuning estimate said, in cents, acted on or not. 0 when none was made. */
  cents?: number;
  /** How much the partials agreed: 0 = they disagree, 1 = they agree. */
  concentration?: number;
  /** How many partials were weighed. 0 means no estimate ran. */
  peaks?: number;
  /** Resampling ratio used for the tuning fix. 1 when the timebase was not touched. */
  pitchRatio?: number;
  /** Gain applied, in dB. 0 when the level was left alone. */
  gainDb?: number;
  /** Peak of the mono mix the engine would hear, before any gain. */
  peakDbfs?: number;
}

export interface TranscribeResult {
  notes: DetectedNoteDTO[];
  /** Beat positions in seconds, if the engine found a grid. */
  beats?: number[];
  /** Measured bar starts. Kept distinct from beats so the meter is not guessed. */
  downbeats?: number[];
  /** Constant-grid metadata when MuScriptor supplied it. No denominator is invented. */
  beatGrid?: {
    bpm: number;
    beatsPerBar?: number | null;
    firstDownbeat?: number;
    beats?: number[];
  };
  tempoBpm?: number;
  durationSec?: number;
  /**
   * What was done to the audio before the engine listened, when anything was offered.
   *
   * Shown to the player as one dim line under the two preprocessing checkboxes in Settings.
   * Nothing else reads it: the times above are already in the recording's own timebase.
   */
  preprocess?: PreprocessReceipt;
}

export interface AudioFileRef {
  /** Filesystem path when the host knows one; "" for a capture. */
  path: string;
  name: string;
  durationSec?: number;
  sampleRate?: number;
  /**
   * The shell's handle for this audio. Everything native is addressed by it —
   * transcribe(), playbackLoad(). Absent in browser mode.
   */
  token?: string;
  /**
   * Where the mono float samples live. Fetched as binary rather than passed through the
   * JSON bridge, because a few million floats through JSON is absurd.
   */
  pcmUrl?: string;
  numFrames?: number;
  /** Present in browser mode, where we hold the bytes ourselves. */
  bytes?: ArrayBuffer;
}

/**
 * The original recording behind a native take — see `NativeBridge.getOriginalAudio`.
 *
 * `verbatim` is a fact about the bytes, not a hope: true only when they are the file the
 * user opened (or an untouched copy of it), false when all that survives is something the
 * shell encoded — a rendered capture. Anything that puts these bytes in a document and
 * calls them "the original" must check it.
 */
export interface OriginalAudio {
  bytes: Uint8Array;
  /** The real filename, with its real extension: "riff.flac", never "riff.wav". */
  name: string;
  verbatim: boolean;
}

/** One result from the shell's all-supported-input picker. */
export type PickedInputFile =
  | { kind: 'audio'; audio: AudioFileRef }
  | { kind: 'bytes'; path: string; name: string; bytes: Uint8Array };

/** Result of an operating-system drop seen by the native editor fallback. */
export type DroppedInputResult =
  | { ok: true; input: PickedInputFile }
  | { ok: false; name: string; error: string };

export interface TranscribeProgress {
  /** 0..1 */
  progress: number;
  /** 'queued' | 'listening' | 'writing' | anything the shell reports. */
  stage?: string;
  /**
   * Our place in the machine-wide engine queue while `stage` is 'queued'.
   *
   * 1 means "next". The engine does one job at a time, so a second Riffsheet pressing go has
   * to wait, and saying so is the difference between "waiting for another Riffsheet" and a
   * progress bar that appears to have died.
   */
  queuePosition?: number;
}

// ---------------------------------------------------------------------------
// Capture (plugin mode)
// ---------------------------------------------------------------------------

export type CapturePhase =
  /** Not capturing. */
  | 'idle'
  /** Armed: waiting for the DAW transport to roll before recording starts. */
  | 'armed'
  /** Actively recording the track's audio. */
  | 'recording'
  /** Stopped, PCM is being handed over. */
  | 'finishing';

export interface CaptureState {
  phase: CapturePhase;
  /** Seconds of audio captured so far. Drives the live counter. */
  capturedSec: number;
  /** Whether the DAW transport is rolling right now. */
  hostIsPlaying: boolean;
  /** Peak level 0..1 over the last update, for a level dot. Optional. */
  peak?: number;
}

/**
 * The DAW's own grid, handed over with a capture.
 *
 * When present this beats beat detection outright — it is the project's truth, not a
 * guess, so the sheet lines up with the user's session exactly. The UI shows a
 * "synced to DAW grid" chip with an override back to detected beats.
 */
export interface CaptureContext {
  hostBpm: number;
  hostTimeSig: { numerator: number; denominator: number };
  /** Absolute seconds relative to the START of the captured audio. */
  barStartsSec: number[];
  /**
   * Plain sentences about anything the host was vague on during the take — a tempo that
   * changed, a meter that arrived late, a mark buffer that filled up.
   *
   * Shown to the player rather than swallowed. The whole class of bug this replaced was the
   * app quietly substituting a plausible number for one it did not have.
   */
  ambiguities?: string[];
}

export interface CaptureResult {
  /** Mono PCM, -1..1. */
  pcm: Float32Array;
  sampleRate: number;
  durationSec: number;
  /** Durable WAV path in native builds; empty only in the browser mock/old shells. */
  path: string;
  /** Same live-sample route as AudioFileRef, valid for this native process. */
  pcmUrl?: string;
  /** Present when the host could report its transport grid. */
  captureContext?: CaptureContext;
  /** The shell's handle for the take, so transcribe/playback can address it. */
  token?: string;
}

// ---------------------------------------------------------------------------
// Original-audio playback (host-side, so the plugin can play through the DAW)
// ---------------------------------------------------------------------------

export interface PlaybackState {
  isPlaying: boolean;
  positionSec: number;
  durationSec: number;
  /**
   * Whether the host actually has audio loaded behind this transport.
   *
   * Optional because not every host says. `false` is a definite "there is nothing to play"
   * — a token that never made it across, say — which the transport counts and carries on
   * past rather than waiting on. `undefined` only means the host did not tell us.
   */
  loaded?: boolean;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * What came back from a save.
 *
 * `saved: false` means the user dismissed the native save panel — NOT an error. The UI must
 * stay silent in that case; the old code toasted "Exported" no matter what, which is the
 * single most confusing thing an export button can do.
 *
 * A failure is still thrown, so `try/catch` keeps working.
 */
export interface ExportOutcome {
  saved: boolean;
  /** Where it landed, when the host tells us. Absent is not a failure. */
  path?: string;
  /** How many files were written. 2 for the "both MIDI variants" export. */
  count?: number;
}

export interface ExportPayload {
  name: string;
  bytes: Uint8Array;
  mimeType?: string;
}

/** Per-run transcription options the user can change in Settings. */
export interface TranscribeOptions {
  /**
   * Ask the shell for real per-beat times instead of one constant tempo.
   *
   * Costs a second pass over the audio (the shell runs a `beat_this` sidecar), so it is
   * off unless the player asks for it — but for anything rubato it is the difference
   * between a readable sheet and a drifting one. `TranscribeResult.beats` carries the
   * result either way; this only changes how good those beats are.
   */
  preciseBeats?: boolean;

  /**
   * Which instrument groups the engine may report, as MuScriptor's own names.
   *
   * A HARD constraint on the model's output, not a hint — an unknown name is a 400 and a
   * wrong name silently deletes everything that was played. **Empty means "anything", and
   * empty is the right default.** Riffsheet used to pin every take to `electric_bass`
   * because it was built bass-first; the engine is good across the board, so only a
   * deliberate choice in Settings narrows it now.
   */
  instruments?: string[];

  /**
   * Transcribe this ONE take with a named engine, whatever the global choice is.
   *
   * Designed for and deliberately not set: the engine is a property of how somebody works —
   * what they play, what they installed — rather than of a recording, so a per-take default
   * would make the same riff transcribe differently after a project reload. It exists so
   * "listen again with Basic Pitch" is later a button rather than a refactor. Absent means
   * "whatever the shell resolves", which is the only thing webcore sends today.
   */
  engineId?: string;

  /**
   * Let the shell even out the level before an engine listens. Default true.
   *
   * The shell brings the peak to −12 dBFS, which is the level these models were trained
   * near, in **both** directions — a hot take comes down too. It is applied per engine:
   * each engine's manifest says whether it wants it, and one that normalises internally is
   * left alone whatever this says. Your own recording is never changed; the shell writes a
   * separate copy for the engine and deletes it when the job ends.
   */
  normalizeBeforeTranscribe?: boolean;

  /**
   * Let the shell nudge the recording to A440 before an engine listens. Default true.
   *
   * A guitar a quarter-tone flat otherwise comes back a semitone wrong. Applied per engine
   * and **only when the estimate is confident** — a confident-looking correction from an
   * unconfident guess is worse than none.
   *
   * Correcting pitch by resampling also changes time, so the shell maps every note, beat
   * and downbeat back into the recording's own timebase before the result leaves it. That
   * is why nothing on this side has to know the correction happened; `preprocess.note` in
   * the result says what was done, for the one place that shows it to the player.
   */
  correctTuningBeforeTranscribe?: boolean;
}

export interface NativeBridge {
  getHostInfo(): Promise<HostInfo>;

  /** Native file picker. Resolves null when the user cancels. */
  pickAudioFile(): Promise<AudioFileRef | null>;

  /**
   * Native picker for every input Riffsheet accepts. Unlike an HTML file input, this works
   * reliably inside plugin WebViews. Optional for older shells and browser mode.
   */
  pickInputFile?(): Promise<PickedInputFile | null>;

  /** Native OS-drop fallback. HTML5 drops still use the same import path directly. */
  onInputDropped?(handler: (result: DroppedInputResult) => void): () => void;

  /**
   * Re-open a file the host already knows the path of, without a picker.
   *
   * Used by session restore: a decoded-audio token is only good for the life of the
   * process, so after a project reload the only way back to the original recording is its
   * path. Optional — absent means a restored session simply has no "original" side to its
   * fader, which is a degradation, not a failure.
   */
  loadAudioPath?(path: string): Promise<AudioFileRef | null>;

  /**
   * Mint a take from bytes the page already holds, with no path involved.
   *
   * The companion to `loadAudioPath` for a v2 `.riffsheet`, which carries its recording
   * inside it: on another machine, or after the original file moved, there is no path left to
   * re-open but the audio itself is right there. Everything that only reads SAMPLES already
   * worked from the embedded bytes; this is what re-transcription needs, because that runs in
   * the shell and the shell addresses audio by token.
   *
   * `name` must keep the original extension — the shell picks its decoder from it.
   *
   * Optional: a shell older than this simply has no such function, and the caller falls back
   * to today's behaviour (path only) with an honest message.
   */
  loadAudioBytes?(name: string, bytes: Uint8Array): Promise<AudioFileRef | null>;

  /**
   * THE RECORDING ITSELF, as the user handed it over — not the samples the transcriber
   * listened to.
   *
   * Everything else on this interface addresses a native take by token and gets back the
   * ANALYSIS BUFFER: folded to mono, resampled to 44.1 kHz, which is exactly right for a
   * transcriber and exactly wrong for a document that says it carries the imported file.
   * Before this existed the page had no bytes at all after a native open, so saving fell
   * back to encoding that mono buffer as a 16-bit WAV — a 24-bit/96 kHz stereo master
   * became 16-bit/44.1 kHz mono inside a `.riffsheet`, while the format's own docs promised
   * a verbatim copy.
   *
   * READ ON DEMAND. Nothing is held for it and nothing is base64'd: the shell reads the
   * file off disk when this is called, so a take that is never saved is never read. Call it
   * when a document is actually being written, not on import.
   *
   * Resolves null when there is no original to give — a track capture before it has been
   * rendered, a file that has moved, or one larger than `RIFFSHEET_LIMITS.containerBytes`.
   * `verbatim: false` means the bytes are a re-encode rather than the user's own file, and
   * the caller must not describe them as the original.
   *
   * Optional: an older shell has no such function, and the caller falls back to today's
   * behaviour (encode the decoded samples) with honest wording.
   */
  getOriginalAudio?(token: string): Promise<OriginalAudio | null>;

  /**
   * Tell the shell which files are on this app's own Recent list.
   *
   * The shell only re-opens a path by name if this user chose that file in Riffsheet at some
   * point — otherwise a path arriving inside a shared DAW project could be opened silently.
   * The Recent list predates that record, so entries made before it exists have to be handed
   * over once or they would never open again. Pass ONLY paths read from
   * `localStorage['riffsheet.recent']`: that store is local to this machine and this host and
   * never travels inside a project file, which is what makes it a safe thing to vouch for.
   *
   * Resolves to how many were accepted. Optional — older shells simply have no such record.
   */
  authorizeRecentPaths?(paths: string[]): Promise<number>;

  /** Local printed-score recognition. Optional until the native shell includes it. */
  omrStatus?(): Promise<OmrStatus>;
  recognizeScoreImage?(name: string, bytes: Uint8Array): Promise<NativeOmrResult>;

  /**
   * Run the transcription engine. `source` is either a host file reference or raw PCM
   * (from capture, or from a browser-decoded file).
   */
  transcribe(
    source: AudioFileRef | CaptureResult,
    onProgress?: (p: TranscribeProgress) => void,
    options?: TranscribeOptions
  ): Promise<TranscribeResult>;

  /** Write bytes to disk via a native save dialog. `saved:false` = the user cancelled. */
  exportFile(name: string, bytes: Uint8Array, mimeType?: string): Promise<ExportOutcome>;

  /**
   * Write several files from ONE save dialog.
   *
   * The user picks a name and folder once; the host writes every payload next to it, keeping
   * each payload's own suffix. Optional: hosts that do not implement it are detected and the
   * caller falls back to one dialog per file (see ui/exportBar.ts). See shell/BRIDGE.md.
   */
  exportFiles?(files: ExportPayload[]): Promise<ExportOutcome>;

  // --- capture (plugin mode only; reject/throw when isPlugin is false) ----------------
  captureStart(options?: { armed?: boolean }): Promise<void>;
  captureStop(): Promise<CaptureResult>;
  /** Subscribe to capture state. Returns an unsubscribe function. */
  onCaptureState(handler: (state: CaptureState) => void): () => void;

  // --- original audio transport ------------------------------------------------------
  /** Hand the host the audio it should play as the "original" side of the fader. */
  loadOriginal(source: AudioFileRef | CaptureResult): Promise<{ durationSec: number }>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionSec: number): Promise<void>;
  setOriginalGain(gain: number): void;
  /** Position updates while playing. Returns an unsubscribe function. */
  onPlaybackState(handler: (state: PlaybackState) => void): () => void;

  /**
   * The DAW's tempo / time signature / playhead as they change.
   *
   * Change-gated and rate-limited to 20 Hz on the native side, so an idle plugin is silent.
   * Optional: a browser has no host to report one. Returns an unsubscribe function.
   */
  onHostInfo?(handler: (info: HostInfo) => void): () => void;

  // --- drag a file out to the DAW ------------------------------------------------------
  /**
   * Start a real OS drag whose payload is a file on disk.
   *
   * An HTML5 drag can only hand bytes to another web page; dropping a `.mid` onto a REAPER
   * track needs the operating system's own drag, carrying a real path. So the page hands the
   * bytes over and the host stages and drags them.
   *
   * MUST be called while the mouse button is still down and the pointer has already moved —
   * macOS will only open a dragging session from inside a live mouse-drag. A `dragstart`
   * handler is too late and a click is far too late. `started: false` means the OS refused;
   * fall back to the normal save dialog rather than leaving the user with nothing.
   *
   * Optional: absent in the browser, where HTML5 drag is all there is.
   */
  beginMidiDrag?(name: string, bytes: Uint8Array): Promise<{ started: boolean; path?: string; error?: string }>;

  // --- diagnostics ---------------------------------------------------------------------
  /**
   * Put a line in the host's log.
   *
   * Inside a DAW the browser console is invisible, so this is the only way a web-side
   * diagnostic is ever read. Used by the transport for clock faults.
   */
  log?(level: 'info' | 'warn' | 'error', message: string): Promise<void>;

  /**
   * The host's own playback counters (audio blocks rendered / skipped / starved).
   *
   * Pulled, never pushed — they change every audio block. Read by
   * `__RIFFSHEET_CLOCK__()` so "playback stalled" can be attributed to the host
   * side or the web side instead of guessed at.
   */
  playbackDiagnostics?(): Promise<Record<string, unknown>>;

  /** Open the engine setup flow (the "2-minute setup" link). */
  openEngineSetup?(): Promise<void>;

  /**
   * The shell's own version string, e.g. "0.1.0".
   *
   * `getHostInfo().version` carries the same value and is the right thing to read when you
   * are already asking for host info; this exists so an About box does not have to probe
   * the whole shell (and the whole DAW) to print one number. Optional like everything else
   * here — in the browser and on an older shell it is simply absent, and the caller shows
   * whatever it already knows.
   */
  getAppVersion?(): Promise<string | null>;

  /**
   * Open an http/https link in the user's real browser.
   *
   * The webview must never navigate away from the app itself — inside a DAW there is no
   * back button and no address bar, so a link that navigated in place would strand the
   * user in a web page with their unsaved session behind it. The host refuses anything
   * that is not http or https; resolves false when it declined or the OS would not open it.
   */
  openExternal?(url: string): Promise<boolean>;

  // --- audio the shell is holding for us ------------------------------------------------
  /**
   * Declare the complete set of takes this session is using.
   *
   * The shell no longer OWNS decoded audio — it indexes it, and a take lives exactly as long as
   * something is genuinely using it. A token is a string, not a reference, so the page has to
   * say which ones it still wants or its takes would be the only holders left and vanish.
   *
   * Deliberately declarative — the full set, replacing the previous declaration — so a page
   * interrupted halfway through swapping takes cannot leak one. The next declaration sweeps.
   */
  /**
   * Tell the host to stop holding a recording for playback.
   *
   * The counterpart to `loadOriginal`, and the ONLY thing that actually frees it. Telling our own
   * transport there is no original does nothing to the audio side: importing a MIDI file over a
   * loaded wav used to strand about 100 MB for the life of the plugin instance.
   */
  unloadOriginal?(): Promise<void>;
  pcmRetain?(tokens: string | string[] | null): Promise<unknown>;
  /** Drop these, or everything when called with nothing. */
  pcmRelease?(tokens?: string | string[]): Promise<unknown>;
  /**
   * How much decoded audio is resident, and who is holding it.
   *
   * Pull-only. This is the number that proves the leak stayed fixed: every recording ever
   * opened used to stay in memory forever, three copies each, which is roughly 318 MB per
   * ten-minute take on a machine with 8 GB.
   */
  pcmDiagnostics?(): Promise<Record<string, unknown>>;

  // --- the transcription engine ---------------------------------------------------------
  /**
   * What the engine is doing, machine-wide. See `EngineStatus`.
   *
   * Pulled, never pushed: it is only interesting when somebody is looking at the settings
   * panel or waiting for a transcription, and a permanently running poll on an idle plugin is
   * exactly the sort of thing that makes a DAW feel heavy.
   *
   * With no argument it answers for the RESOLVED engine — exactly what it has always answered
   * for, on a shell that only ever had one. Pass an id to ask about a particular engine; an
   * unknown id is an error, not an empty answer.
   */
  engineStatus?(id?: string): Promise<EngineStatus | null>;

  /**
   * Every engine this build can offer, and which one is in charge.
   *
   * Cheap and pull-only — the compiled-in manifest table plus each adapter's cached status —
   * so the settings panel polls it on the same two-second tick as `engineStatus()` rather than
   * on a timer of its own. Absent on a shell that predates the engine registry, in which case
   * the screen falls back to the single-engine layout it has always drawn.
   */
  listEngines?(): Promise<EngineListResult | null>;

  /**
   * Choose the engine, machine-wide and for good (it lands in `<appSupport>/engine.json`).
   *
   * Refuses while anything on this machine is transcribing, for the same reason the model
   * cannot be swapped mid-job, and refuses an id it does not know. It does NOT refuse an
   * engine that is not installed yet — that is how "Select" works next to "Install"; the
   * resolution then falls back and `reason` says why.
   */
  selectEngine?(id: string): Promise<{
    ok: boolean;
    configuredEngine?: string;
    resolvedEngine?: string;
    reason?: string;
    error?: string;
  }>;

  /**
   * Download and set up a one-click engine.
   *
   * Modelled on `transcribe()`: the native call resolves at once with a job id and the answer
   * arrives on an event, and this method rejoins the two so the caller simply awaits the
   * outcome. Progress arrives separately through `onEngineInstallProgress`.
   *
   * Only ever offered for `install: 'one-click'` engines. A `guide` engine has no download at
   * all — not as a policy note, as a missing field in its manifest.
   */
  installEngine?(id: string): Promise<EngineInstallResult>;

  /** Abandon an install. With no id, abandons whatever is running. */
  cancelInstall?(jobId?: number): Promise<{ cancelled: number }>;

  /**
   * Remove a one-click engine and give the disk space back.
   *
   * Refuses for `bundled` and `guide` engines: Riffsheet did not put those there and does not
   * get to take them away — the same principle as never killing a server it merely adopted.
   */
  uninstallEngine?(id: string): Promise<{ ok: boolean; freedBytes?: number; error?: string }>;

  /** Install progress frames. Returns an unsubscribe function. */
  onEngineInstallProgress?(handler: (progress: EngineInstallProgress) => void): () => void;

  /**
   * Run engine discovery again and answer with the fresh status.
   *
   * The "Check again" button on the engine setup screen. Discovery runs once when the plugin
   * loads, so somebody who installs the engine with the window open would otherwise have to
   * restart their DAW to be found. Same payload as `engineStatus()`, so the screen renders one
   * shape of data either way.
   */
  recheckEngine?(): Promise<EngineStatus | null>;

  /**
   * Abandon a transcription — including one that is only waiting its turn.
   *
   * Waiting for another Riffsheet to finish is a wait you must be able to walk away from;
   * without this, a queued job is a progress bar with no exit.
   */
  transcribeCancel?(jobId?: number): Promise<{ cancelled: number }>;

  /**
   * Shut the listener down now and give its memory back.
   *
   * Mostly redundant since the engine started dying at the end of every job; what is left for
   * it is a server left up by a job that was queued behind somebody else's. Refuses, with a
   * plain sentence, when there is nothing to stop, when a transcription is running, or when the
   * server belongs to somebody else — Riffsheet borrows a server the user started themselves
   * and stopping that would be taking something that is not ours.
   */
  stopEngine?(): Promise<{ stopped: boolean; reason: string }>;

  /**
   * Stop a listener Riffsheet did NOT start, after the user has been told it is not ours.
   *
   * `stopEngine()` refuses an adopted server on principle — Riffsheet borrows a server the
   * user started themselves and killing it would be taking something that is not ours. That
   * principle is right as a default and wrong as an absolute: the person being refused is
   * usually the same person who started it, they are looking at a notice saying 1.5 GB is
   * being held, and "it is not mine to stop" is not an answer they can act on.
   *
   * So this is the escape hatch, and it is deliberately a SEPARATE call rather than a flag on
   * `stopEngine`: an explicit second gesture, after an explicit notice, is the only thing that
   * makes killing somebody else's process defensible. Nothing calls it automatically.
   *
   * It must still refuse mid-job — a transcription in flight anywhere on this machine is the
   * one rule that has no override — and it answers with the same `{ stopped, reason }` shape
   * `stopEngine` does so one piece of UI renders either outcome.
   *
   * NOT YET IN THE SHELL. Registered here and implemented in the browser mock so the button
   * and its harness check are real; `hasNativeFunction('stopExternalEngine')` is the truthful
   * capability test, and the notice simply carries no button on a shell without it.
   */
  stopExternalEngine?(): Promise<{ stopped: boolean; reason: string }>;

  /**
   * "I already have this engine — it is over there."
   *
   * The one-click cards can download an engine, and for somebody who installed the same thing
   * last year that is several hundred megabytes of pointless traffic and a second copy on
   * disk. This is the other door: point Riffsheet at the copy that is already here, have it
   * checked, and use it.
   *
   * ONE CALL, TWO JOBS, chosen over two calls because the shell has to do the same work for
   * both and a second entry point is a second thing to keep in step:
   *
   *  - `path === ''` means SNIFF: look in the places this engine is normally installed and
   *    answer with what was found. `path` on the way back is where it is.
   *  - a non-empty `path` means VALIDATE THAT: is a working copy of engine `id` at this
   *    location, and if not, why not.
   *
   * `detail` is a sentence for the player either way — "Found a working copy at …" or "That
   * folder has no `bin/muscriptor` in it" — because the useful half of a failed check is
   * knowing what was looked for. `ok: true` means the engine is usable from that path and
   * Riffsheet has recorded it; the card then behaves exactly as it does after an install.
   *
   * IN THE SHELL SINCE WAVE 5, and the shape did not have to change to get there — which was
   * the point of keeping it to two strings in and a boolean plus two strings out. What the
   * shell does with it is per engine and deliberately a FILE check rather than an execution:
   * `transkun` is present when its console script is in an environment's `bin`, `bass-v2` when
   * a checkout has both `infer.py` and a checkpoints folder with weights in it. Running a
   * stranger's script to find out whether it is installed is a bigger promise than this call
   * makes, and on a broken venv it hangs. `hasNativeFunction` is still the capability test: an
   * older shell has no such call and the card simply carries no box.
   */
  validateExistingEngineInstall?(
    id: string,
    path: string
  ): Promise<{ ok: boolean; detail: string; path?: string; searched?: string[] }>;

  /**
   * Beats, and nothing else.
   *
   * WHY IT EXISTS. Beat tracking has never belonged to an engine here — it is a bundled model
   * the shell runs for all of them, as a sub-phase of `transcribe` gated on `preciseBeats`. That
   * worked while every engine ran in the shell. Riffsheet's own engine runs HERE, so a take
   * transcribed locally would have notes and no grid, and the only way to reach the tracker was
   * to start a whole transcription and throw its notes away.
   *
   * Same tracker, same numbers, no engine involved. It takes no turn in the engine queue, so it
   * does not wait behind somebody else's four-minute job.
   *
   * Optional: `hasNativeFunction('trackBeats')` is the capability test, and a page on an older
   * shell keeps its notes and goes without a grid rather than hanging on a call nobody answers.
   */
  trackBeats?(source: AudioFileRef | CaptureResult): Promise<{
    beats: number[];
    downbeats: number[];
    bpm: number | null;
    beatsPerBar: number | null;
  }>;

  /**
   * Ask for different weights.
   *
   * Restarts the server when we own it. Refuses — politely, with a sentence the user can act
   * on — when we adopted a server somebody else started, because that one is not ours to
   * restart.
   */
  setEngineModel?(model: 'auto' | 'small' | 'medium' | 'large'): Promise<{
    ok: boolean;
    model?: string;
    restarted?: boolean;
    error?: string;
  }>;

  /**
   * The raw, uninterpreted playhead the host handed us, plus the marks a capture recorded.
   *
   * A diagnostic and nothing else: when the sheet's tempo disagrees with the DAW's, this is
   * the one call that answers "what did the DAW actually say?" instead of inviting a guess.
   */
  hostTimelineProbe?(): Promise<Record<string, unknown>>;

  // --- per-instance persistence ---------------------------------------------------------
  /**
   * The page's own state, parked somewhere that outlives the page.
   *
   * THIS IS THE FIX FOR PLUGIN AMNESIA. In a DAW the plugin editor — WebView, document,
   * every JavaScript object in it — is destroyed the moment the user clicks another track
   * or another FX, and rebuilt from nothing when they come back. Anything the app held in
   * memory is gone. The host's processor is the only thing that survives, so the app hands
   * its state down on every meaningful change and asks for it back on boot.
   *
   * The string is opaque to the host: webcore owns the schema (see app/persist.ts) and
   * versions it, so the two sides can change independently.
   *
   * Optional, both of them, and independently so: a host without them degrades to "no
   * session restore", which is exactly the old behaviour. They must NEVER be called
   * speculatively in the JUCE shell — an unregistered native function hangs rather than
   * failing (see bridge/juce.ts hasNativeFunction).
   */
  getPersistedState?(): Promise<string | null>;
  /** Hand the host a new blob. Pass an empty string to clear it. */
  setPersistedState?(json: string): Promise<void>;
}
