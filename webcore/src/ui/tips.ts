/**
 * Plain-language tooltips, toggleable (default ON).
 *
 * Ported from Basscribe's TooltipLayer + useTip, keeping the good idea — registration via
 * the plain `title` attribute, hoisted into `data-riff-tip` so the native OS tooltip never
 * appears — and fixing the two bugs that shipped with it:
 *
 *   1. Basscribe's hoist was permanent, so turning tips OFF left `data-riff-tip` on every
 *      element already hovered and those kept showing tips forever. Here the layer checks
 *      the flag on every hover AND sweeps `[data-riff-tip]` back to `title` on toggle.
 *   2. After an off->on cycle the old code left `title` and `data-riff-tip` both present,
 *      resurrecting the native tooltip permanently. The sweep makes the two states exact
 *      inverses of each other.
 *
 * Texts are written for an amateur musician, generously — never manual-speak.
 */

const HOVER_DELAY_MS = 250;

let enabled = true;
let tipEl: HTMLElement | null = null;
let timer: number | undefined;
let currentEl: Element | null = null;

export function tipsEnabled(): boolean {
  return enabled;
}

/** Gate helper: `title: t(TIPS.play)` yields undefined when tips are off. */
export function t(text: string): string | undefined {
  return enabled ? text : undefined;
}

export function setTipsEnabled(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  localStorage.setItem('riffsheet.tooltips', on ? '1' : '0');
  hide();
  // Restore hoisted text so the two states are exact inverses.
  for (const node of document.querySelectorAll<HTMLElement>('[data-riff-tip]')) {
    if (!on) {
      node.removeAttribute('data-riff-tip');
    }
  }
}

function findTipSource(target: EventTarget | null): { el: HTMLElement; text: string } | null {
  let node = target instanceof Element ? (target as HTMLElement) : null;
  while (node && node !== document.body) {
    const hoisted = node.getAttribute('data-riff-tip');
    if (hoisted) return { el: node, text: hoisted };
    const title = node.getAttribute('title');
    if (title) {
      // Hoist so the native tooltip (delayed, unstyled, unreliable) never fires.
      node.setAttribute('data-riff-tip', title);
      node.removeAttribute('title');
      return { el: node, text: title };
    }
    node = node.parentElement;
  }
  return null;
}

function show(text: string, x: number, y: number): void {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'riff-tooltip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = text;
  tipEl.style.visibility = 'hidden';
  tipEl.style.display = 'block';

  // Measure, then clamp on all four edges — Basscribe only clamped right and bottom.
  const rect = tipEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(x + 12, window.innerWidth - rect.width - 8));
  let top = y + 16;
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - rect.height - 10);
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
  tipEl.style.visibility = 'visible';
}

function hide(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  currentEl = null;
  if (tipEl) tipEl.style.display = 'none';
}

