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
    const noteHeadAt = async (nth) => {
      const s = await sheet();
      return s && s.noteHeads.length ? s.noteHeads[Math.min(nth, s.noteHeads.length - 1)] : null;
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
    check(
      'note menu: bar operations are shown and REFUSED with a reason on a recorded take',
      ['Insert bar before', 'Insert bar after', 'Delete bar'].every((label) => {
        const item = noteMenu.items.find((i) => i.label === label);
        return item && item.disabled && item.reason === 'Bars are fixed by the recording';
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
      const addPicked = await pick('Add note');
      await settle(1500);
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
      say('after add', await sheet().then((x) => ({ raw: x.rawNotes, feed: x.feedNotes, undo: x.undoTitle })));
      await shot('03-after-add');
      check(
        'add note: the roll gained a rectangle, so the performance really changed',
        addPicked === 'picked' && countAfter === countBefore + 1,
        `pick=${addPicked}, rects ${countBefore} -> ${countAfter}`
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
      const target = (await sheet()).noteHeads[4];
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

      // The mirror: mostly vertical, with sideways slop. Pitch moves, time does not.
      const before2 = await rects();
      const target2 = (await sheet()).noteHeads[6];
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
        check(
          'imported part: every edit item is refused',
          m.open === true && m.items.length > 0 && m.items.every((i) => i.disabled),
          JSON.stringify(m.items.filter((i) => !i.disabled))
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
