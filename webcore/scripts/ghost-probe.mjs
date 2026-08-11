#!/usr/bin/env node
/**
 * THE GHOST PROBE, and the ALIGNMENT probe. A live browser, not a unit test.
 *
 * Two reports had survived three rounds of reasoning-from-the-source fixes, which is the
 * signal that reasoning is the wrong tool:
 *
 *   G3  every glyph doubled on a grand-clef score with Align on and the Free grid, after a
 *       zoom/scroll gesture. A DOUBLED ENGRAVING IS A COUNTABLE THING — alphaTab keeps one
 *       absolutely-positioned `<div>` per render partial inside `.at-surface` and exactly one
 *       `svg.at-surface-svg` inside each — so this counts them, before and after the gesture,
 *       instead of arguing about placeholders.
 *   G2  "the same note's notehead, roll block and waveform hit sit on one vertical line, and
 *       scrolling moves all three together." Measured as three screen x's for one note id at
 *       several scroll positions.
 *
 * A SEPARATE FILE from scripts/verify.mjs on purpose: verify is the shipped smoke test and is
 * owned elsewhere. The server/Chrome/CDP bootstrap below is deliberately the same incantation
 * (port 5399/9335 so the two can run at the same time).
 *
 *   node scripts/ghost-probe.mjs [--headful] [--shots]
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'spike-results');
const PORT = 5399;
const DEBUG_PORT = 9335;
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

// ---------------------------------------------------------------------------
// The counters. Both are DOM facts, taken from the live page.
// ---------------------------------------------------------------------------

/**
 * alphaTab's surface, counted.
 *
 * `surfaces` must be 1 (one API instance, one canvas element). `partials` is
 * `.at-surface > div` — one per render partial — and `svgs` is `svg.at-surface-svg`, one per
 * partial. A GHOST is `svgs > partials` (two engravings inside one placeholder) or `partials`
 * larger than the layout produced (stale placeholders the sweep did not reclaim); either way
 * the visible symptom is the same doubled ink, so both numbers are reported.
 *
 * `overlapPairs` is the independent witness: partial boxes are laid out side by side, so any
 * pair whose rectangles overlap by more than a pixel is two pictures on top of each other.
 */
const COUNT = `(() => {
  const host = document.querySelector('.at-host');
  if (!host) return JSON.stringify({ error: 'no .at-host' });
  const surfaces = host.querySelectorAll('.at-surface');
  const surface = surfaces[0] ?? null;
  const partials = surface ? [...surface.children].filter((c) => c.tagName === 'DIV') : [];
  const svgs = host.querySelectorAll('svg.at-surface-svg');
  const boxes = partials.map((p) => ({
    left: Math.round(parseFloat(p.style.left) || 0),
    width: Math.round(parseFloat(p.style.width) || 0),
    svgs: p.querySelectorAll('svg.at-surface-svg').length,
    glyphs: p.querySelectorAll('path,text').length
  }));
  // ONLY GLYPH-BEARING partials can ghost. alphaTab emits one extra, empty partial per render
  // (the credit annotation, whose text this app strips), which legitimately sits at x=0 on top
  // of the music; counting it as an overlap would make the check fail on a healthy page.
  const inked = boxes.filter((b) => b.glyphs > 0);
  let overlapPairs = 0;
  for (let i = 0; i < inked.length; i++) {
    for (let j = i + 1; j < inked.length; j++) {
      const a = inked[i], b = inked[j];
      const o = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
      if (o > 1) overlapPairs++;
    }
  }
  // Duplicate ink, measured a third way and the one closest to what the eye sees: two glyphs
  // of the same shape at (nearly) the same place. A doubled engraving is offset by the change
  // in scale or padding, so the copies are near but not exactly coincident.
  const seen = new Map();
  let dupGlyphs = 0;
  for (const t of host.querySelectorAll('svg.at-surface-svg text')) {
    const r = t.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // 12px buckets: a doubled engraving is offset by the change in page padding or scale that
    // produced it (measured at 6px on the reported case), so a 4px key put the copies in
    // different buckets and reported zero duplicates on a visibly doubled page.
    const key = (t.textContent ?? '') + '@' + Math.round(r.left / 12) + ',' + Math.round(r.top / 12);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) dupGlyphs++;
  }
  return JSON.stringify({
    surfaces: surfaces.length,
    partials: partials.length,
    svgs: svgs.length,
    svgsPerPartial: boxes.map((b) => b.svgs),
    overlapPairs,
    dupGlyphs,
    totalGlyphs: host.querySelectorAll('svg.at-surface-svg path,svg.at-surface-svg text').length,
    boxes
  });
})()`;

