/**
 * The settings panel — musician-only knobs.
 *
 * Nothing here is a developer switch. Every control is something a bass player has an
 * opinion about, and every one carries a plain-language tooltip.
 */

import { el, replace, type Store } from './dom';
import { t, TIPS, tipsEnabled, setTipsEnabled } from './tips';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ClefMode,
  type FingeringStyle,
  type NotationGrid,
  type RollGrid,
  type RuntimeState
} from '../app/state';
import { type SynthVoice } from '../audio/synth';
import {
  SAMPLED_INSTRUMENTS,
  isSampledVoice,
  onSampleStatus,
  sampleStatus,
  type SampleStatus
} from '../audio/sampler';
import {
  getBridge,
  type EngineInstallProgress,
  type EngineListResult,
  type EngineStatus,
  type EngineSummary,
  type GuideStep,
  type NativeBridge
} from '../bridge';

/**
 * One sound the player can pick.
 *
 * This used to be two questions — a source, then a timbre if you happened to land on the
 * synth — and the reported problem with that was not that it was wrong, it was that nobody
 * found the second half. It is one flat list of recorded multisample instruments now.
 */
export interface SoundOption {
  value: SynthVoice;
  label: string;
  /** True when this is a real recording rather than an oscillator. */
  recorded: boolean;
  /** Who recorded it — the credit line under the settings picker. */
  source?: string;
}

/**
 * Every sound, in the order a person should meet them.
 *
 * The recorded half is generated from the sampler's own registry, so adding an instrument
 * there puts it in both pickers with nothing else to remember.
 */
export const SOUND_OPTIONS: ReadonlyArray<SoundOption> = [
  ...SAMPLED_INSTRUMENTS.map((instrument) => ({
    value: instrument.id as SynthVoice,
    label: instrument.label,
    recorded: true,
    source: instrument.source
  }))
];

export function soundOptionFor(voice: SynthVoice): SoundOption {
  return SOUND_OPTIONS.find((o) => o.value === voice) ?? SOUND_OPTIONS[0];
}

/**
 * What to say about a sound right now, in one short phrase.
 *
 * Only the chosen instrument is ever loading — they are fetched one at a time, on demand —
 * so the status is about the current pick and nothing else. Returns null when there is
 * nothing worth saying (including a legacy hidden voice restored by an old test fixture).
 */
function soundNote(voice: SynthVoice, status: SampleStatus): { text: string; dot: string } | null {
  if (!isSampledVoice(voice)) return null;
  // A status left over from a different instrument says nothing about this one.
  if (status.voice !== voice) return { text: 'Recorded notes.', dot: 'off' };
  if (status.state === 'loading') return { text: status.message ?? 'Loading the recordings…', dot: 'off' };
  if (status.state === 'unavailable') {
    return { text: status.message ?? 'These recordings are not available in this build.', dot: 'warn' };
  }
  if (status.state === 'ready') return { text: status.message ?? 'Recorded notes, ready.', dot: 'ok' };
  return { text: 'Recorded notes.', dot: 'off' };
}

/**
 * A `<select>` carrying the recorded multisample instruments.
 *
 * Shared by the settings panel and by the compact transport-bar picker below, so the two
 * cannot drift apart. The group label makes it explicit that every visible choice is recorded.
 */
function soundSelect(
  current: SynthVoice,
  status: SampleStatus,
  onPick: (voice: SynthVoice) => void,
  ariaLabel: string
): HTMLSelectElement {
  const optionEl = (option: SoundOption) =>
    el('option', {
      value: option.value,
      // The one being fetched says so in the list itself, so a player who opened the menu
      // mid-load is not left wondering why it still sounds like a buzz.
      text:
        option.value === current && status.voice === option.value && status.state === 'loading'
          ? `${option.label} — loading…`
          : option.label,
      selected: option.value === current
    });

  return el(
    'select',
    {
      'aria-label': ariaLabel,
      'data-role': 'sound-picker',
      'data-setting': 'playbackVoice',
      onChange: (e: Event) => onPick((e.target as HTMLSelectElement).value as SynthVoice)
    },
    el('optgroup', { label: 'Recorded instruments' }, ...SOUND_OPTIONS.map(optionEl))
  );
}

/**
 * A compact sound picker for the transport bar. Same setting, same behaviour, one row.
 *
 * The settings panel already had a sound picker and the player could not find it — it sits
 * several groups down a scrolling panel behind the gear icon, which is nowhere near where
 * somebody comparing two sounds is looking. That place is the Original↔MIDI fader, so this
 * exists to go next to it.
 *
 * Self-contained on purpose: it builds its own elements, subscribes to the settings store
 * and to the sample loader itself, and uses only classes that already exist in styles.css
 * (`row`, `dim`, plus the plain `select` styling). Call `remove()` on the returned element
 * to take it away — it unsubscribes itself when it leaves the document.
 */
export function soundPicker(opts: {
  settings: Store<AppSettings>;
  onChange?: (voice: SynthVoice) => void;
}): HTMLElement {
  const root = el('div', { class: 'row', 'data-role': 'sound-picker-row' });
  const note = el('span', { class: 'dim', 'data-role': 'sound-picker-note' });
  // Room for "loading…" so the transport bar does not jump when a set is being fetched.
  note.style.minWidth = '7ch';
  note.style.fontSize = '11.5px';

  const draw = () => {
    const voice = opts.settings.get().playbackVoice;
    const status = sampleStatus();
    const select = soundSelect(voice, status, (picked) => {
      opts.settings.set({ playbackVoice: picked });
      opts.onChange?.(picked);
    }, 'Playback sound');
    // `t()` returns undefined when the player has turned tooltips off.
    select.title = t(TIPS.sound) ?? '';
    // A <select> sizes itself to its widest recorded-instrument name. Capped here rather than in
    // styles.css so this stays a drop-in with no CSS to remember; the full text is still
    // there when the menu is open, and in the tooltip.
    select.style.maxWidth = '150px';

    // Short, because this lives on a bar that has to survive a 360px-wide window
    // (design notes §2.4). The settings panel carries the full sentence.
    const state = isSampledVoice(voice) && status.voice === voice ? status.state : null;
    note.textContent =
      state === 'loading' ? 'loading…' : state === 'unavailable' ? 'not in this build' : '';
    note.title = soundNote(voice, status)?.text ?? '';

    replace(root, el('span', { class: 'dim', text: 'Sound' }), select, note);
  };

  // No framework here to own a lifecycle, so the element owns its own. The transport bar is
  // rebuilt on every re-render, and a picker that kept listening after being dropped would
  // leak one subscription per rebuild — and, worse, keep writing into a detached element.
  // Checked lazily, on the next event rather than on a timer or a document-wide observer:
  // nothing has to be paid for while nothing is happening.
  const unsubs: Array<() => void> = [];
  let wasAttached = false;
  const guard = () => {
    if (root.isConnected) wasAttached = true;
    else if (wasAttached) {
      for (const off of unsubs) off();
      unsubs.length = 0;
      return;
    }
    draw();
  };

  unsubs.push(opts.settings.watch((s) => s.playbackVoice, guard), onSampleStatus(guard));
  draw();
  return root;
}

/** Written down once so the select and the read-out cannot drift apart. */
type EngineModel = AppSettings['engineModel'];

/**
 * The weights, described by what they cost the player rather than by parameter count.
 * "Choose for me" is first because it is the right answer for almost everybody.
 */
const ENGINE_MODELS: Array<[EngineModel, string]> = [
  ['auto', 'Choose for me'],
  ['small', 'Small — fastest'],
  ['medium', 'Medium — the balanced one'],
  ['large', 'Large — most accurate, slowest, most memory']
];

/**
 * How often the engine read-out refreshes while the panel is open.
 *
 * Two seconds is fast enough that "another Riffsheet grabbed the engine" shows up while the
 * player is still looking at the panel, and slow enough to be free. It runs ONLY while the
 * panel is open — the status is pulled, never pushed (BRIDGE.md), and a timer still ticking
 * behind a closed panel is exactly what makes a DAW with eight plugins in it feel heavy.
 */
const ENGINE_POLL_MS = 2000;

/**
 * ONE source of truth for the install guide, and it is not here.
 *
 * This file used to carry its own hard-coded `SETUP_STEPS` array. The steps belong to the
 * ENGINE — the shell ships them in that engine's manifest and hands them over on
 * `engineStatus().guideSteps` — so two copies were one copy too many and the day they drifted
 * apart the screen would have been confidently wrong. `renderEngineSetup()` renders whatever
 * the bridge says, in the same `<strong>` + `<div class="dim">` shape it always drew.
 */

/**
 * Roughly how much memory each set of weights wants, in MB.
 *
 * One measured anchor: a second copy of the MEDIUM model costs "about another gigabyte"
 * (design notes §3.3); small and large are scaled from it. These are an order of magnitude and
 * nothing finer, which is all they need to be — they decide whether to say "this may not
 * fit", never whether to allow it. Nothing here refuses anything.
 */
