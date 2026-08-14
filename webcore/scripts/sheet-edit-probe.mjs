#!/usr/bin/env node
/**
 * THE SHEET EDITING PROBE (Z4). A live browser, a real right-click, and the real menu.
 *
 * WHY A LIVE PROBE AS WELL AS src/edit/performanceEdit.test.ts. That test proves the LAW —
 * collision victims, touched ids, bar arithmetic — over plain arrays, which is the right shape
 * for it. It cannot prove any of the things this feature is actually made of: that a right-click
 * does not seek the transport, that the browser's own menu never appears, that a press eight
 * pixels off a notehead's centre still finds it, that picking a duration changes the RECTANGLE
 * ON THE ROLL, or that the menu says why it is refusing something. Every one of those is a fact
 * about the DOM under a pointer, so this drives one.
 *
 * A SEPARATE FILE from verify.mjs, ghost-probe.mjs and scrollzoom-probe.mjs, with its own port
 * pair (5401/9341) so all four can run at once. The Chrome bootstrap is deliberately the same
 * incantation, through the shared reaper in probe-chrome.mjs.
 *
 *   node scripts/sheet-edit-probe.mjs [--headful] [--shots]
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { launchChrome } from './probe-chrome.mjs';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'spike-results');
const PORT = 5401;
const DEBUG_PORT = 9341;
const HEADFUL = process.argv.includes('--headful');
const SHOTS = process.argv.includes('--shots');

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
  return new Promise((ok, fail) => {
    server.once('error', (e) => fail(new Error(String(e.message ?? e))));
    server.listen(PORT, '127.0.0.1', () => ok(server));
  });
}

class Cdp {
  #ws; #id = 0; #pending = new Map(); #listeners = new Map();
  static async connect(url) {
    const c = new Cdp();
    c.#ws = new WebSocket(url);
    await new Promise((ok, err) => {
      c.#ws.addEventListener('open', ok, { once: true });
      c.#ws.addEventListener('error', () => err(new Error('cdp connect failed')), { once: true });
    });
    c.#ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = c.#pending.get(m.id);
        if (!p) return;
        c.#pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else for (const fn of c.#listeners.get(m.method) ?? []) fn(m.params);
    });
    return c;
  }
  on(m, fn) { const l = this.#listeners.get(m) ?? []; l.push(fn); this.#listeners.set(m, l); }
  send(method, params = {}, maxMs = 45_000) {
    const id = ++this.#id;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { this.#pending.delete(id); fail(new Error(`${method} timed out`)); }, maxMs);
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); ok(v); },
        reject: (e) => { clearTimeout(timer); fail(e); }
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.#ws.close(); }
}

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const server = await serve();
  const chromePath = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.CHROME_PATH
  ].filter(Boolean).find((p) => existsSync(p));
  if (!chromePath) { console.error('No Chrome found'); process.exit(1); }

  const profileDir = join(tmpdir(), `riffsheet-sheetedit-${process.pid}-${Date.now()}`);
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required'
  ];
  if (!HEADFUL) args.push('--headless=new', '--disable-gpu');
  const { dispose: reapChrome } = launchChrome(chromePath, args, { profileDir });

  let cdp, failures = 0;
  const errors = [];
  const results = [];
  try {
    const deadline = Date.now() + 20000;
    let list;
    for (;;) {
      try { list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json(); break; }
      catch { if (Date.now() > deadline) throw new Error('devtools never came up'); await new Promise((o) => setTimeout(o, 150)); }
    }
    cdp = await Cdp.connect((list.find((t) => t.type === 'page') ?? list[0]).webSocketDebuggerUrl);
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') errors.push((p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    });
    cdp.on('Runtime.exceptionThrown', (p) =>
      errors.push(p.exceptionDetails?.exception?.description ?? JSON.stringify(p.exceptionDetails)));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const ev = async (expression, awaitPromise = false) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval threw');
      return r.result.value;
    };
    const json = async (expression, awaitPromise = false) => {
      const v = await ev(expression, awaitPromise);
      return typeof v === 'string' ? JSON.parse(v) : v;
    };
    const settle = (ms) => new Promise((o) => setTimeout(o, ms));
    const shot = async (name) => {
      if (!SHOTS) return;
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(OUT, `sheet-edit-${name}.png`), Buffer.from(r.data, 'base64'));
    };
    const check = (label, ok, detail) => {
      results.push({ label, ok: !!ok, detail });
      if (!ok) failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    };
    const say = (label, value) => console.log(`      ${label}: ${JSON.stringify(value)}`);

    await cdp.send('Page.navigate', {
      url: `http://127.0.0.1:${PORT}/index.html?demo=straight&bars=4&tab=bass&verify=1`
    });
    for (let i = 0; ; i++) {
      const ready = await ev('!!window.__RIFFSHEET_DEMO_READY__ && (document.querySelector(".at-host .at-surface")?.childElementCount ?? 0) > 0');
      if (ready === true) break;
      if (i > 60) throw new Error('demo never became ready');
      await settle(200);
    }
    await settle(900);

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------
    /** Everything the sheet says about itself, in one frame. See `__RIFFSHEET_SHEETEDIT__`. */
    const sheet = () => json('JSON.stringify(window.__RIFFSHEET_SHEETEDIT__ ? window.__RIFFSHEET_SHEETEDIT__() : null)');
    /**
     * The nth notehead ON THE NOTATION STAVE.
     *
     * `editProbe().noteHeads` holds tab positions too — a fret digit has `noteHeadBounds` like
     * any other note — and a pitch drag aimed at one of those is a STRING drag, where the pitch
     * deliberately does not move. Taking "the seventh notehead" without filtering made this
     * probe's pitch checks depend on the engraving's stave order, which is not what they claim
     * to be about.
     */
    const noteHeadAt = async (nth) => {
      const s = await sheet();
      const heads = (s?.noteHeads ?? []).filter((h) => h.staff === 'notation');
      return heads.length ? heads[Math.min(nth, heads.length - 1)] : null;
    };
    /** Every notehead of the chord at `beat`, lowest on the page (highest pitch) first. */
    const stackAt = async (beat) => {
      const s = await sheet();
      return (s?.noteHeads ?? [])
        .filter((h) => h.staff === 'notation' && h.beat === beat)
        .sort((a, b) => a.y - b.y);
    };
    /** The feed note with this id, as the app itself reports it. */
    const noteById = async (id) => (await sheet()).notes.find((n) => n.id === id) ?? null;
    /** Second at which bar `i` (0-based) beat `b` (0-based) starts, off the app's own bar list. */
    const beatSec = async (i, b) => {
      const bar = (await sheet()).bars[i];
      return bar ? bar.startSec + (b * bar.durSec) / bar.beats : null;
    };

    const rightClick = (x, y) => ev(`(() => {
      const el = document.elementFromPoint(${x}, ${y}) || document.querySelector('.triview-scroll');
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, button: 2, buttons: 2 });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    })()`);

    const menu = async () => (await sheet()).menu;

    const pick = (label) => ev(`(() => {
      const row = [...document.querySelectorAll('[data-menu-item]')].find((e) => e.getAttribute('data-menu-item') === ${JSON.stringify(label)});
      if (!row) return 'missing';
      if (row.getAttribute('aria-disabled') === 'true') return 'disabled';
      row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));
      return 'picked';
    })()`);

    const rects = () => json('JSON.stringify((window.__RIFFSHEET_ROLLRECTS__ && window.__RIFFSHEET_ROLLRECTS__()) ?? [])');
    const transportSec = () => json(`JSON.stringify(window.__RIFFSHEET_PIANOROLL__().positionSec)`);

    const head0 = await noteHeadAt(0);
    check('a notehead was found to point at', !!head0, JSON.stringify(head0));
    if (!head0) throw new Error('nothing engraved to edit');

    // ===================================================================
    // 1 — RIGHT-CLICK IS EDIT, and it does not seek
    // ===================================================================
    //
    // The bug this replaces: `onPointerDown` selected and seeked before looking at the button,
    // so a right-click on empty space jumped the playhead as the menu opened.
    const beforeSec = await transportSec();
    const preventedEmpty = await rightClick(Math.round(head0.x + 220), Math.round(head0.y + 3));
    await settle(200);
    const afterSec = await transportSec();
    check(
      'right-click: the browser menu is suppressed',
      preventedEmpty === true,
      `defaultPrevented=${preventedEmpty}`
    );
    check(
      'right-click: it does NOT seek the transport (it used to)',
      Math.abs(afterSec - beforeSec) < 1e-6,
      `${beforeSec}s -> ${afterSec}s`
    );
    await ev(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
    await settle(150);
    check('right-click: Esc closes the menu', (await menu()).open === false);

    // ===================================================================
    // 2 — THE NOTE MENU: durations, the ticked current value, delete
    // ===================================================================
    await rightClick(Math.round(head0.x), Math.round(head0.y));
    await settle(250);
    const noteMenu = await menu();
    say('note menu', noteMenu.items.map((i) => `${i.checked ? '*' : ''}${i.label}${i.disabled ? ' (off)' : ''}`));
    await shot('01-note-menu');
    check('note menu: it opened', noteMenu.open === true);
    check(
      'note menu: every written value is offered, plain and dotted',
      ['Whole', 'Half', 'Quarter', 'Eighth', 'Sixteenth', 'Thirty-second'].every((v) =>
        noteMenu.items.some((i) => i.label === v)) &&
      ['Dotted whole', 'Dotted half', 'Dotted quarter', 'Dotted eighth', 'Dotted sixteenth'].every((v) =>
        noteMenu.items.some((i) => i.label === v)),
      `${noteMenu.items.length} items`
    );
    check(
      'note menu: the dotted 1/32 is greyed, because the tick domain cannot hold it',
      !!noteMenu.items.find((i) => i.label === 'Dotted thirty-second')?.disabled,
      JSON.stringify(noteMenu.items.find((i) => i.label === 'Dotted thirty-second'))
    );
    check(
      'note menu: the value the note is PRINTED at is ticked',
      noteMenu.items.filter((i) => i.checked).length === 1,
      JSON.stringify(noteMenu.items.filter((i) => i.checked).map((i) => i.label))
    );
    check('note menu: Delete note is there', noteMenu.items.some((i) => i.label === 'Delete note'));
    // BAR OPERATIONS ARE ENABLED ON A RECORDED TAKE (workstream C). This check used to assert
    // the opposite — that they were shown, greyed, and explained with "Bars are fixed by the
    // recording". That refusal is gone: the waveform is a photograph, the score is the music,
    // and §8 below proves the photograph does not move when a bar is inserted into the music.
    check(
      'note menu: bar operations are ENABLED on a recorded take (they used to be refused)',
      ['Insert bar before', 'Insert bar after', 'Delete bar'].every((label) => {
        const item = noteMenu.items.find((i) => i.label === label);
        return item && !item.disabled;
      }),
      JSON.stringify(noteMenu.items.filter((i) => i.label.includes('bar')))
    );

    // ===================================================================
    // 3 — A DURATION CHANGE REACHES THE ROLL
    // ===================================================================
    const beforeRects = await rects();
    const beforeRect = beforeRects.find((r) => r.noteId === head0.id) ?? beforeRects[0];
    const picked = await pick('Half');
    await settle(1400);
    const afterRects = await rects();
    const afterRect = afterRects.find((r) => r.noteId === (beforeRect?.noteId ?? '')) ?? null;
    say('duration', { picked, before: beforeRect, after: afterRect });
    await shot('02-after-duration');
    check('duration: the item was picked', picked === 'picked');
    check(
      'duration: the ROLL rectangle changed with it (write-through, not a glyph swap)',
      !!beforeRect && !!afterRect && Math.abs(afterRect.w - beforeRect.w) > 1,
      `${beforeRect?.w} -> ${afterRect?.w}`
    );
    check('duration: picking closes the menu', (await menu()).open === false);
    const undoTitle = await ev(`document.querySelector('[data-role="undo"]')?.getAttribute('title') ?? ''`);
    check(
      'duration: it is ONE undo step, named after what was chosen',
      /half note/i.test(undoTitle),
      undoTitle
    );

    // ===================================================================
    // 4 — HIT RADIUS: eight pixels off centre still finds the note
    // ===================================================================
    //
    // alphaTab's own `getNoteAtPos` is an exact containment test against a glyph nine pixels
    // tall, so this press used to select nothing at all.
    const head1 = await noteHeadAt(2);
    await ev(`(() => {
      const el = document.querySelector('.triview-scroll');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 3, isPrimary: true, button: 0, buttons: 1, clientX: ${Math.round(head1.x)}, clientY: ${Math.round(head1.y - 8)} }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3 }));
      return true;
    })()`);
    await settle(400);
    const selected = (await sheet()).selection;
    say('off-centre press', { wanted: head1.id, selected });
    check(
      'hit radius: a press 8px above the notehead centre still selects it',
      selected.includes(head1.id),
      `wanted ${head1.id}, got ${JSON.stringify(selected)}`
    );

    // ===================================================================
    // 5 — ADD NOTE on empty notation-staff space
    // ===================================================================
    const staffPoint = (await sheet()).emptyNotation;
    say('empty notation point', staffPoint);
    if (staffPoint) {
      const countBefore = (await rects()).length;
      await rightClick(Math.round(staffPoint.x), Math.round(staffPoint.y));
      await settle(250);
      const addMenu = await menu();
      say('empty menu', addMenu.items.map((i) => `${i.label}${i.disabled ? ' (off)' : ''}`));
      say('empty target', staffPoint);
      check('add note: the empty-space menu offers it', addMenu.items.some((i) => i.label === 'Add note' && !i.disabled),
        JSON.stringify(addMenu.items[0]));
      const idsBefore = new Set((await sheet()).notes.map((n) => n.id));
      const addPicked = await pick('Add note');
      await settle(1500);

      // =================================================================
      // 5a — ...AND IT LANDS WHERE THE HAND PUT IT (P2)
      // =================================================================
      //
      // THE CHECK THIS ADDS, and the reason the old one could not see the bug. "The note count
      // went up" is true of a note added in the right place and of a note added in the wrong
      // one, and the fault was the second: `nearestBeatTick` compared an alphaTab tick (960 to a
      // quarter) against IR bar ticks (24 to a quarter) and handed the answer back to a converter
      // that read it as alphaTab's again — a deterministic 40x error, so the note landed near the
      // top of the take or on top of something else and the command looked inert.
      //
      // TWO INDEPENDENT WITNESSES, because one of them alone would be the app marking its own
      // homework:
      //
      //   1. THE ENGRAVING. The new note's notehead is read back out of alphaTab's bounds lookup
      //      and compared with the pixel that was right-clicked. Nothing in that path shares a
      //      line of code with the seconds arithmetic under test.
      //   2. THE METER. Its attack must sit exactly on the active add subdivision of the bar it
      //      is in. Auto uses the adjudicated 1/16 default: four slots per local meter beat.
      {
        const after = await sheet();
        const added = after.notes.find((n) => !idsBefore.has(n.id));
        const head = (after.noteHeads ?? []).find((h) => h.id === added?.id && h.staff === 'notation');
        const bar = after.bars.find(
          (b) => added && added.startSec >= b.startSec - 1e-3 && added.startSec < b.startSec + b.durSec - 1e-3
        );
        const beatDur = bar ? bar.durSec / bar.beats : 0;
        const subdivisionDur = beatDur / 4;
        const offSubdivision = bar
          ? Math.abs(((added.startSec - bar.startSec) / subdivisionDur) % 1)
          : 1;
        say('added note', { added, head, bar, offSubdivision: Number(offSubdivision.toFixed(6)) });
        /*
         * THE OLD ASSERTION, quoted: "add note: it lands on a BEAT of the bar it was dropped in,
         * exactly". That claim encoded the bug: it allowed a click aimed at an eighth or
         * sixteenth to be relocated to a quarter boundary before the insertion planner ran.
         * Auto now means a 1/16 add lattice, so the same meter witness checks four slots per beat.
         */
        check(
          'add note: it lands on the active 1/16 subdivision exactly',
          !!bar && (offSubdivision < 1e-3 || offSubdivision > 1 - 1e-3),
          `start=${added?.startSec}s, bar ${bar?.index} starts ${bar?.startSec}s, subdivision=${subdivisionDur}s`
        );
        check(
          'add note: and it is ENGRAVED under the pixel that was clicked (the 40x tick bug)',
          !!head && Math.abs(head.x - staffPoint.x) <= 40,
          `clicked x=${staffPoint.x}, engraved x=${head?.x ?? 'nowhere'}`
        );
      }
      // FIT THE PITCH AXIS FIRST. The roll draws the take's own pitch range, and a note added
      // at the middle of a BASS staff is well above a bass take's lowest string — outside the
      // window, so no rectangle is painted for it and the count would be unchanged for a reason
      // that has nothing to do with the edit. Double-clicking the gutter is the app's own "fit".
      await ev(`(() => {
        const c = document.querySelector('.pianoroll-pane canvas');
        const r = c.getBoundingClientRect();
        c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + r.height / 2 }));
        return true;
      })()`);
      await settle(700);
      const countAfter = (await rects()).length;
      const tightInsertion = await json(
        'JSON.stringify(window.__RIFFSHEET_SHEETINSERTPROBE__ ? window.__RIFFSHEET_SHEETINSERTPROBE__() : null)'
      );
      say('after add', await sheet().then((x) => ({ raw: x.rawNotes, feed: x.feedNotes, undo: x.undoTitle })));
      say('tight insertion transaction', tightInsertion);
      await shot('03-after-add');
      /*
       * The old assertion was "add note: the roll gained a rectangle, so the performance really
       * changed". That proves an unconstrained add only. The same one check now also drives a
       * guaranteed tight gap through the App adapter and requires its ripple/log, roll, engraving,
       * raw-locality and one-Undo answers; the total probe floor remains exactly 63.
       */
      check(
        'add note: the roll changes, and a tight-gap add is one exact forward-ripple transaction',
        addPicked === 'picked' && countAfter === countBefore + 1 &&
          !!tightInsertion && !tightInsertion.error && tightInsertion.applied === true &&
          tightInsertion.rawOldStable === true && tightInsertion.opKind === 'sheet-insert' &&
          tightInsertion.fixed === true &&
          Math.abs(tightInsertion.deltaTick - tightInsertion.expectedDelta) < 1e-6 &&
          JSON.stringify(tightInsertion.feedSpan) === JSON.stringify(tightInsertion.expectedSpan) &&
          JSON.stringify(tightInsertion.rollSpan) === JSON.stringify(tightInsertion.expectedSpan) &&
          JSON.stringify(tightInsertion.writtenSpan) === JSON.stringify(tightInsertion.expectedSpan) &&
          tightInsertion.suffixMoved === true && /add note/i.test(tightInsertion.undoTitle) &&
          tightInsertion.undoExact === true,
        JSON.stringify({ pick: addPicked, rects: [countBefore, countAfter], tightInsertion })
      );
    } else {
      check('add note: a point of empty notation staff was found', false, 'no probe point');
    }

    // ===================================================================
    // 5b — HORIZONTAL DRAG, and the axis lock that makes it safe
    // ===================================================================
    //
    // The sheet's drag used to read only `clientY`. Adding a time meaning without a lock would
    // turn every ordinary diagonal wobble on a pitch drag into a move in time as well, so the
    // two claims below are one feature: a mostly-sideways drag moves the note in TIME and leaves
    // its pitch alone, and a mostly-vertical one with sideways slop still only moves the PITCH.
    const drag = async (head, dx, dy) => {
      await ev(`(() => {
        const el = document.querySelector('.triview-scroll');
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, isPrimary: true, button: 0, buttons: 1, clientX: ${head.x}, clientY: ${head.y} }));
        for (let i = 1; i <= 6; i++) {
          window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, buttons: 1, clientX: ${head.x} + (${dx} * i) / 6, clientY: ${head.y} + (${dy} * i) / 6 }));
        }
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientX: ${head.x} + ${dx}, clientY: ${head.y} + ${dy} }));
        return true;
      })()`);
      await settle(1400);
    };

    {
      const before = await rects();
      const target = await noteHeadAt(4);
      const beforeRect = before.find((r) => r.noteId === target.id);
      // Mostly sideways, with a few pixels of vertical slop a real hand would add.
      await drag(target, 70, 5);
      const after = await rects();
      const afterRect = after.find((r) => r.noteId === target.id);
      say('horizontal drag', { id: target.id, before: beforeRect, after: afterRect, undo: (await sheet()).undoTitle });
      await shot('05-after-time-drag');
      check(
        'drag: a mostly-sideways drag moves the note in TIME',
        !!beforeRect && !!afterRect && Math.abs(afterRect.startSec - beforeRect.startSec) > 1e-3,
        `${beforeRect?.startSec}s -> ${afterRect?.startSec}s`
      );
      check(
        'drag: and leaves its PITCH exactly alone (the axis lock)',
        !!beforeRect && !!afterRect && afterRect.midi === beforeRect.midi,
        `midi ${beforeRect?.midi} -> ${afterRect?.midi}`
      );
      check(
        'drag: one undo step, named for what the hand did',
        /move note/i.test((await sheet()).undoTitle),
        (await sheet()).undoTitle
      );

      // ===============================================================
      // 5c — ...AND IT LANDS WHERE IT WAS DROPPED (P3)
      // ===============================================================
      //
      // The owner's report: "it takes the note back to wherever the second note is, every time".
      // Deterministic, which is what a units bug looks like from the outside — the same 40x
      // domain mismatch as P2, arriving through the drop-to-beat mapping instead of the
      // right-click one. So the claim is not "it moved" but "it moved TO THE PIXEL THE HAND LET
      // GO OF", proved against alphaTab's bounds lookup, and onto a real beat line.
      {
        const s = await sheet();
        const head = (s.noteHeads ?? []).find((h) => h.id === target.id && h.staff === 'notation');
        const note = s.notes.find((n) => n.id === target.id);
        const bar = s.bars.find(
          (b) => note && note.startSec >= b.startSec - 1e-3 && note.startSec < b.startSec + b.durSec - 1e-3
        );
        const beatDur = bar ? bar.durSec / bar.beats : 0;
        const offBeat = bar ? Math.abs(((note.startSec - bar.startSec) / beatDur) % 1) : 1;
        say('drop placement', { droppedAtX: target.x + 70, engravedX: head?.x, note, bar });
        check(
          'drag: the note is ENGRAVED where the hand let go, not at a neighbour (the 40x tick bug)',
          !!head && Math.abs(head.x - (target.x + 70)) <= 40,
          `dropped at x=${target.x + 70}, engraved at x=${head?.x ?? 'nowhere'}`
        );
        check(
          'drag: and on a real beat of the bar it was dropped in',
          !!bar && (offBeat < 1e-3 || offBeat > 1 - 1e-3),
          `start=${note?.startSec}s, bar ${bar?.index} starts ${bar?.startSec}s, beat=${beatDur}s`
        );
      }

      // The mirror: mostly vertical, with sideways slop. Pitch moves, time does not.
      const before2 = await rects();
      const target2 = await noteHeadAt(6);
      const beforeRect2 = before2.find((r) => r.noteId === target2.id);
      await drag(target2, 5, -22);
      const after2 = await rects();
      const afterRect2 = after2.find((r) => r.noteId === target2.id);
      say('vertical drag', { id: target2.id, before: beforeRect2, after: afterRect2 });
      check(
        'drag: a mostly-vertical drag still changes the PITCH',
        !!beforeRect2 && !!afterRect2 && afterRect2.midi !== beforeRect2.midi,
        `midi ${beforeRect2?.midi} -> ${afterRect2?.midi}`
      );
      check(
        'drag: and does NOT move it in time, however much the hand wobbled',
        !!beforeRect2 && !!afterRect2 && Math.abs(afterRect2.startSec - beforeRect2.startSec) < 1e-6,
        `${beforeRect2?.startSec}s -> ${afterRect2?.startSec}s`
      );
    }

    // ===================================================================
    // 6 — BAR OPERATIONS on a blank, audio-free document
    // ===================================================================
    const blank = await json('window.__RIFFSHEET_BLANKSCORE__().then((r) => JSON.stringify(r))', true);
    say('blank score', { bars: blank.bars, documentBars: blank.documentBars });
    check('bars: a blank score was created to test on', blank.created === true, JSON.stringify(blank.error ?? ''));
    await settle(800);
    const barPoint = (await sheet()).emptyNotation;
    if (barPoint) {
      await rightClick(Math.round(barPoint.x), Math.round(barPoint.y));
      await settle(250);
      const barMenu = await menu();
      say('blank menu', barMenu.items.map((i) => `${i.label}${i.disabled ? ' (off)' : ''}`));
      check(
        'bars: on a blank, audio-free document the items are ENABLED',
        ['Insert bar before', 'Insert bar after', 'Delete bar'].every((label) =>
          barMenu.items.find((i) => i.label === label && !i.disabled)),
        JSON.stringify(barMenu.items.filter((i) => i.label.includes('bar')))
      );
      const barsBefore = (await sheet()).documentBars;
      const barPicked = await pick('Insert bar after');
      await settle(1400);
      const barsAfter = (await sheet()).documentBars;
      await shot('04-after-bar-insert');
      say('bar insert', { picked: barPicked, barsBefore, barsAfter });
      check('bars: inserting one lengthens the document by exactly one', barsAfter === barsBefore + 1,
        `${barsBefore} -> ${barsAfter}`);
      // STRUCTURE JOINS THE UNDO TRANSACTION. Undoing used to put the notes back and leave the
      // document a bar longer than its own history said it was. See `App.perfBars`.
      await ev(`(() => { document.querySelector('[data-role="undo"]')?.click(); return true; })()`);
      await settle(1400);
      const barsUndone = (await sheet()).documentBars;
      check('bars: undo puts the document length back too', barsUndone === barsBefore,
        `${barsAfter} -> ${barsUndone}, wanted ${barsBefore}`);
    } else {
      check('bars: a point of empty notation staff was found on the blank score', false, 'no probe point');
    }

    // ===================================================================
    // 7 — AN IMPORTED PART IS PAPER, and the menu says so
    // ===================================================================
    //
    // The case a note-id guard could not reach: an EMPTY imported staff has no note under the
    // pointer, so "is this note id an imported one?" answered no for exactly the press where the
    // answer matters. `NoteHit.trackIndex` is the fix; this is the proof.
    {
      const parts = await json('window.__RIFFSHEET_PARTS__().then((r) => JSON.stringify(r))', true);
      check('imported part: one was loaded to point at', !parts.error, JSON.stringify(parts.error ?? ''));
      await settle(1200);
      const point = (await sheet()).importedStaff;
      say('imported staff point', point);
      if (point) {
        await rightClick(Math.round(point.x), Math.round(point.y));
        await settle(250);
        const m = await menu();
        say('imported menu', m.items.map((i) => `${i.label}${i.disabled ? ' (off)' : ''}`));
        await shot('06-imported-part');
        // EVERY NOTE EDIT is refused — that is the paper-only rule, and it is unchanged. The BAR
        // items are the exception now, and deliberately: a bar belongs to the document's one
        // shared clock rather than to any part, so inserting one shifts every part together
        // (§8 asserts exactly that). Refusing them on the imported staff would mean the same
        // menu item worked or not depending on which staff the pointer happened to be over.
        check(
          'imported part: every NOTE edit is refused',
          m.open === true &&
            m.items.filter((i) => !i.label.includes('bar')).length > 0 &&
            m.items.filter((i) => !i.label.includes('bar')).every((i) => i.disabled),
          JSON.stringify(m.items.filter((i) => !i.disabled && !i.label.includes('bar')))
        );
        check(
          'imported part: and the reason is on screen, not implied',
          m.items.some((i) => i.reason === 'Imported parts are paper-only'),
          JSON.stringify(m.items.map((i) => i.reason))
        );
        await ev("(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()");
      } else {
        check('imported part: a point on its staff was found', false, 'no imported staff on screen');
      }
    }

    // ===================================================================
    // 8 — CHORDS: one duration, and every notehead is its own note (P1, P6)
    // ===================================================================
    //
    // On the `chord` fixture, which is the owner's own screenshot written down: a C2 held for
    // three beats and a C3 struck THREE MILLISECONDS later and released after a 1/32, plus a
    // three-note and a five-note stack. Everything in this section is about that first bar.
    const reload = async (url) => {
      await cdp.send('Page.navigate', { url });
      for (let i = 0; ; i++) {
        const ready = await ev(
          '!!window.__RIFFSHEET_DEMO_READY__ && (document.querySelector(".at-host .at-surface")?.childElementCount ?? 0) > 0'
        );
        if (ready === true) break;
        if (i > 60) throw new Error('demo never became ready');
        await settle(200);
      }
      await settle(1200);
    };
    await reload(`http://127.0.0.1:${PORT}/index.html?demo=chord&bars=4&tab=bass&verify=1`);

    {
      const first = await sheet();
      const beat = Math.min(...first.noteHeads.filter((h) => h.staff === 'notation').map((h) => h.beat));
      const stack = await stackAt(beat);
      say('chord stack', stack.map((h) => ({ id: h.id, x: h.x, y: h.y })));
      await shot('07-chord-before');
      check(
        'chord: the fixture engraves a stack of at least two noteheads to point at',
        stack.length >= 2,
        `${stack.length} noteheads at beat ${beat}`
      );

      // -----------------------------------------------------------------
      // P5 — THE NAMES ROW HAS ROOM ABOVE THE STAFF
      // -----------------------------------------------------------------
      //
      // The report: a chord's names ran off the top of the sheet pane with no way to scroll to
      // them. Not a scrolling problem — the stack grows upward from an anchor a fixed distance
      // above the system, so with alphaTab's default page padding the third name of a stack was
      // laid out at a NEGATIVE y, which is outside the scrollable content entirely. The fixture's
      // third bar is a five-note stack, which is the tallest the owner says this material makes.
      {
        const rows = await json(`JSON.stringify((() => {
          const out = [];
          for (const el of document.querySelectorAll('.note-name')) {
            const m = /translate\\(([-0-9.]+)px, *([-0-9.]+)px\\)/.exec(el.style.transform || '');
            out.push({ text: el.textContent, x: m ? Number(m[1]) : null, y: m ? Number(m[2]) : null });
          }
          return out;
        })())`);
        const tallest = rows.reduce((most, r) => {
          const n = rows.filter((o) => Math.abs(o.x - r.x) < 1).length;
          return Math.max(most, n);
        }, 0);
        const above = rows.filter((r) => r.y !== null && r.y < 0);
        say('names row', { labels: rows.length, tallestStack: tallest, negative: above.length });
        check(
          'headroom: not one name is laid out above the top of the page (they used to be)',
          rows.length > 0 && above.length === 0,
          JSON.stringify(above.slice(0, 4))
        );
        // The FULL five-name stack is checked in §10, on the grand staff: this shape puts the row
        // in the staff/tab band, and a four-string bass cannot hold five simultaneous notes, so
        // the tallest stack HERE is a property of the instrument rather than of the layout.
      }

      // -----------------------------------------------------------------
      // P6 — EVERY MEMBER SELECTS ITSELF
      // -----------------------------------------------------------------
      //
      // The report: clicking the long member highlighted its roll note and clicking the short one
      // did nothing. Every notehead in the stack is pressed here, in turn, and each must answer
      // with its OWN id — the short member included, which is the half that was broken.
      const selectedIds = [];
      for (const head of stack) {
        await ev(`(() => {
          const el = document.querySelector('.triview-scroll');
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 11, isPrimary: true, button: 0, buttons: 1, clientX: ${head.x}, clientY: ${head.y} }));
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 11 }));
          return true;
        })()`);
        await settle(300);
        selectedIds.push({ wanted: head.id, got: (await sheet()).selection });
      }
      say('chord member selection', selectedIds);
      check(
        'chord: every stacked notehead selects ITS OWN roll note, short members included',
        selectedIds.length >= 2 && selectedIds.every((s) => s.got.includes(s.wanted)),
        JSON.stringify(selectedIds.filter((s) => !s.got.includes(s.wanted)))
      );

      // The names row is the other door into the same fault: it used to resolve a press by X
      // alone and hand back `beat.notes[0]`, so every name in a stack selected the bottom member.
      const nameHits = await json(`JSON.stringify((() => {
        const out = [];
        for (const el of document.querySelectorAll('.note-name')) {
          if (!el.dataset.noteId) continue;
          out.push(el.dataset.noteId);
        }
        return out.slice(0, 12);
      })())`);
      say('name labels carry ids', nameHits);
      check(
        'chord: the note-name labels carry the note each one is ABOUT',
        nameHits.length >= 2 && new Set(nameHits).size >= 2,
        JSON.stringify(nameHits)
      );

      // -----------------------------------------------------------------
      // P1 — THE DURATION IS CHORD-WIDE, AND REPEATING IT CHANGES NOTHING
      // -----------------------------------------------------------------
      //
      // The report: "picking a length does nothing visible on the sheet but SHORTENS the roll
      // note each successive click." Root cause: the reducer's chord test was a microsecond
      // epsilon while the engraver groups attacks inside 35 ms, so the edited note was clipped
      // against its OWN chord mate and collapsed to the minimum. Both halves are checked — the
      // stack becomes one value, and the second identical pick is a no-op.
      const memberIds = stack.map((h) => h.id);
      await rightClick(Math.round(stack[stack.length - 1].x), Math.round(stack[stack.length - 1].y));
      await settle(300);
      const pickedHalf = await pick('Half');
      await settle(1500);
      const afterHalf = await sheet();
      const rollAfter = await rects();
      const spans = memberIds.map((id) => {
        const n = afterHalf.notes.find((x) => x.id === id);
        return { id, startSec: n?.startSec ?? null, endSec: n?.endSec ?? null };
      });
      say('after Half', { picked: pickedHalf, spans });
      await shot('08-chord-half');
      check(
        'chord duration: EVERY member of the stack becomes the chosen value, not just the one clicked',
        spans.length >= 2 &&
          spans.every((s) => s.endSec !== null) &&
          Math.max(...spans.map((s) => s.endSec)) - Math.min(...spans.map((s) => s.endSec)) < 0.01,
        JSON.stringify(spans)
      );
      check(
        'chord duration: and the roll shows it — the short member got LONGER, it did not collapse',
        memberIds.every((id) => {
          const r = rollAfter.find((x) => x.noteId === id);
          return r && r.w > 4;
        }),
        JSON.stringify(memberIds.map((id) => rollAfter.find((x) => x.noteId === id)?.w ?? null))
      );

      // REPEAT-APPLY. This is the reported loop, stated as a fixed point.
      await rightClick(Math.round(stack[stack.length - 1].x), Math.round(stack[stack.length - 1].y));
      await settle(300);
      await pick('Half');
      await settle(1500);
      const afterTwice = await sheet();
      const spans2 = memberIds.map((id) => afterTwice.notes.find((x) => x.id === id)?.endSec ?? null);
      say('after Half twice', spans2);
      check(
        'chord duration: picking the SAME value again changes nothing (the shrink loop)',
        spans2.every((end, i) => end !== null && Math.abs(end - spans[i].endSec) < 1e-3),
        `${JSON.stringify(spans.map((s) => s.endSec))} -> ${JSON.stringify(spans2)}`
      );
    }

    // ===================================================================
    // 9 — BAR OPERATIONS ON A RECORDED TAKE, AND THE WAVEFORM DOES NOT MOVE
    // ===================================================================
    //
    // The whole of workstream C in one sequence: insert a bar into the middle of a take that has
    // audio behind it, and check that the NOTES moved, the inserted bar is EMPTY, the recording's
    // own length did not change by so much as a float, and the waveform strip is the same
    // picture — pixel for pixel, off a real screenshot of the element rather than off a number
    // the app reports about itself.
    {
      /**
       * A photograph of the strip, WITH THE SELECTION BRACKET CLEARED FIRST.
       *
       * The claim these shots support is that the waveform's PEAKS are immutable — a recording is
       * a photograph and a bar operation may not resize it. The selection bracket is a different
       * thing painted on the same canvas: it is chrome that tracks the selected note, so it moves
       * whenever the selection does, entirely legitimately.
       *
       * That distinction started to matter when the right-click road began synchronising the
       * selection to the note it is about to edit (audit finding 4: the menu used to mutate one
       * note while a different one held the only visible ring). The bar-op sequence right-clicks
       * between the two shots, so the second frame gained a bracket the first did not have and
       * the comparison failed on chrome while the peaks were in fact identical.
       *
       * Clearing selection on both sides isolates the thing being asserted instead of loosening
       * the assertion, which is the direction that keeps it worth having.
       */
      const waveShot = async () => {
        await ev(`(() => { window.__RIFFSHEET_SELECT__ && window.__RIFFSHEET_SELECT__([]); return true; })()`);
        await settle(150);
        const box = await json(`JSON.stringify((() => {
          const el = document.querySelector('.waveform') || document.querySelector('canvas.waveform-canvas') ||
                     document.querySelector('.waveform-pane');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
        })())`);
        if (!box || box.width < 4 || box.height < 4) return null;
        const r = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { ...box, scale: 1 }
        });
        return r.data;
      };

      const before = await sheet();
      const waveBefore = await waveShot();
      // The bar the operation acts on: the middle one, so there is material on both sides of it.
      const targetBar = Math.max(1, Math.floor(before.bars.length / 2));
      const seamSec = before.bars[targetBar].startSec;
      const barSec = before.bars[targetBar].durSec;
      const laterBefore = before.notes.filter((n) => n.startSec >= seamSec - 1e-3).map((n) => n.startSec);
      say('bar op setup', {
        bars: before.bars.length,
        targetBar,
        seamSec,
        barSec,
        audio: before.audioDurationSec,
        score: before.scoreDurationSec,
        detached: before.timelineDetached
      });
      await shot('09-bars-before');

      // Right-click ON that bar: the x of any notehead inside it, at a y with nothing on it.
      const inBar = before.noteHeads.find(
        (h) => h.staff === 'notation' && before.notes.some((n) =>
          n.id === h.id && n.startSec >= seamSec - 1e-3 && n.startSec < seamSec + barSec - 1e-3)
      );
      check('bars on a take: a notehead inside the target bar was found', !!inBar, JSON.stringify(inBar ?? null));
      if (inBar) {
        await rightClick(Math.round(inBar.x), Math.round(inBar.y));
        await settle(300);
        const m = await menu();
        check(
          'bars on a take: Insert bar before is offered and NOT refused',
          !!m.items.find((i) => i.label === 'Insert bar before' && !i.disabled),
          JSON.stringify(m.items.filter((i) => i.label.includes('bar')))
        );
        const barPick = await pick('Insert bar before');
        await settle(1800);
        const after = await sheet();
        const waveAfter = await waveShot();
        say('after insert', {
          picked: barPick,
          bars: after.bars.length,
          audio: after.audioDurationSec,
          score: after.scoreDurationSec,
          detached: after.timelineDetached
        });
        await shot('10-bars-after');

        check(
          'bars on a take: THE WAVEFORM IS PIXEL-IDENTICAL (it is a photograph, not a timeline)',
          !!waveBefore && waveBefore === waveAfter,
          waveBefore === waveAfter ? 'identical' : 'the strip repainted differently'
        );
        check(
          "bars on a take: and the RECORDING's length is untouched to the float",
          after.audioDurationSec === before.audioDurationSec,
          `${before.audioDurationSec}s -> ${after.audioDurationSec}s`
        );
        check(
          'bars on a take: the SCORE got one bar longer, and says so',
          after.scoreDurationSec > before.scoreDurationSec + barSec * 0.5 && after.timelineDetached === true,
          `score ${before.scoreDurationSec}s -> ${after.scoreDurationSec}s, detached=${after.timelineDetached}`
        );
        check(
          'bars on a take: every note at or after the seam moved exactly one bar later',
          laterBefore.length > 0 &&
            laterBefore.every((sec) =>
              after.notes.some((n) => Math.abs(n.startSec - (sec + barSec)) < 0.02)
            ),
          `${laterBefore.length} notes; first ${laterBefore[0]}s -> wanted ${laterBefore[0] + barSec}s`
        );
        check(
          'bars on a take: THE INSERTED BAR IS EMPTY — nothing attacks or sounds inside it',
          !after.notes.some((n) => n.startSec < seamSec + barSec - 1e-3 && n.endSec > seamSec + 1e-3),
          JSON.stringify(
            after.notes.filter((n) => n.startSec < seamSec + barSec - 1e-3 && n.endSec > seamSec + 1e-3).slice(0, 3)
          )
        );

        // ONE UNDO, both halves: the notes AND the structural length.
        await ev(`(() => { document.querySelector('[data-role="undo"]')?.click(); return true; })()`);
        await settle(1800);
        const undone = await sheet();
        say('after undo', { bars: undone.bars.length, audio: undone.audioDurationSec, score: undone.scoreDurationSec });
        check(
          'bars on a take: ONE undo puts every note back where it was',
          laterBefore.every((sec) => undone.notes.some((n) => Math.abs(n.startSec - sec) < 0.02)),
          `${laterBefore.length} notes checked`
        );
        check(
          'bars on a take: ...and the recording is still exactly as long as it always was',
          undone.audioDurationSec === before.audioDurationSec,
          `${before.audioDurationSec}s -> ${undone.audioDurationSec}s`
        );
        // THE STRUCTURAL HALF OF THE SAME STEP. A recorded take declares no bar count until the
        // first insert adopts one, so undoing that insert has to put the declaration back to
        // "none" — otherwise the page keeps an empty bar its own history does not account for.
        check(
          'bars on a take: and the page is back to the length it was engraved at',
          undone.bars.length === before.bars.length && undone.scoreDurationSec === before.scoreDurationSec,
          `${before.bars.length} bars/${before.scoreDurationSec}s -> ${undone.bars.length} bars/${undone.scoreDurationSec}s`
        );

        // THE OTHER DIRECTION, on the same take: delete removes the bar's notes and pulls
        // everything after it one bar earlier. Same rule about the recording — it does not move.
        await rightClick(Math.round(inBar.x), Math.round(inBar.y));
        await settle(300);
        const delPicked = await pick('Delete bar');
        await settle(1800);
        const deleted = await sheet();
        const waveDeleted = await waveShot();
        const insideBefore = before.notes.filter(
          (n) => n.startSec >= seamSec - 1e-3 && n.startSec < seamSec + barSec - 1e-3
        );
        const afterBarBefore = before.notes
          .filter((n) => n.startSec >= seamSec + barSec - 1e-3)
          .map((n) => n.startSec);
        say('after delete', {
          picked: delPicked,
          bars: deleted.bars.length,
          audio: deleted.audioDurationSec,
          score: deleted.scoreDurationSec,
          removed: insideBefore.length
        });
        await shot('12-bars-deleted');
        check(
          'bars on a take: deleting one takes the notes that were IN it with it',
          insideBefore.length > 0 && insideBefore.every((n) => !deleted.notes.some((d) => d.id === n.id)),
          `${insideBefore.length} notes were in the bar; ${insideBefore.filter((n) => deleted.notes.some((d) => d.id === n.id)).length} survived`
        );
        check(
          'bars on a take: and pulls everything after it exactly one bar earlier',
          afterBarBefore.length > 0 &&
            afterBarBefore.every((sec) =>
              deleted.notes.some((n) => Math.abs(n.startSec - (sec - barSec)) < 0.02)
            ),
          `${afterBarBefore.length} notes; first ${afterBarBefore[0]}s -> wanted ${afterBarBefore[0] - barSec}s`
        );
        check(
          'bars on a take: the waveform is STILL the same photograph after a delete',
          !!waveBefore && waveBefore === waveDeleted && deleted.audioDurationSec === before.audioDurationSec,
          `audio ${before.audioDurationSec}s -> ${deleted.audioDurationSec}s, strip ${waveBefore === waveDeleted ? 'identical' : 'repainted'}`
        );
      }
    }

    // ===================================================================
    // 10 — GRAND + TAB: the key on BOTH staves, and the names off the stem lane
    // ===================================================================
    //
    // The two defects the owner's first screenshot carries, checked on the same picture it was a
    // picture of: Clef: Grand with Tab: Bass, in a key with accidentals in it.
    await reload(`http://127.0.0.1:${PORT}/index.html?demo=chord&bars=4&tab=bass&verify=1`);
    {
      // A key with three sharps, and the grand clef — both through the real controls.
      await ev(`(() => {
        const set = (role, value) => {
          const el = document.querySelector('[data-role="' + role + '"]');
          if (!el) return false;
          el.value = value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        return [set('doc-key', '3'), set('clef-view', 'grand')];
      })()`);
      await settle(2500);
      await shot('11-grand-tab-key');

      // THE KEY, counted off the ENGRAVING, per stave. alphaTab draws a key signature as
      // accidental glyphs immediately after the clef, so "how many accidental glyphs are in the
      // first 120px of each stave" is the question the screenshot answers by eye.
      const perStave = await json(`JSON.stringify((() => {
        const tv = window.__RIFFSHEET_LAYOUT__ && window.__RIFFSHEET_LAYOUT__();
        return tv ? tv.keySignaturePerStave : null;
      })())`);
      say('key signature per stave', perStave);
      check(
        'grand: the key signature is on EVERY stave, not only the treble one',
        Array.isArray(perStave) && perStave.length >= 2 && perStave.every((k) => k === perStave[0] && k !== 0),
        JSON.stringify(perStave)
      );

      // B7 — the names must not be in the bass-stem / TAB lane. With a grand staff the row goes
      // ABOVE the whole system, so every label is above the topmost stave's top line.
      const lane = await json(`JSON.stringify((() => {
        const tv = window.__RIFFSHEET_LAYOUT__ && window.__RIFFSHEET_LAYOUT__();
        const top = tv ? tv.systemTop : null;
        const rows = [];
        for (const el of document.querySelectorAll('.note-name')) {
          const m = /translate\\(([-0-9.]+)px, *([-0-9.]+)px\\)/.exec(el.style.transform || '');
          if (m) rows.push(Number(m[2]));
        }
        return { top, lowest: rows.length ? Math.max(...rows) : null, highest: rows.length ? Math.min(...rows) : null, count: rows.length };
      })())`);
      say('grand names lane', lane);
      check(
        'grand + tab: every note name is ABOVE the system, out of the bass-stem and TAB lane',
        lane.count > 0 && lane.top !== null && lane.lowest !== null && lane.lowest <= lane.top,
        JSON.stringify(lane)
      );
      check(
        'grand + tab: and none of them is off the top of the page',
        lane.highest !== null && lane.highest >= 0,
        JSON.stringify(lane)
      );
      // P5, on the shape that actually produces a five-note stack: a grand staff can hold all
      // five of the fixture's simultaneous pitches, where a four-string bass tab cannot. The row
      // stacks upward by 12px a name, so a five-name stack spans 48px above its anchor — which
      // is exactly the room `reserveTopRoom` buys, and the reason the top two names used to be
      // laid out at a negative y with no way to scroll to them.
      const stackSpan = lane.lowest !== null && lane.highest !== null ? lane.lowest - lane.highest : 0;
      check(
        'headroom: the five-note stack is drawn IN FULL and still fits above the staff',
        stackSpan >= 47 && lane.highest >= 0,
        `stack spans ${stackSpan}px, topmost name at y=${lane.highest}`
      );
      const padding = await json(
        `JSON.stringify((window.__RIFFSHEET_LAYOUT__ && window.__RIFFSHEET_LAYOUT__().pagePadding) ?? null)`
      );
      say('page padding', padding);
      check(
        'headroom: it is REAL page padding, so the engraving and the labels moved together',
        Array.isArray(padding) && padding.length === 4 && padding[1] > 35,
        JSON.stringify(padding)
      );
    }

    // ===================================================================
    // 11 — THE GESTURE RECORDER (D2): off by default, and real when it is on
    // ===================================================================
    //
    // WHY THIS IS CHECKED AT ALL. Everything this repository claims about WKWebView's trackpad is
    // a claim about a SHAPE — `scripts/gesture-test.ts` says so on its face, because no Chromium
    // has ever implemented `GestureEvent`. The only machine that can settle it is the owner's,
    // running the real plugin, where there is no console to paste a snippet into. So the recorder
    // ships, behind a flag, and this proves the flag works and that what it writes is the fixture
    // format — the two things that would leave the owner with nothing to send back.
    {
      const off = await ev('typeof window.__RSGT__');
      check(
        'gesture recorder: OFF unless it is asked for — nothing installed on an ordinary boot',
        off === 'undefined',
        `window.__RSGT__ is ${off}`
      );

      await reload(`http://127.0.0.1:${PORT}/index.html?demo=straight&bars=2&tab=bass&verify=1&gesturerec=1`);
      const roll = await json(`JSON.stringify((() => {
        const el = document.querySelector('.pianoroll') || document.querySelector('.triview-scroll');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })())`);
      // THROUGH THE BROWSER, not `dispatchEvent`: `Input.dispatchMouseEvent` makes the engine
      // synthesise the event, so what the recorder sees is `isTrusted: true` with the engine's own
      // deltaMode and modifier plumbing — which is the difference between a capture and a
      // hand-written stream, and is exactly what the fixture's provenance field is about.
      for (let i = 0; i < 4; i++) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: roll.x, y: roll.y, deltaX: 0, deltaY: -8, modifiers: 2, pointerType: 'mouse'
        });
        await settle(40);
      }
      await settle(400);
      const trace = await json(`JSON.stringify(JSON.parse(window.__RSGT__.json('probe-trace')))`);
      say('recorder', {
        provenance: trace.provenance,
        events: trace.events.length,
        first: trace.events[0] ?? null
      });
      check(
        'gesture recorder: the flag turns it on and it records real, delivered events',
        trace.events.length >= 4 && trace.events.every((e) => e.isTrusted === true),
        `${trace.events.length} events, trusted=${trace.events.every((e) => e.isTrusted)}`
      );
      check(
        'gesture recorder: what it writes IS the fixture format the replay test reads',
        trace.provenance === 'captured' &&
          typeof trace.engine === 'string' &&
          trace.events.every((e) => e.kind === 'wheel' && typeof e.atMs === 'number' && typeof e.delta === 'number'),
        JSON.stringify(trace.events[0] ?? null)
      );
      check(
        'gesture recorder: and it says WHICH SIDE of the tree it saw each one on, and what the app did',
        trace.events.some((e) => e.phase === 'capture') &&
          trace.events.some((e) => e.defaultPrevented === true) &&
          trace.events.some((e) => (e.path ?? []).length > 0),
        JSON.stringify(trace.events.map((e) => ({ p: e.phase, dp: e.defaultPrevented })).slice(0, 4))
      );
    }

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${results.length} checks)`);
    await writeFile(join(OUT, 'sheet-edit-probe.json'), JSON.stringify({ results }, null, 2));
  } catch (e) {
    failures++;
    console.error('probe crashed:', e);
  } finally {
    cdp?.close();
    reapChrome();
    server.close();
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
  process.exit(failures === 0 ? 0 : 1);
};

main();
