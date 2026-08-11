/**
 * The real JUCE bridge, adapted to webcore's NativeBridge interface.
 *
 * Written against shell/BRIDGE.md (Team A) + Source/bridge/NativeBridge.cpp. Where the two
 * disagree, the C++ wins and BRIDGE.md is the bug.
 *
 * Four things about the shell's contract that shape this file:
 *
 *  1. **Errors resolve, they do not reject.** Every native call comes back as
 *     `{ ok: false, error }` or `{ ok: false, cancelled: true }`. `call()` below turns the
 *     first into a thrown Error (so the UI's try/catch works) and the second into null.
 *  2. **Audio samples do not come through the JSON bridge.** An `AudioRef` carries a
 *     `pcmUrl`; the floats are fetched as binary. Nothing here ever base64s a waveform.
 *  3. **Transcription is a job, not a promise.** `transcribe()` resolves instantly with a
 *     `jobId`; the answer arrives on the `transcribeResult` event. This file rejoins them.
 *  4. **`Juce` comes from a classic script** the shell serves at `./juce/juce-global.js`.
 *     It is loaded lazily and only when `window.__JUCE__` exists, so a plain browser never
 *     404s on it.
 */

import type {
  AudioFileRef,
  CaptureContext,
  CaptureResult,
  CaptureState,
  DroppedInputResult,
  EngineInstall,
  EngineInstallProgress,
  EngineInstallResult,
  EngineListResult,
  EngineState,
  EngineStatus,
  EngineSummary,
  ExportOutcome,
  ExportPayload,
  GuideStep,
  HostInfo,
  NativeBridge,
  PickedInputFile,
  PlaybackState,
  TranscribeOptions,
  TranscribeProgress,
  TranscribeResult
} from './types';
import type { NativeOmrResult, OmrStatus } from '../import/scoreImage';

// ---------------------------------------------------------------------------
// JUCE globals
// ---------------------------------------------------------------------------

interface JuceBackend {
  addEventListener(name: string, handler: (payload: unknown) => void): void;
  removeEventListener?(name: string, handler: (payload: unknown) => void): void;
}

interface JuceGlobal {
  getNativeFunction(name: string): (...args: unknown[]) => Promise<unknown>;
}

declare global {
  interface Window {
    Juce?: JuceGlobal;
    __JUCE__?: {
      backend: JuceBackend;
      /** Injected natively before any of our script runs. */
      initialisationData?: { __juce__functions?: string[] };
    };
  }
}

/** True when the page is running inside the JUCE shell. */
export function isJuceHost(): boolean {
  return typeof window !== 'undefined' && !!window.__JUCE__?.backend;
}

/**
 * Does the shell actually implement this native function?
 *
 * This is not defensive paranoia — calling a name the backend does not know is a HANG, not
 * an error: `getNativeFunction` happily builds a binding for any string, emits
 * `__juce__invoke`, and the C++ side silently drops an unknown name, so the promise never
 * settles. JUCE publishes the registered names in
 * `window.__JUCE__.initialisationData.__juce__functions` (its own `getNativeFunction` warns
 * off that same list), so capability detection is exact and free.
 *
 * Used for the optional parts of the contract, so webcore can ship ahead of the shell.
 */
export function hasNativeFunction(name: string): boolean {
  const names = window.__JUCE__?.initialisationData?.__juce__functions;
  // An older shell may not publish the list at all. Only *deny* on a list that exists.
  return Array.isArray(names) ? names.includes(name) : false;
}

let juceReady: Promise<JuceGlobal> | null = null;

/**
 * Load the shell's classic build of JUCE's frontend library.
 *
 * `window.__JUCE__` is injected natively and is present before any of our script runs;
 * `window.Juce` is the helper library and has to be fetched. We only ask for it when the
 * native side is there, so the browser dev path never sees a failed request.
 */
function loadJuce(): Promise<JuceGlobal> {
  if (juceReady) return juceReady;
  juceReady = new Promise((resolve, reject) => {
    if (window.Juce) return resolve(window.Juce);
    const script = document.createElement('script');
    script.src = './juce/juce-global.js';
    script.onload = () =>
      window.Juce ? resolve(window.Juce) : reject(new Error('juce-global.js loaded but window.Juce is missing'));
    script.onerror = () => reject(new Error('Could not load ./juce/juce-global.js'));
    document.head.appendChild(script);
  });
  return juceReady;
}

const fnCache = new Map<string, (...args: unknown[]) => Promise<unknown>>();

async function nativeFn(name: string): Promise<(...args: unknown[]) => Promise<unknown>> {
  const cached = fnCache.get(name);
  if (cached) return cached;
  const juce = await loadJuce();
  const fn = juce.getNativeFunction(name);
  fnCache.set(name, fn);
  return fn;
}

type NativeResult = Record<string, unknown> & { ok?: boolean; error?: string; cancelled?: boolean };

/** Call a native function. Throws on `{ok:false}`; returns null on `{cancelled:true}`. */
async function call<T = NativeResult>(name: string, ...args: unknown[]): Promise<T | null> {
  const fn = await nativeFn(name);
  const result = (await fn(...args)) as NativeResult;
  if (result && result.ok === false) {
    if (result.cancelled) return null;
    throw new Error(result.error ?? `${name} failed`);
  }
  return result as T;
}

/** Subscribe to a native event. Returns an unsubscribe function. */
function onEvent(name: string, handler: (payload: never) => void): () => void {
  const backend = window.__JUCE__?.backend;
  if (!backend) return () => {};
  const wrapped = (payload: unknown) => handler(payload as never);
  backend.addEventListener(name, wrapped);
  return () => backend.removeEventListener?.(name, wrapped);
}

// ---------------------------------------------------------------------------
// Shell payload shapes (BRIDGE.md §2)
// ---------------------------------------------------------------------------

interface ShellAudioRef {
  token: string;
  path: string;
  name: string;
  sampleRate: number;
  numFrames: number;
  durationSec: number;
  pcmUrl: string;
}

interface ShellPickedBytes {
  kind: 'bytes';
  path: string;
  name: string;
  contents: string;
}

type ShellDroppedInput =
  | (ShellAudioRef & { ok?: true })
  | (ShellPickedBytes & { ok?: true })
  | { ok: false; name?: string; error?: string };

interface ShellCaptureState {
  mode: 'off' | 'armed' | 'recording' | 'finished';
  armedToTransport: boolean;
  secondsCaptured: number;
  maxSeconds: number;
  sampleRate: number;
  hitLimit: boolean;
}

