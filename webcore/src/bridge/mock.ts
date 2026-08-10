/**
 * Browser-mode mock bridge.
 *
 * Real enough to build the whole UI against: it decodes files with WebAudio, "transcribes"
 * by running a crude onset/pitch pass over the buffer (or by replaying a fixture when the
 * audio is unhelpful), plays the original through WebAudio, and simulates capture with the
 * microphone so the plugin flow can be exercised without a DAW.
 *
 * Everything it does is honest about being a mock via getHostInfo().engineMessage.
 */

import type {
  AudioFileRef,
  CaptureResult,
  CaptureState,
  DetectedNoteDTO,
  EngineInstallProgress,
  EngineInstallResult,
  EngineListResult,
  EngineSummary,
  GuideStep,
  HostInfo,
  NativeBridge,
  PlaybackState,
  TranscribeOptions,
  TranscribeProgress,
  TranscribeResult
} from './types';

const MOCK_TRANSCRIBE_RATE = 0.35; // seconds of work per second of audio

/**
 * The last options `transcribe()` was called with, kept so a test can read them back.
 *
 * The shell records what it was asked for by acting on it — a wrong flag comes back as wrong
 * audio. The mock has nothing to act on, so the only way to prove that the two preprocessing
 * checkboxes and a named engine reach the bridge at all, rather than being built into an
 * object that is then quietly dropped, is to write down what arrived.
 */
let lastTranscribeOptions: TranscribeOptions | null = null;

/** What the last `transcribe()` call was asked to do. Null until one has been made. */
export function lastMockTranscribeOptions(): TranscribeOptions | null {
  return lastTranscribeOptions;
}

/**
 * The simulated DAW's tempo and meter.
 *
 * The defaults are the user's own reproduction case — REAPER at 222 BPM in 3/6 — because the
 * bug being guarded against is the app quietly substituting 120/4-4 for whatever the host
 * really said. A fixture that agrees with the fallback cannot catch that.
 */
function mockHostTimeline(): Partial<HostInfo> {
  const params = new URLSearchParams(location.search);
  const bpm = Number(params.get('hostbpm') ?? 222);
  const [num, den] = (params.get('hostsig') ?? '3/6').split('/').map(Number);
  return {
    hasHostTimeline: true,
    bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : 222,
    timeSignature:
      Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0
        ? { numerator: num, denominator: den }
        : { numerator: 3, denominator: 6 },
    isPlaying: false,
    ppqPosition: 0,
    ppqOfLastBarStart: 0
  };
}

/** Where the mock parks the session blob. See getPersistedState at the bottom of the file. */
export const MOCK_SESSION_KEY = 'riffsheet.session';

/**
 * How a musician installs MuScriptor by hand, in the order they have to do it.
 *
 * These used to live in `ui/settings.ts` as a hard-coded list the panel drew. They belong to
 * the ENGINE, not to the panel: the shell ships the same steps in MuScriptor's manifest and
 * hands them over with `engineStatus()`, so the guide has one source of truth and the browser
 * mock has to supply its own copy exactly as the shell supplies the real one.
 *
 * GUIDE AND FIND, NEVER INSTALL — for this engine specifically. Its weights are CC BY-NC and
 * gated behind a licence click-through, so Riffsheet has no right to fetch them and never
 * will. That is a fact about the licence, not a limitation of the app: the one-click engines
 * below install themselves in a click precisely because their weights permit it.
 *
 * The steps are derived from the shape of a working install: a Python 3.10 virtualenv with
 * `bin/muscriptor` in it (the reference install on this machine is muscriptor 0.3.0 in a
 * python 3.10.11 venv), plus the licence click-through that gates the weights. The weights
 * themselves are NOT part of setup: the first transcription downloads them, which is slow but
 * is not something a setup screen can do anything about.
 */
const MOCK_MUSCRIPTOR_STEPS: GuideStep[] = [
  {
    what: 'Install Python 3.10 or newer',
    detail:
      'From python.org, or "brew install python@3.10" if you use Homebrew. Nothing else here works without it.'
  },
  {
    what: 'Make a folder for the engine and a virtual environment inside it',
    detail:
      'In Terminal: mkdir -p ~/muscriptor && cd ~/muscriptor && python3 -m venv venv — a virtual environment keeps this install out of the way of everything else on your machine.'
  },
  {
    what: 'Install MuScriptor into it',
    detail: 'Still in Terminal: ./venv/bin/pip install muscriptor — this is the part that takes a few minutes.'
  },
  {
    what: 'Accept the model licence, once',
    detail:
      'The weights are gated: sign in at huggingface.co, open the MuScriptor model page, accept the licence, then make a Read token in your account settings. The engine asks for it the first time and never again.'
  },
  {
    what: 'Come back and press Check again',
    detail:
      'Riffsheet looks in ~/muscriptor/venv by itself, along with everywhere else listed below. Installed it somewhere unusual? Use the custom-location box under this list.'
  }
];

