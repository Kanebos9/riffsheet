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

/** Smallest first — the order the RAM line on the card lists them in. */
const MODEL_ORDER = ['small', 'medium', 'large'] as const;

/**
 * What each MuScriptor size holds in memory, when the shell has not said.
 *
 * BRIDGE.md §3.4's own figures — "roughly 0.9 GB (small), 1.8 GB (medium) or 5 GB (large),
 * Python and the Metal buffers included" — which is the same table `auto` steps down through
 * when it drops a size that needs more than 40% of physical RAM. Written here so the card is
 * still honest against a shell that predates `EngineSummary.modelRamMb`, and superseded the
 * moment that field arrives, because the shell is the one that knows.
 */
const DEFAULT_MODEL_RAM_MB: Record<string, number> = { small: 900, medium: 1800, large: 5000 };

/**
 * The engine a single-engine shell is talking about, for `modelChooser`'s benefit only.
 *
 * A shell too old for `listEngines()` has exactly one engine and it is MuScriptor — that is
 * what "too old" means here, since the registry is what introduced the others. Enough of an
 * `EngineSummary` to name it and to get the RAM table; nothing else is read.
 */
const SINGLE_ENGINE_STAND_IN = { id: 'muscriptor', name: 'MuScriptor' } as EngineSummary;

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

/**
 * A model's memory cost, in the GB the rest of the product quotes it in.
 *
 * NOT `formatMb`, on purpose. That one switches to GB at 1024 MB and rounds to one decimal, so
 * the three MuScriptor sizes come out "900 MB · 1.8 GB · 4.9 GB" — three different units, one
 * of which disagrees with BRIDGE.md's own "roughly 0.9 GB (small), 1.8 GB (medium) or 5 GB
 * (large)". A row whose job is to be compared at a glance has to be in one unit, and the unit
 * has to be the one the documentation and the `auto` thresholds are written in.
 *
 * Decimal GB, and a trailing ".0" trimmed, so 5000 reads "5 GB" rather than "5.0 GB".
 */