interface ShellCaptureContext {
  hasHostTimeline: boolean;
  hostBpm: number | null;
  hostTimeSigNumerator: number | null;
  hostTimeSigDenominator: number | null;
  /** False when no recorded block carried a meter. Never guess one from this. */
  hostTimeSigKnown?: boolean;
  hostTimeSigInferred?: boolean;
  barStartsSec: number[];
  /** Plain sentences about anything the host was vague on. Shown, not swallowed. */
  ambiguities?: string[];
}

interface ShellPlaybackState {
  loaded: boolean;
  isPlaying: boolean;
  positionSec: number;
  lengthSec: number;
  gain: number;
  token: string;
}

interface ShellHostInfo {
  isPlugin: boolean;
  format: string;
  hostName: string;
  hostBpm: number | null;
  /**
   * The DAW's meter, as nulls when the host said nothing.
   *
   * These have been on the wire since v1.1 and webcore simply never read them, which is why
   * "synced to DAW grid" could only ever work for a captured take: a dropped wav had nowhere
   * to get a tempo from. See app.ts `liveHostGrid()`.
   */
  hostTimeSigNumerator: number | null;
  hostTimeSigDenominator: number | null;
  hasHostTimeline?: boolean;
  isPlaying: boolean;
  ppqPosition?: number | null;
  ppqPositionOfLastBarStart?: number | null;
}

interface ShellEngineStatus {
  state?: string;
  port?: number;
  adopted?: boolean;
  model?: string;
  configuredModel?: string;
  installedModels?: string[];
  busy?: boolean;
  busyOwner?: string | null;
  queueLength?: number;
  queuePosition?: number;
  ramTotalMb?: number;
  ramFreeMb?: number;
  stopsAfterEachJob?: boolean;
  idleSeconds?: number;
  canStop?: boolean;
  externalServer?: boolean;
  canStopExternal?: boolean;
  memoryMb?: number | null;
  models?: Array<{ name?: string; approxResidentMb?: number; installed?: boolean; fits?: boolean }>;
  searchedPaths?: string[];
  venv?: string;
  executable?: string;
  engineInstalled?: boolean;
  setupDirectory?: string;
  engineConfigPath?: string;
  engineConfigExists?: boolean;
  error?: string | null;
  // Added by the multi-engine shell (BRIDGE.md §3.2). Absent on every older one.
  id?: string;
  configuredEngine?: string;
  resolvedEngine?: string;
  engineReason?: string;
  install?: string;
  guideSteps?: Array<string | { what?: string; detail?: string }>;
}

interface ShellEngineSummary {
  id?: string;
  name?: string;
  tier?: string;
  summary?: string;
  sourceUrl?: string;
  install?: string;
  state?: string;
  selected?: boolean;
  instrumentStrengths?: string[];
  acceptsInstrumentConstraint?: boolean;
  producesBeatGrid?: boolean;
  producesConfidence?: boolean;
  producesVelocity?: boolean;
  approxDiskBytes?: number;
  approxPeakRssMb?: number;
  installing?: boolean;
  detail?: string;
  error?: string | null;
  /** Optional addition — a shell older than the card overhaul does not send it. See types.ts. */
  license?: string;
}

interface ShellEngineList {
  configuredEngine?: string;
  resolvedEngine?: string;
  engineReason?: string;
  nativeFallbackEngine?: string;
  engines?: ShellEngineSummary[];
}

const ENGINE_INSTALLS: readonly EngineInstall[] = ['bundled', 'one-click', 'guide'];
const ENGINE_STATES: readonly EngineState[] = ['ready', 'installed', 'not-installed', 'broken'];

/** An install kind the shell actually named, or nothing. Never a plausible substitute. */
function toEngineInstall(value: unknown): EngineInstall | undefined {
  return (ENGINE_INSTALLS as readonly string[]).includes(value as string)
    ? (value as EngineInstall)
    : undefined;
}

/**
 * Guide steps, in whichever of the two shapes the shell sent.
 *
 * BRIDGE.md types this `string[]`; the engine manifest carries `{what, detail}` pairs and the
 * renderer draws both halves. Rather than pick one and lose the other, a bare string becomes a
 * heading with no detail — which is exactly what a flat list means.
 */
function toGuideSteps(value: unknown): GuideStep[] {
  if (!Array.isArray(value)) return [];
  const steps: GuideStep[] = [];
  for (const step of value) {
    if (typeof step === 'string') {
      if (step.length > 0) steps.push({ what: step, detail: '' });
    } else if (step && typeof step === 'object') {
      const what = (step as { what?: unknown }).what;
      const detail = (step as { detail?: unknown }).detail;
      if (typeof what === 'string' && what.length > 0) {
        steps.push({ what, detail: typeof detail === 'string' ? detail : '' });
      }
    }
  }
  return steps;
}

/**
 * One shell payload -> one EngineStatus, shared by `engineStatus()` and `recheckEngine()`.
 *
 * Both answer with exactly the same object — the setup screen renders one shape whether it
 * polled or the player pressed Check again — so the normalising belongs in one place. Every
 * field is defaulted rather than trusted: a shell one version behind simply omits the newer
 * ones, and the screen has to degrade to "not reported" instead of throwing.
 */
function toEngineStatus(s: ShellEngineStatus | null): EngineStatus | null {
  if (!s) return null;
  const state = s.state;
  return {
    state:
      state === 'ready' || state === 'starting' || state === 'failed' || state === 'stopped'
        ? state
        : 'stopped',
    port: s.port ?? 0,
    adopted: s.adopted === true,
    model: s.model ?? 'unknown',
    configuredModel: s.configuredModel,
    installedModels: Array.isArray(s.installedModels) ? s.installedModels : [],
    busy: s.busy === true,
    busyOwner: s.busyOwner === 'self' || s.busyOwner === 'other' ? s.busyOwner : null,
    queueLength: s.queueLength ?? 0,
    queuePosition: s.queuePosition ?? 0,
    ramTotalMb: s.ramTotalMb,
    ramFreeMb: s.ramFreeMb,
    stopsAfterEachJob: s.stopsAfterEachJob === true,
    idleSeconds: s.idleSeconds,
    canStop: s.canStop === true,
    externalServer: s.externalServer === true,
    canStopExternal: s.canStopExternal === true,
    memoryMb: s.memoryMb ?? null,
    // Kept only when a row is complete. A size with no name or no figure would draw as
    // "undefined 0 GB" on the card, and half a size table is worse than none.
    models: Array.isArray(s.models)
      ? s.models
          .filter((m) => typeof m?.name === 'string' && typeof m.approxResidentMb === 'number')
          .map((m) => ({
            name: m.name as string,
            approxResidentMb: m.approxResidentMb as number,
            installed: m.installed === true,
            // Absent means "this shell did not say", and the honest reading of that is "no
            // reason to think it does not fit" — never a warning nobody asked for.
            fits: m.fits !== false
          }))
      : undefined,
    searchedPaths: Array.isArray(s.searchedPaths) ? s.searchedPaths : [],
    venv: s.venv,
    executable: s.executable,
    engineInstalled: s.engineInstalled === true,
    setupDirectory: s.setupDirectory,
    engineConfigPath: s.engineConfigPath,
    engineConfigExists: s.engineConfigExists === true,
    error: s.error ?? null,
    // Multi-engine fields. Left UNDEFINED rather than defaulted when the shell said nothing:
    // an older shell has exactly one engine and inventing an id for it would make the picker
    // claim a choice that does not exist.
    id: s.id,
    configuredEngine: s.configuredEngine,
    resolvedEngine: s.resolvedEngine,
    engineReason: s.engineReason,
    install: toEngineInstall(s.install),
    guideSteps: toGuideSteps(s.guideSteps)
  };
}