export function installTooltipLayer(): void {
  enabled = localStorage.getItem('riffsheet.tooltips') !== '0';

  const onOver = (e: MouseEvent) => {
    if (!enabled) return;
    const src = findTipSource(e.target);
    if (!src) {
      hide();
      return;
    }
    // Moving within the same control must not restart the timer or move the popup.
    if (src.el === currentEl) return;
    hide();
    currentEl = src.el;
    const { clientX, clientY } = e;
    timer = window.setTimeout(() => {
      if (currentEl !== src.el) return;
      show(src.text, clientX, clientY);
    }, HOVER_DELAY_MS);
  };

  const onFocus = (e: FocusEvent) => {
    if (!enabled) return;
    const src = findTipSource(e.target);
    if (!src) return;
    hide();
    currentEl = src.el;
    const r = src.el.getBoundingClientRect();
    show(src.text, r.left + r.width / 2, r.bottom + 4);
  };

  // Capture phase throughout, so nothing can stopPropagation these away.
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('keydown', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}

/**
 * One text, two keys.
 *
 * `hostSync` is the name to use. `hostGrid` was the old one and is kept pointing at the same
 * sentence, because a tip key that quietly disappears takes a tooltip with it and nobody
 * notices until a user hovers something and gets nothing.
 */
const HOST_SYNC_TIP =
  "Takes the tempo and time signature from your DAW instead of working them out by ear. " +
  'A captured take gets your DAW\'s exact bar lines; a dropped-in file borrows only the tempo. ' +
  'Off means the beat is guessed from the recording, which can come out wrong.';


/**
 * THE TEXTS (H11).
 *
 * They were essays. The capo's ran to sixty words, "split at attacks" to a hundred and thirty,
 * the tempo source to a hundred and twenty — each one a wall of grey text in a narrow bubble,
 * which is a thing people close rather than read, and the owner said so.
 *
 * THE RULE NOW: ONE TO THREE SHORT SENTENCES, and only what somebody hovering actually needs —
 * what this control does, and the one thing about it that is surprising. No history, no
 * reassurance repeated three ways, no explanation of a second control that has a tooltip of its
 * own. Plain words: "rounds", not "quantizes"; "your recording is not touched", not a paragraph
 * about non-destructive layers.
 *
 * What was cut was never information anybody was hovering FOR. The reasoning behind these
 * decisions has not been thrown away — it lives in the source comments beside the code that
 * implements it, which is where the next person to change it will look, rather than in a popup
 * over a button.
 *
 * Retired keys are kept (see the notes on them below): removing an exported key removes the
 * tooltip for whoever still imports it, and this file has outlived several of its controls.
 */
export const TIPS = {
  // --- opening -------------------------------------------------------------
  drop: 'Drop in audio, MIDI, MusicXML, Guitar Pro, or a printed score as a PDF or image. Audio is listened to; everything else becomes editable notes straight away.',
  browse: 'Pick a file from your computer instead of dragging one in.',
  capture:
    'Record straight off this track in your DAW. Press once to arm it, hit play in your DAW, then press again when you are done.',
  captureArmed: 'Armed and waiting. Recording starts by itself the moment your DAW starts playing.',
  captureStop: 'Stop recording and turn what you just played into a sheet.',
  recent: 'Files you have opened before. Pick one to open it again from where it lives on disk.',
  engineSetup:
    'The part that listens to audio is not installed yet. Settings → Engine setup lists the steps and checks again when you are done. MIDI, MusicXML and score files work without it.',

  // --- transport -----------------------------------------------------------
  play: 'Play from where the cursor is. The space bar does the same thing.',
  stop: 'Stop playing and jump back to the very beginning.',
  loop: 'Repeat the bar under the playhead. To loop a different bar, move there, turn this off, then on again.',
  position: 'Where you are in the recording, in minutes and seconds.',
  fader:
    "Slide between your actual recording and the app's version of what it heard. In the middle you hear both at once, which is the fastest way to spot a wrong note.",
  bpm:
    'The tempo, in beats per minute. Unless it came from your DAW this was worked out by ear, so if the rhythm on the sheet looks wrong, fix this number first.',
  /**
   * The one control the "Use DAW grid" chip and the BPM box became (F19). Three states, one
   * line each — the fields greying out is the only surprise, so that is the only aside.
   */
  tempoSource:
    'Where the tempo and time signature come from. Follow DAW takes them from your DAW, Manual lets you type them, From recording works them out by ear and re-checks whenever you edit the take. The two boxes beside this are only yours to type in on Manual.',
  /**
   * The old Re-detect button's tip. The button is gone (G12) — choosing "From recording" does
   * the detecting, and every take edit re-does it — but removing an exported key removes it for
   * every caller, so it stays with text that is still true of what replaced it.
   */
  tempoRedetect:
    'The tempo and time signature are worked out again by themselves whenever the take changes — after a trim, a cut, an edit, or a move of the bar-1 marker. None of that listens to your audio afresh; that is "Start over" in the Main menu.',
  timesig:
    'How many beats are in each bar. Most rock and pop is 4/4. If your bars look chopped in the wrong places, try another one.',

  // --- waveform ------------------------------------------------------------
  waveform:
    'Your recording, drawn as a picture. Click anywhere to jump there, and the app plays that moment and tells you what pitch is really in it. The ribbon along the top brackets the part you are looking at — drag it to move through the take.',
  trimmed: 'The dimmed parts are silence at the start and end that the app is ignoring, so your riff starts at bar 1.',
  barOneMarker:
    'Where bar 1 begins. Drag it if the count-in should start somewhere else. Moving it redraws the sheet; it does not listen to your audio again.',
  trimSilence:
    'Takes the quiet run-up and ending off the take, so the music starts where the music starts. Your recording is not touched, and one undo puts it back.',
  cutArm:
    'Turns the recording strip into a span picker. Drag across it to sweep out a stretch, and drag either end to adjust — the notes inside light up so you can see what would go. Nothing is removed until you press "Cut out".',
  cutOut:
    'Removes the selected stretch and closes the gap, as if you had never played it. The sheet, the roll and every export get shorter to match. Your recording is not touched: undo puts it back.',
  cutSummary:
    'How much of the take your cuts are leaving out. Nothing has been taken off your disk. Playing the original sound jumps over the cuts, so you may hear a small click at the join.',
  hostSync: HOST_SYNC_TIP,
  /** The old name for `hostSync`. Same text; kept so older callers keep working. */
  hostGrid: HOST_SYNC_TIP,

  // --- piano roll ----------------------------------------------------------
  pianoRoll:
    'The notes the app heard, as blocks: high notes near the top, time left to right. Double-click empty space to add a note, or a note to delete it.',
  pianoRollResize:
    'Drag this edge to make the piano roll taller or shorter. Double-click to put it back. It stays where you leave it.',
  /**
   * The Align chip's tip. The chip is deleted (G11) — alignment is simply what the app does —
   * and the key stays because removing an exported one removes it for every caller.
   */
  alignViews:
    'All four views point at the same moment. Click the waveform or the piano roll and the sheet scrolls there too; picking a note lights it up everywhere.',
  // Kept because removing an exported key breaks whoever imports it. Its control is now
  // `alignViews`, which means something else: see the note on the Align chip in `ui/app.ts`.
  rollLink: 'Keeps all four views pointing at the same moment.',
  rollReset: 'Puts the view back to normal — full size, scrolled to the start.',
  rollEdit:
    'Drag a note to move it, drag its right edge to change its length, double-click empty space to add one, or press Delete to remove the one you picked. Hold Option while dragging to ignore the grid.',
  autoEdits:
    'Notes Riffsheet split or added on its own that you have not looked at yet. Click to step through them — each one lights up and offers Keep or Revert.',
  autoSplitAtAttacks:
    'Transcribers often run two quick repeated notes together into one long one. With this on, Riffsheet listens for the second strike and splits the note there. Every change it makes is highlighted for you to Keep or Revert; off, it still shows you what it heard but changes nothing.',
  /**
   * DEAD, like the two below it: "Follow a drifting tempo" is off for good and has no switch
   * (#39). Kept for the same reason every other retired key here is — an exported key that
   * disappears takes somebody's tooltip with it — and left describing what the feature did,
   * so that whoever revives it has the sentence it shipped with.
   */
  preciseBeats:
    'For playing that drifts. The app listens a second time and follows your actual beat instead of one steady tempo. It takes longer, and only helps if you played without a click.',

  tabOctaveShift:
    'This note is outside your instrument\'s reach, so the tab moved the position by an octave to keep it on the fretboard. Play what the tab says — the staff above still shows the note you really played.',
  stringLetters:
    'What each tab line is tuned to, lowest string at the bottom. Change them with the Tab menu under the sheet. They print with the tab.',

  // --- editing -------------------------------------------------------------
  // The first seven of these belonged to the per-note popover, and nothing renders them any
  // more — the popover was replaced by dragging on the piano roll and by the Delete key
  // (see `ui/app.ts`). Kept because removing an exported key breaks whoever imports it, but
  // do not add to them: `rollEdit` / `rollEditing` are where the live gestures are described.
  pitchUp: 'Move this note up one semitone.',
  pitchDown: 'Move this note down one semitone.',
  stringUp: 'Play this same note on the next thinner string, higher up the neck.',
  stringDown: 'Play this same note on the next thicker string, lower down the neck.',
  nudgeLeft: 'Move this note one step earlier in time.',
  nudgeRight: 'Move this note one step later in time.',
  deleteNote: 'Remove this note. The app sometimes hears notes you did not play — this is how you take them away.',
  undo: 'Take back the last change (⌘Z).',
  redo: 'Bring back what you just undid (⌘⇧Z).',

  // --- settings ------------------------------------------------------------
  instrument:
    'Whether to show tablature, and for what. Bass and Guitar are presets; Custom takes any string count and tuning. It never limits what the app is allowed to hear.',
  tuning:
    'Open-string pitches, lowest string first. They decide the tab\'s string and fret suggestions, and they print with it.',
  /**
   * The Quantize menu. Named `grid` still, because renaming an exported key renames it for
   * every caller and this one is read by the notation toolbar under a name nothing else uses.
   */
  grid:
    'How much the sheet rounds what you played, and only the sheet — the piano roll never changes. Auto works it out bar by bar; Free writes exactly what you played, with no tidying at all. Naming a size forbids everything finer, so a triplet against 1/8 loses a note.',
  /**
   * The roll's own ruler, and it keeps the plain name "Grid" on screen. The menu that used to
   * be called Notation is "Quantize" now, so the two no longer read as the same word twice.
   */
  rollGrid:
    'The columns on the piano roll, and the length of a note you add by hand. Free draws the subdivisions but snaps to none of them; Off draws bar lines only. It never re-writes what the app heard — hold Option while dragging to ignore it.',
  /**
   * Snap — Off / Grid / Beat. The one control in the app that MOVES the player's notes, so its
   * tip has to say all of it out loud: one line per state, then the promise that covers all
   * three — the recording is kept underneath and Off puts every note straight back.
   */
  rollSnap:
    'Off shows your recording exactly as played. Grid lines every note up with the columns; Beat moves each note to its nearest beat, which gives the cleanest sheet. Your recording is kept underneath either way, so Off puts every note straight back.',
  /**
   * The Part box on the notation bar. It is both a chooser and a menu, so the tip has to say
   * that out loud — the first half of the list picks the part, the second half acts on it.
   */
  parts:
    'Which part of the sheet you are working on, and what to do with it. The one marked ● is your own take — it is always on the page and always the one you hear. Add part reads a MusicXML file and prints it as an extra staff, up to four; imported parts are engraved but never played.',
  clef:
    'Auto picks one stable clef for the whole part. Treble and Bass force one; Grand stacks both, for music that really needs the range.',
  fingering:
    'How the tab picks frets. Low positions keeps you near the nut; least movement keeps your hand in one place, even if that means higher frets.',
  maxFret:
    'How far up the neck Riffsheet may go when YOU move a note. A move needing a higher fret is refused rather than written. It does not re-fret notes already on the page — set it to what your instrument actually has.',
  capo:
    'Where your capo is clamped, in frets from the nut. The tab then counts from the capo: with it on 2, a note you would play at fret 5 is written as 3. The staff does not move. 0 means no capo.',
  documentKey:
    'How many sharps or flats are printed at the start of each line. Auto uses the key the app worked out; naming one overrides it, which is what you want when a riff comes back in the wrong key. It never changes a pitch, only how it is written.',
  sound: "The recorded instrument used for the app's MIDI playback.",
  noteNames: 'Show or hide the row of letter names between the sheet and the tab.',
  // THE NEXT TWO HAVE NO CONTROL ANY MORE (#39). Naming every row and editing on the roll are
  // simply what the roll does; the switches were taken out of the settings panel and the
  // behaviour is hardcoded on in `ui/app.ts` §renderMain. The texts stay because removing an
  // exported key breaks whoever imports it, and because `rollEdit` above — which IS still
  // rendered, on the roll itself — says the same thing about the same gestures.
  rollAllNoteNames:
    'Write a letter name on every row of the piano roll, not only the C notes. When the roll is too short it thins them out by itself, so no two names overlap.',
  rollEditing:
    'Lets you change notes on the piano roll. Every change rewrites the sheet and the tab to match, and ⌘Z takes it back.',
  tooltips: 'Turn these explanations on or off.',
  engineModel:
    'Which set of weights does the listening. Bigger is more accurate but slower and hungrier for memory; "Choose for me" picks the biggest one installed that still fits this machine.',
  engineStatus: 'Whether the part that listens to your audio is installed, and what it is doing right now.',
  engineBusy:
    'Another Riffsheet is using the transcription engine. There is only one of it and it does one job at a time, so yours starts as soon as that one finishes.',
  reset: 'Put every setting on this panel back the way it shipped. Your notes and edits are not touched.',

  // --- export --------------------------------------------------------------
  // The plain version, with no drag in it. `ui/exportBar.ts` uses this text ONLY when there is
  // no drag to be had (no host bridge, nothing built yet) and writes its own sentence when
  // there is — so promising a drag here promised it in exactly the case where it does not work.
  exportMidi:
    'Save as MIDI. Pick the tidied-up version, exactly as you played it, or both — it remembers what you chose last time.',
  exportMusicXml: 'Save as MusicXML — opens in MuseScore, Sibelius, Guitar Pro and the rest.',
  exportPdf: 'Save the sheet and tab as a PDF you can print or send.',
  retranscribe:
    'Listen to the same recording again for a fresh reading. The engine does not always give the same answer twice, so a second attempt can simply come out better. It replaces the notes, so your changes are lost — it asks first.',
  engineChip:
    'A listening engine is running right now. Click to shut it down and give its memory back. It stops by itself after each transcription and starts again when you need it.',
  openAnother:
    'Back to the main menu, where you can open a file, capture the DAW track, start a blank score, or resume what you were doing.',
  /*
   * THE TWO MAGNIFIERS. Their tips are the only place the gestures are written down (H11): a
   * trackpad pinch and a two-finger swipe are things nobody discovers by looking at a button,
   * and the buttons are exactly where somebody goes when they want to zoom.
   */
  rollZoom:
    'How tall the piano-roll rows are. Option+pinch also zooms pitch, the wheel over the keyboard on the left does the same, and a double-click on the keyboard fits every note on screen.',
  rollTimeZoom:
    'How much of the recording the roll shows across its width, with the sheet magnifying to match. Pinch on the trackpad also zooms time, and two-finger swipes scroll.',
  /**
   * The old "Fit" button's tip. The button is deleted (G13); fitting the time axis is a
   * double-click on the roll's ruler. The key stays for the same reason the two above it do.
   */
  rollTimeFit:
    'Show the whole recording across the roll again. Double-click the time ruler at the top of the roll to do it.',
  rollFit:
    'Zoom the roll out until every note fits. Useful once, to see the shape of the whole take — it is not how the roll opens, because fitting a wide-ranging take squashes the rows.',
  settings: 'Open the settings panel.',

  // --- the brand block ------------------------------------------------------
  brand:
    'Which version of Riffsheet you are running. Click to open the releases page in your browser. Riffsheet never checks for updates by itself — this button is the only thing here that opens a web page.',
  /** The engine cards' truncated Source: link, and the copy button beside it. */
  engineSourceLink:
    'Where this engine comes from. The address is shortened to fit; click it to open the full page in your browser.',
  engineSourceCopy: 'Copy the full address to the clipboard.'
} as const;
