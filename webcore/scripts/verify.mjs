#!/usr/bin/env node
/**
 * End-to-end smoke test of the built app, headless.
 *
 * Loads index.html?demo, waits for the tri-view to render, and asserts the things that
 * would be embarrassing to ship broken: staff SVG present, tab present, note-name labels
 * placed, no console errors. Writes a screenshot to spike-results/app.png.
 *
 * It also checks the three things a screenshot alone would not catch, at three viewports
 * (1440x900, 1100x700, 900x600):
 *
 *   - the note-names row is CLEAR of both the staff and the tab. It collided with the tab
 *     once; measured slack plus a glyph-intersection count is what keeps it from coming
 *     back. `.note-name` boxes are compared against every engraved fret digit.
 *   - the piano-roll strip is present, drawn from the score, seeks when clicked, and
 *     collapses when its chip is switched off.
 *   - octave-folded tab positions (IRNote.tabOctaveShift) carry an 8va marker. The
 *     `?demo=droptuned` fixture exists purely to make that path render.
 *
 *   node scripts/verify.mjs [--headful]
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const PORT = 5398;
const HEADFUL = process.argv.includes('--headful');
const READINESS_ONLY = process.env.RIFFSHEET_VERIFY_READINESS_ONLY === '1';
const TARGET_QUERY = process.env.RIFFSHEET_VERIFY_QUERY ?? 'demo=triplet&bars=8&tab=bass&verify=1';
const READY_EXPRESSION = process.env.RIFFSHEET_VERIFY_READY_EXPRESSION ??
  '!!window.__RIFFSHEET_DEMO_READY__ && document.querySelectorAll(".note-name").length > 0';
const READY_TIMEOUT_MS = Math.max(
  1_000,
  Math.min(40_000, Number(process.env.RIFFSHEET_VERIFY_READY_TIMEOUT_MS) || 40_000)
);
/**
 * How far a note's roll x may sit from its sheet x, in viewport pixels, with Align ON.
 *
 * Not a taste, and not a number anybody would want to be larger: it is the residual of drawing
 * a LINEAR time ruler under an engraving that deliberately is not linear in time. alphaTab
 * gives a rhythmically dense bar more pixels than a sparse one, and the roll must stay linear
 * or a picture of a performance re-spaces itself whenever the performance is edited — the
 * failure the old linked mode was deleted for, and the one rule this whole item is built
 * around. The two therefore agree exactly at the edges of the visible span and drift by the
 * engraving's own unevenness in between.
 *
 * Measured on the demo fixture (worst 308 px on a 1440 px pane) and set just above it, so a
 * regression that made the coupling looser fails here. The ratio check beside it is what stops
 * this being a rubber stamp: unaligned, the SAME three notes miss by 2712 px, so the bound has
 * to be nearly nine times tighter than doing nothing.
 */
const ALIGN_TOLERANCE_PX = 320;

const VERIFY_STARTED = Date.now();
const VERIFY_DEADLINE = VERIFY_STARTED + 5 * 60_000;
let activePhase = { name: 'startup', deadline: VERIFY_STARTED + 30_000 };

/**
 * The old harness printed nothing until every probe had completed. A single page promise that
 * never settled therefore looked exactly like an idle agent for as long as the caller was
 * willing to wait. Phases are both visible progress and hard budgets: no debugger request can
 * outlive the phase that owns it, and the entire run is capped at five minutes.
 */
function phase(name, budgetMs) {
  activePhase = {
    name,
    deadline: Math.min(VERIFY_DEADLINE, Date.now() + budgetMs)
  };
  const elapsed = ((Date.now() - VERIFY_STARTED) / 1000).toFixed(1);
  console.log(`[verify +${elapsed}s] ${name}`);
}