/**
 * The engines the picker offers, as the browser mock describes them.
 *
 * These four are the real product decision, written down where the UI can be built and tested
 * against them without a JUCE host. Every claim below is one somebody measured on this machine
 * rather than one that reads well:
 *
 *  - **Basic Pitch** is bundled and always there. It is good across every instrument and it
 *    needs no setup at all, which is what makes it the honest default on a fresh machine.
 *  - **MuScriptor** is the best quality available and the only engine that knows 35 instrument
 *    groups — and it is guide-only FOREVER, because its weights are non-commercial and gated.
 *  - **bass_v2** is a bass specialist that matched MuScriptor note for note (86 of 86) at 3.3
 *    times its speed. That is why it is offered at all: a one-click engine has to earn its
 *    place against the guided one, not merely exist.
 *  - **Transkun** is piano only and very good at it.
 *
 * A fifth candidate (a singing transcriber) was auditioned and DROPPED — its weights are
 * non-commercial, so Riffsheet has no right to install them and a one-click card would have
 * been an offer it could not keep. It is absent rather than disabled, deliberately.
 */
const MOCK_ENGINES: readonly EngineSummary[] = [
  {
    id: 'basic-pitch',
    name: 'Basic Pitch',
    tier: 'Built in',
    summary:
      'Works instantly, on every instrument, and it is good. Bundled with Riffsheet, so there is nothing to install and nothing to go wrong.',
    sourceUrl: 'https://github.com/spotify/basic-pitch',
    install: 'bundled',
    state: 'ready',
    selected: false,
    instrumentStrengths: ['Guitar', 'Piano', 'Voice', 'Any single instrument'],
    acceptsInstrumentConstraint: false,
    producesBeatGrid: false,
    producesConfidence: true,
    producesVelocity: false,
    approxDiskBytes: 230 * 1024,
    approxPeakRssMb: 120,
    installing: false,
    detail: 'Built in and ready.',
    error: null
  },
  {
    id: 'muscriptor',
    name: 'MuScriptor',
    tier: 'Best quality — guided setup',
    summary:
      'The best quality Riffsheet can drive, and the only engine that knows 35 instrument groups. Its weights are non-commercial and licence-gated, so Riffsheet can never install it for you — the steps below are the whole of it.',
    sourceUrl: 'https://pypi.org/project/muscriptor/',
    install: 'guide',
    state: 'not-installed',
    selected: false,
    instrumentStrengths: ['Bass', 'Guitar', 'Piano', 'Drums', '35 groups'],
    acceptsInstrumentConstraint: true,
    producesBeatGrid: true,
    producesConfidence: false,
    producesVelocity: false,
    approxDiskBytes: 0,
    approxPeakRssMb: 1800,
    installing: false,
    detail: '',
    error: null
  },
  {
    id: 'bass-v2',
    name: 'Instrument-Agnostic AMT (bass)',
    tier: 'One-click',
    summary:
      'A bass specialist. On this machine it matched MuScriptor note for note — 86 of 86 — at 3.3 times the speed, on the CPU. 57 MB, installs in one click.',
    sourceUrl: 'https://github.com/anime-song/instrument-agnostic-amt',
    install: 'one-click',
    state: 'not-installed',
    selected: false,
    instrumentStrengths: ['Bass'],
    acceptsInstrumentConstraint: false,
    producesBeatGrid: false,
    producesConfidence: true,
    producesVelocity: true,
    approxDiskBytes: 57 * 1024 * 1024,
    approxPeakRssMb: 900,
    installing: false,
    detail: 'Not installed yet.',
    error: null
  },
  {
    id: 'transkun',
    name: 'Transkun v2',
    tier: 'One-click',
    summary: 'Piano only, and very good at it. Installed with pip in one click.',
    sourceUrl: 'https://pypi.org/project/transkun/',
    install: 'one-click',
    state: 'not-installed',
    selected: false,
    instrumentStrengths: ['Piano'],
    acceptsInstrumentConstraint: false,
    producesBeatGrid: false,
    producesConfidence: false,
    producesVelocity: true,
    approxDiskBytes: 400 * 1024 * 1024,
    approxPeakRssMb: 1200,
    installing: false,
    detail: 'Not installed yet.',
    error: null
  }
];

export interface MockOptions {
  isPlugin?: boolean;
  engineAvailable?: boolean;
}

