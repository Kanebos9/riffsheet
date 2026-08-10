/**
 * The export bar: MIDI, MusicXML, PDF.
 *
 * Four things were wrong with the old inline version, and all four were reported from the
 * field rather than guessed at:
 *
 *  1. **MIDI opened two save dialogs.** It always wrote both variants, so the player got a
 *     save panel, saved, and then got another save panel with no explanation. Now the button
 *     opens a small menu — Quantized / As played / Both — the choice is remembered, and
 *     "Both" is one dialog (`bridge.exportFiles`) wherever the host can do it.
 *  2. **Cancelling still said "Exported".** Dismissing the native panel produced a cheerful
 *     confirmation toast for a file that was never written. Every path here reads the
 *     bridge's `ExportOutcome` and stays silent on a cancel.
 *  3. **PDF was dead in the plugin.** It called `window.print()`, and a WKWebView has no
 *     print dialog to give. Now the page renders real PDF bytes and hands them to the same
 *     save dialog as everything else; the print route survives as a browser-only fallback.
 *  4. **The MIDI button could not be dragged onto a track.** "i wanted midi button to be
 *     draggable, like when i click on drag, it should be able to drag the midi item onto a
 *     track." `beginMidiDrag` existed all the way down to the C++ and was registered with the
 *     WebView, but nothing in the page ever called it — so the only route into a DAW was
 *     save-the-file-then-go-and-find-it. It drags now.
 *
 * ## Why the drag hangs off `pointermove` and not off `dragstart`
 *
 * An HTML5 drag can hand bytes to another *web page*; it cannot hand a *file* to another
 * application, and a DAW track will only take a file. So the page supplies the bytes and the
 * shell stages them and starts a genuine operating-system drag carrying the path.
 *
 * The timing is the whole trick. macOS will only open a dragging session from inside a live
 * mouse drag — the native side reaches for the window's current event, and if that is not a
 * mouse event there is nothing to attach the session to. A `dragstart` handler runs after that
 * moment has passed and the OS simply refuses; a `click` handler is far too late. So the
 * gesture is hand-rolled: arm on `pointerdown`, and the first `pointermove` past a few pixels
 * calls the bridge **synchronously, with the mouse button still down** (shell/BRIDGE.md §4b).
 *
 * The MIDI bytes are made at `pointerdown` for the same reason — nothing slow may sit between
 * the mouse moving and the call. It costs a millisecond or two on a press that turns out to be
 * an ordinary click, which is a fair price for a drag that starts every time.
 *
 * A drag is not a click, so the click that the press would otherwise produce is swallowed;
 * without that the export menu would pop open in the middle of dragging a file onto a track.
 * Everything else about the button is unchanged — press and release without moving and you get
 * the same three-item menu you always got.
 *
 * Where there is no `beginMidiDrag` — a plain browser, the mock bridge, an older shell — the
 * gesture is not armed at all and the tooltip never mentions dragging. Promising a drag that
 * cannot happen is worse than not offering one.
 */

import { el, type Store } from './dom';
import { t, TIPS } from './tips';
import type { AppSettings, MidiExportMode } from '../app/state';
import type { ExportOutcome, ExportPayload, NativeBridge } from '../bridge';
import { renderScorePdf, printScore } from '../export/pdf';
import type { RiffScore } from '@pipeline';

export interface ExportBarOptions {
  bridge: NativeBridge;
  settings: Store<AppSettings>;
  getScore: () => RiffScore | null;
  /** Exact source playback for imported MIDI/MusicXML/Guitar Pro, when one exists. */
  getSourceMidi?: () => Uint8Array | null;
  /** File name with no extension, e.g. "riff-take-3". */
  getBaseName: () => string;
  isPlugin: () => boolean;
  toast: (kind: 'info' | 'danger', title: string, message: string) => void;
}

interface MidiChoice {
  value: MidiExportMode;
  label: string;
  hint: string;
}

