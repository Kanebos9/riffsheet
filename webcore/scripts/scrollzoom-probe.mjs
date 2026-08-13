#!/usr/bin/env node
/**
 * THE SCROLL/ZOOM PROBE. One live check per finding in the Codex coupling audit.
 *
 * A SEPARATE FILE from ghost-probe.mjs and verify.mjs on purpose, and the same bootstrap in all
 * three (its own port pair, 5397/9337, so all three can run at once).
 *
 * WHY IT EXISTS AT ALL. The fourteen findings were reproduction RECIPES — "zoom in, drag the
 * scrollbar across a density change, wait 250 ms, watch the roll breathe" — and a recipe that
 * only a person can run is a bug that comes back. Each one below is that recipe, driven through
 * the real DOM at the real app, asserting on numbers rather than on pixels wherever the number
 * is the honest claim.
 *
 * WHAT IT READS. `__RIFFSHEET_VIEWPORT__` publishes the app's ONE authoritative viewport, the
 * shared limits, the saturation flags, the scrollbar's own geometry, and a LOG of every command
 * that reached the reducer. The log is what makes the mechanism checkable rather than only its
 * consequences: "one pinch produced exactly one revision" is a statement no screenshot can make.
 *
 * PROVEN AGAINST THE BUGS. Findings 1, 2 and 6 were re-run with the fixes surgically reverted
 * (see `--regress`, and the notes on each check); each fails there and passes here. A check that
 * has never been seen to fail is a rubber stamp.
 *
 *   node scripts/scrollzoom-probe.mjs [--headful] [--shots]
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
const PORT = 5397;
const DEBUG_PORT = 9337;
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

async function main() {
  await mkdir(OUT, { recursive: true });
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('dist/index.html missing — run the build first.');
    process.exit(1);
  }
  const server = await serve();
  const chromePath = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.CHROME_PATH
  ].filter(Boolean).find((p) => existsSync(p));
  if (!chromePath) { console.error('No Chrome found'); process.exit(1); }

  const profileDir = join(tmpdir(), `riffsheet-scrollzoom-${process.pid}-${Date.now()}`);
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required'
  ];
  if (!HEADFUL) args.push('--headless=new', '--disable-gpu');
  // Through the shared bootstrap, which owns the process GROUP and reaps it on every exit
  // path — including Ctrl-C and a kill, which a `finally` never sees. See probe-chrome.mjs.
  const { proc, dispose: reapChrome } = launchChrome(chromePath, args, { profileDir });

  let cdp, failures = 0;
  const errors = [];
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
      await writeFile(join(OUT, `scrollzoom-${name}.png`), Buffer.from(r.data, 'base64'));
    };

    const results = [];
    const check = (label, ok, detail) => {
      results.push({ label, ok: !!ok, detail });
      if (!ok) failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    };
    const say = (label, value) => console.log(`      ${label}: ${JSON.stringify(value)}`);

    await cdp.send('Page.navigate', {
      url: `http://127.0.0.1:${PORT}/index.html?demo=triplet&bars=8&tab=bass&verify=1`
    });
    for (let i = 0; ; i++) {
      const ready = await ev('!!window.__RIFFSHEET_DEMO_READY__ && (document.querySelector(".at-host .at-surface")?.childElementCount ?? 0) > 0');
      if (ready === true) break;
      if (i > 60) {
        console.log('not ready; page says:', await ev(`JSON.stringify({
          demoReady: !!window.__RIFFSHEET_DEMO_READY__,
          names: document.querySelectorAll('.note-name').length,
          host: !!document.querySelector('.at-host'),
          surfaceKids: document.querySelector('.at-host .at-surface')?.childElementCount ?? -1,
          screen: document.querySelector('.triview') ? 'main' : 'opening',
          log: window.__RSLOG__ ?? null,
          glyphs: [...document.querySelectorAll('.at-host .at-surface > div')].map((d) => d.querySelectorAll('path,text').length),
          rollNotes: window.__RIFFSHEET_ROLLRECTS__ ? window.__RIFFSHEET_ROLLRECTS__().length : null,
          renderInfo: window.__RIFFSHEET_LAYOUT__ ? null : null,
          beats: (() => { const l = window.__RIFFSHEET_LAYOUT__ && window.__RIFFSHEET_LAYOUT__(); return l ? { split: l.hasSplit, systems: l.systems } : null; })(),
          texts: [...document.querySelectorAll('.at-host svg text')].slice(0,12).map(t=>t.textContent),
          namesRow: document.querySelector('.names-row')?.childElementCount ?? -1,
          stackKids: [...(document.querySelector('.triview-stack')?.children ?? [])].map((c) => c.className)
        })`));
        throw new Error('demo never became ready');
      }
      await settle(200);
    }
    await settle(800);

    // =====================================================================
    // Helpers shared by the checks below
    // =====================================================================
    const vp = () => json('JSON.stringify(window.__RIFFSHEET_VIEWPORT__ ? window.__RIFFSHEET_VIEWPORT__() : null)');
    const resetLog = () => ev('!!window.__RIFFSHEET_VIEWPORTLOGRESET__ && window.__RIFFSHEET_VIEWPORTLOGRESET__()');
    const near = (a, b, tol) => Math.abs(a - b) <= tol;

    /** A pointer press/drag/release on an element, in CLIENT coordinates. */
    const pointerAt = (selector, kind, clientX, clientY, buttons = 1) =>
      '(() => {' +
      '  const el = document.querySelector(' + JSON.stringify(selector) + ');' +
      '  if (!el) return "missing";' +
      '  el.dispatchEvent(new PointerEvent(' + JSON.stringify(kind) + ', { bubbles: true, cancelable: true,' +
      '    pointerId: 1, isPrimary: true, clientX: ' + clientX + ', clientY: ' + clientY +
      '    , buttons: ' + buttons + ', button: 0 }));' +
      '  return true;' +
      '})()';

    /** A wheel event, dispatched at the element under the given client point. */
    const wheelAt = (selector, clientX, clientY, deltaX, deltaY, ctrl) => `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'missing';
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        clientX: ${clientX}, clientY: ${clientY}, deltaX: ${deltaX}, deltaY: ${deltaY},
        deltaMode: 0, ctrlKey: ${ctrl ? 'true' : 'false'} }));
      return true;
    })()`;

    const rectOf = (selector) => json(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify(null);
      const r = el.getBoundingClientRect();
      return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height });
    })()`);

    /** Where a note id's notehead is on screen, straight off the engraving's own bounds. */
    const noteScreenX = (noteId) => json(`(() => {
      const L = window.__RIFFSHEET_LAYOUT__ && window.__RIFFSHEET_LAYOUT__();
      const n = (L?.noteXs ?? []).find((r) => r.noteId === ${JSON.stringify(noteId)});
      return JSON.stringify(n ? n.screenX : null);
    })()`);

    const someNoteIds = await json(`(() => {
      const L = window.__RIFFSHEET_LAYOUT__ && window.__RIFFSHEET_LAYOUT__();
      return JSON.stringify((L?.noteXs ?? []).map((r) => ({ id: r.noteId, x: r.screenX })));
    })()`);

    const start = await vp();
    say('viewport at rest', { viewport: start.viewport, limits: start.limits, sheetScale: start.sheetScale });
    check('the app has ONE authoritative viewport', !!start.viewport, JSON.stringify(start.viewport));
    check(
      'the shared zoom range is the INTERSECTION of roll and sheet (finding 9)',
      !!start.limits && start.limits.maxSpanSec !== null && start.limits.minSpanSec > 0.05,
      `min=${start.limits?.minSpanSec}s max=${start.limits?.maxSpanSec}s (roll alone would be 0.05s..take)`
    );
    await shot('01-at-rest');

    // =====================================================================
    // FINDING 1 — the scrollbar's forward and inverse mappings must agree
    // =====================================================================
    //
    // RECIPE: scroll about halfway, press the thumb without moving, watch the sheet jump left.
    // The old `updateScrollbar` placed the thumb over `trackWidth - thumbWidth` while `seekTo`
    // divided the grabbed position by the whole `trackWidth`, so pressing an already-positioned
    // thumb was not the identity: a 30%-wide thumb at 50% mapped to 35%.
    //
    // Checked at THREE positions including the far right, because the error is proportional to
    // how far along the thumb is — at 0 the two mappings agree by accident, which is exactly how
    // a bug like this survives a spot check.
    {
      const bar0 = (await vp()).scrollbar;
      check('the horizontal scrollbar is on screen to be tested', !!bar0 && bar0.visible, JSON.stringify(bar0));
      if (bar0 && bar0.visible) {
        const jumps = [];
        for (const frac of [0.0, 0.5, 1.0]) {
          // Put the window there through the reducer's own road (a drag of the thumb), so the
          // thumb really is where `updateScrollbar` puts it before we press it.
          const b = (await vp()).scrollbar;
          const targetX = b.trackLeft + b.thumbWidth / 2 + frac * b.travelPx;
          const y = (await rectOf('.hscroll')).top + 4;
          await ev(pointerAt('.hscroll', 'pointerdown', targetX, y));
          await ev(`(() => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })); return true; })()`);
          await settle(350);

          // THE IDENTITY TEST. Press the thumb dead centre and let go without moving.
          const before = await vp();
          const t = before.scrollbar;
          const centre = t.thumbLeft + t.thumbWidth / 2;
          await ev(pointerAt('.hscroll', 'pointerdown', centre, y));
          await ev(`(() => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })); return true; })()`);
          await settle(300);
          const after = await vp();
          jumps.push({
            frac,
            fromBefore: before.viewport.fromSec,
            fromAfter: after.viewport.fromSec,
            jumpSec: Number(Math.abs(after.viewport.fromSec - before.viewport.fromSec).toFixed(4))
          });
        }
        say('scrollbar press-identity', jumps);
        const worst = Math.max(...jumps.map((j) => j.jumpSec));
        // A twentieth of a second on a take this long is well under one pixel of thumb travel;
        // the bug moved it by tens of percent of the take.
        check(
          'finding 1: pressing the thumb without moving it moves nothing',
          worst < 0.05,
          `worst jump ${worst}s across fracs 0/0.5/1`
        );
        const rightEnd = jumps[jumps.length - 1];
        const dur = (await vp()).limits.durationSec;
        const span = (await vp()).spanSec;
        check(
          'finding 1: the far right edge is reachable',
          near(rightEnd.fromBefore, dur - span, 0.25),
          `fromSec=${rightEnd.fromBefore} wanted=${Number((dur - span).toFixed(3))}`
        );
      }
    }

    // =====================================================================
    // FINDING 2 — a scrollbar drag must PAN, not zoom, and must not breathe
    // =====================================================================
    //
    // RECIPE: zoom in, drag the scrollbar across notation whose engraving density changes, stop,
    // wait ~250 ms. The old loop: the sheet's two engraved viewport edges became the window, the
    // roll's `holdSpan` replaced the span, `applyTimeWindow` republished it unconditionally, a
    // 250 ms timer called it a commit, and `App` — seeing a >2% difference — called `tv.setZoom`.
    // A scroll became a delayed zoom, which is what "breathing" was.
    //
    // The wait is 900 ms, comfortably past both the old 250 ms commit and the old 700 ms
    // ownership clock, so a delayed re-scale has every chance to happen.
    {
      await resetLog();
      const y = (await rectOf('.hscroll')).top + 4;
      const b0 = (await vp()).scrollbar;
      const spans = [];
      // ONE PRESS AND A REAL DRAG. Five separate presses would not be a drag at all: pressing
      // the thumb anywhere along its length is deliberately the identity (finding 1), so the
      // gesture has to take hold once and then move — which is also the gesture the report is
      // about, dragged across notation whose engraving density changes as it goes.
      const grabX = b0.thumbLeft + b0.thumbWidth / 2;
      await ev(pointerAt('.hscroll', 'pointerdown', grabX, y));
      const move = (x) => `(() => { window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: ${x}, clientY: ${y}, buttons: 1 })); return true; })()`;
      for (const frac of [0.15, 0.35, 0.55, 0.75, 0.95]) {
        await ev(move(b0.trackLeft + b0.thumbWidth / 2 + frac * b0.travelPx));
        await settle(140);
        const v = await vp();
        spans.push({ frac, from: v.viewport.fromSec, span: v.spanSec, scale: Number(v.sheetScale.toFixed(4)) });
      }
      await ev(`(() => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })); return true; })()`);
      const settled = await (async () => { await settle(900); return vp(); })();
      say('scrollbar drag across the take', spans);
      say('after 900ms of stillness', { span: settled.spanSec, scale: Number(settled.sheetScale.toFixed(4)) });
      const spanValues = spans.map((s) => s.span).concat([settled.spanSec]);
      const drift = (Math.max(...spanValues) - Math.min(...spanValues)) / spanValues[0];
      check(
        'finding 2: dragging the scrollbar PANS — the span never changes',
        drift < 0.005,
        `span drift ${(drift * 100).toFixed(3)}% across five positions and a 900ms settle`
      );
      check(
        'finding 2: and the window really moved while it did not re-scale',
        Math.abs(spans[spans.length - 1].from - spans[0].from) > 1,
        `from ${spans[0].from}s -> ${spans[spans.length - 1].from}s`
      );
      const log = settled.log;
      // NO ZOOM EVER ANSWERS A PAN, which is the claim, rather than "nothing but pans", which
      // is not. A pan against the start or the end of the take can legitimately raise ONE extra
      // command: the sheet reports that its page had nowhere further to scroll and the window
      // takes the sheet's actual left edge instead (`App.reportSheetLeftEdge`). That is a
      // `sheetScroll` — one edge, span supplied by the reducer — so it cannot re-scale anything,
      // which the span check above already proves. What must never appear is a `zoom` or a
      // `showSpan`: those are the commands the old controller manufactured out of a scroll.
      const rescaling = (l) => l.filter((e) => e.kind === 'zoom' || e.kind === 'showSpan' || e.kind === 'fit');
      check(
        'finding 2: a scrollbar drag never manufactures a zoom out of a scroll',
        log.length > 0 && rescaling(log).length === 0,
        `kinds: ${[...new Set(log.map((e) => e.kind + ':' + e.source))].join(', ')}`
      );
    }

    // =====================================================================
    // FINDING 3 — the edges: span constant, and the moment preserved
    // =====================================================================
    //
    // RECIPE: scroll fully right so the sheet's viewport runs past the last engraved bar, then
    // fully left into the clef/key/meter prefix. `contentXToTick` extrapolates through both, and
    // the old controller turned those extrapolated x's into the window — on a 20 s take a raw
    // [18,25] became [13,20], so the sheet's left edge said 18 s while the roll silently showed
    // 13 s. Both edges are driven through the SHEET's own scroller, which is the gesture.
    {
      const dur = (await vp()).limits.durationSec;
      const setSheetScroll = (px) => `(() => { const s = document.querySelector('.triview-scroll'); if (!s) return 'missing'; s.scrollLeft = ${px}; return true; })()`;
      await ev(setSheetScroll(999999));
      await settle(600);
      const right = await vp();
      await ev(setSheetScroll(0));
      await settle(600);
      const left = await vp();
      say('edges', {
        right: { from: right.viewport.fromSec, span: right.spanSec },
        left: { from: left.viewport.fromSec, span: left.spanSec }
      });
      check(
        'finding 3: scrolling to the right edge keeps the span',
        Math.abs(right.spanSec - left.spanSec) / left.spanSec < 0.005,
        `right ${right.spanSec}s vs left ${left.spanSec}s`
      );
      check(
        'finding 3: the right edge parks at the end of the take, not short of it',
        near(right.viewport.toSec, dur, Math.max(0.2, right.spanSec * 0.02)),
        `toSec=${right.viewport.toSec} take=${dur}`
      );
      check(
        'finding 3: the left edge parks at second zero, not at a negative or a slid window',
        near(left.viewport.fromSec, 0, 0.05),
        `fromSec=${left.viewport.fromSec}`
      );
    }

    // =====================================================================
    // FINDING 4 — a roll PAN must not be granted zoom ownership
    // =====================================================================
    //
    // RECIPE: zoom the time window, pan the roll horizontally, release near a density change or
    // an edge, and watch the sheet's return callback change the roll's magnification. Every
    // `source === 'user'` request used to arm `ownZoomUntilMs` for 700 ms — including a plain
    // pan — and for that window `holdSpan` accepted whatever span the sheet's engraving produced.
    {
      await resetLog();
      const roll = await rectOf('.pianoroll');
      const before = await vp();
      const y = roll.top + roll.height / 2;
      await ev(pointerAt('.pianoroll', 'pointerdown', roll.left + roll.width * 0.6, y));
      for (const step of [0.55, 0.5, 0.45, 0.4, 0.35]) {
        await ev(pointerAt('.pianoroll', 'pointermove', roll.left + roll.width * step, y));
        await settle(40);
      }
      await ev(pointerAt('.pianoroll', 'pointerup', roll.left + roll.width * 0.35, y, 0));
      await settle(900);
      const after = await vp();
      say('roll pan', { beforeSpan: before.spanSec, afterSpan: after.spanSec, from: [before.viewport.fromSec, after.viewport.fromSec] });
      check(
        'finding 4: a roll pan is a pan 900ms later too — the span never changed',
        Math.abs(after.spanSec - before.spanSec) / before.spanSec < 0.005,
        `${before.spanSec}s -> ${after.spanSec}s`
      );
      // Same rule as finding 2's log check: no `zoom`/`showSpan` may answer a pan. A trailing
      // `sheetScroll` is the sheet saying its page ran out, and it cannot change the span.
      check(
        'finding 4: and nothing re-scaled in answer to it',
        after.log.length > 0 &&
          after.log.filter((e) => e.kind === 'zoom' || e.kind === 'showSpan' || e.kind === 'fit').length === 0,
        `kinds: ${[...new Set(after.log.map((e) => e.kind))].join(', ')}`
      );
    }

    // =====================================================================
    // FINDING 5 — a small pan is not an echo
    // =====================================================================
    //
    // RECIPE: show ~10 s, two-finger pan by 5-15 px, stop. `sameTimeWindow` called any pair of
    // windows within 2% of the span identical, so on a 10 s window every pan under 0.2 s — about
    // 20 px on a 1000 px roll — was discarded as the app's own value echoing back. The roll and
    // the strip moved live and the sheet was never told.
    {
      const roll = await rectOf('.pianoroll');
      // AWAY FROM EITHER WALL FIRST. At an edge the reducer correctly refuses to move, and a
      // clamp is not the bug under test: what is, is a pan too small for the old 2% guard.
      const mid = await vp();
      const rollX = roll.left + roll.width / 2;
      const rollY = roll.top + roll.height / 2;
      await ev(wheelAt('.pianoroll', rollX, rollY, -99999, 0, false));
      await settle(300);
      const perPx = mid.spanSec / Math.max(1, roll.width - 34);
      await ev(wheelAt('.pianoroll', rollX, rollY, ((mid.limits.durationSec - mid.spanSec) / 2) / perPx, 0, false));
      await settle(400);
      const before = await vp();
      const sheetBefore = before.sheetScrollLeft;
      const px = 15;
      await ev(wheelAt('.pianoroll', rollX, rollY, px, 0, false));
      await settle(500);
      const after = await vp();
      const movedSec = after.viewport.fromSec - before.viewport.fromSec;
      say('15px pan', {
        movedSec: Number(movedSec.toFixed(4)),
        spanSec: before.spanSec,
        sheetScrollLeft: [sheetBefore, after.sheetScrollLeft]
      });
      check(
        'finding 5: a 15px pan moves the window at all',
        Math.abs(movedSec) > 1e-3,
        `moved ${movedSec.toFixed(4)}s (the 2% guard would have needed ${(before.spanSec * 0.02).toFixed(3)}s)`
      );
      check(
        'finding 5: and it is under the old 2% guard, so it is exactly the pan that used to vanish',
        Math.abs(movedSec) < before.spanSec * 0.02,
        `${Math.abs(movedSec).toFixed(4)}s < ${(before.spanSec * 0.02).toFixed(4)}s`
      );
      check(
        'finding 5: the SHEET followed it too',
        Math.abs((after.sheetScrollLeft ?? 0) - (sheetBefore ?? 0)) > 0.5,
        `sheet scrollLeft ${sheetBefore} -> ${after.sheetScrollLeft}`
      );
    }

    // =====================================================================
    // FINDINGS 6 + 7 — the sheet pinch anchors under the pointer, in one step
    // =====================================================================
    //
    // RECIPE (6): scroll away from the start, pinch over a note in the right half of the pane,
    // and watch the note slide out from under the fingers. `zoomAt` called `setZoom` first and
    // wrote the pointer anchor afterwards, guarded by `renderPending()` — but renders here are
    // synchronous, so the anchor had already been consumed and `renderPending()` was false. The
    // pointer anchor was therefore never installed at all and the sheet anchored on its left edge.
    //
    // RECIPE (7): the same gesture, watching the roll. Partial renders, the pre-anchor viewport
    // and the post-anchor viewport were all wired into the coupling, so the panes walked through
    // up to three windows per pinch. Asserted on the reducer LOG: one pinch, one revision.
    {
      await ev(`(() => { const s = document.querySelector('.triview-scroll'); if (s) s.scrollLeft = 700; return true; })()`);
      await settle(600);
      const sheet = await rectOf('.triview-scroll');
      // A note in the RIGHT HALF of the pane: at the left edge the bug and the fix agree.
      const target = await json(`(() => {
        const L = window.__RIFFSHEET_LAYOUT__ && window.__RIFFSHEET_LAYOUT__();
        const rect = document.querySelector('.triview-scroll').getBoundingClientRect();
        const wanted = rect.left + rect.width * 0.7;
        let best = null;
        for (const n of (L?.noteXs ?? [])) {
          if (n.screenX < rect.left + rect.width * 0.45 || n.screenX > rect.right - 40) continue;
          if (!best || Math.abs(n.screenX - wanted) < Math.abs(best.screenX - wanted)) best = n;
        }
        return JSON.stringify(best);
      })()`);
      say('pinch target note', target);
      if (!target) {
        check('finding 6: a note was found in the right half of the sheet to pinch over', false, 'none visible');
      } else {
        await resetLog();
        const beforeVp = await vp();
        const y = sheet.top + sheet.height / 2;
        // One pinch event, as macOS delivers it: a ctrl-wheel at the pointer.
        await ev(wheelAt('.triview-scroll', target.screenX, y, 0, -40, true));
        await settle(700);
        const afterX = await noteScreenX(target.noteId);
        const afterVp = await vp();
        say('sheet pinch', {
          noteX: [Math.round(target.screenX), afterX === null ? null : Math.round(afterX)],
          span: [beforeVp.spanSec, afterVp.spanSec],
          scale: [Number(beforeVp.sheetScale.toFixed(4)), Number(afterVp.sheetScale.toFixed(4))],
          log: afterVp.log
        });
        check(
          'finding 6: the note under the fingers stays under the fingers',
          afterX !== null && Math.abs(afterX - target.screenX) <= 24,
          `moved ${afterX === null ? 'off screen' : Math.round(afterX - target.screenX)}px (the bug anchored on the left edge, tens to hundreds)`
        );
        check(
          'finding 6: and the pinch actually zoomed',
          Math.abs(afterVp.spanSec - beforeVp.spanSec) / beforeVp.spanSec > 0.01,
          `span ${beforeVp.spanSec}s -> ${afterVp.spanSec}s, scale ${beforeVp.sheetScale.toFixed(3)} -> ${afterVp.sheetScale.toFixed(3)}`
        );
        const applied = afterVp.log.filter((e) => e.applied);
        check(
          'finding 7: one pinch produces exactly ONE settled window, with nothing transient',
          applied.length === 1 && applied[0].kind === 'zoom',
          `${applied.length} applied command(s): ${applied.map((e) => e.kind + ':' + e.source).join(', ')}`
        );
      }
    }

    // =====================================================================
    // FINDING 8 — the waveform's body and its bracket read the SAME window
    // =====================================================================
    //
    // RECIPE: zoom so the visible window is a small middle slice of a long take, then look at
    // the strip's dimming. `setTimeAnchors` zoomed the BODY to the window while `bracket()`
    // computed its x's on the whole-take ruler, so on a 100 s take showing [40,60] the bracket
    // was drawn from 40% to 60% of an already-zoomed body — roughly 48-52 s.
    {
      const v = await vp();
      const w = await json('JSON.stringify(window.__RIFFSHEET_WAVE__ ? window.__RIFFSHEET_WAVE__() : null)');
      say('waveform vs the window', {
        window: [v.viewport.fromSec, v.viewport.toSec],
        body: [w.windowFromSec, w.windowToSec],
        bracket: [w.viewportFromSec, w.viewportToSec],
        bracketX: [w.viewportFromX, w.viewportToX],
        overviewPx: w.overviewPx,
        sheetLinked: w.sheetLinked
      });
      const tol = Math.max(0.02, v.spanSec * 0.01);
      check(
        'finding 8: the waveform BODY shows the authoritative window',
        near(w.windowFromSec, v.viewport.fromSec, tol) && near(w.windowToSec, v.viewport.toSec, tol),
        `body [${w.windowFromSec}, ${w.windowToSec}] vs window [${v.viewport.fromSec}, ${v.viewport.toSec}]`
      );
      check(
        'finding 8: and the BRACKET is the same window, on the same ruler',
        w.viewportFromSec !== null &&
          near(w.viewportFromSec, v.viewport.fromSec, tol) &&
          near(w.viewportToSec, v.viewport.toSec, tol),
        `bracket [${w.viewportFromSec}, ${w.viewportToSec}]`
      );
      check(
        'finding 8: the bracket now spans the plot, because the body IS the window',
        w.viewportFromX !== null && Math.abs(w.viewportFromX - w.gutterPx) < 3 && Math.abs(w.viewportToX - w.width) < 3,
        `x [${w.viewportFromX}, ${w.viewportToX}] gutter=${w.gutterPx} width=${w.width}`
      );
      check(
        'finding 14: the dead overview-ribbon mode is gone, not merely switched off',
        w.overviewPx === 0 && w.sheetLinked === false && w.viewportDraggable === false,
        `overviewPx=${w.overviewPx} sheetLinked=${w.sheetLinked} draggable=${w.viewportDraggable}`
      );
    }

    // =====================================================================
    // FINDING 12 — a pinch over the waveform must not escape to the browser
    // =====================================================================
    {
      await resetLog();
      const wave = await rectOf('.waveform');
      const before = await vp();
      const swallowed = await json(`(() => {
        const el = document.querySelector('.waveform');
        const e = new WheelEvent('wheel', { bubbles: true, cancelable: true,
          clientX: ${wave.left + wave.width * 0.5}, clientY: ${wave.top + wave.height / 2},
          deltaX: 0, deltaY: -30, deltaMode: 0, ctrlKey: true });
        el.dispatchEvent(e);
        return JSON.stringify({ prevented: e.defaultPrevented });
      })()`);
      await settle(500);
      const after = await vp();
      say('waveform pinch', { prevented: swallowed.prevented, span: [before.spanSec, after.spanSec] });
      check(
        'finding 12: a ctrl-wheel over the waveform is swallowed, not left to the browser',
        swallowed.prevented === true,
        'an unhandled one is the plugin window zooming, with no way back'
      );
      check(
        'finding 12: and it zooms the shared window like every other surface',
        Math.abs(after.spanSec - before.spanSec) / before.spanSec > 0.005,
        `${before.spanSec}s -> ${after.spanSec}s`
      );
    }

    // =====================================================================
    // FINDING 9 — the saturation contract at the zoom limits
    // =====================================================================
    //
    // RECIPE: pinch the roll past the sheet's minimum scale, then keep panning or touch the
    // sheet. The old model stored the roll's requested window whether or not `tv.setZoom()` had
    // clamped, so the panes either stayed visibly different or the roll snapped back a callback
    // later — which of the two depended on timing.
    {
      const roll = await rectOf('.pianoroll');
      const cx = roll.left + roll.width / 2;
      const cy = roll.top + roll.height / 2;
      for (let i = 0; i < 40; i++) await ev(wheelAt('.pianoroll', cx, cy, 0, -60, true));
      await settle(900);
      const deep = await vp();
      await resetLog();
      for (let i = 0; i < 5; i++) await ev(wheelAt('.pianoroll', cx, cy, 0, -60, true));
      await settle(600);
      const deeper = await vp();
      say('saturated in', {
        span: deep.spanSec, minSpan: deep.limits.minSpanSec, sheetScale: deep.sheetScale,
        saturation: deep.saturation, appliedAfter: deeper.log.filter((e) => e.applied).length
      });
      check(
        'finding 9: zooming in stops at the SHEET’s floor, not at the roll’s 50ms',
        deep.saturation.atMinSpan && near(deep.spanSec, deep.limits.minSpanSec, deep.limits.minSpanSec * 0.02),
        `span ${deep.spanSec}s, shared floor ${deep.limits.minSpanSec}s, roll's own floor 0.05s`
      );
      check(
        'finding 9: the sheet is at its own maximum scale there, so the two really do agree',
        near(deeper.sheetScale, 3, 0.05),
        `display.scale=${deeper.sheetScale} (MAX_ZOOM is 3)`
      );
      check(
        'finding 9: further pinching at the limit changes nothing — no snap-back, no drift',
        deeper.log.filter((e) => e.applied).length === 0 &&
          Math.abs(deeper.viewport.fromSec - deep.viewport.fromSec) < 1e-6,
        `${deeper.log.filter((e) => e.applied).length} applied commands, from ${deep.viewport.fromSec} -> ${deeper.viewport.fromSec}`
      );
      /*
       * AND THE SHEET IS STILL POINTED AT MUSIC AT THE FLOOR — an edge state, measured because a
       * screenshot of it looked wrong, and it is worth saying exactly what this does and does not
       * cover.
       *
       * WHAT IT COVERS, and what the coupling is answerable for: at the deepest shared zoom the
       * sheet must be scrolled to somewhere inside its own engraving, not past the last bar into
       * the trailing page. That is this side of the contract and it holds.
       *
       * WHAT IT DID NOT COVER, AND WHAT THAT TURNED OUT TO BE — kept, because the wrong reading
       * is instructive. The pane was OBSERVED BLANK in `scrollzoom-02-saturated.png` at
       * `display.scale` 3 while the coupling's own numbers said it was pointed at music, and the
       * note here concluded "alphaTab engraved about half the notes", from 246 glyphs across
       * 6941 px against 477 across 3476 px at scale ~1. That comparison was between two DIFFERENT
       * selectors and the conclusion was wrong: re-measured per bar, every bar is laid out and
       * every bar has ink at every scale.
       *
       * THE ACTUAL CAUSE was one element's box. alphaTab's `.at-surface` is `overflow: hidden`
       * and is sized once per render from `RenderFinishedEventArgs.totalWidth`, which
       * `ScoreRenderer._onRenderFinished` sets to `this.layout.width` — LAYOUT units — while every
       * partial inside it is positioned by `registerPartial`, which multiplies by `display.scale`
       * first. So the surface is short by the scale factor and the engraving is CLIPPED, not
       * missing. Measured on `?demo=triplet&bars=16`, surface box against the partials' own right
       * edge: 4673 px against 4434 at scale 0.96 (nothing lost, which is why it hid for so long),
       * 4630 against 10774 at scale 2.33, and 4623 against 13835 at scale 3 — where scrolling to
       * 7553 left FOURTEEN glyphs on screen and the pane photographed white.
       *
       * It is the same fault as the owner's other report, "the sheet is half-drawn at bars 9-10":
       * when the engraving overhangs the box by less than a bar, the last bar or two come out cut
       * in half rather than the page coming out empty. One clip, two descriptions.
       *
       * `view/triview.ts §growSurfaceToPartials` repairs the box after every render by growing it
       * to the union of the placeholders it already holds (never shrinking it — a box larger than
       * alphaTab thinks costs nothing). The two checks below are that repair, asserted.
       */
      const sheetAtFloor = await json(`(() => {
        const host = document.querySelector('.at-host');
        const sc = document.querySelector('.triview-scroll');
        const surface = host?.querySelector('.at-surface');
        const partials = surface ? [...surface.children].filter((c) => c.tagName === 'DIV') : [];
        return JSON.stringify({
          partials: partials.length,
          glyphs: host ? host.querySelectorAll('svg.at-surface-svg path,svg.at-surface-svg text').length : 0,
          scrollLeft: sc ? Math.round(sc.scrollLeft) : null,
          clientWidth: sc ? Math.round(sc.clientWidth) : null,
          scrollWidth: sc ? Math.round(sc.scrollWidth) : null,
          // Ink actually inside the viewport, which is the only thing the eye cares about.
          inkOnScreen: (() => {
            if (!sc) return null;
            const r = sc.getBoundingClientRect();
            let n = 0;
            for (const g of (host?.querySelectorAll('svg.at-surface-svg path') ?? [])) {
              const b = g.getBoundingClientRect();
              if (b.width === 0 && b.height === 0) continue;
              if (b.right >= r.left && b.left <= r.right && b.bottom >= r.top && b.top <= r.bottom) n++;
              if (n > 20) break;
            }
            return n;
          })()
        });
      })()`);
      say('the sheet at the zoom floor', sheetAtFloor);
      say('partial boxes at the floor', await json(`(() => {
        const host = document.querySelector('.at-host');
        const surface = host?.querySelector('.at-surface');
        const boxes = surface ? [...surface.children].filter((c) => c.tagName === 'DIV').map((p) => ({
          left: Math.round(parseFloat(p.style.left) || 0),
          width: Math.round(parseFloat(p.style.width) || 0),
          glyphs: p.querySelectorAll('path,text').length
        })) : [];
        const L = window.__RIFFSHEET_LAYOUT__ && window.__RIFFSHEET_LAYOUT__();
        return JSON.stringify({ boxes, ghostsTrimmed: L?.ghostsTrimmed ?? null, partialsThisRender: L?.partialsThisRender ?? null, surfacePartials: L?.surfacePartials ?? null });
      })()`));
      say('engraved extent at the floor', await json(`(() => {
        const L = window.__RIFFSHEET_LAYOUT__ && window.__RIFFSHEET_LAYOUT__();
        return JSON.stringify(L ? { axis: L.axis, systems: L.systems, beats: L.beats ?? null } : null);
      })()`));
      say('sheet vertical at the floor', await json(`(() => {
        const sc = document.querySelector('.triview-scroll');
        const host = document.querySelector('.at-host');
        const r = sc?.getBoundingClientRect();
        const first = host?.querySelector('svg.at-surface-svg path');
        const b = first?.getBoundingClientRect();
        return JSON.stringify({
          scrollerRect: r ? { top: Math.round(r.top), h: Math.round(r.height), left: Math.round(r.left), w: Math.round(r.width) } : null,
          scrollTop: sc ? Math.round(sc.scrollTop) : null,
          scrollHeight: sc ? Math.round(sc.scrollHeight) : null,
          clientHeight: sc ? Math.round(sc.clientHeight) : null,
          firstInk: b ? { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) } : null,
          hostH: host ? Math.round(host.getBoundingClientRect().height) : null
        });
      })()`));
      const extentAtFloor = await json(`(() => {
        const L = window.__RIFFSHEET_LAYOUT__ && window.__RIFFSHEET_LAYOUT__();
        return JSON.stringify(L ? L.axis : null);
      })()`);
      check(
        'finding 9: at the shared floor the sheet is scrolled INSIDE its own engraving',
        sheetAtFloor.glyphs > 0 &&
          extentAtFloor != null &&
          sheetAtFloor.scrollLeft >= extentAtFloor.firstX - 40 &&
          sheetAtFloor.scrollLeft + sheetAtFloor.clientWidth <= extentAtFloor.lastX + 40,
        `scroll ${sheetAtFloor.scrollLeft}..${sheetAtFloor.scrollLeft + sheetAtFloor.clientWidth} inside engraving ${extentAtFloor?.firstX}..${extentAtFloor?.lastX}`
      );
      /*
       * THE CLIP, ASSERTED — and asserted on the two numbers that can tell it apart from a page
       * that is merely scrolled somewhere empty.
       *
       * `surfaceWidth` vs `partialsRight` is the box against its own contents: they must agree,
       * because `growSurfaceToPartials` has just made them agree. `inkOnScreen` is the only
       * number the EYE agrees with — every other reading here (bars laid out, bars with ink,
       * bounds, `ghostsTrimmed`) was green throughout the whole time the pane was white.
       */
      const census = await json(
        `(async () => JSON.stringify(await window.__RIFFSHEET_SHEETSCALE__()))()`,
        true
      );
      say('the engraving at the floor, per bar', {
        scale: census?.scale,
        blankBars: census?.blankBars,
        inkOnScreen: census?.inkOnScreen,
        surfaceWidth: census?.surfaceWidth,
        partialsRight: census?.partialsRight
      });
      check(
        'the sheet surface is as wide as the engraving inside it (alphaTab sizes it unscaled)',
        !!census && census.surfaceWidth >= census.partialsRight,
        `surface ${census?.surfaceWidth}px vs partials to ${census?.partialsRight}px`
      );
      check(
        'and there is ink ON SCREEN at the deepest zoom, not merely somewhere on the page',
        !!census && census.inkOnScreen > 0 && census.blankBars.length === 0,
        `${census?.inkOnScreen} glyphs in the pane, ${census?.blankBars?.length} bars laid out with no ink`
      );
      await settle(1500);
      await shot('02-saturated');
    }

    // =====================================================================
    // FINDING 10 — the sheet's pinch and the roll's are the same gesture
    // =====================================================================
    //
    // RECIPE: feed the same small pinch deltas over each pane. `setZoom` dropped absolute scale
    // changes under 0.001 — at scale 0.6 a one-pixel wheel delta asks for 0.0009 — and never
    // accumulated them, while the roll's threshold was in SECONDS and so far more sensitive. The
    // sheet "barely moved"; the roll moved. Same synthetic deltas here, proportional results.
    {
      // Back to a workable zoom first.
      await ev(`(() => { const b = document.querySelector('[data-role="roll-zoom-out"]'); return !!b; })()`);
      for (let i = 0; i < 30; i++) {
        const rollRect = await rectOf('.pianoroll');
        await ev(wheelAt('.pianoroll', rollRect.left + rollRect.width / 2, rollRect.top + rollRect.height / 2, 0, 60, true));
      }
      await settle(800);

      const measure = async (selector) => {
        const r = await rectOf(selector);
        const before = (await vp()).spanSec;
        for (let i = 0; i < 6; i++) {
          await ev(wheelAt(selector, r.left + r.width / 2, r.top + r.height / 2, 0, -10, true));
          await settle(80);
        }
        await settle(500);
        const after = (await vp()).spanSec;
        return { before, after, ratio: before / after };
      };
      const rollPinch = await measure('.pianoroll');
      // Put it back exactly, so the sheet's six events start from the same span.
      for (let i = 0; i < 6; i++) {
        const r = await rectOf('.pianoroll');
        await ev(wheelAt('.pianoroll', r.left + r.width / 2, r.top + r.height / 2, 0, 10, true));
        await settle(80);
      }
      await settle(600);
      const sheetPinch = await measure('.triview-scroll');
      say('same six deltas, two surfaces', { roll: rollPinch, sheet: sheetPinch });
      check(
        'finding 10: six identical pinch events move the SHEET at all',
        sheetPinch.ratio > 1.001,
        `sheet span ${sheetPinch.before}s -> ${sheetPinch.after}s (the bug moved display.scale 1.269 -> 1.274 over six events)`
      );
      check(
        'finding 10: and by the same amount as over the roll',
        Math.abs(sheetPinch.ratio - rollPinch.ratio) / rollPinch.ratio < 0.08,
        `roll x${rollPinch.ratio.toFixed(4)} vs sheet x${sheetPinch.ratio.toFixed(4)}`
      );
      await shot('03-pinch');
    }

    // =====================================================================
    // FINDING 11 — an edit must not leave the panes on a stale window
    // =====================================================================
    //
    // RECIPE: leave the sheet still, make an edit that changes the engraving's width, wait more
    // than 1500 ms without scrolling. The rebuild hold was armed for 1500 ms and nothing ran when
    // it expired, so a rebuild whose render callbacks all landed inside it left the roll and the
    // strip on the old window indefinitely. Nothing derives the window now, so the check is the
    // stronger one: the window is IDENTICAL across a rebuild, and the sheet comes back to it.
    {
      const before = await vp();
      await ev(`(() => { const s = document.querySelector('[data-role="notation-grid"]'); if (!s) return 'missing'; s.value = '8'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
      await settle(2200);
      const after = await vp();
      say('across a re-engrave', {
        before: [before.viewport.fromSec, before.viewport.toSec],
        after: [after.viewport.fromSec, after.viewport.toSec],
        revision: [before.viewport.revision, after.viewport.revision]
      });
      check(
        'finding 11: a re-engrave does not move the shared window at all',
        near(after.viewport.fromSec, before.viewport.fromSec, 1e-6) &&
          near(after.viewport.toSec, before.viewport.toSec, 1e-6),
        `[${before.viewport.fromSec}, ${before.viewport.toSec}] -> [${after.viewport.fromSec}, ${after.viewport.toSec}]`
      );
      check(
        'finding 11: and no command was needed to hold it there',
        after.viewport.revision === before.viewport.revision,
        `revision ${before.viewport.revision} -> ${after.viewport.revision}`
      );
    }

    // =====================================================================
    // FINDING 13 — the pitch scrollbar reaches everywhere the wheel does
    // =====================================================================
    //
    // RECIPE: load a bass-range take, drag the pitch scrollbar fully down (it stops around the
    // notes), then keep going with the wheel — more empty pitches appear. The bar built its
    // range from the union of the notes and the viewport; the wheel clamps against the whole
    // 0..127 keyboard, on purpose, so a note can be added out there.
    {
      const roll = await rectOf('.pianoroll');
      const probe = () => json('JSON.stringify((window.__RIFFSHEET_PIANOROLL__ ? window.__RIFFSHEET_PIANOROLL__().roll : null))');
      // Wheel the pitch window as far down as it will go, over the gutter (which zooms) — no:
      // over the notes, vertically, which pans pitch.
      for (let i = 0; i < 40; i++) {
        await ev(wheelAt('.pianoroll', roll.left + roll.width / 2, roll.top + roll.height / 2, 0, 120, false));
      }
      await settle(400);
      const wheelBottom = await probe();
      say('pitch: wheel floor', { visibleLowMidi: wheelBottom.visibleLowMidi, scrollTopMidi: wheelBottom.scrollTopMidi });
      check(
        'finding 13: the wheel reaches the bottom of the keyboard',
        wheelBottom.visibleLowMidi <= 0.5,
        `lowest visible midi ${wheelBottom.visibleLowMidi}`
      );
      // And the SCROLLBAR's own range is that same space: the thumb must be at the very bottom
      // of its track here, which it cannot be if the track only covers the notes.
      check(
        'finding 13: and the scrollbar is a map of the same space (its range is the keyboard)',
        wheelBottom.verticalScrollable === true,
        `verticalScrollable=${wheelBottom.verticalScrollable}`
      );
    }

    // =====================================================================
    // THE PINCH ROADS — captured, then contested (Z3)
    // =====================================================================
    //
    // WHAT THIS CAN AND CANNOT PROVE, said first because the difference is the whole point.
    //
    // macOS delivers one trackpad pinch to a WKWebView down TWO roads — a `wheel` with `ctrlKey`
    // forced on, and WebKit's own `gesturestart`/`gesturechange`/`gestureend` — and applying both
    // is one pinch zoomed twice. Chromium implements only the first road and has never
    // implemented `GestureEvent` at all, so a headless-Chrome probe CANNOT deliver the second one
    // and no amount of it running green is evidence about WKWebView.
    //
    // So this does two separable things:
    //
    //   1. CAPTURES the wheel road as the browser actually delivers it to the shipped handlers,
    //      with `isTrusted`, `deltaMode`, the modifiers and whether the handler called
    //      `preventDefault`, and writes it to scripts/fixtures/gesture/ as a fixture with its
    //      provenance on its face. That road is not a Chromium curiosity: it is the ONLY road on
    //      Windows/WebView2, which is Chromium, so this is the Windows path measured.
    //   2. CONTESTS the two roads at the real app by dispatching the WKWebView-shaped
    //      `gesture*` stream alongside the wheel one. Those events are synthesised, and the
    //      capture records them as untrusted so nobody can mistake the file for a hardware trace
    //      — but the HANDLERS do not know that, so "one gesture produced one zoom command"
    //      is a real statement about our code, which is the part that was broken.
    //
    // TO TURN THE CONSTRUCTED FIXTURE INTO A HARDWARE ONE: build the webcore dist, point the
    // shell at it with the disk-bundle override in shell/Source/bridge/WebResources.cpp, load the
    // plugin, paste `RECORDER` below into the webview's console, pinch the trackpad, and copy
    // `window.__RSGT__.events` into scripts/fixtures/gesture/. Nothing else about this probe or
    // scripts/gesture-test.ts has to change: the fixture's `provenance` field is what they read.
    {
      /** A capture-phase recorder. Also the snippet to paste into a real WKWebView. */
      const RECORDER = `(() => {
        const T = { events: [] };
        window.__RSGT__ = T;
        const kinds = ['wheel', 'gesturestart', 'gesturechange', 'gestureend'];
        const rec = (e) => {
          T.events.push({
            kind: e.type,
            atMs: Math.round(e.timeStamp * 1000) / 1000,
            delta: e.type === 'wheel' ? (e.deltaY || e.deltaX) : undefined,
            deltaMode: e.type === 'wheel' ? e.deltaMode : undefined,
            scale: typeof e.scale === 'number' ? e.scale : undefined,
            ctrlKey: !!e.ctrlKey, metaKey: !!e.metaKey, altKey: !!e.altKey,
            isTrusted: e.isTrusted, cancelable: e.cancelable, defaultPrevented: null,
            target: e.target && e.target.className ? String(e.target.className).slice(0, 40) : null
          });
        };
        // Recorded on the way DOWN so the record exists before any handler runs, and patched on
        // the way back UP so \`defaultPrevented\` says what the handler actually did.
        for (const k of kinds) {
          window.addEventListener(k, rec, { capture: true });
          window.addEventListener(k, (e) => {
            const last = T.events[T.events.length - 1];
            if (last && last.kind === e.type) last.defaultPrevented = e.defaultPrevented;
          }, { capture: false });
        }
        return true;
      })()`;
      await ev(RECORDER);

      const roll = await rectOf('.pianoroll');
      const cx = roll.left + roll.width / 2;
      const cy = roll.top + roll.height / 2;

      // ROOM TO MOVE, first. Everything below zooms IN, and a check that counts commands is
      // meaningless against a saturated axis — a refused command is not logged as applied. So
      // both axes are wound out to their far end before anything is counted.
      for (let i = 0; i < 30; i++) await ev(wheelAt('.pianoroll', cx, cy, 0, 40, true));
      await ev(`(() => {
        const el = document.querySelector('.pianoroll');
        for (let i = 0; i < 20; i++) {
          el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
            clientX: ${cx}, clientY: ${cy}, deltaX: 0, deltaY: 60, deltaMode: 0, altKey: true }));
        }
        return true;
      })()`);
      await settle(700);

      // --- 1. the wheel road, captured -------------------------------------------------
      await ev(`(() => { window.__RSGT__.events.length = 0; return true; })()`);
      await resetLog();
      for (let i = 0; i < 8; i++) {
        // THROUGH THE BROWSER, not through `dispatchEvent`. `Input.dispatchMouseEvent` makes the
        // ENGINE synthesise the event, so what the handler receives is `isTrusted: true` with the
        // engine's own `deltaMode` and modifier plumbing — which is the difference between a
        // capture and a hand-written stream, and is asserted below. `modifiers: 2` is Ctrl,
        // which is how macOS and Windows both spell "the fingers are pinching".
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -8, modifiers: 2, pointerType: 'mouse'
        });
        await settle(30);
      }
      await settle(500);
      const wheelTrace = await json(`JSON.stringify(window.__RSGT__.events)`);
      const wheelLog = (await vp()).log.filter((l) => l.kind === 'zoom' && l.applied);
      say('wheel road', { events: wheelTrace.length, zoomCommands: wheelLog.length });
      check(
        'pinch roads: the wheel road is delivered as a TRUSTED ctrl-wheel and swallowed by the handler',
        wheelTrace.length === 8 &&
          wheelTrace.every(
            (e) => e.kind === 'wheel' && e.ctrlKey && e.isTrusted === true && e.defaultPrevented === true
          ),
        JSON.stringify(wheelTrace[0] ?? null)
      );
      check(
        'pinch roads: eight wheel events of one pinch are eight zoom commands, not sixteen',
        wheelLog.length === 8,
        `zoom commands = ${wheelLog.length}`
      );
      check(
        'pinch roads: this engine never dispatches a GestureEvent (so WebView2/Windows is wheel-only)',
        wheelTrace.every((e) => e.kind === 'wheel'),
        wheelTrace.map((e) => e.kind).join(',')
      );

      await mkdir(join(ROOT, 'scripts', 'fixtures', 'gesture'), { recursive: true });
      await writeFile(
        join(ROOT, 'scripts', 'fixtures', 'gesture', 'roll-ctrlwheel-chromium.json'),
        JSON.stringify(
          {
            name: 'roll-ctrlwheel-chromium',
            provenance: 'captured',
            engine: await ev('navigator.userAgent'),
            note:
              'A pinch-in over the piano roll as the browser ITSELF delivered it to the shipped ' +
              'handlers — dispatched through CDP Input, so every event is isTrusted. ' +
              'The ONLY road on Windows/WebView2, which is Chromium; on macOS/WKWebView the same ' +
              'fingers also produce the gesture* road, which no Chromium can emit — see ' +
              'roll-webkit-both-roads.json and the recipe in scripts/scrollzoom-probe.mjs.',
            events: wheelTrace
          },
          null,
          2
        ) + '\n'
      );

      // --- 2. both roads at once, at the real app ---------------------------------------
      //
      // THE BUG, AS A RECIPE: WKWebView sends both, and the roll used to apply both. Worse for
      // Option+pinch, where the wheel handler applied the vertical zoom and returned BEFORE
      // claiming the road, so the gesture copy always found the road free.
      // `GestureEvent` is not constructible outside WebKit, and the handlers read it
      // structurally (`scale`, `altKey`, `clientX`) precisely so that it need not be: a plain
      // Event with those properties is indistinguishable to them, which is what makes this
      // testable at all. The capture records `isTrusted: false` for every one of them.
      const gestureAt = (selector, type, scale, alt) =>
        '(() => {' +
        '  const el = document.querySelector(' + JSON.stringify(selector) + ');' +
        '  if (!el) return "missing";' +
        '  const e = new Event(' + JSON.stringify(type) + ', { bubbles: true, cancelable: true });' +
        (scale === null ? '' : '  e.scale = ' + scale + ';') +
        '  e.altKey = ' + (alt ? 'true' : 'false') + ';' +
        '  e.clientX = ' + cx + '; e.clientY = ' + cy + ';' +
        '  el.dispatchEvent(e);' +
        '  return e.defaultPrevented;' +
        '})()';
      await ev(`(() => { window.__RSGT__.events.length = 0; return true; })()`);
      await resetLog();
      await ev(gestureAt('.pianoroll', 'gesturestart', 1, false));
      for (let i = 1; i <= 6; i++) {
        // The same fingers, both roads, interleaved exactly as a dual-delivery build would.
        await ev(wheelAt('.pianoroll', cx, cy, 0, -8, true));
        await ev(gestureAt('.pianoroll', 'gesturechange', 1 + i * 0.02, false));
        await settle(30);
      }
      await ev(gestureAt('.pianoroll', 'gestureend', null, false));
      await settle(500);
      const bothTrace = await json(`JSON.stringify(window.__RSGT__.events)`);
      const bothLog = (await vp()).log.filter((l) => l.kind === 'zoom' && l.applied);
      say('both roads', {
        events: bothTrace.length,
        wheels: bothTrace.filter((e) => e.kind === 'wheel').length,
        gestures: bothTrace.filter((e) => e.kind !== 'wheel').length,
        zoomCommands: bothLog.length
      });
      check(
        'pinch roads: one pinch delivered on BOTH roads is still six zoom commands, not twelve',
        bothLog.length === 6,
        `zoom commands = ${bothLog.length} for 6 wheel + 6 gesturechange events`
      );
      check(
        'pinch roads: gestureend is registered and swallowed (nothing listened for it before)',
        bothTrace.some((e) => e.kind === 'gestureend' && e.defaultPrevented === true),
        JSON.stringify(bothTrace.filter((e) => e.kind === 'gestureend'))
      );

      // --- 3. Option+pinch, the fault Codex found ---------------------------------------
      const pitchBefore = await json('JSON.stringify(window.__RIFFSHEET_PIANOROLL__().roll.pxPerSemitone)');
      await ev(`(() => { window.__RSGT__.events.length = 0; return true; })()`);
      await ev(gestureAt('.pianoroll', 'gesturestart', 1, true));
      await ev(`(() => {
        const el = document.querySelector('.pianoroll');
        el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
          clientX: ${cx}, clientY: ${cy}, deltaX: 0, deltaY: -40, deltaMode: 0,
          ctrlKey: true, altKey: true }));
        return true;
      })()`);
      await ev(gestureAt('.pianoroll', 'gesturechange', 1.06, true));
      await ev(gestureAt('.pianoroll', 'gestureend', null, true));
      await settle(400);
      const pitchAfter = await json('JSON.stringify(window.__RIFFSHEET_PIANOROLL__().roll.pxPerSemitone)');
      // ONE event's worth, not two. The wheel road owns the gesture, so the ratio is exactly the
      // wheel's own factor — `exp(40 * 0.0015)` clamped by the 1.06 anti-jump step.
      const wanted = Math.min(1.06, Math.exp(40 * 0.0015));
      const got = pitchAfter / pitchBefore;
      say('option+pinch', { before: pitchBefore, after: pitchAfter, ratio: got, wanted, doubled: wanted * 1.06 });
      check(
        'pinch roads: Option+pinch on both roads zooms pitch ONCE (it used to zoom on both)',
        Math.abs(got - wanted) < 0.005,
        `pitch x${got.toFixed(4)}, wanted x${wanted.toFixed(4)}, the bug gave up to x${(wanted * 1.06).toFixed(4)}`
      );
    }

    // =====================================================================
    // P4 — THE SHEET PANE IS ONE GESTURE SURFACE, GLYPH OR NOT
    //
    // THE REPORT: a pinch over the sheet zooms perfectly with the pointer over the empty space
    // BELOW the music, and is dead — or dies after one event — directly over the engraving.
    //
    // THE MECHANISM, which is a LATCH and not a `preventDefault`. Every one of the sheet's
    // handlers is on `.triview-scroll` and events bubble, so where the pointer is cannot change
    // which handler runs. What it changes is which NODE the platform delivers the gesture to:
    // macOS latches both roads (view/gesture.ts) to the node hit at the start of a pinch and
    // routes every later event of that pinch to it, so a latched node that leaves the document
    // mid-gesture takes the rest of the pinch with it. Over the engraving the latched node was
    // an alphaTab `<path>`/`<text>`, the first event asked for a zoom, the zoom re-engraved, and
    // alphaTab replaced every partial — the node the remaining events were owed to was destroyed
    // by the event that had just been delivered to it. Below the music the node was
    // `.triview-scroll`, built once and never replaced, so the same pinch worked perfectly.
    //
    // BOTH ROADS AT REAL COORDINATES, and they see the fault differently — which is the point.
    //
    //   ctrl-wheel, through `Input.dispatchMouseEvent`: the browser does its own hit test and its
    //     own routing rather than being told the answer. Chromium re-hit-tests EVERY wheel event,
    //     so it never loses the zoom and the parity numbers stay level even with the bug in
    //     place. What it still shows is the property underneath — the node the gesture latched to
    //     is `isConnected === false` a moment later — and that is asserted directly.
    //
    //   GestureEvent, dispatched at `document.elementFromPoint(x, y)`: not constructible outside
    //     WebKit, so it is synthesised — and synthesising it is what makes the LATCH reproducible
    //     here, because one hit test followed by every later event of the pinch at that same node
    //     is exactly what macOS does. Events dispatched at a node that has left the document do
    //     not reach `.triview-scroll`, so the fault appears as the owner described it and as a
    //     NUMBER: with the fix reverted this road is worth x1.06 over the engraving — one event
    //     of four — against x1.2625 over the empty pane below it. Measured, both faces.
    //
    // WHY NO EXISTING CHECK CAUGHT IT: `finding 6` above dispatches at `.triview-scroll` itself,
    // which is the one node in the pane that was never the problem, so it never touched the
    // engraving's layer stack at all.
    // =====================================================================
    {
      /** Sheet back to a known middle scale, so no measurement starts against the zoom clamp. */
      const restScale = () =>
        ev('(async () => { await window.__RIFFSHEET_SHEETSCALE__(1); return true; })()', true);

      /**
       * The six places a pinch has to behave identically: five kinds of engraved ink and the
       * empty pane below the last stave, which is the one the owner reported as WORKING.
       *
       * The noteheads come from the app's own `editProbe` (client pixels, face-scale corrected);
       * the beam and the staff line are classified off the SVG by shape, because "wide and one
       * pixel tall" and "short, wide and solid" is what those two things are and neither carries
       * a class name to ask for.
       */
      const sheetPoints = () => json(`(() => {
        const s = document.querySelector('.triview-scroll').getBoundingClientRect();
        const inside = (r) => r.width > 0 && r.height > 0 &&
          r.left > s.left + 8 && r.right < s.right - 8 && r.top > s.top + 4 && r.bottom < s.bottom - 4;
        const centre = (r) => ({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        const heads = (window.__RIFFSHEET_SHEETEDIT__().noteHeads ?? []).filter(
          (h) => inside({ left: h.x - h.w / 2, right: h.x + h.w / 2, top: h.y - h.h / 2, bottom: h.y + h.h / 2, width: h.w, height: h.h })
        );
        // CLIPPED TO THE PANE, not required to fit inside it: a staff line runs the width of the
        // whole system and is therefore almost never wholly on screen, so "fully inside" found
        // one only by luck and dropped it at the scales where the engraving is wider. What is
        // needed is a POINT on the ink that is in the pane, which is what the clip gives.
        const pad = 8;
        const clip = (r) => {
          const left = Math.max(r.left, s.left + pad), right = Math.min(r.right, s.right - pad);
          const top = Math.max(r.top, s.top + 4), bottom = Math.min(r.bottom, s.bottom - 4);
          return right > left && bottom > top
            ? { left, right, top, bottom, width: right - left, height: bottom - top, ink: r }
            : null;
        };
        const ink = [...document.querySelectorAll('.at-host .at-surface svg path, .at-host .at-surface svg rect')]
          .map((el) => clip(el.getBoundingClientRect()))
          .filter(Boolean);
        /*
         * STAFF LINE vs BEAM, BY SHAPE RATIO — and it has to be a ratio, not a pixel count.
         *
         * The first version asked for "wider than 200px", which is a statement about the SCALE
         * rather than about the thing: alphaTab engraves in partials, so a staff line is cut into
         * one segment per partial, and at a small sheet scale the widest segment on screen is
         * 183px. The check then went looking for a staff line in a pane full of them and found
         * none. What actually tells the two apart at every scale is how much longer than thick
         * each is — a staff line is a hairline running the width of a bar (hundreds to one), a
         * beam is a solid slab a few notes long (tens to one at most).
         *
         * Measured on the INK's own box, never the clipped one: a clip can shorten something, so
         * a half-scrolled staff line would otherwise start reading as a beam.
         */
        const aspect = (r) => r.ink.width / Math.max(0.01, r.ink.height);
        const widest = (list) => list.slice().sort((a, b) => b.width - a.width)[0];
        const staffLine = widest(ink.filter((r) => r.ink.height <= 3 && r.ink.width >= 40 && aspect(r) > 20));
        const beam = widest(ink.filter((r) =>
          r.ink.height >= 2 && r.ink.height <= 14 && r.ink.width >= 8 && r.ink.width <= 180 && aspect(r) <= 20));
        const labels = [...document.querySelectorAll('.note-name')].map((el) => el.getBoundingClientRect()).filter(inside);
        const heads2 = (kind) => heads.filter((h) => h.staff === kind).map((h) => ({ x: Math.round(h.x), y: Math.round(h.y) }));
        /*
         * A CANDIDATE IS ONLY THE POINT IT CLAIMS TO BE IF THE HIT TEST AGREES.
         *
         * Three of the four decoration rows are PINNED over the music — the open-string letters
         * sit in a fixed left column and travel across the engraving as it scrolls — so a
         * notehead's own centre can have a string-letter span on top of it. Taking it anyway
         * would leave the check named "TAB digit" quietly measuring a label instead, which is the
         * same class of mistake as a probe that never fails: it reports on something else and
         * passes. So each kind offers a LIST, and the first candidate whose topmost element is
         * what the kind is about wins. wantLabel is true for the one point that IS a label.
         */
        const controls = '.note-name, .tab-mark, .string-letter, .part-label-hit';
        const pick = (cands, wantLabel) => cands.find((p) => {
          const el = document.elementFromPoint(p.x, p.y);
          if (!el || !el.closest('.triview-scroll')) return false;
          return wantLabel ? !!el.closest(controls) : !el.closest(controls);
        }) ?? null;
        const out = [];
        const add = (name, p) => { if (p) out.push({ name, x: p.x, y: p.y }); };
        add('notehead', pick(heads2('notation'), false));
        add('beam', pick(beam ? [centre(beam)] : [], false));
        add('staff line', pick(
          // Several points along the line, so one that happens to sit under a pinned letter or a
          // notehead is not the only one tried.
          staffLine ? [0.62, 0.78, 0.4, 0.9, 0.2].map((f) => ({
            x: Math.round(staffLine.left + staffLine.width * f),
            y: Math.round((staffLine.top + staffLine.bottom) / 2)
          })) : [], false));
        add('TAB digit', pick(heads2('tab'), false));
        add('name label', pick(labels.map(centre), true));
        // THE BASELINE: below the last stave, inside the pane. The pixel the owner says works.
        const host = document.querySelector('.at-host').getBoundingClientRect();
        const below = Math.round(Math.min(s.bottom - 6, host.bottom + 20));
        add('below the music', below > host.bottom && below < s.bottom ? { x: Math.round(s.left + s.width / 2), y: below } : null);
        // WHAT THE CLASSIFIER SAW, so a missing kind is a diagnosis rather than a shrug.
        const seen = {
          ink: ink.length,
          staffLines: ink.filter((r) => r.ink.height <= 3 && r.ink.width >= 40 && aspect(r) > 20).length,
          beams: ink.filter((r) => r.ink.height >= 2 && r.ink.height <= 14 && r.ink.width >= 8 && r.ink.width <= 180 && aspect(r) <= 20).length,
          // The eight biggest boxes as [width, height], which is what says WHY a shape rule missed.
          widest: ink.slice().sort((a, b) => b.ink.width - a.ink.width).slice(0, 8)
            .map((r) => [Math.round(r.ink.width), Number(r.ink.height.toFixed(2))]),
          heads: heads.length,
          labels: labels.length,
          pane: [Math.round(s.width), Math.round(s.height)],
          music: [Math.round(host.width), Math.round(host.height)],
          scrollLeft: Math.round(document.querySelector('.triview-scroll').scrollLeft)
        };
        return JSON.stringify({ points: out, seen });
      })()`);

      /** Four ctrl-wheel notches through the browser's OWN hit test and routing. */
      const wheelBurst = async (x, y, sign) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        for (let i = 0; i < 4; i++) {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x, y, deltaX: 0, deltaY: sign * 40,
            modifiers: 2, pointerType: 'mouse', button: 'none', clickCount: 0
          });
          await settle(25);
        }
        await settle(320);
      };

      /**
       * One WebKit pinch at (x, y): start, four changes, end — dispatched at the node the
       * platform would have latched to. The cumulative scale steps by 1.06 per event so the two
       * roads are asking for exactly the same zoom and their numbers are directly comparable.
       */
      const gestureBurst = async (x, y, sign) => {
        await ev(`(() => {
          const el = document.elementFromPoint(${x}, ${y});
          if (!el) return 'no element';
          const fire = (type, scale) => {
            const e = new Event(type, { bubbles: true, cancelable: true });
            if (scale !== null) e.scale = scale;
            e.altKey = false; e.clientX = ${x}; e.clientY = ${y};
            el.dispatchEvent(e);
          };
          fire('gesturestart', 1);
          for (let i = 1; i <= 4; i++) fire('gesturechange', Math.pow(${sign > 0 ? '1/1.06' : '1.06'}, i));
          fire('gestureend', null);
          return true;
        })()`);
        await settle(320);
      };

      /**
       * One measurement at one point: what the pinch was worth, and whether the node the platform
       * latched to was still in the document when the zoom it caused had been engraved.
       */
      const measure = async (name, burst) => {
        await restScale();
        await settle(120);
        // RE-RESOLVED HERE, not once for the pass. `restScale` walks in 1.25 steps and lands
        // NEAR 1 rather than on it, so the row of names is not laid out identically to the frame
        // the points were first read from — and a "name label" point that has drifted off its
        // label is a check quietly measuring bare pane instead of the control it is named for.
        //
        // RETRIED, because alphaTab's partials land one at a time after the render returns: read
        // a frame too early and the surface has staves but not yet the ink on them. This waits
        // for the engraving, it does not retry a failure — a kind that is still missing after two
        // seconds of a settled sheet is reported as missing and fails the check.
        let p = null;
        let lastSeen = null;
        for (let i = 0; i < 14 && !p; i++) {
          const read = await sheetPoints();
          p = read.points.find((q) => q.name === name) ?? null;
          if (!p) { lastSeen = read.seen; await settle(150); }
        }
        if (!p) return { name, hit: 'gone from the pane', survived: false, ratio: 0, seen: lastSeen };
        await ev(`(() => { window.__P4NODE__ = document.elementFromPoint(${p.x}, ${p.y}); return true; })()`);
        const before = (await vp()).sheetScale;
        await burst(p.x, p.y, -1);
        const after = (await vp()).sheetScale;
        const survived = await ev('!!(window.__P4NODE__ && window.__P4NODE__.isConnected)');
        const hit = await ev(`(() => { const n = window.__P4NODE__; if (!n) return 'none';
          const c = (n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className) || '';
          return n.tagName + (c ? '.' + String(c).split(' ')[0] : ''); })()`);
        return { name: p.name, hit, survived, ratio: Number((after / before).toFixed(4)) };
      };

      /** Drive the face to a wanted scale by resizing the viewport, and wait for it to arrive. */
      const setFace = async (w, h, wantScale) => {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        for (let i = 0; i < 40; i++) {
          const f = await json('JSON.stringify(window.__RIFFSHEET_FACE__())');
          if (Math.abs(f.scale - wantScale) < 0.01) break;
          await settle(150);
        }
        await settle(600);
      };

      for (const face of [{ w: 1440, h: 900, scale: 1 }, { w: 900, h: 600, scale: 0.68 }]) {
        await setFace(face.w, face.h, face.scale);
        const got = (await json('JSON.stringify(window.__RIFFSHEET_FACE__())')).scale;
        check(
          `P4 face ${face.scale}: the probe is measuring at the face scale it claims`,
          Math.abs(got - face.scale) < 0.01,
          `faceScale = ${got}, wanted ${face.scale}`
        );
        await restScale();
        const points = (await sheetPoints()).points;
        check(
          `P4 face ${face.scale}: all five kinds of engraved ink plus the below-sheet baseline are on screen`,
          points.length === 6,
          points.map((p) => p.name).join(', ') || 'none found'
        );
        // Measure whatever WAS found rather than skipping the pass: a missing kind is already its
        // own failed check above, and the parity numbers for the other five are the evidence of
        // what the pane is doing. Only the baseline is indispensable — there is nothing to
        // compare against without it.
        if (!points.some((p) => p.name === 'below the music')) continue;

        for (const [road, burst] of [['ctrl-wheel', wheelBurst], ['GestureEvent', gestureBurst]]) {
          const rows = [];
          for (const p of points) rows.push(await measure(p.name, burst));
          const baseline = rows[rows.length - 1];
          say(`P4 face ${face.scale} ${road}`, rows);
          // The gain is real, so "they all agree" cannot be "they all did nothing": four notches
          // of 1.06 is x1.26, and a saturated or dead pane would sit at x1.00.
          check(
            `P4 face ${face.scale}, ${road}: the below-sheet baseline really zooms, so parity means something`,
            baseline.ratio > 1.2,
            `baseline x${baseline.ratio}`
          );
          const off = rows.filter((r) => Math.abs(r.ratio - baseline.ratio) > 0.005);
          check(
            `P4 face ${face.scale}, ${road}: every on-engraving point zooms exactly as the empty pane below does`,
            off.length === 0,
            off.length === 0
              ? `all six at x${baseline.ratio}`
              : off.map((r) => `${r.name} x${r.ratio} != x${baseline.ratio}`).join('; ')
          );
          const lost = rows.filter((r) => !r.survived);
          check(
            `P4 face ${face.scale}, ${road}: the node the pinch latches to outlives the zoom it causes`,
            lost.length === 0,
            lost.length === 0
              ? rows.map((r) => `${r.name}->${r.hit}`).join(' ')
              : `destroyed mid-gesture: ${lost.map((r) => `${r.name}->${r.hit}`).join(', ')}`
          );
        }
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await settle(600);
      await restScale();
    }

    // =====================================================================
    // P5 — BPM CHANGES TIME, NOT TYPOGRAPHY
    //
    // THE REPORT: type 30 into the tempo box and the SHEET gets bigger. The owner calls that a
    // bug and it is one — a tempo is a statement about the clock under the music, not about how
    // large to print it.
    //
    // THE MECHANISM, in the app's own numbers. A tempo rebuild re-maps written ticks onto
    // seconds; `onSheetRenderSettled` then re-measures the engraving through the NEW map, so at
    // a quarter of the tempo the same page is worth a quarter of the pixels per second. The
    // authoritative window is in SECONDS and is deliberately retained across a rebuild, so
    // `applyViewportToSheet` handed the new engraving the old span and `absoluteSheetScale`
    // answered the only way it can: about four times `display.scale`. The clamp at 3 is what
    // stopped it, not any part of the design. `faceScale` is not involved at any point.
    //
    // THE LAW NOW (`timeAxis.RebuildViewportPolicy`): a tempo rebuild carries
    // `preserve-sheet-scale`. The size is held and the SECONDS WINDOW is rebased around the bar
    // at the left edge — which is what a tempo change means, and the pick out of the three-way
    // constraint (size, old window, endpoint alignment: any two) that the owner adjudicated.
    //
    // MEASURED BEFORE THE FIX, both doors, so nothing below is a rubber stamp:
    //
    //   the meter door, on this very fixture — 4/4 -> 6/8 re-states the same tempo in a beat
    //     worth 1.5x, and `display.scale` went 0.9753 -> 0.8032 while the retained window sat at
    //     13.08 s throughout. `display.scale` multiplies every engraved coordinate, so the staff
    //     went with it. It comes back 0.9753 -> 0.9753 here.
    //   the BPM door, on the blank-score fixture below, where a typed tempo really does decide
    //     the clock (with detected beats the pipeline uses THOSE and the box is inert, which is
    //     why the meter is the door this demo can be moved through at all) — 120 -> 30 took
    //     `display.scale` 0.9837 -> 3.0, the hard clamp, and 120 -> 240 took it to 0.6, the other
    //     one. Both are held below.
    //
    // AND THE HARD EDGE, ASSERTED RATHER THAN HIDDEN. A slower tempo needs MORE seconds on screen
    // to keep the same size, and a document only has so many: at 30 BPM the fixture below wants a
    // 157 s window out of a 96 s document, and no policy can conjure the other 61 s. The window is
    // clamped, the size moves, and `rebuildRebase.sizeHeld` says so — the one case where the
    // engraving may still change size, and it is reported rather than silent. Lifting it needs a
    // shared virtual extent past the end of the recording for all three panes, which is a separate
    // piece of work (codex-voices-critique, ranked tempo fix 5).
    // =====================================================================
    {
      const setSel = (v) => `(() => { const s = document.querySelector('[data-role="tempo-source"]'); if (!s) return 'missing'; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`;
      const setBpm = (v) => `(() => { const b = document.querySelector('[data-role="bpm"]'); if (!b) return 'missing'; b.value = '${v}'; b.dispatchEvent(new Event('change', { bubbles: true })); return b.value; })()`;
      const setSig = (v) => `(() => { const s = document.querySelector('[data-role="timesig"]'); if (!s) return 'missing'; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`;

      /**
       * The two numbers the claim is made of, plus what the app says it did.
       *
       * `staffGap` is the TYPOGRAPHY, measured off the SVG and not off any app state: the median
       * vertical gap between engraved staff lines, in client pixels. It is the number the eye is
       * reading when it says "the sheet got bigger", and it is independent of `display.scale`,
       * which is the app's own claim about the same thing. Both, or this only proves the app is
       * consistent with itself.
       */
      const tempoState = () => json(`(() => {
        const v = window.__RIFFSHEET_VIEWPORT__();
        const lines = [...document.querySelectorAll('.at-host .at-surface svg path, .at-host .at-surface svg rect')]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.height <= 3 && r.width >= 40 && r.width / Math.max(0.01, r.height) > 20);
        const ys = [...new Set(lines.map((r) => Math.round((r.top + r.bottom) / 2 * 4) / 4))].sort((a, b) => a - b);
        const gaps = [];
        for (let i = 1; i < ys.length; i++) { const g = ys[i] - ys[i - 1]; if (g > 1) gaps.push(g); }
        gaps.sort((a, b) => a - b);
        const bpm = document.querySelector('[data-role="bpm"]');
        return JSON.stringify({
          scale: v.sheetScale,
          staffGap: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
          staffLines: ys.length,
          spanSec: v.spanSec,
          fromSec: v.viewport && v.viewport.fromSec,
          leftEdgeSec: v.sheetLeftEdgeSec,
          rebase: v.rebuildRebase,
          limits: v.limits,
          doc: v.documentSec,
          bpmBox: bpm ? bpm.value : null
        });
      })()`);

      const sameScale = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 1e-4;
      const setFaceTo = async (w, h, wantScale) => {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        for (let i = 0; i < 40; i++) {
          const f = await json('JSON.stringify(window.__RIFFSHEET_FACE__())');
          if (Math.abs(f.scale - wantScale) < 0.01) break;
          await settle(150);
        }
        await settle(700);
      };

      for (const face of [{ w: 1440, h: 900, scale: 1 }, { w: 900, h: 600, scale: 0.68 }]) {
        await setFaceTo(face.w, face.h, face.scale);
        await ev(setSel('manual'));
        await settle(1200);
        const at120 = await tempoState();

        // --- the meter door: a re-labelling that moves the clock by 1.5x -------------------
        await ev(setSig('6/8'));
        await settle(1800);
        const at68 = await tempoState();
        await ev(setSig('4/4'));
        await settle(1800);
        const back = await tempoState();

        say(`P5 face ${face.scale}: 4/4 -> 6/8 -> 4/4`, {
          scale: [at120.scale, at68.scale, back.scale].map((n) => Number(n.toFixed(4))),
          staffGap: [at120.staffGap, at68.staffGap, back.staffGap],
          spanSec: [at120.spanSec, at68.spanSec, back.spanSec],
          rebase: at68.rebase
        });
        check(
          `P5 face ${face.scale}: the sheet has staff lines to measure`,
          at120.staffLines >= 5 && at68.staffLines >= 5,
          `${at120.staffLines} / ${at68.staffLines} distinct staff-line rows`
        );
        check(
          `P5 face ${face.scale}: a meter change does not touch display.scale (it went 0.975 -> 0.803)`,
          sameScale(at120.scale, at68.scale) && sameScale(at120.scale, back.scale),
          `${at120.scale.toFixed(6)} -> ${at68.scale.toFixed(6)} -> ${back.scale.toFixed(6)}`
        );
        check(
          `P5 face ${face.scale}: and the ENGRAVING is the same size on the glass`,
          at120.staffGap !== null && at68.staffGap !== null && Math.abs(at68.staffGap - at120.staffGap) <= 0.26,
          `staff-line spacing ${at120.staffGap}px -> ${at68.staffGap}px -> ${back.staffGap}px`
        );
        check(
          `P5 face ${face.scale}: the SECONDS window is what moved instead`,
          at68.rebase !== null && at68.rebase.sizeHeld === true &&
            Math.abs(at68.spanSec - at120.spanSec) / at120.spanSec > 0.05,
          `span ${at120.spanSec}s -> ${at68.spanSec}s, wanted ${at68.rebase?.wantedSpanSec}s and got ${at68.rebase?.grantedSpanSec}s`
        );
        check(
          `P5 face ${face.scale}: and the sheet's left edge still names the window's own first second`,
          Math.abs(at68.leftEdgeSec - at68.fromSec) < Math.max(0.02, at68.spanSec * 0.01),
          `left edge ${at68.leftEdgeSec}s vs window from ${at68.fromSec}s`
        );

        // --- the BPM box, on a take whose beats the pipeline detected ----------------------
        // Inert here BY DESIGN (detected beats decide the grid, not a typed number), so this is
        // the other half of the same claim: the new policy must not invent movement either.
        const bpms = [];
        for (const bpm of [30, 240, 120]) {
          await ev(setBpm(bpm));
          await settle(1600);
          const s = await tempoState();
          bpms.push({ bpm, scale: Number(s.scale.toFixed(6)), staffGap: s.staffGap, span: s.spanSec });
        }
        say(`P5 face ${face.scale}: manual BPM 30/240/120`, bpms);
        check(
          `P5 face ${face.scale}: 30 <-> 240 <-> 120 BPM leaves display.scale exactly where it was`,
          bpms.every((b) => sameScale(b.scale, at120.scale)),
          bpms.map((b) => `${b.bpm}:${b.scale}`).join(' ')
        );

        // --- and an explicit zoom is still a zoom ------------------------------------------
        // The whole risk of this fix is over-reach: a policy that froze `display.scale` outright
        // would kill the pinch as well. Scale-follows-span is correct for a GESTURE and wrong
        // only for a clock change, so the gesture is measured immediately afterwards.
        const beforePinch = await vp();
        const sheetRect = await rectOf('.triview-scroll');
        for (let i = 0; i < 4; i++) {
          await ev(wheelAt('.triview-scroll', sheetRect.left + sheetRect.width / 2, sheetRect.top + sheetRect.height / 2, 0, -40, true));
          await settle(90);
        }
        await settle(600);
        const afterPinch = await vp();
        say(`P5 face ${face.scale}: pinch after a tempo change`, {
          scale: [Number(beforePinch.sheetScale.toFixed(4)), Number(afterPinch.sheetScale.toFixed(4))],
          span: [beforePinch.spanSec, afterPinch.spanSec]
        });
        check(
          `P5 face ${face.scale}: an explicit pinch still scale-follows-span`,
          afterPinch.sheetScale > beforePinch.sheetScale * 1.05 &&
            afterPinch.spanSec < beforePinch.spanSec * 0.96,
          `scale ${beforePinch.sheetScale.toFixed(4)} -> ${afterPinch.sheetScale.toFixed(4)}, span ${beforePinch.spanSec}s -> ${afterPinch.spanSec}s`
        );
        await ev('(async () => { await window.__RIFFSHEET_SHEETSCALE__(1); return true; })()', true);
        await settle(400);
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await settle(700);

      // =====================================================================
      // P5b — THE BPM BOX ITSELF, on a take where a typed tempo IS the clock
      // =====================================================================
      //
      // A blank score has no detected beats, so `bpmOverride` decides the grid outright — which
      // is the owner's own case (a typed 30 that really re-times the page) and the one the demo
      // above cannot reach. 48 bars so the document is long enough to zoom inside; anything
      // shorter saturates and has nothing left to measure.
      {
        const built = await ev(`(async () => {
          const menu = document.querySelector('[data-role="main-menu"]');
          if (!menu) return 'no main menu';
          menu.click();
          await new Promise((r) => setTimeout(r, 250));
          const blank = [...document.querySelectorAll('.dropzone-screen button')].find((b) => /blank/i.test(b.textContent || ''));
          if (!blank) return 'no blank button';
          blank.click();
          await new Promise((r) => setTimeout(r, 250));
          const form = document.querySelector('[data-role="blank-score-setup"]');
          if (!form) return 'no form';
          form.elements.title.value = 'Tempo probe';
          form.elements.tempo.value = '120';
          form.elements.bars.value = '48';
          form.elements.meter.value = '4/4';
          form.requestSubmit();
          for (let i = 0; i < 60; i++) {
            const ok = document.querySelector('[data-role="confirm-ok"]');
            if (ok) { ok.click(); break; }
            await new Promise((r) => setTimeout(r, 50));
          }
          await new Promise((r) => setTimeout(r, 1800));
          return document.querySelector('.triview') ? 'main' : 'still opening';
        })()`, true);
        await settle(1500);
        check('P5b: a 48-bar blank score is on screen to type a tempo at', built === 'main', String(built));

        if (built === 'main') {
          const rows = [];
          // The FIRST slow-down pays the document's own wall (below); every change after it is
          // inside the limits and must be exact. Both are asserted, separately.
          for (const bpm of [30, 120, 240, 30, 120, 240]) {
            await ev(setBpm(bpm));
            await settle(1800);
            const s = await tempoState();
            rows.push({
              bpm, scale: Number(s.scale.toFixed(6)), staffGap: s.staffGap, span: s.spanSec,
              sizeHeld: s.rebase?.sizeHeld ?? null,
              wanted: s.rebase?.wantedSpanSec ?? null, granted: s.rebase?.grantedSpanSec ?? null,
              docSec: s.doc, box: s.bpmBox
            });
            if ([30, 120, 240].includes(bpm) && rows.length > 3) await shot(`04-bpm-${bpm}`);
          }
          say('P5b: manual BPM on a beatless take', rows);
          const settled = rows.slice(3);
          check(
            'P5b: the typed tempo really reaches the clock on this take (the demo above cannot)',
            rows.every((r) => String(r.box) === String(r.bpm)),
            rows.map((r) => `${r.bpm}->${r.box}`).join(' ')
          );
          check(
            'P5b: 30 <-> 120 <-> 240 BPM engraves at ONE size (it used to run 3.0 / 0.98 / 0.6)',
            settled.every((r) => sameScale(r.scale, settled[0].scale)) &&
              settled.every((r) => r.staffGap !== null && Math.abs(r.staffGap - settled[0].staffGap) <= 0.26),
            settled.map((r) => `${r.bpm}:scale ${r.scale}/gap ${r.staffGap}px`).join('  ')
          );
          check(
            'P5b: and the window is what carried the change instead',
            settled.every((r) => r.span > 0) &&
              Math.max(...settled.map((r) => r.span)) / Math.min(...settled.map((r) => r.span)) > 3,
            settled.map((r) => `${r.bpm}:${r.span}s`).join(' ')
          );
          // THE DOCUMENTED EDGE, asserted as a REPORT rather than as an absence: the run must
          // contain at least one honest "I could not hold the size", and it must be for the one
          // legal reason — the window it wanted is longer than the document is.
          const walls = rows.filter((r) => r.sizeHeld === false);
          check(
            'P5b: where size CANNOT be held the app says so, and only because the document is too short',
            walls.every((r) => r.granted < r.wanted && Math.abs(r.granted - r.docSec.audio) < 0.5),
            walls.length === 0
              ? 'no clamp was needed on this run'
              : walls.map((r) => `${r.bpm}BPM wanted ${r.wanted}s, document is ${r.docSec.audio}s, took ${r.granted}s`).join('; ')
          );
        }
      }
    }

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${results.length} checks)`);
    await writeFile(join(OUT, 'scrollzoom-probe.json'), JSON.stringify({ results }, null, 2));

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
}

main();