/**
 * THE ACCEPTANCE TEST, in numbers: sheet notehead x, roll block x and waveform hit x for the
 * SAME note id, in SCREEN pixels.
 *
 * Assembled here rather than in the app, out of three probes that already exist, so each of the
 * three numbers comes from the pane that drew it:
 *
 *   sheet  `layoutProbe().noteXs[].screenX` — `BeatBounds.onNotesX` plus the stack's own left,
 *          i.e. the engraved notehead, not a re-derivation of it.
 *   roll   `paintedRects()[].x` plus the roll canvas's left — the rectangle's own left edge,
 *          which IS the onset (view/pianoroll.ts invariant 5).
 *   wave   the strip's published axis (`gutterPx`, `plotWidth`, the aligned window) evaluated
 *          at the note's RECORDING second, which is the roll's written second plus the roll's
 *          own `originSec`. Same arithmetic as `secToEvenX`.
 */
const TRIPLE = `(() => {
  const L = window.__RIFFSHEET_LAYOUT__ && window.__RIFFSHEET_LAYOUT__();
  const rects = window.__RIFFSHEET_ROLLRECTS__ && window.__RIFFSHEET_ROLLRECTS__();
  const rollProbe = window.__RIFFSHEET_PIANOROLL__ && window.__RIFFSHEET_PIANOROLL__();
  const wave = window.__RIFFSHEET_WAVE__ && window.__RIFFSHEET_WAVE__();
  if (!L || !rects || !rollProbe) return JSON.stringify({ error: 'no probes' });
  const rollCanvas = document.querySelector('.pianoroll-pane canvas');
  const waveCanvas = document.querySelector('canvas.waveform') ?? document.querySelector('.waveform canvas');
  if (!rollCanvas) return JSON.stringify({ error: 'no roll canvas' });
  const rollLeft = rollCanvas.getBoundingClientRect().left;
  const waveLeft = waveCanvas ? waveCanvas.getBoundingClientRect().left : null;
  const originSec = rollProbe.roll ? rollProbe.roll.originSec : 0;
  const byId = new Map(rects.filter((r) => r.noteId).map((r) => [r.noteId, r]));
  const waveX = (recSec) => {
    if (!wave || waveLeft === null) return null;
    const from = wave.windowFromSec;
    const to = wave.windowToSec;
    const frac = from !== null && to !== null && to > from
      ? (recSec - from) / (to - from)
      : wave.durationSec > 0 ? recSec / wave.durationSec : 0;
    return waveLeft + wave.gutterPx + frac * wave.plotWidth;
  };
  const rows = [];
  for (const n of L.noteXs) {
    const r = byId.get(n.noteId);
    if (!r) continue;
    const rollScreenX = rollLeft + r.x;
    const recSec = r.startSec + originSec;
    const wx = waveX(recSec);
    rows.push({
      noteId: n.noteId,
      sheetX: Math.round(n.screenX),
      rollX: Math.round(rollScreenX),
      waveX: wx === null ? null : Math.round(wx),
      sheetToRoll: Math.round(Math.abs(n.screenX - rollScreenX)),
      sheetToWave: wx === null ? null : Math.round(Math.abs(n.screenX - wx))
    });
  }
  // Only notes actually ON SCREEN in the sheet: one scrolled off the left edge has a negative
  // screen x and no rectangle to compare against, and folding it in would report a disagreement
  // that is really just "it is not visible".
  const visible = rows.filter((r) => r.sheetX > 0 && r.sheetX < window.innerWidth);
  const pool = visible.length > 0 ? visible : rows;
  return JSON.stringify({
    compared: pool.length,
    worstSheetToRollPx: pool.length ? Math.max(...pool.map((r) => r.sheetToRoll)) : null,
    worstSheetToWavePx: pool.length && pool.every((r) => r.sheetToWave !== null)
      ? Math.max(...pool.map((r) => r.sheetToWave))
      : null,
    rows: pool.slice(0, 6)
  });
})()`;

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

  const profileDir = join(tmpdir(), `riffsheet-ghost-${process.pid}-${Date.now()}`);
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required'
  ];
  if (!HEADFUL) args.push('--headless=new', '--disable-gpu');
  const proc = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

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
      await writeFile(join(OUT, `ghost-${name}.png`), Buffer.from(r.data, 'base64'));
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

    // ---------------------------------------------------------------------
    // The scenario the report is a photograph of: GRAND clef, FREE grid, Align ON.
    // Driven through the real controls, so nothing here is a shortcut past the app.
    // ---------------------------------------------------------------------
    const setSelect = (role, value) => `(() => {
      const s = document.querySelector('[data-role="${role}"]');
      if (!s) return 'missing';
      s.value = ${JSON.stringify(value)};
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return s.value;
    })()`;
    const brief = async (label) => {
      const c = await json(COUNT);
      say(label, { partials: c.partials, svgs: c.svgs, glyphs: c.boxes.map((b) => b.glyphs), widths: c.boxes.map((b) => b.width) });
    };
    await brief('after load');
    say('names@auto', await json(`JSON.stringify({
      noteNames: document.querySelectorAll('.note-name').length,
      showNames: document.querySelector('[data-setting="showNoteNames"]')?.checked ?? null,
      layoutLabels: window.__RIFFSHEET_LAYOUT__ ? window.__RIFFSHEET_LAYOUT__().labels : null,
      noteXs: window.__RIFFSHEET_LAYOUT__ ? window.__RIFFSHEET_LAYOUT__().noteXs.length : null
    })`));
    say('clef', await ev(setSelect('clef-view', 'grand')));
    await settle(1200);
    await brief('after clef=grand');
    say('quantize', await ev(setSelect('notation-grid', 'free')));
    await settle(1500);
    await brief('after grid=free');
    say('alignOn', await ev(`(() => {
      const chip = document.querySelector('[data-setting="alignViews"]');
      if (!chip) return 'missing';
      if (chip.getAttribute('aria-pressed') !== 'true') chip.click();
      return chip.getAttribute('aria-pressed');
    })()`));
    await settle(900);
    await shot('01-baseline');
    // G18: where the open-string letters landed, against the prefix they are meant to sit beside.
    say('string letters', await json(`(() => {
      const letters = [...document.querySelectorAll('.string-letter')].map((e) => {
        const r = e.getBoundingClientRect();
        return { t: e.textContent, l: Math.round(r.left), r: Math.round(r.right) };
      });
      const glyphs = [...document.querySelectorAll('.at-host svg text, .at-host svg path')]
        .map((g) => ({ box: g.getBoundingClientRect() }))
        .filter((g) => g.box.width > 0 && g.box.height > 0);
      let hits = 0;
      for (const l of letters) {
        const lb = [...document.querySelectorAll('.string-letter')].find((e) => e.textContent === l.t)?.getBoundingClientRect();
        if (!lb) continue;
        for (const g of glyphs) {
          if (lb.left < g.box.right && lb.right > g.box.left && lb.top < g.box.bottom && lb.bottom > g.box.top) { hits++; break; }
        }
      }
      const first = document.querySelector('.note-name');
      return JSON.stringify({
        count: letters.length,
        letters: letters.slice(0, 6),
        overlappingGlyphs: hits,
        firstNoteNameLeft: first ? Math.round(first.getBoundingClientRect().left) : null
      });
    })()`));
    // G16(a): WHAT DRAWS THE VERTICAL LINES IN THE STRIP. Every full-height mark the waveform
    // paints on its BODY, by x, so the report can name one instead of describing it.
    say('wave marks', await json(`(() => {
      const w = window.__RIFFSHEET_WAVE__ && window.__RIFFSHEET_WAVE__();
      if (!w) return JSON.stringify({ error: 'no wave probe' });
      return JSON.stringify({
        sheetLinked: w.sheetLinked, gutterPx: w.gutterPx, plotWidth: w.plotWidth,
        overviewPx: w.overviewPx, hasViewport: w.hasViewport,
        viewportFromX: w.viewportFromX, viewportToX: w.viewportToX,
        selectionFromX: w.selectionFromX, selectionToX: w.selectionToX,
        barOneX: w.durationSec > 0 ? Math.round(w.gutterPx + (w.barOneSec / w.durationSec) * w.plotWidth) : null,
        playheadX: w.durationSec > 0 ? Math.round(w.gutterPx + (w.positionSec / w.durationSec) * w.plotWidth) : null,
        onsetCount: w.onsetCount
      });
    })()`));

    const baseline = await json(COUNT);
    say('baseline', baseline);
    const ghostCounters = async () => {
      const l = await json(`JSON.stringify(window.__RIFFSHEET_LAYOUT__ ? window.__RIFFSHEET_LAYOUT__() : null)`);
      return l ? { surfacePartials: l.surfacePartials, surfaceSvgs: l.surfaceSvgs, partialsThisRender: l.partialsThisRender, ghostsTrimmed: l.ghostsTrimmed } : null;
    };
    const gc0 = await ghostCounters();
    say('view counters (baseline)', gc0);
    check('baseline: surface holds exactly this render\'s partials',
      !!gc0 && gc0.surfacePartials === gc0.partialsThisRender && gc0.surfaceSvgs === gc0.partialsThisRender,
      JSON.stringify(gc0));
    check('baseline: one surface', baseline.surfaces === 1, `surfaces=${baseline.surfaces}`);
    check(
      'baseline: one svg per partial',
      baseline.svgs === baseline.partials && baseline.svgsPerPartial.every((n) => n === 1),
      `partials=${baseline.partials} svgs=${baseline.svgs} per=${JSON.stringify(baseline.svgsPerPartial)}`
    );
    check('baseline: no duplicated glyphs', baseline.dupGlyphs === 0, `dupGlyphs=${baseline.dupGlyphs}`);
    check('baseline: no overlapping partials', baseline.overlapPairs === 0, `overlapPairs=${baseline.overlapPairs}`);

    // ---------------------------------------------------------------------
    // THE GESTURE. An align-coupled zoom is a wheel over the roll's TIME RULER: the roll's
    // window changes, it reports the change, and app.ts answers by re-engraving the sheet at
    // a new display.scale and re-anchoring its scroll. Then a scroll, then another zoom the
    // other way — the sequence the report describes as "it doubles after a while".
    // ---------------------------------------------------------------------
    const ruler = await json(`(() => {
      const c = document.querySelector('.pianoroll-pane canvas');
      if (!c) return JSON.stringify({ error: 'no roll canvas' });
      const r = c.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 6), h: Math.round(r.height) });
    })()`);
    if (ruler.error) throw new Error(ruler.error);
    const wheelAt = async (x, y, deltaY) => {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: 0, pointerType: 'mouse'
      });
    };

    const trace = [];
    for (let step = 0; step < 6; step++) {
      // in, in, in, out, in, out — a real hand turning a notch back and forth.
      await wheelAt(ruler.x, ruler.y, step === 3 || step === 5 ? 120 : -120);
      await settle(500);
      // ...and a scroll of the sheet between notches, which is what re-arms the Align anchor.
      await ev(`(() => { const s = document.querySelector('.triview-scroll'); if (s) s.scrollLeft += 140; return true; })()`);
      await settle(400);
      const c = await json(COUNT);
      trace.push({
        step,
        partials: c.partials,
        svgs: c.svgs,
        dupGlyphs: c.dupGlyphs,
        overlapPairs: c.overlapPairs,
        totalGlyphs: c.totalGlyphs,
        zoom: await ev(`window.__RIFFSHEET_PIANOROLL__ ? window.__RIFFSHEET_PIANOROLL__().zoom : null`)
      });
      say(`step ${step}`, trace[trace.length - 1]);
    }
    await shot('02-after-gesture');

    const after = await json(COUNT);
    say('after', after);
    const gc1 = await ghostCounters();
    say('view counters (after)', gc1);
    check('after gesture: surface holds exactly this render\'s partials',
      !!gc1 && gc1.surfacePartials === gc1.partialsThisRender && gc1.surfaceSvgs === gc1.partialsThisRender,
      JSON.stringify(gc1));
    check('after gesture: one surface', after.surfaces === 1, `surfaces=${after.surfaces}`);
    check(
      'after gesture: one svg per partial',
      after.svgs === after.partials && after.svgsPerPartial.every((n) => n === 1),
      `partials=${after.partials} svgs=${after.svgs} per=${JSON.stringify(after.svgsPerPartial)}`
    );
    check('after gesture: no duplicated glyphs', after.dupGlyphs === 0, `dupGlyphs=${after.dupGlyphs}`);
    check('after gesture: no overlapping partials', after.overlapPairs === 0, `overlapPairs=${after.overlapPairs}`);
    const worst = trace.reduce(
      (m, t) => ({
        dupGlyphs: Math.max(m.dupGlyphs, t.dupGlyphs),
        overlapPairs: Math.max(m.overlapPairs, t.overlapPairs),
        extraSvgs: Math.max(m.extraSvgs, t.svgs - t.partials)
      }),
      { dupGlyphs: 0, overlapPairs: 0, extraSvgs: 0 }
    );
    say('worst across the gesture', worst);
    check('no ghost at any point in the gesture',
      worst.dupGlyphs === 0 && worst.overlapPairs === 0 && worst.extraSvgs === 0,
      JSON.stringify(worst));

    // ---------------------------------------------------------------------
    // G16(b): DRAGGING THE SCROLLBAR MUST ONLY PAN.
    //
    // The bar writes `TriView.setScrollLeft` and nothing else, so the roll's span changing at
    // all is the bug. Driven through the real control — a pointer press and a drag on
    // `[data-role="hscroll"]` — rather than by calling the setter, so the whole chain from the
    // gesture to the roll's window is what is measured.
    // ---------------------------------------------------------------------
    const rollWindow = async () => {
      const p = await json(`JSON.stringify(window.__RIFFSHEET_PIANOROLL__ ? window.__RIFFSHEET_PIANOROLL__().roll : null)`);
      return p ? { from: p.windowFromSec, to: p.windowToSec, span: p.windowFromSec === null ? null : Number((p.windowToSec - p.windowFromSec).toFixed(4)) } : null;
    };
    const barBox = await json(`(() => {
      const b = document.querySelector('[data-role="hscroll"]');
      if (!b) return JSON.stringify({ error: 'no scrollbar' });
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), visible: r.width > 0 && r.height > 0 });
    })()`);
    say('scrollbar', barBox);
    if (barBox.visible) {
      const before = await rollWindow();
      const press = async (type, x, y, buttons) =>
        cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
      await press('mousePressed', barBox.x, barBox.y, 1);
      for (const step of [60, 120, 200, 300]) {
        await press('mouseMoved', barBox.x + step, barBox.y, 1);
        await settle(120);
      }
      await press('mouseReleased', barBox.x + 300, barBox.y, 0);
      await settle(600);
      const after = await rollWindow();
      say('roll window before/after a scrollbar drag', { before, after });
      const moved = !!before && !!after && Math.abs(after.from - before.from) > 0.05;
      const spanDrift = !!before && !!after ? Math.abs(after.span - before.span) : null;
      const spanPct = spanDrift !== null && before.span > 0 ? (spanDrift / before.span) * 100 : null;
      check('scrollbar: it moved the roll at all', moved, `from ${before?.from} -> ${after?.from}`);
      check(
        'scrollbar: it PANNED — the span is unchanged (< 1%)',
        spanPct !== null && spanPct < 1,
        `span ${before?.span}s -> ${after?.span}s (${spanPct?.toFixed(2)}%)`
      );
    } else {
      check('scrollbar: present', false, JSON.stringify(barBox));
    }

    // ---------------------------------------------------------------------
    // G2: sheet notehead / roll block / waveform hit, one vertical line, through scrolling.
    // ---------------------------------------------------------------------
    const alignRows = [];
    for (const scrollLeft of [0, 200, 600, 1200]) {
      await ev(`(() => { const s = document.querySelector('.triview-scroll'); if (s) s.scrollLeft = ${scrollLeft}; return true; })()`);
      await settle(500);
      const t = await json(TRIPLE);
      alignRows.push({ scrollLeft, ...t });
      say(`triple @${scrollLeft}`, t);
    }
    const measurable = alignRows.filter((r) => typeof r.worstSheetToRollPx === 'number');
    if (measurable.length === 0) {
      check('alignment: measurable', false, JSON.stringify(alignRows[0]));
    } else {
      const worstRoll = Math.max(...measurable.map((r) => r.worstSheetToRollPx));
      const worstWave = Math.max(...measurable.map((r) => r.worstSheetToWavePx ?? 0));
      say('alignment worst (px)', { sheetToRoll: worstRoll, sheetToWave: worstWave });
      /*
       * TWO DIFFERENT CLAIMS, AND ONLY ONE OF THEM CAN BE A FEW PIXELS.
       *
       * The FIRST engraved note is an exact claim. It is where the two rulers are pinned
       * together, so any error there is a pairing bug — the origin, `barOneSec`, or the clamp
       * that used to pin the window to the first attack while the sheet was still showing the
       * whole clef/key/meter prefix. That one was 177 px and is now 0.
       *
       * EVERY OTHER note is bounded, not exact, and the bound is a property of engraving rather
       * than of this code. The roll is linear in time by design (view/pianoroll.ts §1: a picture
       * of a performance must not re-space itself when the performance is edited) and alphaTab
       * is deliberately not — it gives a rhythmically dense bar more pixels than a sparse one.
       * Measured on this fixture, the sheet's pixels-per-second varies about 20% across the
       * take, so two anchors and a straight line between them cannot do better than a
       * proportional share of the pane. The shipped harness allows 320 px for exactly this
       * (scripts/verify.mjs, ALIGN_TOLERANCE_PX, measured at 308). 120 is where this build
       * actually is; making it truly exact needs the roll to borrow the sheet's non-linear axis,
       * which is the linked mode that was deliberately deleted.
       */
      const first = alignRows
        .map((r) => (r.rows ?? []).find((row) => row.noteId === 'f0'))
        .filter(Boolean);
      const worstFirst = first.length ? Math.max(...first.map((r) => r.sheetToRoll)) : null;
      say('first engraved note, sheet vs roll (px)', worstFirst);
      check(
        'alignment: the FIRST note is pinned to within a notehead (<= 8px)',
        worstFirst === null || worstFirst <= 8,
        `worst=${worstFirst}px`
      );
      check('alignment: every note within the engraving residual (<= 90px)', worstRoll <= 90, `worst=${worstRoll}px`);
      check('alignment: the strip agrees with the roll to the pixel', worstWave <= worstRoll + 1, `wave=${worstWave} roll=${worstRoll}`);
    }
    await shot('03-alignment');

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${results.length} checks)`);
    await writeFile(join(OUT, 'ghost-probe.json'), JSON.stringify({ baseline, trace, after, alignRows, results }, null, 2));
  } catch (e) {
    failures++;
    console.error('probe crashed:', e);
  } finally {
    cdp?.close();
    proc.kill();
    server.close();
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();