export const MIDI_CHOICES: readonly MidiChoice[] = [
  { value: 'quantized', label: 'Quantized', hint: 'The tidied-up sheet' },
  { value: 'as-played', label: 'As played', hint: 'Exactly your timing' },
  { value: 'both', label: 'Both', hint: 'One dialog, two files' }
];

/**
 * What the drag would carry, without carrying it.
 *
 * A real operating-system drag cannot be synthesised from a headless browser — that is the
 * entire point of it being an OS drag — so the harness cannot press, move and check. This is
 * the next best thing: everything the gesture would use, read from the same code the gesture
 * reads it from. The integrator exposes it as `window.__RIFFSHEET_DRAGPROBE__`.
 */
export interface DragProbe {
  /** True when a press on the MIDI button right now would arm a drag. */
  armed: boolean;
  /** Whether the host offers an OS drag at all. False in a browser and under the mock. */
  hasBridge: boolean;
  /** The remembered choice the drag would honour. */
  mode: MidiExportMode;
  /** Size of the file that would be dropped. 0 when there is no sheet yet. */
  bytes: number;
  /** The name the DAW would see. Null when there is nothing to drag. */
  name: string | null;
}

/** What the drag would hand over, worked out once and used by the gesture and the probe. */
interface DragPlan {
  name: string;
  bytes: Uint8Array;
}

/**
 * How far the pointer must travel before a press counts as a drag.
 *
 * Small enough that the drag feels immediate, large enough that the hand-shake in an ordinary
 * click never trips it.
 */
const DRAG_THRESHOLD_PX = 5;

/**
 * How long a fired drag keeps swallowing clicks.
 *
 * A stamp rather than a flag, because after a real drag the click may never arrive at all —
 * the OS took the gesture. A flag would then sit there and eat the *next* honest click. This
 * heals itself.
 */
const CLICK_SUPPRESS_MS = 700;

export class ExportBar {
  private opts: ExportBarOptions;
  private menu: MenuPopover;
  private midiButton: HTMLButtonElement | null = null;
  private pdfButton: HTMLButtonElement | null = null;
  /** Tears down an armed press. Null when no press is in flight. */
  private endGesture: (() => void) | null = null;
  /** `performance.now()` before which a click on the MIDI button is a drag's leftovers. */
  private suppressClickUntil = 0;

  constructor(opts: ExportBarOptions) {
    this.opts = opts;
    this.menu = new MenuPopover();
  }

  /** The header's export controls, in order. */
  buttons(): HTMLElement[] {
    // The header is rebuilt wholesale on every render, so an open menu would be left
    // pointing at a button that is no longer in the document.
    this.menu.close();
    // Same reasoning for a half-finished press: its button is about to be thrown away.
    this.disarmDrag();

    const canDrag = this.canDrag();

    this.midiButton = el(
      'button',
      {
        text: 'MIDI',
        'data-role': 'export-midi',
        // The button IS the control for `midiExportMode`: the menu it opens is where the
        // remembered choice is made. Named so the settings sweep can find it.
        'data-setting': 'midiExportMode',
        // A truthful marker of what this button can do, for CSS and for the harness.
        'data-drag': canDrag ? 'midi' : undefined,
        // Without this WebKit's own drag machinery starts first and swallows the gesture.
        draggable: 'false',
        'aria-haspopup': 'menu',
        title: t(this.midiTip()),
        // The affordance has to live here: styles.css belongs to the integrator, and a
        // button nobody knows is draggable is a button nobody drags.
        style: canDrag ? { cursor: 'grab' } : undefined,
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          // The press that just ended turned into a drag. Opening the menu on top of it
          // would be the app doing two things for one gesture.
          if (performance.now() < this.suppressClickUntil) {
            this.suppressClickUntil = 0;
            return;
          }
          this.toggleMidiMenu();
        },
        // Deliberately does NOT preventDefault: a press that never moves must still click,
        // and clicking is still what opens the menu.
        onPointerDown: (e: PointerEvent) => this.armMidiDrag(e)
      },
      // Something to take hold of. Only drawn where a drag can actually happen.
      canDrag
        ? el('span', {
            class: 'drag-grip',
            'aria-hidden': 'true',
            text: '⠿',
            style: { marginLeft: '6px', opacity: '0.55', cursor: 'grab' }
          })
        : null
    );

