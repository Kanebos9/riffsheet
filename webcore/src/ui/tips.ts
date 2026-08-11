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
  "Uses your DAW's own tempo and time signature instead of the app working them out by ear. " +
  'For a take made with "Capture from track" the bar lines land exactly where your DAW\'s are, ' +
  'because the app wrote them down while you were playing. For a file you dropped in, the app ' +
  'takes your DAW\'s tempo but has no way of knowing how the file lines up with your project, so ' +
  'it counts the bars from the bar-1 marker instead. With this off, the beat is worked out from ' +
  'the recording alone, which is a guess and can come out wrong.';

export const TIPS = {
  // --- opening -------------------------------------------------------------
  drop:
    'Drop audio, MIDI, MusicXML, Guitar Pro, or a printed score PDF/image. Audio is listened to; score and MIDI files go straight to editable notes.',
  browse: 'Pick a file from your computer instead of dragging one in.',
  capture:
    'Record straight off this track in your DAW. Press once to arm it, hit play in your DAW, then press again when you are done — the sheet appears.',
  captureArmed:
    'Armed and waiting. Recording starts the moment your DAW starts playing, so you do not have to catch it by hand.',
  captureStop: 'Stop recording and turn what you just played into a sheet.',
  recent: 'Open this file again from its original location.',
  engineSetup:
    'The part that listens to audio is not installed yet. Settings → Engine setup lists the steps, shows every place Riffsheet looked for it, and has a Check again button for when you have finished. Riffsheet never installs anything itself. The very first transcription after setup also downloads the listening model, which takes a few minutes; everything later is quick. Until then you can still open MIDI, MusicXML and score files.',

  // --- transport -----------------------------------------------------------
  play: 'Play from where the cursor is. The space bar does the same thing.',
  stop: 'Stop playing and jump back to the very beginning.',
  loop: 'Repeat the bar under the playhead. Move to another bar, turn this off, then on again to pick that bar.',
  position: 'Where you are in the recording, in minutes and seconds.',
  fader:
    'Slide between your actual recording and the app\'s version of what it heard. Sitting in the middle plays both at once — the fastest way to spot a note it got wrong.',
  bpm:
    'The tempo — how many beats per minute. Unless it came from your DAW, the app worked this out from the recording by ear, so it can be wrong; if the rhythm on the sheet looks wrong, fixing this number is the FIRST thing to try.',
  timesig:
    'How many beats are in each bar. Most rock and pop is 4/4. If your bars look chopped in the wrong places, try another one.',

  // --- waveform ------------------------------------------------------------
  waveform:
    'The recording, drawn as a picture. Click anywhere in it to jump there — and the app plays a ' +
    'moment of the recording from that spot and tells you what pitch is really in it, measured ' +
    'straight off the sound rather than read back off the sheet. That is how you check a note the ' +
    'app got wrong, and how you find one it missed entirely, because you can point at a place ' +
    'where nothing was written down at all. While it is following the sheet, a thin ribbon along ' +
    'the top shows the whole recording with a bracket around the part you are looking at — drag ' +
    'that bracket to move through the take.',
  trimmed:
    'The dimmed parts are silence at the start and end that the app is ignoring, so your riff starts at bar 1 instead of three seconds in.',
  barOneMarker:
    'Where bar 1 begins. The app put it where the recording stops being silent; drag it if the count-in should start somewhere else. Moving it re-draws the sheet — it does not listen to your audio again.',
  hostSync: HOST_SYNC_TIP,
  /** The old name for `hostSync`. Same text; kept so older callers keep working. */
  hostGrid: HOST_SYNC_TIP,

  // --- piano roll ----------------------------------------------------------
  pianoRoll:
    'The notes the app heard, drawn as blocks: high notes near the top, time running left to right. Bar, beat and column lines come from the Grid chip beside this one, which is only ever used for drawing and editing here — never for re-writing the sheet. Double-click empty space to add a note; double-click a note to delete it.',
  pianoRollResize:
    'Drag this edge down to make the piano roll taller, up to make it shorter. Double-click to put it back to normal. It stays where you leave it.',
  alignViews:
    'Keeps all four views pointing at the same moment. Click anywhere on the waveform or the piano roll and the sheet scrolls to that spot, so the page you are reading follows the sound you are pointing at. Picking a note always lights it up everywhere, whether this is on or off. It never changes the piano roll’s spacing — the roll is a plain steady ruler, left to right, and adding a note there never shifts the notes around it.',
  // Kept because removing an exported key breaks whoever imports it. Its control is now
  // `alignViews`, which means something else: see the note on the Align chip in `ui/app.ts`.
  rollLink:
    'Keeps all four views pointing at the same moment.',
  rollReset:
    'Puts the view back to normal — full size again, scrolled back to the start. Use it when zooming has left you somewhere you did not mean to be.',
  rollEdit:
    'Drag a note to move it, drag its right edge to change how long it is, double-click an empty spot to add one, and press Delete to remove the note you picked. Hold Option while you drag to ignore the grid and place it exactly where you want.',
  autoEdits:
    'How many notes Riffsheet split or added on its own, listening to your recording, that you have not looked at yet. Click to step through them one at a time — each one lights up on the piano roll and the waveform and offers Keep or Revert. They disappear from here as you deal with them.',
  autoSplitAtAttacks:
    'Riffsheet listens to your recording for the moment a string is struck, and it hears repeated notes that the transcriber often runs together — two quick notes coming back as one long one. With this on, it splits that long note at the second strike, and where the transcriber wrote nothing but a clear steady note was played, it writes one in. Every change it makes is outlined on the piano roll and shaded on the waveform until you click it and choose Keep or Revert; the sheet and the tab are left clean. It is careful on purpose and would rather do nothing than guess — anything it is unsure about is highlighted without being touched. Turn it off and it stops changing notes, but still shows you where it heard something the transcriber did not.',
  /**
   * DEAD, like the two below it: "Follow a drifting tempo" is off for good and has no switch
   * (#39). Kept for the same reason every other retired key here is — an exported key that
   * disappears takes somebody's tooltip with it — and left describing what the feature did,
   * so that whoever revives it has the sentence it shipped with.
   */
  preciseBeats:
    'For playing that drifts. The app listens a second time and follows your actual beat instead of assuming one steady tempo. It takes longer, and it only helps if you played without a click. It changes nothing on the sheet you already have — only what happens the next time the app listens to a recording, either a new file or "Listen again".',

  tabOctaveShift:
    'This note is outside what your instrument can reach, so the tab has moved the position by a whole octave to keep it on the fretboard: 8va means the tab is an octave above the note on the staff, 8vb an octave below (15ma and 15mb are two octaves). Play what the tab says. The staff above still shows the note you really played.',
  stringLetters:
    'What each tab line is tuned to, with the open string played on that line. The bottom line is your thickest string. Change them with the Tab menu under the sheet — these follow whatever tuning the sheet is written for, and they print.',

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
    'Choose whether to show tablature. Bass and Guitar are starting presets; Custom accepts any practical string count and tuning. This never restricts what the listener may hear.',
  tuning:
    'Open-string pitches from the lowest string to the highest. They are printed with the tablature and determine its string and fret suggestions.',
  /**
   * The Quantize menu. Named `grid` still, because renaming an exported key renames it for
   * every caller and this one is read by the notation toolbar under a name nothing else uses.
   */
  grid:
    'How much the sheet rounds what you played. This never changes the piano roll — only how the sheet rounds it. Free is where it starts, and it writes exactly what you played with no tidying at all. Auto works it out bar by bar and is the only setting that can write straight notes and triplets in the same piece, so it is the one to reach for when Free comes out cluttered. Naming a size instead forbids everything finer, so a triplet played against 1/8 loses a note; 1/32 is there for fast picked figures that 1/16 rounds into each other, and Triplet (1/12) for music that swings in threes.',
  /**
   * The roll's own ruler, and it keeps the plain name "Grid" on screen. The menu that used to
   * be called Notation is "Quantize" now, so the two no longer read as the same word twice.
   */
  rollGrid:
    'The columns drawn on the piano roll, and the size of a note you add by hand: with 1/4 selected, double-clicking an empty spot puts a quarter note there, on the nearest quarter-note line. On its own it never re-writes what the app heard — changing it does not move a single note. Hold Option while dragging to ignore it.',
  /**
   * Snap to grid. The one control in the app that MOVES the player's notes, so its tip has to
   * say both halves out loud: what it does, and that it is undoable by switching it off.
   */
  rollSnap:
    'Line every note up with the grid columns. Each note starts on the nearest line and keeps the length it had. Your recording is kept underneath exactly as you played it, so switching this off puts every note straight back — and changing the grid size measures again from the original, never from the last snap. While it is on, the sheet, the playback and anything you export all follow the lined-up version.',
  clef:
    'Auto chooses one stable clef for the whole part. Treble and Bass force one clef; Grand stacks treble and bass for music that genuinely needs both ranges.',
  fingering:
    'How the tab picks frets. Low positions keeps you near the nut; least movement keeps your hand in one place even if that means higher frets.',
  maxFret:
    'How far up the neck Riffsheet may go when YOU move a note — dragging a notehead to a new pitch, or a fret digit onto another string. A move that would need a higher fret than this is refused instead of written. It does not re-fret the notes already on the page; set it to whatever your own instrument actually has.',
  capo:
    'Where your capo is clamped, counted in frets from the nut. The tab then counts from the capo instead: with it on 2, a note you would have played at fret 5 is written as a 3. The notes on the staff do not move, because your playing did not. 0 means no capo.',
  documentKey:
    'How many sharps or flats are printed at the start of every line. Auto uses the key the app worked out from the notes you played; naming one overrides that, which is what you want when a riff has come back spelled in the wrong key. It never changes a pitch — only how that pitch is written down. It belongs to this take, like the tempo, not to the app.',
  sound:
    "The recorded multisample instrument used for the app's MIDI playback.",
  noteNames: 'Show or hide the row of letter names between the sheet and the tab.',
  // THE NEXT TWO HAVE NO CONTROL ANY MORE (#39). Naming every row and editing on the roll are
  // simply what the roll does; the switches were taken out of the settings panel and the
  // behaviour is hardcoded on in `ui/app.ts` §renderMain. The texts stay because removing an
  // exported key breaks whoever imports it, and because `rollEdit` above — which IS still
  // rendered, on the roll itself — says the same thing about the same gestures.
  rollAllNoteNames:
    'Write a letter name on every row of the piano roll, not only on the C notes. When the roll is too short to fit that many names it thins them out by itself — first down to the white-key notes, then back to the C\'s — so no two names are ever drawn on top of each other. The C\'s stay emphasised either way, so you can still find your place.',
  rollEditing:
    'Lets you change notes on the piano roll: drag one to move it, drag its right-hand edge to change how long it is, double-click an empty spot to add one, or select one and press Delete to take it away. Every one of those changes the notes the sheet is written from, so the sheet and the tab redraw to match — and ⌘Z takes it back.',
  tooltips: 'Turn these explanations on or off.',
  engineModel:
    'Which set of weights does the listening. Bigger is more accurate but slower and hungrier for memory; "Choose for me" picks the biggest one that is already installed and still fits in this machine.',
  engineStatus: 'Whether the part that listens to your audio is installed, and what it is doing right now.',
  engineBusy:
    'Another Riffsheet is using the transcription engine right now. There is only one of it and it does one job at a time, so yours starts as soon as that one finishes.',
  reset: 'Put every setting on this panel back the way it shipped. Your notes and edits are not touched.',

  // --- export --------------------------------------------------------------
  // The plain version, with no drag in it. `ui/exportBar.ts` uses this text ONLY when there is
  // no drag to be had (no host bridge, nothing built yet) and writes its own sentence when
  // there is — so promising a drag here promised it in exactly the case where it does not work.
  exportMidi:
    'Save as MIDI. Pick the tidied-up version, exactly-as-you-played, or both — it remembers what you chose last time.',
  exportMusicXml: 'Save as MusicXML — opens in MuseScore, Sibelius, Guitar Pro and the rest.',
  exportPdf: 'Save the sheet and tab as a PDF you can print or send.',
  retranscribe:
    'Listen to the same recording again and take a fresh reading. Worth trying when the app has ' +
    'clearly misheard a passage: the listening engine does not always give the same answer twice, ' +
    'so a second attempt can simply come out better. It replaces the notes, so any changes you ' +
    'have made are lost — it asks first.',
  engineChip:
    'The listening engine is running and using this much memory. It shuts itself down the moment ' +
    'it has finished a transcription, so most of the time it is not running at all and this is ' +
    'not here; click it to stop it early. It starts again by itself the next time you transcribe ' +
    'something.',
  openAnother:
    'Return to the main menu to open a file, capture the DAW track, create a blank score, or resume current work.',
  rollZoom:
    'How tall the piano-roll rows are. The wheel over the keyboard on the left does the same, a trackpad pinch does it anywhere on the roll, and a double-click on the keyboard fits every note in the take on screen at once.',
  rollTimeZoom:
    'How much of the recording the piano roll shows across its width. The wheel over the time ' +
    'ruler at the top of the roll does the same. With Align on, the sheet music magnifies to ' +
    'match, so both views keep showing the same stretch of the take.',
  rollTimeFit:
    'Show the whole recording across the roll again, from the first sound to the last.',
  rollFit:
    'Zoom the piano roll out until every note in the take fits. Useful once, to see the shape of ' +
    'the whole thing — but it is not how the roll opens any more, because fitting a wide-ranging ' +
    'take squashes every row until you cannot read it.',
  settings: 'Open the settings panel.'
} as const;