/** One shell engine row -> one EngineSummary. Every field defaulted, nothing trusted. */
function toEngineSummary(e: ShellEngineSummary): EngineSummary {
  const state = ENGINE_STATES.includes(e.state as EngineState) ? (e.state as EngineState) : 'not-installed';
  return {
    id: typeof e.id === 'string' ? e.id : '',
    name: typeof e.name === 'string' && e.name.length > 0 ? e.name : (e.id ?? 'Engine'),
    tier: typeof e.tier === 'string' ? e.tier : '',
    summary: typeof e.summary === 'string' ? e.summary : '',
    sourceUrl: typeof e.sourceUrl === 'string' ? e.sourceUrl : '',
    install: toEngineInstall(e.install) ?? 'guide',
    state,
    selected: e.selected === true,
    instrumentStrengths: Array.isArray(e.instrumentStrengths) ? e.instrumentStrengths : [],
    acceptsInstrumentConstraint: e.acceptsInstrumentConstraint === true,
    producesBeatGrid: e.producesBeatGrid === true,
    producesConfidence: e.producesConfidence === true,
    producesVelocity: e.producesVelocity === true,
    approxDiskBytes: typeof e.approxDiskBytes === 'number' ? e.approxDiskBytes : 0,
    approxPeakRssMb: typeof e.approxPeakRssMb === 'number' ? e.approxPeakRssMb : 0,
    installing: e.installing === true,
    detail: typeof e.detail === 'string' ? e.detail : '',
    error: typeof e.error === 'string' && e.error.length > 0 ? e.error : null,
    // Left UNDEFINED when the shell does not send them, never defaulted to a string. The card
    // draws a licence line only when it has been told a licence, because the alternative is
    // printing "Unknown" next to somebody's engine, which is worse than printing nothing.
    license: typeof e.license === 'string' && e.license.length > 0 ? e.license : undefined
  };
}

function toEngineList(list: ShellEngineList | null): EngineListResult | null {
  if (!list || !Array.isArray(list.engines)) return null;
  // An engine with no id cannot be selected, installed or drawn — drop it rather than render a
  // card whose every button would address nothing.
  const engines = list.engines.map(toEngineSummary).filter((e) => e.id.length > 0);
  return {
    configuredEngine: typeof list.configuredEngine === 'string' ? list.configuredEngine : 'auto',
    resolvedEngine:
      typeof list.resolvedEngine === 'string' && list.resolvedEngine.length > 0
        ? list.resolvedEngine
        : (engines.find((e) => e.selected)?.id ?? ''),
    engineReason: typeof list.engineReason === 'string' ? list.engineReason : '',
    // Carried only when the shell said it. A build that predates the in-page engine sends no
    // such key, and on that shell nothing ever needs one — see EngineListResult.
    ...(typeof list.nativeFallbackEngine === 'string' && list.nativeFallbackEngine.length > 0
      ? { nativeFallbackEngine: list.nativeFallbackEngine }
      : {}),
    engines
  };
}

interface ShellEngineInstallProgress {
  jobId?: number;
  id?: string;
  stage?: string;
  message?: string;
  receivedBytes?: number;
  totalBytes?: number;
  fraction?: number;
  bytesPerSec?: number;
  etaSec?: number;
}

interface ShellEngineInstallResult {
  jobId?: number;
  id?: string;
  ok?: boolean;
  bytesOnDisk?: number;
  elapsedMs?: number;
  location?: string;
  error?: string;
  cancelled?: boolean;
  guideSteps?: Array<string | { what?: string; detail?: string }>;
}

const INSTALL_STAGES: readonly EngineInstallProgress['stage'][] = [
  'checking',
  'downloading',
  'verifying',
  'extracting',
  'installing',
  'probing'
];

interface ShellTranscribeResult {
  jobId: number;
  ok: boolean;
  error?: string;
  notes?: Array<{
    pitch: number;
    start: number;
    end: number;
    instrument: string;
    index: number;
    /** 0..1, from the engines that measure it (Basic Pitch does; MuScriptor does not). */
    confidence?: number;
  }>;
  beatGrid?: { bpm: number; beatsPerBar: number | null; firstDownbeat: number; beats?: number[] } | null;
  preciseBeats?: { beats: number[]; downbeats: number[]; bpm: number; beatsPerBar?: number | null };
  /**
   * Present only when this engine asked for preparation and the player left it on. Every time
   * in this payload is already mapped back into the recording's own timebase — see BRIDGE.md.
   */
  preprocess?: {
    applied: boolean;
    note: string;
    cents?: number;
    concentration?: number;
    peaks?: number;
    pitchRatio?: number;
    gainDb?: number;
    peakDbfs?: number;
  };
}