    this.pdfButton = el('button', {
      text: 'PDF',
      'data-role': 'export-pdf',
      title: t(TIPS.exportPdf),
      onClick: () => void this.exportPdf()
    });

    return [
      this.midiButton,
      el('button', {
        text: 'MusicXML',
        'data-role': 'export-musicxml',
        title: t(TIPS.exportMusicXml),
        onClick: () => void this.exportMusicXml()
      }),
      this.pdfButton
    ];
  }

  destroy(): void {
    this.disarmDrag();
    this.menu.destroy();
  }

  // -------------------------------------------------------------------------
  // Dragging the MIDI onto a track  (shell/BRIDGE.md §4b — read the header first)
  // -------------------------------------------------------------------------

  /**
   * Does this host offer a real OS drag?
   *
   * Optional in the bridge contract and genuinely absent in a browser and under the mock, so
   * this is a capability test, not a guard against a bug. Where it is false nothing is armed
   * and nothing is promised.
   */
  private canDrag(): boolean {
    return typeof this.opts.bridge.beginMidiDrag === 'function';
  }

  /**
   * Arm the gesture. Called on every press of the MIDI button, and mostly comes to nothing —
   * a press that never travels 5px is an ordinary click and the menu opens as before.
   */
  private armMidiDrag(down: PointerEvent): void {
    if (!this.canDrag()) return;
    // Left button only, and only the first finger of a multi-touch: a right-click is a
    // context menu and a second finger is a scroll.
    if (down.button !== 0 || !down.isPrimary) return;

    const score = this.opts.getScore();
    if (!score) return;

    // Made now, while there is time. Once the pointer moves, the call to the shell has to be
    // the very next thing that happens — see the header.
    let plan: DragPlan;
    try {
      plan = this.dragPlan(score);
    } catch {
      // A sheet that cannot be written to MIDI is the save button's problem to report, with
      // its proper message. Silently leave the drag unarmed.
      return;
    }

    this.disarmDrag();
    const button = this.midiButton;
    if (button) button.style.cursor = 'grabbing';

    const move = (e: PointerEvent): void => {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_THRESHOLD_PX) return;
      // Unhook first: once the operating system owns the gesture we stop hearing about it,
      // and a stale listener would arm a second drag on the next press.
      this.disarmDrag();
      this.suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
      // Dragging a file out with a menu hanging open under the button looks broken.
      this.menu.close();
      this.startMidiDrag(plan);
    };
    const end = (): void => this.disarmDrag();

    this.endGesture = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      this.endGesture = null;
      if (button) button.style.cursor = 'grab';
    };
    // On window, not on the button: by the time the pointer has moved far enough to count as
    // a drag it has usually left the button, and a listener on the button would never hear it.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  private disarmDrag(): void {
    this.endGesture?.();
  }

  /**
   * The actual hand-off. Everything up to here has been about arriving at this line while the
   * mouse button is still down.
   */
  private startMidiDrag(plan: DragPlan): void {
    const bridge = this.opts.bridge;
    if (!bridge.beginMidiDrag) return;

    const failed = (why: string) =>
      this.opts.toast(
        'danger',
        'MIDI drag',
        `${why} Nothing was dropped. The MIDI button still works as a save button — click it, ` +
          'pick a version, and drop the saved file into your track.'
      );

    // Nothing is said when it works: the file landing on the track is the feedback, and a
    // toast on top of a successful drag is just noise.
    void Promise.resolve(bridge.beginMidiDrag(plan.name, plan.bytes)).then(
      (result) => {
        if (result?.started) return;
        failed(result?.error ? `The drag could not be started — ${result.error}.` : 'The drag could not be started.');
      },
      (e: Error) => failed(`The drag could not be started — ${e.message}.`)
    );
  }

  /**
   * What a drag would carry, for the mode the player last chose.
   *
   * "Both" is the awkward one: one drag stages one file, because that is all the bridge
   * offers. Rather than picking silently we drag the as-played take — the one the user asked
   * to be the default, and the one nothing else can reproduce — and the tooltip says so. The
   * menu is still there when they want the pair on disk.
   */
  private dragPlan(score: RiffScore): DragPlan {
    const quantized = this.opts.settings.get().midiExportMode === 'quantized';
    const base = this.opts.getBaseName();
    return {
      name: quantized ? `${base}.mid` : `${base}-as-played.mid`,
      bytes: this.midiBytes(score, quantized)
    };
  }

  /**
   * What WOULD be dragged, without dragging.
   *
   * The harness cannot synthesise an operating-system drag, so it checks the ingredients
   * instead: that the gesture is wired, that the host offers one, and that the bytes and the
   * name match the remembered choice.
   */
  dragProbe(): DragProbe {
    const hasBridge = this.canDrag();
    const score = this.opts.getScore();
    let plan: DragPlan | null = null;
    try {
      plan = score ? this.dragPlan(score) : null;
    } catch {
      plan = null;
    }
    return {
      armed: hasBridge && !!plan && !!this.midiButton?.isConnected,
      hasBridge,
      mode: this.opts.settings.get().midiExportMode,
      bytes: plan ? plan.bytes.length : 0,
      name: plan ? plan.name : null
    };
  }

  // -------------------------------------------------------------------------
  // MIDI
  // -------------------------------------------------------------------------

  /** The button's tooltip. Mentions the drag only where a drag genuinely exists. */
  private midiTip(): string {
    if (!this.canDrag()) return TIPS.exportMidi;
    return `Click to export · Drag onto a DAW track to drop the MIDI. ${this.dragSentence()}`;
  }

  private dragSentence(): string {
    switch (this.opts.settings.get().midiExportMode) {
      case 'quantized':
        return 'Right now dragging gives you the tidied-up version.';
      case 'both':
        return (
          'Right now dragging gives you the as-played file — one drag can only carry one file. ' +
          'Click and pick Both when you want to save the pair.'
        );
      default:
        return 'Right now dragging gives you exactly how you played it.';
    }
  }

  /**
   * Keep the tooltip honest after the choice changes.
   *
   * tips.ts moves `title` into `data-riff-tip` the first time a control is hovered, so
   * setting `title` alone would leave the old sentence showing on a button the player has
   * already pointed at. Whichever of the two is in force is the one that gets updated.
   */
  private refreshMidiTip(): void {
    const button = this.midiButton;
    if (!button) return;
    const text = t(this.midiTip());
    if (!text) return;
    if (button.hasAttribute('data-riff-tip')) button.setAttribute('data-riff-tip', text);
    else button.setAttribute('title', text);
  }

  private toggleMidiMenu(): void {
    if (this.menu.isOpen) {
      this.menu.close();
      return;
    }
    if (!this.midiButton) return;
    const current = this.opts.settings.get().midiExportMode;

    this.menu.open(
      this.midiButton,
      MIDI_CHOICES.map((choice) => ({
        label: choice.label,
        hint: choice.hint,
        checked: choice.value === current,
        onPick: () => {
          // Remembered before the dialog opens, so the choice sticks even if the save is
          // then cancelled — the user still told us what they want next time.
          this.opts.settings.set({ midiExportMode: choice.value });
          // The drag follows the same choice, so the tooltip has to say the new thing even
          // if nothing re-renders the header.
          this.refreshMidiTip();
          void this.exportMidi(choice.value);
        }
      }))
    );
  }

  private async exportMidi(mode: MidiExportMode): Promise<void> {
    const score = this.opts.getScore();
    if (!score) return this.opts.toast('danger', 'Export', 'There is no sheet to export yet.');
    const base = this.opts.getBaseName();

    try {
      if (mode === 'both') {
        const outcome = await this.saveMany([
          { name: `${base}.mid`, bytes: score.midi(true), mimeType: 'audio/midi' },
          { name: `${base}-as-played.mid`, bytes: this.midiBytes(score, false), mimeType: 'audio/midi' }
        ]);
        // On a host without `exportFiles` this is two dialogs, and the second one can be
        // cancelled on its own — so the message reports what actually landed.
        this.report(
          outcome,
          (outcome.count ?? 0) >= 2
            ? 'Two MIDI files saved — the tidied-up sheet, and exactly as you played it.'
            : 'The tidied-up MIDI was saved. The as-played one was not.'
        );
        return;
      }

      const quantized = mode === 'quantized';
      const name = quantized ? `${base}.mid` : `${base}-as-played.mid`;
      const outcome = await this.opts.bridge.exportFile(name, this.midiBytes(score, quantized), 'audio/midi');
      this.report(
        outcome,
        quantized ? 'MIDI saved — the tidied-up sheet.' : 'MIDI saved — exactly as you played it.'
      );
    } catch (e) {
      this.opts.toast('danger', 'MIDI', (e as Error).message);
    }
  }

  /** Imported score files already have an exact multi-track playback; do not flatten it. */
  private midiBytes(score: RiffScore, quantized: boolean): Uint8Array {
    return quantized ? score.midi(true) : (this.opts.getSourceMidi?.() ?? score.midi(false));
  }

  /**
   * Write several files, preferring one dialog.
   *
   * `exportFiles` is optional in the bridge contract, so this degrades to the old
   * one-dialog-per-file behaviour rather than failing. In that mode a cancel on the first
   * file abandons the rest: nobody who just dismissed a save panel wants another one.
   */
  private async saveMany(files: ExportPayload[]): Promise<ExportOutcome> {
    const { bridge } = this.opts;
    if (bridge.exportFiles) return bridge.exportFiles(files);

    let saved = 0;
    let firstPath: string | undefined;
    for (const file of files) {
      const outcome = await bridge.exportFile(file.name, file.bytes, file.mimeType);
      if (!outcome.saved) break;
      firstPath ??= outcome.path;
      saved++;
    }
    return { saved: saved > 0, path: firstPath, count: saved };
  }

  // -------------------------------------------------------------------------
  // MusicXML
  // -------------------------------------------------------------------------

  private async exportMusicXml(): Promise<void> {
    const score = this.opts.getScore();
    if (!score) return this.opts.toast('danger', 'Export', 'There is no sheet to export yet.');
    try {
      const bytes = new TextEncoder().encode(score.musicxml());
      const outcome = await this.opts.bridge.exportFile(
        `${this.opts.getBaseName()}.musicxml`,
        bytes,
        'application/vnd.recordare.musicxml+xml'
      );
      this.report(outcome, 'MusicXML saved — opens in MuseScore, Guitar Pro and the rest.');
    } catch (e) {
      this.opts.toast('danger', 'MusicXML', (e as Error).message);
    }
  }

  // -------------------------------------------------------------------------
  // PDF
  // -------------------------------------------------------------------------

  private async exportPdf(): Promise<void> {
    const score = this.opts.getScore();
    if (!score) return this.opts.toast('danger', 'Export', 'There is no sheet to export yet.');
    if (this.pdfButton?.disabled) return;

    // Engraving a second, hidden score takes a moment; say so on the button rather than
    // leaving a dead-looking click.
    this.setPdfBusy(true);
    try {
      const title = this.opts.getBaseName();
      const bytes = await renderScorePdf(score, { title });
      const outcome = await this.opts.bridge.exportFile(`${title}.pdf`, bytes, 'application/pdf');
      this.report(outcome, 'PDF saved — sheet and tab, ready to print.');
    } catch (e) {
      // The browser can still fall back to its own print dialog. A plugin cannot: WKWebView
      // has no print UI, which is the whole reason the byte path exists.
      if (!this.opts.isPlugin()) {
        try {
          await printScore(score, { title: this.opts.getBaseName() });
          return;
        } catch {
          /* fall through to the error below */
        }
      }
      this.opts.toast('danger', 'PDF', (e as Error).message);
    } finally {
      this.setPdfBusy(false);
    }
  }

  private setPdfBusy(busy: boolean): void {
    if (!this.pdfButton) return;
    this.pdfButton.disabled = busy;
    this.pdfButton.textContent = busy ? 'PDF…' : 'PDF';
  }

  // -------------------------------------------------------------------------

  /** One rule for every export: say something when it saved, nothing when it did not. */
  private report(outcome: ExportOutcome, message: string): void {
    if (!outcome.saved) return;
    const where = shortPath(outcome.path);
    this.opts.toast('info', 'Saved', where ? `${message}  ·  ${where}` : message);
  }
}