export function createMockBridge(options: MockOptions = {}): NativeBridge {
  const isPlugin = options.isPlugin ?? new URLSearchParams(location.search).has('plugin');
  const engineAvailable =
    options.engineAvailable ?? !new URLSearchParams(location.search).has('noengine');

  // Verification-only, and only in browser mode — the JUCE shell never builds this bridge, so
  // this hook cannot exist in the plugin. Same gate as `installTestHooks` in ui/app.ts: it is
  // the harness that reads it, and nothing a player can reach.
  if (new URLSearchParams(location.search).get('verify') === '1') {
    (window as unknown as Record<string, unknown>).__RIFFSHEET_MOCKBRIDGE__ = () => ({
      lastTranscribeOptions: lastMockTranscribeOptions()
    });
  }

  /**
   * What the shell would say about the engine, told plainly as a browser mock.
   *
   * The paths are the REAL discovery order from `MuScriptorServer::resolveDefaultVenv`, written
   * as a browser would have to guess at them, and labelled as a mock in the last entry so
   * nobody reads a dev screenshot as a report about their own disk. They exist so the engine
   * setup screen — searched list, custom-location box, Check again — renders and can be tested
   * without a JUCE host, which is where every one of its bugs would otherwise be found.
   */
  // --- the engine picker ------------------------------------------------------------
  //
  // Module-level in spirit, closure-level in fact: the choice and what is installed have to
  // survive between calls or "Select" and "Install" would be theatre. Reset with the page,
  // which is what a browser tab is.
  let configuredEngine = 'auto';
  /** One-click engines the mock has been asked to install this session. */
  const installedOneClick = new Set<string>();
  /** id -> jobId, while an install is running. */
  const installing = new Map<string, number>();
  let nextInstallJob = 1;
  const installHandlers = new Set<(p: EngineInstallProgress) => void>();
  const emitInstallProgress = (frame: EngineInstallProgress) => {
    for (const h of installHandlers) h(frame);
  };

  /**
   * What each engine's state is right now, mock-side.
   *
   * `?noengine` means NO engine — including the bundled one. It used to leave bundled engines
   * `ready` while `getHostInfo` reported `engineAvailable: false` and `transcribe()` threw
   * "not installed", which is three answers to one question: the picker showed a ready engine,
   * the banner said set one up, and the call refused. Nothing on a real machine can be in that
   * state, so a mock that can be in it is testing a world that does not exist.
   */
  const engineState = (e: EngineSummary): EngineSummary['state'] => {
    if (!engineAvailable) return 'not-installed';
    if (e.install === 'bundled') return 'ready';
    if (e.id === 'muscriptor') return 'ready';
    return installedOneClick.has(e.id) ? 'installed' : 'not-installed';
  };

  const engineIsUsable = (e: EngineSummary) => engineState(e) === 'ready' || engineState(e) === 'installed';

  /**
   * What `auto` means right now — BRIDGE.md §3.4, and nothing cleverer.
   *
   * MuScriptor when it is discovered and installed, otherwise the built-in. That preserves
   * today's behaviour exactly for somebody who already has MuScriptor on disk, and gives a
   * fresh machine a working app with no setup at all. A concrete choice wins over both, but
   * only while that engine is actually usable — a chosen engine that is not installed yet
   * falls back and says so rather than failing at transcribe time.
   */
  const resolveEngine = (): { id: string; reason: string } => {
    const byId = (id: string) => MOCK_ENGINES.find((e) => e.id === id);
    if (configuredEngine !== 'auto') {
      const chosen = byId(configuredEngine);
      if (chosen && engineIsUsable(chosen)) {
        return { id: chosen.id, reason: `You chose ${chosen.name}, and it is ready.` };
      }
      if (chosen) {
        return {
          id: 'basic-pitch',
          reason: `${chosen.name} is not installed yet, so Basic Pitch is doing the listening until it is.`
        };
      }
    }
    const mu = byId('muscriptor');
    if (mu && engineIsUsable(mu)) {
      return { id: 'muscriptor', reason: 'MuScriptor is installed, so Auto is using it — it is the best quality here.' };
    }
    return {
      id: 'basic-pitch',
      reason: 'MuScriptor is not installed, so Auto is using the built-in Basic Pitch. It needs no setup and works on everything.'
    };
  };

  const mockEngineStatus = () => ({
    state: engineAvailable ? ('ready' as const) : ('stopped' as const),
    port: engineAvailable ? 8223 : 0,
    adopted: false,
    model: 'mock',
    configuredModel: 'auto',
    installedModels: ['small', 'medium'],
    busy: false,
    busyOwner: null,
    queueLength: 0,
    queuePosition: 0,
    ramTotalMb: 8192,
    ramFreeMb: 3072,
    stopsAfterEachJob: true,
    idleSeconds: 0,
    canStop: false,
    memoryMb: engineAvailable ? 1300 : null,
    searchedPaths: [
      '$RIFFSHEET_MUSCRIPTOR_VENV (not set in a browser)',
      '<Application Support>/Riffsheet/engine/venv',
      '<Application Support>/Riffsheet/muscriptor/venv',
      '~/.riffsheet/muscriptor/venv',
      '~/Desktop/muscriptor/venv',
      '~/Documents/muscriptor/venv',
      '~/muscriptor/venv',
      '/opt/muscriptor/venv',
      'muscriptor on PATH (browser mock — no real search was run)'
    ],
    venv: engineAvailable ? '~/muscriptor/venv' : '<Application Support>/Riffsheet/engine/venv',
    executable: engineAvailable ? '~/muscriptor/venv/bin/muscriptor' : '',
    engineInstalled: engineAvailable,
    setupDirectory: '<Application Support>/Riffsheet/engine',
    engineConfigPath: '<Application Support>/Riffsheet/engine.json',
    engineConfigExists: false,
    error: null,
    // The multi-engine half of the payload. MuScriptor is a `guide` engine and carries the
    // steps; everything above this line is exactly what it always was.
    id: 'muscriptor',
    configuredEngine,
    resolvedEngine: resolveEngine().id,
    engineReason: resolveEngine().reason,
    install: 'guide' as const,
    guideSteps: MOCK_MUSCRIPTOR_STEPS
  });

  /**
   * One engine's status, for the card that is not MuScriptor's.
   *
   * The MuScriptor-only fields stay PRESENT with honest values rather than being dropped —
   * `installedModels: []` and `venv: ''` read as "irrelevant to this engine", where a missing
   * key reads as "unknown", and the difference is the whole point of BRIDGE.md §3.2's
   * compatibility rule.
   */
  const statusForEngine = (id: string) => {
    if (id === 'muscriptor') return mockEngineStatus();
    const e = MOCK_ENGINES.find((x) => x.id === id);
    if (!e) return null;
    const state = engineState(e);
    const usable = state === 'ready' || state === 'installed';
    const resolution = resolveEngine();
    return {
      state: state === 'ready' ? ('ready' as const) : ('stopped' as const),
      port: 0,
      adopted: false,
      model: e.install === 'bundled' ? 'built in' : e.name,
      configuredModel: 'not applicable to this engine',
      installedModels: [] as string[],
      busy: false,
      busyOwner: null,
      queueLength: 0,
      queuePosition: 0,
      ramTotalMb: 8192,
      ramFreeMb: 3072,
      stopsAfterEachJob: e.install !== 'bundled',
      idleSeconds: 0,
      canStop: false,
      memoryMb: null,
      // Nothing is searched for: it is either compiled in or in Riffsheet's own engines folder.
      searchedPaths: [] as string[],
      venv: '',
      executable: e.install === 'bundled' ? 'built in' : `<Application Support>/Riffsheet/engines/${e.id}`,
      engineInstalled: usable,
      setupDirectory: `<Application Support>/Riffsheet/engines/${e.id}`,
      engineConfigPath: '<Application Support>/Riffsheet/engine.json',
      engineConfigExists: false,
      error: e.error,
      id: e.id,
      configuredEngine,
      resolvedEngine: resolution.id,
      engineReason: resolution.reason,
      install: e.install,
      guideSteps: [] as GuideStep[]
    };
  };

  const engineList = (): EngineListResult => {
    const resolution = resolveEngine();
    return {
      configuredEngine,
      resolvedEngine: resolution.id,
      engineReason: resolution.reason,
      engines: MOCK_ENGINES.map((e) => ({
        ...e,
        state: engineState(e),
        selected: resolution.id === e.id,
        installing: installing.has(e.id),
        detail:
          e.install === 'bundled'
            ? 'Built in and ready.'
            : engineState(e) === 'ready'
              ? 'Installed and ready.'
              : engineState(e) === 'installed'
                ? 'Installed. It starts when you press Listen.'
                : e.install === 'guide'
                  ? 'Not found on this machine. The steps below are how to put it there.'
                  : 'Not installed yet.'
      }))
    };
  };

  let ctx: AudioContext | null = null;
  const audioContext = () => (ctx ??= new AudioContext());

  // --- original playback ------------------------------------------------------------
  let originalBuffer: AudioBuffer | null = null;
  let source: AudioBufferSourceNode | null = null;
  let gainNode: GainNode | null = null;
  let startedAtCtxTime = 0;
  let startedAtOffset = 0;
  let playing = false;
  let raf = 0;
  const playbackHandlers = new Set<(s: PlaybackState) => void>();

  const gain = () => {
    if (!gainNode) {
      gainNode = audioContext().createGain();
      gainNode.connect(audioContext().destination);
    }
    return gainNode;
  };

  const position = () =>
    playing && originalBuffer
      ? Math.min(originalBuffer.duration, startedAtOffset + (audioContext().currentTime - startedAtCtxTime))
      : startedAtOffset;

  const emitPlayback = () => {
    const state: PlaybackState = {
      isPlaying: playing,
      positionSec: position(),
      durationSec: originalBuffer?.duration ?? 0,
      loaded: originalBuffer !== null
    };
    for (const h of playbackHandlers) h(state);
  };

  const tick = () => {
    if (!playing) return;
    emitPlayback();
    if (originalBuffer && position() >= originalBuffer.duration - 0.01) {
      playing = false;
      startedAtOffset = 0;
      emitPlayback();
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  // --- capture ----------------------------------------------------------------------
  let captureStream: MediaStream | null = null;
  let captureNode: ScriptProcessorNode | null = null;
  let captureChunks: Float32Array[] = [];
  let captureState: CaptureState = { phase: 'idle', capturedSec: 0, hostIsPlaying: false };
  const captureHandlers = new Set<(s: CaptureState) => void>();
  const emitCapture = () => {
    for (const h of captureHandlers) h({ ...captureState });
  };

  return {
    async getHostInfo(): Promise<HostInfo> {
      return {
        host: 'browser',
        isPlugin,
        hostName: isPlugin ? 'Browser (simulated plugin)' : 'Browser',
        version: 'dev',
        engineAvailable,
        engineMessage: engineAvailable
          ? 'Mock engine — onset detection in the browser, not the real transcriber.'
          : 'Simulated: engine not installed.',
        transcribeRate: MOCK_TRANSCRIBE_RATE,
        sampleRate: 48000,
        // A simulated DAW timeline, but only in simulated-plugin mode — a browser tab is not
        // a DAW and must not pretend to have a tempo. Deliberately NOT 120/4-4: the reported
        // bug was the app showing a plausible default instead of the host's real numbers, and
        // an odd tempo in an odd meter is the only fixture that can catch that happening
        // again. Override with `?hostbpm=222&hostsig=3/6`.
        ...(isPlugin ? mockHostTimeline() : { hasHostTimeline: false, bpm: null, timeSignature: null })
      };
    },

    onHostInfo(handler) {
      // Static in the mock: there is no transport moving underneath us. Reported once so a
      // subscriber gets the same shape it would in a DAW.
      if (isPlugin) {
        setTimeout(
          () => handler({ host: 'browser', isPlugin, engineAvailable, ...mockHostTimeline() } as HostInfo),
          0
        );
      }
      return () => {};
    },

    // With no id: whichever engine `auto` resolved to, which is what the shell answers and
    // what the read-out at the top of the panel is about. With an id: that engine's own card.
    async engineStatus(id?: string) {
      return statusForEngine(id ?? resolveEngine().id);
    },

    // The browser has no discovery to re-run, but the button must still be exercisable here:
    // the setup screen is the one part of the app most likely to be looked at on a machine
    // where the engine is NOT installed, and a control that only exists in the plugin is a
    // control nobody tests. Same payload as engineStatus(), one tick later.
    async recheckEngine() {
      await new Promise((done) => setTimeout(done, 60));
      return statusForEngine(resolveEngine().id);
    },

    async setEngineModel(model) {
      return { ok: true, model, restarted: false };
    },

    // --- the engine picker ------------------------------------------------------------
    async listEngines() {
      return engineList();
    },

    async selectEngine(id: string) {
      // 'auto' is always selectable; a concrete id has to be one this build offers. The mock
      // is never busy, so the shell's other refusal ("not while it is transcribing") has
      // nothing to fire on here — it is exercised against the real bridge.
      if (id !== 'auto' && !MOCK_ENGINES.some((e) => e.id === id)) {
        return { ok: false, error: `There is no engine called "${id}".` };
      }
      configuredEngine = id;
      const resolution = resolveEngine();
      return {
        ok: true,
        configuredEngine,
        resolvedEngine: resolution.id,
        reason: resolution.reason
      };
    },

    /**
     * A one-click install, simulated end to end.
     *
     * Eight frames over about 1.2 seconds and then one result, which is the same shape the
     * shell emits and slow enough that a progress row genuinely has to render rather than
     * flashing past. Refuses exactly what the shell refuses: an engine that is not one-click,
     * and a second job for an id that already has one.
     */
    async installEngine(id: string): Promise<EngineInstallResult> {
      const engine = MOCK_ENGINES.find((e) => e.id === id);
      const jobId = nextInstallJob++;
      if (!engine) return { jobId, id, ok: false, error: `There is no engine called "${id}".` };
      if (engine.install !== 'one-click') {
        return {
          jobId,
          id,
          ok: false,
          // The guide IS the failure path for an engine Riffsheet may not fetch, so the card
          // has something to render rather than a dead end.
          error: `Riffsheet cannot install ${engine.name} for you.`,
          guideSteps: id === 'muscriptor' ? MOCK_MUSCRIPTOR_STEPS : []
        };
      }
      if (installing.has(id)) {
        return { jobId, id, ok: false, error: `${engine.name} is already being installed.` };
      }

      installing.set(id, jobId);
      const total = engine.approxDiskBytes;
      const frames: Array<Partial<EngineInstallProgress> & { stage: EngineInstallProgress['stage'] }> = [
        { stage: 'checking', message: 'Checking disk space and Python…' },
        { stage: 'downloading', fraction: 0.15 },
        { stage: 'downloading', fraction: 0.45 },
        { stage: 'downloading', fraction: 0.78 },
        { stage: 'downloading', fraction: 1 },
        { stage: 'verifying', message: 'Checking the download against its published checksum…' },
        { stage: 'extracting', message: 'Unpacking…' },
        { stage: 'probing', message: 'Running it once on a one-second test clip…' }
      ];

      const startedAt = Date.now();
      return new Promise<EngineInstallResult>((resolve) => {
        let i = 0;
        const timer = window.setInterval(() => {
          // Cancelled from under us: `cancelInstall` drops the entry, and the job has to stop
          // rather than carry on emitting into a card that has moved on.
          if (installing.get(id) !== jobId) {
            clearInterval(timer);
            resolve({ jobId, id, ok: false, cancelled: true, error: 'Install cancelled.' });
            return;
          }
          const frame = frames[i++];
          if (frame) {
            emitInstallProgress({
              jobId,
              id,
              stage: frame.stage,
              message: frame.message,
              ...(frame.fraction !== undefined
                ? {
                    fraction: frame.fraction,
                    receivedBytes: Math.round(total * frame.fraction),
                    totalBytes: total,
                    bytesPerSec: Math.round(total / 1.2),
                    etaSec: Number((1.2 * (1 - frame.fraction)).toFixed(1))
                  }
                : {})
            });
            return;
          }
          clearInterval(timer);
          installing.delete(id);
          installedOneClick.add(id);
          resolve({
            jobId,
            id,
            ok: true,
            bytesOnDisk: total,
            elapsedMs: Date.now() - startedAt,
            location: `<Application Support>/Riffsheet/engines/${id}`
          });
        }, 150);
      });
    },

    async cancelInstall(jobId?: number) {
      let cancelled = 0;
      for (const [id, job] of [...installing]) {
        if (jobId === undefined || job === jobId) {
          installing.delete(id);
          cancelled++;
        }
      }
      return { cancelled };
    },

    async uninstallEngine(id: string) {
      const engine = MOCK_ENGINES.find((e) => e.id === id);
      if (!engine) return { ok: false, error: `There is no engine called "${id}".` };
      if (engine.install !== 'one-click') {
        // Riffsheet did not put it there and does not get to take it away.
        return { ok: false, error: `Riffsheet did not install ${engine.name}, so it cannot remove it.` };
      }
      const wasInstalled = installedOneClick.delete(id);
      return { ok: true, freedBytes: wasInstalled ? engine.approxDiskBytes : 0 };
    },

    // Same fan-out shape as onCaptureState below: a Set, and an unsubscribe that removes.
    onEngineInstallProgress(handler) {
      installHandlers.add(handler);
      return () => installHandlers.delete(handler);
    },

    async pickAudioFile(): Promise<AudioFileRef | null> {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*,.mid,.midi';
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return resolve(null);
          resolve({ path: file.name, name: file.name, bytes: await file.arrayBuffer() });
        };
        input.oncancel = () => resolve(null);
        input.click();
      });
    },

    async transcribe(
      src: AudioFileRef | CaptureResult,
      onProgress?: (p: TranscribeProgress) => void,
      options?: TranscribeOptions
    ): Promise<TranscribeResult> {
      if (!engineAvailable) throw new Error('Transcription engine is not installed.');
      // Written down before anything else can throw: what a caller asked for is worth knowing
      // even about a run that then fails. See lastMockTranscribeOptions().
      lastTranscribeOptions = options ? { ...options } : null;

      let pcm: Float32Array;
      let sampleRate: number;

      if ('pcm' in src) {
        pcm = src.pcm;
        sampleRate = src.sampleRate;
      } else {
        if (!src.bytes) throw new Error('No audio bytes to transcribe.');
        const buffer = await audioContext().decodeAudioData(src.bytes.slice(0));
        pcm = buffer.getChannelData(0);
        sampleRate = buffer.sampleRate;
      }

      const durationSec = pcm.length / sampleRate;
      // Simulate the real engine's cost so the ETA logic gets exercised honestly.
      const workMs = durationSec * MOCK_TRANSCRIBE_RATE * 1000;
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        await new Promise((ok) => setTimeout(ok, workMs / steps));
        onProgress?.({ progress: i / steps, stage: i < steps ? 'listening' : 'writing notes' });
      }

      // --- what happens before the "engine" listens ------------------------------------
      //
      // The shell prepares a SEPARATE copy of the audio: peak to −12 dBFS when the engine
      // wants it, and a resample to A440 when it is confident about the amount. The mock does
      // the level half for real — one multiply into a copy, the player's samples untouched —
      // and does not pretend to the other half: it never estimates tuning, which is exactly
      // what `peaks: 0` means in the receipt, and the sentence says so rather than inventing a
      // reassuring number of cents. Both flags default to on, as they do in the shell.
      const wantsGain = options?.normalizeBeforeTranscribe !== false;
      const wantsTuning = options?.correctTuningBeforeTranscribe !== false;
      let peak = 0;
      for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
      // Digital silence has no level in dB; −160 is a floor so the receipt stays a number.
      const peakDbfs = peak > 0 ? Math.max(-160, 20 * Math.log10(peak)) : -160;
      // Skipped below −60 dBFS and capped at +30 dB, the shell's own two rules: under the
      // floor there is nothing but noise to amplify.
      const gainDb = wantsGain && peakDbfs > -60 ? Math.min(30, -12 - peakDbfs) : 0;
      let heard = pcm;
      if (gainDb !== 0) {
        const gain = Math.pow(10, gainDb / 20);
        heard = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) heard[i] = pcm[i] * gain;
      }
      const said: string[] = [];
      if (gainDb !== 0) {
        said.push(
          `Brought the level ${gainDb > 0 ? 'up' : 'down'} ${Math.abs(gainDb).toFixed(1)} dB ` +
            'to −12 dBFS for the engine to listen to.'
        );
      }
      if (wantsTuning) said.push('The tuning was left alone — the browser mock does not estimate it.');
      if (said.length === 0) said.push('Nothing needed changing before listening.');

      const notes = detectNotes(heard, sampleRate);
      return {
        notes,
        durationSec,
        beats: undefined,
        // Only when something was on offer, exactly like the shell: a player who switched both
        // options off gets no receipt at all, rather than one that says nothing happened.
        ...(wantsGain || wantsTuning
          ? {
              preprocess: {
                applied: gainDb !== 0,
                note: said.join(' '),
                cents: 0,
                concentration: 0,
                peaks: 0,
                pitchRatio: 1,
                gainDb,
                peakDbfs
              }
            }
          : {})
      };
    },

    async exportFile(name: string, bytes: Uint8Array, mimeType = 'application/octet-stream') {
      download(name, bytes, mimeType);
      // A browser download has no cancel to report back — it either starts or throws.
      return { saved: true, path: name, count: 1 };
    },

    // The browser has no save dialog to consolidate, but implementing this keeps the
    // "Both" MIDI export on one code path in ui/exportBar.ts instead of two.
    async exportFiles(files) {
      for (const f of files) download(f.name, f.bytes, f.mimeType ?? 'application/octet-stream');
      return { saved: true, path: files[0]?.name, count: files.length };
    },

    // --- capture ---------------------------------------------------------------------
    async captureStart(opts?: { armed?: boolean }) {
      captureChunks = [];
      captureState = {
        phase: opts?.armed ? 'armed' : 'recording',
        capturedSec: 0,
        hostIsPlaying: false
      };
      emitCapture();

      captureStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ac = audioContext();
      const src = ac.createMediaStreamSource(captureStream);
      // ScriptProcessor is deprecated but needs no separate worklet file, which keeps the
      // mock self-contained. The real bridge captures on the JUCE side anyway.
      captureNode = ac.createScriptProcessor(4096, 1, 1);
      captureNode.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        if (captureState.phase === 'armed') {
          // "Begins when the DAW plays" — simulated here as "begins on first real signal".
          let peak = 0;
          for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]));
          if (peak > 0.02) {
            captureState = { ...captureState, phase: 'recording', hostIsPlaying: true };
          } else {
            emitCapture();
            return;
          }
        }
        captureChunks.push(new Float32Array(input));
        captureState = {
          ...captureState,
          capturedSec: (captureChunks.length * 4096) / ac.sampleRate,
          hostIsPlaying: true
        };
        emitCapture();
      };
      src.connect(captureNode);
      // Must be connected to something or the callback never fires; a zero gain keeps it silent.
      const sink = ac.createGain();
      sink.gain.value = 0;
      captureNode.connect(sink);
      sink.connect(ac.destination);
      emitCapture();
    },

    async captureStop(): Promise<CaptureResult> {
      captureState = { ...captureState, phase: 'finishing' };
      emitCapture();

      captureNode?.disconnect();
      captureNode = null;
      captureStream?.getTracks().forEach((t) => t.stop());
      captureStream = null;

      const sampleRate = audioContext().sampleRate;
      const total = captureChunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Float32Array(total);
      let offset = 0;
      for (const chunk of captureChunks) {
        pcm.set(chunk, offset);
        offset += chunk.length;
      }
      captureChunks = [];
      captureState = { phase: 'idle', capturedSec: 0, hostIsPlaying: false };
      emitCapture();

      return { pcm, sampleRate, durationSec: total / sampleRate, path: '' };
    },

    onCaptureState(handler) {
      captureHandlers.add(handler);
      handler({ ...captureState });
      return () => captureHandlers.delete(handler);
    },

    // --- original playback -----------------------------------------------------------
    async loadOriginal(src: AudioFileRef | CaptureResult) {
      const ac = audioContext();
      if ('pcm' in src) {
        const buffer = ac.createBuffer(1, src.pcm.length, src.sampleRate);
        buffer.copyToChannel(src.pcm as Float32Array<ArrayBuffer>, 0);
        originalBuffer = buffer;
      } else if (src.bytes) {
        originalBuffer = await ac.decodeAudioData(src.bytes.slice(0));
      } else {
        originalBuffer = null;
      }
      startedAtOffset = 0;
      return { durationSec: originalBuffer?.duration ?? 0 };
    },

    async play() {
      if (!originalBuffer || playing) return;
      const ac = audioContext();
      await ac.resume();
      source = ac.createBufferSource();
      source.buffer = originalBuffer;
      source.connect(gain());
      source.start(0, startedAtOffset);
      startedAtCtxTime = ac.currentTime;
      playing = true;
      emitPlayback();
      raf = requestAnimationFrame(tick);
    },

    async pause() {
      if (!playing) return;
      startedAtOffset = position();
      playing = false;
      try {
        source?.stop();
      } catch {
        /* already stopped */
      }
      source?.disconnect();
      source = null;
      cancelAnimationFrame(raf);
      emitPlayback();
    },

    async seek(positionSec: number) {
      const wasPlaying = playing;
      if (wasPlaying) await this.pause();
      startedAtOffset = Math.max(0, positionSec);
      if (wasPlaying) await this.play();
      else emitPlayback();
    },

    setOriginalGain(g: number) {
      const node = gain();
      // Ramp rather than step — a raw assignment per pixel of fader drag is zipper noise.
      node.gain.setTargetAtTime(Math.max(0, Math.min(1, g)), audioContext().currentTime, 0.01);
    },

    onPlaybackState(handler) {
      playbackHandlers.add(handler);
      return () => playbackHandlers.delete(handler);
    },

    // beginMidiDrag is deliberately NOT implemented here. A browser cannot hand a real file
    // to another application, and a mock that pretended otherwise would let the drag wiring
    // "work" in dev and fail only in the plugin — the exact class of bug this whole bridge
    // exists to avoid. Leaving it undefined makes the capability test honest.

    async log(level, message) {
      // In the plugin this reaches the DAW's log. Here the console is the log.
      if (level === 'error') console.error(message);
      else console.warn(message);
    },

    async openEngineSetup() {
      // eslint-disable-next-line no-alert
      alert('In the real app this opens the engine setup. (Browser mock.)');
    },

    // --- per-instance persistence -------------------------------------------------------
    // The plugin parks this on its processor, which is the thing that survives the editor
    // being destroyed. A browser tab has no processor, so localStorage stands in — the same
    // round trip through the same interface, and it gives the dev path a real session
    // restore for free. One key for the page, because a browser tab IS one instance.
    async getPersistedState(): Promise<string | null> {
      try {
        return localStorage.getItem(MOCK_SESSION_KEY);
      } catch {
        return null; // private browsing — no restore, and that is not an error
      }
    },

    async setPersistedState(json: string): Promise<void> {
      try {
        if (json.length === 0) localStorage.removeItem(MOCK_SESSION_KEY);
        else localStorage.setItem(MOCK_SESSION_KEY, json);
      } catch {
        /* quota or private browsing — the session just does not persist */
      }
    }
  };
}