const MODEL_RAM_MB: Record<string, number> = { small: 700, medium: 1300, large: 2600 };

/**
 * Memory left for everything else before a model counts as fitting. Without the headroom the
 * warning only appears once the machine is already in trouble, which is too late to be advice.
 */
const RAM_HEADROOM_MB = 250;

/** Sizes as a person says them: "1.4 GB", not "1434 MB". */
function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** The same, from raw bytes — what the engine manifest and the download frames speak in. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * A row of chips where exactly one is on — the app's single "pick one of these" widget.
 *
 * A module function rather than a method because the main-menu engine picker needs the same
 * control on a screen the settings panel has nothing to do with (`ui/app.ts renderOpening`),
 * and two implementations of one widget is how two things that must look identical stop
 * looking identical. `aria-pressed` rather than a radio group: these are buttons that act
 * immediately, not a form somebody submits.
 */
export function chipGroup<T extends string>(
  current: T,
  options: Array<{ value: T; label: string; title?: string }>,
  onPick: (value: T) => void,
  tip?: string,
  /** Stamp each chip with its own value under this attribute, so a test can address one. */
  valueAttribute?: string
): HTMLElement {
  return el(
    'div',
    { class: 'chip-group', title: tip ? t(tip) : undefined },
    ...options.map((o) =>
      el('button', {
        class: `chip${o.value === current ? ' on' : ''}`,
        text: o.label,
        title: o.title,
        'aria-pressed': String(o.value === current),
        ...(valueAttribute ? { [valueAttribute]: o.value } : {}),
        onClick: () => onPick(o.value)
      })
    )
  );
}

/** "small, medium and large" — a list you could read out loud. */
function humanList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Install stages, as a person would say them rather than as the protocol names them. */
const INSTALL_STAGE_WORDS: Record<string, string> = {
  checking: 'Checking',
  downloading: 'Downloading',
  verifying: 'Checking the download',
  extracting: 'Unpacking',
  installing: 'Installing',
  probing: 'Testing it'
};

/**
 * Guide steps in whichever of the two shapes the bridge sent.
 *
 * A step is a heading AND the line you actually type, and the renderer draws both. A bare
 * string therefore becomes a heading with no detail rather than being refused — which is
 * exactly what a flat list of strings means — so neither shape can produce an empty guide.
 */
function normalizeGuideSteps(value: ReadonlyArray<string | GuideStep> | undefined): GuideStep[] {
  if (!Array.isArray(value)) return [];
  const steps: GuideStep[] = [];
  for (const step of value) {
    if (typeof step === 'string') {
      if (step.length > 0) steps.push({ what: step, detail: '' });
    } else if (step && typeof step.what === 'string' && step.what.length > 0) {
      steps.push({ what: step.what, detail: typeof step.detail === 'string' ? step.detail : '' });
    }
  }
  return steps;
}

/**
 * What to show when the shell hands back no steps at all.
 *
 * Deliberately generic and deliberately not a promise about a specific package name: this is
 * the shape every licence-gated engine's own guide takes, and the last step is the one that
 * matters, because Check again is the button on this very screen. A screen that says "these
 * are the steps" and then lists none is worse than one that says nothing.
 */
const FALLBACK_GUIDE_STEPS: readonly GuideStep[] = [
  {
    what: 'Install the engine into a Python environment of its own',
    detail: 'Follow the instructions on the engine’s own page. A virtual environment keeps its dependencies away from the rest of your system.'
  },
  {
    what: 'Accept the licence and download the weights',
    detail: 'These weights are licence-gated, which is why Riffsheet cannot fetch them for you.'
  },
  {
    what: 'Point Riffsheet at it, then press Check again',
    detail: 'Use the location box below if it is not in one of the places already searched.'
  }
];

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

function fretOptions(current: number): number[] {
  const list = [...FRET_COUNTS];
  if (Number.isFinite(current) && current > 0 && !list.includes(current)) list.push(current);
  return list.sort((a, b) => a - b);
}

export interface SettingsPanelOptions {
  settings: Store<AppSettings>;
  runtime: Store<RuntimeState>;
  /** Called when a change requires the notation to be rebuilt (not re-transcribed). */
  onRebuild: () => void;
  /** Called for changes that only affect the view or playback. */
  onViewChange: () => void;
  onClose: () => void;
}

export class SettingsPanel {
  private root: HTMLElement;
  private opts: SettingsPanelOptions;
  private unsubs: Array<() => void> = [];

  private bridge: NativeBridge = getBridge();
  /** The last thing `engineStatus()` said. Null means "nothing known" — including "no engine here". */
  private engine: EngineStatus | null = null;
  /**
   * Where the live engine read-out draws.
   *
   * It is refreshed on its own rather than through `render()`, because a full redraw every two
   * seconds would close an open dropdown and pull the focus off whatever the player was in the
   * middle of doing.
   */
  private engineReadout: HTMLElement | null = null;
  private enginePoll: number | undefined;
  private engineAsking = false;
  /** What the shell said when it refused a model change. Cleared by the next attempt. */
  private engineModelError: string | null = null;

  // --- engine setup: guide and find ------------------------------------------------------
  /** Where the setup block draws, refreshed in place like the read-out above it. */
  private engineSetupHost: HTMLElement | null = null;
  /** The searched-locations list is long and boring until it is the only thing that matters. */
  private searchedOpen = false;
  private rechecking = false;
  /** What the last Check again found, as a sentence. Null until one has been pressed. */
  private recheckSaid: string | null = null;
  /** Whether the engine.json path went to the clipboard, so the button can say so. */
  private pathCopied = false;

  // --- the engine picker ------------------------------------------------------------------
  /** Every engine this build offers. Null on a shell that has only ever had one. */
  private engines: EngineListResult | null = null;
  /**
   * The GUIDE engine's own status, when it is not the one `engineStatus()` answered about.
   *
   * `engineStatus()` with no argument describes whichever engine `auto` resolved to. The
   * guided card's body is the whole of the old setup screen — searched paths, the engine.json
   * row, Check again — and every one of those is a fact about THAT engine, so on a machine
   * where the built-in engine is in charge the card has to ask for its own status or it would
   * render somebody else's. One extra call, on the same tick, only when the ids differ.
   */
  private guideStatus: EngineStatus | null = null;
  /** id -> the last install frame seen for it. Cleared when the job ends. */
  private installProgress = new Map<string, EngineInstallProgress>();
  /** id -> how the last install ended, as a sentence plus its own steps if it failed. */
  private installOutcome = new Map<string, { ok: boolean; text: string; steps: GuideStep[] }>();
  /**
   * id -> the last job id seen for it, which is what Cancel has to name.
   *
   * Deliberately NOT the same thing as "an install is running": installs are machine-wide, so
   * another Riffsheet window's job reaches this panel as events with a job id we never started
   * and cannot be told about the end of except by the list saying so.
   */
  private installJobs = new Map<string, number>();
  /** Installs THIS panel started and is still awaiting. */
  private installingHere = new Set<string>();
  /** What the shell said when it refused an engine change. Cleared by the next attempt. */
  private engineSelectError: string | null = null;
  /** Press-anywhere-else-to-close. On the document, so it has to be taken off in `destroy`. */
  private onOutsidePointer: (e: PointerEvent) => void = () => undefined;

  constructor(opts: SettingsPanelOptions) {
    this.opts = opts;
    this.root = el('aside', { class: 'settings-panel', role: 'dialog', 'aria-label': 'Settings' });
    this.root.style.display = 'none';
    document.body.appendChild(this.root);

    this.unsubs.push(opts.settings.subscribe(() => this.render()));
    this.unsubs.push(opts.runtime.watch((s) => s.host, () => this.render()));
    // The "what was done to your audio" sentence. Read from the runtime store at render
    // time, so a panel that was already open when a transcription finished went on showing
    // the PREVIOUS take's sentence — or none — until something else happened to redraw it.
    // A sentence about somebody's own recording that is quietly one take out of date is
    // worse than no sentence, so the panel watches the value it prints.
    this.unsubs.push(opts.runtime.watch((s) => s.preprocessNote, () => this.render()));
    // Samples decode in the background; the row under the picker has to stop saying
    // "loading" by itself when they land.
    this.unsubs.push(onSampleStatus(() => this.render()));
    // Install frames arrive at up to 5 Hz and only ever touch the one card, so they redraw
    // the setup block rather than the panel — a full `render()` per frame would close an open
    // dropdown eight times in a second.
    const offInstall = this.bridge.onEngineInstallProgress?.((p) => {
      this.installProgress.set(p.id, p);
      // Learn the job's real id from its own frames. It is what Cancel has to name, and an
      // install started by another Riffsheet window reaches us this way and no other.
      if (p.jobId > 0) this.installJobs.set(p.id, p.jobId);
      this.renderEngineSetup();
    });
    if (offInstall) this.unsubs.push(offInstall);

    /**
     * A press anywhere else closes it.
     *
     * The panel is a drawer over the music with no scrim, and until now the only way out was
     * the gear you came in by — so somebody who opened it, read the thing they wanted and then
     * reached for the sheet had to go back across the window to put it away. Clicking outside
     * a panel to dismiss it is what every other drawer in every other app does, and the player
     * asked for it directly.
     *
     * Three exemptions, and each one is a bug that would otherwise be reported:
     *
     *  - INSIDE the panel, obviously — including a press that begins on a control and ends
     *    outside it, which is every slider drag. `pointerdown` is the right event for that:
     *    a `click` fires on the element the press ENDED over, so a fader dragged past the edge
     *    would close the panel it belongs to.
     *  - the GEAR, because it toggles. Closing here and then letting its own handler run would
     *    close and instantly reopen, and the button would appear to do nothing.
     *  - anything the browser draws OUTSIDE the document for us — an open `<select>` list is
     *    the live case. Its options are not children of the panel, so a click on one reads as
     *    "outside" and would slam the drawer as the player chose a value.
     *
     * On `pointerdown` and NOT captured: a control that legitimately stops propagation gets to
     * keep doing so, which is how the pickers stay working.
     */
    this.onOutsidePointer = (e: PointerEvent) => {
      if (this.root.style.display === 'none') return;
      const target = e.target as Node | null;
      if (!target || !document.contains(target)) return;
      if (this.root.contains(target)) return;
      if ((target as HTMLElement).closest?.('[data-role="settings-gear"], select, option')) return;
      this.opts.onClose();
    };
    document.addEventListener('pointerdown', this.onOutsidePointer);

    this.render();
  }