interface ShellTranscribeProgress {
  jobId: number;
  stage: string;
  fraction?: number;
  message?: string;
  completed?: number;
  total?: number;
  /** Set while `stage` is 'queued': our place in the machine-wide engine queue. */
  queuePosition?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** AudioRef -> webcore's AudioFileRef, carrying the token/pcmUrl instead of bytes. */
function toAudioFileRef(ref: ShellAudioRef): AudioFileRef {
  return {
    path: ref.path,
    name: ref.name,
    durationSec: ref.durationSec,
    sampleRate: ref.sampleRate,
    token: ref.token,
    pcmUrl: ref.pcmUrl,
    numFrames: ref.numFrames
  };
}

function toCaptureState(s: ShellCaptureState): CaptureState {
  return {
    phase:
      s.mode === 'recording' ? 'recording' : s.mode === 'armed' ? 'armed' : s.mode === 'finished' ? 'finishing' : 'idle',
    capturedSec: s.secondsCaptured,
    hostIsPlaying: s.mode === 'recording'
  };
}

/**
 * The DAW's live tempo and meter, read strictly.
 *
 * `null` means "the host said nothing" and must survive as null all the way to the UI: a
 * standalone app has no tempo, and quietly turning that into 120/4-4 is precisely the class of
 * bug the user reported ("the DAW says 222 and 3/6, Riffsheet says 102 and 4/4"). A partial
 * answer is reported partially — a host that gives a tempo but no time signature yields a bpm
 * and a null signature, never a made-up 4/4.
 */
function toHostTimeline(host: ShellHostInfo | null): Partial<HostInfo> {
  if (!host?.isPlugin) return { hasHostTimeline: false, bpm: null, timeSignature: null };
  const num = host.hostTimeSigNumerator;
  const den = host.hostTimeSigDenominator;
  const sig =
    typeof num === 'number' && typeof den === 'number' && num > 0 && den > 0
      ? { numerator: num, denominator: den }
      : null;
  const bpm = typeof host.hostBpm === 'number' && host.hostBpm > 0 ? host.hostBpm : null;
  return {
    bpm,
    timeSignature: sig,
    // An older shell does not send the flag; infer it from having said anything at all.
    hasHostTimeline: host.hasHostTimeline ?? (bpm !== null || sig !== null),
    isPlaying: host.isPlaying === true,
    ppqPosition: typeof host.ppqPosition === 'number' ? host.ppqPosition : null,
    ppqOfLastBarStart:
      typeof host.ppqPositionOfLastBarStart === 'number' ? host.ppqPositionOfLastBarStart : null
  };
}

/**
 * A capture's measured DAW grid — or nothing, and never a plausible substitute.
 *
 * The `?? 4` that used to sit on the numerator and denominator here was half of the reported
 * bug. A host that raises its time-signature flag one block late left the shell reporting null,
 * this function turned that into 4/4, and the sheet then displayed a confident 4/4 next to a lit
 * "synced to DAW grid" chip while REAPER was in 3/6. The shell now says explicitly whether it
 * knows (`hostTimeSigKnown`), so an unknown meter means no host grid at all rather than an
 * invented one — the tempo alone is still available through `getHostInfo()`, which is a weaker
 * claim honestly made instead of a stronger one falsely.
 */
function toCaptureContext(ctx: ShellCaptureContext | undefined): CaptureContext | undefined {
  if (!ctx?.hasHostTimeline || !ctx.barStartsSec?.length) return undefined;
  if (ctx.hostBpm === null) return undefined;
  const known = ctx.hostTimeSigKnown ?? (ctx.hostTimeSigNumerator !== null && ctx.hostTimeSigDenominator !== null);
  if (!known || ctx.hostTimeSigNumerator === null || ctx.hostTimeSigDenominator === null) return undefined;
  return {
    hostBpm: ctx.hostBpm,
    hostTimeSig: {
      numerator: ctx.hostTimeSigNumerator,
      denominator: ctx.hostTimeSigDenominator
    },
    barStartsSec: ctx.barStartsSec,
    ...(ctx.ambiguities?.length ? { ambiguities: ctx.ambiguities } : {})
  };
}

/**
 * Interpret a save result. BRIDGE.md §2 "Output":
 *
 *   { ok: true, path, bytes }  |  { ok: false, cancelled: true }  |  { ok: false, error }
 *
 * Read strictly: **only** an explicit `cancelled` counts as a cancel. An older shell that
 * answered `{ ok: true }` with no path, or answered nothing at all, must still read as
 * saved — treating a missing path as a cancel would swap one lying toast for another.
 */
function toExportOutcome(result: NativeResult | undefined, count: number): ExportOutcome {
  if (result && result.ok === false) {
    if (result.cancelled) return { saved: false };
    throw new Error(result.error ?? 'The file could not be saved.');
  }
  const path = typeof result?.path === 'string' ? result.path : undefined;
  return { saved: true, path, count };
}

/** Base64 without blowing the argument limit on a multi-megabyte export. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(contents: string): Uint8Array {
  const binary = atob(contents.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export function createJuceBridge(): NativeBridge {
  const playbackHandlers = new Set<(s: PlaybackState) => void>();
  const captureHandlers = new Set<(s: CaptureState) => void>();
  const inputDropHandlers = new Set<(result: DroppedInputResult) => void>();
  const installHandlers = new Set<(p: EngineInstallProgress) => void>();
  let lastCapture: CaptureState = { phase: 'idle', capturedSec: 0, hostIsPlaying: false };

  // Install progress. Subscribed once for the life of the bridge, exactly like capture state:
  // the shell only emits these while an install is running, so an idle plugin pays nothing,
  // and a card that opens mid-install joins the frames already in flight.
  onEvent('engineInstallProgress', (p: ShellEngineInstallProgress) => {
    if (installHandlers.size === 0) return;
    const stage = INSTALL_STAGES.includes(p.stage as EngineInstallProgress['stage'])
      ? (p.stage as EngineInstallProgress['stage'])
      : 'installing';
    const frame: EngineInstallProgress = {
      jobId: p.jobId ?? 0,
      id: typeof p.id === 'string' ? p.id : '',
      stage,
      message: typeof p.message === 'string' ? p.message : undefined,
      receivedBytes: typeof p.receivedBytes === 'number' ? p.receivedBytes : undefined,
      totalBytes: typeof p.totalBytes === 'number' ? p.totalBytes : undefined,
      fraction: typeof p.fraction === 'number' ? p.fraction : undefined,
      bytesPerSec: typeof p.bytesPerSec === 'number' ? p.bytesPerSec : undefined,
      etaSec: typeof p.etaSec === 'number' ? p.etaSec : undefined
    };
    for (const handler of installHandlers) handler(frame);
  });

  onEvent('inputFileDropped', (result: ShellDroppedInput) => {
    let mapped: DroppedInputResult;
    if (result.ok === false) {
      mapped = {
        ok: false,
        name: result.name ?? 'Dropped file',
        error: result.error ?? 'The native shell could not open that file.'
      };
    } else if ('contents' in result) {
      mapped = {
        ok: true,
        input: {
          kind: 'bytes',
          path: result.path,
          name: result.name,
          bytes: fromBase64(result.contents)
        }
      };
    } else {
      mapped = { ok: true, input: { kind: 'audio', audio: toAudioFileRef(result) } };
    }
    for (const handler of inputDropHandlers) handler(mapped);
  });

  onEvent('playbackPosition', (p: ShellPlaybackState) => {
    const state: PlaybackState = {
      isPlaying: p.isPlaying,
      positionSec: p.positionSec,
      durationSec: p.lengthSec,
      // Forwarded so the transport can tell "the shell has nothing loaded" apart from
      // "the shell has gone quiet". The two used to look identical from up here, and the
      // first one silently became a frozen playhead.
      loaded: p.loaded
    };
    for (const h of playbackHandlers) h(state);
  });

  onEvent('captureState', (s: ShellCaptureState) => {
    lastCapture = toCaptureState(s);
    for (const h of captureHandlers) h(lastCapture);
  });

  // The DAW's tempo and meter as they change. The shell change-gates this and caps it at
  // 20 Hz, so an idle plugin fires nothing at all.
  // Build the drag binding now rather than at drag time. `nativeFn` loads juce-global.js on
  // first use, and doing that from inside a pointermove would put a real suspension between
  // the mouse moving and the native call — which is exactly the window in which macOS still
  // has a live mouse-drag to attach a dragging session to. Warmed once, cached forever.
  if (hasNativeFunction('beginMidiDrag')) void nativeFn('beginMidiDrag').catch(() => {});

  const hostHandlers = new Set<(info: HostInfo) => void>();
  let lastHost: ShellHostInfo | null = null;
  onEvent('hostInfo', (h: ShellHostInfo) => {
    lastHost = h;
    if (hostHandlers.size === 0) return;
    const info = {
      host: h.format === 'Standalone' ? 'juce-standalone' : 'juce-plugin',
      isPlugin: h.isPlugin === true,
      hostName: h.hostName,
      engineAvailable: true,
      ...toHostTimeline(h)
    } as HostInfo;
    for (const handler of hostHandlers) handler(info);
  });

  return {
    async getHostInfo(): Promise<HostInfo> {
      const [shell, host] = await Promise.all([
        call<{ version: string; juce: string; platform: string }>('getShellInfo').catch(() => null),
        call<ShellHostInfo>('getHostInfo').catch(() => null)
      ]);
      return {
        host: host?.format === 'Standalone' ? 'juce-standalone' : 'juce-plugin',
        isPlugin: host?.isPlugin ?? false,
        hostName: host?.hostName && host.hostName !== 'Unknown' ? host.hostName : (shell?.platform ?? 'JUCE'),
        version: shell?.version,
        // The shell starts MuScriptor on demand (or adopts a running one), so the engine is
        // treated as available and a failure surfaces as a real error from transcribe().
        engineAvailable: true,
        engineMessage: shell ? `${shell.juce} · ${shell.platform}` : undefined,
        ...toHostTimeline(host)
      };
    },

    async pickAudioFile(): Promise<AudioFileRef | null> {
      // 44100 keeps A/B playback of the original sounding right; the waveform is drawn from
      // the same buffer, which is cheap enough at riff length.
      const ref = await call<ShellAudioRef>('pickAudioFile', { sampleRate: 44100 });
      return ref ? toAudioFileRef(ref) : null;
    },

    pickInputFile: hasNativeFunction('pickInputFile')
      ? async (): Promise<PickedInputFile | null> => {
          const result = await call<ShellAudioRef | ShellPickedBytes>('pickInputFile', {
            sampleRate: 44100
          });
          if (!result) return null;
          if ('contents' in result) {
            return {
              kind: 'bytes',
              path: result.path,
              name: result.name,
              bytes: fromBase64(result.contents)
            };
          }
          return { kind: 'audio', audio: toAudioFileRef(result) };
        }
      : undefined,

    onInputDropped(handler) {
      inputDropHandlers.add(handler);
      return () => inputDropHandlers.delete(handler);
    },

    // No picker: session restore already knows the path. Same rate as pickAudioFile, so a
    // restored take plays back identically to the one that was opened by hand.
    loadAudioPath: hasNativeFunction('loadAudioPath')
      ? async (path: string): Promise<AudioFileRef | null> => {
          const ref = await call<ShellAudioRef>('loadAudioPath', path, { sampleRate: 44100 });
          return ref ? toAudioFileRef(ref) : null;
        }
      : undefined,

    authorizeRecentPaths: hasNativeFunction('authorizeRecentPaths')
      ? async (paths: string[]): Promise<number> => {
          const result = await call<{ authorized: number }>('authorizeRecentPaths', paths);
          return result?.authorized ?? 0;
        }
      : undefined,

    omrStatus: hasNativeFunction('omrStatus')
      ? async (): Promise<OmrStatus> => {
          const result = await call<OmrStatus & { ok: boolean }>('omrStatus');
          return result ?? { available: false, message: 'The score reader did not answer.' };
        }
      : undefined,

    recognizeScoreImage: hasNativeFunction('recognizeScoreImage')
      ? async (name: string, bytes: Uint8Array): Promise<NativeOmrResult> => {
          const result = await call<NativeOmrResult>('recognizeScoreImage', name, toBase64(bytes));
          if (!result) throw new Error('Score recognition was cancelled.');
          return result;
        }
      : undefined,

    async transcribe(
      source,
      onProgress?: (p: TranscribeProgress) => void,
      options?: TranscribeOptions
    ): Promise<TranscribeResult> {
      const token = 'token' in source ? source.token : undefined;
      if (!token) throw new Error('That audio has not been handed to the shell yet.');

      const started = await call<{ jobId: number }>('transcribe', {
        token,
        // A HARD constraint on the model's output, not a hint — so an empty list is the
        // right thing whenever we are not certain, and it is now the default. Riffsheet was
        // built bass-first and pinned this to `electric_bass` for every take; MuScriptor is
        // good across the board and the owner plays more than bass, so the instrument picker
        // in Settings decides and "Whatever it hears" means exactly that. Only a deliberate
        // choice narrows it.
        instruments: options?.instruments ?? [],
        detectTempo: 'best-effort',
        // Off unless asked: it runs a second pass over the audio (BRIDGE.md §3). When it is
        // on, the shell returns real per-beat times and the mapping below prefers them.
        preciseBeats: options?.preciseBeats === true,
        // What may happen to the audio before the engine hears it. Sent explicitly rather
        // than left to the shell's default, because these are the player's two checkboxes.
        //
        // `=== true`, not `!== false`. The old test made a MISSING option mean "on", so any
        // caller that had not been taught about these keys — an older page against a newer
        // shell, or any call built before they existed — silently asked for the audio to be
        // rewritten. Both are opt-in now, and only an explicit true opts in. Which engines
        // they actually reach is still the shell's business: each engine's manifest says
        // whether it wants them, and one that normalises internally is left alone.
        normalizeBeforeTranscribe: options?.normalizeBeforeTranscribe === true,
        correctTuningBeforeTranscribe: options?.correctTuningBeforeTranscribe === true,
        // Only when a caller actually named one. Nothing in the UI does today — the shell
        // resolves the global choice — and sending an empty key to a shell that has never
        // heard of per-take engines is a change of call shape for no gain.
        ...(options?.engineId ? { engineId: options.engineId } : {})
      });
      if (!started) throw new Error('Transcription was cancelled.');
      const jobId = started.jobId;

      return new Promise<TranscribeResult>((resolve, reject) => {
        const offProgress = onEvent('transcribeProgress', (p: ShellTranscribeProgress) => {
          if (p.jobId !== jobId) return;
          onProgress?.({
            progress: p.fraction ?? (p.total ? (p.completed ?? 0) / p.total : 0),
            stage: p.stage === 'transcribing' ? 'listening' : p.stage,
            // Only meaningful while `stage` is 'queued' — another Riffsheet has the engine.
            queuePosition: p.queuePosition
          });
        });
        const offResult = onEvent('transcribeResult', (r: ShellTranscribeResult) => {
          if (r.jobId !== jobId) return;
          offProgress();
          offResult();
          if (!r.ok) {
            reject(new Error(r.error ?? 'Transcription failed.'));
            return;
          }
          const preciseDownbeats = r.preciseBeats?.downbeats ?? [];
          const firstGridDownbeat = r.beatGrid?.firstDownbeat;
          const downbeats =
            preciseDownbeats.length > 0
              ? preciseDownbeats
              : Number.isFinite(firstGridDownbeat)
                ? [firstGridDownbeat as number]
                : undefined;
          // Normalize the precise and constant-grid DTOs so neither the detected grouping nor
          // the first bar is lost at the native/JavaScript seam.
          const beatGrid = r.beatGrid
            ? {
                bpm: r.beatGrid.bpm,
                beatsPerBar: r.beatGrid.beatsPerBar,
                firstDownbeat: r.beatGrid.firstDownbeat,
                beats: r.beatGrid.beats
              }
            : r.preciseBeats
              ? {
                  bpm: r.preciseBeats.bpm,
                  beatsPerBar: r.preciseBeats.beatsPerBar,
                  firstDownbeat: preciseDownbeats[0],
                  beats: r.preciseBeats.beats
                }
              : undefined;
          resolve({
            // The model emits no velocity (its writer hardcodes 100), so we do not invent
            // dynamics from it — see BRIDGE.md §3. `confidence` is the opposite case: the
            // engines that measure it send a real number, and dropping it here was the only
            // reason nothing downstream could ever use it. Carried only when it arrived, so a
            // note from an engine that reports none has no key rather than an undefined one.
            notes: (r.notes ?? []).map((n) => ({
              startSec: n.start,
              endSec: n.end,
              midi: n.pitch,
              ...(typeof n.confidence === 'number' ? { confidence: n.confidence } : {})
            })),
            beats: r.preciseBeats?.beats ?? r.beatGrid?.beats,
            downbeats,
            beatGrid,
            tempoBpm: r.preciseBeats?.bpm ?? r.beatGrid?.bpm,
            // The receipt for what happened to the audio before the engine heard it. Passed
            // through whole: Settings shows `note`, and the numbers behind that sentence are
            // what a support conversation about "it came back a semitone out" needs.
            ...(r.preprocess ? { preprocess: { ...r.preprocess } } : {})
          });
        });
      });
    },

    async exportFile(name: string, bytes: Uint8Array): Promise<ExportOutcome> {
      const fn = await nativeFn('exportFile');
      return toExportOutcome((await fn(name, toBase64(bytes))) as NativeResult, 1);
    },

    // Present only when the shell registered it — see hasNativeFunction() above for why
    // this is a lookup rather than an optimistic call.
    exportFiles: hasNativeFunction('exportFiles')
      ? async (files: ExportPayload[]): Promise<ExportOutcome> => {
          const fn = await nativeFn('exportFiles');
          const payload = files.map((f) => ({ name: f.name, contents: toBase64(f.bytes) }));
          const result = (await fn(payload)) as NativeResult & { paths?: string[] };
          const outcome = toExportOutcome(result, files.length);
          return outcome.saved
            ? { ...outcome, path: result?.paths?.[0] ?? outcome.path, count: result?.paths?.length ?? files.length }
            : outcome;
        }
      : undefined,

    async captureStart(options?: { armed?: boolean }): Promise<void> {
      await call('captureStart', { armToTransport: options?.armed ?? false });
    },

    async captureStop(): Promise<CaptureResult> {
      const ref = await call<ShellAudioRef & { captureContext?: ShellCaptureContext }>('captureStop');
      if (!ref) throw new Error('Capture was cancelled.');
      const pcm = new Float32Array(await (await fetch(ref.pcmUrl)).arrayBuffer());
      return {
        pcm,
        sampleRate: ref.sampleRate,
        durationSec: ref.durationSec,
        // Unlike the token, this points at the durable WAV under Riffsheet's
        // application-support takes folder and survives a project reload.
        path: ref.path ?? '',
        pcmUrl: ref.pcmUrl,
        captureContext: toCaptureContext(ref.captureContext),
        // Kept so transcribe() and playbackLoad() can address the same take.
        token: ref.token
      };
    },

    onCaptureState(handler) {
      captureHandlers.add(handler);
      handler(lastCapture);
      void call<ShellCaptureState>('captureStatus')
        .then((s) => {
          if (s) handler(toCaptureState(s));
        })
        .catch(() => {});
      return () => captureHandlers.delete(handler);
    },

    async loadOriginal(source): Promise<{ durationSec: number }> {
      const token = 'token' in source ? source.token : undefined;
      if (!token) return { durationSec: 0 };
      const state = await call<ShellPlaybackState>('playbackLoad', token);
      return { durationSec: state?.lengthSec ?? 0 };
    },

    async play(): Promise<void> {
      await call('playbackTransport', 'play');
    },
    async pause(): Promise<void> {
      await call('playbackTransport', 'pause');
    },
    async seek(positionSec: number): Promise<void> {
      await call('playbackTransport', 'seek', positionSec);
    },
    setOriginalGain(gain: number): void {
      void call('playbackSetGain', Math.max(0, Math.min(4, gain))).catch(() => {});
    },
    onPlaybackState(handler) {
      playbackHandlers.add(handler);
      return () => playbackHandlers.delete(handler);
    },

    onHostInfo(handler) {
      hostHandlers.add(handler);
      // Hand over what the last event said, so a subscriber that arrives between two host
      // changes is not left with nothing until the DAW happens to move.
      if (lastHost) {
        handler({
          host: lastHost.format === 'Standalone' ? 'juce-standalone' : 'juce-plugin',
          isPlugin: lastHost.isPlugin === true,
          hostName: lastHost.hostName,
          engineAvailable: true,
          ...toHostTimeline(lastHost)
        } as HostInfo);
      }
      return () => hostHandlers.delete(handler);
    },

    // --- the transcription engine -------------------------------------------------------
    // Gated on registration for the usual reason: an unregistered native name never settles
    // its promise, so a speculative call would hang the settings panel rather than fail.
    engineStatus: hasNativeFunction('engineStatus')
      ? async (id?: string) => {
          // Passed through only when asked for. An older shell takes no argument at all and
          // handing it one would be a change of call shape for no gain.
          const s = await (id === undefined
            ? call<ShellEngineStatus>('engineStatus')
            : call<ShellEngineStatus>('engineStatus', id)
          ).catch(() => null);
          return toEngineStatus(s);
        }
      : undefined,

    // --- the engine picker (BRIDGE.md §3.1, §3.4, §3.5) ---------------------------------
    // Every one of these is gated on registration for the reason at the top of this file: an
    // unregistered native name never settles its promise, so a speculative call would wedge
    // the settings panel rather than fail. The gate is also what makes the UI honest — the
    // card loop asks `bridge.installEngine ?` before it draws an Install button.
    listEngines: hasNativeFunction('listEngines')
      ? async (): Promise<EngineListResult | null> => {
          const list = await call<ShellEngineList>('listEngines').catch(() => null);
          return toEngineList(list);
        }
      : undefined,

    // The beat tracker on its own — what the engine that runs in this page uses instead of
    // starting a native transcription it does not want. Gated on registration like everything
    // else here: no `trackBeats` means notes without a grid, never a hung promise.
    trackBeats: hasNativeFunction('trackBeats')
      ? async (source: AudioFileRef | CaptureResult) => {
          const token = 'token' in source ? source.token : undefined;
          if (!token) throw new Error('That audio has not been handed to the shell yet.');
          const r = await call<{
            beats?: number[];
            downbeats?: number[];
            bpm?: number | null;
            beatsPerBar?: number | null;
          }>('trackBeats', { token });
          if (!r) throw new Error('Beat tracking was cancelled.');
          return {
            beats: Array.isArray(r.beats) ? r.beats : [],
            downbeats: Array.isArray(r.downbeats) ? r.downbeats : [],
            bpm: typeof r.bpm === 'number' ? r.bpm : null,
            beatsPerBar: typeof r.beatsPerBar === 'number' ? r.beatsPerBar : null
          };
        }
      : undefined,

    selectEngine: hasNativeFunction('selectEngine')
      ? async (id: string) => {
          // Not `call()`: "I will not swap the engine while it is transcribing" is an answer
          // to put on screen, not an exception to swallow — the same treatment
          // `setEngineModel` gets for the same reason.
          const fn = await nativeFn('selectEngine');
          const r = (await fn(id)) as NativeResult & {
            configuredEngine?: string;
            resolvedEngine?: string;
            reason?: string;
          };
          return {
            ok: r?.ok !== false,
            configuredEngine: typeof r?.configuredEngine === 'string' ? r.configuredEngine : undefined,
            resolvedEngine: typeof r?.resolvedEngine === 'string' ? r.resolvedEngine : undefined,
            reason: typeof r?.reason === 'string' ? r.reason : undefined,
            error: r?.ok === false ? (r.error ?? 'the engine could not be changed') : undefined
          };
        }
      : undefined,

    // Rejoins the job with its answer, exactly as `transcribe()` above does: the native call
    // resolves at once with a jobId and the outcome arrives on `engineInstallResult`. A
    // refusal before the job starts (no Python, not enough disk) resolves as an `ok:false`
    // result carrying `guideSteps`, so the card degrades into a guide rather than a dead end.
    installEngine: hasNativeFunction('installEngine')
      ? async (id: string): Promise<EngineInstallResult> => {
          const fn = await nativeFn('installEngine');
          const started = (await fn(id)) as NativeResult & { jobId?: number; guideSteps?: unknown };
          if (started?.ok === false || typeof started?.jobId !== 'number') {
            return {
              jobId: 0,
              id,
              ok: false,
              error: started?.error ?? 'The install could not be started.',
              cancelled: started?.cancelled === true,
              guideSteps: toGuideSteps(started?.guideSteps)
            };
          }
          const jobId = started.jobId;
          return new Promise<EngineInstallResult>((resolve) => {
            const off = onEvent('engineInstallResult', (r: ShellEngineInstallResult) => {
              if (r.jobId !== jobId) return;
              off();
              resolve({
                jobId,
                id: typeof r.id === 'string' ? r.id : id,
                ok: r.ok === true,
                bytesOnDisk: typeof r.bytesOnDisk === 'number' ? r.bytesOnDisk : undefined,
                elapsedMs: typeof r.elapsedMs === 'number' ? r.elapsedMs : undefined,
                location: typeof r.location === 'string' ? r.location : undefined,
                error: typeof r.error === 'string' ? r.error : undefined,
                cancelled: r.cancelled === true,
                guideSteps: toGuideSteps(r.guideSteps)
              });
            });
          });
        }
      : undefined,

    cancelInstall: hasNativeFunction('cancelInstall')
      ? async (jobId?: number) => {
          const r = await call<{ cancelled?: number }>('cancelInstall', jobId).catch(() => null);
          return { cancelled: r?.cancelled ?? 0 };
        }
      : undefined,

    uninstallEngine: hasNativeFunction('uninstallEngine')
      ? async (id: string) => {
          // A refusal ("Riffsheet did not install that one") is an answer, not an exception.
          const fn = await nativeFn('uninstallEngine');
          const r = (await fn(id)) as NativeResult & { freedBytes?: number };
          return {
            ok: r?.ok !== false,
            freedBytes: typeof r?.freedBytes === 'number' ? r.freedBytes : undefined,
            error: r?.ok === false ? (r.error ?? 'the engine could not be removed') : undefined
          };
        }
      : undefined,

    onEngineInstallProgress(handler) {
      installHandlers.add(handler);
      return () => installHandlers.delete(handler);
    },

    // "Look at the disk again, now." Discovery runs once when the plugin loads, which is no
    // use at all to somebody who has just finished installing the engine with the window open.
    // Gated like everything else: an older shell has no such native name, and the setup screen
    // hides the button rather than offering one that would never settle.
    recheckEngine: hasNativeFunction('recheckEngine')
      ? async () => {
          const s = await call<ShellEngineStatus>('recheckEngine').catch(() => null);
          return toEngineStatus(s);
        }
      : undefined,

    stopEngine: hasNativeFunction('stopEngine')
      ? async () => {
          // Not `call()`: "I will not stop somebody else's server" is an answer to show the
          // user, not an exception to swallow.
          const fn = await nativeFn('stopEngine');
          const r = (await fn()) as NativeResult & { stopped?: boolean; reason?: string };
          return {
            stopped: r?.stopped === true,
            reason: typeof r?.reason === 'string' ? r.reason : (r?.error ?? '')
          };
        }
      : undefined,

    /**
     * Stop a listener Riffsheet did not start. Same answer shape as `stopEngine`, on purpose.
     *
     * The shell does not register this name yet, so `hasNativeFunction` answers false and the
     * "Stop it anyway" button is simply not offered — which is the correct behaviour on an old
     * shell rather than a button that hangs. When the native side lands, the button appears
     * with no change here: the capability test IS the wiring.
     */
    stopExternalEngine: hasNativeFunction('stopExternalEngine')
      ? async () => {
          const fn = await nativeFn('stopExternalEngine');
          const r = (await fn()) as NativeResult & { stopped?: boolean; reason?: string };
          return {
            stopped: r?.stopped === true,
            reason: typeof r?.reason === 'string' ? r.reason : (r?.error ?? '')
          };
        }
      : undefined,