/**
 * Crude onset + autocorrelation pitch detection. Not a transcriber — just enough signal
 * for the UI to have something plausible to draw in browser mode.
 */
function detectNotes(pcm: Float32Array, sampleRate: number): DetectedNoteDTO[] {
  const hop = Math.floor(sampleRate * 0.01);
  const frameCount = Math.floor(pcm.length / hop);
  const energy = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop && i < pcm.length; i++) sum += pcm[i] * pcm[i];
    energy[f] = Math.sqrt(sum / hop);
  }

  const peak = Math.max(...energy, 1e-6);
  const threshold = peak * 0.12;
  const onsets: number[] = [];
  for (let f = 2; f < frameCount - 1; f++) {
    const rising = energy[f] - energy[f - 2];
    if (energy[f] > threshold && rising > threshold * 0.35) {
      const lastOnset = onsets[onsets.length - 1];
      if (lastOnset === undefined || f - lastOnset > 8) onsets.push(f);
    }
  }

  const notes: DetectedNoteDTO[] = [];
  for (let i = 0; i < onsets.length; i++) {
    const startFrame = onsets[i];
    const endFrame = i + 1 < onsets.length ? onsets[i + 1] : frameCount;
    const startSample = startFrame * hop;
    const analysisLength = Math.min(sampleRate / 8, pcm.length - startSample);
    if (analysisLength < 512) continue;
    const midi = autocorrelationMidi(pcm.subarray(startSample, startSample + analysisLength), sampleRate);
    if (midi === null) continue;
    notes.push({
      startSec: startFrame * hop / sampleRate,
      endSec: (endFrame * hop) / sampleRate,
      midi,
      confidence: 0.6,
      velocity: Math.round(Math.min(127, Math.max(30, (energy[startFrame] / peak) * 127)))
    });
  }
  return notes;
}

function autocorrelationMidi(frame: Float32Array, sampleRate: number): number | null {
  const minMidi = 24;
  const maxMidi = 72;
  const minLag = Math.floor(sampleRate / midiToHz(maxMidi));
  const maxLag = Math.floor(sampleRate / midiToHz(minMidi));
  if (maxLag >= frame.length) return null;

  let bestLag = -1;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < frame.length; i++) sum += frame[i] * frame[i + lag];
    if (sum > bestScore) {
      bestScore = sum;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestScore <= 0) return null;
  const hz = sampleRate / bestLag;
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return midi >= minMidi && midi <= maxMidi ? midi : null;
}

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** The browser stand-in for a native save panel. */
function download(name: string, bytes: Uint8Array, mimeType: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