/**
 * The tail of a path: enough to answer "where did it go?" in a 340px toast.
 *
 * A full save path is longer than the toast and would wrap to three lines, so the folder
 * plus the file name is the useful part — the user chose the rest.
 */
function shortPath(path: string | undefined): string | null {
  if (!path) return null;
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}

// ---------------------------------------------------------------------------
// The little menu
// ---------------------------------------------------------------------------

export interface MenuItem {
  label: string;
  hint?: string;
  checked?: boolean;
  onPick: () => void;
}

/**
 * A one-level menu anchored under a button.
 *
 * Deliberately not reusing NotePopover: that one is a form with steppers anchored to a
 * notehead rect, this is a list anchored to an element, and merging them would leave both
 * worse. Both share the `.popover` look through CSS instead.
 */
export class MenuPopover {
  private root: HTMLElement;
  private anchor: HTMLElement | null = null;
  private onKeyDown: (e: KeyboardEvent) => void;
  private onPointerDown: (e: PointerEvent) => void;

  constructor() {
    this.root = el('div', { class: 'menu-popover', role: 'menu', 'data-role': 'export-menu' });
    this.root.style.display = 'none';
    document.body.appendChild(this.root);

    this.onKeyDown = (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        const anchor = this.anchor;
        this.close();
        // Focus goes back where it came from, or a keyboard user is stranded on <body>.
        anchor?.focus();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.step(e.key === 'ArrowDown' ? 1 : -1);
      }
    };
    this.onPointerDown = (e) => {
      if (!this.isOpen) return;
      const target = e.target as Node;
      // The anchor is exempt: closing here and then letting its own click handler run
      // would close and instantly re-open, so the button would appear to do nothing.
      if (this.root.contains(target) || this.anchor?.contains(target)) return;
      this.close();
    };
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('pointerdown', this.onPointerDown, true);
  }

  private step(delta: number): void {
    const items = [...this.root.querySelectorAll<HTMLElement>('.menu-item')];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length;
    items[next].focus();
  }

  get isOpen(): boolean {
    return this.root.style.display !== 'none';
  }

  open(anchor: HTMLElement, items: MenuItem[]): void {
    this.anchor = anchor;
    this.root.replaceChildren(
      ...items.map((item) =>
        el(
          'button',
          {
            class: `menu-item${item.checked ? ' on' : ''}`,
            role: 'menuitemradio',
            'aria-checked': String(!!item.checked),
            onClick: () => {
              this.close();
              item.onPick();
            }
          },
          // A fixed-width tick column, so the labels do not shift when the choice moves.
          el('span', { class: 'tick', text: item.checked ? '✓' : '' }),
          el('span', { class: 'menu-label', text: item.label }),
          item.hint ? el('span', { class: 'menu-hint', text: item.hint }) : null
        )
      )
    );

    this.root.style.display = 'flex';
    this.root.style.visibility = 'hidden';
    // Measure before placing, or the flip-up test uses a stale height.
    const rect = this.root.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    let left = Math.min(anchorRect.left, window.innerWidth - rect.width - 8);
    let top = anchorRect.bottom + 6;
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, anchorRect.top - rect.height - 6);
    }
    left = Math.max(8, left);
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
    this.root.style.visibility = 'visible';

    // Land on the remembered choice, not on the top of the list: Enter should repeat what
    // you did last time.
    (
      this.root.querySelector<HTMLElement>('.menu-item.on') ?? this.root.querySelector<HTMLElement>('.menu-item')
    )?.focus();
  }

  close(): void {
    this.root.style.display = 'none';
    this.anchor = null;
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    this.root.remove();
  }
}