  setOpen(open: boolean): void {
    this.root.style.display = open ? '' : 'none';
    if (open) {
      this.render();
      this.startEnginePoll();
    } else {
      this.stopEnginePoll();
    }
  }

  private set<K extends keyof AppSettings>(key: K, value: AppSettings[K], rebuild: boolean): void {
    this.opts.settings.set({ [key]: value } as Partial<AppSettings>);
    if (rebuild) this.opts.onRebuild();
    else this.opts.onViewChange();
  }

  // -------------------------------------------------------------------------
  // The transcription engine
  // -------------------------------------------------------------------------

  /**
   * Ask the engine what it is doing, now and every couple of seconds after that.
   *
   * Idempotent on purpose: `setOpen(true)` runs on every one of the app's main renders, and
   * starting a second interval each time would leave a fan of orphaned timers behind. The
   * immediate first ask is what keeps the panel from sitting blank for two seconds after it
   * opens.
   */
  private startEnginePoll(): void {
    void this.askEngine();
    if (this.enginePoll !== undefined) return;
    this.enginePoll = window.setInterval(() => void this.askEngine(), ENGINE_POLL_MS);
  }

  private stopEnginePoll(): void {
    if (this.enginePoll !== undefined) clearInterval(this.enginePoll);
    this.enginePoll = undefined;
  }

  private async askEngine(): Promise<void> {
    // One question in flight at a time, so a slow shell cannot stack up answers that then
    // arrive out of order and make the read-out flicker between two truths.
    if (this.engineAsking) return;
    this.engineAsking = true;
    try {
      // `?.` is load-bearing: in a browser, and in any shell older than this build, there is
      // no engine to ask. `undefined` back means the read-out draws nothing at all rather
      // than inventing a status.
      //
      // Both questions on ONE tick and on the SAME timer. `listEngines()` is as cheap as
      // `engineStatus()` — a compiled-in table plus cached status — and giving it a timer of
      // its own is how an idle plugin ends up with two heartbeats instead of one.
      const [status, list] = await Promise.all([
        this.bridge.engineStatus?.(),
        this.bridge.listEngines?.().catch(() => null)
      ]);
      this.engine = status ?? null;
      this.engines = list ?? null;
      // An install that has finished must not leave its last frame on screen. Ours is cleared
      // where it is awaited; one started in another Riffsheet window can only be known to have
      // ended by the list saying so, which is what this reads.
      for (const e of this.engines?.engines ?? []) {
        if (!e.installing && !this.installingHere.has(e.id)) this.installProgress.delete(e.id);
      }
      this.guideStatus = await this.askGuideEngine();
      this.renderEngineReadout();
      this.renderEngineSetup();
    } catch {
      // The call exists but is unhappy. Keep the last thing it said — a read-out that blanks
      // itself every time a probe times out is worse than a slightly stale one.
    } finally {
      this.engineAsking = false;
    }
  }

  /**
   * The guide engine's own status, when the resolved one is somebody else.
   *
   * Returns null — and costs nothing — in the ordinary case where the engine `auto` picked IS
   * the guided one, which is exactly what happens on the machine this was built on.
   */
  private async askGuideEngine(): Promise<EngineStatus | null> {
    const guide = this.engines?.engines.find((e) => e.install === 'guide');
    // No `id` on the status means a single-engine shell: that payload IS the guide engine's.
    if (!guide || !this.engine?.id || this.engine.id === guide.id) return null;
    return (await this.bridge.engineStatus?.(guide.id).catch(() => null)) ?? null;
  }

  /**
   * Whose status describes this card.
   *
   * Three cases and they must not share an answer: the resolved engine (the payload we polled),
   * the guided engine when it is not that one (the extra ask above), and everybody else — for
   * whom the card renders from the summary alone rather than from a status belonging to a
   * different engine. Guessing here would put MuScriptor's venv path on Basic Pitch's card.
   */
  private statusFor(engine: EngineSummary): EngineStatus | null {
    const st = this.engine;
    if (!st) return null;
    if (!st.id) return engine.install === 'guide' ? st : null;
    if (st.id === engine.id) return st;
    return this.guideStatus?.id === engine.id ? this.guideStatus : null;
  }

  /**
   * Change which weights the engine uses.
   *
   * The shell is allowed to say no, and it does when Riffsheet joined a MuScriptor server
   * somebody else started (§3.3): that server is not ours to restart. When it refuses, the
   * sentence it gives back IS the answer, so it goes on screen and the select returns to what
   * it was. Silently snapping the select back with no explanation is how a control ends up
   * looking broken.
   */
  private async pickEngineModel(next: EngineModel, previous: EngineModel): Promise<void> {
    // Cleared BEFORE the write, because the write re-renders: leave it until afterwards and
    // last time's refusal is still on screen under a select that has just been accepted.
    this.engineModelError = null;
    // Neither a rebuild nor a view change: this decides how the NEXT transcription listens,
    // and the sheet on screen was written from whatever was in use at the time.
    this.opts.settings.set({ engineModel: next });

    let refusal: string | null = null;
    try {
      const result = await this.bridge.setEngineModel?.(next);
      if (result && !result.ok) refusal = result.error ?? 'The engine kept the weights it already had.';
    } catch (err) {
      refusal = err instanceof Error ? err.message : 'The engine could not be asked to change weights.';
    }

    if (refusal) {
      this.engineModelError = refusal;
      // Back to what it was, so the select never claims something the engine is not doing.
      this.opts.settings.set({ engineModel: previous });
    }
    void this.askEngine();
  }