    /**
     * Point Riffsheet at an engine that is already on this disk.
     *
     * `path === ''` is the sniff and a real path is the check — see the contract in
     * `types.ts`. Gated identically, and for the same reason: the cards drop the whole
     * "Use existing installation…" affordance on a shell that cannot answer, rather than
     * offering a door that opens onto nothing.
     */
    validateExistingEngineInstall: hasNativeFunction('validateExistingEngineInstall')
      ? async (id: string, path: string) => {
          const fn = await nativeFn('validateExistingEngineInstall');
          const r = (await fn(id, path)) as NativeResult & {
            ok?: boolean;
            detail?: string;
            path?: string;
            searched?: string[];
          };
          return {
            ok: r?.ok === true,
            detail: typeof r?.detail === 'string' ? r.detail : (r?.error ?? ''),
            path: typeof r?.path === 'string' ? r.path : undefined,
            searched: Array.isArray(r?.searched) ? r.searched.filter((s) => typeof s === 'string') : undefined
          };
        }
      : undefined,

    // `playbackLoad(null)` is the shell's unload. Gated because an older shell would treat a
    // null token as an error rather than as "let go".
    unloadOriginal: hasNativeFunction('pcmRetain')
      ? async (): Promise<void> => {
          await call('playbackLoad', null);
        }
      : undefined,