function requestBudget(capMs = 45_000) {
  const remaining = Math.min(activePhase.deadline, VERIFY_DEADLINE) - Date.now();
  if (remaining <= 0) {
    throw new Error(`phase timed out: ${activePhase.name}`);
  }
  return Math.max(1, Math.min(capMs, remaining));
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${(timeoutMs / 1000).toFixed(1)}s`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.sf2': 'application/octet-stream',
  '.sf3': 'application/octet-stream',
  // decodeAudioData works off the bytes, not the content type — the JUCE resource provider
  // serves these as octet-stream too, so the harness matches it deliberately.
  '.wav': 'audio/wav'
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let path = normalize(decodeURIComponent(url.pathname));
      if (path === '/') path = '/index.html';
      const file = join(DIST, path);
      if (!file.startsWith(DIST)) return void res.writeHead(403).end();
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  // Fail FAST and legibly when the port is taken. This used to reject nothing and resolve
  // nothing: `listen` emitted an 'error' event with no handler, so the run either crashed with
  // a raw stack trace or hung forever with no output at all. Both happened, repeatedly, and
  // each time it looked like the harness itself was broken rather than a leftover run.
  return new Promise((ok, fail) => {
    server.once('error', (e) =>
      fail(
        new Error(
          e.code === 'EADDRINUSE'
            ? `port ${PORT} is already in use — another verify run is still going. ` +
              `Stop it with:  lsof -ti :${PORT} | xargs kill`
            : String(e.message ?? e)
        )
      )
    );
    server.listen(PORT, '127.0.0.1', () => ok(server));
  });
}

class Cdp {
  #ws; #id = 0; #pending = new Map(); #listeners = new Map();
  static async connect(url) {
    const c = new Cdp();
    c.#ws = new WebSocket(url);
    await withTimeout(
      new Promise((ok, err) => {
        c.#ws.addEventListener('open', ok, { once: true });
        c.#ws.addEventListener('error', () => err(new Error('cdp connect failed')), { once: true });
      }),
      requestBudget(10_000),
      'CDP connection'
    );
    c.#ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = c.#pending.get(m.id);
        if (!p) return;
        c.#pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else for (const fn of c.#listeners.get(m.method) ?? []) fn(m.params);
    });
    const rejectPending = () => {
      for (const pending of c.#pending.values()) pending.reject(new Error('CDP connection closed'));
      c.#pending.clear();
    };
    c.#ws.addEventListener('close', rejectPending, { once: true });
    return c;
  }
  on(m, fn) { const l = this.#listeners.get(m) ?? []; l.push(fn); this.#listeners.set(m, l); }
  send(method, params = {}, maxMs = 45_000) {
    const id = ++this.#id;
    const timeoutMs = requestBudget(maxMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `${activePhase.name}: ${method} timed out after ${(timeoutMs / 1000).toFixed(1)}s`
          )
        );
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  close() { this.#ws.close(); }
}

const PROBE = `(() => {
  const q = (s) => document.querySelectorAll(s);
  const svgs = q('.at-host svg');
  let paths = 0, texts = 0;
  for (const s of svgs) { paths += s.querySelectorAll('path').length; texts += s.querySelectorAll('text').length; }
  const names = [...q('.note-name')].map(n => n.textContent);
  return JSON.stringify({
    screen: q('.triview').length ? 'main' : 'opening',
    header: !!document.querySelector('.app-header'),
    transport: !!document.querySelector('.transport'),
    waveform: !!document.querySelector('.waveform'),
    svgCount: svgs.length,
    svgPaths: paths,
    svgTexts: texts,
    nameLabelCount: names.length,
    firstNames: names.slice(0, 10),
    toasts: [...q('.toast')].map(t => t.textContent),
    exportButtons: [...q('.app-header button')].map(b => b.textContent),
    // The gear is BIGGER AND LABELLED now (#11), so it is no longer a button whose whole text
    // is the glyph. Found by its role, and checked for both halves: the glyph that makes it
    // recognisable and the word that makes it findable.
    exportMenuButton: !!document.querySelector('[data-role="export-menu-button"]'),
    exportMenuIsMenu: document.querySelector('[data-role="export-menu-button"]')?.getAttribute('aria-haspopup') === 'menu',
    // It is still the control for the remembered MIDI variant — that is what a drag hands over,
    // and folding four buttons into one must not have lost it. (Whether an OS drag is possible
    // at all is a separate claim, checked by the drag-probe block below: a browser has no
    // beginMidiDrag, so the data-drag attribute is correctly absent here.)
    exportMenuOwnsMidiMode:
      document.querySelector('[data-role="export-menu-button"]')?.getAttribute('data-setting') === 'midiExportMode',
    // The three buttons it replaced, and the stray one from the main menu, are all gone.
    legacyExportButtons: [
      'export-midi', 'export-pdf', 'export-musicxml', 'save-riffsheet-as'
    ].filter((r) => !!document.querySelector('[data-role="' + r + '"]')).length,
    settingsGear: (() => {
      const g = document.querySelector('[data-role="settings-gear"]');
      return !!g && g.textContent.indexOf('\\u2699') >= 0 && /Settings/.test(g.textContent);
    })(),
    mainMenuButton: [...q('.app-header button')].some(b => b.textContent.trim() === 'Main menu'),
    legacyOpenButtons: [...q('button')].filter(b => /^Open(?:\\.\\.\\.)?$/.test(b.textContent.trim())).length,
    // G11: the Align chip is DELETED and alignment is unconditional. Counted, not merely
    // absent-checked, because "one" and "two" are both wrong for different reasons and only a
    // count says which happened.
    linkedControls: [...q('button, [role="switch"]')].filter(e => e.textContent.trim() === 'Align').length,
    // G13: "Fit" is retired from the roll's horizontal zoom pair as well as from the pane.
    rollTimeFitButton: !!document.querySelector('[data-role="roll-time-fit"]'),
    // G7: the axis captions say which axis in words rather than in a 12px arrow glyph.
    zoomAxisLabels: [...q('.zoom-pair [data-role$="zoom-label"]')].map(e => e.textContent.trim()),
    // G12: selecting "From recording" does the detecting; the button is gone.
    tempoRedetectButton: !!document.querySelector('[data-role="tempo-redetect"]'),
    notationToolbar: !!document.querySelector('[data-role="notation-toolbar"]'),
    tabView: document.querySelector('[data-role="tab-view"]')?.value ?? null,
    // The "Tuning low → high:" row is gone. Its job — proving the tuning reached the page —
    // is done by the open-string letters at the left of every tab staff, which are on the
    // paper too. Read off the DOM rather than off a probe, so this measures what is DRAWN.
    stringLetters: [...q('.string-letter')].map((e) => e.textContent.trim()).join(' '),
    stringLetterCount: q('.string-letter').length,
    // TWO grids, and they must be two controls. Until this split they were one <select>
    // driving both the quantizer and the roll's ruler, so asking for bigger cells to draw
    // into also told the transcriber what it was allowed to write.
    notationGridView: document.querySelector('[data-role="notation-grid"]')?.value ?? null,
    notationGridOptions: [...q('[data-role="notation-grid"] option')].map(o => o.value),
    rollGridView: document.querySelector('[data-role="roll-grid"]')?.value ?? null,
    rollGridOptions: [...q('[data-role="roll-grid"] option')].map(o => o.value),
    soundChoices: [...q('[data-role="sound-picker"] option')].map(o => ({
      value: o.value, text: o.textContent
    })),
    layout: (() => {
      const pick = (sel) => { const e = document.querySelector(sel); if (!e) return null;
        const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        return { h: Math.round(r.height), w: Math.round(r.width), top: Math.round(r.top), display: cs.display, flex: cs.flex, position: cs.position }; };
      return { body: pick('body'), app: pick('#app'), triview: pick('.triview'),
               scroll: pick('.triview-scroll'), stack: pick('.triview-stack'), host: pick('.at-host'),
               wave: pick('.waveform'), roll: pick('.pianoroll-pane'), innerH: window.innerHeight };
    })()
  });
})()`;

/** The tri-view's own measurement of where the names row landed. See view/triview.ts. */
const LAYOUT = `JSON.stringify(window.__RIFFSHEET_LAYOUT__ ? window.__RIFFSHEET_LAYOUT__() : null)`;
/** The piano roll's view of itself, plus the transport position for the click test. */
const ROLL = `JSON.stringify(window.__RIFFSHEET_PIANOROLL__ ? window.__RIFFSHEET_PIANOROLL__() : null)`;

/** The strip, same shape of question — its half of the shared ruler. */
const WAVE_PROBE = `JSON.stringify(window.__RIFFSHEET_WAVE__ ? window.__RIFFSHEET_WAVE__() : null)`;

/** Sheet cursor vs synth vs piano roll: one origin, or the cursor leads the sound. */
const TIMEBASE = `JSON.stringify(window.__RIFFSHEET_TIMEBASE__ ? window.__RIFFSHEET_TIMEBASE__() : null)`;

/**
 * Does the MIDI voice play the take, or a quantized copy of it?
 *
 * The reported symptom was "the in-app playback sounds robotic, but the MIDI I export sounds
 * fine in my own sampler". Both were true: the export writes the AS-PLAYED variant by default
 * while playback walked the ENGRAVED model, so every note was struck on a grid line instead of
 * where it was hit. The hook manufactures the disagreement (a 37 ms nudge — no fraction of any
 * beat) and reports where each side puts the note.
 */
const PLAYBACK_TIMING = `JSON.stringify(window.__RIFFSHEET_PLAYBACKTIMING__ ? window.__RIFFSHEET_PLAYBACKTIMING__() : null)`;

/**
 * A real pointerdown at a fraction of the roll's PLOT area — the click-to-seek path.
 *
 * The fraction is of the plot and not of the canvas, because the canvas now carries a pitch
 * label gutter on its left and the timeline starts after it. Asking for "half way along the
 * music" and getting back half the duration is only true if the roll subtracts that gutter,
 * so the expectation is computed from the roll's own numbers and compared tightly. Ignoring
 * the gutter would land a quarter of a second out on this demo — under the old 0.6s slack,
 * which is exactly why that slack is gone.
 */
const clickRoll = (frac) => `(() => {
  const c = document.querySelector('.pianoroll');
  const p = window.__RIFFSHEET_PIANOROLL__ ? window.__RIFFSHEET_PIANOROLL__() : null;
  if (!c || !p || !p.roll) return JSON.stringify({ clicked: false });
  const r = c.getBoundingClientRect();
  const x = p.roll.gutterPx + p.roll.plotWidth * ${frac};
  // Aim at a row with no rectangle on it. A click on a note now SELECTS instead of seeking
  // (the reported bug was that clicking lit up everything before the playhead), so hitting
  // one here would make this check assert the opposite of what it means to.
  const y = typeof p.roll.emptyRowY === 'number' ? p.roll.emptyRowY : r.height / 2;
  c.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true
  }));
  // What that fraction MEANS depends on the ruler the roll is on: the whole take normally,
  // and the sheet's visible span when Align has given it one (#1). Asking the roll itself
  // rather than assuming duration*frac keeps this check testing click-to-seek instead
  // of quietly testing which mode the roll happens to be in.
  const from = typeof p.roll.windowFromSec === 'number' ? p.roll.windowFromSec : 0;
  const to = typeof p.roll.windowToSec === 'number' ? p.roll.windowToSec : p.roll.durationSec;
  return JSON.stringify({
    clicked: true, atFrac: ${frac}, x: Math.round(x),
    wantSec: Number((from + (to - from) * ${frac}).toFixed(3))
  });
})()`;

/** A pointerdown at an absolute x on either strip — for proving they share one ruler. */
const clickAtPx = (selector, x) => `(() => {
  const c = document.querySelector('${selector}');
  const p = window.__RIFFSHEET_PIANOROLL__ ? window.__RIFFSHEET_PIANOROLL__() : null;
  if (!c) return JSON.stringify({ clicked: false });
  const r = c.getBoundingClientRect();
  const y = '${selector}' === '.pianoroll' && p && typeof p.roll?.emptyRowY === 'number'
    ? p.roll.emptyRowY : r.height / 2;
  c.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: r.left + ${x}, clientY: r.top + y, bubbles: true, cancelable: true
  }));
  return JSON.stringify({ clicked: true, x: ${x} });
})()`;

/** Click a chip on the roll's own toolbar by data-role. */
const clickRole = (role) => `(() => {
  const b = document.querySelector('[data-role="${role}"]');
  if (!b) return JSON.stringify({ clicked: false });
  b.click();
  return JSON.stringify({ clicked: true });
})()`;

/**
 * Pick an option in a <select> the way a user does — assign, then fire 'change'.
 *
 * Setting `.value` alone changes what is drawn and nothing else; the app's handler is on the
 * event. A probe that skipped the dispatch would report the control moving while the setting
 * behind it never did, which is the exact class of bug this harness exists to catch.
 */
const setSelect = (role, value) => `(() => {
  const s = document.querySelector('[data-role="${role}"]');
  if (!s) return JSON.stringify({ set: false, reason: 'no control' });
  const has = [...s.options].some((o) => o.value === ${JSON.stringify(value)});
  if (!has) return JSON.stringify({ set: false, reason: 'no such option' });
  s.value = ${JSON.stringify(value)};
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ set: true, value: s.value });
})()`;

/** The built score, asked of the app itself. See `installTestHooks` in ui/app.ts. */
const SELFTEST = `(() => { try {
  return JSON.stringify(window.__RIFFSHEET_SELFTEST__ ? window.__RIFFSHEET_SELFTEST__() : { missing: true });
} catch (e) { return JSON.stringify({ threw: String((e && e.stack) || e) }); } })()`;

/**
 * Is the resize grip drawn AT REST?
 *
 * The handle was always there and always worked; its grip only appeared on hover, and the
 * verdict from the field was that nobody could tell the pane was resizable. An affordance you
 * have to already know about is not one, so the resting opacity is now a thing the harness
 * asserts rather than a thing a stylesheet is trusted about.
 */
const RESIZE_AFFORDANCE = `(() => {
  const h = document.querySelector('[data-role="roll-resize"]');
  if (!h) return JSON.stringify({ present: false });
  const grip = getComputedStyle(h, '::after');
  const r = h.getBoundingClientRect();
  return JSON.stringify({
    present: true,
    cursor: getComputedStyle(h).cursor,
    heightPx: Math.round(r.height),
    gripOpacity: Number(grip.opacity),
    gripWidthPx: parseFloat(grip.width) || 0
  });
})()`;

/**
 * Alt+wheel over the roll — the pitch-axis zoom gesture.
 *
 * The time axis stays a stable DAW ruler; this changes only how many pitch rows are visible.
 * ALT, not Ctrl: the roll's gesture map (view/pianoroll.ts, invariant 6) gives Ctrl/Cmd+wheel
 * to the SHEET's zoom, because that is where a trackpad pinch arrives, and keeps Alt/Option
 * for its own vertical zoom. Sending Ctrl here asserted the pitch zoom while driving the
 * sheet's, so the row size correctly never moved.
 */
/**
 * A PLAIN wheel over the pitch gutter — no key held. #9's whole point: zoom is discoverable by
 * putting the pointer somewhere sensible, not by knowing that Alt exists.
 */
const WHEEL_OVER_GUTTER = `(() => {
  const c = document.querySelector('.pianoroll');
  if (!c) return JSON.stringify({ sent: false });
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new WheelEvent('wheel', {
    clientX: r.left + 10, clientY: r.top + r.height / 2,
    deltaY: -240, bubbles: true, cancelable: true
  }));
  return JSON.stringify({ sent: true });
})()`;

/** A double-click on the same gutter. This is what "Fit" and "Reset view" retired into. */
const DOUBLE_CLICK_GUTTER = `(() => {
  const c = document.querySelector('.pianoroll');
  if (!c) return JSON.stringify({ sent: false });
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new MouseEvent('dblclick', {
    clientX: r.left + 10, clientY: r.top + r.height / 2, bubbles: true, cancelable: true
  }));
  return JSON.stringify({ sent: true });
})()`;

const WHEEL_ZOOM_IN = `(() => {
  const c = document.querySelector('.pianoroll');
  if (!c) return JSON.stringify({ sent: false });
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new WheelEvent('wheel', {
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    deltaY: -120, altKey: true, bubbles: true, cancelable: true
  }));
  return JSON.stringify({ sent: true });
})()`;

/**
 * A real drag of a rectangle on the piano roll, through the roll's own listeners.
 *
 * This is the check for "users should be able to edit piano roll midis and the changes should
 * reflect on music sheet/tab as well". It is deliberately a GESTURE rather than a call to the
 * edit function: what has to be true is that pressing on a rectangle and moving the mouse
 * changes the engraved sheet, and the whole chain — hit test, snap, the RollEdit, the
 * performance rewrite, the pipeline re-run, the re-engrave — sits between the two.
 *
 * `buttons: 1` on the moves is not optional: a move with no button held is treated as a
 * released gesture (which is what stops a swallowed pointerup wedging the roll), so without it
 * the drag ends before it begins.
 */
const dragRollNote = (dx, dy) => `(() => {
  const c = document.querySelector('.pianoroll');
  const rects = window.__RIFFSHEET_ROLLRECTS__ ? window.__RIFFSHEET_ROLLRECTS__() : null;
  const self = window.__RIFFSHEET_SELFTEST__ ? window.__RIFFSHEET_SELFTEST__() : null;
  if (!c || !Array.isArray(rects) || rects.length === 0 || !self || self.error) {
    return JSON.stringify({ dragged: false, reason: 'nothing to drag' });
  }
  // Wide enough that the middle is nowhere near the resize edge, and not the very first rect
  // (which can sit under the label gutter once the sheet is scrolled).
  const t = rects.filter((r) => r.noteId && r.w > 14 && r.x > 60).sort((a, b) => a.x - b.x)[0];
  if (!t) return JSON.stringify({ dragged: false, reason: 'no wide rect' });
  const r = c.getBoundingClientRect();
  const x0 = r.left + t.x + t.w / 2;
  const y0 = r.top + t.y + t.h / 2;
  const ev = (type, ex, ey, buttons) => new PointerEvent(type, {
    clientX: ex, clientY: ey, bubbles: true, cancelable: true,
    pointerId: 1, isPrimary: true, button: 0, buttons
  });
  c.dispatchEvent(ev('pointerdown', x0, y0, 1));
  window.dispatchEvent(ev('pointermove', x0 + ${dx} / 2, y0 + ${dy} / 2, 1));
  window.dispatchEvent(ev('pointermove', x0 + ${dx}, y0 + ${dy}, 1));
  window.dispatchEvent(ev('pointerup', x0 + ${dx}, y0 + ${dy}, 0));
  return JSON.stringify({
    dragged: true, noteId: t.noteId, dx: ${dx}, dy: ${dy},
    before: { midiBytes: self.midiQuantizedBytes, noteGlyphs: self.noteGlyphs, bars: self.bars }
  });
})()`;

/** The state a roll edit has to have changed, read the same way before and after. */
const SHEET_STATE = `(() => { try {
  const s = window.__RIFFSHEET_SELFTEST__ ? window.__RIFFSHEET_SELFTEST__() : null;
  const p = window.__RIFFSHEET_PIANOROLL__ ? window.__RIFFSHEET_PIANOROLL__() : null;
  if (!s || s.error) return JSON.stringify(null);
  // What is ENGRAVED, not what could be exported. MIDI byte length is the wrong fingerprint —
  // moving a note two semitones changes no event count and no variable-length encoding, so the
  // file comes out exactly 785 bytes either way and a real edit reads as no edit at all.
  // The fret digits and the note-name row are the sheet and the tab saying what they show.
  const digits = [...document.querySelectorAll('.at-host svg text')].map((t) => t.textContent).join('|');
  const names = [...document.querySelectorAll('.note-name')].map((t) => t.textContent).join('|');
  const hash = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };
  return JSON.stringify({
    midiBytes: s.midiQuantizedBytes, noteGlyphs: s.noteGlyphs, bars: s.bars,
    engraved: hash(digits), names: hash(names),
    rollNotes: p && p.roll ? p.roll.notes : null,
    firstMidi: p && p.roll ? p.roll.firstNoteMidi : null
  });
} catch (e) { return JSON.stringify(null); } })()`;

/** Escape, which clears a waveform selection and closes the tuner with it. */
const PRESS_ESCAPE = `(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  return JSON.stringify({ pressed: true });
})()`;

/** ⌘Z, as the window handler sees it. */
const PRESS_UNDO = `(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'z', metaKey: true, bubbles: true, cancelable: true
  }));
  return JSON.stringify({ pressed: true });
})()`;

/**
 * The pitch detector, measured rather than trusted.
 *
 * It runs synthesised sine and sawtooth tones at known frequencies — including the low notes a
 * bass actually plays, where plain autocorrelation famously reports the octave above — and
 * reports the error in cents. This is the one number the tuner's whole value rests on: a tuner
 * that is confidently wrong is worse than no tuner, because the player will believe it over
 * their own ears.
 */
const PITCH_SELFTEST = `(() => { try {
  return JSON.stringify(window.__RIFFSHEET_PITCH__ ? window.__RIFFSHEET_PITCH__() : null);
} catch (e) { return JSON.stringify({ error: String((e && e.stack) || e) }); } })()`;

/**
 * Click a moment on the waveform, the way a player would.
 *
 * The gesture starts in the BODY of the strip, below the handle lane — that separation is the
 * whole reason a fourth gesture could be added to a 46px strip at all, so starting the drag at
 * the wrong height is exactly what this needs to catch.
 */
/**
 * A REAL DRAG ON THE STRIP'S BODY (G8): down at one fraction of the plot, three moves, up.
 *
 * Three moves rather than one, because the strip ignores the first pointermove inside
 * `DRAG_SLOP_PX` — a drag proved by a single move would pass on a build that had lost the slop
 * guard and fail on one that had it. Delivered on the canvas for the reason `clickWaveform`
 * gives: a synthetic pointer cannot be captured, so the events have to land where the listeners
 * are. `fromPx` lets a second call aim at an EDGE of the span the first one made, which is the
 * adjust gesture.
 */
const dragWaveform = (fromFrac, toFrac, fromPx = null) => `(() => {
  const c = document.querySelector('.waveform');
  const p = window.__RIFFSHEET_WAVE__ ? window.__RIFFSHEET_WAVE__() : null;
  if (!c || !p) return JSON.stringify({ dragged: false });
  const r = c.getBoundingClientRect();
  const x = (f) => r.left + p.gutterPx + p.plotWidth * f;
  const y = r.top + p.handleLanePx + (r.height - p.handleLanePx) / 2;
  const ev = (type, ex, buttons) => new PointerEvent(type, {
    clientX: ex, clientY: y, bubbles: true, cancelable: true,
    pointerId: 1, isPrimary: true, button: 0, buttons
  });
  const startX = ${fromPx === null ? 'x(' + fromFrac + ')' : 'r.left + ' + fromPx};
  const endX = x(${toFrac});
  c.dispatchEvent(ev('pointerdown', startX, 1));
  for (const t of [0.34, 0.67, 1]) c.dispatchEvent(ev('pointermove', startX + (endX - startX) * t, 1));
  c.dispatchEvent(ev('pointerup', endX, 0));
  const after = window.__RIFFSHEET_WAVE__();
  const cut = document.querySelector('[data-role="cut-out"]');
  return JSON.stringify({
    dragged: true,
    selectArmed: after.selectArmed,
    selectionFromSec: after.selectionFromSec,
    selectionToSec: after.selectionToSec,
    selectionFromX: after.selectionFromX,
    selectionToX: after.selectionToX,
    spanSec: after.selectionFromSec === null || after.selectionToSec === null
      ? null : Number((after.selectionToSec - after.selectionFromSec).toFixed(3)),
    // THE THING THE PLAYER SEES, and the whole of the reported bug: it used to say 0.1s.
    cutLabel: cut ? cut.textContent.trim() : null,
    // The tuner is calibrated on a tenth of a second and must stay shut for a span.
    tunerOnScreen: !!document.querySelector('.tuner-host:not([hidden])')
  });
})()`;

/**
 * ARE THERE FULL-HEIGHT VERTICAL LINES IN THE BODY OF THE STRIP? (G16a)
 *
 * The reported "vertical lines in the waveform" were the viewport bracket's two 1px edge rails,
 * drawn the whole height of the body. They read as bar lines or as cut seams — neither of which
 * they are — and they move whenever the sheet is scrolled.
 *
 * Read off the PIXELS rather than off a flag, because "we deleted the fillRect" is exactly the
 * kind of claim that a later refactor restores by accident. A full-height rail has a property
 * nothing else in this strip has: every pixel down its column is bright, so the column's DIMMEST
 * pixel is bright. The envelope, the playhead and the dim wash all leave dark pixels somewhere
 * down any column they touch. So: the minimum luminance down the rail's own column, against the
 * same measure taken six pixels away, where there is certainly no rail.
 */
const BODY_RAILS = `(() => {
  const c = document.querySelector('.waveform');
  const p = window.__RIFFSHEET_WAVE__ ? window.__RIFFSHEET_WAVE__() : null;
  if (!c || !p) return JSON.stringify({ measured: false });
  if (p.overviewPx !== 0 || !p.hasViewport || p.viewportFromX === null) {
    return JSON.stringify({ measured: false, reason: 'no bracket on the body' });
  }
  const ctx = c.getContext('2d');
  const scale = c.width / (c.clientWidth || 1);
  const top = Math.round(p.overviewPx * scale);
  const h = c.height - top;
  if (!ctx || h < 8) return JSON.stringify({ measured: false, reason: 'nothing to sample' });
  const minDown = (cssX) => {
    const px = Math.round(cssX * scale);
    if (px < 1 || px >= c.width - 1) return null;
    const d = ctx.getImageData(px, top, 1, h).data;
    let min = 255 * 3;
    for (let i = 0; i < d.length; i += 4) min = Math.min(min, d[i] + d[i + 1] + d[i + 2]);
    return min;
  };
  return JSON.stringify({
    measured: true,
    railColumn: minDown(p.viewportFromX),
    // Six pixels in from the edge, which is inside the bright (undimmed) side of the bracket —
    // so if anything, this column is favoured over the rail's.
    neighbourColumn: minDown(p.viewportFromX + 6)
  });
})()`;

const clickWaveform = (atFrac) => `(() => {
  const c = document.querySelector('.waveform');
  const p = window.__RIFFSHEET_WAVE__ ? window.__RIFFSHEET_WAVE__() : null;
  if (!c || !p) return JSON.stringify({ clicked: false });
  const r = c.getBoundingClientRect();
  const x = (f) => r.left + p.gutterPx + p.plotWidth * f;
  // Below the handle lane: the lane owns the bar-1 flag and the viewport rail.
  const y = r.top + p.handleLanePx + (r.height - p.handleLanePx) / 2;
  const ev = (type, ex, buttons) => new PointerEvent(type, {
    clientX: ex, clientY: y, bubbles: true, cancelable: true,
    pointerId: 1, isPrimary: true, button: 0, buttons
  });
  // On the canvas, not on window: the strip listens on its own element and relies on pointer
  // capture to keep receiving moves once the pointer leaves it. A synthetic pointer cannot be
  // captured, so the events have to be delivered where the listeners actually are.
  // A CLICK, not a drag. Dragging out a range was removed: a long selection contains many notes
  // and "what pitch is in these four seconds" has no good answer, while "what is at this moment"
  // does. The property that mattered survives — you can still point at a stretch of audio where
  // nothing was written down, because you are pointing at the recording, not at a notehead.
  c.dispatchEvent(ev('pointerdown', x(${atFrac}), 1));
  c.dispatchEvent(ev('pointerup', x(${atFrac}), 0));
  const after = window.__RIFFSHEET_WAVE__();
  return JSON.stringify({
    clicked: true,
    selectionFromSec: after.selectionFromSec,
    selectionToSec: after.selectionToSec,
    // The host element is built on every main render and shown by clearing [hidden], so its
    // mere presence says nothing. ':not([hidden])' is the difference between "the tuner is on
    // screen" and "the app has a tuner".
    tunerOnScreen: !!document.querySelector('.tuner-host:not([hidden])'),
    probeWindowSec: after.probeWindowSec,
    sheetLinked: after.sheetLinked,
    tuner: window.__RIFFSHEET_TUNER__ ? window.__RIFFSHEET_TUNER__() : null
  });
})()`;

/** What the MIDI button would hand to the OS if it were dragged right now. */
const DRAG_PROBE = `(() => { try {
  return JSON.stringify(window.__RIFFSHEET_DRAGPROBE__ ? window.__RIFFSHEET_DRAGPROBE__() : null);
} catch (e) { return JSON.stringify({ error: String((e && e.stack) || e) }); } })()`;

/** Click the first rectangle the roll drew, and report what got selected on both views. */
const CLICK_FIRST_NOTE = `(() => {
  const c = document.querySelector('.pianoroll');
  const all = window.__RIFFSHEET_ROLLRECTS__ ? window.__RIFFSHEET_ROLLRECTS__() : null;
  const rects = Array.isArray(all) ? all.filter((r) => r.noteId && r.x > 40) : null;
  if (!c || !rects || rects.length === 0) return JSON.stringify({ clicked: false });
  const target = rects[0];
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: r.left + target.x + Math.max(1, target.w / 2),
    clientY: r.top + target.y + Math.max(1, target.h / 2),
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1
  }));
  c.dispatchEvent(new PointerEvent('pointerup', {
    clientX: r.left + target.x + Math.max(1, target.w / 2),
    clientY: r.top + target.y + Math.max(1, target.h / 2),
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 0
  }));
  const after = window.__RIFFSHEET_PIANOROLL__();
  return JSON.stringify({
    clicked: true,
    wantedId: target.noteId,
    rollSelection: after.roll.selection,
    sheetSelection: document.querySelectorAll('.triview-overlay .sel-rect').length
  });
})()`;

/** The gutter is a label column, not timeline: clicking it must not move the transport. */
const CLICK_GUTTER = `(() => {
  const c = document.querySelector('.pianoroll');
  if (!c) return JSON.stringify({ clicked: false });
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: r.left + 3, clientY: r.top + r.height / 2, bubbles: true, cancelable: true
  }));
  return JSON.stringify({ clicked: true });
})()`;

/**
 * A real drag of the pane's bottom edge: down, move, up, exactly as a mouse would.
 *
 * Driven through the handle's own listeners rather than by assigning a height, so a handle
 * that is not wired, or a drag that never commits, fails here rather than in the field.
 */
const dragRollEdge = (dy) => `(() => {
  const h = document.querySelector('[data-role="roll-resize"]');
  const pane = document.querySelector('.pianoroll-pane');
  if (!h || !pane) return JSON.stringify({ dragged: false });
  const before = Math.round(pane.getBoundingClientRect().height);
  const r = h.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const ev = (type, cy) => new PointerEvent(type, {
    clientX: x, clientY: cy, bubbles: true, cancelable: true,
    pointerId: 1, isPrimary: true, button: 0, buttons: 1
  });
  h.dispatchEvent(ev('pointerdown', y));
  window.dispatchEvent(ev('pointermove', y + ${dy}));
  window.dispatchEvent(ev('pointerup', y + ${dy}));
  return JSON.stringify({
    dragged: true, dy: ${dy}, before,
    after: Math.round(pane.getBoundingClientRect().height)
  });
})()`;

/** One real edit, through the real command path, measured on the roll. See ui/app.ts. */
/**
 * Tied notes: one note, several noteheads, ONE id.
 *
 * The reported bug, in the player's words: "sometimes I see same pitched notes repeating and
 * the first one of them is not clickable, the second one is... the tab note is under the
 * unclickable one... the one that actually makes the sound is not affecting the tab."
 *
 * All of that was one fault. A note held across a bar line is engraved as several noteheads
 * joined by ties, and the pipeline gives every one of them the same id on purpose. Webcore's
 * id -> note map was written once per notehead, so the LAST one won — and the last one is a tie
 * destination, which carries no fret digit by the rules of notation. So clicking the first
 * notehead resolved to the second, and edits landed on a glyph with no tab number under it.
 *
 * This asserts the shape directly rather than the symptom: a tied id must resolve to a chain,
 * the chain's FIRST member must be the one that owns the fret, and an edit must move all of them.
 */
const TIE_PROBE = `(() => { try {
  return JSON.stringify(window.__RIFFSHEET_TIES__ ? window.__RIFFSHEET_TIES__() : null);
} catch (e) { return JSON.stringify({ error: String((e && e.stack) || e) }); } })()`;

const EDIT_PROBE = `(() => { try {
  return JSON.stringify(window.__RIFFSHEET_EDITPROBE__ ? window.__RIFFSHEET_EDITPROBE__(2) : null);
} catch (e) { return JSON.stringify({ error: String((e && e.stack) || e) }); } })()`;

const CLICK_TOGGLE = `(() => {
  const b = document.querySelector('.pianoroll-toggle');
  if (!b) return JSON.stringify({ clicked: false });
  b.click();
  return JSON.stringify({ clicked: true });
})()`;

/**
 * Slack the names row must keep, in px.
 *
 * Below: the row stops short of the tab's top LINE, and fret digits are centred on that
 * line, so anything under ~6 is already touching a digit. Above: the row must simply not
 * enter the staff's own bottom overflow.
 */
const MIN_CLEAR_BELOW_TAB = 6;
const MIN_CLEAR_ABOVE_STAFF = 0;

async function main() {
  phase('checking build and starting local server', 15_000);
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('dist/index.html missing — run the build first.');
    process.exit(1);
  }
  const server = await serve();
  const chrome = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.CHROME_PATH
  ].filter(Boolean).find((p) => existsSync(p));
  if (!chrome) { console.error('No Chrome found'); process.exit(1); }

  const port = 9334;
  // A throwaway Chrome profile, DELETED on the way out. It used to be left behind: 99 of them
  // had piled up in the temp folder totalling 2.1 GB, one per run, because the name carried a
  // timestamp and nothing ever swept them. Kept unique so two runs cannot share one.
  const profileDir = join(tmpdir(), `riffsheet-verify-${process.pid}-${Date.now()}`);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required'
  ];
  if (!HEADFUL) args.push('--headless=new', '--disable-gpu');
  const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  let code = 0, cdp;
  const stepTimes = [];
  const errors = [];
  let chromeStderr = '';
  let chromeSpawnError = null;
  proc.stderr?.on('data', (chunk) => {
    chromeStderr = (chromeStderr + String(chunk)).slice(-16_000);
  });
  proc.once('error', (error) => {
    chromeSpawnError = error;
  });
  try {
    phase('connecting to Chrome', 25_000);
    const deadline = Date.now() + 20000;
    let list;
    for (;;) {
      try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; }
      catch { if (Date.now() > deadline) throw new Error('devtools never came up'); await new Promise(o => setTimeout(o, 150)); }
    }
    cdp = await Cdp.connect((list.find(t => t.type === 'page') ?? list[0]).webSocketDebuggerUrl);

    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') errors.push((p.args ?? []).map(a => a.value ?? a.description ?? '').join(' '));
    });
    cdp.on('Runtime.exceptionThrown', (p) =>
      errors.push(p.exceptionDetails?.exception?.description ?? JSON.stringify(p.exceptionDetails)));

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    /**
     * Poll a readiness expression under ONE budget.
     *
     * Every poll used to inherit `send`'s 45-second protocol default, so a readiness budget of
     * ten seconds still took forty-five to report anything: the loop deadline was checked
     * AFTER a call that outlived it. A wedged renderer never answers at all, which is exactly
     * the case the short budget exists for, so the per-call cap is what is left of the budget
     * rather than a constant. `timeout` on the evaluate itself is the other half — it lets V8
     * abandon an expression that did start running instead of holding the protocol open.
     */
    const waitForReady = async (label, expression, budgetMs) => {
      const until = Date.now() + budgetMs;
      for (;;) {
        const perCall = Math.max(250, until - Date.now());
        const r = await cdp.send(
          'Runtime.evaluate',
          { expression, returnByValue: true, timeout: perCall },
          perCall
        );
        if (r.result.value === true) return;
        if (Date.now() >= until) {
          throw new Error(`${label} did not become ready within ${(budgetMs / 1000).toFixed(1)}s`);
        }
        await new Promise((o) => setTimeout(o, 250));
      }
    };

    // The phase has to outlast the readiness budget it owns, or `requestBudget` clamps every
    // poll to the phase instead and the budget stops meaning anything.
    phase('loading the main demo', READY_TIMEOUT_MS + 10_000);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?${TARGET_QUERY}` });

    // Wait for the demo flag, then for alphaTab to have actually painted.
    await waitForReady('main page', READY_EXPRESSION, READY_TIMEOUT_MS);
    if (READINESS_ONLY) {
      console.log('[verify] readiness-only probe passed');
      return;
    }
    await new Promise(o => setTimeout(o, 700));

    // WHERE THE TIME GOES.
    //
    // The run had grown to several minutes and nobody knew which part was expensive — only about
    // 15 seconds of it is deliberate waiting, so the rest was invisible. Every call is timed and
    // the worst are printed at the end, so making this faster becomes an informed decision rather
    // than a guess. It costs one clock read either side of a call that was already crossing the
    // debugger protocol.
    const evalJson = async (expression, timeout) => {
      const started = Date.now();
      const r = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true, ...(timeout ? { timeout } : {})
      }, timeout ?? 45_000);
      // The first line of the snippet is enough to recognise it, and short enough to print.
      stepTimes.push([Date.now() - started, String(expression).trim().split('\n')[0].slice(0, 64)]);
      if (r.exceptionDetails) {
        throw new Error(
          r.exceptionDetails.exception?.description ??
            r.exceptionDetails.text ??
            `page evaluation failed during ${activePhase.name}`
        );
      }
      if (r.result.value === undefined || r.result.value === null) return null;
      try {
        return JSON.parse(r.result.value);
      } catch (error) {
        throw new Error(
          `${activePhase.name}: probe returned invalid JSON (${String(r.result.value).slice(0, 160)}): ${error}`
        );
      }
    };
    const settle = (ms) => new Promise((o) => setTimeout(o, ms));

    /** One viewport: re-measure the layout and the roll, and keep a screenshot. */
    const atViewport = async (width, height, file) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await settle(900);
      const out = { layout: await evalJson(LAYOUT), roll: await evalJson(ROLL) };
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await mkdir(join(ROOT, 'spike-results'), { recursive: true });
      await writeFile(join(ROOT, 'spike-results', file), Buffer.from(shot.data, 'base64'));
      return out;
    };

    phase('measuring the initial UI', 35_000);
    const probe = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const result = JSON.parse(probe.result.value);
    // `result.layout` is PROBE's DOM geometry; `namesLayout` is the tri-view's own
    // measurement of the names row. Two different things, deliberately two keys.
    result.namesLayout = await evalJson(LAYOUT);
    result.roll = await evalJson(ROLL);

    phase('checking PDF and sound exports', 150_000);
    console.log('[verify]   print document');
    const pdf = await cdp.send('Runtime.evaluate', {
      expression: `window.__RIFFSHEET_PDFTEST__ ? window.__RIFFSHEET_PDFTEST__().then(r => JSON.stringify(r)) : Promise.resolve('null')`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 90000
    }, 90_000);
    result.pdf = JSON.parse(pdf.result.value ?? 'null');

    // The bytes the PDF button actually writes in the plugin, where window.print() is dead.
    console.log('[verify]   PDF bytes');
    const pdfBytes = await cdp.send('Runtime.evaluate', {
      expression: `window.__RIFFSHEET_PDFBYTES__ ? window.__RIFFSHEET_PDFBYTES__().then(r => JSON.stringify(r)) : Promise.resolve('null')`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 120000
    }, 120_000);
    result.pdfBytes = JSON.parse(pdfBytes.result.value ?? 'null');

    // Sound sources: the sampled bass loads, and a missing set degrades rather than throws.
    console.log('[verify]   sampled sound loading');
    const sound = await cdp.send('Runtime.evaluate', {
      expression: `window.__RIFFSHEET_SOUND__ ? window.__RIFFSHEET_SOUND__().then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) })) : Promise.resolve('null')`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 60000
    }, 60_000);
    result.sound = JSON.parse(sound.result.value ?? 'null');

    // The MIDI menu, driven for real with the save stubbed. `cancelled` is the regression
    // test for the reported bug: a dismissed save panel must produce NO toast.
    const runProbe = async (label, saved) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `window.__RIFFSHEET_EXPORTPROBE__ ? window.__RIFFSHEET_EXPORTPROBE__(${JSON.stringify(
          label
        )}, ${saved}).then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) })) : Promise.resolve('null')`,
        awaitPromise: true,
        returnByValue: true,
        timeout: 30000
      });
      return JSON.parse(r.result.value ?? 'null');
    };
    console.log('[verify]   MIDI export menu');
    result.midiMenu = {
      quantized: await runProbe('Quantized', true),
      both: await runProbe('Both', true),
      cancelled: await runProbe('As played', false)
    };
    // Whatever the probes left behind, so a stray toast cannot leak into later checks.
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.toast button').forEach(b => b.click())`,
      returnByValue: true
    });

    // Responsive floor: 900x600, plus the mid size a user actually drags an FX window to.
    // Check nothing overflows horizontally and the chrome is all still on screen — a user
    // hit clipping here in field testing — and re-measure the names row at each size,
    // because the staff/tab gap is engraved geometry and re-engraves on every resize.
    const OVERFLOW = `(() => {
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
        const b = e.getBoundingClientRect();
        return { right: Math.round(b.right), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
      const btns = [...document.querySelectorAll('.app-header button')].map(b => Math.round(b.getBoundingClientRect().right));
      return JSON.stringify({
        // PROPORTIONAL, NOT WRAPPED (#11). Two numbers say whether the shell scaled or
        // re-flowed: the zoom actually in force, and how many ROWS the header came out as
        // (distinct top edges among its children — wrapping is what pushes that above one).
        appZoom: Number(getComputedStyle(document.querySelector('#app')).zoom) || 1,
        // COUNTED OFF CENTRES, NOT TOPS, and that correction is the whole of what this number
        // is worth. The header centre-aligns its items, so a 19px filename, a 24px chip group,
        // a 27px chip, a 30px button and a 32px gear all have DIFFERENT top edges while sitting
        // on the same line — and a zero-height spacer has one of its own. Counting tops
        // therefore reported four or five "rows" for a header that had never wrapped in its
        // life, which made the check below unfalsifiable in the direction that mattered: it was
        // already at its limit before anything went wrong. Centre-aligned items on one line
        // share a centre exactly; a wrapped line's centre is a whole row away. Bucketed at 4px
        // so sub-pixel layout noise cannot split a row in two.
        headerRows: new Set(
          [...document.querySelectorAll('.app-header > *')]
            .map((e) => { const b = e.getBoundingClientRect(); return Math.round((b.top + b.height / 2) / 4); })
        ).size,
        /*
         * THE SAME MEASURE FOR THE TRANSPORT (G4). The tempo source has been a child of this row
         * since F19, but the row wrapped, so at any plugin width it fell onto a line of its own
         * — three bands of chrome between the roll and the sheet where the design says two.
         * Counted off centres for exactly the reasons headerRows is; the transport
         * centre-aligns its items too, and a 20px readout, a 26px chip and a 30px button on one
         * line have three different top edges.
         */
        transportRows: new Set(
          [...document.querySelectorAll('.transport > *')]
            .map((e) => { const b = e.getBoundingClientRect(); return Math.round((b.top + b.height / 2) / 4); })
        ).size,
        bodyScrollW: document.body.scrollWidth, innerW: window.innerWidth,
        docScrollW: document.documentElement.scrollWidth,
        header: r('.app-header'), transport: r('.transport'), triview: r('.triview'),
        roll: r('.pianoroll-pane'), wave: r('.waveform'),
        maxHeaderButtonRight: btns.length ? Math.max(...btns) : 0,
        names: document.querySelectorAll('.note-name').length,
        svg: document.querySelectorAll('.at-host svg').length
      });
    })()`;

    /**
     * CAN A HUMAN ACTUALLY PRESS IT?
     *
     * Two ways to be unreachable and both have shipped from this repo:
     *
     *  - outside the window entirely;
     *  - inside a scroller whose scrollbar is switched off in CSS. `.notation-toolbar` and
     *    `.view-tools` were both `overflow-x: auto; scrollbar-width: none`, and when Key and
     *    Capo were added to the notation bar, Capo came to rest 39px past the right edge at
     *    900x600 with nothing on screen admitting it was there. It was reported, correctly,
     *    as the button having disappeared.
     *
     * So `clipped` counts as unreachable exactly like `outside` does: "scroll it into view" is
     * not an instruction anybody can follow when there is no scrollbar to see. Both toolbars
     * wrap now, and this is what keeps them wrapping.
     *
     * `linkControl` used to be the one control called out by name, because it had been deleted
     * from this UI once already. It is deleted for good now (G11) and the probe reports its
     * ABSENCE at every size instead — the claim has flipped, so the probe reads the same
     * selector and the checks below assert null rather than an on-screen box.
     */
    const REACH = `(() => {
      const scopes = ['.app-header', '[data-role="notation-toolbar"]', '.view-tools'];
      const bad = [];
      for (const scope of scopes) {
        for (const host of document.querySelectorAll(scope)) {
          for (const e of host.querySelectorAll('button, select, input, [role="switch"]')) {
            const cs = getComputedStyle(e);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const r = e.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            let clipped = null;
            for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
              const ps = getComputedStyle(p);
              if (!/auto|scroll|hidden/.test(ps.overflowX) && !/auto|scroll|hidden/.test(ps.overflowY)) continue;
              const pr = p.getBoundingClientRect();
              if (r.right > pr.right + 1 || r.left < pr.left - 1) { clipped = String(p.className || p.tagName); break; }
            }
            const outside = r.right > window.innerWidth + 1 || r.left < -1;
            if (clipped || outside) {
              bad.push({
                what: e.getAttribute('data-role') || e.getAttribute('aria-label') ||
                  e.textContent.trim().slice(0, 24) || e.tagName,
                scope, right: Math.round(r.right), clipped, outside
              });
            }
          }
        }
      }
      const link = document.querySelector('[data-role="roll-link"]');
      const lr = link ? link.getBoundingClientRect() : null;
      // The zoom captions are measured at every size for the same reason the chips are: G7's
      // whole claim is that they are LEGIBLE at a plugin's floor, and a caption that has been
      // shrunk to nothing or clipped away is not.
      const axes = [...document.querySelectorAll('.zoom-pair [data-role$="zoom-label"]')].map((e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return {
          text: e.textContent.trim(),
          w: Math.round(r.width),
          fontPx: Math.round(parseFloat(cs.fontSize) * 10) / 10,
          onScreen: r.width > 0 && r.left >= -1 && r.right <= window.innerWidth + 1
        };
      });
      return JSON.stringify({
        offScreen: bad,
        zoomAxes: axes,
        linkControl: link ? {
          text: link.textContent.trim(),
          setting: link.getAttribute('data-setting'),
          pressed: link.getAttribute('aria-pressed'),
          w: Math.round(lr.width), h: Math.round(lr.height),
          onScreen: lr.width > 0 && lr.height > 0 && lr.left >= -1 && lr.top >= -1 &&
            lr.right <= window.innerWidth + 1 && lr.bottom <= window.innerHeight + 1
        } : null
      });
    })()`;

    phase('checking responsive layouts', 40_000);
    for (const [w, h, key, file] of [
      [900, 600, 'narrow', 'app-900x600.png'],
      [1100, 700, 'mid', 'app-1100x700.png'],
      // REAPER's floor. An FX window can be dragged this small, and everything on the chrome
      // still has to be pressable there — see REACH.
      [360, 280, 'floor', 'app-360x280.png']
    ]) {
      const view = await atViewport(w, h, file);
      view.overflow = await evalJson(OVERFLOW);
      result[key] = { ...view.overflow, layout: view.layout, roll: view.roll };
      result[key].reach = await evalJson(REACH);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await new Promise((o) => setTimeout(o, 700));
    // The wide layout has been re-engraved twice by now; re-measure it rather than trust
    // the reading taken before the resizes.
    result.namesLayout = await evalJson(LAYOUT);
    result.roll = await evalJson(ROLL);
    result.timebase = await evalJson(TIMEBASE);
    // Nudges one note and puts it back through the ordinary undo path, so it sits here rather
    // than at the end: everything after it runs against the same take it would have anyway,
    // and `timebaseAfterPlayback` is what proves that.
    result.playbackTiming = await evalJson(PLAYBACK_TIMING);
    result.timebaseAfterPlayback = await evalJson(TIMEBASE);

    const selfTest = await cdp.send('Runtime.evaluate', {
      expression: SELFTEST,
      returnByValue: true
    });
    result.selfTest = selfTest.result.value ? JSON.parse(selfTest.result.value) : { evaluateFailed: JSON.stringify(selfTest) };

    await mkdir(join(ROOT, 'spike-results'), { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(ROOT, 'spike-results', 'app.png'), Buffer.from(shot.data, 'base64'));

    // 60s until the grid-split probe joined this phase: it drives four export-building
    // self-tests and two full notation rebuilds through the real controls.
    phase('checking selection, rulers and zoom', 90_000);
    // The roll and waveform now use a stable DAW-style time ruler. Engraving spacing must
    // never widen an audio gap merely because a note was added to the score.
    result.rollLinear = await evalJson(ROLL);

    // ...and the resize handle must be visible without hovering it (item 7).
    result.rollHandleAffordance = await evalJson(RESIZE_AFFORDANCE);

    // Clicking a rectangle selects THAT note, on the roll and on the sheet, and nothing else
    // changes colour. The old behaviour tinted every note before the playhead orange.
    result.rollNoteClick = await evalJson(CLICK_FIRST_NOTE);
    await settle(300);

    // --- piano roll: click-to-seek ---------------------------------------------------
    // Clicking the roll must move the ONE transport everything else follows, not a private
    // cursor of its own. Reading the position back is what proves it.
    //
    result.rollFreeMode = await evalJson(ROLL);
    const seekFrac = 0.5;
    result.rollClick = await evalJson(clickRoll(seekFrac));
    await settle(400);
    const afterClick = await evalJson(ROLL);
    result.rollAfterClick = {
      positionSec: afterClick?.positionSec ?? null,
      wantSec: result.rollClick?.wantSec ?? null
    };

    // The gutter belongs to the labels. A click there used to be impossible; now it must be
    // ignored rather than silently meaning "seek to zero".
    result.rollGutterClick = await evalJson(CLICK_GUTTER);
    await settle(400);
    result.rollAfterGutterClick = (await evalJson(ROLL))?.positionSec ?? null;

    // ONE RULER, proven end to end: the same x on either strip must mean the same second.
    // Comparing the two constants would only prove they were copied; comparing what the two
    // click handlers DO catches a gutter that one strip reserves and the other does not.
    const sharedX = 700;
    await evalJson(clickAtPx('.pianoroll', sharedX));
    await settle(350);
    const rollSeek = (await evalJson(ROLL))?.positionSec ?? null;
    await evalJson(clickAtPx('.waveform', sharedX));
    await settle(350);
    const waveSeek = (await evalJson(ROLL))?.positionSec ?? null;
    // The two rulers, read at one instant. See the check that consumes this.
    const rollNow = await evalJson(ROLL);
    const waveNow = await evalJson(WAVE_PROBE);
    result.sharedRuler = {
      x: sharedX,
      rollSeek,
      waveSeek,
      rollMidSec: rollNow?.roll?.midPlotSec ?? null,
      waveMidSec: waveNow?.midPlotSec ?? null,
      rollWindow: rollNow?.roll?.windowFromSec ?? null,
      waveWindow: waveNow?.windowFromSec ?? null
    };

    // "Reset view" must put the pitch view back after a roll zoom. Horizontal time remains
    // linear throughout and is deliberately independent of engraving zoom.
    result.zoomBefore = (await evalJson(ROLL))?.roll ?? null;
    await evalJson(WHEEL_ZOOM_IN);
    await settle(600);
    result.zoomAfterWheel = (await evalJson(ROLL))?.roll ?? null;
    // NO MODIFIER. A plain wheel over the GUTTER — the pitch ruler — zooms it; the same wheel
    // over the notes still scrolls. Nothing to hold down and nothing to have been told.
    await evalJson(WHEEL_OVER_GUTTER);
    await settle(600);
    result.zoomAfterGutterWheel = (await evalJson(ROLL))?.roll ?? null;
    // ...and a double-click on that same ruler fits, which is what the retired chips did.
    await evalJson(DOUBLE_CLICK_GUTTER);
    await settle(700);
    result.zoomAfterReset = (await evalJson(ROLL))?.roll ?? null;
    // The visible control, for anyone without a wheel or a trackpad.
    result.zoomButtons = await evalJson(`JSON.stringify({
      inButton: !!document.querySelector('[data-role="roll-zoom-in"]'),
      outButton: !!document.querySelector('[data-role="roll-zoom-out"]'),
      retiredFit: !!document.querySelector('[data-role="roll-fit"]'),
      retiredReset: !!document.querySelector('[data-role="roll-reset"]')
    })`);
    const beforeButtonZoom = (await evalJson(ROLL))?.roll?.pxPerSemitone ?? null;
    await evalJson(clickRole('roll-zoom-in'));
    await settle(400);
    result.zoomAfterButton = {
      before: beforeButtonZoom,
      after: (await evalJson(ROLL))?.roll?.pxPerSemitone ?? null
    };

    // What the MIDI button would drag. A real OS drag cannot be synthesised from a page, so
    // the wiring is checked by asking what it holds rather than by dropping it anywhere.
    result.dragProbe = await evalJson(DRAG_PROBE);
    result.ties = await evalJson(TIE_PROBE);

    // --- #36/#41: the Quantize menu writes the SHEET and nothing else -------------------
    // The probe walks the menu through four values and dumps, at each one, what the roll is
    // drawing and what the synth would play. It puts every setting back before it returns, so
    // it is safe to run in the middle of the take everything below is still looking at.
    result.snapFeed = await evalJson(
      `JSON.stringify(window.__RIFFSHEET_SNAPFEED__ ? window.__RIFFSHEET_SNAPFEED__() : null)`
    );
    await settle(600);

    // --- the two grids are actually two ------------------------------------------------
    // Driven through the real controls, because the whole failure being guarded against was
    // a UI wire: one <select> that reached both the roll and the quantizer.
    result.gridBefore = await evalJson(SELFTEST);
    result.rollGridBefore = (await evalJson(ROLL))?.roll ?? null;
    await evalJson(setSelect('roll-grid', 'quarter'));
    await settle(400);
    result.rollGridAfter = (await evalJson(ROLL))?.roll ?? null;
    result.gridAfterRollChange = await evalJson(SELFTEST);
    await evalJson(setSelect('roll-grid', 'eighth'));
    await settle(400);
    // And the other half: the NOTATION grid must still reach the pipeline. A split that made
    // both controls inert would pass every check above.
    await evalJson(setSelect('notation-grid', 'quarter'));
    await settle(900);
    result.gridAfterNotationChange = await evalJson(SELFTEST);
    // BACK TO 'auto', WHICH IS THE DEFAULT AGAIN under settings v11 (it was 'free' under v10).
    // `gridBefore` was measured with whatever the app opens on, so restoring to a value that is
    // no longer that one compares two different settings and calls the difference a regression.
    await evalJson(setSelect('notation-grid', 'auto'));
    await settle(900);
    result.gridRestored = await evalJson(SELFTEST);

    phase('checking tuner and editing gestures', 75_000);
    // --- the tuner ---------------------------------------------------------------------
    // The pitch detector, measured here rather than on the machine it was written on.
    result.pitchSelfTest = await evalJson(PITCH_SELFTEST);
    // And the gesture that reaches it: click the waveform BODY (not the overview ribbon) and
    // the tuner must appear on that moment. The demo fixture has no real recording
    // behind it, so the tuner will correctly say it has no audio — what is under test here is
    // the selection and the wiring, not the analysis.
    result.waveSelect = await evalJson(clickWaveform(0.38));
    await settle(500);
    // Halved in this round, and the way out moved to the far right edge. Measured off the
    // panel's own box rather than off the stylesheet, and `contentFits` is the half that stops
    // "half the height" being achieved with `overflow: hidden`.
    result.tunerBox = await evalJson(`JSON.stringify(window.__RIFFSHEET_TUNER__ ? window.__RIFFSHEET_TUNER__() : null)`);
    // The same panel in REAPER's smallest docked window. It has to survive that too.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 360, height: 280, deviceScaleFactor: 1, mobile: false
    });
    await settle(600);
    result.tunerBoxNarrow = await evalJson(`JSON.stringify(window.__RIFFSHEET_TUNER__ ? window.__RIFFSHEET_TUNER__() : null)`);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900, height: 600, deviceScaleFactor: 1, mobile: false
    });
    await settle(600);
    result.tunerBoxMid = await evalJson(`JSON.stringify(window.__RIFFSHEET_TUNER__ ? window.__RIFFSHEET_TUNER__() : null)`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await settle(600);
    // The mouse path, which is the primary one — the player runs this inside REAPER, which
    // eats most keystrokes before the plugin sees them. Pressed for real, on the button.
    result.tunerCloseClick = await evalJson(`(() => {
      const b = document.querySelector('[data-role="tuner-close"]');
      if (!b) return JSON.stringify({ found: false });
      b.click();
      return JSON.stringify({ found: true, onScreen: !!document.querySelector('.tuner-host:not([hidden])') });
    })()`);
    await settle(400);
    // ...and then open it again, because everything below expects the tuner to be up.
    result.waveSelect = await evalJson(clickWaveform(0.38));
    await settle(500);
    // The tuner is a whole extra band on screen. While it is up, the roll must give some of its
    // height back — otherwise the sheet is what pays, which is the failure the roll's clamp
    // exists to prevent, arriving through a door it did not know about.
    result.rollWithTuner = await evalJson(ROLL);
    // Then put the window back. Everything after this measures the roll at its normal size, and
    // a tuner left open would quietly cap every one of those readings.
    await evalJson(PRESS_ESCAPE);
    await settle(500);
    result.tunerClosed = await evalJson(`JSON.stringify({
      onScreen: !!document.querySelector('.tuner-host:not([hidden])'),
      selection: window.__RIFFSHEET_WAVE__ ? window.__RIFFSHEET_WAVE__().selectionFromSec : null
    })`);

    // --- G8: cutting a span you actually chose -----------------------------------------
    //
    // The reported fault: "Cut out 0.1s". The strip's only selection was the tuner's fixed
    // probe window, so the Cut button could never offer anything else — there was no gesture
    // anywhere in the app that could name a longer stretch. The mode, the drag, the edge
    // adjust and the way back are all driven here, and NOTHING IS CUT: the label is what was
    // broken, and committing would leave every check below reading a shortened take.
    result.cutArmBefore = await evalJson(`JSON.stringify((() => {
      const b = document.querySelector('[data-role="cut-arm"]');
      const w = window.__RIFFSHEET_WAVE__ ? window.__RIFFSHEET_WAVE__() : null;
      return {
        present: !!b,
        pressed: b ? b.getAttribute('aria-pressed') : null,
        armed: w ? w.selectArmed : null
      };
    })())`);
    // UNARMED FIRST: a drag on the strip must still be a click, and still produce the tuner's
    // fixed window. The mode is what makes the span safe to add; without this the check below
    // would pass just as well on a build that had made every drag a span.
    result.cutDragUnarmed = await evalJson(dragWaveform(0.30, 0.62));
    await settle(400);
    await evalJson(PRESS_ESCAPE);
    await settle(300);
    result.cutArmClick = await evalJson(clickRole('cut-arm'));
    await settle(400);
    result.cutDragArmed = await evalJson(dragWaveform(0.30, 0.62));
    await settle(500);
    // AND THE EDGE IS A HANDLE. Take hold of the span's left edge and pull it back to 0.12: the
    // span must GROW from the edge that was grabbed, with the other end pinned.
    result.cutDragEdge = await evalJson(
      dragWaveform(0, 0.12, '(window.__RIFFSHEET_WAVE__().selectionFromX)')
    );
    await settle(500);
    // THE VERTICAL LINES (G16a), measured on the pixels while the bracket is on the body.
    result.bodyRails = await evalJson(BODY_RAILS);
    // …and the way out. Disarm, and the strip goes back to answering "what is at this moment".
    result.cutDisarmClick = await evalJson(clickRole('cut-arm'));
    await settle(400);
    result.cutAfterDisarm = await evalJson(clickWaveform(0.38));
    await settle(500);
    await evalJson(PRESS_ESCAPE);
    await settle(400);

    // --- editing the piano roll changes the sheet -------------------------------------
    // "users should be able to edit piano roll midis and the changes should reflect on music
    // sheet/tab as well." Drag one rectangle up in pitch, through the roll's own listeners,
    // and read the ENGRAVED sheet back — the MIDI bytes come from the pipeline's writer, so
    // they cannot change unless the notation really did.
    result.rollEditBefore = await evalJson(SHEET_STATE);
    result.rollEditDrag = await evalJson(dragRollNote(0, -14));
    await settle(900);
    result.rollEditAfter = await evalJson(SHEET_STATE);
    await evalJson(PRESS_UNDO);
    await settle(900);
    result.rollEditUndone = await evalJson(SHEET_STATE);

    await evalJson(CLICK_TOGGLE);
    await settle(900);
    result.rollOff = await evalJson(ROLL);
    await evalJson(CLICK_TOGGLE);
    await settle(900);
    result.rollBackOn = await evalJson(ROLL);

    // --- edit sync: change a pitch on the sheet, watch the roll ---------------------
    // The reported bug. The roll drew the pipeline's IR, which an edit never touches, so a
    // note changed pitch on the sheet and the rectangle stayed exactly where it was. A
    // screenshot cannot catch that — the pane looks fine, it is just a picture of the
    // previous score — so this drives the real command path and measures the rectangle.
    result.editSync = await evalJson(EDIT_PROBE);
    await settle(500);

    // --- the pane's height belongs to the player -------------------------------------
    // A real drag of the bottom edge, then the two limits, then the short state is left in
    // place so the NEXT page load can prove it was remembered.
    //
    // Measured on an UNLOCKED view. "Fit" is a command that deliberately keeps the whole take
    // on screen across a resize — the row height is what gives, by design (view/pianoroll.ts,
    // invariant 10) — and the zoom block above ends by pressing Reset view, which takes that
    // lock. One zoom notch drops it, so what follows measures the ordinary behaviour a player
    // who never pressed Fit would see: a taller pane shows MORE ROWS at the same row height.
    await evalJson(WHEEL_ZOOM_IN);
    await settle(400);
    result.rollResizeBase = await evalJson(ROLL);
    result.rollDragDown = await evalJson(dragRollEdge(90));
    await settle(500);
    result.rollTall = await evalJson(ROLL);
    const tallShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(ROOT, 'spike-results', 'app-roll-tall.png'), Buffer.from(tallShot.data, 'base64'));

    // Past the ceiling: 40% of the window, and never eating the sheet.
    result.rollDragHuge = await evalJson(dragRollEdge(2000));
    await settle(400);
    result.rollHuge = await evalJson(ROLL);

    // ...and past the floor, which is where the labels have the least room.
    result.rollDragUp = await evalJson(dragRollEdge(-2000));
    await settle(500);
    result.rollShort = await evalJson(ROLL);
    const shortShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(ROOT, 'spike-results', 'app-roll-short.png'), Buffer.from(shortShot.data, 'base64'));

    // --- names off: the reserved gap must close, and re-open ------------------------
    // The staff<->tab padding exists only to hold the names row, so switching the row off
    // re-engraves with a smaller gap. That is a live `updateSettings()` + `render()` on a
    // loaded score, which is exactly the sort of thing that throws.
    const NAMES_SWITCH = `(() => {
      const row = [...document.querySelectorAll('.settings-panel label.switch')]
        .find((l) => (l.textContent || '').includes('Show note names'));
      const box = row && row.querySelector('input');
      if (!box) return JSON.stringify({ clicked: false });
      box.click();
      return JSON.stringify({ clicked: true, checked: box.checked });
    })()`;
    result.namesOffClick = await evalJson(NAMES_SWITCH);
    await settle(900);
    result.namesOff = await evalJson(LAYOUT);
    await evalJson(NAMES_SWITCH);
    await settle(900);
    result.namesBackOn = await evalJson(LAYOUT);

    // --- engine setup: guide and find ------------------------------------------------
    //
    // The screen somebody with NO engine installed is looking at, which is exactly why it
    // cannot be left to be discovered in the plugin: the browser mock reports the same shape
    // of status as the shell does, so the whole thing renders and can be driven here.
    //
    // What is asserted is what a stranded player needs, in order: it says whether an engine
    // was found, it lists the places actually searched (the "not found at <path nobody has>"
    // bug), it can look again live, and it shows the engine.json path a custom install has to
    // be written into. The steps are asserted to be steps rather than a paragraph.
    phase('checking the engine setup screen', 40_000);
    result.engineSetupOpen = await evalJson(`(() => {
      const gear = [...document.querySelectorAll('.app-header button')]
        .find((b) => b.getAttribute('data-role') === 'settings-gear');
      if (!gear) return JSON.stringify({ clicked: false });
      gear.click();
      return JSON.stringify({ clicked: true });
    })()`);
    // The panel asks the shell the moment it opens; one poll interval is plenty.
    await settle(1200);

    const ENGINE_SETUP = `(() => {
      const panel = document.querySelector('.settings-panel');
      const status = document.querySelector('[data-role="engine-setup-status"]');
      const steps = [...document.querySelectorAll('[data-role="engine-setup-steps"] > li')]
        .map((li) => (li.textContent || '').trim());
      const toggle = document.querySelector('[data-role="engine-setup-searched-toggle"]');
      const paths = [...document.querySelectorAll('[data-role="engine-setup-searched"] > li')]
        .map((li) => (li.textContent || '').trim());
      const config = document.querySelector('[data-role="engine-config-path"]');
      const recheck = document.querySelector('[data-role="engine-recheck"]');
      const said = document.querySelector('[data-role="engine-recheck-said"]');
      const policy = document.querySelector('[data-role="engine-setup-policy"]');
      const guideToggle = document.querySelector('[data-role="engine-guide-toggle"]');
      return JSON.stringify({
        hasGuideToggle: !!guideToggle,
        guideToggleText: guideToggle ? (guideToggle.textContent || '').trim() : null,
        panelOpen: !!panel && panel.style.display !== 'none',
        group: !!document.querySelector('[data-role="engine-setup-group"]'),
        status: status ? (status.textContent || '').trim() : null,
        policy: policy ? (policy.textContent || '').trim() : null,
        steps,
        hasToggle: !!toggle,
        toggleText: toggle ? (toggle.textContent || '').trim() : null,
        paths,
        configPath: config ? (config.textContent || '').trim() : null,
        hasRecheck: !!recheck,
        recheckText: recheck ? (recheck.textContent || '').trim() : null,
        said: said ? (said.textContent || '').trim() : null
      });
    })()`;

    // WITH THE ENGINE FOUND. The mock's machine has MuScriptor on it, and the card must
    // therefore carry NO guide at all — not a collapsed one, none. Instructions for installing
    // something that is installed are the clearest possible sign the app has not noticed.
    result.engineSetupInstalled = await evalJson(ENGINE_SETUP);

    // WITH THE ENGINE MISSING. The other half of the same card, and the state everything below
    // is about: a folded guide behind one button, and the whole of the old setup screen behind
    // that. `__RIFFSHEET_MOCKENGINE__` is a mock-only switch (see bridge/mock.ts); on a real
    // machine this is what the filesystem says.
    result.engineSetupUninstall = await evalJson(`(() => {
      if (!window.__RIFFSHEET_MOCKENGINE__) return JSON.stringify({ switched: false });
      window.__RIFFSHEET_MOCKENGINE__(false);
      return JSON.stringify({ switched: true });
    })()`);
    await settle(2400);
    result.engineSetupFolded = await evalJson(ENGINE_SETUP);

    // Unfold it, and everything the guide has always promised has to still be there.
    result.engineGuideClick = await evalJson(clickRole('engine-guide-toggle'));
    await settle(400);
    result.engineSetup = await evalJson(ENGINE_SETUP);

    // The searched list is collapsed until asked for — open it and count what is really there.
    result.engineSetupExpand = await evalJson(`(() => {
      const t = document.querySelector('[data-role="engine-setup-searched-toggle"]');
      if (!t) return JSON.stringify({ clicked: false });
      t.click();
      return JSON.stringify({ clicked: true });
    })()`);
    await settle(300);
    result.engineSetupOpened = await evalJson(ENGINE_SETUP);

    // Check again has to actually go and ask, and say what came back.
    result.engineRecheckClick = await evalJson(`(() => {
      const b = document.querySelector('[data-role="engine-recheck"]');
      if (!b) return JSON.stringify({ clicked: false });
      b.click();
      return JSON.stringify({ clicked: true });
    })()`);
    await settle(900);
    result.engineRechecked = await evalJson(ENGINE_SETUP);

    // Put MuScriptor back on the pretend machine. Everything below this line — the cards, the
    // picker, the layout measurements — is written against the mock's ordinary world, and a
    // switch left flipped would quietly change what those are testing.
    result.engineSetupRestore = await evalJson(`(() => {
      if (!window.__RIFFSHEET_MOCKENGINE__) return JSON.stringify({ switched: false });
      window.__RIFFSHEET_MOCKENGINE__(true);
      return JSON.stringify({ switched: true });
    })()`);
    await settle(2400);

    // --- the engine picker: cards, a real install, and a choice that sticks -----------
    //
    // The setup screen is a LIST of engines now, one card each, and MuScriptor's card is the
    // whole of the old screen moved inside it. So everything above still applies and these
    // add the things a picker has to get right: that each card says what its engine is
    // actually good at, that only the engines whose licence permits it offer an Install
    // button, that pressing Install shows work happening and then says how it ended, and that
    // a choice survives the panel being closed.
    //
    // Driven against the browser mock, which is the executable version of the bridge contract
    // — the shell answers the same shapes, so the same checks stand against the real thing.
    phase('checking the engine cards and one-click install', 90_000);

    /** Every card, read the way somebody scanning the screen reads them. */
    const ENGINE_CARDS = `(() => {
      const text = (root, sel) => {
        const e = root.querySelector(sel);
        return e ? (e.textContent || '').trim() : null;
      };
      const cards = [...document.querySelectorAll('[data-role="engine-card"]')].map((c) => {
        const use = c.querySelector('[data-role="engine-use"]');
        return {
          id: c.getAttribute('data-engine-id'),
          install: c.getAttribute('data-engine-install'),
          state: c.getAttribute('data-engine-state'),
          inCharge: c.classList.contains('on'),
          name: text(c, '.engine-name'),
          tier: text(c, '[data-role="engine-card-tier"]'),
          strengths: text(c, '[data-role="engine-card-strengths"]'),
          status: text(c, '[data-role="engine-card-state"], [data-role="engine-setup-status"]'),
          hasUse: !!use,
          usePressed: !!use && use.getAttribute('aria-pressed') === 'true',
          hasInstall: !!c.querySelector('[data-role="engine-install"]'),
          hasCancel: !!c.querySelector('[data-role="engine-install-cancel"]'),
          hasUninstall: !!c.querySelector('[data-role="engine-uninstall"]'),
          steps: [...c.querySelectorAll('[data-role="engine-setup-steps"] > li')]
            .map((li) => (li.textContent || '').trim()),
          hasSearchedToggle: !!c.querySelector('[data-role="engine-setup-searched-toggle"]'),
          configPath: text(c, '[data-role="engine-config-path"]'),
          progress: text(c, '[data-role="engine-install-progress"]'),
          outcome: text(c, '[data-role="engine-install-result"]'),
          body: (c.textContent || '').trim()
        };
      });
      return JSON.stringify({
        cards,
        reason: text(document, '[data-role="engine-setup-reason"]'),
        group: (document.querySelector('[data-role="engine-setup-group"]')?.textContent || '').trim()
      });
    })()`;

    /** Press a button that belongs to ONE card. There are several Install buttons on screen. */
    const clickInCard = (engineId, role) => `(() => {
      const card = document.querySelector('[data-role="engine-card"][data-engine-id="${engineId}"]');
      const b = card && card.querySelector('[data-role="${role}"]');
      if (!b) return JSON.stringify({ clicked: false });
      b.click();
      return JSON.stringify({ clicked: true });
    })()`;

    const GEAR_CLICK = `(() => {
      const gear = [...document.querySelectorAll('.app-header button')]
        .find((b) => b.getAttribute('data-role') === 'settings-gear');
      if (!gear) return JSON.stringify({ clicked: false });
      gear.click();
      return JSON.stringify({ clicked: true });
    })()`;

    result.engineCards = await evalJson(ENGINE_CARDS);

    // The engine that runs in this page, on two fixtures it built itself. See
    // `__RIFFSHEET_LOCALENGINE__` for why both takes are needed and why they carry a hiss floor.
    result.localEngine = await evalJson(
      `JSON.stringify(window.__RIFFSHEET_LOCALENGINE__ ? window.__RIFFSHEET_LOCALENGINE__() : null)`,
      30_000
    );

    // A one-click install, pressed for real. The mock takes about 1.2s over eight frames,
    // which is slow enough that the progress row genuinely has to render rather than flash.
    result.engineInstallClick = await evalJson(clickInCard('bass-v2', 'engine-install'));
    await settle(500);
    result.engineInstalling = await evalJson(ENGINE_CARDS);
    await settle(2000);
    result.engineInstalled = await evalJson(ENGINE_CARDS);

    // A choice, then the panel closed and opened again. The engine lives in a file the shell
    // owns, not in this page, so "it stuck" means the page asked again and got the same answer.
    result.engineUseClick = await evalJson(clickInCard('transkun', 'engine-use'));
    await settle(600);
    result.engineChosen = await evalJson(ENGINE_CARDS);
    await evalJson(GEAR_CLICK);
    await settle(400);
    await evalJson(GEAR_CLICK);
    await settle(1400);
    result.engineChosenAfterReopen = await evalJson(ENGINE_CARDS);

    // Put the panel back the way it was found; everything after this expects the sheet.
    await evalJson(GEAR_CLICK);
    await settle(400);

    // --- the main-menu picker, and the two window sizes it has to survive -------------
    //
    // The picker is on the main menu rather than behind the gear, because which engine
    // listens is a decision about the take you are about to make. The measurements happen
    // HERE and not on the sheet deliberately: the opening screen has no engraving in it, so
    // what is being measured is the picker and the cards rather than alphaTab's reflow.
    phase('checking the main-menu engine picker', 60_000);
    result.mainMenuClick = await evalJson(clickRole('main-menu'));
    await settle(700);

    const ENGINE_PICK = `(() => {
      const s = document.querySelector('[data-role="engine-pick"]');
      if (!s) return JSON.stringify({ present: false, innerW: window.innerWidth });
      const box = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { right: Math.round(r.right), scrollW: e.scrollWidth, clientW: e.clientWidth };
      };
      return JSON.stringify({
        present: true,
        innerW: window.innerWidth,
        docScrollW: document.documentElement.scrollWidth,
        chips: [...s.querySelectorAll('.chip-group .chip')].map((b) => ({
          id: b.getAttribute('data-engine-id'),
          label: (b.textContent || '').trim(),
          on: b.classList.contains('on'),
          pressed: b.getAttribute('aria-pressed') === 'true',
          title: b.getAttribute('title') || ''
        })),
        reason: (s.querySelector('[data-role="engine-pick-reason"]')?.textContent || '').trim(),
        hasMore: !!s.querySelector('[data-role="engine-pick-more"]'),
        pick: box(s)
      });
    })()`;

    /** Does anything on the engine screen push the window sideways at this size? */
    const ENGINE_FIT = `(() => {
      const box = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { right: Math.round(r.right), scrollW: e.scrollWidth, clientW: e.clientWidth };
      };
      const panel = document.querySelector('.settings-panel');
      const cards = [...document.querySelectorAll('[data-role="engine-card"]')].map(box);
      return JSON.stringify({
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        docScrollW: document.documentElement.scrollWidth,
        panelOpen: !!panel && panel.style.display !== 'none',
        panel: box(panel),
        cards,
        pick: box(document.querySelector('[data-role="engine-pick"]'))
      });
    })()`;

    result.enginePick = await evalJson(ENGINE_PICK);

    // 900x600 is the product's floor for a plugin window; 360x280 is REAPER's smallest docked
    // FX window. Both have to hold the picker AND the cards without a sideways scrollbar.
    const OPEN_CARDS_FROM_MENU = `(() => {
      const b = document.querySelector('[data-role="engine-pick-more"]');
      if (!b) return JSON.stringify({ clicked: false });
      b.click();
      return JSON.stringify({ clicked: true });
    })()`;
    const CLOSE_PANEL = `(() => {
      const x = document.querySelector('.settings-panel button[aria-label="Close settings"]');
      if (!x) return JSON.stringify({ clicked: false });
      x.click();
      return JSON.stringify({ clicked: true });
    })()`;

    for (const [w, h, key] of [
      [900, 600, 'engineFit900'],
      [360, 280, 'engineFit360']
    ]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: false
      });
      await settle(500);
      result[`${key}Pick`] = await evalJson(ENGINE_PICK);
      await evalJson(OPEN_CARDS_FROM_MENU);
      await settle(1300);
      result[key] = await evalJson(ENGINE_FIT);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(ROOT, 'spike-results', `app-engines-${w}x${h}.png`), Buffer.from(shot.data, 'base64'));
      await evalJson(CLOSE_PANEL);
      await settle(300);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await settle(600);

    // Back to Auto through the picker itself, so nothing downstream inherits a choice this
    // block made — and so "the mark follows the choice" is proved rather than assumed.
    result.enginePickAutoClick = await evalJson(`(() => {
      const b = document.querySelector('[data-role="engine-pick"] [data-engine-id="auto"]');
      if (!b) return JSON.stringify({ clicked: false });
      b.click();
      return JSON.stringify({ clicked: true });
    })()`);
    await settle(700);
    result.enginePickAuto = await evalJson(ENGINE_PICK);

    // --- About & licences: the "Support the makers" section ---------------------------
    //
    // Measured here because the button that opens it is on the opening screen, which is
    // already up.
    //
    // What this guards is not a layout. Every row on that list is a factual claim about
    // somebody else's project — three of them publish a funding channel, and the rest either
    // have none or, in MuseScore's case, say in as many words that they do not want money.
    // The regression to be afraid of is a well-meaning later edit bolting a donate button
    // onto one of those, which would be a lie told in their name from inside our own credits
    // screen. So the probe reports the href of every row next to the row's declared money
    // status, and the checks refuse both a wallet where none was declared and a money link
    // that is not one of the three that were verified against the upstream's own site.
    phase('checking the About screen support section', 30_000);
    result.aboutOpen = await evalJson(clickRole('about-licenses'));
    await settle(400);

    const SUPPORT = `(() => {
      const card = document.querySelector('[data-role="about-dialog"]');
      const section = card && card.querySelector('[data-role="support-makers"]');
      if (!section) return JSON.stringify({ present: false, dialog: !!card });
      // Anything that looks like somewhere to send money. Deliberately broad: the point is to
      // catch a payment link appearing on a row that never declared one, whatever the host.
      const WALLET = /paypal|opencollective|patreon|ko-fi|liberapay|buymeacoffee|tidelift|github\\.com\\/sponsors|donate|donation/i;
      const rows = [...section.querySelectorAll('[data-role="support-entry"]')].map((li) => {
        const a = li.querySelector('[data-role="support-link"]');
        const href = a ? a.getAttribute('href') || '' : null;
        return {
          id: li.getAttribute('data-support-id'),
          money: li.getAttribute('data-support-money') === 'yes',
          href,
          target: a ? a.getAttribute('target') : null,
          rel: a ? a.getAttribute('rel') : null,
          wallet: href === null ? false : WALLET.test(href),
          text: (li.textContent || '').replace(/\\s+/g, ' ').trim()
        };
      });
      const box = section.getBoundingClientRect();
      return JSON.stringify({
        present: true,
        heading: [...card.querySelectorAll('h3')].some((h) => (h.textContent || '').trim() === 'Support the makers'),
        groups: [...section.querySelectorAll('.support-heading')].map((h) => (h.textContent || '').trim()),
        order: rows.map((r) => r.id),
        rows,
        moneyLinks: rows.filter((r) => r.money).map((r) => r.href),
        walletsWithoutAChannel: rows.filter((r) => !r.money && r.wallet).map((r) => r.id),
        laidOut: box.width > 0 && box.height > 0,
        cardOverflows: card.scrollWidth > card.clientWidth + 1,
        docScrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth
      });
    })()`;

    result.support = await evalJson(SUPPORT);
    await evalJson(`(() => {
      const s = document.querySelector('[data-role="support-makers"]');
      if (s) s.scrollIntoView({ block: 'start' });
      return JSON.stringify({ scrolled: !!s });
    })()`);
    await settle(300);
    const supportShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(join(ROOT, 'spike-results'), { recursive: true });
    await writeFile(join(ROOT, 'spike-results', 'app-about-support.png'), Buffer.from(supportShot.data, 'base64'));

    result.aboutClosed = await evalJson(`(() => {
      const x = document.querySelector('[data-role="about-dialog"] button[aria-label="Close About and licenses"]');
      if (!x) return JSON.stringify({ clicked: false, gone: false });
      x.click();
      return JSON.stringify({ clicked: true, gone: !document.querySelector('[data-role="about-dialog"]') });
    })()`);
    await settle(300);

    // And back to the sheet. Everything after this expects the main screen.
    result.resumeClick = await evalJson(clickRole('resume-current'));
    await settle(1800);

    // --- every adjustable setting, and whether it can actually be reached --------------
    //
    // The question an audit of `AppSettings` asked and this answers: for each thing the app
    // lets somebody change, is there a control anywhere on screen that changes it? Three had
    // none — the highest fret a hand edit may use, the capo, and the key the take is written
    // in — all three read by live code, none of them reachable by a player. So this comes in
    // two halves: the three new controls are DRIVEN, and then every remaining setting is swept
    // for a control that exists.
    //
    // The sweep reads its key list out of `src/app/state.ts` rather than repeating it here, so
    // a setting added later cannot arrive with no way to change it and no one notice: it will
    // be in neither map below and the check names it.
    //
    // What each control is proved by differs, because the settings differ:
    //   - capo and key reach the PIPELINE, so the proof is the MusicXML the app writes —
    //     `<capo>` and `<fifths>` are the pipeline's own words for what it was told.
    //   - the highest fret does not reach the pipeline (`BuildSettings` has no such field): it
    //     governs hand edits, so the proof is that the app stored it and the panel reads it
    //     back — a control that writes and then shows its own value, rather than a widget that
    //     springs back.
    phase('checking every setting is reachable from the UI', 60_000);

    const stateSource = await readFile(join(ROOT, 'src', 'app', 'state.ts'), 'utf8');
    const defaultsBlock = /export const DEFAULT_SETTINGS: AppSettings = \{([\s\S]*?)\n\};/.exec(stateSource);
    // Top-level keys are the ones indented exactly two spaces; every value in that literal is
    // written on one line, so nothing nested can be mistaken for a setting.
    const settingKeys = [...(defaultsBlock?.[1] ?? '').matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);

    /**
     * Settings with no control on screen, and why that is a fact rather than an oversight.
     * Anything not in here has to have one.
     */
    const SETTINGS_OFF_SCREEN = {
      instrument:
        'dead: written ("auto", always) and read by nothing — tabMode took over the job in settings v5',
      settingsVersion: 'bookkeeping: the number migrate() reads, never a knob',
      useHostGrid:
        'only exists when a DAW does — driven below, in simulated-plugin mode, where there is a grid to follow',
      anchorFret:
        'only exists for one fingering style — the box appears beside the Tab menu when "Around fret N" is chosen, and a number that governs nothing is what this pass removed everywhere else',
      // The three that stopped being switches in settings v9. The FIELDS survive so an older
      // blob still round-trips and is normalised rather than merely spread back (see their
      // comments in app/state.ts), but there is no control for them anywhere any more and there
      // is not meant to be: the roll names every row and is always editable, and the drifting
      // tempo pass is off for good. `migrate()` forces all three.
      rollAllNoteNames:
        'dead: forced true by the v9 migration — naming every row is simply what the roll does, and renderMain passes the literal rather than the field',
      rollEditing:
        'dead: forced true by the v9 migration — the roll is always editable, and renderMain passes setEditable(true) outright',
      preciseBeats:
        'dead: forced false by the v9 migration — the second listening pass it bought cost minutes a take and returned bar lines that followed the player\'s drift',
      // The fourth of the same kind, added in G11. The Align chip is deleted and `migrate()`
      // forces this true, because the OFF position only ever meant "the sheet refuses to follow
      // the thing you are pointing at" — a worse version of ON rather than a different choice.
      // The field survives so an older blob still round-trips; the readers in ui/app.ts pass
      // the literal. The BEHAVIOUR is checked harder than a switch ever checked it: see the
      // align block below, which no longer has an off state to weaken its bounds.
      alignViews:
        'dead: forced true by the v11 migration — alignment is unconditional and the chip is gone (G11)'
    };

    /** Every `[data-setting]` on screen right now, counted. */
    const SETTINGS_CENSUS = `(() => {
      const found = {};
      for (const e of document.querySelectorAll('[data-setting]')) {
        const key = e.getAttribute('data-setting');
        found[key] = (found[key] || 0) + 1;
      }
      const panel = document.querySelector('.settings-panel');
      return JSON.stringify({ found, panelOpen: !!panel && panel.style.display !== 'none' });
    })()`;

    /** What the app itself wrote down, and what the pipeline put in the file it exports. */
    const SETTINGS_TRUTH = `(() => {
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem('riffsheet.settings') || 'null'); } catch (e) { stored = null; }
      const x = window.__RIFFSHEET_EXPORTS__ ? window.__RIFFSHEET_EXPORTS__() : null;
      const xml = x && typeof x.musicxml === 'string' ? x.musicxml : '';
      const fifths = /<fifths>(-?\\d+)<\\/fifths>/.exec(xml);
      const capo = /<capo>(\\d+)<\\/capo>/.exec(xml);
      const key = document.querySelector('[data-role="doc-key"]');
      const fret = document.querySelector('[data-role="max-fret"]');
      const capoBox = document.querySelector('[data-role="capo"]');
      return JSON.stringify({
        storedMaxFret: stored ? stored.maxFret : null,
        storedCapo: stored ? stored.capo : null,
        xmlFifths: fifths ? Number(fifths[1]) : null,
        // No <capo> element at all is the pipeline saying zero; it only writes it above 0.
        xmlCapo: capo ? Number(capo[1]) : 0,
        keyControl: key ? key.value : null,
        // What Auto resolved to, which is the sheet's own key read back off the picker.
        keyAutoLabel: key ? (key.querySelector('option[value="auto"]') || {}).textContent || null : null,
        fretControl: fret ? fret.value : null,
        capoControl: capoBox ? capoBox.value : null
      });
    })()`;

    /** Type into a number box the way a player does — set it, then let the app hear about it. */
    const setNumber = (role, value) => `(() => {
      const i = document.querySelector('[data-role="${role}"]');
      if (!i) return JSON.stringify({ set: false, reason: 'no control' });
      i.value = ${JSON.stringify(String(value))};
      i.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ set: true, value: i.value });
    })()`;

    result.settingsBefore = await evalJson(SETTINGS_TRUTH);

    // --- the key signature ---------------------------------------------------------
    // Four sharps, which the triplet demo is certainly not in, so an unchanged file cannot
    // pass by accident.
    result.keyPick = await evalJson(setSelect('doc-key', '4'));
    await settle(1200);
    result.keySet = await evalJson(SETTINGS_TRUTH);
    // ...and Auto puts the app back to reading the key off the notes, rather than leaving the
    // override behind for everything after this.
    result.keyAuto = await evalJson(setSelect('doc-key', 'auto'));
    await settle(1200);
    result.keyRestored = await evalJson(SETTINGS_TRUTH);

    // --- the capo ------------------------------------------------------------------
    result.capoSet = await evalJson(setNumber('capo', 3));
    await settle(1200);
    result.capoApplied = await evalJson(SETTINGS_TRUTH);
    await evalJson(setNumber('capo', 0));
    await settle(1200);
    result.capoRestored = await evalJson(SETTINGS_TRUTH);

    // --- the highest fret ----------------------------------------------------------
    await evalJson(GEAR_CLICK);
    await settle(600);
    result.fretSet = await evalJson(setSelect('max-fret', '24'));
    await settle(500);
    result.fretApplied = await evalJson(SETTINGS_TRUTH);

    // --- the sweep -----------------------------------------------------------------
    // Two censuses, because two controls only exist for a custom tuning — the tuning box and
    // its string count are meaningless for a named preset and are not drawn for one. Switching
    // the tab picker to Custom and back is what a player would do to find them.
    result.settingsCensus = await evalJson(SETTINGS_CENSUS);
    await evalJson(setSelect('tab-view', 'custom'));
    await settle(1200);
    result.settingsCensusCustom = await evalJson(SETTINGS_CENSUS);
    await evalJson(setSelect('tab-view', 'bass'));
    await settle(1200);

    // Put the panel and the fret limit back the way they were found; the persistence probe
    // below fingerprints the app and everything after it expects the sheet, not the panel.
    await evalJson(setSelect('max-fret', '17'));
    await settle(300);
    await evalJson(GEAR_CLICK);
    await settle(400);
    result.settingsAfter = await evalJson(SETTINGS_TRUTH);

    // --- what happens to the audio before an engine hears it --------------------------
    //
    // Three claims no other check can make. (1) The two preprocessing switches belong to the
    // player, so what they say has to REACH the bridge — proved by comparing what the app
    // sent with what the bridge received, two independent readings of one call rather than
    // one side's opinion of itself. (2) The receipt that comes back has to be shown, and
    // shown to somebody who opens the panel AFTER the transcription, which is when anybody
    // actually asks "what did it do to my recording?" — so the row is read from a panel
    // opened afterwards, and again after it has been closed and reopened. (3) A named engine
    // survives the same trip, because a per-take "listen again with this one" is built on
    // that field and nothing in the product sends it yet.
    //
    // The probe deliberately does not touch the score, so this sits between the settings
    // sweep and the persistence probe without disturbing either.
    phase('checking preprocessing feedback and transcribe options', 60_000);

    const TRANSCRIBE_PROBE = (engineId) =>
      `window.__RIFFSHEET_TRANSCRIBEPROBE__
        ? window.__RIFFSHEET_TRANSCRIBEPROBE__(${engineId === undefined ? '' : JSON.stringify(engineId)})
            .then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) }))
        : Promise.resolve('null')`;

    /** What the bridge itself wrote down about the last call it was given. */
    const MOCK_SEEN = `JSON.stringify(window.__RIFFSHEET_MOCKBRIDGE__ ? window.__RIFFSHEET_MOCKBRIDGE__() : null)`;

    /** The dim sentence under the two checkboxes — is it there, and is it below them? */
    const PREPROCESS_ROW = `(() => {
      const row = document.querySelector('[data-role="preprocess-result-note"]');
      const tuning = document.querySelector('[data-role="preprocess-tuning"]');
      const panel = document.querySelector('.settings-panel');
      return JSON.stringify({
        panelOpen: !!panel && panel.style.display !== 'none',
        present: !!row,
        dim: !!row && row.classList.contains('dim'),
        text: row ? (row.textContent || '').trim() : null,
        // Under the switches it explains, not filed away in some other group.
        belowSwitches:
          !!row && !!tuning &&
          (tuning.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      });
    })()`;

    const CHECKBOX = (role) => `(() => {
      const i = document.querySelector('[data-role="${role}"]');
      return JSON.stringify({ present: !!i, checked: !!i && i.checked });
    })()`;

    // Nothing has run yet, so nothing may be claimed.
    result.preprocessBefore = await evalJson(PREPROCESS_ROW);

    // THE DEFAULT RUN. Both switches off, so the call has to carry false and the shell has to
    // report that it did nothing. This is the reading that matters most: it is what every
    // existing player gets without touching anything.
    result.transcribeProbe = await evalJson(TRANSCRIBE_PROBE(), 30_000);
    result.transcribeSeen = await evalJson(MOCK_SEEN);

    // THE OPT-IN RUN. Switched on the way a player switches it, so the value has to travel and
    // the answer has to change with it. The receipt sentence only exists when something was
    // actually done, so the panel is read AFTER this run rather than after the default one.
    await evalJson(GEAR_CLICK);
    await settle(500);
    result.preprocessNormalizeOn = await evalJson(clickRole('preprocess-normalize'));
    await settle(400);
    // Shut the panel before the run. The receipt row is drawn when the panel renders and does
    // not yet watch the runtime store, so a panel that was already open during the run shows
    // the previous take's sentence. That is its own (separate, older) bug; reading it the way
    // a player would — open the panel to ask what happened — is what this probe is for.
    await evalJson(GEAR_CLICK);
    await settle(300);
    result.transcribeProbeOn = await evalJson(TRANSCRIBE_PROBE(), 30_000);
    result.transcribeSeenOn = await evalJson(MOCK_SEEN);
    await settle(400);
    await evalJson(GEAR_CLICK);
    await settle(500);
    result.preprocessRow = await evalJson(PREPROCESS_ROW);
    await evalJson(GEAR_CLICK);
    await settle(300);
    await evalJson(GEAR_CLICK);
    await settle(500);
    result.preprocessRowReopened = await evalJson(PREPROCESS_ROW);

    // Put it back — everything after this expects the documented defaults — and prove the
    // panel agrees it is back rather than assuming the click landed.
    await evalJson(clickRole('preprocess-normalize'));
    await settle(400);
    result.preprocessNormalizeRestored = await evalJson(CHECKBOX('preprocess-normalize'));
    result.preprocessTuningState = await evalJson(CHECKBOX('preprocess-tuning'));

    result.transcribeProbeEngine = await evalJson(TRANSCRIBE_PROBE('bass-v2'), 30_000);
    result.transcribeSeenEngine = await evalJson(MOCK_SEEN);

    await evalJson(GEAR_CLICK);
    await settle(400);

    // The one seam a browser harness cannot drive: the JUCE mapping only runs inside the
    // shell, and both fields below reached the page and were thrown away there until now.
    // Read as source, because a one-line regression that drops them again would otherwise
    // have nothing anywhere that notices.
    const juceSource = await readFile(join(ROOT, 'src', 'bridge', 'juce.ts'), 'utf8');
    result.juceCarries = {
      confidence: /\{\s*confidence:\s*n\.confidence\s*\}/.test(juceSource),
      preprocess: /preprocess:\s*\{\s*\.\.\.r\.preprocess\s*\}/.test(juceSource),
      confidenceDeclared: /confidence\?:\s*number/.test(juceSource),
      // Opt-in, at the seam. `!== false` here would put the audio rewrites back on for any
      // caller that simply does not mention them.
      preprocessOptIn:
        /normalizeBeforeTranscribe:\s*options\?\.normalizeBeforeTranscribe === true/.test(juceSource) &&
        /correctTuningBeforeTranscribe:\s*options\?\.correctTuningBeforeTranscribe === true/.test(juceSource)
    };
    // The plugin half of the external-link rule. A browser harness cannot see JUCE's window
    // handling, so the guarantee is read off the source that decides it.
    const appSource = await readFile(join(ROOT, 'src', 'ui', 'app.ts'), 'utf8');
    result.linkTargetGuarded = /\.\.\.\(inJuceShell\(\) \? \{\} : \{ target: '_blank' \}\)/.test(appSource);

    phase('checking settings and session persistence', 100_000);
    // --- session persistence: the plugin-amnesia regression test ---------------------
    // --- the auto-split / gap-fill pass ------------------------------------------------
    //
    // The player's case, in their own words: the engine returned two quarter-second hits as
    // one half-second note, while the app's own attack detector had already drawn a line at
    // the join. The pass acts on that. What has to be proved is not that it CAN split — that
    // is easy — but that it refuses everything it should, because the same detector fires
    // narrow ghost detections just before real attacks and a pass that believed them would
    // turn a clean take into confetti.
    phase('checking the auto-edit pass', 60_000);
    result.autoPlan = await evalJson(
      `JSON.stringify(window.__RIFFSHEET_AUTOPLAN__ ? window.__RIFFSHEET_AUTOPLAN__() : null)`,
      45_000
    );
    // The no-false-positives half, against the REAL detector rather than a hand-made onset
    // list: render the demo's own notes as clean tones, run the detector over them, and count
    // what the pass would do to a take that is already right.
    result.autoClean = await evalJson(
      `JSON.stringify(window.__RIFFSHEET_AUTOCLEAN__ ? window.__RIFFSHEET_AUTOCLEAN__() : null)`,
      45_000
    );
    result.autoBefore = await evalJson(`JSON.stringify(window.__RIFFSHEET_AUTOEDITS__ ? window.__RIFFSHEET_AUTOEDITS__() : null)`);
    // The whole review loop, driven the way a mouse drives it: highlight, chip, popover, Keep.
    result.autoKeep = await evalJson(
      `JSON.stringify(window.__RIFFSHEET_AUTOREVIEW__ ? window.__RIFFSHEET_AUTOREVIEW__('keep') : null)`,
      45_000
    );
    await settle(600);
    // ...and again, pressing Revert instead, which has to put the note back together.
    result.autoRevert = await evalJson(
      `JSON.stringify(window.__RIFFSHEET_AUTOREVIEW__ ? window.__RIFFSHEET_AUTOREVIEW__('revert') : null)`,
      45_000
    );
    await settle(600);
    result.autoAfter = await evalJson(`JSON.stringify(window.__RIFFSHEET_AUTOEDITS__ ? window.__RIFFSHEET_AUTOEDITS__() : null)`);
    // Switched OFF: the same detections, shown and not acted on.
    result.autoOff = await evalJson(
      `window.__RIFFSHEET_AUTOOFF__
        ? window.__RIFFSHEET_AUTOOFF__().then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) }))
        : Promise.resolve('null')`,
      45_000
    );
    await settle(500);
    // NEVER on the sheet or the tab. Counted rather than assumed: those two views are the
    // RESULT, and marking them up with what the app thinks of itself would make the music
    // harder to read in exchange for information about the app.
    result.autoSheetMarks = await evalJson(`JSON.stringify(
      document.querySelectorAll('.at-host [class*="auto-"], .at-host [data-auto-edit], .note-name[class*="auto-"], .triview [data-auto-edit]').length
    )`);

    // --- clicking outside Settings closes it ------------------------------------------
    // Requested directly. The three exemptions are what make it survivable: the panel itself,
    // the gear (which toggles), and a browser-drawn <select> list whose options are not
    // children of the panel.
    result.settingsOutside = await evalJson(`(() => {
      const open = () => !!document.querySelector('.settings-panel') &&
        document.querySelector('.settings-panel').style.display !== 'none';
      const gear = document.querySelector('[data-role="settings-gear"]');
      if (!gear) return JSON.stringify({ error: 'no gear' });
      const press = (node) => node.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1
      }));
      gear.click();
      const opened = open();
      // Inside first: a press on the panel's own body must NOT close it.
      const panel = document.querySelector('.settings-panel');
      press(panel);
      const afterInside = open();
      // A press on the gear itself must not close-then-reopen either.
      press(gear);
      const afterGear = open();
      // Then genuinely outside.
      press(document.querySelector('.triview') || document.body);
      const afterOutside = open();
      if (open()) gear.click();
      return JSON.stringify({ opened, afterInside, afterGear, afterOutside, closedAtEnd: !open() });
    })()`);
    await settle(400);

    phase('checking cross-highlighting, custom tuning and outside-click', 90_000);
    // --- a stretch on the strip lights the same notes on the roll AND the sheet ---------
    // "two pictures of one set of notes that could not point at the same one" was the report.
    result.crossHighlight = await evalJson(
      `JSON.stringify(window.__RIFFSHEET_CROSSHIGHLIGHT__ ? window.__RIFFSHEET_CROSSHIGHLIGHT__() : null)`,
      45_000
    );
    await settle(600);

    // --- a custom TAB tuning is actually used, not merely remembered -------------------
    // Drops every string a whole tone and reads the FRET DIGITS back off the engraving. A
    // tuning that is stored and not applied leaves them identical, which is the bug.
    result.customTuning = await evalJson(
      `window.__RIFFSHEET_CUSTOMTUNING__
        ? window.__RIFFSHEET_CUSTOMTUNING__().then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) }))
        : Promise.resolve('null')`,
      60_000
    );
    await settle(900);

    phase('checking session persistence and the main menu', 120_000);
    // The reported bug: switching REAPER tracks destroys the plugin editor and everything
    // on it, and coming back shows an empty plugin. Nothing here can destroy a WebView, but
    // the claim that matters IS testable — mutate, save through the real bridge, boot a
    // SECOND app that has only the persisted blob to go on, and compare it note for note.
    //
    // Runs last of the in-page probes because it edits the live app. It puts back what it
    // changed, but nothing after this point should depend on the app being untouched.
    result.persist = await evalJson(
      `window.__RIFFSHEET_PERSIST__
        ? window.__RIFFSHEET_PERSIST__().then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) }))
        : Promise.resolve('null')`,
      90000
    );
    await settle(300);

    // --- what a .riffsheet file carries ------------------------------------------------
    //
    // Deliberately AFTER the persistence probe and before the menu walk. The probe above
    // leaves the edit log populated with the cursor wound back by its undos, which is the
    // one state worth writing a document from: it proves the log and the cursor travel
    // separately. The menu walk below presses Close and would leave nothing to save.
    //
    // Synchronous, unlike its neighbours — it is a pure round trip through the writer and
    // the reader, with no boot and no bridge call.
    result.document = await evalJson(
      `window.__RIFFSHEET_DOCUMENT__ ? JSON.stringify(window.__RIFFSHEET_DOCUMENT__()) : 'null'`,
      30_000
    );
    await settle(200);

    // --- the main menu, and a blank score, end to end ----------------------------------
    //
    // LAST of the in-page probes, and deliberately so: the menu walk presses Close, which
    // throws the take away. Everything above needs the demo; nothing below does — the next
    // thing that happens is a navigation to a different fixture.
    //
    // Every row is pressed through its REAL handler and answered with something observable.
    // "The row exists" is not a claim worth making in a repository that has already shipped a
    // menu whose confirmations led nowhere.
    result.menuActions = await evalJson(
      `window.__RIFFSHEET_MENUACTIONS__
        ? window.__RIFFSHEET_MENUACTIONS__().then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) }))
        : Promise.resolve('null')`,
      60_000
    );
    await settle(400);
    // And the one row that builds something: a blank score, followed all the way to a page.
    result.blankScore = await evalJson(
      `window.__RIFFSHEET_BLANKSCORE__
        ? window.__RIFFSHEET_BLANKSCORE__().then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) }))
        : Promise.resolve('null')`,
      60_000
    );
    await settle(600);

    // --- octave-folded tab positions -------------------------------------------------
    // A separate fixture, because the ordinary demo never leaves the fretboard. Below the
    // low E the pipeline folds the tab position up an octave and records tabOctaveShift;
    // without a marker the tab silently shows a position that is not the pitch on the
    // staff above it.
    phase('loading the drop-tuned fixture', 50_000);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?demo=droptuned&bars=4&tab=bass&verify=1` });
    // Same one-budget rule as the main demo: without it each poll carried the 45s protocol
    // default and the 40s deadline could only ever be noticed late.
    await waitForReady(
      'drop-tuned demo',
      '!!window.__RIFFSHEET_DEMO_READY__ && document.querySelectorAll(".note-name").length > 0',
      40_000
    );
    await settle(900);
    result.dropTuned = {
      layout: await evalJson(LAYOUT),
      roll: await evalJson(ROLL),
      timebase: await evalJson(TIMEBASE)
    };
    const shotDrop = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(ROOT, 'spike-results', 'app-droptuned.png'), Buffer.from(shotDrop.data, 'base64'));

    // --- the one setting a browser tab cannot show: the DAW's grid --------------------
    //
    // `useHostGrid` has two controls — the chip in the header and a switch in the panel — and
    // BOTH are drawn only when there is a DAW timeline to follow, which is right: a switch
    // offering to follow a grid that does not exist is a lie. A plain browser tab has none, so
    // the mock's simulated-plugin mode (`?plugin`) is where that setting can be seen at all.
    // Last of the navigations, because it leaves the page in a different host.
    phase('checking the DAW-grid switch in simulated-plugin mode', 40_000);
    await cdp.send('Page.navigate', {
      url: `http://127.0.0.1:${PORT}/index.html?demo=straight&bars=2&tab=bass&verify=1&plugin`
    });
    await waitForReady(
      'simulated-plugin demo',
      '!!window.__RIFFSHEET_DEMO_READY__ && document.querySelectorAll(".note-name").length > 0',
      30_000
    );
    await settle(900);
    /**
     * THE TEMPO SOURCE (F19), where the "Use DAW grid" chip used to be probed.
     *
     * The chip is gone: it and the transport's BPM box were the same question asked twice, two
     * rows apart, so they are one `<select>` in the transport now — see `buildTempoSource()`.
     * What is checked is the same claim as before plus the two the unification adds: the
     * control offers the DAW as a source only where there is a DAW, choosing it really does
     * write `useHostGrid`, and the fields it governs are read-only under every source but
     * Manual. `data-setting` is still `useHostGrid`, which is what keeps this control inside
     * the settings sweep further down.
     */
    const TEMPO_SOURCE = `(() => {
      const sel = document.querySelector('[data-role="tempo-source"]');
      const bpm = document.querySelector('[data-role="bpm"]');
      const sig = document.querySelector('[data-role="timesig"]');
      const detail = document.querySelector('[data-role="tempo-detail"]');
      const row = document.querySelector('[data-role="tempo-source-row"]');
      return JSON.stringify({
        present: !!sel,
        setting: sel ? sel.getAttribute('data-setting') : null,
        value: sel ? sel.value : null,
        options: sel ? [...sel.options].map((o) => o.value) : [],
        labels: sel ? [...sel.options].map((o) => o.textContent) : [],
        bpmPresent: !!bpm,
        bpmValue: bpm ? bpm.value : null,
        bpmReadOnly: bpm ? bpm.readOnly === true : null,
        sigDisabled: sig ? sig.disabled === true : null,
        detail: detail ? (detail.textContent || '').trim() : null,
        // The row lives in the transport, not in the header — the whole point of the move.
        inTransport: !!(row && row.closest('.transport')),
        inHeader: !!(row && row.closest('.app-header')),
        // …and the chip it replaced is really gone rather than merely hidden.
        chipGone: !document.querySelector('[data-role="host-grid"]')
      });
    })()`;
    result.tempoSourceBefore = await evalJson(TEMPO_SOURCE);
    // Choosing a source re-engraves the sheet, so the read happens after the render rather
    // than inside the same tick as the change.
    result.tempoSourceSet = await evalJson(setSelect('tempo-source', 'manual'));
    await settle(1200);
    result.tempoSourceManual = await evalJson(TEMPO_SOURCE);
    result.tempoSourceBack = await evalJson(setSelect('tempo-source', 'daw'));
    await settle(1200);
    result.tempoSourceDaw = await evalJson(TEMPO_SOURCE);

    // THE BRAND BLOCK (F17/F18), in the host where the header is under most pressure. Three
    // claims: it exists with all four of its parts, it is one clickable target, and it has NOT
    // made the header taller — measured against the tallest ordinary control in the same row.
    result.brand = await evalJson(`(() => {
      const block = document.querySelector('[data-role="brand"]');
      const header = document.querySelector('.app-header');
      if (!block || !header) return JSON.stringify({ present: false });
      const h = (sel) => { const e = block.querySelector(sel); return e ? (e.textContent || '').trim() : null; };
      const heights = [...header.children].map((e) => Math.round(e.getBoundingClientRect().height));
      return JSON.stringify({
        present: true,
        tag: block.tagName,
        mark: !!block.querySelector('.brand-mark svg'),
        wordmark: h('.brand-wordmark'),
        version: h('[data-role="brand-version"]'),
        check: h('[data-role="brand-check"]'),
        label: block.getAttribute('aria-label'),
        // BASAMAK's own rule: one target, and nothing inside it intercepts the click.
        childrenClickable: [...block.children].some(
          (e) => getComputedStyle(e).pointerEvents !== 'none'
        ),
        blockH: Math.round(block.getBoundingClientRect().height),
        tallestSiblingH: Math.max(...heights),
        // Its left edge is the header's left edge: this is the TOP-LEFT brand block.
        firstChild: header.firstElementChild === block,
        // And the take's name is the thing beside it.
        nameIsNext: !!(block.nextElementSibling && block.nextElementSibling.classList.contains('filename')),
        // The same measure the layout check uses — distinct row CENTRES, not top edges. See
        // the note on it in the OVERFLOW probe above for why tops do not answer this question.
        headerRows: new Set(
          [...header.children].map((e) => { const b = e.getBoundingClientRect(); return Math.round((b.top + b.height / 2) / 4); })
        ).size,
        // The same buckets, itemised. headerRows is a count, so when it moves the only useful
        // question is WHICH child moved — and a bare number cannot say.
        // (No backticks in this comment: it lives inside a template literal.)
        headerTops: [...header.children].map((e) => {
          const b = e.getBoundingClientRect();
          return [
            (e.getAttribute('data-role') || e.className || e.tagName).toString().slice(0, 24),
            Math.round(b.top),
            Math.round(b.height),
            Math.round(b.top + b.height / 2)
          ];
        })
      });
    })()`);

    // THE SETTINGS CLOBBER (review major), driven end to end through the real document path.
    // See `__RIFFSHEET_DOCSETTINGS__` in ui/app.ts for the scenario it plays out.
    result.docSettings = await evalJson(
      `JSON.stringify(window.__RIFFSHEET_DOCSETTINGS__ ? window.__RIFFSHEET_DOCSETTINGS__() : null)`
    );

    // -------------------------------------------------------------------------------
    // The three controls the player reported as broken, driven through real clicks.
    // -------------------------------------------------------------------------------
    //
    // BACK TO THE MAIN DEMO FIRST, and this is a HARNESS fix rather than a softening of what
    // follows.
    //
    // The align checks below were written against the take this file loads at the top: the
    // 8-bar triplet demo, 20.9s and 77 notes, whose engraving is several screens wide. They
    // were then left in place while two navigations were added ABOVE them — the drop-tuned
    // fixture and, immediately before this line, `?demo=straight&bars=2&plugin`. So by the time
    // they ran, the document was a 2-bar, 5.264s, 16-note take, and on that take the
    // assertions are not merely hard to meet, they are unmeetable arithmetic:
    //
    //   - the whole take is barely wider than one pane, so with Align OFF the sheet and the
    //     roll still overlap by ~82% and CANNOT disagree by the asserted 320px. "The panes are
    //     free to disagree" was failing because there was no room left to disagree in.
    //   - the sheet's entire horizontal scroll range came to ~20px against the ~402px the seek
    //     needed, so `sheetErrorPx` could never come under 80 however correctly Align behaved.
    //
    // Both numbers are properties of the FIXTURE, not of the feature, which is why the fix is
    // to restore the fixture the assertions describe rather than to weaken them. Same two
    // lines the second pass further down uses, and for the same reason.
    phase('restoring the main demo for the align checks', READY_TIMEOUT_MS + 10_000);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?${TARGET_QUERY}` });
    await waitForReady('triplet demo (align pass)', READY_EXPRESSION, READY_TIMEOUT_MS);
    await settle(1200);

    phase('checking Align, Listen again and in-page confirms', 100_000);

    // ALIGN. The chip that used to put the roll on the sheet's engraved x-axis; that mode is
    // deleted (adding one note re-spaced its neighbours) and the chip now means "keep all four
    // views on the same moment". So there are two claims and they pull in opposite directions:
    // clicking a moment MUST move the sheet, and it must move NOTHING on the roll.
    result.alignDefault = await evalJson(
      `window.__RIFFSHEET_ALIGN__
        ? window.__RIFFSHEET_ALIGN__('probe').then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) }))
        : Promise.resolve('null')`,
      45_000
    );
    result.alignOn = await evalJson(
      `window.__RIFFSHEET_ALIGN__
        ? window.__RIFFSHEET_ALIGN__('on').then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) }))
        : Promise.resolve('null')`,
      60_000
    );
    await settle(600);
    // `__RIFFSHEET_ALIGN__('off')` and `__RIFFSHEET_ALIGNX__('off')` stood here. Both modes are
    // deleted with the setting they flipped (G11) — there is no unaligned state left to drive,
    // and a probe that pretended to produce one would be measuring a mode the app cannot enter.
    // VERTICAL CORRESPONDENCE, on and off. The claim Align makes to the eye — a note's sheet x,
    // roll x and waveform x are one column — measured on three notes spread across the span.
    result.alignXOn = await evalJson(
      `window.__RIFFSHEET_ALIGNX__
        ? window.__RIFFSHEET_ALIGNX__().then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) }))
        : Promise.resolve('null')`,
      60_000
    );
    await settle(600);
    // The chip was pressed twice here, so the control and not only the setting was exercised.
    // There is no control (G11), so what is left is the claim the presses were really guarding:
    // NEITHER PANE CAN BE PUT ON THE SHEET'S ENGRAVED X-AXIS. That is a property of the roll and
    // the strip, not of a chip, and it is read straight off them.
    result.linkOff = await evalJson(ROLL);

    // START OVER, WHICH USED TO BE "LISTEN AGAIN" IN THE TOOLBAR.
    //
    // The header button is RETIRED (#10): a permanent control for a rare gesture, in the row
    // that has to survive REAPER's 390px docked FX window, doing the thing that is now the
    // ordinary consequence of choosing an engine. What is left of it lives in the Main menu
    // beside the other deliberate acts. Both halves are asserted — gone from there, working
    // from here — because "we moved it" is only true if both are.
    result.retranscribeEntry = await evalJson(`(() => {
      const header = document.querySelector('.app-header');
      return JSON.stringify({
        inToolbar: !!document.querySelector('[data-role="retranscribe"]'),
        headerText: header ? (header.textContent || '').trim() : '',
        toastsBefore: document.querySelectorAll('.toast').length
      });
    })()`);

    // In the Main menu, on the row that describes the open take.
    result.retranscribeMenuOpen = await evalJson(clickRole('main-menu'));
    await settle(700);
    result.retranscribeMenu = await evalJson(`(() => {
      const b = document.querySelector('[data-role="retranscribe-menu"]');
      const r = b ? b.getBoundingClientRect() : null;
      const row = document.querySelector('[data-role="main-menu-current"]');
      return JSON.stringify({
        present: !!b,
        inCurrentWorkRow: !!row && !!b && row.contains(b),
        text: b ? b.textContent.trim() : null,
        onScreen: !!r && r.width > 0 && r.right <= window.innerWidth + 1 && r.left >= -1
      });
    })()`);
    // Pressing it has to reach the app and produce an answer. The demo's handle is genuinely
    // gone, so the answer is the explanation — what is asserted is that SOMETHING happened and
    // that it took us back to the sheet rather than leaving us in the menu.
    result.retranscribeClick = await evalJson(clickRole('retranscribe-menu'));
    await settle(900);
    result.retranscribeAfter = await evalJson(`(() => {
      const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim());
      return JSON.stringify({
        toasts,
        count: toasts.length,
        backOnSheet: !!document.querySelector('.app-header')
      });
    })()`);
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.toast button').forEach(b => b.click())`,
      returnByValue: true
    });
    await settle(300);

    // IN-PAGE CONFIRMS. `window.confirm()` returns false in a WKWebView with no UI delegate,
    // in silence, and the shell has none — so every yes/no question this app asked was
    // answered "no" by nobody. That is what "the Listen again button does not work" was. The
    // dialog must be a real element in the page, and Cancel must leave the take alone.
    result.confirmOpen = await evalJson(`(() => {
      const menu = document.querySelector('[data-role="main-menu"]');
      if (menu) menu.click();
      return JSON.stringify({ opened: !!menu });
    })()`);
    await settle(700);
    result.confirmClose = await evalJson(clickRole('close-current'));
    await settle(700);
    result.confirmDialog = await evalJson(`(() => {
      const d = document.querySelector('[data-role="confirm-dialog"]');
      return JSON.stringify({
        present: !!d,
        message: d ? (d.querySelector('[data-role="confirm-message"]')?.textContent ?? '') : null,
        hasOk: !!d?.querySelector('[data-role="confirm-ok"]'),
        hasCancel: !!d?.querySelector('[data-role="confirm-cancel"]')
      });
    })()`);
    result.confirmCancel = await evalJson(clickRole('confirm-cancel'));
    await settle(700);
    result.confirmAfterCancel = await evalJson(`(() => JSON.stringify({
      dialogGone: !document.querySelector('[data-role="confirm-dialog"]'),
      stillHasWork: !!window.__RIFFSHEET_PIANOROLL__ && !!window.__RIFFSHEET_PIANOROLL__().roll
    }))()`);

    // =====================================================================================
    // NIGHT WAVE 2 — the controls that were added, moved or deleted this wave.
    //
    // Ordered by how destructive they are, gently first: reading the transport pair and the
    // tempo unit changes nothing, the grid warning changes a setting and puts it back, and
    // the engine gestures re-transcribe the take, so they go last.
    // =====================================================================================
    phase('checking undo/redo buttons, the tempo unit and the grid warning', 120_000);

    // BACK TO THE TRIPLET DEMO, ON A FRESH PAGE.
    //
    // Two reasons, and both matter. The phases above left the app on the main menu, in
    // simulated-plugin mode, holding the two-bar STRAIGHT fixture at the mock DAW's 222 BPM in
    // 3/6 — none of which is the state these checks are about. And the grid warning has to be
    // exercised on the fixture that actually breaks: a triplet figure, where a 1/4 notation
    // grid has nowhere to put the second and third note of each triplet.
    //
    // A reload also resets the mock's own memory (what is installed, whether the borrowed
    // listener is up), which is what the engine checks below need to be able to assume.
    // `?demo=` returns before `restoreSession()`, so the resume prompt cannot fire here.
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?${TARGET_QUERY}` });
    await waitForReady('triplet demo (second pass)', READY_EXPRESSION, READY_TIMEOUT_MS);
    await settle(1200);

    /** The pair, and whether they are drawn rather than typed. */
    const UNDO_PAIR = `(() => {
      const read = (role) => {
        const b = document.querySelector('[data-role="' + role + '"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const svg = b.querySelector('svg');
        return {
          present: true,
          disabled: b.disabled,
          onScreen: r.width > 0 && r.height > 0 && r.right <= window.innerWidth + 1 && r.left >= -1,
          w: Math.round(r.width),
          h: Math.round(r.height),
          // DRAWN, not a text glyph: an <svg> with real paths in it, stroked heavily enough
          // to read as a button rather than as a hairline.
          hasSvg: !!svg,
          paths: svg ? svg.querySelectorAll('path, polyline').length : 0,
          strokeWidth: svg ? Number(svg.getAttribute('stroke-width') || 0) : 0,
          text: (b.textContent || '').trim()
        };
      };
      const undo = document.querySelector('[data-role="undo"]');
      const transport = document.querySelector('.transport');
      return JSON.stringify({
        undo: read('undo'),
        redo: read('redo'),
        // "Near transport" is a claim about where it is, so it is measured rather than assumed.
        inTransport: !!transport && !!undo && transport.contains(undo)
      });
    })()`;

    result.undoPairAtRest = await evalJson(UNDO_PAIR);
    // Make one edit through the roll, so both ends of the stack get visited.
    result.undoPairEdit = await evalJson(dragRollNote(0, -18));
    await settle(700);
    result.undoPairAfterEdit = await evalJson(UNDO_PAIR);
    result.undoPairUndoClick = await evalJson(clickRole('undo'));
    await settle(700);
    result.undoPairAfterUndo = await evalJson(UNDO_PAIR);
    result.undoPairRollAfterUndo = await evalJson(ROLL);
    result.undoPairRedoClick = await evalJson(clickRole('redo'));
    await settle(700);
    result.undoPairAfterRedo = await evalJson(UNDO_PAIR);
    // And back, so nothing downstream inherits the probe's edit.
    await evalJson(clickRole('undo'));
    await settle(600);

    // THE TEMPO UNIT, and the thing it must NOT do.
    //
    // The box shows the tempo in the beat the signature is written in, so 4/4 -> 6/8 turns
    // "120" into "240". That is a relabelling, and the only way to prove it is a relabelling
    // is to compare what the app would SCHEDULE either side of the switch. The probe dumps
    // `synthNotesFor()` — the exact list handed to the thing that makes sound — and puts the
    // signature back.
    result.tempoUnit = await evalJson(
      `window.__RIFFSHEET_TEMPOUNIT__
        ? JSON.stringify(window.__RIFFSHEET_TEMPOUNIT__(6, 8))
        : 'null'`,
      60_000
    );
    await settle(800);

    // THE COARSE-GRID WARNING, on the fixture that breaks. The demo is a triplet figure and a
    // 1/4 notation grid has nowhere to put the second and third note of each triplet.
    result.gridWarnBefore = await evalJson(`(() => {
      const w = document.querySelector('[data-role="grid-too-coarse"]');
      return JSON.stringify({ shown: !!w, text: w ? w.textContent.trim() : null });
    })()`);
    result.gridWarnSet = await evalJson(setSelect('notation-grid', 'quarter'));
    await settle(1600);
    result.gridWarnCoarse = await evalJson(`(() => {
      const w = document.querySelector('[data-role="grid-too-coarse"]');
      const grid = document.querySelector('[data-role="notation-grid"]');
      const r = w ? w.getBoundingClientRect() : null;
      const gr = grid ? grid.getBoundingClientRect() : null;
      const self = window.__RIFFSHEET_SELFTEST__ ? window.__RIFFSHEET_SELFTEST__() : null;
      return JSON.stringify({
        shown: !!w,
        text: w ? w.textContent.trim() : null,
        // "Near the grid control" is measured: same row, within a couple of hundred px of it.
        nearGrid: !!r && !!gr && Math.abs(r.top - gr.top) < 40 && r.left > gr.left,
        engravedNotes: self ? self.noteGlyphs : null
      });
    })()`);
    // A grid that fits has nothing to warn about, and the line has to go away again.
    result.gridWarnFineSet = await evalJson(setSelect('notation-grid', 'triplet'));
    await settle(1600);
    result.gridWarnFine = await evalJson(`(() => {
      const w = document.querySelector('[data-role="grid-too-coarse"]');
      const self = window.__RIFFSHEET_SELFTEST__ ? window.__RIFFSHEET_SELFTEST__() : null;
      return JSON.stringify({
        shown: !!w,
        engravedNotes: self ? self.noteGlyphs : null
      });
    })()`);
    // Back to the DEFAULT, which is 'auto' again since settings v11 — everything after this expects
    // the sheet the app opens with.
    await evalJson(setSelect('notation-grid', 'auto'));
    await settle(1400);

    // --- the engine cards, second pass: detail block, RAM row, existing installs ---------
    phase('checking the engine card detail, model row and existing-install path', 90_000);
    await evalJson(GEAR_CLICK);
    await settle(1400);

    const CARD_DETAIL = `(() => {
      const card = (id) => document.querySelector('[data-role="engine-card"][data-engine-id="' + id + '"]');
      const text = (root, sel) => {
        const e = root && root.querySelector(sel);
        return e ? (e.textContent || '').trim() : null;
      };
      const read = (id) => {
        const c = card(id);
        if (!c) return null;
        return {
          strengths: text(c, '[data-role="engine-card-strengths"]'),
          cost: text(c, '[data-role="engine-card-cost"]'),
          source: text(c, '[data-role="engine-card-source"]'),
          license: text(c, '[data-role="engine-card-license"]'),
          ram: text(c, '[data-role="engine-card-model-ram"]'),
          hasModelSelect: !!c.querySelector('[data-role="engine-model"]'),
          hasUseExisting: !!c.querySelector('[data-role="engine-use-existing"]'),
          scrollW: c.scrollWidth,
          clientW: c.clientWidth
        };
      };
      const group = document.querySelector('[data-role="engine-setup-group"]');
      return JSON.stringify({
        basic: read('basic-pitch'),
        mu: read('muscriptor'),
        bass: read('bass-v2'),
        transkun: read('transkun'),
        // The old standalone Model row lived in the "Transcription engine" group, ABOVE the
        // setup group. If one is still there, the control was copied rather than moved.
        modelSelectsOnPanel: document.querySelectorAll('[data-role="engine-model"]').length,
        modelSelectsInSetupGroup: group ? group.querySelectorAll('[data-role="engine-model"]').length : 0
      });
    })()`;

    result.cardDetail = await evalJson(CARD_DETAIL);

    // "Use existing installation…" — the sniff, then a path that is refused, then one that is
    // accepted. All three through the one native call the contract defines.
    result.existingOpen = await evalJson(clickInCard('transkun', 'engine-use-existing'));
    await settle(500);
    result.existingPanel = await evalJson(`(() => {
      const c = document.querySelector('[data-role="engine-card"][data-engine-id="transkun"]');
      return JSON.stringify({
        hasSniff: !!c?.querySelector('[data-role="engine-existing-sniff"]'),
        hasPath: !!c?.querySelector('[data-role="engine-existing-path"]'),
        hasCheck: !!c?.querySelector('[data-role="engine-existing-check"]')
      });
    })()`);
    result.existingSniff = await evalJson(clickInCard('transkun', 'engine-existing-sniff'));
    await settle(900);
    result.existingAfterSniff = await evalJson(`(() => {
      const c = document.querySelector('[data-role="engine-card"][data-engine-id="transkun"]');
      const said = c?.querySelector('[data-role="engine-existing-said"]');
      const box = c?.querySelector('[data-role="engine-existing-path"]');
      return JSON.stringify({
        said: said ? said.textContent.trim() : null,
        // The sniff FILLS the box rather than adopting silently — you see where before
        // anything is used.
        path: box ? box.value : null
      });
    })()`);

    // A location with no engine in it. The refusal has to say what was wrong.
    result.existingBadType = await evalJson(`(() => {
      const c = document.querySelector('[data-role="engine-card"][data-engine-id="transkun"]');
      const box = c?.querySelector('[data-role="engine-existing-path"]');
      if (!box) return JSON.stringify({ typed: false });
      box.value = '/Users/somebody/Music';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return JSON.stringify({ typed: true });
    })()`);
    result.existingBadCheck = await evalJson(clickInCard('transkun', 'engine-existing-check'));
    await settle(900);
    result.existingAfterBad = await evalJson(`(() => {
      const c = document.querySelector('[data-role="engine-card"][data-engine-id="transkun"]');
      const said = c?.querySelector('[data-role="engine-existing-said"]');
      const dot = said?.querySelector('.dot');
      return JSON.stringify({
        said: said ? said.textContent.trim() : null,
        warned: !!dot && dot.classList.contains('warn'),
        state: c?.getAttribute('data-engine-state') ?? null
      });
    })()`);

    // ...and a real one, which makes the card behave exactly as it does after an install.
    result.existingGoodType = await evalJson(`(() => {
      const c = document.querySelector('[data-role="engine-card"][data-engine-id="transkun"]');
      const box = c?.querySelector('[data-role="engine-existing-path"]');
      if (!box) return JSON.stringify({ typed: false });
      box.value = '/opt/transkun';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return JSON.stringify({ typed: true });
    })()`);
    result.existingGoodCheck = await evalJson(clickInCard('transkun', 'engine-existing-check'));
    await settle(1200);
    result.existingAfterGood = await evalJson(`(() => {
      const c = document.querySelector('[data-role="engine-card"][data-engine-id="transkun"]');
      return JSON.stringify({
        state: c?.getAttribute('data-engine-state') ?? null,
        hasUninstall: !!c?.querySelector('[data-role="engine-uninstall"]'),
        // The offer is withdrawn once there is nothing left to point at.
        hasUseExisting: !!c?.querySelector('[data-role="engine-use-existing"]')
      });
    })()`);

    // The two preprocessing switches, in plain speak (#20).
    result.preprocessCopy = await evalJson(`(() => {
      const label = (role) => {
        const input = document.querySelector('[data-role="' + role + '"]');
        const span = input?.closest('label')?.querySelector('span');
        return span ? span.textContent.trim() : null;
      };
      const note = (role) => {
        const n = document.querySelector('[data-role="' + role + '"]');
        return n ? n.textContent.trim() : null;
      };
      return JSON.stringify({
        level: label('preprocess-normalize'),
        tuning: label('preprocess-tuning'),
        levelNote: note('preprocess-normalize-note'),
        tuningNote: note('preprocess-tuning-note'),
        receipt: !!document.querySelector('[data-role="preprocess-result-note"]') ||
          note('preprocess-normalize-note') !== null
      });
    })()`);

    await evalJson(GEAR_CLICK);
    await settle(500);

    // --- the two-step engine stop (#5-web) ----------------------------------------------
    phase('checking the external-engine stop and the engine-click gesture', 120_000);

    // G17 FIRST, BEFORE THE CHIP IS CLICKED — a stop would change every number in it.
    result.engineChip = await evalJson(
      `JSON.stringify(window.__RIFFSHEET_ENGINECHIP__ ? window.__RIFFSHEET_ENGINECHIP__() : null)`
    );
    result.engineChipStop = await evalJson(`(() => {
      const chip = document.querySelector('[data-role="engine-chip"]');
      if (!chip) return JSON.stringify({ present: false });
      chip.click();
      return JSON.stringify({ present: true, hidden: chip.style.display === 'none' });
    })()`);
    await settle(900);
    result.leftRunning = await evalJson(`(() => {
      const toasts = [...document.querySelectorAll('.toast')];
      const withButton = toasts.find((t) => t.querySelector('[data-role="stop-external-engine"]'));
      return JSON.stringify({
        count: toasts.length,
        texts: toasts.map((t) => t.textContent.trim()),
        hasStopAnyway: !!withButton,
        label: withButton
          ? withButton.querySelector('[data-role="stop-external-engine"]').textContent.trim()
          : null
      });
    })()`);
    result.stopAnywayClick = await evalJson(clickRole('stop-external-engine'));
    await settle(900);
    result.afterStopAnyway = await evalJson(`(() => {
      const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim());
      return JSON.stringify({ toasts, count: toasts.length });
    })()`);
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.toast button[aria-label="Dismiss"]').forEach(b => b.click())`,
      returnByValue: true
    });
    await settle(400);

    // --- clicking an engine transcribes with it (#10) -----------------------------------
    //
    // Two claims, and the second is the one that was broken: a press must never be a silent
    // no-op, and a press that would discard edits must ask first. Driven on the MAIN MENU
    // picker, whose chips are the same gesture as the cards' "Use this engine".
    //
    // A REAL RECORDING FIRST. The demo fixtures are note lists with no audio behind them, so
    // "re-read this take" cannot happen on one — the app correctly says so instead, which
    // proves the never-silent half and nothing about the transcribe half. This opens two
    // seconds of WAV through `openFile()`, the same door a drop uses.
    result.engineClickOpen = await evalJson(
      `window.__RIFFSHEET_OPENAUDIO__
        ? window.__RIFFSHEET_OPENAUDIO__().then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) }))
        : Promise.resolve('null')`,
      60_000
    );
    await settle(1200);
    //
    // An edit is made ON PURPOSE next. The confirm path only exists when there is something
    // to discard, and a probe that happened to run against a clean take would pass by
    // accident and prove nothing about the question it is meant to be asking.
    result.engineClickEdit = await evalJson(dragRollNote(0, -18));
    await settle(700);
    result.engineClickMenu = await evalJson(clickRole('main-menu'));
    await settle(800);
    result.engineClickBefore = await evalJson(`(() => JSON.stringify({
      transcribeCount: window.__RIFFSHEET_MOCKBRIDGE__
        ? window.__RIFFSHEET_MOCKBRIDGE__().transcribeCount
        : null,
      toasts: document.querySelectorAll('.toast').length
    }))()`);
    result.engineClickPress = await evalJson(`(() => {
      const chip = document.querySelector('[data-role="engine-pick"] .chip[data-engine-id="basic-pitch"]');
      if (!chip) return JSON.stringify({ clicked: false });
      chip.click();
      return JSON.stringify({ clicked: true });
    })()`);
    await settle(900);
    // With edits on the take, the press has to put the question up BEFORE anything happens.
    result.engineClickDialog = await evalJson(`(() => {
      const d = document.querySelector('[data-role="confirm-dialog"]');
      return JSON.stringify({
        present: !!d,
        message: d ? (d.querySelector('[data-role="confirm-message"]')?.textContent ?? '') : null,
        okText: d ? (d.querySelector('[data-role="confirm-ok"]')?.textContent ?? '') : null
      });
    })()`);
    result.engineClickConfirm = await evalJson(clickRole('confirm-ok'));
    await settle(2500);
    result.engineClickAfter = await evalJson(`(() => {
      const mock = window.__RIFFSHEET_MOCKBRIDGE__ ? window.__RIFFSHEET_MOCKBRIDGE__() : null;
      const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim());
      return JSON.stringify({
        // The bridge itself counts them. "Something was sent at some point in this run" would
        // have been true before the button was pressed, so the count is what makes this a
        // claim about THIS press.
        transcribeCount: mock ? mock.transcribeCount : null,
        toasts,
        onSheet: !!document.querySelector('.app-header')
      });
    })()`);

    // CLICKING AN ENGINE WHILE A JOB IS RUNNING. The board's case, and the one that cannot be
    // reached by clicking alone: the gesture has to CANCEL what is in flight and start a new
    // reading, rather than queueing behind it or — as it used to — returning in silence
    // because `retranscribe()` saw `progress !== null` and gave up.
    //
    // Both halves are counted at the bridge: `cancelCount` only rises when a running job was
    // actually abandoned between two of its own progress frames, and `transcribeCount` only
    // rises when a new one was started.
    result.engineBusyStart = await evalJson(
      `window.__RIFFSHEET_STARTJOB__
        ? window.__RIFFSHEET_STARTJOB__().then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) }))
        : Promise.resolve('null')`,
      30_000
    );
    result.engineBusyBefore = await evalJson(`(() => {
      const m = window.__RIFFSHEET_MOCKBRIDGE__ ? window.__RIFFSHEET_MOCKBRIDGE__() : null;
      return JSON.stringify({
        inFlight: m ? m.transcribeInFlight : null,
        cancels: m ? m.cancelCount : null,
        transcribes: m ? m.transcribeCount : null
      });
    })()`);
    result.engineBusyMenu = await evalJson(clickRole('main-menu'));
    await settle(400);
    result.engineBusyPress = await evalJson(`(() => {
      const chip = document.querySelector('[data-role="engine-pick"] .chip[data-engine-id="basic-pitch"]');
      if (!chip) return JSON.stringify({ clicked: false });
      chip.click();
      return JSON.stringify({ clicked: true });
    })()`);
    await settle(500);
    // The take may or may not carry edits by now, so the question may or may not be asked.
    // Answering it when it is there is not the claim under test; what happens after it is.
    result.engineBusyConfirm = await evalJson(clickRole('confirm-ok'));
    await settle(3000);
    result.engineBusyAfter = await evalJson(`(() => {
      const m = window.__RIFFSHEET_MOCKBRIDGE__ ? window.__RIFFSHEET_MOCKBRIDGE__() : null;
      return JSON.stringify({
        cancels: m ? m.cancelCount : null,
        transcribes: m ? m.transcribeCount : null,
        onSheet: !!document.querySelector('.app-header')
      });
    })()`);
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.toast button[aria-label="Dismiss"]').forEach(b => b.click())`,
      returnByValue: true
    });
    await settle(300);

    // --- the resume prompt (#25) ---------------------------------------------------------
    phase('checking the resume-or-start-fresh prompt', 120_000);
    result.resumePrompt = await evalJson(
      `window.__RIFFSHEET_RESUMEPROMPT__
        ? window.__RIFFSHEET_RESUMEPROMPT__().then(r => JSON.stringify(r), e => JSON.stringify({ error: String(e) }))
        : Promise.resolve('null')`,
      110_000
    );

    const layouts = [
      ['wide', result.namesLayout],
      ['1100x700', result.mid?.layout],
      ['900x600', result.narrow?.layout],
      ['droptuned', result.dropTuned?.layout]
    ];
    const namesClearOf = (what) =>
      layouts.every(([, l]) => !!l && l.hasSplit && l.labels > 0 && what(l));
    const drop = result.dropTuned?.layout;
    const clickPos = result.rollAfterClick;
    const ed = result.editSync;
    const editOk = !!ed && !ed.error;
    /** Every pane height the run visited, so a label rule is checked at all of them. */
    const rollStates = [
      ['default', result.rollResizeBase],
      ['tall', result.rollTall],
      ['ceiling', result.rollHuge],
      ['floor', result.rollShort],
      ['1100x700', result.mid?.roll],
      ['900x600', result.narrow?.roll]
    ];
    const everyRollState = (what) => rollStates.every(([, s]) => !!s?.roll && what(s.roll, s));
    const LABEL_RE = /^[A-G]#?-?\d$/;
    /** Drawn labels are whole octaves apart; the px between them is what has to stay legible. */
    /**
     * Thinning, not shrinking.
     *
     * The rule has not changed — two labels closer together than their own type size are two
     * smudges — but what gets labelled has: the gutter now names every row it can read, not
     * only the octave C's, so the gap between consecutive labels has to be measured in
     * SEMITONES rather than assumed to be twelve of them. Measuring it the old way scored
     * adjacent semitone labels as zero pixels apart and called a working column broken.
     */
    const labelGapOk = (r) => {
      const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
      const midi = (name) => {
        const m = /^([A-G])(#?)(-?\d+)$/.exec(name);
        if (!m) return null;
        return STEP[m[1]] + (m[2] ? 1 : 0) + (Number(m[3]) + 1) * 12;
      };
      for (let i = 1; i < r.labels.length; i++) {
        const a = midi(r.labels[i - 1]);
        const b = midi(r.labels[i]);
        if (a === null || b === null) return false;
        // 8px is the smallest type the gutter draws; two baselines closer than that touch.
        if (r.rowHeight * Math.abs(b - a) < 8) return false;
      }
      return true;
    };

    /**
     * The three funding channels that were checked against the upstreams' own sites, and the
     * order the credits list is meant to read in. Both are written out here rather than derived
     * from the page, so that changing either one in the app is a decision somebody has to come
     * and make here as well.
     */
    const VERIFIED_MONEY = [
      'https://paypal.me/versilian',
      'https://opencollective.com/haxe',
      'https://xiph.org/donate/'
    ];
    const SUPPORT_ORDER = [
      'versilian', 'musescore', 'alphatab',
      'haxe', 'xiph',
      'basic-pitch', 'beat-this', 'transkun', 'muscriptor', 'bass-v2',
      'juce', 'bravura'
    ];
    const support = result.support;
    const supportRow = (id) => (support?.rows ?? []).find((r) => r.id === id) ?? null;
    const supportLinks = (support?.rows ?? []).filter((r) => r.href !== null);

    /**
     * Settings with nowhere to change them.
     *
     * A key counts as reachable if a live `[data-setting]` control for it was on screen in
     * EITHER census — the second one exists because the custom-tuning box and its string count
     * are drawn only for a custom tuning — or if it is on the documented off-screen list with
     * the reason it is not a control.
     */
    const censusFound = {
      ...(result.settingsCensus?.found ?? {}),
      ...(result.settingsCensusCustom?.found ?? {})
    };
    const unreachableSettings = settingKeys.filter(
      (key) => !(censusFound[key] > 0) && !(key in SETTINGS_OFF_SCREEN)
    );
    result.settingsSweep = {
      keys: settingKeys,
      reachable: settingKeys.filter((key) => censusFound[key] > 0),
      offScreen: SETTINGS_OFF_SCREEN,
      unreachable: unreachableSettings
    };
    // Named in the log as well as in the payload: a FAIL that only says "some setting" is a
    // FAIL somebody has to re-run the whole harness to understand.
    if (unreachableSettings.length > 0) {
      console.log(`\nsettings with no control on screen: ${unreachableSettings.join(', ')}`);
    }

    // The three transcribe probes, each read twice: what the app SENT, and what the bridge
    // itself says ARRIVED. Kept side by side so a check can compare the two.
    const pre = result.transcribeProbe;
    const preSeen = result.transcribeSeen?.lastTranscribeOptions;
    const preOn = result.transcribeProbeOn;
    const preOnSeen = result.transcribeSeenOn?.lastTranscribeOptions;
    const preEngine = result.transcribeProbeEngine;
    const preEngineSeen = result.transcribeSeenEngine?.lastTranscribeOptions;

    const checks = [
      ['main screen rendered', result.screen === 'main'],
      [
        // Was ">= 3": MIDI, MusicXML and PDF each had a button, and "Save as Riffsheet" was
        // adrift in the main menu. They are ONE Export menu now (#11) — four permanent buttons
        // for something done at the end of a session was a poor trade on a bar that has to
        // survive 360 px — so the assertion is that the menu button is there and that it still
        // knows it is a MIDI drag source, which is the one thing folding them could have lost.
        'header + Export menu',
        result.header && result.exportMenuButton === true && result.exportMenuIsMenu === true &&
          result.exportMenuOwnsMidiMode === true && result.legacyExportButtons === 0
      ],
      ['main menu replaces Open', result.mainMenuButton && result.legacyOpenButtons === 0],
      // WAS: 'the Align control is on screen' (linkedControls === 1). Inverted again, and this
      // is the last time — G11 makes alignment unconditional. The history is worth keeping in
      // one place: it was 0 when the linked mode was deleted, then 1 when the player reported
      // the loss ("the link button also disappeared. i cant link midi/musicsheet/tab/
      // soundwave"), and it is 0 now because what the player wanted back is simply how the app
      // behaves. The BEHAVIOUR they asked for is checked harder than before — see the align
      // block below, which no longer has an off state to weaken it.
      ['the Align control is gone and alignment is unconditional', result.linkedControls === 0],
      // G13. "Fit" was retired once and came back by mistake on the horizontal zoom pair.
      ['zoom: no Fit button on the roll’s time axis', result.rollTimeFitButton === false],
      [
        // G7. The axes say their names. Two captions, spelled out, in the order the pairs sit
        // in — the glyphs they replaced were unreadable at the plugin's zoom steps.
        'zoom: the two axes are labelled in words',
        JSON.stringify(result.zoomAxisLabels ?? []) === JSON.stringify(['Vertical', 'Horizontal'])
      ],
      // G12. Choosing "From recording" re-detects, and every take edit re-detects again.
      ['tempo source: the Re-detect button is gone', result.tempoRedetectButton === false],
      ['notation controls live beside the notation', result.notationToolbar],
      [
        // Was: the ".tuning-summary" row read "Tuning low → high: E1 A1 D2 G2". That row is
        // gone and the letters are on the staff lines themselves, on every system and in the
        // PDF — so the assertion moved to what replaced it rather than being dropped. Top line
        // first, so a standard 4-string bass reads G2 D2 A1 E1 down the staff.
        'TAB fixture is visibly set to bass',
        result.tabView === 'bass' && result.stringLetters === 'G2 D2 A1 E1'
      ],
      [
        // ALWAYS, including standard tuning: their absence must not be the thing that means
        // "standard", because that is only readable by somebody who already knew.
        'string letters: one per string, named on every tab line',
        result.stringLetterCount === 4
      ],
      // --- two grids, and the roll's one never touches the transcription ----------------
      //
      // The user's rule, in their own words: "the grid was supposed to not meddle with how
      // the notes were written from audio recording... it was supposed to only help when
      // added a new note manually. But if it is transcribing from audio, it should not
      // quantize or snap at all."
      //
      // Until this split there was ONE control. Asking for 1/4 cells to draw notes into also
      // told the quantizer that a quarter was the shortest thing it was allowed to write, and
      // a default of 1/8 silently deleted the third note of every triplet in the demo.
      [
        'grids: notation and piano roll are separate controls',
        typeof result.notationGridView === 'string' && result.notationGridView.length > 0 &&
          typeof result.rollGridView === 'string' && result.rollGridView.length > 0
      ],
      [
        // AUTO IS THE DEFAULT AGAIN (G6, settings v11). This check has been both ways round:
        // 'auto' until v10, 'free' after it, and back now. The reason for the return is in
        // DEFAULT_SETTINGS.grid and the v11 case in `migrate()` — 'free' and 'auto' engrave
        // straight material identically, so v10 bought those takes nothing, while a triplet
        // performance came out of 'free' with 38 rests and 34 ties on the first page anybody
        // ever sees. Free is still offered for every take (the check below) and is one press
        // away; what changed is which of the two somebody meets without asking.
        'grids: notation offers Auto, and starts on it',
        (result.notationGridOptions ?? []).includes('auto') && result.notationGridView === 'auto'
      ],
      [
        // THE ORDER IS FINENESS (G6). Triplet (1/12) is finer than an eighth and coarser than a
        // sixteenth, and it had been sitting after 1/32 as if it were the finest thing on offer.
        'grids: the Quantize menu runs coarse to fine, with Triplet in its place',
        JSON.stringify(result.notationGridOptions ?? []) ===
          JSON.stringify(['auto', 'quarter', 'eighth', 'triplet', 'sixteenth', 'thirtysecond', 'free'])
      ],
      [
        // FREE IS OFFERED FOR EVERY TAKE. It was the default under v10 and is not under v11
        // (see above); what this check is about is that it is OFFERED at all.
        //
        // This check asserted the OPPOSITE until #36, on a measurement that has since stopped
        // being true: 'free' used to engrave 64 played notes as 192 glyphs with 192 ties, which
        // was a trap rather than a setting. The pipeline's 'free' is a 1:1 pass-through now —
        // re-measured at 64 played -> 64 glyphs / 0 rests / 0 ties on the straight fixture,
        // identical to 'auto' — so the reason for hiding it is gone, and a default the player
        // cannot select again after moving off it would be incoherent.
        //
        // `scripts/roll-snap-test.ts` §8 holds the numbers, so a regression in the pipeline's
        // 'free' fails there with an arithmetic reason rather than here with a missing option.
        'grids: Free is offered for every take',
        (result.notationGridOptions ?? []).includes('free') &&
          (result.notationGridOptions ?? []).length >= 6
      ],
      [
        // And the roll must NOT offer it: its grid is a stated cell size for drawing into.
        'grids: the roll has no Auto to infer',
        (result.rollGridOptions ?? []).length >= 5 && !(result.rollGridOptions ?? []).includes('auto')
      ],
      [
        // G14. The roll's ruler grew 1/32 and an Off that draws bar lines only, and Triplet
        // moved between 1/8 and 1/16 for the same reason it did in the Quantize menu. The exact
        // value keys are asserted, not the labels: the shell, the saved document and
        // `rollSnapUnitSec` all key on these words.
        'grids: the roll offers 1/32 and Off, in fineness order',
        JSON.stringify(result.rollGridOptions ?? []) ===
          JSON.stringify(['quarter', 'eighth', 'triplet', 'sixteenth', 'thirtysecond', 'free', 'off'])
      ],
      [
        'grids: changing the roll grid changes the roll',
        !!result.rollGridBefore && !!result.rollGridAfter &&
          result.rollGridAfter.snapSec > result.rollGridBefore.snapSec
      ],
      [
        // THE POINT OF THE WHOLE SPLIT. Same score object, byte for byte, through both
        // exporters — so this cannot pass by the sheet merely looking similar.
        'grids: changing the roll grid changes NOTHING on the sheet',
        !!result.gridBefore && !!result.gridAfterRollChange &&
          result.gridAfterRollChange.noteGlyphs === result.gridBefore.noteGlyphs &&
          result.gridAfterRollChange.bars === result.gridBefore.bars &&
          result.gridAfterRollChange.restDensity === result.gridBefore.restDensity &&
          result.gridAfterRollChange.musicxmlBytes === result.gridBefore.musicxmlBytes &&
          result.gridAfterRollChange.midiQuantizedBytes === result.gridBefore.midiQuantizedBytes
      ],
      [
        // The other half. A split that left both controls inert would pass everything above.
        'grids: changing the NOTATION grid does re-write the sheet',
        !!result.gridBefore && !!result.gridAfterNotationChange &&
          result.gridAfterNotationChange.noteGlyphs !== result.gridBefore.noteGlyphs
      ],
      [
        'grids: putting the notation grid back restores the score',
        !!result.gridBefore && !!result.gridRestored &&
          result.gridRestored.noteGlyphs === result.gridBefore.noteGlyphs &&
          result.gridRestored.musicxmlBytes === result.gridBefore.musicxmlBytes
      ],
      [
        'sound picker exposes recorded instruments only',
        result.soundChoices.length > 0 &&
          result.soundChoices.every((o) => !['bass', 'piano', 'pad'].includes(o.value))
      ],
      ['settings gear', result.settingsGear],

      // --- engine setup: guide and find, never install --------------------------------
      //
      // The screen a player with no engine lands on. Each check is one thing they need from
      // it, and none of them can pass on a screen that merely exists: the status has to name
      // a state, the searched list has to be REAL paths, Check again has to change something.
      ['engine setup: the panel opened on the setup group', !!result.engineSetup?.panelOpen && !!result.engineSetup.group],
      [
        'engine setup: says whether an engine was found',
        typeof result.engineSetup?.status === 'string' && result.engineSetup.status.length > 20
      ],
      [
        // The promise this screen makes. If the copy ever turns into "installing…", this fails.
        // Read off the UNFOLDED guide, which is where the policy line lives.
        'engine setup: says out loud that it installs nothing',
        typeof result.engineSetup?.policy === 'string' && /install/i.test(result.engineSetup.policy)
      ],
      [
        // #7-web. Instructions for installing something that is installed are the clearest
        // possible sign the app has not noticed what is on the machine. Not folded — absent.
        'engine setup: an installed engine shows no setup guide at all',
        result.engineSetupInstalled?.hasGuideToggle === false &&
          (result.engineSetupInstalled?.steps ?? []).length === 0 &&
          result.engineSetupInstalled?.hasToggle === false &&
          // The status line still says where it was found, and Check again is still there:
          // "look again, now" outlives setup.
          /found at/i.test(result.engineSetupInstalled?.status ?? '') &&
          result.engineSetupInstalled?.hasRecheck === true
      ],
      [
        // ...and when it is NOT installed, the guide is behind one button rather than being
        // the first thing under the best engine's name. Five numbered steps, a nine-entry path
        // list and a JSON snippet is a wall for the many, to serve the few who are installing.
        'engine setup: a missing engine folds its guide behind one button',
        result.engineSetupUninstall?.switched === true &&
          result.engineSetupFolded?.hasGuideToggle === true &&
          /show setup steps/i.test(result.engineSetupFolded?.guideToggleText ?? '') &&
          (result.engineSetupFolded?.steps ?? []).length === 0
      ],
      [
        'engine setup: the guide is steps, not a paragraph',
        result.engineGuideClick?.clicked === true &&
          Array.isArray(result.engineSetup?.steps) && result.engineSetup.steps.length >= 4 &&
          result.engineSetup.steps.every((s) => s.length > 20)
      ],
      [
        // A musician has to be able to follow it: the three things they must type are named.
        'engine setup: the steps name python, venv and pip install',
        /python/i.test((result.engineSetup?.steps ?? []).join(' ')) &&
          /venv/i.test((result.engineSetup?.steps ?? []).join(' ')) &&
          /pip install/i.test((result.engineSetup?.steps ?? []).join(' '))
      ],
      ['engine setup: offers the searched-locations list', result.engineSetup?.hasToggle === true],
      [
        // THE reported bug: "not found at <one canonical path nobody has>". Non-empty, and
        // path-shaped rather than prose.
        'engine setup: the searched list is non-empty and shows paths',
        Array.isArray(result.engineSetupOpened?.paths) && result.engineSetupOpened.paths.length >= 5 &&
          result.engineSetupOpened.paths.some((p) => /venv/.test(p))
      ],
      [
        'engine setup: the list is collapsed until asked for',
        (result.engineSetup?.paths ?? []).length === 0 && (result.engineSetupOpened?.paths ?? []).length > 0
      ],
      [
        // The custom-install escape hatch, and the only setting a DAW-hosted plugin can read.
        'engine setup: shows the engine.json path to copy',
        typeof result.engineSetupOpened?.configPath === 'string' &&
          /engine\.json$/.test(result.engineSetupOpened.configPath)
      ],
      ['engine setup: Check again is present', result.engineSetup?.hasRecheck === true],
      [
        // Wired, not decorative: pressing it goes to the bridge and the answer lands on screen.
        'engine setup: Check again ran and reported back',
        result.engineRecheckClick?.clicked === true &&
          typeof result.engineRechecked?.said === 'string' && result.engineRechecked.said.length > 10
      ],

      // --- the engine picker: several engines, honestly described ----------------------
      //
      // The screen is a list now. What these add to the eleven above is everything a CHOICE
      // has to get right: that there is more than one thing to choose, that the built-in one
      // is named as the thing that always works, that the mark follows the choice, that a
      // choice outlives the panel, that each card says what its engine is good at rather than
      // only that it exists, that only the engines whose licence permits it offer to install
      // themselves, and that the guided engine's card still carries every block it used to.
      [
        'engine picker: offers more than one engine',
        !!result.enginePick?.present &&
          (result.enginePick.chips ?? []).filter((c) => c.id && c.id !== 'auto').length >= 2 &&
          result.enginePick.hasMore === true &&
          typeof result.enginePick.reason === 'string' && result.enginePick.reason.length > 20
      ],
      [
        // The one that needs no setup has to be findable BY SOMEBODY WITH NOTHING INSTALLED,
        // so it must not be behind an "· install" suffix and it must say what it is.
        'engine picker: names the built-in engine as always available',
        (() => {
          const built = (result.enginePick?.chips ?? []).find((c) => c.id === 'basic-pitch');
          return !!built && !/install/i.test(built.label) && /built in/i.test(built.title);
        })()
      ],
      [
        // And the mark MOVES: it is marked after the choice was made in the panel, and it is a
        // different chip once Auto is pressed here. One mark, never two, never none.
        'engine picker: the chosen engine is marked, and only one is',
        (() => {
          const marked = (result.enginePick?.chips ?? []).filter((c) => c.on);
          const pressed = (result.enginePick?.chips ?? []).filter((c) => c.pressed);
          const after = (result.enginePickAuto?.chips ?? []).filter((c) => c.on);
          return (
            marked.length === 1 &&
            pressed.length === 1 &&
            marked[0].id === pressed[0].id &&
            result.enginePickAutoClick?.clicked === true &&
            after.length === 1 &&
            after[0].id === 'auto'
          );
        })()
      ],
      [
        // The choice lives in a file the shell owns, not in this page. "It stuck" therefore
        // means the panel asked again after being torn down and got the same answer back.
        'engine picker: choosing an engine sticks across closing and reopening the panel',
        (() => {
          const chosen = (result.engineChosen?.cards ?? []).find((c) => c.id === 'transkun');
          const after = (result.engineChosenAfterReopen?.cards ?? []).find((c) => c.id === 'transkun');
          const marks = (result.engineChosenAfterReopen?.cards ?? []).filter((c) => c.usePressed);
          return (
            result.engineUseClick?.clicked === true &&
            chosen?.usePressed === true &&
            after?.usePressed === true &&
            marks.length === 1
          );
        })()
      ],
      // --- the engine Riffsheet wrote, and the default it now is ------------------------
      [
        // IT PRODUCES NOTES. Six plucks at known pitches go in; notes come out, in order, with
        // a real confidence on each. Not a count match — the attack detector legitimately
        // re-fires inside a synthetic decay — but every pitch it reports has to be one that was
        // actually played, which is the property that matters.
        'riffsheet engine: a single-note take comes back as notes, with confidence',
        (() => {
          const m = result.localEngine?.mono;
          const played = new Set([45, 43, 41, 40]);
          return (
            !!m &&
            m.ok === true &&
            m.notes >= 6 &&
            Array.isArray(m.midis) && m.midis.every((n) => played.has(n)) &&
            typeof m.minConfidence === 'number' && m.minConfidence > 0 && m.minConfidence <= 1
          );
        })()
      ],
      [
        // IT REFUSES A CHORD, which is the whole reason it is allowed to be the default. The
        // same six plucks with a fifth on each are a phantom-fundamental trap: YIN reads them
        // as one rock-solid note an octave below the root and does not waver, so "the frames
        // disagreed" cannot catch it and the harmonic-gap test has to. A pass here that came
        // back `ok` would be six tidy, confident, entirely fictional notes.
        'riffsheet engine: a chordal take is refused rather than guessed at',
        (() => {
          const c = result.localEngine?.chord;
          return (
            !!c &&
            c.ok === false &&
            c.kind === 'polyphony' &&
            typeof c.reason === 'string' && /more than one note/i.test(c.reason) &&
            c.contested >= 2
          );
        })()
      ],
      [
        // FRESH STATE RESOLVES TO IT. Nothing installed, nothing downloaded, and the app can
        // still transcribe — because the engine `auto` reaches for first is the app. The card
        // is the one in charge, it needs no Install button, and it costs nothing on disk.
        'riffsheet engine: auto resolves to it on a fresh machine, and its card says so',
        (() => {
          const cards = result.engineCards?.cards ?? [];
          const riff = cards.find((c) => c.id === 'riffsheet');
          const reason = result.engineCards?.reason ?? '';
          return (
            !!riff &&
            riff.install === 'bundled' &&
            riff.state === 'ready' &&
            riff.inCharge === true &&
            riff.hasInstall === false &&
            typeof riff.tier === 'string' && riff.tier.length > 3 &&
            /single-note/i.test(riff.body) &&
            /riffsheet/i.test(reason)
          );
        })()
      ],
      [
        // "One-click" on its own is worth nothing. The comparison somebody actually makes is
        // "a bass specialist that installs itself" against "the best one here, by hand", so
        // every card has to carry its tier AND what it is good at.
        'engine cards: every card says its tier and its instrument strengths',
        (() => {
          const cards = result.engineCards?.cards ?? [];
          return (
            cards.length >= 3 &&
            cards.every(
              (c) =>
                typeof c.tier === 'string' && c.tier.length > 3 &&
                typeof c.strengths === 'string' && /good at:/i.test(c.strengths) &&
                /Bass|Guitar|Piano|Voice|Drums/.test(c.strengths)
            )
          );
        })()
      ],
      [
        // The licence line, drawn as a button or its absence. An engine whose weights Riffsheet
        // may not fetch has no Install button anywhere on its card — that is the AGPL red line
        // rendered, not a policy sentence somebody has to read and believe.
        'engine cards: a one-click engine offers Install and a guide engine does not',
        (() => {
          const cards = result.engineCards?.cards ?? [];
          const oneClick = cards.filter((c) => c.install === 'one-click');
          const guide = cards.filter((c) => c.install === 'guide');
          const bundled = cards.filter((c) => c.install === 'bundled');
          return (
            oneClick.length >= 1 && oneClick.some((c) => c.hasInstall) &&
            guide.length === 1 && guide.every((c) => !c.hasInstall) &&
            bundled.length >= 1 && bundled.every((c) => !c.hasInstall)
          );
        })()
      ],
      [
        // The guide moved behind a button and lost nothing: when it IS unfolded, every part of
        // the old setup screen is still on MuScriptor's card, with the same roles. Read off the
        // unfolded state above rather than off the cards sweep, because by then the mock's
        // engine is back and the card correctly has no guide at all.
        'engine cards: MuScriptor’s unfolded guide still carries the steps, the searched list and the engine.json path',
        (() => {
          const g = result.engineSetupOpened;
          return (
            !!g &&
            (g.steps ?? []).length >= 4 &&
            (g.steps ?? []).every((s) => s.length > 20) &&
            g.hasToggle === true &&
            typeof g.configPath === 'string' && /engine\.json$/.test(g.configPath)
          );
        })()
      ],
      [
        // Pressed for real against the bridge: work visibly happening, then a sentence saying
        // how it ended, then the card offering to undo it rather than to do it again.
        'engine install: pressing Install shows progress and then a result',
        (() => {
          const during = (result.engineInstalling?.cards ?? []).find((c) => c.id === 'bass-v2');
          const done = (result.engineInstalled?.cards ?? []).find((c) => c.id === 'bass-v2');
          return (
            result.engineInstallClick?.clicked === true &&
            typeof during?.progress === 'string' && during.progress.length > 0 &&
            typeof done?.outcome === 'string' && /installed/i.test(done.outcome) &&
            done.hasInstall === false && done.hasUninstall === true
          );
        })()
      ],
      [
        // The promise the licence makes for us. If this copy ever turns into an offer, the
        // screen would be promising something Riffsheet has no right to do.
        //
        // TWO PLACES, because the sentence moved. The policy line lives inside the guide, and
        // the guide is now hidden once the engine is found — so the card that is always on
        // screen has to carry the claim itself. It does, in the cost line: "guided setup — its
        // licence does not let Riffsheet install it". Both are asserted, and so is the absence
        // of an Install button, which is the part a player can actually act on.
        'engine setup: the screen never claims Riffsheet can install MuScriptor',
        (() => {
          const mu = (result.engineCards?.cards ?? []).find((c) => c.id === 'muscriptor');
          const group = result.engineCards?.group ?? '';
          return (
            !!mu &&
            mu.hasInstall === false &&
            /licence does not let Riffsheet install it/i.test(mu.body) &&
            /cannot install/i.test(result.engineSetup?.policy ?? '') &&
            !/riffsheet\s+(can|will|could)\s+install/i.test(group)
          );
        })()
      ],
      [
        // 900x600 is the product's floor for a plugin window. Measured on the opening screen
        // with the cards open, so what is being measured is this screen and not alphaTab.
        'engine screen: fits a 900x600 window with nothing pushed sideways',
        (() => {
          const fit = result.engineFit900;
          const pick = result.engineFit900Pick;
          return (
            !!fit && fit.panelOpen === true && (fit.cards ?? []).length >= 3 &&
            fit.cards.every((c) => !!c && c.scrollW <= c.clientW + 1 && c.right <= fit.innerW + 1) &&
            !!pick?.pick && pick.pick.right <= pick.innerW + 1
          );
        })()
      ],
      [
        // 360x280 is REAPER's smallest docked FX window. Cards, chips and the guide all have
        // to wrap into it rather than scroll out of it.
        'engine screen: fits REAPER’s 360x280 floor with nothing pushed sideways',
        (() => {
          const fit = result.engineFit360;
          const pick = result.engineFit360Pick;
          return (
            !!fit && fit.panelOpen === true && (fit.cards ?? []).length >= 3 &&
            fit.cards.every((c) => !!c && c.scrollW <= c.clientW + 1 && c.right <= fit.innerW + 1) &&
            !!pick?.pick && pick.pick.right <= pick.innerW + 1
          );
        })()
      ],

      ['transport bar', result.transport],
      ['waveform strip', result.waveform],
      ['alphaTab drew SVG', result.svgCount > 0 && result.svgPaths > 0],
      ['tab digits / glyphs present', result.svgTexts > 0],
      ['note-name labels placed', result.nameLabelCount > 0],
      ['no console errors', errors.length === 0],
      ['pipeline produced bars', !!result.selfTest && result.selfTest.bars > 0],
      ['pipeline produced notes', !!result.selfTest && result.selfTest.noteGlyphs > 0],
      ['note ids reach the renderer index', !!result.selfTest && (result.selfTest.noteIds ?? []).length > 0],
      ['MIDI header is MThd', !!result.selfTest && result.selfTest.midiHeaderOk],
      ['MIDI quantized non-trivial', !!result.selfTest && result.selfTest.midiQuantizedBytes > 100],
      ['MIDI as-played non-trivial', !!result.selfTest && result.selfTest.midiAsPlayedBytes > 100],
      ['MusicXML well-formed-ish', !!result.selfTest && result.selfTest.musicxmlOk],
      ['PDF: print document built', !!result.pdf && !result.pdf.error && result.pdf.bytes > 1000],
      ['PDF: contains engraved SVG', !!result.pdf && result.pdf.svgCount > 0 && result.pdf.hasNoteGlyphs],
      ['PDF: Bravura inlined as data URI', !!result.pdf && result.pdf.hasInlinedBravura],
      // Both export paths lose alphaTab's document CSS, so the music font has to be written
      // onto the glyphs themselves. Without it the page comes out full of empty boxes while
      // every other check still passes — which is exactly how it shipped broken once.
      ['PDF: glyphs carry the music font', !!result.pdf && result.pdf.glyphsCarryFont > 20],
      ['PDF bytes: real PDF produced', !!result.pdfBytes && !result.pdfBytes.error && result.pdfBytes.bytes > 5000],
      ['PDF bytes: header and trailer', !!result.pdfBytes && result.pdfBytes.header && result.pdfBytes.trailer],
      ['PDF bytes: a page per engraved page', !!result.pdfBytes && result.pdfBytes.pages >= 1 && result.pdfBytes.images === result.pdfBytes.pages],
      ['PDF bytes: image stream compressed', !!result.pdfBytes && ['FlateDecode', 'DCTDecode'].includes(result.pdfBytes.filter)],

      ['sound: sampled bass loaded', !!result.sound && result.sound.samplesLoaded === true],
      ['sound: whole sample set decoded', !!result.sound && result.sound.loaded === result.sound.expected],
      ['sound: status reads ready', !!result.sound && result.sound.state === 'ready'],
      ['sound: missing samples fall back quietly', !!result.sound && result.sound.fallbackLoaded === false && result.sound.fallbackScheduled === 0 && result.sound.fallbackReady === false],
      ['sound: sampled bass is the default', !!result.sound && result.sound.voice === 'finger-bass'],

      ['MIDI menu: one dialog for one file', !!result.midiMenu?.quantized && result.midiMenu.quantized.dialogs === 1 && result.midiMenu.quantized.names?.length === 1],
      ['MIDI menu: quantized name has no suffix', !!result.midiMenu?.quantized && /\.mid$/.test(result.midiMenu.quantized.names?.[0] ?? '') && !result.midiMenu.quantized.names[0].includes('as-played')],
      ['MIDI menu: "Both" is ONE dialog, two files', !!result.midiMenu?.both && result.midiMenu.both.dialogs === 1 && result.midiMenu.both.names?.length === 2 && result.midiMenu.both.names.some((n) => n.includes('-as-played.mid'))],
      ['MIDI menu: choice is remembered', !!result.midiMenu?.cancelled && result.midiMenu.cancelled.remembered === 'as-played'],
      ['MIDI menu: saving toasts once', !!result.midiMenu?.quantized && result.midiMenu.quantized.toastsAdded === 1],
      ['MIDI menu: CANCEL does not toast', !!result.midiMenu?.cancelled && result.midiMenu.cancelled.toastsAdded === 0],
      ['MIDI menu: closes on pick', !!result.midiMenu?.quantized && result.midiMenu.quantized.menuClosed === true],
      // --- every control on the chrome is reachable, at every size -----------------------
      //
      // The reported failure mode: Capo was added to the notation toolbar, the toolbar was a
      // horizontal scroller with its scrollbar switched off, and at 900x600 Capo came to rest
      // 39px past the right edge. Nothing was broken in code and nothing logged; the control
      // was simply not there as far as anybody using it was concerned. These three are the
      // guard, and they name what they found so a failure is readable without a re-run.
      // Named for what they MEASURE — sideways clipping — and not for the broader claim that
      // everything is reachable, because at 360x280 the lower half of the window is cut off
      // vertically by `body { overflow-y: hidden }` and that is a separate, older problem.
      [
        '900x600: no header/toolbar control is clipped sideways',
        !!result.narrow?.reach && result.narrow.reach.offScreen.length === 0
      ],
      [
        '1100x700: no header/toolbar control is clipped sideways',
        !!result.mid?.reach && result.mid.reach.offScreen.length === 0
      ],
      [
        // REAPER's floor. An FX window goes this small and the chrome still has to work.
        '360x280: no header/toolbar control is clipped sideways',
        !!result.floor?.reach && result.floor.reach.offScreen.length === 0
      ],
      [
        // G11, at both ends of the size ladder. `linkControl` reads the same selector it always
        // did; what changed is which answer is correct. Null at every size, because "deleted"
        // has to mean gone rather than hidden behind a breakpoint.
        'align: the Align control is gone at 900x600',
        !!result.narrow?.reach && result.narrow.reach.linkControl === null
      ],
      [
        'align: the Align control is gone at 360x280',
        !!result.floor?.reach && result.floor.reach.linkControl === null
      ],
      [
        // G7. Both axis captions readable at the product's floor: on screen, not clipped, and
        // not shrunk below 9px, which is where 8 uppercase characters stop being a word.
        'zoom: both axis captions are legible at 360x280',
        (result.floor?.reach?.zoomAxes ?? []).length === 2 &&
          result.floor.reach.zoomAxes.every(
            (a) => a.onScreen === true && a.w >= 24 && a.fontPx >= 9 && /^(Vertical|Horizontal)$/.test(a.text)
          )
      ],
      [
        // The player asked for it ON out of the box. Safe to default on only because the
        // setting no longer means "borrow the sheet's geometry" — following a moment cannot
        // move anything, which is what made the old default-on dangerous.
        'align: a fresh boot has it ON',
        !!result.alignDefault && result.alignDefault.enabled === true &&
          // …and there is no control that could ever have it any other way (G11).
          result.alignDefault.chipPresent === false
      ],
      [
        // The whole of what it does: point at a moment on the roll or the strip and the SHEET
        // goes there. `followed` is the decisive fact and `sheetMoved` the corroborating one —
        // corroborating rather than decisive because a take whose engraving already fits in
        // the window has nowhere to scroll TO, and on that take "it did not move" is correct
        // behaviour rather than a failure. `sheetScrollable` says which case this run is.
        'align: ON, pointing at a moment takes the sheet there',
        !!result.alignOn && result.alignOn.followed === true &&
          (result.alignOn.sheetScrollable ? result.alignOn.sheetMoved === true : true) &&
          result.alignOn.sheetErrorPx !== null &&
          // CENTRED WHERE CENTRING IS POSSIBLE, ON SCREEN WHERE IT IS NOT.
          //
          // The bound was `sheetErrorPx < 80` alone, and the second clause is not a loosening
          // of it — it is the case the first clause was silently getting away with. A moment in
          // the last half-viewport of the engraving CANNOT be put in the middle of the pane:
          // `setScrollLeft` clamps at the end of the content rather than scrolling past it, so
          // the residual is however far the target is from the centre of the last screenful,
          // and that is correct behaviour rather than a miss. The target here sits at 75% of
          // the take, and the take's engraving got shorter when the Quantize default went back
          // to 'auto' (G6) — same music, fewer glyph-widths — which is what moved this run over
          // the line. `clampedAtEnd` and `targetOnScreen` are new fields on the probe reporting
          // exactly which of the two situations a run is in, so the distinction is measured
          // rather than assumed.
          (result.alignOn.sheetErrorPx < 80 ||
            (result.alignOn.clampedAtEnd === true && result.alignOn.targetOnScreen === true))
      ],
      [
        // THE POINT OF THE WHOLE ITEM. With Align ON the roll and the strip are told the
        // sheet's own visible span — derived from alphaTab's bounds, not guessed — so all
        // three panes draw the same seconds across the same pixels.
        'align: ON, the roll and the strip are given the sheet\'s visible span',
        typeof result.alignOn?.alignedWindowSec === 'number' && result.alignOn.alignedWindowSec > 0
      ],
      // WAS: 'align: OFF, the panes go back to being independent' (alignOff.alignedWindowSec
      // === null). There is no OFF (G11), so the claim is retired rather than restated — the
      // window is always supplied, which the check above already asserts. What the off-state
      // was really guarding, that the roll's own geometry stays linear and independent of the
      // engraving, is asserted below and by the add-a-note check, neither of which needed it.
      [
        // VERTICAL CORRESPONDENCE, measured. Three notes, sheet x against roll x, in viewport
        // pixels. The tolerance is what a LINEAR time ruler can do against alphaTab's own
        // spacing over one screen of music — the roll must stay linear in time or a picture of
        // a performance starts re-spacing itself when the performance is edited (§1). It is a
        // real bound, not a rubber stamp: unaligned, the same three notes are hundreds of
        // pixels apart, which the off-mode check below states as a fact.
        'align: ON, a note\'s sheet x and its roll x are the same column',
        result.alignXOn?.aligned === true &&
          result.alignXOn?.compared >= 3 &&
          result.alignXOn?.worstDeltaPx <= ALIGN_TOLERANCE_PX
      ],
      // THREE OFF-STATE CHECKS STOOD HERE and are deleted with the state (G11):
      //
      //   'align: OFF, the two panes are free to disagree'      (alignXOff.worstDeltaPx > tol)
      //   'align: ON closes the gap by at least 4x over OFF'    (a ratio between the two modes)
      //   'align: OFF, the sheet is left exactly where the player put it'
      //
      // All three asserted something about a mode the app can no longer enter, so none of them
      // can fail for a reason anybody would want to hear about. The first two were how the
      // absolute tolerance above was shown to be a real bound rather than a rubber stamp; that
      // argument is preserved as a NUMBER instead of as a second measurement — unaligned, the
      // same three notes were hundreds of pixels apart, against ALIGN_TOLERANCE_PX above.
      [
        // Selection has always crossed all four views and still does. It was checked in both
        // modes because the chip governed scrolling and not highlighting; with one mode left,
        // the claim is the same and the evidence is half as long.
        'align: selection crosses the views',
        !!result.alignOn && result.alignOn.selectionCrossed === true
      ],
      [
        // THE USER'S OWN ACCEPTANCE TEST, and the reason the old design was deleted. Adding a
        // note to the roll must move no other note on the roll by a single pixel — with Align
        // ON, which is exactly when the old design reflowed.
        'align: ON, adding a note on the roll moves no other note',
        !!result.alignOn && result.alignOn.noteAdded === true &&
          result.alignOn.otherNotesMovedPx === 0
      ],
      [
        // ...and the geometry is gone, not merely switched off: there is no supplier left that
        // could put either pane on the engraved axis.
        // Read off the panes rather than off a chip that no longer exists (G11): there is no
        // supplier left that could put either of them on the engraved axis, so there is nothing
        // to press to find out.
        'align: neither pane can be put on the sheet’s x-axis any more',
        result.linkOff?.roll?.linkedActive === false &&
          result.linkOff?.roll?.hasSheetMap === false &&
          result.linkOff?.wave?.sheetLinked === false
      ],

      // --- start over: out of the toolbar, into the Main menu ---------------------------
      [
        // #10. The toolbar button is retired, and "retired" has to mean gone rather than
        // hidden behind a condition — this reads the whole header, not just the role.
        'start over: “Listen again” is no longer in the toolbar',
        result.retranscribeEntry?.inToolbar === false &&
          !/listen again/i.test(result.retranscribeEntry?.headerText ?? '')
      ],
      [
        // ...and it is where the other deliberate, irreversible acts are: on the row that
        // describes the open take, next to Save as and Close.
        'start over: the Main menu carries it, in the current-work row',
        result.retranscribeMenu?.present === true &&
          result.retranscribeMenu?.inCurrentWorkRow === true &&
          result.retranscribeMenu?.onScreen === true &&
          /re-transcribe/i.test(result.retranscribeMenu?.text ?? '')
      ],
      [
        // The click has to reach the app and produce an answer. Here the handle is genuinely
        // gone, so the answer is the explanation; what is asserted is that SOMETHING happened,
        // and that pressing it left the menu rather than stranding somebody there.
        'start over: pressing it is never silent, and returns to the sheet',
        result.retranscribeClick?.clicked === true &&
          (result.retranscribeAfter?.count ?? 0) > 0 &&
          result.retranscribeAfter?.backOnSheet === true
      ],

      // --- yes/no questions are asked in the page ----------------------------------------
      [
        // `window.confirm` returns false in a WKWebView with no UI delegate. Three call sites
        // were dead that way, including Listen again once anything had been edited.
        'confirm: the dialog is a real element in the page',
        result.confirmClose?.clicked === true &&
          result.confirmDialog?.present === true &&
          result.confirmDialog?.hasOk === true &&
          result.confirmDialog?.hasCancel === true
      ],
      [
        'confirm: Cancel closes it and keeps the take',
        result.confirmCancel?.clicked === true &&
          result.confirmAfterCancel?.dialogGone === true &&
          result.confirmAfterCancel?.stillHasWork === true
      ],

      // =================================================================================
      // NIGHT WAVE 2
      // =================================================================================

      // --- #14: undo and redo, visible ---------------------------------------------------
      [
        // ⌘Z has always worked and has always been invisible, which makes it a feature for
        // people who already knew about it. Seeing that a mistake is undoable BEFORE making
        // one is most of what makes an editable sheet feel safe to touch.
        'undo/redo: a visible pair sits in the transport row',
        result.undoPairAtRest?.undo?.present === true &&
          result.undoPairAtRest?.redo?.present === true &&
          result.undoPairAtRest?.inTransport === true &&
          result.undoPairAtRest?.undo?.onScreen === true &&
          result.undoPairAtRest?.redo?.onScreen === true
      ],
      [
        // BOLD DRAWN ARROWS, not "↶". At 16px in the shell's UI font the text glyph is a
        // hairline, sits off-centre, and is missing outright from some fallback fonts. This
        // asserts real geometry — an <svg> with paths in it — and a stroke heavy enough to
        // read as a button rather than as decoration.
        'undo/redo: the arrows are drawn SVG, not thin text glyphs',
        (() => {
          const both = [result.undoPairAtRest?.undo, result.undoPairAtRest?.redo];
          return both.every(
            (b) => !!b && b.hasSvg === true && b.paths >= 2 && b.strokeWidth >= 2 && b.text === ''
          );
        })()
      ],
      [
        // Wired to the real machinery, not to a stub: an edit lights Undo, pressing it puts
        // the note back AND lights Redo, and pressing that re-applies it.
        'undo/redo: the buttons act, and light in step with the stack',
        result.undoPairAtRest?.undo?.disabled === true &&
          result.undoPairAfterEdit?.undo?.disabled === false &&
          result.undoPairUndoClick?.clicked === true &&
          result.undoPairAfterUndo?.redo?.disabled === false &&
          result.undoPairRedoClick?.clicked === true &&
          result.undoPairAfterRedo?.redo?.disabled === true
      ],
      [
        // Greyed at the ends rather than hidden. A control that vanishes takes the answer to
        // "can I undo this?" away at exactly the moment somebody is asking it.
        'undo/redo: they grey out at the ends of the stack instead of disappearing',
        result.undoPairAtRest?.redo?.disabled === true &&
          result.undoPairAtRest?.redo?.present === true &&
          result.undoPairAfterRedo?.redo?.present === true
      ],

      // --- #15: the tempo unit, and the rate it must not change --------------------------
      [
        'tempo: the beat unit is drawn next to the BPM box',
        typeof result.tempoUnit?.before?.unit === 'string' &&
          /♩|♪|𝅝|𝅘𝅥𝅯|𝅘𝅥/.test(result.tempoUnit.before.unit) &&
          /\/min$/.test(result.tempoUnit.before.unit)
      ],
      [
        // 4/4 counts quarters, 6/8 counts eighths. The glyph follows the signature, and so
        // does the NUMBER — printing "120" beside a ♪ would be out by a factor of two, since
        // `tempoBpm` is quarter-notes per minute everywhere in this app.
        //
        // The expectation is computed from each side's OWN signature rather than hard-coded,
        // so this stays a statement about the rule instead of about one fixture.
        'tempo: changing the signature re-states the tempo in the new beat',
        (() => {
          const shownFor = (side) => {
            if (!side || typeof side.storedBpm !== 'number') return null;
            const d = Number((side.timeSig ?? '').split('/')[1]);
            // Only the denominators the app names a beat for are scaled; anything else keeps
            // the quarter, so the glyph and the number can never disagree.
            const perQuarter = [1, 2, 4, 8, 16].includes(d) ? d / 4 : 1;
            return Math.round(side.storedBpm * perQuarter);
          };
          const before = result.tempoUnit?.before;
          const after = result.tempoUnit?.after;
          return (
            !!before && !!after &&
            after.timeSig === '6/8' &&
            before.unit !== after.unit &&
            after.unit === '♪/min' &&
            before.shownBpm === shownFor(before) &&
            after.shownBpm === shownFor(after)
          );
        })()
      ],
      [
        // THE CHECK THE BOARD ASKED FOR, and the answer is a schedule dump comparison rather
        // than a stopwatch. `synthNotesFor()` is the exact list handed to the thing that makes
        // sound, so two identical lists either side of a signature change is playback proving
        // it did not move. It agrees with the static reading: `audio/transport.ts` contains no
        // reference to a tempo or a signature at all, and every conversion divides 60 by
        // `tempoBpm` and multiplies by 960 ticks per QUARTER, unconditionally.
        // NOTE WHAT IS *NOT* ASSERTED: that `score.tempoBpm` stays put. It does not, and that
        // is correct — the engraving tempo is a pipeline OUTPUT, re-derived for the new meter
        // (96 quarters/min in 4/4 becomes 144 in 6/8 on this fixture, which is the same music
        // barred differently). The claim worth making is about the sound, and the sound is
        // this list: playback schedules absolute seconds computed from the performance, so it
        // comes out identical to the microsecond.
        'tempo: changing the signature does NOT change the playback schedule',
        result.tempoUnit?.scheduleIdentical === true &&
          (result.tempoUnit?.before?.schedule ?? []).length > 0 &&
          result.tempoUnit?.restored === result.tempoUnit?.before?.timeSig
      ],

      // --- #16: a grid too coarse for the riff says so -----------------------------------
      [
        // The demo is a triplet figure. A 1/4 notation grid has nowhere to put the second and
        // third note of each triplet, and what used to happen is that they silently merged —
        // the only clue being that the sheet looked emptier than it should.
        'grid: 1/4 on the triplet fixture says how many notes it would merge',
        result.gridWarnSet?.set === true &&
          result.gridWarnCoarse?.shown === true &&
          /1\/4 would merge \d+ notes/.test(result.gridWarnCoarse?.text ?? '') &&
          /too coarse for this riff/.test(result.gridWarnCoarse?.text ?? '')
      ],
      [
        // The number is the pipeline's own arithmetic — engine notes minus engraved noteheads —
        // not a guess, and not a constant. Checked two ways: it is a large fraction of the
        // riff (a 1/4 grid cannot hold a triplet figure at all), and a grid that CAN hold it
        // engraves that many more notes.
        'grid: the count is the real difference between heard and engraved notes',
        (() => {
          const m = /would merge (\d+) notes/.exec(result.gridWarnCoarse?.text ?? '');
          const lost = m ? Number(m[1]) : null;
          const coarse = result.gridWarnCoarse?.engravedNotes;
          const fine = result.gridWarnFine?.engravedNotes;
          if (lost === null || typeof coarse !== 'number' || typeof fine !== 'number') return false;
          // What the engine heard, reconstructed from the two numbers the page itself reported.
          const heard = coarse + lost;
          return (
            lost >= 2 &&
            // The rule the code applies: more than a tenth of the riff cannot be written.
            lost > 0.1 * heard &&
            // ...and a grid that CAN hold the figure recovers most of them.
            fine > coarse &&
            fine - coarse > 0.5 * lost
          );
        })()
      ],
      [
        // Beside the control it is about. A warning one control away from its cause is a
        // warning about nothing.
        'grid: the line sits next to the grid control, and clears when the grid fits',
        result.gridWarnCoarse?.nearGrid === true &&
          result.gridWarnBefore?.shown === false &&
          result.gridWarnFine?.shown === false
      ],

      // --- #7-web: what a card actually tells you ----------------------------------------
      [
        // Three lines, each answering a different question, in the order somebody comparing
        // engines asks them. It used to be one run-on line that read as a single fact.
        'engine cards: every card carries a detail block — strengths, cost, source',
        (() => {
          const cards = [
            result.cardDetail?.basic,
            result.cardDetail?.mu,
            result.cardDetail?.bass,
            result.cardDetail?.transkun
          ];
          return (
            cards.every((c) => !!c) &&
            cards.every((c) => /good at:/i.test(c.strengths ?? '')) &&
            // Disk or memory, and how it gets here. Never empty.
            cards.every((c) => (c.cost ?? '').length > 12) &&
            cards.every((c) => /source:/i.test(c.source ?? ''))
          );
        })()
      ],
      [
        // The licence is drawn only when the shell SENT one — never guessed from the URL,
        // because "it is on GitHub" says nothing about the terms. The mock sends all four.
        'engine cards: the source line names a licence',
        (() => {
          const cards = [
            result.cardDetail?.basic,
            result.cardDetail?.mu,
            result.cardDetail?.bass,
            result.cardDetail?.transkun
          ];
          return cards.every((c) => !!c && typeof c.license === 'string' && c.license.length > 2);
        })()
      ],
      [
        // The three RAM numbers, on the card of the engine they belong to. "small / medium /
        // large" are three adjectives; these are what lets somebody with 8 GB decide, and they
        // are exactly what `auto` is deciding with on their behalf.
        'engine cards: MuScriptor shows what each model size costs in memory',
        /small 0\.9 GB/.test(result.cardDetail?.mu?.ram ?? '') &&
          /medium 1\.8 GB/.test(result.cardDetail?.mu?.ram ?? '') &&
          /large 5 GB/.test(result.cardDetail?.mu?.ram ?? '')
      ],
      [
        // The figures come from `engineStatus().models`, which carries `fits` — the auto rule's
        // own answer about this machine. A size that cannot run here is SAID to be, rather than
        // listed beside the ones that can and left to be chosen and wondered about. (The mock's
        // machine has 8 GB, so `large` does not fit, which is the whole reason it models one.)
        'engine cards: a model size this machine cannot run is named as such',
        /large 5 GB \(too big for this machine\)/.test(result.cardDetail?.mu?.ram ?? '') &&
          !/0\.9 GB \(too big/.test(result.cardDetail?.mu?.ram ?? '')
      ],
      [
        // MOVED, not copied. The old row sat in the group above, named no engine, and applied
        // to exactly one of the four — somebody running Basic Pitch could set "large" and watch
        // nothing happen. Exactly one model select on the whole panel, and it is on the card.
        'engine cards: the model chooser lives on MuScriptor’s card and nowhere else',
        result.cardDetail?.mu?.hasModelSelect === true &&
          result.cardDetail?.basic?.hasModelSelect === false &&
          result.cardDetail?.bass?.hasModelSelect === false &&
          result.cardDetail?.transkun?.hasModelSelect === false &&
          result.cardDetail?.modelSelectsOnPanel === 1 &&
          result.cardDetail?.modelSelectsInSetupGroup === 1
      ],
      [
        // Cards are ~300px wide inside a panel that is a fixed column, and a <select> takes
        // its intrinsic width from its longest option. Nothing in a card may push it sideways.
        'engine cards: nothing in a card overflows it',
        (() => {
          const cards = [
            result.cardDetail?.basic,
            result.cardDetail?.mu,
            result.cardDetail?.bass,
            result.cardDetail?.transkun
          ];
          return cards.every((c) => !!c && c.scrollW <= c.clientW + 1);
        })()
      ],

      // --- #13: "I already have this one" ------------------------------------------------
      [
        // A one-click card's Install button is 57 to 400 MB of download. For somebody who
        // already has the package the app had nothing to say: the only door was Install.
        'existing install: one-click cards offer it, the built-in one does not',
        result.cardDetail?.bass?.hasUseExisting === true &&
          result.cardDetail?.transkun?.hasUseExisting === true &&
          result.cardDetail?.basic?.hasUseExisting === false &&
          result.cardDetail?.mu?.hasUseExisting === false
      ],
      [
        'existing install: it opens onto a sniff row and a path box',
        result.existingOpen?.clicked === true &&
          result.existingPanel?.hasSniff === true &&
          result.existingPanel?.hasPath === true &&
          result.existingPanel?.hasCheck === true
      ],
      [
        // The sniff FILLS the box rather than adopting silently: you see where before anything
        // is used, which is the difference between an answer and a surprise.
        'existing install: “Look for it” reports a location and fills the box',
        result.existingSniff?.clicked === true &&
          /found/i.test(result.existingAfterSniff?.said ?? '') &&
          (result.existingAfterSniff?.path ?? '').length > 3
      ],
      [
        // A refusal has to say what was wrong. "No" on its own sends somebody back to guessing.
        'existing install: a folder with no engine in it is refused, with a reason',
        result.existingBadCheck?.clicked === true &&
          result.existingAfterBad?.warned === true &&
          /no runnable engine|there is no/i.test(result.existingAfterBad?.said ?? '') &&
          result.existingAfterBad?.state === 'not-installed'
      ],
      [
        // ...and a real one makes the card behave exactly as it does after an install: usable,
        // removable, and no longer offering to be pointed anywhere.
        'existing install: a working copy is adopted and the card becomes an installed one',
        result.existingGoodCheck?.clicked === true &&
          result.existingAfterGood?.state === 'installed' &&
          result.existingAfterGood?.hasUninstall === true &&
          result.existingAfterGood?.hasUseExisting === false
      ],

      // --- #20: the two switches, in plain speak -----------------------------------------
      [
        // "Even out the level before listening" describes the operation. Somebody who does not
        // already know what normalisation is cannot tell whether they want it. Name the
        // SITUATION first, then what the app will do about it.
        'preprocessing: the switches name the problem, not the process',
        /if your recording is quiet/i.test(result.preprocessCopy?.level ?? '') &&
          /boost it so the engine hears it better/i.test(result.preprocessCopy?.level ?? '') &&
          /if your instrument was tuned slightly off/i.test(result.preprocessCopy?.tuning ?? '') &&
          /right pitches/i.test(result.preprocessCopy?.tuning ?? '')
      ],
      [
        // Jargon that the old labels leaked. "A440" and "normalise" are correct and are not
        // what a person reaching for this switch is thinking in.
        'preprocessing: no jargon left in either label',
        !/normali[sz]|a440|concert pitch|level\b/i.test(result.preprocessCopy?.level ?? '') &&
          !/normali[sz]|a440|concert pitch/i.test(result.preprocessCopy?.tuning ?? '')
      ],
      [
        // The receipt row survives the rewrite. "Corrected 14 cents flat" is a fact about
        // somebody's own recording and the only place they can be told it.
        'preprocessing: the receipt rows are still there',
        (result.preprocessCopy?.levelNote ?? '').length > 20 &&
          (result.preprocessCopy?.tuningNote ?? '').length > 20 &&
          result.preprocessCopy?.receipt === true
      ],

      // --- G17: the chip may only claim a listener that exists ---------------------------
      [
        /*
         * THE BUG: "Listener · running" on a machine where nobody had ever started an engine
         * server. `EngineStatus.state` means the SERVER'S LIFECYCLE for MuScriptor and "this
         * engine is installed" for every other engine, and ui/app.ts read it as the first for
         * both — so on any machine whose resolved engine was not MuScriptor the chip was up
         * from boot. `memoryMb` was absent, which is why the text read the literal word
         * "running" instead of a figure; that string was the tell.
         *
         * A check cannot start a Python process, so it cannot assert the chip is RIGHT. What it
         * asserts is the implication that was broken, in both directions: visible only where
         * the payload carries evidence of a process, and no evidence means not visible. The
         * evidence list is the same one `engineProcessAlive()` uses, restated here rather than
         * imported, so a quiet widening of it on the app's side fails this check.
         */
        'listener chip: it appears only where a server process actually exists',
        !!result.engineChip &&
          result.engineChip.present === true &&
          result.engineChip.visible ===
            (['ready', 'starting'].includes(result.engineChip.state) &&
              ((result.engineChip.port ?? 0) > 0 ||
                (result.engineChip.memoryMb ?? 0) > 0 ||
                result.engineChip.externalServer === true ||
                result.engineChip.adopted === true))
      ],
      [
        // And when it IS shown it says what it is and what pressing it does, in the accent —
        // "Listener · 1.5 GB" read as a status badge, and nobody clicks a status badge. The
        // memory figure is not lost; it moved into the tooltip.
        'listener chip: shown means named, highlighted, and offering to stop',
        !result.engineChip?.visible ||
          (/ running — click to stop$| starting…$/.test(result.engineChip?.text ?? '') &&
            result.engineChip?.highlighted === true)
      ],

      // --- #5-web: a refusal you can act on ----------------------------------------------
      [
        // "It is not Riffsheet's to stop" is a correct principle and, on its own, a dead end:
        // the person reading it usually started that server themselves, can see it holding
        // well over a gigabyte, and has just been told the app will not help.
        'engine stop: “Left running” now carries a Stop it anyway button',
        result.engineChipStop?.present === true &&
          result.leftRunning?.hasStopAnyway === true &&
          /left running/i.test((result.leftRunning?.texts ?? []).join(' ')) &&
          /stop it anyway/i.test(result.leftRunning?.label ?? '')
      ],
      [
        // And it works — through `stopExternalEngine`, which is a separate native call rather
        // than a flag on the ordinary Stop, so nothing can reach it without the second press.
        'engine stop: pressing it stops the borrowed listener',
        result.stopAnywayClick?.clicked === true &&
          /listener stopped/i.test((result.afterStopAnyway?.toasts ?? []).join(' '))
      ],

      // --- #10: choosing an engine transcribes with it -----------------------------------
      [
        // The old behaviour was to write the choice into engine.json and stop, which on a
        // screen already showing a sheet is a control that does nothing visible.
        'engine click: it asks before discarding edits, naming what will be lost',
        result.engineClickPress?.clicked === true &&
          result.engineClickDialog?.present === true &&
          /listening again/i.test(result.engineClickDialog?.message ?? '') &&
          /change/i.test(result.engineClickDialog?.message ?? '')
      ],
      [
        // ...and then it actually listens. Counted at the BRIDGE, so this is "a transcription
        // arrived" rather than "the app believes it sent one".
        'engine click: confirming starts a fresh transcription with the engine just chosen',
        result.engineClickConfirm?.clicked === true &&
          typeof result.engineClickAfter?.transcribeCount === 'number' &&
          result.engineClickAfter.transcribeCount > (result.engineClickBefore?.transcribeCount ?? 0) &&
          result.engineClickAfter?.onSheet === true
      ],

      [
        // THE BOARD'S CASE. Pressing an engine while one is listening used to be the quietest
        // failure in the app: `retranscribe()` saw `progress !== null` and returned, so the
        // press did nothing, said nothing, and left the old engine's reading on screen.
        'engine click: pressing one while a job is running cancels it and starts a new reading',
        result.engineBusyStart?.running === true &&
          result.engineBusyBefore?.inFlight === true &&
          result.engineBusyPress?.clicked === true &&
          // Counted at the bridge: a job was abandoned mid-flight...
          result.engineBusyAfter?.cancels > (result.engineBusyBefore?.cancels ?? 0) &&
          // ...and a new one was started, not merely queued behind it.
          result.engineBusyAfter?.transcribes > (result.engineBusyBefore?.transcribes ?? 0) &&
          result.engineBusyAfter?.onSheet === true
      ],

      // --- #25: opening work that was left behind ----------------------------------------
      [
        // Silent restore is right exactly once — a DAW destroying the editor, where the work
        // reappearing IS the fix — and wrong every other time. Open the plugin on a new track
        // and last week's riff is on screen, apparently belonging to a project it has nothing
        // to do with.
        'resume: a boot with saved work asks instead of restoring silently',
        result.resumePrompt?.promptOnFresh?.shown === true &&
          /unfinished work/i.test(result.resumePrompt?.promptOnFresh?.message ?? '') &&
          /resume previous work/i.test(result.resumePrompt?.promptOnFresh?.resumeLabel ?? '') &&
          /start fresh/i.test(result.resumePrompt?.promptOnFresh?.freshLabel ?? '')
      ],
      [
        // Fresh means fresh, in both senses: nothing restored, and nothing left waiting to ask
        // the same question at the next boot.
        'resume: Start fresh leaves no take and clears the stored copy',
        result.resumePrompt?.pressedFresh === true &&
          result.resumePrompt?.freshHasTake === false &&
          result.resumePrompt?.blobClearedByFresh === true
      ],
      [
        'resume: Resume previous work brings the take back',
        result.resumePrompt?.pressedResume === true &&
          result.resumePrompt?.promptOnResume?.shown === true &&
          (result.resumePrompt?.savedNotes ?? 0) > 0 &&
          (result.resumePrompt?.resumedNotes ?? 0) > 0
      ],

      [
        // PROPORTIONAL, NOT WRAPPED (#11). Below the threshold the shell SCALES. It used to
        // answer a narrow window by wrapping its bars into more rows, which spends the height
        // that was already short on chrome — the opposite of what somebody dragging a window
        // edge is asking for.
        'layout: at 360x280 the shell scales down instead of wrapping',
        typeof result.floor?.appZoom === 'number' && result.floor.appZoom < 1
      ],
      [
        // The measurable half of the same claim: the header is ONE row at 900x600 and, at
        // REAPER's 360x280 floor, has not multiplied. It is measured rather than asserted as
        // one row because 360 px cannot hold a filename, five chips, an Export menu and a
        // labelled gear on one line at any legible scale — what it must not do is answer a
        // smaller window by spending more of it on chrome, which is exactly what wrapping did.
        //
        // `headerRows` counts distinct row CENTRES now rather than distinct top edges, which
        // is what makes the first half of this check mean anything at all: a centre-aligned
        // header of mixed-height controls always had four or five distinct TOPS, so the old
        // `<= 3` was a threshold the bar could never have been under. See the probe. At 900px
        // the header is `nowrap`, so the honest number there is exactly 1.
        'layout: narrowing the window scales the shell rather than multiplying the chrome',
        typeof result.narrow?.header?.h === 'number' &&
          typeof result.floor?.header?.h === 'number' &&
          result.narrow.headerRows === 1 &&
          result.floor.header.h <= result.narrow.header.h * 2
      ],
      [
        // G4. TWO ROWS BETWEEN THE ROLL AND THE SHEET, not three. The transport is one of them
        // and the notation toolbar is the other; the tempo source belongs to the first and used
        // to wrap out of it into a band of its own at every plugin width. Asserted at 900x600
        // and at REAPER's 360x280 floor, because the failure was a width-dependent wrap and a
        // check at one width would have missed it exactly where it happened.
        'transport: one row at 900x600 and at the 360x280 floor',
        result.narrow?.transportRows === 1 && result.floor?.transportRows === 1
      ],
      ['900x600: no horizontal overflow', !!result.narrow && result.narrow.docScrollW <= result.narrow.innerW + 1],
      ['900x600: header buttons on screen', !!result.narrow && result.narrow.maxHeaderButtonRight <= 900],
      ['900x600: tri-view still drawn', !!result.narrow && result.narrow.svg > 0 && result.narrow.names > 0],
      ['900x600: tri-view has height', !!result.narrow && result.narrow.triview && result.narrow.triview.h > 120],
      ['1100x700: no horizontal overflow', !!result.mid && result.mid.docScrollW <= result.mid.innerW + 1],
      ['1100x700: header buttons on screen', !!result.mid && result.mid.maxHeaderButtonRight <= 1100],
      ['1100x700: tri-view still drawn', !!result.mid && result.mid.svg > 0 && result.mid.names > 0],

      // --- the names row, at every viewport ---------------------------------------
      ['names: staff/tab split found everywhere', layouts.every(([, l]) => !!l && l.hasSplit)],
      ['names: labels placed everywhere', layouts.every(([, l]) => !!l && l.labels > 0)],
      [
        `names: clear of the tab (>= ${MIN_CLEAR_BELOW_TAB}px)`,
        namesClearOf((l) => l.clearBelowTab >= MIN_CLEAR_BELOW_TAB)
      ],
      [
        `names: clear of the staff (>= ${MIN_CLEAR_ABOVE_STAFF}px)`,
        namesClearOf((l) => l.clearAboveStaff >= MIN_CLEAR_ABOVE_STAFF)
      ],
      ['names: no label sits on an engraved digit or number', namesClearOf((l) => l.textOverlaps === 0)],
      ['names: switching them off empties the row', !!result.namesOff && result.namesOff.labels === 0],
      [
        // STAFF_TAB_GAP, the whole of the reserved room, must come back out.
        'names: switching them off closes the reserved gap',
        !!result.namesOff && !!result.namesLayout &&
          result.namesLayout.tabTop - result.namesOff.tabTop >= 10
      ],
      [
        'names: switching them back on restores the clearance',
        !!result.namesBackOn && result.namesBackOn.labels > 0 &&
          result.namesBackOn.textOverlaps === 0 &&
          result.namesBackOn.clearBelowTab >= MIN_CLEAR_BELOW_TAB
      ],

      // --- stable DAW ruler ------------------------------------------------------------
      [
        'time ruler: piano roll is independent of engraving spacing',
        !!result.rollLinear?.roll && result.rollLinear.roll.linkedActive === false
      ],
      [
        'time ruler: the selected edit grid controls snapping',
        !!result.rollLinear?.roll && result.rollLinear.roll.snapSec > 0
      ],
      [
        'piano roll: pitch zoom actually changes row size',
        !!result.zoomBefore && !!result.zoomAfterWheel &&
          result.zoomBefore.pxPerSemitone !== result.zoomAfterWheel.pxPerSemitone
      ],
      [
        // ZOOM WITH NO MODIFIER, over the ruler. The row height has to actually change.
        'zoom: a plain wheel over the pitch ruler zooms it',
        !!result.zoomAfterWheel && !!result.zoomAfterGutterWheel &&
          result.zoomAfterGutterWheel.pxPerSemitone !== result.zoomAfterWheel.pxPerSemitone
      ],
      [
        // A VISIBLE control, for a mouse with no wheel and for anybody who never discovers a
        // gesture. Pressed for real, and the row height has to move.
        'zoom: the +/- control is on screen and works',
        result.zoomButtons?.inButton === true && result.zoomButtons?.outButton === true &&
          typeof result.zoomAfterButton?.before === 'number' &&
          result.zoomAfterButton?.after !== result.zoomAfterButton?.before
      ],
      [
        // RETIRED. Both chips are gone from the bar; their job is the double-click below.
        'zoom: the Fit and Reset view chips are retired',
        result.zoomButtons?.retiredFit === false && result.zoomButtons?.retiredReset === false
      ],
      [
        'zoom: a double-click on the ruler fits the pitch range again',
        !!result.zoomAfterReset && result.zoomAfterReset.fitLocked === true
      ],

      // --- v1.2: clicking a note highlights THAT note ---------------------------------
      // The reported bug: "all the previous notes before it in the piano roll highlights".
      // That was a played-progress fill, and it is gone. What is left is a selection of one.
      ['selection: clicking a rectangle selects exactly one note', !!result.rollNoteClick && result.rollNoteClick.rollSelection?.length === 1],
      ['selection: it is the note that was clicked', !!result.rollNoteClick && result.rollNoteClick.rollSelection?.[0] === result.rollNoteClick.wantedId],
      ['selection: the same note lights up on the sheet and tab', !!result.rollNoteClick && result.rollNoteClick.sheetSelection >= 1],

      // --- v1.2: rectangles are outlined ---------------------------------------------
      // "midi notes should have a visible outline... they may look like same notes without
      // the outline even tho there are two different hits."
      ['roll: rectangles carry an outline', !!result.roll?.roll && result.roll.roll.noteOutline === true],

      // --- v1.2: every row is named --------------------------------------------------
      ['roll: names more than the C rows', !!result.roll?.roll && ['all', 'naturals'].includes(result.roll.roll.labelMode)],

      // --- v1.2: the resize handle is discoverable ------------------------------------
      // It always worked; nobody could tell it was there. A grip that only exists on hover is
      // not an affordance, so its RESTING opacity is asserted rather than assumed.
      ['roll: resize handle is grabbable', !!result.rollHandleAffordance?.present && result.rollHandleAffordance.cursor === 'ns-resize' && result.rollHandleAffordance.heightPx >= 7],
      ['roll: resize grip is visible without hovering', !!result.rollHandleAffordance && result.rollHandleAffordance.gripOpacity >= 0.3 && result.rollHandleAffordance.gripWidthPx >= 20],

      // --- v1.2: the MIDI button is a drag source ------------------------------------
      // A real OS drag cannot be synthesised from a page, so what is checked here is that the
      // button is holding the right bytes under the right name. In the browser there is no
      // native drag at all and `armed` is correctly false — the capability test must stay
      // honest rather than promise a drag that cannot happen.
      ['MIDI drag: the button knows what it would drag', !!result.dragProbe && typeof result.dragProbe.bytes === 'number' && result.dragProbe.bytes > 0],
      ['MIDI drag: it drags the remembered variant', !!result.dragProbe && result.dragProbe.mode === 'as-played' && /-as-played\.mid$/.test(result.dragProbe.name ?? '')],
      ['MIDI drag: no OS drag is promised in a browser', !!result.dragProbe && result.dragProbe.hasBridge === false && result.dragProbe.armed === false],

      // --- ties: one note, several noteheads, ONE id ------------------------------------
      ['ties: the index resolves an id to every notehead', !!result.ties && result.ties.ids > 0],
      [
        // THE REPORTED BUG. A note held across a bar line is drawn as several tied noteheads,
        // and this row used to label every one of them — so one held A1 read as
        // "A1 A1 A1 A1 A1 A1 A1" and looked like the transcriber stuttering.
        'names: one name per attack, not one per notehead',
        !!result.ties && result.ties.labelsDrawn === result.ties.attacks
      ],
      [
        // Proves the fixture actually exercises it — without a tie in the score the check above
        // passes for the wrong reason.
        'names: the test score really does contain tied continuations',
        !!result.ties && result.ties.continuations > 0
      ],
      [
        // And the other half, which is what stops "fixed" being indistinguishable from "labels
        // deleted": a pitch the player struck AGAIN is not a continuation and keeps its name.
        //
        // THIS USED TO BE VACUOUS. It asserted `attacks >= restruckAttacks`, which is true by
        // construction — a re-struck attack IS an attack, counted by the same walk — so the
        // check passed whatever the names row had actually drawn, and its only real content
        // was `restruckAttacks > 0`. It now compares against `restruckNamed`, which the probe
        // measures off the DOM: for every re-struck attack it looks up that pitch's own label
        // text in the row and consumes it from a multiset, so two identical names cannot cover
        // for one that went missing. See `__RIFFSHEET_TIES__` in ui/app.ts.
        //
        // THE `> 0` IS GONE WITH IT, and that is the second half of the same correction. It
        // was a claim about the FIXTURE, not about the app — and this fixture has no re-struck
        // pitch in it (77 attacks, 17 tied continuations, 0 re-struck), so the check has been
        // failing on a precondition it cannot meet rather than on anything the app does. The
        // rule is what belongs here, and it is the rule that will catch a regression the day
        // a fixture with one arrives. The demonstration that names are per-attack and not
        // per-notehead is the check two rows above, on real numbers: 77 labels for 94
        // noteheads, which is exactly the 17 continuations going unnamed.
        'names: a re-struck note keeps every name',
        !!result.ties &&
          result.ties.restruckNamed === result.ties.restruckAttacks &&
          result.ties.attacks === result.ties.noteheads - result.ties.continuations &&
          result.ties.continuations > 0
      ],
      [
        // The fixture has to actually contain a tie, or the three checks below are vacuous.
        'ties: the test score really does contain a held note',
        !!result.ties && result.ties.tiedIds > 0 && result.ties.maxGlyphsPerId > 1
      ],
      [
        // The reported symptom, stated as a rule: the glyph an id resolves to must be the one
        // that owns the fret digit, i.e. NOT a tie destination.
        'ties: an id resolves to the notehead that carries the fret',
        !!result.ties && result.ties.firstIsTieDestination === false && result.ties.headMatchesIdToNote === true
      ],
      [
        'ties: every notehead of a held note agrees on string and fret',
        !!result.ties && result.ties.chainsDisagreeing === 0
      ],

      // --- v1.3: the tuner, and the pitch detector it rests on -------------------------
      // A tuner that is confidently wrong is worse than no tuner — the player will believe it
      // over their own ears. So the accuracy is asserted on every build, not measured once.
      ['pitch: the self-test ran', !!result.pitchSelfTest && Array.isArray(result.pitchSelfTest.cases) && result.pitchSelfTest.cases.length >= 20],
      ['pitch: no tone was missed', !!result.pitchSelfTest && result.pitchSelfTest.missed === 0],
      [
        // Half a semitone is 50 cents; anything approaching that names the wrong note. 10 is a
        // deliberately loose ceiling on a detector measuring ~0.02 median — it is a tripwire
        // for a regression, not the standard being claimed.
        'pitch: worst error stays under 10 cents',
        !!result.pitchSelfTest && typeof result.pitchSelfTest.worstCents === 'number' &&
          result.pitchSelfTest.worstCents < 10
      ],
      [
        'pitch: median error under 1 cent',
        !!result.pitchSelfTest && typeof result.pitchSelfTest.medianCents === 'number' &&
          result.pitchSelfTest.medianCents < 1
      ],
      [
        // The gesture the whole feature hangs on: you must be able to point at a moment where
        // the transcriber heard nothing, without first inventing a note there.
        'tuner: clicking the waveform picks out a moment',
        !!result.waveSelect?.clicked && typeof result.waveSelect.selectionFromSec === 'number' &&
          typeof result.waveSelect.selectionToSec === 'number' &&
          result.waveSelect.selectionToSec > result.waveSelect.selectionFromSec
      ],
      ['tuner: it opens on that moment', !!result.waveSelect?.tunerOnScreen && !!result.waveSelect.tuner],

      // --- G8: "Cut out 0.1s" ------------------------------------------------------------
      [
        // The mode exists and starts OFF, so the strip a player meets is still the tuner's.
        'cut: the strip has a Cut mode and it is off until asked for',
        result.cutArmBefore?.present === true &&
          result.cutArmBefore?.pressed === 'false' &&
          result.cutArmBefore?.armed === false
      ],
      [
        // UNARMED, A DRAG IS STILL A CLICK. This is what makes the mode worth having: the
        // tuner's gesture — point at one moment, get one answer — cannot be made ambiguous by
        // the cut feature. A span here would mean the mode had been skipped.
        'cut: unarmed, dragging the strip still gives the fixed probe window',
        result.cutDragUnarmed?.dragged === true &&
          typeof result.cutDragUnarmed.spanSec === 'number' &&
          Math.abs(result.cutDragUnarmed.spanSec - (result.waveSelect?.probeWindowSec ?? 0.1)) < 0.01
      ],
      [
        // ARMED, THE DRAG IS A SPAN — and the button says so. The label is the whole of the
        // reported bug: it read "Cut out 0.1s" whatever you did, because 0.1s was the only
        // selection the app could make. A third of this take is seconds, not tenths.
        'cut: armed, a drag sweeps out a real span and the button offers to cut it',
        result.cutArmClick?.clicked === true &&
          result.cutDragArmed?.selectArmed === true &&
          typeof result.cutDragArmed?.spanSec === 'number' &&
          result.cutDragArmed.spanSec > 1 &&
          /^Cut out \d+(\.\d)?s$/.test(result.cutDragArmed.cutLabel ?? '') &&
          !/Cut out 0\.1s/.test(result.cutDragArmed.cutLabel ?? '')
      ],
      [
        // The tuner is calibrated on one steady pitch. Handing it eight seconds of a riff is
        // the failure the drag gesture was removed for in v1.2, so the span must not open it.
        'cut: a span does not open the tuner',
        result.cutDragArmed?.tunerOnScreen === false
      ],
      [
        // THE EDGES ARE HANDLES. Grab the left one, pull it earlier, and the span grows from
        // that end with the other pinned — otherwise a selection is something you can only make
        // once and never correct.
        'cut: either edge of the span can be dragged to adjust it',
        result.cutDragEdge?.dragged === true &&
          typeof result.cutDragEdge.spanSec === 'number' &&
          typeof result.cutDragArmed?.spanSec === 'number' &&
          result.cutDragEdge.spanSec > result.cutDragArmed.spanSec + 0.2 &&
          Math.abs((result.cutDragEdge.selectionToSec ?? 0) - (result.cutDragArmed.selectionToSec ?? -1)) < 0.05
      ],
      [
        // And the way out. A mode that outlives the edit it was armed for is a mode somebody
        // gets stuck in, so disarming has to put the click-to-probe gesture back exactly.
        'cut: disarming gives the strip its probe gesture back',
        result.cutDisarmClick?.clicked === true &&
          result.cutAfterDisarm?.clicked === true &&
          typeof result.cutAfterDisarm.selectionToSec === 'number' &&
          Math.abs(
            result.cutAfterDisarm.selectionToSec -
              result.cutAfterDisarm.selectionFromSec -
              result.cutAfterDisarm.probeWindowSec
          ) < 0.01
      ],

      // --- G16a: the vertical lines in the waveform --------------------------------------
      [
        /*
         * The player's "vertical lines in the waveform" were the body bracket's two 1px edge
         * rails. They look like bar lines or cut seams, they are neither, and they move
         * whenever the sheet scrolls — while the dim wash on either side already says
         * everything the bracket has to say.
         *
         * Measured on the PIXELS, because "we deleted the fillRect" is the kind of claim a
         * later refactor undoes by accident. A full-height rail is the only mark in this strip
         * whose column has no dark pixel anywhere down it, so the test is the column's DIMMEST
         * pixel against the same measure six pixels away. Equal-ish means no rail; a rail
         * column would sit hundreds of units brighter.
         */
        'waveform: the viewport bracket draws no vertical rails on the body',
        result.bodyRails?.measured === true &&
          typeof result.bodyRails.railColumn === 'number' &&
          typeof result.bodyRails.neighbourColumn === 'number' &&
          result.bodyRails.railColumn <= result.bodyRails.neighbourColumn + 30
      ],
      [
        // A fixed window, not whatever the pointer happened to cover. Long enough for the pitch
        // detector to get three agreeing frames, short enough not to straddle two notes.
        'tuner: the window is the fixed probe width',
        !!result.waveSelect &&
          typeof result.waveSelect.probeWindowSec === 'number' &&
          Math.abs(
            result.waveSelect.selectionToSec - result.waveSelect.selectionFromSec - result.waveSelect.probeWindowSec
          ) < 0.005
      ],
      [
        'waveform and roll both use the stable recording-time ruler',
        !!result.waveSelect && !!result.roll &&
          result.waveSelect.sheetLinked === false && result.roll.roll?.linkedActive === false
      ],
      [
        // The roll must hand height back while the tuner is up. Asserted on the SHEET, because
        // the sheet is what gets squeezed and the sheet is the point of the whole app.
        'tuner: the sheet keeps its room while the tuner is open',
        !!result.rollWithTuner && result.rollWithTuner.triviewHeight > 200
      ],
      ['tuner: Escape closes it and clears the selection', !!result.tunerClosed && result.tunerClosed.onScreen === false && result.tunerClosed.selection === null],

      // --- the audio-check panel is HALF the height it was ------------------------------
      //
      // It was 58-86px. This window is already more chrome than music and the panel is a
      // readout you glance at, so the space it was taking came out of the sheet — which is the
      // point of the app. The stylesheet now says 29-43px; these read the panel's own box.
      //
      // `contentFits` is the half that stops this being achieved with `overflow: hidden`: the
      // type, padding and gaps were scaled with the box, so the contents genuinely fit rather
      // than being clipped by it. Asserted at the default size AND at both of the sizes the
      // player actually uses.
      [
        'audio check: the panel is half its old height',
        !!result.tunerBox && result.tunerBox.panelHeight > 0 && result.tunerBox.panelHeight <= 48
      ],
      [
        'audio check: its contents fit rather than being clipped',
        !!result.tunerBox && result.tunerBox.contentFits === true
      ],
      [
        'audio check: still fits at 900x600 and 360x280',
        !!result.tunerBoxMid && !!result.tunerBoxNarrow &&
          result.tunerBoxMid.panelHeight <= 48 && result.tunerBoxMid.contentFits === true &&
          result.tunerBoxNarrow.panelHeight <= 56 && result.tunerBoxNarrow.contentFits === true &&
          result.tunerBoxNarrow.closeVisible === true
      ],
      [
        // FAR RIGHT, not mid-panel. It used to sit beside the title, in the middle of a
        // four-column strip — the one place on a horizontal bar nobody looks for a way out.
        'audio check: the close button is at the far right edge',
        !!result.tunerBox && result.tunerBox.closeIsLastChild === true &&
          result.tunerBox.closeVisible === true && result.tunerBox.closeInsetPx <= 12
      ],
      [
        // ...and lit, as a chip like every other control here rather than a bare glyph. The
        // colour is read off the element, so a stylesheet that stopped applying would fail.
        // "Highlighted" measured as a COMPARISON: its border differs from a plain button in
        // the same panel. Against a literal colour this would pass on a stylesheet that had
        // turned every control that colour, which is not the claim being made.
        'audio check: the close button is highlighted, not bare punctuation',
        !!result.tunerBox && result.tunerBox.closeIsChip === true &&
          /rgb/.test(result.tunerBox.closeBorderColor ?? '') &&
          result.tunerBox.closeBorderColor !== result.tunerBox.plainBorderColor &&
          result.tunerBox.closeWidth > 0
      ],
      [
        // The mouse path is the primary one: REAPER eats most keystrokes before the plugin
        // sees them, so Esc is the convenience and this is the guarantee.
        'audio check: clicking the close button closes it',
        !!result.tunerCloseClick && result.tunerCloseClick.found === true &&
          result.tunerCloseClick.onScreen === false
      ],


      // --- v1.2: the piano roll is editable, and the sheet follows --------------------
      ['roll edit: a rectangle was actually dragged', !!result.rollEditDrag?.dragged],
      [
        // The tab's own fret digits and the note-name row, read off the rendered DOM. A
        // rectangle that only LOOKED like it moved — the class of bug this area has produced
        // twice — leaves both of these exactly as they were.
        'roll edit: the engraved tab and note names changed',
        !!result.rollEditBefore && !!result.rollEditAfter &&
          result.rollEditAfter.engraved !== result.rollEditBefore.engraved &&
          result.rollEditAfter.names !== result.rollEditBefore.names
      ],
      [
        // ...and it moved the RIGHT way. Dragging up is more semitones, not fewer.
        'roll edit: dragging up raised the pitch',
        !!result.rollEditBefore && !!result.rollEditAfter &&
          result.rollEditAfter.firstMidi !== null &&
          result.rollEditAfter.firstMidi >= result.rollEditBefore.firstMidi
      ],
      [
        // Nothing was lost or invented on the way through the pipeline.
        'roll edit: no notes gained or lost',
        !!result.rollEditBefore && !!result.rollEditAfter &&
          result.rollEditAfter.rollNotes === result.rollEditBefore.rollNotes
      ],
      [
        // One ⌘Z puts it back. Roll edits and sheet edits share one history, so this is also
        // the check that the shared undo did not lose track of which layer was last.
        'roll edit: undo puts the sheet back',
        !!result.rollEditBefore && !!result.rollEditUndone &&
          result.rollEditUndone.engraved === result.rollEditBefore.engraved &&
          result.rollEditUndone.names === result.rollEditBefore.names &&
          result.rollEditUndone.firstMidi === result.rollEditBefore.firstMidi
      ],

      // --- piano roll ---------------------------------------------------------------
      ['piano roll: pane present, on by default', !!result.roll && result.roll.pane && result.roll.visible],
      ['piano roll: chip present', !!result.roll && result.roll.toggle],
      ['piano roll: drew notes from the score', !!result.roll?.roll && result.roll.roll.notes > 0],
      [
        'piano roll: pitch range spans the riff',
        !!result.roll?.roll && result.roll.roll.highMidi - result.roll.roll.lowMidi >= 10
      ],
      [
        // The demo has a 0.9s count-in. The first rect must land ON it, not at x=0 — that
        // is the whole point of the bar-1 origin, and it is what keeps the roll lined up
        // with the waveform directly above it.
        'piano roll: first note sits at bar 1, not at x=0',
        !!result.roll?.roll && result.roll.roll.barOneSec > 0.1 &&
          result.roll.roll.firstNoteSec !== null &&
          Math.abs(result.roll.roll.firstNoteSec - result.roll.roll.barOneSec) < 0.15
      ],
      [
        // One ruler: the roll's canvas must be exactly as wide as the waveform above it,
        // or a note does not sit over the sound that made it.
        'piano roll: shares the waveform width',
        !!result.roll?.roll && !!result.layout?.wave &&
          Math.abs(result.roll.roll.width - result.layout.wave.w) <= 1
      ],
      [
        // Half way along the MUSIC, which is not half way along the canvas any more: the
        // gutter comes off first. 0.05s of slack, where the old check allowed 0.6 — an
        // ignored gutter is worth about 0.25s here and used to slip through.
        'piano roll: click seeks the transport, gutter accounted for',
        !!clickPos && clickPos.positionSec !== null && clickPos.wantSec !== null &&
          Math.abs(clickPos.positionSec - clickPos.wantSec) < 0.05
      ],
      [
        'piano roll: clicking the label gutter does not seek',
        result.rollAfterGutterClick !== null && clickPos &&
          Math.abs(result.rollAfterGutterClick - clickPos.positionSec) < 0.01
      ],
      [
        // The two strips are one timeline. Same pixel, same second, or a note stops sitting
        // over the sound that made it — which is the whole reason this pane exists.
        // Was: click the roll at x, then the strip at x, and compare where the transport
        // landed. That worked while both panes always showed the whole take. It cannot survive
        // Align, because the first click SEEKS — which takes the sheet with it, which moves the
        // shared window — so the second click is answering a different question by the time it
        // is asked. Both rulers are now interrogated at the same instant instead, which is a
        // stricter statement of the same claim and has no gesture in it to perturb anything.
        'piano roll: the same x on the waveform means the same second',
        typeof result.sharedRuler?.rollMidSec === 'number' &&
          typeof result.sharedRuler?.waveMidSec === 'number' &&
          Math.abs(result.sharedRuler.rollMidSec - result.sharedRuler.waveMidSec) < 0.02
      ],
      [
        // ...and with Align on, that shared second is the sheet's, not an accident of both
        // panes happening to draw the whole take.
        'align: the roll and the strip are given the SAME window',
        result.sharedRuler?.rollWindow === null
          ? result.sharedRuler?.waveWindow === null
          : Math.abs((result.sharedRuler?.rollWindow ?? 0) - (result.sharedRuler?.waveWindow ?? -1)) < 0.001
      ],
      ['piano roll: chip collapses the pane', !!result.rollOff && !result.rollOff.visible && result.rollOff.paneHeight < 40],
      ['piano roll: chip brings it back', !!result.rollBackOn && result.rollBackOn.visible && (result.rollBackOn.roll?.notes ?? 0) > 0],
      ['piano roll: survives every viewport', [result.narrow?.roll, result.mid?.roll].every((r) => !!r?.roll && r.roll.notes > 0)],

      // --- the pitch gutter -------------------------------------------------------------
      ['piano roll: a gutter is reserved for pitch labels', everyRollState((r) => r.gutterPx > 0)],
      [
        'piano roll: the gutter comes out of the plot, not out of nowhere',
        everyRollState((r) => r.plotWidth === r.width - r.gutterPx)
      ],
      [
        // Octave C's, on their lines. Empty at any height is the failure mode that matters:
        // a label column with nothing in it is worse than no column.
        'piano roll: octave labels at every pane height',
        everyRollState((r) => r.labels.length > 0 && r.labels.every((l) => LABEL_RE.test(l)))
      ],
      [
        // Thinning, not shrinking. Two labels closer together than their own type size are
        // two smudges; the rule is to drop whole octaves instead, so the gap between the ones
        // that DID get drawn has to stay above a legible minimum at every height.
        'piano roll: labels thin out rather than collide',
        everyRollState(labelGapOk)
      ],

      // --- the roll follows the sheet, not a snapshot of it -----------------------------
      [
        // 'performance', NOT 'model'. The roll used to walk alphaTab's live MODEL, which was
        // itself the fix for it having walked the build-time IR — and #36 moved it one step
        // further back again, to the PERFORMANCE feed, because a roll drawn off the engraving
        // re-timed the player's own recording whenever the Quantize menu changed. All three
        // names are in `view/pianoroll.ts §source`; 'ir' is still the one that must never
        // appear on a live take, and this is the check that says so.
        'piano roll: reads the performance, not the build-time IR',
        everyRollState((r) => r.source === 'performance')
      ],
      [
        // THE DELTA IS NULL NOW, AND THAT IS THE ASSERTION.
        //
        // It used to be a number: two walks of the same score on two different tick
        // resolutions, which had to agree to the floating-point noise. Since #36 the roll does
        // not walk the score at all — it draws the PERFORMANCE — so there is only one walk and
        // no delta to report, and `view/pianoroll.ts §rebuildNotes` sets it to null rather than
        // leaving a stale number behind. Demanding a number here was demanding the old design.
        //
        // What survives, and is the half that was always worth checking: the roll and the
        // engraving still agree on HOW MANY notes there are before anything has been edited.
        // A performance that has quietly gained or lost one against the sheet built from it is
        // the same class of bug the delta was watching for.
        'piano roll: the performance and the sheet agree before any edit',
        !!result.roll?.roll && result.roll.roll.irDeltaSec === null &&
          typeof result.roll.roll.notes === 'number' && result.roll.roll.notes === result.roll.roll.irNotes
      ],
      // --- #36: the roll shows the PERFORMANCE, so the Quantize menu cannot move it -----
      [
        // THE ACCEPTANCE TEST for #36, and the reason the roll stopped walking the engraving:
        // choosing 1/4 visibly re-timed the player's own recording in the one view that is
        // supposed to be a picture of it. Byte-identical note list at four Quantize values.
        'snap feed: the roll draws the same notes at every Quantize value',
        !!result.snapFeed && !result.snapFeed.error && result.snapFeed.feedStableAcrossGrids === true
      ],
      [
        // ...and the SHEET is not identical, or the line above would be true for the wrong
        // reason (a menu that reaches nothing at all passes a stability check trivially).
        'snap feed: ...while the sheet does change',
        !!result.snapFeed && result.snapFeed.sheetChangedAcrossGrids === true
      ],
      [
        // PLAYBACK UNCHANGED, by identity rather than by comparison: with Snap off,
        // `performanceFeed()` hands `scoreToSynthNotes` the take's own array — the same
        // object it got before this feature existed, not merely an equal one.
        'snap feed: with snap off, playback gets the take’s own array',
        !!result.snapFeed && result.snapFeed.feedIsRawObjectWhenSnapOff === true
      ],
      [
        // #41: and the snap layer itself — on moves the feed, finer moves it further, and
        // switching it off returns the raw take rather than a re-snapped approximation of it.
        'snap feed: snapping on/finer/off round-trips to the raw take',
        !!result.snapFeed && result.snapFeed.snapMovesTheFeed === true &&
          result.snapFeed.finerGridDiffers === true && result.snapFeed.resnapFromRaw === true &&
          result.snapFeed.snapRoundTripsToRaw === true
      ],

      [
        // THE REPORTED BUG. Pitch a note up on the sheet; its rectangle must move up here.
        'edit sync: a pitch change moves the rectangle',
        editOk && ed.after.midi === ed.before.midi + ed.semitones &&
          ed.before.y !== null && ed.after.y !== null && ed.after.y < ed.before.y
      ],
      [
        // ...with the pitch range unmoved, so the rectangle moved because the NOTE did and
        // not because the whole pane rescaled underneath it.
        'edit sync: on a scale that did not move under it',
        editOk && ed.after.lowMidi === ed.before.lowMidi && ed.after.highMidi === ed.before.highMidi &&
          ed.after.notes === ed.before.notes
      ],
      [
        'edit sync: undo puts the rectangle back',
        editOk && ed.undone.midi === ed.before.midi && Math.abs(ed.undone.y - ed.before.y) < 0.01
      ],
      [
        'edit sync: redo moves it again',
        editOk && ed.redone.midi === ed.after.midi && Math.abs(ed.redone.y - ed.after.y) < 0.01
      ],

      // --- the pane's height belongs to the player --------------------------------------
      ['piano roll: the bottom edge carries a resize handle', !!result.rollResizeBase?.handle],
      [
        'piano roll: the handle says it is draggable',
        result.rollResizeBase?.handleCursor === 'ns-resize' && result.rollResizeBase?.handleHeight >= 5
      ],
      [
        'piano roll: opens at the roomy default, not the old 96px',
        !!result.rollResizeBase && result.rollResizeBase.paneHeight >= 140
      ],
      [
        'piano roll: dragging the edge down makes it taller',
        !!result.rollDragDown && result.rollDragDown.after - result.rollDragDown.before >= 80
      ],
      [
        'piano roll: the drag is written down',
        !!result.rollTall && result.rollTall.savedHeight === result.rollTall.paneHeight
      ],
      [
        'piano roll: a taller pane shows more rows, at the same row height',
        !!result.rollTall?.roll && !!result.rollResizeBase?.roll &&
          result.rollTall.roll.visibleSemitones > result.rollResizeBase.roll.visibleSemitones
      ],
      [
        // 40% of the window, and never so much of a short one that the sheet is squeezed out.
        'piano roll: cannot be dragged past its ceiling',
        !!result.rollHuge?.roll && result.rollHuge.paneHeight === result.rollHuge.roll.maxHeight &&
          result.rollHuge.paneHeight <= Math.round(result.rollHuge.viewportH * 0.4)
      ],
      [
        'piano roll: cannot be dragged below its floor',
        !!result.rollShort?.roll && result.rollShort.paneHeight === result.rollShort.roll.minHeight &&
          result.rollShort.paneHeight >= 46
      ],
      [
        // A fresh page load with nothing but the settings file to go on. This is the claim
        // "it stays where you leave it" — the harness left it at the floor a navigation ago.
        'piano roll: the height survives a reload',
        !!result.dropTuned?.roll && !!result.rollShort &&
          result.dropTuned.roll.paneHeight === result.rollShort.paneHeight &&
          result.dropTuned.roll.savedHeight === result.rollShort.savedHeight
      ],
      [
        // Even wound all the way out. The roll taking the window is the failure this whole
        // clamp exists to prevent, and it is the one a screenshot would flatter.
        'piano roll: the sheet keeps its room even at the ceiling',
        !!result.rollHuge && result.rollHuge.triviewHeight > 200
      ],

      // --- one timebase: cursor vs audio vs roll ---------------------------------------
      [
        // The v1.1 bug: the sheet cursor converted transport seconds to ticks with no bar-1
        // origin, so it ran ahead of the audio (and the waveform, and the roll) by the whole
        // count-in — and the synth carried the same offset, so the MIDI voice agreed with
        // the cursor and with nothing else. Both demos have a 0.9s lead-in, so a missing
        // origin shows up as 0.9 here. Checked on the tri-view demo AND the drop-tuned one.
        'timebase: cursor, synth and roll share the bar-1 origin',
        [result.timebase, result.dropTuned?.timebase].every(
          (tb) =>
            !!tb &&
            tb.barOneSec > 0.1 &&
            tb.rollOriginSec !== null &&
            // one origin, three consumers
            Math.abs(tb.cursorOriginSec - tb.rollOriginSec) < 0.005 &&
            // tick 0 of the sheet IS bar 1 in the recording, not the top of the file
            Math.abs(tb.cursorSecAtTick0 - tb.barOneSec) < 0.005 &&
            Math.abs(tb.tickAtBarOne) < 1 &&
            // and what you hear starts where what you see starts
            tb.synthNotes > 0 &&
            tb.firstRollNoteSec !== null &&
            Math.abs(tb.firstSynthNoteSec - tb.firstRollNoteSec) < 0.02
        )
      ],

      // --- playback plays the take, not the grid ---------------------------------------
      //
      // The player's report: "the exported MIDI sounds great in my sampler, the in-app
      // playback is robotic." Both halves were literally true. The export writes the AS-PLAYED
      // variant by default — the seconds the engine reported — while playback read the
      // ENGRAVED model, where every onset has been rounded onto a metric grid so the sheet can
      // be written at all. Measured on this repository's own triplet fixture with ordinary
      // human timing applied, that rounding moves the attack a median of 7-26 ms and as much
      // as 77 ms. That is not a subtle difference on a bass line; it is the difference between
      // a performance and a drum machine.
      //
      // The fix takes pitch, identity, velocity and tie-grouping from the engraving — every
      // property the sampler and the notation edits depend on — and only the two time fields
      // from the performance. These four checks are the two halves of that, plus the proof it
      // cleans up after itself.
      [
        'playback: the synth strikes a note where it was PLAYED',
        !!result.playbackTiming && result.playbackTiming.synthFollowsPerformance === true &&
          result.playbackTiming.synthAtMs === result.playbackTiming.playedAtMs
      ],
      [
        // The other half, and the one that stops this being "we deleted quantization". An
        // off-grid onset is not engravable and a sheet that drew it would be unreadable, so
        // the notation MUST still snap — the two views are allowed to disagree, and this is
        // the case where they have to.
        'playback: the sheet still snaps that note to the grid',
        !!result.playbackTiming && result.playbackTiming.engravingSnappedBack === true &&
          result.playbackTiming.engravedAtMs !== result.playbackTiming.playedAtMs
      ],
      [
        // Every note, not just the nudged one: on an exact fixture the grid and the take agree,
        // so what this catches is a build where the performance stopped reaching the synth at
        // all (a call site that forgot it, an id that stopped matching).
        'playback: every played note is struck at its own time',
        !!result.timebase && result.timebase.playedNotes > 0 &&
          result.timebase.followsPerformance === result.timebase.playedNotes
      ],
      [
        'playback: the timing probe leaves the take as it found it',
        !!result.timebaseAfterPlayback && !!result.timebase &&
          result.timebaseAfterPlayback.synthNotes === result.timebase.synthNotes &&
          result.timebaseAfterPlayback.followsPerformance === result.timebase.followsPerformance
      ],

      // --- session persistence: plugin amnesia ------------------------------------------
      // Six claims, in the order they have to be true: the host can store anything at all;
      // the mutation was real (or "identical" would be a tautology); the blob holds the
      // notes rather than a promise to listen again; the edits are written down; a second
      // app with nothing but the blob comes up on the main screen; and what it shows is the
      // same score, note for note, edit for edit, down to the fader position.
      [
        'session: the host can store per-instance state',
        !!result.persist && !result.persist.error && result.persist.mutated?.canSave === true
      ],
      [
        'session: the probe really changed the score',
        !!result.persist && result.persist.mutationChangedTheScore === true
      ],
      [
        'session: the blob carries the take, so no re-transcription',
        !!result.persist && result.persist.storedDetectedNotes > 0 && result.persist.storedPeakBuckets > 0
      ],
      [
        // Two edits of different kinds must be in the blob, and the undo cursor must point
        // at the last of them. A refused action (the probe attempts one) must NOT be there.
        'session: the edits are written down, refusals are not',
        !!result.persist &&
          result.persist.storedEdits === result.persist.mutated?.edits &&
          result.persist.storedCursor === result.persist.storedEdits - 1 &&
          (result.persist.mutated?.editKinds ?? []).includes('pitch') &&
          (result.persist.mutated?.editKinds ?? []).includes('delete')
      ],
      [
        // A deleted note must still be gone after the restore. It is the one edit whose
        // loss a fingerprint comparison alone could hide, because a missing note simply
        // reappearing changes the count in a direction "more notes" looks healthy in.
        'session: a deleted note stays deleted across the boot',
        !!result.persist &&
          result.persist.restored?.noteCount === result.persist.mutated?.noteCount &&
          result.persist.mutated?.noteCount === result.persist.before?.noteCount - 1
      ],
      [
        'session: a cold boot restores from the blob alone',
        !!result.persist && result.persist.restored?.restored === true && result.persist.restored?.screen === 'main'
      ],
      [
        'session: the cold boot is identical, note for note',
        !!result.persist && Array.isArray(result.persist.identical) && result.persist.identical.length === 0
      ],
      [
        // A DAW project file has to carry this. Tens of KB is right; megabytes would mean
        // something (raw PCM, most likely) had leaked into the blob.
        'session: the blob is small enough to live in a project file',
        !!result.persist && result.persist.blobBytes > 500 && result.persist.blobBytes < 2_000_000
      ],

      // --- .riffsheet documents: the four things Save as has to carry -------------------
      // A document is the portable form of a session, so it owes the user the same four
      // things: the take it is OF, the performed notes, the edits, and the settings. Three
      // were carried and the audio reference was not — the loader replaced it with a MIDI
      // stub, which silently killed the fader's Original side and Listen again on every
      // reopen. The session probe above could not catch it: the BLOB carries `audio`, only
      // the document did not.
      [
        'document: a saved take names the recording it came from',
        !!result.document &&
          !result.document.error &&
          result.document.syntheticAudio?.kind === 'file' &&
          result.document.syntheticAudio?.path === '/takes/probe take.wav' &&
          result.document.syntheticAudio?.durationSec === 12.5
      ],
      [
        // The two volatile handles name a decode inside the process that wrote the file.
        // Written into a document they are worse than absent: `reopenOriginal` tries the
        // dead token first and the path that would have worked second.
        // Gated on the reference actually being there: "no token in the file" is trivially
        // true of a file that names no take at all, which is precisely the bug this pair
        // of checks exists to keep out.
        'document: the process-local audio handles are not written to disk',
        !!result.document && result.document.syntheticAudio?.name === 'take.wav' && result.document.tokenInBytes === false
      ],
      [
        'document: the performed notes travel, so a reopen never re-listens',
        !!result.document && result.document.performedNotes > 0 && result.document.performedNotesMatchLive === true
      ],
      [
        // Both halves: the log AND where the user is in it. They differ here because the
        // persistence probe wound the cursor back, which is the case a single length
        // comparison would pass while losing every undo.
        'document: the edit log and the undo cursor both travel',
        !!result.document &&
          result.document.edits === result.document.liveEdits &&
          result.document.edits > 0 &&
          result.document.editCursor === result.document.liveEditCursor
      ],
      [
        'document: the settings the sheet was engraved with travel',
        !!result.document && result.document.settingsMatch === true && result.document.settingsKeys > 10
      ],
      [
        // THE VERSION IS 3 NOW, and the claim has changed with it.
        //
        // It was 1, and this check asserted that adding the audio REFERENCE had not moved it —
        // an additive optional field, and a bump for one would have orphaned every document
        // already written. v2 was a different act: the take itself moved INSIDE the file
        // (`audioData`), which is what made a .riffsheet portable, and that earned the number.
        // v3 changes the CONTAINER — a zip holding score.json plus the audio STORED verbatim,
        // instead of base64 inside the JSON, which cost seven or eight times the recording in
        // memory to write. `RIFFSHEET_DOCUMENT_VERSION` in app/persist.ts is the source of
        // truth; the reader still accepts v1 and v2 documents by their magic bytes, which is
        // the property that actually protects people and is checked by
        // `scripts/riffsheet-doc-test.ts`.
        'document: the current writer stamps the current version',
        !!result.document && result.document.version === 3
      ],
      [
        // The container is the point of v3, so it is asserted rather than assumed, together
        // with the claim the STORE'd entry exists to make: the recording comes back out at
        // exactly the length it went in at.
        'document: the file is a zip and its audio survives byte for byte',
        !!result.document &&
          result.document.container === 'zip' &&
          result.document.audioIn === result.document.audioOut
      ],

      // --- About: support the makers ---------------------------------------------------
      //
      // Three claims about other people's projects, in the order they matter: the section is
      // there at all; the one instruction an upstream attached to their own donation link is
      // still attached to it; and nobody who declined money — or never offered a way to take
      // it — has been given a wallet on their behalf.
      [
        'support: the About screen carries a Support the makers section',
        !!support?.present && support.heading === true && support.laidOut === true
      ],
      [
        'support: every upstream is listed, grouped and ordered as the copy was written',
        JSON.stringify(support?.order ?? []) === JSON.stringify(SUPPORT_ORDER) &&
          JSON.stringify(support?.groups ?? []) ===
            JSON.stringify(['Further upstream', 'Cite the paper or star the repo', 'Licences, not donations'])
      ],
      [
        // Versilian's own condition. Money sent without it does not reach VCSL, so dropping
        // this sentence would turn a working link into a misleading one.
        'support: Versilian carries the VCSL earmark instruction',
        !!supportRow('versilian') &&
          /VCSL/.test(supportRow('versilian').text) &&
          /payment description/i.test(supportRow('versilian').text) &&
          supportRow('versilian').href === 'https://paypal.me/versilian'
      ],
      [
        'support: no project without a funding channel is given one',
        !!support?.present && support.walletsWithoutAChannel.length === 0
      ],
      [
        'support: the only money links are the three that were verified upstream',
        JSON.stringify([...(support?.moneyLinks ?? [])].sort()) === JSON.stringify([...VERIFIED_MONEY].sort())
      ],
      [
        // MuseScore is the loudest "no" on the list and the deepest debt on it, which is
        // exactly the combination that invites a well-meaning donate button.
        'support: MuseScore is quoted declining money and pointed at contributing instead',
        !!supportRow('musescore') &&
          supportRow('musescore').money === false &&
          /most valuable donation you can give us is your time/i.test(supportRow('musescore').text) &&
          supportRow('musescore').href === 'https://musescore.org/en/contribute'
      ],
      [
        'support: alphaTab and Basic Pitch ask for a star, not a payment',
        ['alphatab', 'basic-pitch'].every((id) => {
          const row = supportRow(id);
          return !!row && row.money === false && row.wallet === false && /^https:\/\/github\.com\//.test(row.href ?? '');
        })
      ],
      [
        // `_blank` in a browser, and NOT in the plugin: there it means
        // `newWindowAttemptingToLoad`, which the shell does not override, so the click died.
        // The harness runs in a browser, so `_blank` is the expected reading here — the plugin
        // half of the rule is asserted against the source below, which is the only place a
        // browser-driven harness can see it.
        'support: every link is https and leaves the app',
        supportLinks.length > 0 &&
          supportLinks.every((r) => /^https:\/\//.test(r.href) && r.target === '_blank' && /noopener/.test(r.rel ?? ''))
      ],
      [
        // In the plugin the same link must NOT ask for a new window, or JUCE drops the click
        // on the floor and the whole credits screen is decorative.
        'support: links do not ask the plugin for a window it will not open',
        result.linkTargetGuarded === true
      ],
      [
        'preprocess: the bridge only rewrites audio when explicitly told to',
        result.juceCarries?.preprocessOptIn === true
      ],
      [
        'support: the section fits the card and the dialog still closes',
        !!support?.present && support.cardOverflows === false && result.aboutClosed?.gone === true
      ],

      // --- every adjustable setting is reachable ---------------------------------------
      [
        // Was: no control anywhere. `SourceAudio.keyFifths` could be set when a blank score was
        // created or by a file that carried one, and never again — so a transcription that came
        // back spelled in the wrong key had no way out. The picker writes the take's own key,
        // the pipeline honours it (`<fifths>` in the exported MusicXML is the pipeline's own
        // word for what it was told), and Auto genuinely lets go of the override again.
        'settings: the key signature is adjustable from the UI',
        result.keyPick?.set === true &&
          result.keySet?.keyControl === '4' &&
          result.keySet?.xmlFifths === 4 &&
          /E major/.test(result.keySet?.keyAutoLabel ?? '') &&
          result.keyAuto?.set === true &&
          result.keyRestored?.keyControl === 'auto' &&
          result.keyRestored?.xmlFifths === result.settingsBefore?.xmlFifths
      ],
      [
        // Was: no control anywhere. `AppSettings.capo` reached the pipeline already — every
        // fret is written relative to it and it is printed in the MusicXML — but the only way
        // to set one was to open a Guitar Pro file that happened to have one.
        'settings: the capo is adjustable from the UI',
        result.capoSet?.set === true &&
          result.capoApplied?.capoControl === '3' &&
          result.capoApplied?.storedCapo === 3 &&
          result.capoApplied?.xmlCapo === 3 &&
          result.capoRestored?.storedCapo === 0 &&
          result.capoRestored?.xmlCapo === 0
      ],
      [
        // Was: no control anywhere, and `TriView.setFretLimit()` — written to "keep the fret
        // limit in step with the settings panel" — had no caller at all. It governs hand edits
        // rather than the transcription (`BuildSettings` has no maxFret), so the proof is that
        // the app stored the new number and the panel reads its own value back.
        'settings: the highest fret is adjustable from the UI',
        result.fretSet?.set === true &&
          result.fretApplied?.fretControl === '24' &&
          result.fretApplied?.storedMaxFret === 24 &&
          result.settingsAfter?.storedMaxFret === 17
      ],
      // --- F19: one tempo source where there were two controls -------------------------
      //
      // The old pair — a "Use DAW grid" chip in the header and an always-editable BPM box in
      // the transport — could and did disagree: typing a tempo under a lit chip silently
      // un-lit it. The claims below are the unification's, in the order they matter: the one
      // control exists and is in the transport, the chip is really gone, the DAW is offered
      // only where there is one, choosing it writes the setting the pipeline reads, and the
      // fields it governs are only editable when they are honestly the player's to edit.
      [
        'tempo source: one control, in the transport row, with the chip gone',
        result.tempoSourceBefore?.present === true &&
          result.tempoSourceBefore?.setting === 'useHostGrid' &&
          result.tempoSourceBefore?.inTransport === true &&
          result.tempoSourceBefore?.inHeader === false &&
          result.tempoSourceBefore?.chipGone === true
      ],
      [
        // Follow DAW is offered here and only here — this is the simulated-plugin host. The
        // other two are always honest answers, so all three are on the menu.
        'tempo source: the DAW is offered in a host that has one',
        (result.tempoSourceBefore?.options ?? []).includes('daw') &&
          (result.tempoSourceBefore?.options ?? []).includes('manual') &&
          (result.tempoSourceBefore?.labels ?? []).some((l) => /Follow DAW/i.test(l ?? ''))
      ],
      [
        // The behaviour the chip used to carry, through the control that replaced it: choosing
        // Manual releases the DAW grid, choosing Follow DAW takes it back, and the sheet is
        // rebuilt both times (the tempo box is re-read after the render, not in the same tick).
        'tempo source: choosing a source really changes the source',
        result.tempoSourceSet?.set === true &&
          result.tempoSourceManual?.value === 'manual' &&
          result.tempoSourceBack?.set === true &&
          result.tempoSourceDaw?.value === 'daw'
      ],
      [
        // The half the old design got wrong. Under Follow DAW the tempo and the meter are the
        // DAW's, so the boxes SHOW them and do not offer to be typed into; under Manual they
        // are the player's and both are live.
        'tempo source: the fields are editable exactly when they are yours',
        result.tempoSourceManual?.bpmReadOnly === false &&
          result.tempoSourceManual?.sigDisabled === false &&
          result.tempoSourceDaw?.bpmReadOnly === true &&
          result.tempoSourceDaw?.sigDisabled === true
      ],
      [
        // And the sub-choice the app makes on the recording's behalf is still said out loud —
        // "bar lines" for a captured take, "tempo only" for a file that merely borrows the
        // tempo. This is the sentence that stopped a sheet sitting at 102 under a lit chip
        // while REAPER was at 222, and it moved with the control rather than being dropped.
        'tempo source: Follow DAW says which of the two grids it is applying',
        typeof result.tempoSourceDaw?.detail === 'string' &&
          /bar lines|tempo only/.test(result.tempoSourceDaw.detail) &&
          /\d/.test(result.tempoSourceDaw.detail)
      ],

      // --- F17/F18: the brand block ----------------------------------------------------
      [
        // G5: THE MARK IS NOT PART OF THIS BLOCK ANY MORE. `mark === true` stood where the
        // `false` is, and the flip is the whole change: a chamfered R beside the word RIFFSHEET
        // is the word twice, and BASAMAK — the block this is modelled on — is a wordmark with
        // nothing in front of it. The R lives in the app icon, which no check here can see.
        // Asserted as false rather than dropped, so it cannot quietly come back.
        'brand: the top-left block carries the name, the version and the invitation, and no mark',
        result.brand?.present === true &&
          result.brand?.mark === false &&
          result.brand?.wordmark === 'RIFFSHEET' &&
          // `v` + whatever the shell said, not `v` + a digit: the version is FEATURE-DETECTED
          // (`bridge.getAppVersion`), the browser mock answers 'dev', and a real build answers
          // its own string. Pinning a shape here would make the check a claim about the mock.
          /^v\S+$/.test(result.brand?.version ?? '') &&
          /check/i.test(result.brand?.check ?? '')
      ],
      [
        // One target, as BASAMAK's is: a button with nothing inside it able to take the click.
        'brand: it is a single clickable target',
        result.brand?.tag === 'BUTTON' &&
          result.brand?.childrenClickable === false &&
          /check for updates/i.test(result.brand?.label ?? '')
      ],
      [
        // THE OWNER'S HARD CONSTRAINT, measured rather than promised: the block is top-left,
        // the take's name is beside it, and the header has NOT grown — no extra row, and the
        // block is no taller than the tallest control that was already in the row.
        'brand: top-left, name beside it, and the header did not grow',
        result.brand?.firstChild === true &&
          result.brand?.nameIsNext === true &&
          // ONE ROW. The same measurement as the `layout:` check further up — distinct row
          // centres among the header's children — and at this width the header is `nowrap`, so
          // anything but 1 means the brand block has pushed the bar into a second line.
          result.brand?.headerRows === 1 &&
          typeof result.brand?.blockH === 'number' &&
          result.brand.blockH <= result.brand.tallestSiblingH
      ],

      // --- the settings clobber (review major) -----------------------------------------
      //
      // The reported scenario, played out through the real document path: choose a Quantize
      // setting, open a document written by a build old enough to predate every migration, and
      // the choice must still be there afterwards. Two failure modes are covered, because the
      // obvious half-fix only closes the first: the open itself must not write, AND the next
      // unrelated change must not carry the document's values onto disk with it.
      [
        'settings: a document is honoured without rewriting your preferences',
        result.docSettings?.chosen === 'quarter' &&
          result.docSettings?.openedEffective === 'auto' &&
          result.docSettings?.openedStored === 'quarter'
      ],
      [
        'settings: an unrelated change with the document open does not leak it either',
        result.docSettings?.afterUnrelatedEdit === 'quarter'
      ],
      [
        // …and the panel is not merely inert. Setting it YOURSELF still writes.
        'settings: your own change still persists',
        result.docSettings?.afterOwnEdit === 'sixteenth'
      ],
      [
        // The other half of the same bug: the v9->v10 "grid goes to Free" case must be
        // one-time EVER, not one-time per file. A v1 document re-armed it before the
        // persisted floor existed, so a deliberate 1/4 became Free on the next old open.
        'settings: a one-time migration is not re-armed by opening a document',
        result.docSettings?.migrationRefired === false &&
          result.docSettings?.migrationFloor >= 10
      ],
      [
        // THE SWEEP. Every key in DEFAULT_SETTINGS is either adjustable on screen — a live
        // `[data-setting]` control — or listed above with a reason it is not. A setting added
        // later with no control lands in neither and fails here by name, which is the whole
        // point: this file's own audit found three that had gone missing exactly that way.
        `settings: every adjustable setting has a control (${settingKeys.length} keys)`,
        settingKeys.length > 20 &&
          unreachableSettings.length === 0 &&
          result.settingsCensus?.panelOpen === true
      ],

      // --- what happens to the audio before an engine hears it -------------------------
      [
        'preprocess: a transcription runs through the real bridge call',
        !!pre && !pre.error && pre.notes > 0
      ],
      [
        // Both halves of one call: what the app handed over, and what the bridge wrote down
        // as having arrived. Either alone could agree with itself while the seam leaked.
        'preprocess: both switches reach the bridge as the player left them',
        pre?.sent?.normalizeBeforeTranscribe === false &&
          pre?.sent?.correctTuningBeforeTranscribe === false &&
          preSeen?.normalizeBeforeTranscribe === false &&
          preSeen?.correctTuningBeforeTranscribe === false
      ],
      [
        // THE DEFAULT, asserted as a fact rather than left to the two readings above to imply.
        // Both shipped defaulted ON, and because they were additive keys on an existing
        // settings blob, every take already on disk started being downmixed, levelled and
        // sometimes resampled before any engine heard it — without anybody choosing that. Off
        // is the contract now; a future change back to on has to fail here first.
        'preprocess: nothing rewrites the audio unless the player asks',
        result.preprocessNormalizeRestored?.checked === false &&
          result.preprocessTuningState?.checked === false
      ],
      [
        'preprocess: the engine answers with a receipt and a sentence',
        typeof preOn?.preprocess?.note === 'string' && preOn.preprocess.note.length > 0
      ],
      ['preprocess: nothing is claimed before a transcription', result.preprocessBefore?.present === false],
      [
        // The point of the whole feature: a real change to somebody's own audio leaves a
        // trace they can find, in the panel, after the fact.
        'preprocess: the panel shows what was done to the last take',
        result.preprocessRow?.present === true &&
          result.preprocessRow?.text === preOn?.note &&
          (result.preprocessRow?.text ?? '').length > 0
      ],
      [
        'preprocess: the sentence is a dim row under the two switches',
        result.preprocessRow?.dim === true && result.preprocessRow?.belowSwitches === true
      ],
      [
        // It is held in the app, not in the panel, so shutting the panel cannot lose it.
        'preprocess: the sentence survives the panel being closed and reopened',
        result.preprocessRowReopened?.present === true &&
          result.preprocessRowReopened?.text === result.preprocessRow?.text
      ],
      [
        'preprocess: switching levelling on sends true to the bridge',
        result.preprocessNormalizeOn?.clicked === true &&
          preOn?.sent?.normalizeBeforeTranscribe === true &&
          preOnSeen?.normalizeBeforeTranscribe === true
      ],
      [
        'preprocess: switching one on leaves the other off',
        preOn?.sent?.correctTuningBeforeTranscribe === false &&
          preOnSeen?.correctTuningBeforeTranscribe === false
      ],
      [
        // And the answer changes with it, rather than the flag being recorded and ignored.
        // With both switches off there is no receipt AT ALL — not one that says nothing
        // happened — because nothing was on offer to happen. `?? null` in the probe means an
        // absent receipt reads as exactly null here.
        'preprocess: with both switches off the audio is untouched',
        !!pre && !pre.error && pre.preprocess === null
      ],
      [
        'preprocess: the panel is left the way it was found',
        result.preprocessNormalizeRestored?.checked === false &&
          result.preprocessTuningState?.checked === false
      ],
      [
        // The per-take engine override: unused by the product today, so this is the only
        // thing standing between "the field exists" and "the field arrives".
        'engine: a named engine reaches the bridge call',
        preEngine?.sent?.engineId === 'bass-v2' && preEngineSeen?.engineId === 'bass-v2'
      ],
      [
        'engine: no engine is named unless a caller names one',
        !!pre?.sent && Object.prototype.hasOwnProperty.call(pre.sent, 'engineId') === false
      ],
      [
        // Carried, not drawn. The mock puts a number on every note it reports; the check is
        // that the bridge hands all of them on rather than flattening them away.
        'confidence: per-note confidence survives the bridge',
        pre?.notes > 0 && pre?.withConfidence === pre?.notes
      ],
      [
        // The JUCE half of the same two seams, which only runs inside the shell.
        'bridge: the JUCE mapping carries confidence and the preprocess receipt',
        result.juceCarries?.confidence === true &&
          result.juceCarries?.confidenceDeclared === true &&
          result.juceCarries?.preprocess === true
      ],

      // --- the auto-split / gap-fill pass ----------------------------------------------
      //
      // The player's case: two ~250 ms hits came back from the engine as ONE ~500 ms note,
      // with the app's own attack detector already drawing a line at the join. Two parts of
      // the app disagreed on screen and the one that was right was the one nobody could act
      // on. These check that it now acts — and, much more importantly, that it refuses.
      //
      // The player's own warning is the reason the refusals outnumber the acceptances here:
      // "it detects some narrow ones just before the real attacks". A pass that believed those
      // would turn a clean take into confetti, which is worse than the bug.
      [
        'auto-split: the reported merged note splits, once, at the attack',
        !!result.autoPlan && result.autoPlan.merged?.splits === 1 &&
          result.autoPlan.merged.splitAtMs === 1250
      ],
      [
        // ELIGIBILITY IS MEASURED ON THE RESULT, not on the note's length. A ghost 40 ms from
        // the end would leave a 40 ms sliver, so it fails by arithmetic rather than by a
        // heuristic that has to guess what a ghost looks like.
        'auto-split: an attack near a note end is refused, not split',
        !!result.autoPlan && result.autoPlan.ghost?.splits === 0 && result.autoPlan.ghost.attention >= 1
      ],
      [
        // NO RAW DETECTOR LINE IS EVER USED. Two detections 40 ms apart are one attack.
        'auto-split: two detections 40ms apart collapse to one split',
        !!result.autoPlan && result.autoPlan.cluster?.splits === 1 &&
          result.autoPlan.cluster.clustered === 2
      ],
      [
        // Rule 3: it never argues with somebody who has already decided about that note.
        'auto-split: a note the player has edited is left alone',
        !!result.autoPlan && result.autoPlan.exempt?.splits === 0
      ],
      [
        // Idempotent: running it over its own output changes nothing, because the boundary
        // attack is no longer INSIDE either fragment.
        'auto-split: re-running the pass splits nothing further',
        !!result.autoPlan && result.autoPlan.rerun?.splits === 0
      ],
      [
        'gap-fill: a steady pitch the engine missed is written in',
        !!result.autoPlan && result.autoPlan.fill?.fills === 1 && result.autoPlan.fill.fillMidi === 45
      ],
      [
        // Stricter than a split, because it invents a note rather than dividing one.
        'gap-fill: noise in the same place is highlighted, never written',
        !!result.autoPlan && result.autoPlan.noisy?.fills === 0 && result.autoPlan.noisy.attention >= 1
      ],
      [
        // Nobody records a real note 55 dB under the take's own peak.
        'gap-fill: a stretch too quiet to be real is refused',
        !!result.autoPlan && result.autoPlan.quiet?.fills === 0 && result.autoPlan.quiet.attention >= 1
      ],
      [
        // THE NO-FALSE-POSITIVES CHECK, and the one that would catch a pass that had become
        // trigger-happy. The real detector, over a clean rendering of the demo's own notes.
        'auto edits: a clean take produces none at all',
        !!result.autoClean && result.autoClean.noteCount > 0 &&
          result.autoClean.splits === 0 && result.autoClean.fills === 0
      ],
      [
        'auto edits: the split is highlighted on the roll AND on the waveform',
        !!result.autoKeep && result.autoKeep.appliedEdits >= 1 &&
          result.autoKeep.afterSplit?.rollMarks >= 2 &&
          result.autoKeep.afterSplit.rollMarksDrawn >= 1 &&
          result.autoKeep.afterSplit.waveRegions >= 1
      ],
      [
        // NEVER on the sheet or the tab. Those are the result — a player reads them to find
        // out what the music is, and marking them up with what the app thinks of itself would
        // make that harder in exchange for nothing about the music.
        'auto edits: nothing is marked on the sheet or the tab',
        !!result.autoKeep &&
          (result.autoKeep.afterSplit?.rollMarks ?? 0) > 0 &&
          // The engraving carries no auto-edit class of any kind.
          result.autoSheetMarks === 0
      ],
      [
        'auto edits: the counter chip appears and says how many',
        !!result.autoKeep && result.autoKeep.afterSplit?.chipShown === true &&
          /auto edit/.test(result.autoKeep.afterSplit.chipText ?? '')
      ],
      [
        // The chip's own gesture: step to the next unreviewed edit and open its popover.
        'auto edits: the chip opens the review popover, with both buttons',
        !!result.autoKeep && /Riffsheet/.test(result.autoKeep.popoverTitle ?? '') &&
          result.autoKeep.hasKeep === true && result.autoKeep.hasRevert === true
      ],
      [
        // Keep clears the highlight and leaves the notes alone. The chip goes with the last
        // unreviewed edit — a chip reading "0 auto edits" is chrome about nothing.
        // There is only one kind of mark now (#24), so "the highlight" is unambiguous: the
        // applied edit's halo, which reviewing it clears.
        'auto edits: Keep clears the highlight and hides the chip',
        !!result.autoKeep && result.autoKeep.afterReview?.rollMarksApplied === 0 &&
          result.autoKeep.afterReview.waveApplied === 0 &&
          result.autoKeep.afterReview.chipShown === false &&
          result.autoKeep.afterReview.popoverOpen === false &&
          result.autoKeep.afterReview.notes === result.autoKeep.afterSplit.notes
      ],
      [
        // Revert un-splits: the two fragments become the one note the engine returned, so the
        // count goes back to what it was before the pass ran.
        'auto edits: Revert puts the note back together',
        !!result.autoRevert && result.autoRevert.afterSplit?.notes > result.autoRevert.beforeNotes &&
          result.autoRevert.afterReview?.notes === result.autoRevert.beforeNotes
      ],
      [
        'auto edits: reviewing leaves the take as it found it',
        !!result.autoRevert && result.autoRevert.restoredNotes === result.autoRevert.beforeNotes &&
          !!result.autoAfter && result.autoAfter.unreviewed === 0
      ],
      [
        // The setting exists, is ON, and is reachable — the settings sweep above proves the
        // last of those; this proves the first two.
        'auto edits: the setting is on by default',
        !!result.autoBefore && result.autoBefore.enabled === true
      ],
      [
        // #24, AND IT REVERSES WHAT THIS CHECK USED TO ASSERT. It used to demand that the
        // switched-off pass still HIGHLIGHTED what it had noticed — "do not touch my notes" is
        // a different instruction from "do not tell me". That argument is true and the result
        // was not worth it: every take came back speckled with yellow marks on notes that were
        // correct, which the player could neither act on nor clear, and the cost was paid by
        // the green marks — the ones that mean "the app changed this" — which the eye learned
        // to skim past with the rest.
        //
        // So off now means off: no edits, no marks on either view, no chip. The pass still
        // RUNS and still records its refusals (`attention` is asserted to be non-zero, which
        // is what proves the guardrails fired at all) — it simply has no ink.
        'auto edits: switched off, nothing is marked at all',
        !!result.autoOff && result.autoOff.applied === 0 && result.autoOff.attention > 0 &&
          result.autoOff.rollMarks === 0 && result.autoOff.waveRegions === 0 &&
          result.autoOff.chipShown === false && result.autoOff.notesUnchanged === true
      ],

      // --- clicking outside Settings closes it ------------------------------------------
      [
        'settings: a press outside the panel closes it',
        !!result.settingsOutside && result.settingsOutside.opened === true &&
          result.settingsOutside.afterOutside === false
      ],
      [
        // The two exemptions that make it survivable. Without the first, dragging a fader past
        // the panel edge would slam the drawer; without the second, the gear would close and
        // instantly reopen and look broken.
        'settings: a press inside it, or on the gear, does not',
        !!result.settingsOutside && result.settingsOutside.afterInside === true &&
          result.settingsOutside.afterGear === true
      ],

      // --- the main menu does what its rows say -----------------------------------------
      [
        'main menu: it leaves the sheet and offers real rows',
        !!result.menuActions && result.menuActions.openedMenu === true &&
          result.menuActions.rowCount >= 3
      ],
      [
        'main menu: Blank score opens its setup form',
        !!result.menuActions && result.menuActions.blankFormOpened === true
      ],
      [
        // BOTH halves. A capture button on a web page would be a lie — there is no track to
        // record — and a missing one inside a DAW is the bug. So the claim is that the offer
        // matches the host, and that when it IS offered, pressing it does something.
        'main menu: Capture is offered exactly when there is a track to capture',
        !!result.menuActions &&
          result.menuActions.captureOffered === result.menuActions.isPlugin &&
          (!result.menuActions.captureOffered || result.menuActions.captureChanged === true)
      ],
      [
        // The dead-confirm class of bug, named: the row has to ASK, and the answer has to be
        // acted on. A dialog that appears and then leads nowhere passes "the row exists".
        'main menu: Close asks first, and then really closes',
        !!result.menuActions && result.menuActions.closeOffered === true &&
          result.menuActions.closeAsked === true && result.menuActions.closedIt === true
      ],
      [
        'blank score: it builds a real page with the meter and bars asked for',
        !!result.blankScore && result.blankScore.created === true &&
          result.blankScore.bars === 6 && result.blankScore.timeSig === '3/4' &&
          result.blankScore.tempoBpm === 100 && result.blankScore.engravedStaves > 0
      ],
      [
        // Blank means blank: bars of rests, not a page with notes on it.
        'blank score: it is empty, and stays that many bars',
        !!result.blankScore && result.blankScore.noteGlyphs === 0 &&
          result.blankScore.documentBars === 6
      ],

      // --- a custom TAB tuning is used, not merely stored --------------------------------
      [
        'custom tuning: dropping every string re-frets the tab',
        !!result.customTuning && result.customTuning.hadDigits === true &&
          result.customTuning.digitsChanged === true
      ],
      [
        'custom tuning: the printed tuning follows it',
        !!result.customTuning && result.customTuning.summaryChanged === true &&
          /^[A-G]/.test(result.customTuning.dropped?.summary ?? '')
      ],
      [
        'custom tuning: a five-string tuning gives the tab five strings',
        !!result.customTuning && result.customTuning.five?.strings === 5 &&
          result.customTuning.standard?.strings === 4
      ],

      // --- one selection, four views -----------------------------------------------------
      [
        'cross-highlight: a stretch of recording marks the roll and the sheet',
        !!result.crossHighlight && result.crossHighlight.askedFor > 0 &&
          result.crossHighlight.rollSelected === result.crossHighlight.askedFor &&
          result.crossHighlight.sheetKnowsIds === result.crossHighlight.askedFor &&
          result.crossHighlight.runtimeSelected === result.crossHighlight.askedFor
      ],

      // --- octave-folded tab positions ------------------------------------------------
      ['8va: the drop-tuned fixture folds something', !!drop && drop.octaveShiftNotes > 0],
      ['8va: one marker per folded note', !!drop && drop.octaveMarks === drop.octaveShiftNotes],
      ['8va: markers land on the tab', !!drop && drop.octaveMarksOnTab === drop.octaveMarks],
      ['8va: marker reads 8va', !!drop && (drop.octaveMarkTexts ?? []).every((x) => x === '8va')],
      [
        '8va: none on an in-range riff',
        !!result.namesLayout && result.namesLayout.octaveShiftNotes === 0 && result.namesLayout.octaveMarks === 0
      ]
    ];

    phase('reporting checks', 15_000);
    console.log(JSON.stringify(result, null, 2));
    console.log('\n--- checks ---');
    // Every measurement this run took, on disk, when asked for. Off by default because it is a
    // 200KB file nobody reads on a green run; indispensable on a red one, where the failing
    // check names a claim and this names the numbers behind it.
    if (process.env.RIFFSHEET_DUMP) {
      await mkdir(join(ROOT, 'spike-results'), { recursive: true });
      await writeFile(join(ROOT, 'spike-results', 'verify-result.json'), JSON.stringify(result, null, 1));
    }
    for (const [name, ok] of checks) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
      if (!ok) code = 1;
    }
    if (errors.length) {
      console.log('\n--- console errors ---');
      for (const e of errors.slice(0, 20)) console.log(e);
    }
    console.log('\nscreenshot: spike-results/app.png');
  } catch (e) {
    console.error('verify failed:', e);
    if (chromeSpawnError) console.error('Chrome launch failed:', chromeSpawnError);
    if (errors.length) {
      console.error('page errors before failure:');
      for (const error of errors.slice(0, 20)) console.error(error);
    }
    if (chromeStderr.trim()) console.error('Chrome stderr (tail):\n' + chromeStderr.trim());
    code = 1;
  } finally {
    if (stepTimes.length) {
      const total = stepTimes.reduce((a, [ms]) => a + ms, 0);
      console.log(`\n--- slowest steps (${(total / 1000).toFixed(1)}s in ${stepTimes.length} calls) ---`);
      for (const [ms, what] of stepTimes.sort((a, b) => b[0] - a[0]).slice(0, 12)) {
        console.log(`${String(ms).padStart(6)} ms  ${what}`);
      }
    }
    // Ask Chrome to take its renderer children with it. If the debugger is already wedged,
    // only the exact child this run created is killed after a short grace period.
    try {
      await cdp?.send('Browser.close', {}, 3_000);
    } catch {
      /* the bounded hard-stop below is the fallback */
    }
    cdp?.close();
    if (proc.exitCode === null && proc.signalCode === null) {
      await Promise.race([
        new Promise((ok) => proc.once('exit', ok)),
        new Promise((ok) => setTimeout(ok, 1_500))
      ]);
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
      await Promise.race([
        new Promise((ok) => proc.once('exit', ok)),
        new Promise((ok) => setTimeout(ok, 1_500))
      ]);
    }
    server.closeAllConnections?.();
    await new Promise((ok) => server.close(ok));
    // Chrome needs a moment to let go of the profile before it can be removed.
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* a leftover profile is untidy, not a failure — never fail a green run over it */
    }
  }
  process.exit(code);
}

main();