  /**
   * What is ACTUALLY happening — not what the select above asked for.
   *
   * The two really can differ, and when they do it is the whole story: rather than load a
   * second gigabyte-sized copy of the model, the shell adopts a MuScriptor server that was
   * already running, and that server's weights are whatever the person who started it chose
   * (§3.3). Saying so out loud is the difference between "this setting does nothing" and
   * "this setting cannot win that argument".
   *
   * Every line is guarded. Only what the shell actually reported gets a sentence; nothing
   * here fills a gap with a guess.
   */
  private renderEngineReadout(): void {
    const host = this.engineReadout;
    if (!host) return;

    const st = this.engine;
    if (!st) {
      replace(host);
      return;
    }

    const s = this.opts.settings.get();
    const rows: HTMLElement[] = [];
    const say = (dot: 'ok' | 'warn' | 'off', text: string) => {
      rows.push(el('div', { class: 'status-row' }, el('span', { class: `dot ${dot}` }), text));
    };

    // --- what is running, and whose it is ---------------------------------
    const weights = st.model ? `the ${st.model} weights` : 'weights it did not name';
    const port = st.port ? ` on port ${st.port}` : '';

    if (st.state === 'ready' && st.adopted) {
      say(
        'ok',
        `Using ${weights}, on a transcription server that was already running${port}. Riffsheet joined it instead of starting a second copy, so the choice above cannot change it — those weights belong to whoever started that server. Quit it and Riffsheet will start its own.`
      );
    } else if (st.state === 'ready') {
      say('ok', `Riffsheet started the transcription server itself${port}, using ${weights}.`);
    } else if (st.state === 'starting') {
      say('off', 'Starting the transcription server. The very first run downloads the weights too, which takes a few minutes.');
    } else if (st.state === 'failed') {
      say('warn', 'The transcription server could not start.');
    } else {
      say('off', 'The transcription server is not running. It starts by itself the first time you turn a recording into notes.');
    }

    // --- what is on this machine ------------------------------------------
    const wanted = s.engineModel === 'auto' ? '' : s.engineModel;
    if (st.installedModels && st.installedModels.length > 0) {
      say('off', `Installed on this machine: ${humanList(st.installedModels)}.`);
      if (wanted && !st.installedModels.includes(wanted)) {
        say('warn', `The ${wanted} weights are not on this machine yet, so the engine has to download them the first time it uses them.`);
      }
    } else if (st.installedModels) {
      say('warn', 'No weights are installed on this machine yet.');
    }

    // --- memory ------------------------------------------------------------
    const free = st.ramFreeMb ?? 0;
    if (free > 0) {
      say(
        'off',
        st.ramTotalMb ? `${formatMb(free)} of memory free, out of ${formatMb(st.ramTotalMb)}.` : `${formatMb(free)} of memory free.`
      );

      // Only warn about weights that are not already loaded. Once a server is up with them the
      // memory is spent and there is nothing left to warn about.
      const sized = wanted || (st.state === 'ready' ? st.model : '');
      const needs = MODEL_RAM_MB[sized];
      const alreadyUp = st.state === 'ready' && st.model === sized;
      if (needs && !alreadyUp && free < needs + RAM_HEADROOM_MB) {
        say(
          'warn',
          `The ${sized} weights want roughly ${formatMb(needs)} and only ${formatMb(free)} is free right now. They may be very slow, or fail to load at all. Closing a few other apps — or picking a smaller size above — is the fix.`
        );
      }
    }

    // --- who has it right now ----------------------------------------------
    if (st.busy && st.busyOwner === 'other') {
      say('warn', 'Busy: another Riffsheet is transcribing right now. Yours starts as soon as that one finishes.');
    } else if (st.busy) {
      say('off', 'Transcribing right now.');
    } else if (st.state === 'ready') {
      say('ok', 'Free right now — nothing else is using it.');
    }

    if (st.queueLength > 0) {
      const jobs = st.queueLength === 1 ? '1 job is' : `${st.queueLength} jobs are`;
      say(
        'off',
        st.queuePosition > 0 ? `${jobs} waiting, and yours is number ${st.queuePosition} in the line.` : `${jobs} waiting.`
      );
    }

    if (st.error) say('warn', st.error);

    replace(host, ...rows);
  }

  // -------------------------------------------------------------------------
  // Engine setup — a guide and a search, not an installer
  // -------------------------------------------------------------------------

  /**
   * One card per engine, and the guided one's card is the old screen.
   *
   * This used to be a single engine's worth of screen, and the note at the top of it said the
   * picker was a decision not yet taken. It is taken: Riffsheet drives several engines, and
   * this is where you choose between them. What did NOT change is the body of MuScriptor's
   * card — it is the same markup with the same `data-role` attributes it has always had, moved
   * inside a card rather than rewritten, because those roles are what `openEngineSetup()`
   * scrolls to and what eleven checks in the harness read.
   *
   * The rule the cards encode, said once here rather than implied everywhere: an engine is
   * installable in one click ONLY when its licence permits Riffsheet to fetch its bytes. Some
   * engines are better and still guide-only forever, and a card that offered to install one of
   * those would be making a promise the licence forbids.
   *
   * The searched list on the guided card is the part that earns its space. The reported bug was
   * "not found at <one canonical path nobody has>", on a machine with a perfectly good engine
   * installed somewhere else; a list you can read against your own disk turns that dead end
   * into a fix, and the engine.json box below it is how you say "it is over here" in a way a
   * Finder-launched DAW can actually read.
   */
  private renderEngineSetup(): void {
    const host = this.engineSetupHost;
    if (!host) return;

    const list = this.engines;

    // A shell that has only ever had one engine has no list to loop over. It gets exactly the
    // screen it has always had — the guide, on its own, every role where it has always been.
    // An empty picker would imply a choice that shell cannot make.
    if (!list || list.engines.length === 0) {
      replace(host, this.guideStatusRow(this.engine), ...this.guideBody(this.engine));
      return;
    }

    const rows: HTMLElement[] = [];

    // What `auto` currently means, in the shell's own words. The same shape as the model
    // read-out above: a resolution the user did not make, explained rather than hidden.
    if (list.engineReason) {
      rows.push(
        el('div', {
          class: 'status-row dim',
          'data-role': 'engine-setup-reason',
          text: list.engineReason
        })
      );
    }

    if (this.engineSelectError) {
      rows.push(
        el(
          'div',
          { class: 'status-row', 'data-role': 'engine-select-error' },
          el('span', { class: 'dot warn' }),
          this.engineSelectError
        )
      );
    }

    for (const engine of list.engines) rows.push(this.engineCard(engine, list));
    replace(host, ...rows);
  }

  /**
   * One engine, as a card.
   *
   * The header carries the three things somebody scanning has to be able to compare at a
   * glance — the name, the tier it is in, and whether it is here — and the line under it says
   * what the engine is actually GOOD at. That capability line is not decoration: "one-click"
   * is worth nothing on its own, and the honest comparison is "a bass specialist that matched
   * the big engine note for note" against "the best thing here, but you install it by hand".
   */
  private engineCard(engine: EngineSummary, list: EngineListResult): HTMLElement {
    const st = this.statusFor(engine);
    const isGuide = engine.install === 'guide';
    const usable = engine.state === 'ready' || engine.state === 'installed';
    const chosen = list.configuredEngine === engine.id;
    const inCharge = list.resolvedEngine === engine.id;

    const rows: HTMLElement[] = [];

    // The state sentence. The guided engine's version keeps the role it has always had —
    // `engine-setup-status` — because that is the one the harness and `openEngineSetup()`
    // read; every other card gets the generic role. One row either way, never two.
    rows.push(isGuide ? this.guideStatusRow(st) : this.engineStateRow(engine));

    rows.push(
      el('div', {
        class: 'status-row dim',
        'data-role': 'engine-card-strengths',
        text: this.capabilityLine(engine)
      })
    );

    rows.push(this.engineButtons(engine, chosen, usable));

    if (isGuide) rows.push(...this.guideBody(st));
    else if (engine.install === 'one-click') rows.push(...this.oneClickBody(engine));

    return el(
      'div',
      {
        // `.on` is "this is the engine actually doing the listening right now", which is not
        // always the one that was chosen: an engine you picked but have not installed yet
        // falls back, and saying so is the whole reason `engineReason` exists.
        class: `engine-card${inCharge ? ' on' : ''}`,
        'data-role': 'engine-card',
        'data-engine-id': engine.id,
        'data-engine-install': engine.install,
        'data-engine-state': engine.state
      },
      el(
        'header',
        {},
        el('span', { class: 'engine-name', text: engine.name }),
        el('span', { class: 'chip tier', 'data-role': 'engine-card-tier', text: engine.tier }),
        el('span', { class: `dot ${engine.error ? 'warn' : usable ? 'ok' : 'off'}` })
      ),
      ...rows
    );
  }

  /** "Good at: Bass · 57 MB download · installs in one click". */
  private capabilityLine(engine: EngineSummary): string {
    const parts: string[] = [];
    if (engine.instrumentStrengths.length > 0) {
      parts.push(`Good at: ${humanList(engine.instrumentStrengths)}`);
    }
    if (engine.install === 'bundled') {
      if (engine.approxDiskBytes > 0) parts.push(`${formatBytes(engine.approxDiskBytes)}, already here`);
      parts.push('no setup needed');
    } else if (engine.install === 'one-click') {
      if (engine.approxDiskBytes > 0) parts.push(`${formatBytes(engine.approxDiskBytes)} to download`);
      parts.push(engine.state === 'not-installed' ? 'installs in one click' : 'installed by Riffsheet');
    } else {
      if (engine.approxPeakRssMb > 0) parts.push(`about ${formatMb(engine.approxPeakRssMb)} of memory while it runs`);
      // Said on the card itself, not only in the policy line further down, because this is the
      // sentence that explains why the best engine here has no Install button.
      parts.push('guided setup — its licence does not let Riffsheet install it');
    }
    return parts.join(' · ');
  }

  /** The state sentence for anything that is not the guided engine. */
  private engineStateRow(engine: EngineSummary): HTMLElement {
    const usable = engine.state === 'ready' || engine.state === 'installed';
    const text =
      engine.error ??
      (engine.detail ||
        (engine.state === 'ready'
          ? 'Ready.'
          : engine.state === 'installed'
            ? 'Installed. It starts when you press Listen.'
            : engine.state === 'broken'
              ? 'Installed, but it did not run. Removing and installing it again is the fix.'
              : 'Not installed yet.'));
    return el(
      'div',
      { class: 'status-row', 'data-role': 'engine-card-state' },
      el('span', { class: `dot ${engine.error ? 'warn' : usable ? 'ok' : 'off'}` }),
      text
    );
  }