    pcmRetain: hasNativeFunction('pcmRetain')
      ? async (tokens: string | string[] | null) => await call('pcmRetain', tokens)
      : undefined,
    pcmRelease: hasNativeFunction('pcmRelease')
      ? async (tokens?: string | string[]) => await call('pcmRelease', tokens ?? null)
      : undefined,
    pcmDiagnostics: hasNativeFunction('pcmDiagnostics')
      ? async () => ((await call<Record<string, unknown>>('pcmDiagnostics')) ?? {})
      : undefined,

    transcribeCancel: hasNativeFunction('transcribeCancel')
      ? async (jobId?: number) => {
          const r = await call<{ cancelled?: number }>('transcribeCancel', jobId).catch(() => null);
          return { cancelled: r?.cancelled ?? 0 };
        }
      : undefined,

    setEngineModel: hasNativeFunction('setEngineModel')
      ? async (model) => {
          // Not `call()`: a refusal ("that server is not ours to restart") is an expected
          // answer the panel shows to the user, not an exception.
          const fn = await nativeFn('setEngineModel');
          const r = (await fn(model)) as NativeResult & { model?: string; restarted?: boolean };
          return {
            ok: r?.ok !== false,
            model: typeof r?.model === 'string' ? r.model : undefined,
            restarted: r?.restarted === true,
            error: r?.ok === false ? (r.error ?? 'the engine would not change model') : undefined
          };
        }
      : undefined,