function formatRamGb(mb: number): string {
  const gb = mb / 1000;
  return `${gb.toFixed(1).replace(/\.0$/, '')} GB`;
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

// FRET_COUNTS / fretOptions moved to ui/app.ts with the picker they feed.

export interface SettingsPanelOptions {
  settings: Store<AppSettings>;
  runtime: Store<RuntimeState>;
  /** Called when a change requires the notation to be rebuilt (not re-transcribed). */
  onRebuild: () => void;
  /** Called for changes that only affect the view or playback. */
  onViewChange: () => void;
  onClose: () => void;
  /**
   * Choose an engine, and do what choosing one MEANS.
   *
   * The panel used to call `selectEngine()` itself, which stored the choice and stopped — and
   * on a screen already showing a transcription that is a control with no visible effect. The
   * whole gesture (ask about unsaved edits, cancel whatever is running, store the choice, then
   * listen again with the new engine) belongs to the app, which is the only thing that knows
   * about takes and edits, so the panel delegates and renders whatever refusal comes back.
   *
   * Resolves to a sentence when the choice was refused, or null when it went through.
   */
  onChooseEngine?: (id: string) => Promise<string | null>;
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

  // --- "I already have this one" (see `existingInstallBody`) --------------------------------
  /** Cards whose "Use existing installation…" panel is open. */
  private existingOpen = new Set<string>();
  /** id -> what the shell said about the path it was last given, and whether it accepted it. */
  private existingSaid = new Map<string, { ok: boolean; detail: string }>();
  /** id -> what is in that card's path box, so a re-render does not eat what was typed. */
  private existingPath = new Map<string, string>();
  /** Cards with a check in flight. One at a time per card; the buttons say "Checking…". */
  private existingBusy = new Set<string>();

  /**
   * Is the guided engine's install guide unfolded?
   *
   * Collapsed by DEFAULT, and hidden altogether once the engine is found — see `guideBody`.
   * One flag for the panel rather than one per card, because there is exactly one guided
   * engine and there is no reading of "expand them all" that anybody wants.
   */
  private guideOpen = false;
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
      // The model chooser comes too. On this shell there is one engine and it is the guided
      // one, so "which engine do these weights belong to?" has an obvious answer — but the
      // control still has to EXIST, or a single-engine build would lose the only way to
      // choose a model when the row moved onto the cards.
      replace(
        host,
        this.guideStatusRow(this.engine),
        ...this.modelChooser(SINGLE_ENGINE_STAND_IN),
        ...this.guideBody(this.engine)
      );
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

    // THE DETAIL BLOCK. Three lines, each answering a different question somebody comparing
    // engines actually asks, in the order they ask them: what is it good at, what will it cost
    // me, and whose is it. It used to be one run-on line — "Good at: Bass · 57 MB to download ·
    // installs in one click" — which reads as a single fact and hides the two that matter most
    // on a laptop with 8 GB of RAM and a metered connection.
    rows.push(
      el('div', {
        class: 'status-row dim',
        'data-role': 'engine-card-strengths',
        text: this.capabilityLine(engine)
      }),
      el('div', {
        class: 'status-row dim',
        'data-role': 'engine-card-cost',
        text: this.costLine(engine)
      })
    );
    const provenance = this.sourceLine(engine);
    if (provenance.length > 0) {
      rows.push(el('div', { class: 'status-row dim', 'data-role': 'engine-card-source' }, ...provenance));
    }

    // The weights chooser belongs to the engine that HAS weights, not to the panel. See
    // `modelChooser` — this is the row that used to sit on its own several groups above,
    // where it applied to an engine it never named.
    rows.push(...this.modelChooser(engine));

    rows.push(this.engineButtons(engine, chosen, usable));

    if (engine.install === 'one-click') rows.push(...this.existingInstallBody(engine));
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

  /** Line 1 of the detail block: "Good at: Bass, Guitar and Piano". */
  private capabilityLine(engine: EngineSummary): string {
    return engine.instrumentStrengths.length > 0
      ? `Good at: ${humanList(engine.instrumentStrengths)}`
      : 'Good at: any single instrument';
  }

  /**
   * Line 2: what it costs — disk first, then memory, then how it gets here.
   *
   * Both numbers, not one. Disk is what somebody on a small SSD cares about and memory is
   * what decides whether the machine swaps while it runs; the old single line reported
   * whichever of the two happened to be interesting for that install kind and left the other
   * one out entirely.
   */
  private costLine(engine: EngineSummary): string {
    const parts: string[] = [];
    if (engine.approxDiskBytes > 0) {
      parts.push(
        engine.install === 'bundled'
          ? `${formatBytes(engine.approxDiskBytes)} on disk, already here`
          : engine.state === 'not-installed'
            ? `${formatBytes(engine.approxDiskBytes)} to download`
            : `${formatBytes(engine.approxDiskBytes)} on disk`
      );
    }
    if (engine.approxPeakRssMb > 0) parts.push(`about ${formatMb(engine.approxPeakRssMb)} of memory while it runs`);
    if (engine.install === 'bundled') parts.push('no setup needed');
    else if (engine.install === 'one-click') {
      parts.push(engine.state === 'not-installed' ? 'installs in one click' : 'installed by Riffsheet');
    } else {
      // Said on the card itself, not only in the policy line further down, because this is the
      // sentence that explains why the best engine here has no Install button.
      parts.push('guided setup — its licence does not let Riffsheet install it');
    }
    return parts.join(' · ');
  }

  /**
   * Line 3: whose work this is, and under what terms.
   *
   * A transcription engine is somebody else's research, and the two things a person is owed
   * before running it are where it came from and what its licence says. The licence is drawn
   * ONLY when the shell sent one — see `EngineSummary.license`. Guessing it from the URL was
   * the tempting shortcut and would have been a claim about somebody's legal terms made by
   * pattern-matching a hostname.
   */
  private sourceLine(engine: EngineSummary): HTMLElement[] {
    if (!engine.sourceUrl && !engine.license) return [];
    const host = engine.sourceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const bits: HTMLElement[] = [];
    if (host) {
      bits.push(
        el('span', { text: 'Source:' }),
        el('code', { class: 'path', 'data-role': 'engine-card-source-url', text: host })
      );
    }
    if (engine.license) {
      if (bits.length > 0) bits.push(el('span', { text: '·' }));
      bits.push(el('span', { 'data-role': 'engine-card-license', text: engine.license }));
    }
    return bits;
  }

  /**
   * The weights chooser, on the card of the engine whose weights they are.
   *
   * IT USED TO BE A STANDALONE SETTINGS ROW, several groups above this one, labelled "Model"
   * with three sizes in it. Nothing on that row said which engine it applied to, and once
   * Riffsheet drove four engines the answer — MuScriptor, and only MuScriptor — was
   * unguessable. Somebody running Basic Pitch could set "large" and watch nothing happen.
   *
   * The three RAM figures are the point of moving it. "small / medium / large" are three
   * adjectives; "0.9 GB · 1.8 GB · 5 GB" is the sentence that lets somebody with 8 GB decide,
   * and it is exactly what `auto` is deciding with on their behalf.
   */
  private modelChooser(engine: EngineSummary): HTMLElement[] {
    if (!this.bridge.setEngineModel) return [];

    // THE SHELL'S OWN TABLE FIRST. `engineStatus().models` carries a figure, `installed` and
    // `fits` for every size (BRIDGE.md §3.2), and `fits` is the `auto` rule's own answer —
    // reading it means the row agrees with what `auto` would actually do instead of
    // second-guessing it from `ramTotalMb`. The constants below are the documented fallback
    // for a shell that predates the table; only MuScriptor has sizes at all.
    const st = this.statusFor(engine);
    const table =
      st?.models && st.models.length > 0
        ? st.models.map((m) => ({ name: m.name, mb: m.approxResidentMb, installed: m.installed, fits: m.fits }))
        : engine.id === 'muscriptor'
          ? MODEL_ORDER.map((name) => ({
              name,
              mb: DEFAULT_MODEL_RAM_MB[name],
              installed: (st?.installedModels ?? []).includes(name),
              fits: true
            }))
          : [];
    if (table.length === 0) return [];

    const s = this.opts.settings.get();
    const rows: HTMLElement[] = [];

    rows.push(
      el('div', {
        class: 'status-row dim',
        'data-role': 'engine-card-model-ram',
        // "small 0.9 GB · medium 1.8 GB · large 5 GB", in the order they grow. A size this
        // machine cannot run is named as such rather than quietly listed beside ones it can:
        // "large 5 GB (too big for this Mac)" is the sentence that stops somebody choosing it
        // and wondering why nothing changed.
        text: table
          .map((m) => `${m.name} ${formatRamGb(m.mb)}${m.fits === false ? ' (too big for this machine)' : ''}`)
          .join(' · '),
        title: t(
          'What each size holds in memory once it is loaded, Python and the GPU buffers included. ' +
            'Auto picks the largest one that fits this machine and steps down when free memory is short.'
        )
      })
    );

    rows.push(
      el(
        'div',
        { class: 'settings-row' },
        el('span', { class: 'label', text: 'Model' }),
        el(
          'select',
          {
            title: t(TIPS.engineModel),
            'aria-label': `${engine.name} model size`,
            'data-role': 'engine-model',
            'data-setting': 'engineModel',
            onChange: (e: Event) =>
              void this.pickEngineModel((e.target as HTMLSelectElement).value as EngineModel, s.engineModel)
          },
          ...ENGINE_MODELS.map(([value, label]) =>
            el('option', { value, text: label, selected: value === s.engineModel })
          )
        )
      )
    );

    if (this.engineModelError) {
      rows.push(
        el(
          'div',
          { class: 'status-row', 'data-role': 'engine-model-error' },
          el('span', { class: 'dot warn' }),
          this.engineModelError
        )
      );
    }

    return rows;
  }

  /**
   * "Use existing installation…" — the other way an engine gets onto this machine.
   *
   * A one-click card's Install button is 57 to 400 MB of download. For somebody who already
   * has the same package in a venv from last year that is pointless traffic and a second copy
   * on disk, and the app had nothing to say to them: the only door was Install.
   *
   * Two affordances, in the order somebody tries them:
   *
   *  1. LOOK FOR IT — one press, `validateExistingEngineInstall(id, '')`, and the shell
   *     reports what it found in the places that engine normally lives.
   *  2. POINT AT IT — a path box, checked with the same call. Deliberately a path box rather
   *     than a native folder chooser: this is the same gesture the guided card already uses
   *     for `engine.json`, and it is the one that works when the folder is somewhere a
   *     sandboxed file dialog will not go.
   *
   * Both routes go through ONE native call, which is the whole design: the shell has to do the
   * same validation either way, and a second entry point would be a second thing to keep in
   * step with it. See `NativeBridge.validateExistingEngineInstall`.
   */
  private existingInstallBody(engine: EngineSummary): HTMLElement[] {
    // Gated on the capability, so a shell that cannot answer never shows a door onto nothing.
    if (!this.bridge.validateExistingEngineInstall) return [];
    // Nothing to point at once Riffsheet has its own copy — Uninstall is the button for that.
    if (engine.state === 'ready' || engine.state === 'installed') return [];

    const open = this.existingOpen.has(engine.id);
    const rows: HTMLElement[] = [
      el('button', {
        class: 'chip',
        'data-role': 'engine-use-existing',
        'aria-expanded': String(open),
        text: `${open ? '▾' : '▸'} Use existing installation…`,
        title: t(
          'Already have this engine on this machine? Point Riffsheet at it instead of downloading it again.'
        ),
        onClick: () => {
          if (open) this.existingOpen.delete(engine.id);
          else this.existingOpen.add(engine.id);
          this.renderEngineSetup();
        }
      })
    ];
    if (!open) return rows;

    const busy = this.existingBusy.has(engine.id);
    const said = this.existingSaid.get(engine.id);

    rows.push(
      el(
        'div',
        { class: 'row', 'data-role': 'engine-existing' },
        el('button', {
          class: 'chip',
          'data-role': 'engine-existing-sniff',
          disabled: busy,
          text: busy ? 'Looking…' : 'Look for it',
          onClick: () => void this.checkExistingInstall(engine, '')
        })
      ),
      el(
        'div',
        { class: 'settings-row' },
        el('input', {
          class: 'custom-tuning',
          type: 'text',
          spellcheck: 'false',
          'data-role': 'engine-existing-path',
          'aria-label': `Where ${engine.name} is installed`,
          placeholder: '/path/to/the/engine',
          value: this.existingPath.get(engine.id) ?? '',
          // Kept on every keystroke: this panel re-renders on a two-second poll, and a box
          // that lost what was half-typed would be unusable by construction.
          onInput: (e: Event) => this.existingPath.set(engine.id, (e.target as HTMLInputElement).value)
        }),
        el('button', {
          class: 'chip',
          'data-role': 'engine-existing-check',
          disabled: busy,
          text: busy ? 'Checking…' : 'Use this folder',
          onClick: () => void this.checkExistingInstall(engine, this.existingPath.get(engine.id) ?? '')
        })
      )
    );

    if (said) {
      rows.push(
        el(
          'div',
          { class: 'status-row', 'data-role': 'engine-existing-said' },
          el('span', { class: `dot ${said.ok ? 'ok' : 'warn'}` }),
          said.detail
        )
      );
    }

    return rows;
  }

  /**
   * Ask the shell about a location. Empty path means "look for it yourself".
   *
   * A found sniff fills the box rather than silently adopting the result: the player gets to
   * see WHERE before anything is used, which is the difference between an answer and a
   * surprise. The check that follows is the one that commits.
   */
  private async checkExistingInstall(engine: EngineSummary, path: string): Promise<void> {
    if (!this.bridge.validateExistingEngineInstall || this.existingBusy.has(engine.id)) return;
    this.existingBusy.add(engine.id);
    this.existingSaid.delete(engine.id);
    this.renderEngineSetup();

    try {
      const result = await this.bridge.validateExistingEngineInstall(engine.id, path);
      this.existingSaid.set(engine.id, {
        ok: result.ok === true,
        detail: result.detail || (result.ok ? 'That copy works.' : 'That did not work.')
      });
      if (result.path) this.existingPath.set(engine.id, result.path);
    } catch (err) {
      this.existingSaid.set(engine.id, {
        ok: false,
        detail: err instanceof Error ? err.message : 'Riffsheet could not check that location.'
      });
    } finally {
      this.existingBusy.delete(engine.id);
      this.renderEngineSetup();
      // The card's state may have changed on disk; ask rather than assume, exactly as an
      // install does.
      void this.askEngine();
    }
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

    // --- when it is already here, the guide is noise -----------------------
    //
    // GONE, not collapsed. Instructions for installing something that is installed are the
    // clearest possible signal that the app has not noticed — the card says "found at
    // ~/muscriptor/venv" and then, underneath, tells you to go and make a virtualenv. The two
    // buttons stay, because "look again" and "open the folder" are still things somebody with
    // a working engine wants (they are how you check after moving it, or after uninstalling it
    // by hand). Everything between them and the status line is setup, and setup is over.
    if (found) {
      rows.push(...this.guideButtons(found));
      return rows;
    }

    // --- and when it is NOT, it is folded away until asked for -------------
    //
    // Five numbered steps, a nine-entry path list and a JSON snippet is a wall, and it was the
    // first thing under the best engine's name. Most people opening this panel are here to
    // pick an engine, not to install one by hand; the ones who ARE here for that press one
    // button. Collapsed by default, and the button says what is behind it.
    if (!this.guideOpen) {
      rows.push(
        el('button', {
          class: 'chip',
          'data-role': 'engine-guide-toggle',
          'aria-expanded': 'false',
          text: '▸ Show setup steps',
          title: t('The five things to run in Terminal, and every place Riffsheet already looked.'),
          onClick: () => {
            this.guideOpen = true;
            this.renderEngineSetup();
          }
        })
      );
      rows.push(...this.guideButtons(found));
      return rows;
    }

    rows.push(
      el('button', {
        class: 'chip',
        'data-role': 'engine-guide-toggle',
        'aria-expanded': 'true',
        text: '▾ Hide setup steps',
        onClick: () => {
          this.guideOpen = false;
          this.renderEngineSetup();
        }
      })
    );

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

    rows.push(...this.guideButtons(found));
    return rows;
  }

  /**
   * Check again / Open the setup folder, and whatever the last check said.
   *
   * Its own method because it is drawn in all three of the guided card's states — engine
   * found, guide folded, guide open — and it is the half that stays useful once setup is
   * over. "Look again, now" is the answer to "I just moved it" as much as to "I just
   * installed it".
   */
  private guideButtons(found: boolean): HTMLElement[] {
    const rows: HTMLElement[] = [];
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
      // Through the app when it is listening, because pressing a card means "transcribe with
      // this one" and only the app can cancel a running job, ask about unsaved edits and start
      // the new one. `selectEngine` on its own is the fallback for a panel mounted without
      // that callback, and it is exactly what this used to do.
      if (this.opts.onChooseEngine) {
        refusal = await this.opts.onChooseEngine(id);
      } else {
        const result = await this.bridge.selectEngine?.(id);
        if (result && !result.ok) refusal = result.error ?? 'The engine could not be changed.';
      }
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

  // `soundSection` — the panel copy of the sound picker — stood here. It is gone with the
  // Playback group: the transport's own `soundPicker()` is beside the Original↔MIDI fader,
  // which is where somebody comparing two sounds is already looking, and it carries the same
  // "loading…" / "not in this build" status the panel row did.

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
        // THE DIET. Grid, Clef, Fingering, the piano-roll switch, the roll's grid and the
        // playback sound all used to be duplicated here, and duplicating a control is not
        // generosity — it is two places to look and two places for the answer to be stale.
        // Each of them now has exactly one home, next to the thing it changes: Grid, Clef and
        // the Tab menu (which carries Fingering) live on the notation toolbar under the sheet;
        // the piano-roll switch and the roll's grid live on the roll's own chip row; the sound
        // picker lives on the transport beside the fader. What is left in this panel is what
        // has nowhere else to be.
        //
        // `fillGaps` and `metronome` are not moved, they are DELETED. The pipeline stage
        // `fillGaps` drove no longer reads it, and the metronome click is gone from
        // audio/synth.ts — a switch that changes nothing is worse than no switch at all.
        //
        // How far up the neck a hand edit may go. It sits at the top because it is the
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
        // "Highest fret" stood here. It is on the notation toolbar now, beside the Tab menu
        // whose fret numbers it limits — see ui/app.ts §buildNotationToolbar.
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
        // "FOLLOW A DRIFTING TEMPO" STOOD HERE, and it is gone rather than moved. It bought a
        // whole second listening pass — minutes on a long take — for a beat grid that followed
        // the drift so closely the bar lines stopped meaning anything. `AppSettings.preciseBeats`
        // survives as a field so an old blob still reads, forced false in `migrate()` v9.
        //
        // The auto-split switch, moved up out of the "Piano roll" group with the rest of that
        // group deleted. It reads as a transcription setting rather than a view one anyway:
        // what it changes is which notes end up on the page, and the highlights it leaves are
        // only how it shows its working. The dim line under it is the half people miss — that
        // switching it off stops it TOUCHING notes.
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

      // --- THE "PIANO ROLL" GROUP IS GONE, and this is the whole of what happened to it.
      //
      // It held four boxes. Three of them were questions nobody wants to be asked — may the
      // roll name its own rows, may the roll be edited, and where the roll's grid and its
      // show/hide chip are — and the player said so directly. Naming every row and editing on
      // the roll are simply what the roll DOES now: the settings survive as fields for the
      // sake of old blobs, `migrate()` v9 forces both true, and `ui/app.ts` §renderMain hands
      // the roll the literals. The signpost row went with them, because the two controls it
      // pointed at are on screen beside the roll and a panel that explains where its own
      // controls went is a panel with too many rows.
      //
      // The fourth, the auto-split switch, moved up into Notation above rather than being
      // deleted: it decides which notes reach the page, which is a transcription question.

      // The whole Playback group is gone with its two rows: the sound picker is on the
      // transport beside the fader, which is where somebody choosing a playback sound is
      // already looking, and the metronome no longer exists to be switched.

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
        // THE MODEL ROW IS NOT HERE ANY MORE. It moved onto the card of the engine whose
        // weights it selects — see `modelChooser()` in the Engine setup group below. Sitting
        // here it named no engine, applied to exactly one of the four, and did nothing at all
        // for anybody running the other three.
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
            // WRITTEN FOR SOMEBODY HOLDING A GUITAR, not for somebody who knows what
            // "normalisation" is. The old label said "Even out the level before listening",
            // which describes the operation rather than the problem it solves — a player who
            // does not already know what it does cannot tell whether they want it. The rule
            // for both of these rows: name the SITUATION first, then what the app will do
            // about it. Everything true about the old text is still said, further down.
            title: t(
              'Quiet recordings are the ones engines mishear most — they were trained on audio at a standard loudness. Riffsheet turns up a copy for the engine to listen to. Applied before engines that need it; engines that do this for themselves are left alone. What you hear and what you see is never touched.'
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
          el('span', { text: 'If your recording is quiet, boost it so the engine hears it better' })
        ),
        el('div', {
          class: 'status-row dim',
          'data-role': 'preprocess-normalize-note',
          text: 'Off unless you switch it on. Your own recording is never changed — only the copy the engine hears.'
        }),
        el(
          'label',
          {
            class: 'switch settings-row',
            title: t(
              'A guitar tuned a little flat comes back with the wrong note names — the engine hears what was played, not what was meant. Riffsheet nudges a copy back to standard pitch first. Only done when it is confident about the amount, because a confident-looking correction from a guess is worse than none.'
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
          el('span', { text: 'If your instrument was tuned slightly off, fix it so notes land on the right pitches' })
        ),
        el('div', {
          class: 'status-row dim',
          'data-role': 'preprocess-tuning-note',
          text: 'Off unless you switch it on. Only done when Riffsheet is sure how far off you were.'
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