  /** Use this engine / Install / Cancel / Uninstall — whichever this engine can honestly offer. */
  private engineButtons(engine: EngineSummary, chosen: boolean, usable: boolean): HTMLElement {
    const buttons: HTMLElement[] = [];
    // Machine-wide: an install this window did not start still owns the card while it runs.
    const installing = this.installingHere.has(engine.id) || engine.installing;

    buttons.push(
      el('button', {
        class: `chip${chosen ? ' on' : ''}`,
        'data-role': 'engine-use',
        'data-setting': 'engineId',
        'aria-pressed': String(chosen),
        // Not disabled when it is already the choice: `aria-pressed` says so, and a disabled
        // control that is disabled *because it worked* reads as a fault.
        title: usable
          ? undefined
          : 'You can choose it now — Riffsheet falls back to the built-in engine until it is installed.',
        text: chosen ? 'In use' : 'Use this engine',
        onClick: () => void this.useEngine(engine.id)
      })
    );

    if (engine.install === 'one-click' && this.bridge.installEngine) {
      if (installing) {
        if (this.bridge.cancelInstall) {
          buttons.push(
            el('button', {
              class: 'chip',
              'data-role': 'engine-install-cancel',
              text: 'Cancel',
              onClick: () => void this.cancelEngineInstall(engine)
            })
          );
        }
      } else if (engine.state === 'not-installed' || engine.state === 'broken') {
        buttons.push(
          el('button', {
            class: 'chip',
            'data-role': 'engine-install',
            text: engine.state === 'broken' ? 'Install again' : 'Install',
            onClick: () => void this.installEngine(engine)
          })
        );
      }

      if (usable && this.bridge.uninstallEngine) {
        buttons.push(
          el('button', {
            class: 'chip',
            'data-role': 'engine-uninstall',
            text: 'Uninstall',
            onClick: () => void this.uninstallEngine(engine)
          })
        );
      }
    }

    return el('div', { class: 'row' }, ...buttons);
  }

  /**
   * The one-click card's body: a live progress row, then how it ended.
   *
   * No bytes ever cross the bridge for this — the download streams to disk natively and these
   * frames carry integers and short strings — so a 400 MB engine is not a payload problem.
   *
   * A FAILURE RENDERS AS A GUIDE. When the shell refuses (no Python it can use, for instance)
   * it answers with the same `{what, detail}` steps a guided engine ships, and they are drawn
   * with the same `ol.setup-steps` markup. The failure path is a way forward, not a dead end.
   */
  private oneClickBody(engine: EngineSummary): HTMLElement[] {
    const rows: HTMLElement[] = [];

    if (!this.bridge.installEngine) {
      rows.push(
        el('div', {
          class: 'status-row dim',
          text: 'This version of Riffsheet cannot install engines for you. Updating it is the fix.'
        })
      );
      return rows;
    }

    const frame = this.installProgress.get(engine.id);
    if (frame) {
      const fraction = typeof frame.fraction === 'number' ? Math.max(0, Math.min(1, frame.fraction)) : null;
      const bytes =
        typeof frame.receivedBytes === 'number' && typeof frame.totalBytes === 'number' && frame.totalBytes > 0
          ? `${formatBytes(frame.receivedBytes)} of ${formatBytes(frame.totalBytes)}`
          : '';
      const words = [
        INSTALL_STAGE_WORDS[frame.stage] ?? frame.stage,
        fraction !== null ? `${Math.round(fraction * 100)}%` : '',
        bytes,
        frame.message ?? ''
      ].filter((w) => w.length > 0);

      rows.push(
        el(
          'div',
          { class: 'status-row', 'data-role': 'engine-install-progress' },
          el(
            'div',
            { class: 'progress' },
            // An indeterminate stage (verifying, unpacking) still shows a bar rather than an
            // empty box, because "nothing is happening" is exactly what an empty box says.
            el('i', { style: { width: fraction !== null ? `${Math.round(fraction * 100)}%` : '100%' } })
          ),
          words.join(' · ')
        )
      );
    }

    const outcome = this.installOutcome.get(engine.id);
    if (outcome) {
      rows.push(
        el(
          'div',
          { class: 'status-row', 'data-role': 'engine-install-result' },
          el('span', { class: `dot ${outcome.ok ? 'ok' : 'warn'}` }),
          outcome.text
        )
      );
      if (outcome.steps.length > 0) {
        rows.push(
          el(
            'ol',
            { class: 'setup-steps', 'data-role': 'engine-install-steps' },
            ...outcome.steps.map((step) =>
              el('li', {}, el('strong', { text: step.what }), el('div', { class: 'dim', text: step.detail }))
            )
          )
        );
      }
    }

    return rows;
  }

  /**
   * "Is the guided engine here, and where?"
   *
   * Three different things, and they must not share a sentence: "asked and it is here", "asked
   * and it is not", and "have not been able to ask". The last one is a browser or an older
   * shell, and calling that "not installed" would be a guess about somebody's disk.
   */
  private guideStatusRow(st: EngineStatus | null): HTMLElement {
    const found = st?.engineInstalled === true;
    const where = st?.executable || st?.venv || '';
    const unaskable = !this.bridge.engineStatus;
    return el(
      'div',
      { class: 'status-row', 'data-role': 'engine-setup-status' },
      el('span', { class: `dot ${found ? 'ok' : unaskable || !st ? 'off' : 'warn'}` }),
      unaskable
        ? 'This version of Riffsheet cannot ask where the listening engine is. The steps below still apply.'
        : !st
          ? 'Asking where the listening engine is…'
          : found
            ? `Listening engine found at ${where}`
            : 'No listening engine found on this machine yet. MIDI, MusicXML and score files still work; only listening to audio needs it.'
    );
  }

  /**
   * Everything under the guided engine's status line — the old setup screen, verbatim.
   *
   * Every `data-role` in here is exactly the one it has always been. The only real change is
   * that the steps now come from the ENGINE (`status.guideSteps`) rather than from a copy this
   * file used to keep, so there is one guide rather than two that could drift apart.
   */
  private guideBody(st: EngineStatus | null): HTMLElement[] {
    const rows: HTMLElement[] = [];
    const found = st?.engineInstalled === true;

    // The promise this card makes, said out loud. It is about THIS engine and its licence, not
    // about Riffsheet in general — the one-click cards above install themselves in a click,
    // and pretending otherwise here would be the same lie in the other direction.
    rows.push(
      el('div', {
        class: 'status-row dim',
        'data-role': 'engine-setup-policy',
        text:
          'Riffsheet cannot install this one for you: its weights are non-commercial and licence-gated, so they are not Riffsheet’s to fetch. These are the steps to run once, in Terminal; then press Check again.'
      })
    );

    // --- the steps, straight from the engine -------------------------------
    // The row above has just promised "these are the steps to run once, in Terminal". When the
    // shell answers with nothing — an older shell, a manifest with no guide, or a status that
    // arrived before the engine was identified — that promise was followed by an empty space,
    // which is the one outcome worse than saying nothing at all. FALLBACK_GUIDE_STEPS is the
    // generic form of what every manifest here says, so the screen always ends in something a
    // person can actually type.
    const steps = normalizeGuideSteps(st?.guideSteps);
    const shown = steps.length > 0 ? steps : FALLBACK_GUIDE_STEPS;
    if (shown.length > 0) {
      rows.push(
        el(
          'ol',
          { class: 'setup-steps', 'data-role': 'engine-setup-steps' },
          ...shown.map((step) =>
            el('li', {}, el('strong', { text: step.what }), el('div', { class: 'dim', text: step.detail }))
          )
        )
      );
    }

    // --- where it looked ---------------------------------------------------
    const searched = st?.searchedPaths ?? [];

    if (searched.length > 0) {
      rows.push(
        el('button', {
          class: 'chip',
          'data-role': 'engine-setup-searched-toggle',
          'aria-expanded': String(this.searchedOpen),
          text: `${this.searchedOpen ? '▾' : '▸'} Where Riffsheet looked on this machine (${searched.length})`,
          onClick: () => {
            this.searchedOpen = !this.searchedOpen;
            this.renderEngineSetup();
          }
        })
      );

      if (this.searchedOpen) {
        rows.push(
          el(
            'ol',
            { class: 'setup-paths', 'data-role': 'engine-setup-searched' },
            ...searched.map((p) => el('li', { text: p }))
          )
        );
      }
    }

    // --- custom location ---------------------------------------------------
    // Deliberately the LAST thing, and deliberately a path plus a copy button rather than a
    // file picker: what has to end up on disk is a two-line JSON file, and the only hard part
    // is knowing where to put it.
    const configPath = st?.engineConfigPath;

    if (configPath) {
      rows.push(
        el('div', {
          class: 'status-row',
          text: 'Already have MuScriptor somewhere else? Point Riffsheet at it by putting {"venv": "/path/to/your/venv"} in this file, then press Check again:'
        }),
        el(
          'div',
          { class: 'settings-row' },
          el('code', { class: 'path', 'data-role': 'engine-config-path', text: configPath }),
          el('button', {
            class: 'chip',
            'data-role': 'engine-config-copy',
            text: this.pathCopied ? 'Copied' : 'Copy path',
            onClick: () => void this.copyEngineConfigPath(configPath)
          })
        )
      );
    }

    // --- the buttons -------------------------------------------------------
    const buttons: HTMLElement[] = [];

    // Hidden rather than disabled when the shell is too old to re-run discovery: a button that
    // cannot do its one job is worse than no button.
    if (this.bridge.recheckEngine) {
      buttons.push(
        el('button', {
          class: 'chip',
          'data-role': 'engine-recheck',
          disabled: this.rechecking,
          text: this.rechecking ? 'Checking…' : 'Check again',
          onClick: () => void this.recheckEngine()
        })
      );
    }

    if (this.bridge.openEngineSetup) {
      buttons.push(
        el('button', {
          class: 'chip',
          'data-role': 'engine-setup-folder',
          text: 'Open the setup folder',
          onClick: () => void this.bridge.openEngineSetup?.().catch(() => undefined)
        })
      );
    }

    if (buttons.length > 0) rows.push(el('div', { class: 'row' }, ...buttons));

    if (this.recheckSaid) {
      rows.push(
        el(
          'div',
          { class: 'status-row', 'data-role': 'engine-recheck-said' },
          el('span', { class: `dot ${found ? 'ok' : 'warn'}` }),
          this.recheckSaid
        )
      );
    }

    return rows;
  }