    hostTimelineProbe: hasNativeFunction('hostTimelineProbe')
      ? async () => ((await call<Record<string, unknown>>('hostTimelineProbe')) ?? {})
      : undefined,

    // Only offered when the shell registered it, so `bridge.beginMidiDrag ?` in the UI is a
    // truthful capability test rather than a call that might reject.
    beginMidiDrag: hasNativeFunction('beginMidiDrag')
      ? async (name: string, bytes: Uint8Array) => {
          // Pre-warmed at boot (see below), so this resolves from the cache in the same
          // microtask. It matters: the OS will only open a dragging session from inside a
          // live mouse-drag, and an await that actually suspends can outlive the event.
          // Deliberately NOT `call()`: a refusal here is an expected outcome the caller has
          // a fallback for, not an exception. The mouse button is still down while this
          // runs — see BRIDGE.md §4b for why that matters.
          const fn = await nativeFn('beginMidiDrag');
          const result = (await fn(name, toBase64(bytes))) as NativeResult & {
            started?: boolean;
            path?: string;
          };
          return {
            started: result?.started === true,
            path: typeof result?.path === 'string' ? result.path : undefined,
            error: result?.ok === false ? (result.error ?? 'the drag could not be started') : undefined
          };
        }
      : undefined,

    async log(level, message) {
      // Never let logging be the thing that throws.
      await call('log', level, message).catch(() => null);
    },

    playbackDiagnostics: hasNativeFunction('playbackDiagnostics')
      ? async () => ((await call<Record<string, unknown>>('playbackDiagnostics')) ?? {})
      : undefined,

    // --- per-instance persistence -------------------------------------------------------
    // Gated, not attempted: calling a native name the shell has not registered never
    // settles its promise (see hasNativeFunction). A boot that awaits session restore
    // would therefore hang forever on an older shell instead of showing the drop zone.
    getPersistedState: hasNativeFunction('getPersistedState')
      ? async (): Promise<string | null> => {
          const result = await call<{ state?: string | null }>('getPersistedState');
          return typeof result?.state === 'string' && result.state.length > 0 ? result.state : null;
        }
      : undefined,

    setPersistedState: hasNativeFunction('setPersistedState')
      ? async (json: string): Promise<void> => {
          await call('setPersistedState', json);
        }
      : undefined
  };
}

/**
 * Dropped-file intake for the shell.
 *
 * The WebView usually eats native drops, so HTML5 is the primary path: read the bytes and
 * hand them over base64. This returns an AudioFileRef with a token, which is what
 * transcribe() and playbackLoad() need.
 */
export async function importDroppedFile(file: File): Promise<AudioFileRef> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ref = await call<ShellAudioRef>('importDroppedFile', file.name, toBase64(bytes), {
    sampleRate: 44100
  });
  if (!ref) throw new Error('The shell would not accept that file.');
  return toAudioFileRef(ref);
}