  /**
   * Choose an engine, machine-wide.
   *
   * The shell is allowed to say no — it refuses while anything on this machine is transcribing,
   * for exactly the reason it refuses a model swap mid-job — and when it does, the sentence it
   * gives back IS the answer. The local setting goes back to what it was, so the marked card
   * never claims something the engine is not doing.
   */
  private async useEngine(id: string): Promise<void> {
    // Cleared BEFORE the write, because the write re-renders: leave it until afterwards and
    // last time's refusal is still on screen under a card that has just been accepted.
    this.engineSelectError = null;
    const previous = this.opts.settings.get().engineId;
    // Neither a rebuild nor a view change: this decides how the NEXT transcription listens, and
    // the sheet on screen was written by whatever was in charge at the time.
    this.opts.settings.set({ engineId: id });

    let refusal: string | null = null;
    try {
      const result = await this.bridge.selectEngine?.(id);
      if (result && !result.ok) refusal = result.error ?? 'The engine could not be changed.';
    } catch (err) {
      refusal = err instanceof Error ? err.message : 'The engine could not be asked to change.';
    }

    if (refusal) {
      this.engineSelectError = refusal;
      this.opts.settings.set({ engineId: previous });
    }
    void this.askEngine();
  }

  /** Download and set up a one-click engine, with the whole of it on screen while it runs. */
  private async installEngine(engine: EngineSummary): Promise<void> {
    if (!this.bridge.installEngine || this.installingHere.has(engine.id)) return;
    this.installOutcome.delete(engine.id);
    // A frame of our own first, so the row exists before the shell's first event arrives.
    // Without it the button looks unpressed for as long as the disk check takes.
    this.installProgress.set(engine.id, {
      jobId: 0,
      id: engine.id,
      stage: 'checking',
      message: 'Starting…'
    });
    this.installingHere.add(engine.id);
    this.renderEngineSetup();

    try {
      const result = await this.bridge.installEngine(engine.id);
      this.installOutcome.set(engine.id, {
        ok: result.ok,
        text: result.ok
          ? [
              'Installed.',
              result.location ? `It lives at ${result.location}.` : '',
              result.bytesOnDisk ? `${formatBytes(result.bytesOnDisk)} on disk.` : ''
            ]
              .filter((s) => s.length > 0)
              .join(' ')
          : result.cancelled
            ? 'Install cancelled. Nothing was left behind.'
            : (result.error ?? 'The install did not finish.'),
        steps: normalizeGuideSteps(result.guideSteps)
      });
    } catch (err) {
      this.installOutcome.set(engine.id, {
        ok: false,
        text: err instanceof Error ? err.message : 'The install did not finish.',
        steps: []
      });
    } finally {
      this.installingHere.delete(engine.id);
      this.installProgress.delete(engine.id);
      this.renderEngineSetup();
      // The card's state has just changed on disk; ask rather than assume.
      void this.askEngine();
    }
  }

  private async cancelEngineInstall(engine: EngineSummary): Promise<void> {
    const jobId = this.installJobs.get(engine.id);
    // 0 means "no frame has named a job yet" — cancel whatever is running rather than nothing.
    await this.bridge.cancelInstall?.(jobId ? jobId : undefined).catch(() => ({ cancelled: 0 }));
  }

  private async uninstallEngine(engine: EngineSummary): Promise<void> {
    if (!this.bridge.uninstallEngine) return;
    const result: { ok: boolean; freedBytes?: number; error?: string } = await this.bridge
      .uninstallEngine(engine.id)
      .catch(() => ({ ok: false, error: 'The engine could not be removed.' }));
    this.installOutcome.set(engine.id, {
      ok: result.ok === true,
      text: result.ok
        ? `Removed${result.freedBytes ? `, ${formatBytes(result.freedBytes)} freed` : ''}.`
        : (result.error ?? 'The engine could not be removed.'),
      steps: []
    });
    this.renderEngineSetup();
    void this.askEngine();
  }

  /**
   * Look at the disk again, now.
   *
   * The whole point is that it is LIVE: the shell re-runs the entire search — environment
   * override, engine.json, the recommended folder, portable layouts, the known hand-built
   * locations, PATH — rather than repeating what it decided when the plugin loaded. Somebody
   * who has just finished the steps above should not have to restart their DAW to be found.
   */
  private async recheckEngine(): Promise<void> {
    if (!this.bridge.recheckEngine || this.rechecking) return;
    this.rechecking = true;
    this.recheckSaid = null;
    this.renderEngineSetup();

    try {
      const status = await this.bridge.recheckEngine();
      if (status) this.engine = status;
      this.recheckSaid = status?.engineInstalled
        ? `Found it: ${status.executable || status.venv || 'installed'}`
        : 'Still nothing. The list above is every place that was looked in — if yours is not on it, use the engine.json box.';
    } catch {
      this.recheckSaid = 'The engine could not be asked. Nothing has changed.';
    } finally {
      this.rechecking = false;
      this.renderEngineSetup();
      this.renderEngineReadout();
      // Discovery has just run for EVERY engine, so the card list and the guided engine's own
      // status are both stale. One ask puts all of them right.
      void this.askEngine();
    }
  }

  /**
   * Put the engine.json path on the clipboard.
   *
   * `navigator.clipboard` is not there in every WebView, and a silent failure on a "Copy"
   * button is a small betrayal, so a failed copy selects the text instead — which leaves the
   * player one ⌘C away rather than nowhere.
   *
   * The fallback takes the role it should select as a parameter rather than hard-coding one.
   * There is more than one card on this screen now, and a selection fallback that always
   * reached for the same element would highlight the wrong card's path the moment a second
   * engine grows one.
   */
  private async copyEngineConfigPath(path: string, role = 'engine-config-path'): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
      this.pathCopied = true;
    } catch {
      this.pathCopied = false;
      const node = this.root.querySelector(`[data-role="${role}"]`);
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    this.renderEngineSetup();
    window.setTimeout(() => {
      this.pathCopied = false;
      this.renderEngineSetup();
    }, 2000);
  }

  /**
   * Settings → Playback → Sound.
   *
   * One list, not two questions. It used to ask for a *source* first and then, only if you
   * had landed on the basic synth, for a *timbre* — which is a fair description of the code
   * and a poor description of what a player wants, which is to pick a sound. Worse, the
   * second half was invisible unless you went looking for it, and the reported complaint
   * was exactly that nothing could be found. Recordings come first because they are the
   * ones worth having; `<optgroup>` says which is which without a sentence of explanation.
   *
   * The status line under it is not decoration: a recorded set can fail to load, and when
   * it does the app quietly plays the oscillator instead. Saying so is the difference
   * between "this sounds wrong" and "oh, those recordings are missing".
   *
   * The same picker also lives on the transport bar next to the fader — see `soundPicker()`
   * — because that is where somebody comparing two sounds is actually looking.
   */
  private soundSection(s: AppSettings): DocumentFragment {
    const status = sampleStatus();
    const chosen = soundOptionFor(s.playbackVoice);

    const fragment = document.createDocumentFragment();
    fragment.append(
      el(
        'div',
        { class: 'settings-row', title: t(TIPS.sound) },
        el('span', { class: 'label', text: 'Sound' }),
        soundSelect(
          s.playbackVoice,
          status,
          (voice) => this.set('playbackVoice', voice, false),
          'Playback sound'
        )
      )
    );

    const note = soundNote(s.playbackVoice, status);
    if (note) {
      fragment.append(
        el(
          'div',
          { class: 'status-row', 'data-role': 'sound-status' },
          el('span', { class: `dot ${note.dot}` }),
          // The credit travels with the sound. Every set is MIT or CC0 (webcore/CREDITS.md) and
          // saying whose recording you are listening to costs one short line.
          chosen.source ? `${note.text} ${chosen.source}.` : note.text
        )
      );
    }

    return fragment;
  }

  private render(): void {
    const s = this.opts.settings.get();
    const host = this.opts.runtime.get().host;
    const source = this.opts.runtime.get().source;
    // What the shell reported doing to the audio before the last engine heard it. Empty until
    // a transcription has said something, which is why the row below is conditional.
    const preprocessNote = this.opts.runtime.get().preprocessNote;

    // Built here and filled in afterwards, so the two-second poll has a stable element to
    // refresh without redrawing the controls around it.
    const engineReadout = el('div', { 'data-role': 'engine-readout' });
    this.engineReadout = engineReadout;
    const engineSetup = el('div', { class: 'engine-setup', 'data-role': 'engine-setup' });
    this.engineSetupHost = engineSetup;

    replace(
      this.root,
      el(
        'div',
        { class: 'row' },
        el('h2', { text: 'Settings' }),
        el('div', { class: 'spacer' }),
        el('button', { class: 'ghost icon', text: '✕', 'aria-label': 'Close settings', onClick: () => this.opts.onClose() })
      ),

      // --- notation ---------------------------------------------------------
      el(
        'div',
        { class: 'settings-group' },
        el('h3', { text: 'Notation' }),
        el(
          'div',
          { class: 'settings-row', 'data-setting': 'grid' },
          el('span', { class: 'label', text: 'Grid' }),
          chipGroup<NotationGrid>(
            s.grid,
            [
              { value: 'auto', label: 'Auto' },
              { value: 'quarter', label: '1/4' },
              { value: 'eighth', label: '1/8' },
              { value: 'sixteenth', label: '1/16' },
              { value: 'triplet', label: 'Triplet' },
              { value: 'free', label: 'Free' }
            ],
            (v) => this.set('grid', v, true),
            TIPS.grid
          )
        ),
        // Said in the panel and not only in a tooltip, because the two grids now sit in
        // different panes and the one question the split has to answer on sight is "which
        // one am I touching, and does it change what I recorded?".
        el('div', {
          class: 'status-row',
          text: 'Auto is the only setting that can write straight notes and triplets together. Naming a size forbids everything finer. The piano roll has its own, separate grid.'
        }),
        el(
          'div',
          { class: 'settings-row', 'data-setting': 'clefMode' },
          el('span', { class: 'label', text: 'Clef' }),
          chipGroup<ClefMode>(
            s.clefMode,
            [
              { value: 'auto', label: 'Auto' },
              { value: 'treble', label: 'Treble' },
              { value: 'bass', label: 'Bass' },
              { value: 'grand', label: 'Grand' }
            ],
            (v) => this.set('clefMode', v, true),
            TIPS.clef
          )
        ),
        el('div', {
          class: 'status-row',
          text: 'Auto chooses one stable clef for the part. Grand uses stacked treble and bass staves.'
        }),
        el(
          'label',
          { class: 'switch settings-row', title: t(TIPS.fillGaps) },
          el('input', {
            type: 'checkbox',
            'data-setting': 'fillGaps',
            checked: s.fillGaps,
            onChange: (e: Event) => this.set('fillGaps', (e.target as HTMLInputElement).checked, true)
          }),
          // It was called "Clean up rests", which is what the RESULT looks like and not what
          // the switch does: it pushes note off-times forward before any rest object exists,
          // so what it actually changes is written note lengths — and with them the playback
          // and the tidied-up MIDI export. Reported from the field as "does not work properly,
          // it seems to do other things", which was an accurate reading of a wrong label.
          el('span', { text: 'Reduce rests by extending notes' })
        ),
        el('div', {
          class: 'status-row',
          text:
            'Lengthens short notes across small gaps so the page is not full of tiny rests. ' +
            'The "as played" MIDI is unchanged.'
        }),
        el(
          'div',
          { class: 'settings-row', 'data-setting': 'fingering' },
          el('span', { class: 'label', text: 'Fingering' }),
          chipGroup<FingeringStyle>(
            s.fingering,
            [
              { value: 'low-positions', label: 'Low positions' },
              { value: 'minimize-movement', label: 'Least movement' }
            ],
            (v) => this.set('fingering', v, true),
            TIPS.fingering
          )
        ),
        // How far up the neck a hand edit may go. It sits with Fingering because it is the
        // same subject — where on the neck a note is put — and it was the one setting in the
        // file with no control anywhere: `AppSettings.maxFret` has always been read by the
        // sheet's drag handling and by the edit actions, and `TriView.setFretLimit()` was
        // written to "keep the fret limit in step with the settings panel" against a panel
        // that had nothing to keep it in step with.
        //
        // `false` for the rebuild argument, and that is the honest wiring rather than a
        // shortcut: this number reaches the EDITS, not the pipeline (`BuildSettings` never
        // receives it), so there is nothing to re-quantize and re-writing the sheet would
        // claim an effect it does not have. The status row below says so out loud.
        el(
          'div',
          { class: 'settings-row', 'data-setting': 'maxFret', title: t(TIPS.maxFret) },
          el('span', { class: 'label', text: 'Highest fret' }),
          el(
            'select',
            {
              'aria-label': 'Highest fret',
              'data-role': 'max-fret',
              onChange: (e: Event) =>
                this.set('maxFret', Number((e.target as HTMLSelectElement).value), false)
            },
            ...fretOptions(s.maxFret).map((fret) =>
              el('option', { value: String(fret), text: `${fret} frets`, selected: fret === s.maxFret })
            )
          )
        ),
        el('div', {
          class: 'status-row',
          text: 'How far up the neck the app may go when you move a note by hand. A drag that would need a higher fret is refused. It does not re-fret what is already written.'
        }),
        el(
          'label',
          { class: 'switch settings-row', title: t(TIPS.noteNames) },
          el('input', {
            type: 'checkbox',
            'data-setting': 'showNoteNames',
            checked: s.showNoteNames,
            onChange: (e: Event) => this.set('showNoteNames', (e.target as HTMLInputElement).checked, false)
          }),
          el('span', { text: 'Show note names' })
        ),
        el(
          'label',
          { class: 'switch settings-row', title: t(TIPS.preciseBeats) },
          el('input', {
            type: 'checkbox',
            'data-setting': 'preciseBeats',
            checked: s.preciseBeats,
            // Not a rebuild: it changes how the NEXT transcription listens, and the sheet
            // on screen was built from beats that already exist.
            onChange: (e: Event) => this.set('preciseBeats', (e.target as HTMLInputElement).checked, false)
          }),
          el('span', { text: 'Follow a drifting tempo' })
        ),
        source?.hostGrid &&
          el(
            'label',
            { class: 'switch settings-row', title: t(TIPS.hostSync) },
            el('input', {
              type: 'checkbox',
              'data-setting': 'useHostGrid',
              checked: s.useHostGrid,
              onChange: (e: Event) => this.set('useHostGrid', (e.target as HTMLInputElement).checked, true)
            }),
            el('span', { text: 'Use the DAW’s bars and tempo' })
          )
      ),

      // --- piano roll -------------------------------------------------------
      // Its own group now, because it has four switches rather than one. The pane carries
      // chips for the first two of these; the chips and these boxes write the same settings,
      // so whichever the player reaches for, the other follows.
      el(
        'div',
        { class: 'settings-group' },
        el('h3', { text: 'Piano roll' }),
        el(
          'label',
          { class: 'switch settings-row', title: t(TIPS.pianoRoll) },
          el('input', {
            type: 'checkbox',
            'data-setting': 'showPianoRoll',
            checked: s.showPianoRoll,
            onChange: (e: Event) => this.set('showPianoRoll', (e.target as HTMLInputElement).checked, false)
          }),
          el('span', { text: 'Show the piano roll' })
        ),
        el(
          'label',
          { class: 'switch settings-row', title: t(TIPS.rollAllNoteNames) },
          el('input', {
            type: 'checkbox',
            'data-setting': 'rollAllNoteNames',
            checked: s.rollAllNoteNames,
            onChange: (e: Event) => this.set('rollAllNoteNames', (e.target as HTMLInputElement).checked, false)
          }),
          el('span', { text: 'Name every row of the piano roll, not just the C’s' })
        ),
        el(
          'label',
          { class: 'switch settings-row', title: t(TIPS.rollEditing) },
          el('input', {
            type: 'checkbox',
            'data-setting': 'rollEditing',
            checked: s.rollEditing,
            onChange: (e: Event) => this.set('rollEditing', (e.target as HTMLInputElement).checked, false)
          }),
          // "drag" was only a third of it — the roll also adds on a double-click and deletes
          // on the Delete key, and all three rewrite the sheet.
          el('span', { text: 'Let me edit notes on the piano roll' })
        ),
        // Beside the editing switch, because that is what it is: an edit, made by the app
        // instead of by hand. The highlights it leaves live on this pane and on the waveform,
        // so the setting belongs with them rather than under transcription — the transcription
        // is finished by the time this runs.
        el(
          'label',
          { class: 'switch settings-row', title: t(TIPS.autoSplitAtAttacks) },
          el('input', {
            type: 'checkbox',
            'data-setting': 'autoSplitAtAttacks',
            checked: s.autoSplitAtAttacks,
            onChange: (e: Event) => this.set('autoSplitAtAttacks', (e.target as HTMLInputElement).checked, false)
          }),
          el('span', { text: 'Split run-together notes where I hear a second strike' })
        ),
        el('div', {
          class: 'status-row dim',
          text: 'Off, it still shows you where it heard one — it just does not touch your notes.'
        }),
        // The roll's OWN grid. `false` for the third argument is the whole point of the
        // split: unlike the notation grid, changing this rebuilds nothing — the pipeline
        // never receives it, so there is no sheet to re-write.
        el(
          'div',
          { class: 'settings-row', 'data-setting': 'rollGrid' },
          el('span', { class: 'label', text: 'Grid' }),
          chipGroup<RollGrid>(
            s.rollGrid,
            [
              { value: 'quarter', label: '1/4' },
              { value: 'eighth', label: '1/8' },
              { value: 'sixteenth', label: '1/16' },
              { value: 'triplet', label: 'Triplet' },
              { value: 'free', label: 'Free' }
            ],
            (v) => this.set('rollGrid', v, false),
            TIPS.rollGrid
          )
        ),
        el('div', {
          class: 'status-row',
          text: 'Columns on the roll, and the length of a note you add by hand. It never changes what was transcribed.'
        })
      ),

      // --- playback ---------------------------------------------------------
      el(
        'div',
        { class: 'settings-group' },
        el('h3', { text: 'Playback' }),
        this.soundSection(s),
        el(
          'label',
          { class: 'switch settings-row', title: t(TIPS.metronome) },
          el('input', {
            type: 'checkbox',
            'data-setting': 'metronome',
            checked: s.metronome,
            onChange: (e: Event) => this.set('metronome', (e.target as HTMLInputElement).checked, false)
          }),
          el('span', { text: 'Metronome click' })
        )
      ),

      // --- help -------------------------------------------------------------
      el(
        'div',
        { class: 'settings-group' },
        el('h3', { text: 'Help' }),
        el(
          'label',
          { class: 'switch settings-row', title: TIPS.tooltips },
          el('input', {
            type: 'checkbox',
            checked: tipsEnabled(),
            onChange: (e: Event) => {
              setTipsEnabled((e.target as HTMLInputElement).checked);
              this.render();
            }
          }),
          el('span', { text: 'Explain things when I hover' })
        )
      ),

      // --- the transcription engine -----------------------------------------
      // One group, not two. Which weights you ask for and what the engine is actually doing
      // are the same subject, and splitting them is how a setting ends up looking broken on
      // the day a server it does not own is the thing in charge.
      el(
        'div',
        { class: 'settings-group' },
        el('h3', { text: 'Transcription engine' }),
        el(
          'div',
          { class: 'status-row', title: t(TIPS.engineStatus) },
          el('span', { class: `dot ${host?.engineAvailable ? 'ok' : 'warn'}` }),
          host
            ? `${host.engineAvailable ? 'Ready' : 'Not installed'} · ${host.hostName ?? host.host}${
                host.isPlugin ? ' · plugin' : ''
              }`
            : 'Checking…'
        ),
        host?.engineMessage && el('div', { class: 'status-row', text: host.engineMessage }),
        el(
          'div',
          { class: 'settings-row' },
          el('span', { class: 'label', text: 'Model' }),
          el(
            'select',
            {
              title: t(TIPS.engineModel),
              'aria-label': 'Transcription model',
              'data-role': 'engine-model',
              'data-setting': 'engineModel',
              onChange: (e: Event) =>
                void this.pickEngineModel((e.target as HTMLSelectElement).value as EngineModel, s.engineModel)
            },
            ...ENGINE_MODELS.map(([value, label]) =>
              el('option', { value, text: label, selected: value === s.engineModel })
            )
          )
        ),
        this.engineModelError &&
          el(
            'div',
            { class: 'status-row', 'data-role': 'engine-model-error' },
            el('span', { class: 'dot warn' }),
            this.engineModelError
          ),
        engineReadout,

        // --- what happens to the audio before an engine hears it ------------
        // Two real transformations of the player's own recording, so they are the player's to
        // switch off. Both are applied PER ENGINE — each engine's manifest says whether it
        // wants them, and an engine that normalises internally is left alone — which is why
        // the labels say "engines that need it" rather than promising something to all of them.
        // Neither ever touches the recording you hear or see: the shell writes a separate file
        // for the engine and deletes it when the job ends.
        el(
          'label',
          {
            class: 'switch settings-row',
            title: t(
              'Brings the recording to a standard loudness before an engine listens to it, because that is the level these models were trained near. Applied before engines that need it; engines that do this for themselves are left alone. Your recording is not changed.'
            )
          },
          el('input', {
            type: 'checkbox',
            'data-role': 'preprocess-normalize',
            'data-setting': 'normalizeBeforeTranscribe',
            checked: s.normalizeBeforeTranscribe,
            // Not a rebuild: it changes how the NEXT transcription listens, and the sheet on
            // screen was written from audio that has already been through it or not.
            onChange: (e: Event) =>
              this.set('normalizeBeforeTranscribe', (e.target as HTMLInputElement).checked, false)
          }),
          el('span', { text: 'Even out the level before listening' })
        ),
        el('div', {
          class: 'status-row dim',
          'data-role': 'preprocess-normalize-note',
          text: 'Off unless you switch it on. Applied before engines that need it. Your own recording is never changed — only the copy the engine hears.'
        }),
        el(
          'label',
          {
            class: 'switch settings-row',
            title: t(
              'If the recording is not at concert pitch, nudges it to A440 before an engine listens, so a guitar tuned a quarter-tone flat does not come back a semitone wrong. Applied before engines that need it, and only when the app is confident about the amount.'
            )
          },
          el('input', {
            type: 'checkbox',
            'data-role': 'preprocess-tuning',
            'data-setting': 'correctTuningBeforeTranscribe',
            checked: s.correctTuningBeforeTranscribe,
            onChange: (e: Event) =>
              this.set('correctTuningBeforeTranscribe', (e.target as HTMLInputElement).checked, false)
          }),
          el('span', { text: 'Correct the tuning to A440 before listening' })
        ),
        el('div', {
          class: 'status-row dim',
          'data-role': 'preprocess-tuning-note',
          text: 'Off unless you switch it on. Applied before engines that need it, and only when the estimate is confident — a confident-looking correction from an unconfident guess is worse than none.'
        }),
        // What actually happened to the LAST take, as opposed to the two rows above, which
        // describe what may happen to the next one. "Corrected 14 cents flat to A440" is a
        // fact about somebody's own recording, and the only place they can be told it: the
        // shell does the work on a copy nobody ever sees, and every time in the result is
        // mapped back, so without this line a real change to their audio leaves no trace.
        // Held in the runtime store rather than here, because a transcription usually
        // finishes long before this panel is opened to ask about it.
        preprocessNote !== '' &&
          el('div', {
            class: 'status-row dim',
            'data-role': 'preprocess-result-note',
            text: preprocessNote
          }),

        ...(this.opts.runtime.get().score?.diagnostics ?? []).map((d) =>
          el('div', { class: 'status-row', text: d })
        )
      ),

      // --- engine setup -----------------------------------------------------
      // Its own group under the engine one, because it answers a different question: the
      // group above is "what is it doing", this is "is it here at all, and what do I type if
      // it is not". Nobody reads it until the day the answer is "not installed", and on that
      // day it is the only thing on the panel that matters.
      el(
        'div',
        { class: 'settings-group', 'data-role': 'engine-setup-group' },
        el('h3', { text: 'Engine setup', title: t(TIPS.engineSetup) }),
        engineSetup
      ),

      el('button', {
        class: 'chip',
        text: 'Reset to defaults',
        title: t(TIPS.reset),
        onClick: () => {
          // THIS PANEL'S settings, and only this panel's.
          //
          // The engine choice and the model choice are NOT in this file: they live in
          // `<appSupport>/engine.json`, which is machine-wide and shared by every Riffsheet
          // window in every DAW on this computer. A reset button sitting next to "Show note
          // names" must not reach that far — somebody tidying up their view settings would
          // have silently reconfigured their other host's setup, and an install they spent
          // ten minutes on would go back to Auto with no warning and no undo.
          //
          // So both are carried through the reset unchanged. What the panel shows for them
          // stays true, because `App.loadEngines()` adopts the shell's value on the way in
          // and the shell is the one that knows.
          this.opts.settings.set({
            ...DEFAULT_SETTINGS,
            engineModel: s.engineModel,
            engineId: s.engineId
          });
          this.opts.onRebuild();
        }
      })
    );

    this.renderEngineReadout();
    this.renderEngineSetup();
  }

  destroy(): void {
    this.stopEnginePoll();
    document.removeEventListener('pointerdown', this.onOutsidePointer);
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
