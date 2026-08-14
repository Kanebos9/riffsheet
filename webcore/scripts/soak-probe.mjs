#!/usr/bin/env node
/**
 * THE SOAK PROBE — long, seeded, randomly-timed interaction runs against a live browser.
 *
 * WHY THIS EXISTS, and why every single-step probe in this directory has failed to catch the
 * thing it is aimed at. `__RIFFSHEET_ROLLPURITY__`, `__RIFFSHEET_ORIGINPROBE__` and
 * `scripts/sheet-edit-probe.mjs` each perform ONE edit, wait for it, and then assert. The
 * reported fault — "adding a note on the roll sometimes wrecks the notes around it" — is
 * INTERMITTENT and the owner reproduces it by working quickly. A probe that waits for the app to
 * settle before it does the next thing has, by construction, removed the only variable that
 * distinguishes a good run from a bad one: WHEN the next event arrives relative to the engrave
 * the previous one started.
 *
 * So this harness is built around three things the others deliberately do not have:
 *
 *   1. LENGTH AND RANDOMNESS. A seeded RNG drives 200+ steps of mixed gestures — roll adds
 *      (including deliberately stacked directly above and below an existing note at the same
 *      onset), drags, resizes, deletes, sheet duration edits, zooms, scrolls, snap-mode flips,
 *      selection changes and undo/redo — with 0-400 ms of jitter between events.
 *
 *   2. MID-REBUILD INJECTION. With probability `--inject`, the next gesture is fired WITHOUT
 *      waiting for the previous engrave to land. "In flight" is not guessed at: the roll
 *      publishes `pendingEdit` (the edit it has emitted and not yet had answered) and paints
 *      provisional rectangles with `noteId: null`, and the app publishes a `revision`. A burst
 *      is a run of gestures fired while at least one of those says the app is still working.
 *
 *   3. INVARIANTS AFTER EVERY BURST, fail-fast, with the whole state dumped on violation:
 *
 *        (a) RAW BYTE-IDENTITY. Every id present in `source.detected.notes` before AND after,
 *            other than the ones the burst was allowed to author, serialises to the same bytes.
 *            This is the corruption claim itself, and it is made against the RECORDING rather
 *            than against the picture, because the recording is what a bad write-back damages
 *            and what a reload would show. Reads `__RIFFSHEET_SHEETEDIT__().rawBytes`.
 *        (b) PAINTED <-> RAW CORRESPONDENCE at quiescence. No provisional (`noteId: null`)
 *            rectangle survives settlement, no id is painted twice, and no painted id is absent
 *            from the feed. NOT a literal 1:1 with the feed: `layoutRects` culls notes outside
 *            the visible pitch/time window on purpose, so "every feed note is painted" is false
 *            by design and asserting it would produce a fountain of false failures.
 *        (c) PROJECTION TOTALITY. engraved + merged + dropped == total == inputs, and the
 *            projection carries the app's current revision — the same law `seam-probe.mjs`
 *            asserts once, asserted after every burst instead.
 *        (d) SELECTION AUTHORITY. The roll's list is the authority's, exactly; the sheet's is the
 *            authority's mapped through the projection (a merged id rings its proxy, a dropped
 *            one legitimately vanishes), and no selected id is absent from the feed.
 *
 * DETERMINISTIC REPRO. Every gesture is logged with its RESOLVED parameters — concrete canvas
 * coordinates, concrete note ids, concrete deltas, concrete delays — not with the random draw
 * that produced them. So a replay does not have to reproduce the state that made the choice; it
 * re-fires the identical events with the identical timing. On a violation the run writes
 * `spike-results/soak/soak-<seed>.json` holding the seed, the failing step, the full event log
 * and the before/after state, and `--replay=<file>` re-runs it. `--replay` with `--runs=N` runs
 * the same log N times and reports a flake rate, which is the honest answer for a race: a repro
 * that fires 7 times in 10 is still a repro.
 *
 * WHAT IS NOT ASSERTED, and why. Undo and redo legitimately rewrite the recording for ids this
 * harness did not author on that step (they are reversing an earlier one), so bursts containing
 * them are marked `wide` and skip invariant (a) only — (b), (c) and (d) still hold and are still
 * checked. Sheet duration edits and moves may legitimately touch collision victims, so their
 * authored set is taken from the app's OWN report (`userTouched` delta and `rippleWriteback`)
 * rather than from the harness's guess; a note the app does not claim to have touched changing
 * is a failure. ROLL ADDS ARE STRICT: a new id is not in the "before" map at all, so nothing
 * needs excusing, and every pre-existing id must be byte-identical. That is the whole point.
 *
 *   node scripts/soak-probe.mjs [--seed=N] [--steps=N] [--runs=N] [--minutes=M]
 *                               [--inject=0.45] [--parts] [--only-parts]
 *                               [--replay=FILE] [--headful] [--verbose]
 *
 * Its own port pair (5407/9347) so it can run alongside every other probe in this directory.
 * Chrome is launched through `probe-chrome.mjs`, which is the only launcher that cannot leave a
 * browser behind — a soak is precisely the kind of run somebody gives up on with Ctrl-C.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { launchChrome } from './probe-chrome.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'spike-results', 'soak');
const PORT = 5407;
const DEBUG_PORT = 9347;

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const HEADFUL = process.argv.includes('--headful');
const VERBOSE = process.argv.includes('--verbose');
const WANT_PARTS = process.argv.includes('--parts') || process.argv.includes('--only-parts');
const ONLY_PARTS = process.argv.includes('--only-parts');
const ONLY_ANCHOR = process.argv.includes('--only-anchored');
const NO_ANCHOR = process.argv.includes('--no-anchored');
const ONLY_GATES = process.argv.includes('--only-gates');
const NO_GATES = process.argv.includes('--no-gates');
const SNAP_MODES = (argOf('snap-modes', 'off,grid,beat')).split(',');
const STEPS = Number(argOf('steps', process.env.SOAK_STEPS ?? 220));
const RUNS = Number(argOf('runs', process.env.SOAK_RUNS ?? 1));
const MINUTES = Number(argOf('minutes', process.env.SOAK_MINUTES ?? 0));
const INJECT = Number(argOf('inject', process.env.SOAK_INJECT ?? 0.45));
const REPLAY = argOf('replay', process.env.SOAK_REPLAY ?? '');
const SEED0 = Number(argOf('seed', process.env.SOAK_SEED ?? Math.floor(Math.random() * 0xffffffff)));
const DEMO = argOf('demo', process.env.SOAK_DEMO ?? 'straight');
const BARS = Number(argOf('bars', process.env.SOAK_BARS ?? 4));

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
  send(method, params = {}, maxMs = 60_000) {
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
  close() { try { this.#ws.close(); } catch { /* already gone */ } }
}

/**
 * mulberry32 — 32 bits of state, one multiply-xorshift per draw.
 *
 * Chosen over `Math.random` for the only reason that matters here: the seed is printed, settable
 * from the environment, and reproduces the identical DRAW SEQUENCE. It does not by itself
 * reproduce the RUN — the app's state decides what each draw resolves to — which is exactly why
 * the event log records resolved parameters and the replay path re-fires those instead.
 */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (xs) => xs[Math.floor(next() * xs.length)];
  next.range = (lo, hi) => lo + next() * (hi - lo);
  next.chance = (p) => next() < p;
  return next;
}

// =============================================================================
// THE PAGE-SIDE HALF
// =============================================================================
/*
 * Everything below runs IN THE BROWSER, installed once per navigation as `window.__SOAK`.
 *
 * It lives here rather than in `src/` because it is test rigging and the production bundle must
 * not carry it. It reads only the `__RIFFSHEET_*` probes that already exist and dispatches only
 * real DOM events; it has no privileged access to the app, which is deliberate — a harness that
 * called the app's own methods would be asserting the app against itself.
 *
 * WHY THE GESTURES ARE EXECUTED IN THE PAGE AND NOT OVER CDP. A `Input.dispatchMouseEvent` round
 * trip is a millisecond or two each way, which would put a floor under the inter-event timing
 * that is the whole subject of this probe, and would make the "fire the next event mid-rebuild"
 * case unreachable. The node half decides WHAT and WHEN with the seeded RNG; the page half does
 * it with the requested delays and no round trip in between.
 */
const SOAK_INSTALL = String.raw`
(() => {
  const w = window;
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const num = (n, d = 4) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)) : null);

  const roll = () => (w.__RIFFSHEET_PIANOROLL__ ? w.__RIFFSHEET_PIANOROLL__().roll : null);
  const rects = () => (w.__RIFFSHEET_ROLLRECTS__ ? w.__RIFFSHEET_ROLLRECTS__() ?? [] : []);
  const seam = () => (w.__RIFFSHEET_SEAM__ ? w.__RIFFSHEET_SEAM__() : null);
  const sheet = () => (w.__RIFFSHEET_SHEETEDIT__ ? w.__RIFFSHEET_SHEETEDIT__() : null);
  const canvas = () => document.querySelector('canvas.pianoroll');
  const faceScale = () => (w.__RIFFSHEET_FACE__ ? (w.__RIFFSHEET_FACE__().scale || 1) : 1);

  /*
   * LOGICAL -> CLIENT, read at dispatch time.
   *
   * The roll publishes its geometry in the design's own pixels; a MouseEvent carries VISUAL
   * viewport coordinates. The canvas box is re-read for every event on purpose: anything that
   * changes the height of a row above the roll (a seek, a transport update, a rebuild that
   * re-measures the ruler) slides the pane, and a hoisted box aims every later event that many
   * pixels off — vertically that walks a double-click off the top of the pitch window, where
   * layoutRects culls the note it authored, and the add then looks like it did nothing.
   */
  const toClient = (x, y) => {
    const c = canvas();
    if (!c) return null;
    const box = c.getBoundingClientRect();
    const s = faceScale();
    return { clientX: box.left + x * s, clientY: box.top + y * s };
  };

  const fire = (type, x, y, extra = {}) => {
    const c = canvas();
    const p = toClient(x, y);
    if (!c || !p) return false;
    const init = { bubbles: true, cancelable: true, clientX: p.clientX, clientY: p.clientY, ...extra };
    let e;
    if (type.startsWith('pointer')) {
      e = new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, ...init });
    } else if (type === 'wheel') {
      e = new WheelEvent(type, { deltaMode: 0, ...init });
    } else {
      e = new MouseEvent(type, init);
    }
    return c.dispatchEvent(e);
  };

  /*
   * A MOVE OR RESIZE DRAG'S POINTERMOVES GO TO THE WINDOW, not to the canvas.
   *
   * PianoRoll captures the pointer on pointerdown and then listens on 'window' for pointermove
   * and pointerup (see its constructor). A synthetic drag that dispatches its moves on the canvas
   * alone still reaches the window by bubbling, but a pointerup dispatched on the canvas after a
   * real 'setPointerCapture' would not necessarily — so both are dispatched at the window, which
   * is where the app is actually listening and therefore what the check should exercise.
   */
  const fireWindow = (type, x, y, extra = {}) => {
    const p = toClient(x, y);
    if (!p) return false;
    const init = { bubbles: true, cancelable: true, clientX: p.clientX, clientY: p.clientY, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, ...extra };
    return w.dispatchEvent(new PointerEvent(type, init));
  };

  const key = (k, extra = {}) =>
    w.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

  const setSelect = (role, value) => {
    const s = document.querySelector('[data-role="' + role + '"]');
    if (!s) return { set: false, why: 'no control' };
    if (![...s.options].some((o) => o.value === value)) return { set: false, why: 'no option' };
    s.value = value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return { set: true, value };
  };

  // ---------------------------------------------------------------------------
  // THE STATE DIGEST — one frame of everything the invariants are stated over
  // ---------------------------------------------------------------------------
  const snapshot = () => {
    const r = roll();
    const s = seam();
    const sh = sheet();
    const painted = rects() ?? [];
    const byId = {};
    const dupes = [];
    let nullIds = 0;
    for (const rect of painted) {
      if (rect.noteId === null || rect.noteId === undefined) { nullIds++; continue; }
      if (byId[rect.noteId]) dupes.push(rect.noteId);
      byId[rect.noteId] = [num(rect.startSec), num(rect.endSec), rect.midi, Math.round(rect.x), Math.round(rect.w)];
    }
    return {
      t: Math.round(performance.now()),
      rev: s ? s.revision : null,
      /*
       * THE ENGRAVE'S OWN LIFECYCLE, and the reason this probe sees anything at all.
       *
       * The roll's 'pendingEdit' is cleared SYNCHRONOUSLY: onEdit -> applyRollEdit ->
       * commitPerformance -> rebuildNotation -> setPerformanceNotes all run in the one task, so
       * by the time the gesture's dispatch returns there is nothing pending to observe. Measured:
       * forty steps at up to 45% injection reported ZERO gestures landing mid-rebuild, which is
       * not the app being fast — it is the harness watching the wrong clock.
       *
       * What IS asynchronous is alphaTab's render. 'revisionProbe()' publishes the pair that says
       * so: 'model' moves when the score is rebuilt, 'bounds' moves when the ENGRAVING that
       * describes it lands, and 'current' is false in between. That gap is the real in-flight
       * window and the one finding 8 lives in — it is the state in which a hit test resolves
       * against the previous engraving's bounds ('staleHitRejections' counts the rejections).
       */
      sheet: s ? s.sheet ?? null : null,
      projection: s ? s.projection : null,
      sel: s ? s.selection : [],
      sheetSel: s ? (s.sheetSelection ?? []) : [],
      rollSel: s ? (s.rollSelection ?? []) : [],
      silent: s ? (s.sheetSilence ?? []).map((x) => x.id) : [],
      duplicateIds: s ? (s.ids ? s.ids.duplicateIds : []) : [],
      feedIds: sh ? sh.notes.map((n) => n.id) : [],
      feed: sh ? Object.fromEntries(sh.notes.filter((n) => n.id).map((n) => [n.id, [n.startSec, n.endSec, n.midi]])) : {},
      raw: sh ? sh.rawBytes ?? null : null,
      rawStarts: sh ? sh.rawStarts ?? null : null,
      userTouched: sh ? sh.userTouched ?? [] : [],
      rippleWriteback: sh ? sh.rippleWriteback ?? [] : [],
      // The app's OWN statement about each transaction it committed. See App.commitLog.
      commits: sh ? sh.commits ?? [] : [],
      // Written second 0 on the recording's clock, as the page is currently using it.
      originSec: sh ? sh.originSec ?? null : null,
      painted: byId,
      paintedNullIds: nullIds,
      paintedDupes: dupes,
      /*
       * THE ROLL'S ORIGIN, published with the picture because the two layers are in DIFFERENT
       * CLOCKS and comparing them without it is a guaranteed false failure.
       *
       * paintedRects() speaks WRITTEN seconds — the roll subtracts the app's origin on the way in,
       * which is the whole of "the roll shows the performance". The feed speaks AUDIO seconds,
       * because that is what the recording is stated in and what a reload restores. On the demo
       * fixture the two differ by the 0.9s lead-in, so a naive span comparison reports every note
       * on the page as drifting by exactly the same amount — which is the signature of a harness
       * bug and not of an app one.
       */
      rollOriginSec: r ? r.originSec : null,
      pendingEdit: r ? r.pendingEdit : null,
      heldEdit: r ? r.heldEdit ?? null : null,
      dragging: r ? r.dragging : null,
      drawnRects: r ? r.drawnRects : null,
      snapMode: (document.querySelector('[data-role="roll-snap"]') || {}).value ?? null,
      gridMode: (document.querySelector('[data-role="roll-grid"]') || {}).value ?? null,
      undo: sh ? { title: sh.undoTitle ?? null } : null
    };
  };

  /*
   * QUIESCENCE, POLLED FOR THE ANSWER RATHER THAN FOR A DURATION.
   *
   * Five conditions, and each one is a real lifecycle state rather than a guess at a timer:
   *   - the roll holds no 'pendingEdit' (it has emitted an edit nobody has answered yet);
   *   - it is painting no provisional rectangle ('noteId: null', which is what an add draws the
   *     instant the gesture fires and before the pipeline has re-engraved);
   *   - no drag gesture is open;
   *   - the SHEET's bounds revision has caught up with its model revision — the asynchronous half,
   *     and on this app the only one with a window wide enough to fire an event into (see
   *     'sheet' in the snapshot for the measurement that made this necessary);
   *   - the app's revision has stopped moving for two consecutive frames.
   * A flat sleep would pass on a fast machine and fail on a slow one, which is the property that
   * makes an intermittent bug look like a flaky harness.
   */
  const busyNow = () => {
    const r = roll();
    const s = seam();
    const painted = rects() ?? [];
    const nulls = painted.filter((x) => x.noteId === null || x.noteId === undefined).length;
    const engraving = !!(s && s.sheet && s.sheet.current === false);
    /*
     * A HELD MICRO-EDIT IS WORK STILL OWED (conviction C2).
     *
     * The roll holds back a drag that travelled less than the double-click tolerance until it
     * knows whether a second click is coming (view/pianoroll.ts, commitOrHold). The rectangle is
     * already drawn where the hand left it, but nothing downstream has been told, so a harness
     * that treated this as settled would snapshot a recording that is about to change and blame
     * the NEXT gesture for the difference. It is answered by the player rather than by the app,
     * which is why the roll publishes it under its own name.
     */
    const held = !!(r && r.heldEdit);
    return {
      busy: !!((r && r.pendingEdit !== null) || held || nulls > 0 || (r && r.dragging !== null) || engraving),
      nulls,
      engraving,
      held,
      pendingEdit: r ? r.pendingEdit : null,
      heldEdit: r ? r.heldEdit ?? null : null,
      dragging: r ? r.dragging : null,
      sheet: s ? s.sheet ?? null : null,
      rev: s ? s.revision : null
    };
  };

  const quiesce = async (maxMs) => {
    const started = performance.now();
    let lastRev = null;
    let stable = 0;
    for (;;) {
      const b = busyNow();
      if (!b.busy && b.rev === lastRev) stable++; else stable = 0;
      lastRev = b.rev;
      if (stable >= 2) return { ok: true, waitedMs: Math.round(performance.now() - started) };
      if (performance.now() - started > maxMs) {
        return { ok: false, waitedMs: Math.round(performance.now() - started), why: b };
      }
      await new Promise((ok) => requestAnimationFrame(() => ok()));
      await sleep(16);
    }
  };

  const busy = () => busyNow().busy;

  // ---------------------------------------------------------------------------
  // THE GESTURES
  // ---------------------------------------------------------------------------
  /*
   * A DOUBLE-CLICK IS FOUR PRESSES AND A dblclick, NOT ONE EVENT.
   *
   * The browser delivers pointerdown/pointerup/click twice before dblclick, and the FIRST
   * pointerdown on empty roll background SEEKS — which recentres the coupled viewport and moves
   * the ruler the dblclick is then measured against. '__RIFFSHEET_ORIGINPROBE__' documents this
   * at length: a probe that dispatches a lone synthetic dblclick never seeks, so it never moves
   * the ruler, so it passes against a broken app. A soak whose whole subject is timing cannot
   * afford that shortcut either.
   */
  const dbl = async (x, y, alt, gapMs, driftX, driftY) => {
    /*
     * MICRO-DRIFT BETWEEN THE TWO CLICKS, because a hand does not press twice on the same pixel.
     *
     * This is suspect 2 in Codex's race analysis and it is a two-part mechanism, both parts in
     * pianoroll.ts: a press followed by a few pixels of travel arms a PAN (the pan branch and its
     * DRAG_SLOP_PX test), and a pan moves the shared time window — so the ruler the second click
     * and then the dblclick are measured against is not the ruler the first click was measured
     * against. Two or three pixels is under the slop threshold and therefore invisible to anyone
     * watching, which is exactly why a probe that clicks twice on an identical integer coordinate
     * cannot see it. 'driftX'/'driftY' are logged with the gesture, so a repro carries the drift.
     */
    const dx = driftX ?? 0;
    const dy = driftY ?? 0;
    for (const detail of [1, 2]) {
      const px = detail === 1 ? x : x + dx;
      const py = detail === 1 ? y : y + dy;
      fire('pointerdown', px, py, { detail, altKey: alt });
      await sleep(6);
      // The travel itself, delivered where the app listens for it (window), so the pan branch
      // gets its chance to arm before the button comes up.
      if (detail === 1 && (dx !== 0 || dy !== 0)) {
        fireWindow('pointermove', x + dx, y + dy, { altKey: alt });
        await sleep(2);
      }
      fire('pointerup', px, py, { detail, altKey: alt, buttons: 0 });
      fire('click', px, py, { detail, altKey: alt });
      await sleep(gapMs);
    }
    fire('dblclick', x + dx, y + dy, { detail: 2, altKey: alt });
  };

  const drag = async (fromX, fromY, toX, toY, steps, holdMs, alt) => {
    fire('pointerdown', fromX, fromY, { altKey: alt });
    await sleep(holdMs);
    const n = Math.max(1, steps);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      fireWindow('pointermove', fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, { altKey: alt });
      await sleep(holdMs);
    }
    fireWindow('pointerup', toX, toY, { altKey: alt, buttons: 0 });
  };

  const rightClick = (clientX, clientY) => {
    const el = document.elementFromPoint(clientX, clientY) || document.querySelector('.triview-scroll');
    if (!el) return false;
    return el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY, button: 2, buttons: 2 }));
  };

  const pickMenu = (label) => {
    const row = [...document.querySelectorAll('[data-menu-item]')].find((e) => e.getAttribute('data-menu-item') === label);
    if (!row) return 'missing';
    if (row.getAttribute('aria-disabled') === 'true') return 'disabled';
    row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));
    return 'picked';
  };

  /** Execute one logged action. 'a' is the RESOLVED descriptor, so replay is exact. */
  const act = async (a) => {
    /*
     * WAS THE APP STILL WORKING WHEN THIS GESTURE LANDED? Read HERE, in the same task that is
     * about to dispatch it, and not over a separate CDP call beforehand — a round trip is a
     * millisecond or two of extra latency in exactly the window the answer is about, so an
     * out-of-page reading systematically under-reports the thing this probe exists to measure.
     */
    const busyBefore = busyNow();
    const out = await actInner(a);
    // …and immediately after the dispatch returns, before anything has had a chance to settle.
    // The pair is what says whether an asynchronous window exists to fire into at all.
    return { ...(out ?? {}), busyBefore: busyBefore.busy, busyBeforeWhy: busyBefore, busyAfter: busyNow() };
  };

  const actInner = async (a) => {
    switch (a.kind) {
      case 'add':
        await dbl(a.x, a.y, !!a.alt, a.gapMs ?? 12, a.driftX ?? 0, a.driftY ?? 0);
        return { done: true };
      case 'move':
      case 'resize':
        await drag(a.fromX, a.fromY, a.toX, a.toY, a.steps, a.holdMs, !!a.alt);
        return { done: true };
      case 'dblDelete':
        await dbl(a.x, a.y, false, a.gapMs ?? 12, a.driftX ?? 0, a.driftY ?? 0);
        return { done: true };
      case 'select':
        if (w.__RIFFSHEET_SELECT__) w.__RIFFSHEET_SELECT__(a.ids);
        return { done: true };
      case 'delete':
        if (w.__RIFFSHEET_SELECT__) w.__RIFFSHEET_SELECT__(a.ids);
        await sleep(4);
        key(a.useBackspace ? 'Backspace' : 'Delete');
        return { done: true };
      case 'snap':
        return setSelect('roll-snap', a.value);
      case 'grid':
        return setSelect('roll-grid', a.value);
      case 'wheel':
        fire('wheel', a.x, a.y, { deltaY: a.deltaY, deltaX: a.deltaX ?? 0, ctrlKey: !!a.ctrl, shiftKey: !!a.shift });
        return { done: true };
      case 'undo':
      case 'redo': {
        const b = document.querySelector('[data-role="' + a.kind + '"]');
        if (!b || b.disabled) return { done: false, why: 'disabled' };
        b.click();
        return { done: true };
      }
      case 'sheetMenu': {
        rightClick(a.clientX, a.clientY);
        await sleep(a.menuMs ?? 120);
        const picked = pickMenu(a.label);
        return { done: picked === 'picked', picked };
      }
      case 'partView':
        return setSelect('part-view', a.value);
      case 'tabView':
        return setSelect('tab-view', a.value);
      case 'partOrder':
        return w.__RIFFSHEET_PARTSORDER__ ? w.__RIFFSHEET_PARTSORDER__(a.order) : { done: false };
      default:
        return { done: false, why: 'unknown kind ' + a.kind };
    }
  };

  /**
   * THE GEOMETRY A CHOICE NEEDS, taken from the frame that is actually on screen.
   *
   * Every candidate point is one the roll is DRAWING: an add's row comes from a painted
   * rectangle's own y (offset by whole rows), and the roll itself is asked whether that exact
   * point is empty ('noteIdAt') and which pitch it is ('midiAtCanvasY') rather than the harness
   * reconstructing the ruler height and the rounding. A reconstructed row that is scrolled off
   * the top gets its note culled by layoutRects, and the add then reads as "did nothing" — a
   * probe bug wearing an app bug's clothes.
   */
  const geometry = () => {
    const r = roll();
    const c = canvas();
    if (!r || !c) return null;
    const painted = (rects() ?? []).filter((x) => x.noteId !== null && x.noteId !== undefined);
    const rulerH = r.rulerHeight ?? 0;
    const rowH = r.pxPerSemitone || 1;
    return {
      rulerH,
      rowH,
      gutterPx: r.gutterPx,
      secPerPx: r.secPerPx,
      width: r.width,
      height: r.height,
      lowMidi: r.visibleLowMidi,
      highMidi: r.visibleHighMidi,
      snapSec: r.snapSec,
      painted: painted.map((x) => ({ id: x.noteId, x: x.x, y: x.y, w: x.w, h: x.h, startSec: x.startSec, endSec: x.endSec, midi: x.midi }))
    };
  };

  /*
   * A WHOLE BURST IN ONE CALL, and this is what makes mid-rebuild injection actually happen.
   *
   * With one CDP round trip per gesture the follow-up cannot arrive sooner than the round trip
   * takes, and an engrave on this fixture completes in about 30-50 ms — measured, via the
   * quiescence wait. Driving each gesture separately therefore reported ZERO injections over
   * forty steps while the app really did leave an asynchronous window open on two of them: the
   * window existed and the harness was too slow to fire into it. The node half now composes a
   * burst of one to three gestures against ONE reading of the screen (which is also what a hand
   * working quickly does — you aim at what you can see, not at what the app will show you next)
   * and hands the whole burst over, delays included, to run with nothing between the events but
   * the delays themselves.
   */
  const actMany = async (list) => {
    const out = [];
    for (const a of list) {
      if (a.preDelayMs) await sleep(a.preDelayMs);
      /*
       * THE CHECKPOINT GATE — replay a RACE, not a stopwatch.
       *
       * A recorded delay reproduces the timing of the machine that recorded it and nothing else.
       * On a slower or busier machine the same 4 ms wait lands on the other side of the engrave
       * and the race simply does not happen, so a failing log quietly becomes a passing one and
       * the regression it was turned into is worthless. What actually characterised the original
       * run is the LIFECYCLE STATE the gesture landed in — mid-engrave or settled — so that is
       * recorded per step ('gate') and waited FOR here: spin until the app is in the state the
       * recording says it was in, then fire, and give up after a bounded wait rather than hang.
       * The delay is still honoured first; the gate only ever adds to it.
       */
      if (a.gate && typeof a.gate.busy === 'boolean') {
        const until = performance.now() + (a.gate.maxWaitMs ?? 400);
        while (busyNow().busy !== a.gate.busy && performance.now() < until) {
          await new Promise((ok) => requestAnimationFrame(() => ok()));
        }
      }
      out.push(await act(a));
    }
    return out;
  };

  w.__SOAK = { snapshot, quiesce, busy, act, actMany, geometry, sleep,
    /** Open the sheet's context menu at a client point and report what it is offering. */
    openMenu: async (clientX, clientY, waitMs) => {
      rightClick(clientX, clientY);
      await sleep(waitMs ?? 140);
      const s = sheet();
      return s ? s.menu : null;
    },
    /*
     * IS THIS EXACT CANVAS POINT ON A RECTANGLE? Answered from the LAST PAINTED FRAME, which is
     * the same thing PianoRoll.hitTest reads, so it agrees with the picture by construction and
     * with the gesture that is about to be aimed there. Reconstructing the pitch geometry instead
     * — ruler height, row origin, rounding — is how a probe ends up authoring a note on a row that
     * is scrolled off the top, where layoutRects culls it and the add looks like it did nothing.
     */
    occupiedAt: (x, y) => (rects() ?? []).some((r) => r.noteId !== null && r.noteId !== undefined && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h),
    menu: () => { const s = sheet(); return s ? s.menu : null; },
    heads: () => { const s = sheet(); return s ? (s.noteHeads ?? []) : []; },
    decorations: () => (w.__RIFFSHEET_LAYOUT__ ? (w.__RIFFSHEET_LAYOUT__() || {}).decorations ?? null : null)
  };
  return true;
})()
`;

// =============================================================================
// THE NODE-SIDE HALF — choosing, timing, asserting
// =============================================================================

/**
 * WHAT CHANGED IN THE RECORDING FOR AN ID NOBODY AUTHORED, split into two verdicts.
 *
 * The first version of this compared the serialised note whole and treated any difference as
 * corruption. That is too strong, and the run that proved it is worth keeping: seed 1 step 32
 * deleted one note and a DIFFERENT note lost its `notationIntent`. That is not damage — it is
 * `App.clearStaleIntents` (ui/app.ts §"DROP A notationIntent THE PAGE HAS CONTRADICTED"), which
 * retires a written value the engraving could no longer carry, deliberately, without a rebuild
 * and without an undo step. Deleting a note re-spaces the bar, so a neighbour's declared duration
 * stops fitting and the claim is dropped. A harness that calls that corruption cries wolf on the
 * first interesting run and buries the fault it was built for.
 *
 * So:
 *   HARD — the note's timing and identity: startSec, endSec, midi, velocity. Nothing may move
 *          these for a note the gesture did not name. This is the corruption claim.
 *   HARD — a notationIntent APPEARING on a note that had none, or CHANGING value. Inventing a
 *          written value for a note nobody edited is a fault in the same family: the page would
 *          print a duration the player never asked for.
 *   SOFT — a notationIntent DISAPPEARING. That is the documented retirement above. Counted and
 *          reported so a run that retires hundreds of them is still visible, never failed on.
 */
function strayedRaw(before, after, allowed) {
  const skip = new Set(allowed);
  const hard = [];
  const soft = [];
  if (!before || !after) return { hard, soft };
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const core = (n) => (n ? JSON.stringify([n.startSec, n.endSec, n.midi, n.velocity ?? null, n.sourceTiming ?? null]) : null);
  for (const id of Object.keys(before)) {
    if (skip.has(id)) continue;
    if (!(id in after)) continue;
    if (before[id] === after[id]) continue;
    const a = parse(before[id]);
    const b = parse(after[id]);
    if (!a || !b) { hard.push({ id, before: before[id], after: after[id], why: 'unparseable' }); continue; }
    if (core(a) !== core(b)) {
      hard.push({ id, why: 'timing/pitch', before: core(a), after: core(b) });
      continue;
    }
    const ia = JSON.stringify(a.notationIntent ?? null);
    const ib = JSON.stringify(b.notationIntent ?? null);
    if (ia !== ib) {
      if (ia !== 'null' && ib === 'null') soft.push({ id, why: 'intent-retired', intent: ia });
      else hard.push({ id, why: 'intent-invented-or-changed', before: ia, after: ib });
      continue;
    }
    // Some other field moved. Report it whole; the harness does not know what it means, and a
    // silent pass on an unknown field is how a new corruption channel stays invisible.
    hard.push({ id, why: 'other-field', before: before[id], after: after[id] });
  }
  return { hard, soft };
}

/**
 * Every invariant, evaluated over one settled snapshot (and the one before the burst for (a)).
 *
 * Returns a list of violations rather than throwing, so a single burst reports everything that is
 * wrong with it at once — a corruption that also breaks the projection is one fault, and seeing
 * both halves of it in the dump is what makes the mechanism guessable.
 */
function checkInvariants(before, after, allowed, wide, projectionMayMove = false) {
  const v = [];

  // (a) RAW BYTE-IDENTITY outside the authored set. `soft` is the documented intent retirement
  //     (see strayedRaw); it is reported on the run's tally and never failed on.
  const softNotes = [];
  if (!wide) {
    const { hard, soft } = strayedRaw(before.raw, after.raw, allowed);
    if (hard.length) v.push({ law: 'a/raw-corruption', detail: hard.slice(0, 12), count: hard.length });
    for (const s of soft) softNotes.push(s);
  }

  /*
   * (a2) THE DERIVED LAYER, WHICH IS WHERE THE OWNER'S FAULT ACTUALLY LIVES.
   *
   * Codex's race analysis §1: the recording is not the only thing an add can disturb, and under a
   * snap mode it is not even the likely one. `performanceFeed()` is the projection every consumer
   * reads — the roll's rectangles, the engraving, the sampler — and Beat snap is a GLOBAL
   * allocator, so an added attack can legitimately change how a NEIGHBOUR is allocated while the
   * recording underneath is untouched. That is exactly the shape of "I added a note and the notes
   * around it moved", and a raw-only invariant is blind to all of it.
   *
   * So the feed row of every pre-existing id is compared as well, by id, and by value rather than
   * by identity. Not asserted for `wide` bursts (undo/redo), and not for snap and grid flips —
   * those are the projection deliberately changing, which is the whole of what they do.
   */
  const reallocated = [];
  if (!wide && !projectionMayMove) {
    /*
     * WHAT BEAT IS ALLOWED TO DO TO A NOTE NOBODY TOUCHED, STATED EXACTLY.
     *
     * This law used to be all-or-nothing, and it had to be switched off (`--snap-modes=off,grid`)
     * to hunt anywhere else, because Beat is a global allocator and fires it on almost every add.
     * That is a real cost, but "almost every add" is not a law — it is a law nobody can read. The
     * adjudicated distinction is sharper than the old one and strictly stronger where it matters:
     *
     *   AN ONSET MAY MOVE under Beat. The allocator hands out slots on the pulse, and adding or
     *     removing an event genuinely changes which slot its neighbours get. That is the
     *     documented global cost the app already exempts (`ui/app.ts §the Beat exemption`).
     *     Counted and reported, never failed on.
     *   AN ARTICULATION MAY NOT. An allocator decides where a note stands, not how long it is
     *     held. A derived duration that changes for a note nobody edited is the collapse
     *     conviction C1's release translation exists to stop (`app/snap.ts §the release follows
     *     the attack it belongs to`), and it is a failure under every snap mode.
     *   A PITCH MAY NOT, under any mode. No snap has an opinion about pitch.
     *
     * Off and Grid keep the whole law: they map each note independently, so nothing an add does
     * may reach a neighbour at all.
     */
    const beat = before.snapMode === 'beat' && after.snapMode === 'beat';
    /*
     * …AND THE ONE SHORTENING THAT IS NOT A RESHAPING: A NOTE SQUEEZED BY ITS OWN SUCCESSOR.
     *
     * Beat may move an onset. If it moves one FORWARD and the next attack does not follow it, the
     * gap between them closes, and a note held to its full length would now overlap a note the
     * RECORDING did not overlap — two notes sounding at once where the player played one after the
     * other. `app/snap.ts` refuses that (its next-attack rule, which fires only where the raw take
     * itself had no overlap), so the note ends exactly AT the next derived attack. That is the
     * consequence of the permitted onset move, not a second liberty: the note is not reshaped by
     * an allocator, it is stopped by the note after it.
     *
     * AND THE SAME RULE RELAXING IS THE SAME EVENT. A note the cap was holding short goes back to
     * its own recorded length the moment the attack that was crowding it moves away — it is not
     * being stretched, it is stopping being squeezed. Refusing that would make the exemption
     * one-way and would fail the undo of every case it permits.
     *
     * Recognised, narrowly, by exactly that signature on the side it moved: SHORTER and now ending
     * at the next derived attack, or LONGER and previously ending at the next derived attack. A
     * length that changed while touching neither cap is a reshaping.
     */
    const attackFinder = (feed) => {
      const starts = Object.values(feed ?? {})
        .map((r) => r[0])
        .sort((a, b) => a - b);
      return (sec) => {
        for (const s of starts) if (s > sec + 1e-6) return s;
        return Number.POSITIVE_INFINITY;
      };
    };
    const nextAttackAfter = attackFinder(after.feed);
    const nextAttackBefore = attackFinder(before.feed);
    const drifted = [];
    for (const [id, row] of Object.entries(before.feed ?? {})) {
      if (allowed.includes(id)) continue;
      const now = (after.feed ?? {})[id];
      if (!now) continue;
      if (JSON.stringify(row) === JSON.stringify(now)) continue;
      // A MILLISECOND OF SLACK, and it is about the PROBE rather than about the music: the feed is
      // published rounded to four decimals, so a note translated by a whole step reports its two
      // ends rounded independently and its duration can differ in the last digit. A real
      // articulation change is a whole snap step — tens of milliseconds at any grid this app
      // offers — so a millisecond cannot hide one and does stop the rounding crying wolf.
      const grew = (now[1] - now[0]) - (row[1] - row[0]);
      const reshaped = Math.abs(grew) > 1e-3;
      const repitched = row[2] !== now[2];
      const squeezed = grew < 0 && Math.abs(now[1] - nextAttackAfter(now[0])) <= 1e-3;
      const released = grew > 0 && Math.abs(row[1] - nextAttackBefore(row[0])) <= 1e-3;
      if (beat && !repitched && (!reshaped || squeezed || released)) {
        reallocated.push({
          id, before: row, after: now,
          why: squeezed ? 'squeezed-by-next-attack' : released ? 'released-by-next-attack' : 'onset'
        });
        continue;
      }
      drifted.push({ id, before: row, after: now, why: repitched ? 'pitch' : reshaped ? 'articulation' : 'onset' });
    }
    if (drifted.length) {
      v.push({ law: 'a2/feed-row-moved', detail: drifted.slice(0, 12), count: drifted.length });
    }
  }

  /*
   * (a3) OBJECT IDENTITY BEHIND THE REVISION PAIR (Codex §1).
   *
   * `sheet.current` is `boundsRevision === modelRevision`, stamped in `onPostRender`. A late
   * post-render callback stamps the new number onto the previous engraving's bounds, so the pair
   * reads current while the bounds are stale — a clean-looking number over a dead lookup, which
   * is the dead-click mechanism. `apiScoreIsModel` and `boundsOwnScore` are reference
   * comparisons and cannot be faked by a stamp: see `TriView.revisionProbe`.
   */
  const sh = after.sheet;
  if (sh) {
    if (sh.apiScoreIsModel === false) {
      v.push({ law: 'a3/api-score-is-not-the-model', detail: { model: sh.model, bounds: sh.bounds } });
    }
    if (sh.boundsOwnScore === false) {
      v.push({ law: 'a3/bounds-belong-to-a-dead-score', detail: { foreignBars: sh.foreignBars, boundsBars: sh.boundsBars, current: sh.current } });
    }
  }

  /*
   * (a4) THE DOCUMENT'S ORIGIN IS THE DOCUMENT'S, NOT ITS CONTENT'S (conviction C3).
   *
   * `originSec` is written second 0 on the recording's clock. The roll subtracts it from every
   * rectangle it paints and `rippleMap()` phases the whole structural layer against it, so it is
   * not one number among many: it is the page's coordinate system. Derived on every rebuild as
   * `firstPerformedSec - firstWrittenSec`, BOTH of which are content, it moves whenever an edit
   * changes which note is played or engraved first — and then every untouched row on the page
   * moves with it, which is "I added a note and everything shifted" with no note having been
   * rewritten at all. Caught as seed 8020: an add mid-take re-phased the origin from 0.809 to
   * 0.536 and fifteen derived rows moved by exactly that difference.
   *
   * Not asserted for undo/redo (they are reversing the edit that set it) nor for snap/grid flips,
   * for the same reason (a2) is not: those are the projection deliberately changing.
   */
  if (!wide && !projectionMayMove) {
    const was = before.originSec;
    const now = after.originSec;
    if (typeof was === 'number' && typeof now === 'number' && Math.abs(now - was) > 1e-6) {
      v.push({ law: 'a4/written-origin-moved', detail: { before: was, after: now, deltaSec: Number((now - was).toFixed(6)) } });
    }
  }

  /*
   * (a5) THE APP'S OWN CLAIM ABOUT EACH TRANSACTION (the pre-commit ledger).
   *
   * (a) states the purity law over a BURST: nothing outside the burst's authored set may change.
   * That is one claim about two or three commands together, and a gesture that emits two commands
   * — the micro-resize a double-click swallowed — satisfies it by naming both notes. The ledger
   * splits the claim per transaction: `App.commitLog` records what the reducer said it authored
   * and what the recording says actually changed, computed inside the transaction.
   *
   * Stated over ADDS, where the law is absolute and needs no exception: a new note has no
   * pre-existing counterpart, so `changedExistingIds` must be empty. (A delete legitimately moves
   * `sourceBars` off the carrier it removed — `keepStructureCarriers` — which is a real exception
   * and is why this is not stated over every kind.)
   */
  const seenSeq = (before.commits ?? []).reduce((m, c) => Math.max(m, c.seq ?? 0), 0);
  for (const c of after.commits ?? []) {
    if ((c.seq ?? 0) <= seenSeq) continue;
    if (c.kind !== 'add') continue;
    const stray = (c.changedExistingIds ?? []).filter((id) => !(c.authoredIds ?? []).includes(id));
    if (stray.length) {
      v.push({
        law: 'a5/commit-changed-unauthored',
        detail: { seq: c.seq, kind: c.kind, label: c.label, authoredIds: c.authoredIds, stray }
      });
    }
  }

  // (b) PAINTED <-> RAW CORRESPONDENCE at quiescence
  if (after.paintedNullIds > 0) {
    v.push({ law: 'b/provisional-leftover', detail: { nullIdRects: after.paintedNullIds } });
  }
  // A held edit that survived settlement is an edit nobody will ever answer. See `busyNow`.
  if (after.heldEdit) v.push({ law: 'b/held-edit-leftover', detail: after.heldEdit });
  if (after.paintedDupes.length) {
    v.push({ law: 'b/painted-twice', detail: after.paintedDupes });
  }
  const feedSet = new Set(after.feedIds.filter(Boolean));
  const phantom = Object.keys(after.painted).filter((id) => !feedSet.has(id));
  if (phantom.length) v.push({ law: 'b/phantom-painted', detail: phantom.slice(0, 12), count: phantom.length });
  // …and where they agree, they must agree: a rectangle is the feed note's own span, once the
  // roll's origin is added back (see `rollOriginSec` — the two layers are in different clocks).
  const drift = [];
  const origin = after.rollOriginSec ?? 0;
  for (const [id, rect] of Object.entries(after.painted)) {
    const fed = after.feed[id];
    if (!fed) continue;
    if (Math.abs(rect[0] + origin - fed[0]) > 0.003 || Math.abs(rect[1] + origin - fed[1]) > 0.003 || rect[2] !== fed[2]) {
      drift.push({ id, painted: [rect[0], rect[1], rect[2]], origin, fed });
    }
  }
  if (drift.length) v.push({ law: 'b/painted-disagrees-with-feed', detail: drift.slice(0, 8), count: drift.length });

  // (c) PROJECTION TOTALITY
  const p = after.projection;
  if (!p) v.push({ law: 'c/no-projection', detail: null });
  else {
    if (p.engraved + p.merged + p.dropped !== p.total || p.total !== p.inputs) {
      v.push({ law: 'c/projection-totality', detail: p });
    }
    if (p.revision !== after.rev) v.push({ law: 'c/projection-revision', detail: { proj: p.revision, app: after.rev } });
  }
  if (after.duplicateIds && after.duplicateIds.length) {
    v.push({ law: 'c/duplicate-feed-ids', detail: after.duplicateIds });
  }

  // (d) SELECTION AUTHORITY
  const auth = after.sel ?? [];
  const rollSel = after.rollSel ?? [];
  const sheetSel = after.sheetSel ?? [];
  const silent = new Set(after.silent ?? []);
  if (auth.length !== rollSel.length || !auth.every((id) => rollSel.includes(id))) {
    v.push({ law: 'd/roll-selection-diverged', detail: { auth, roll: rollSel } });
  }
  const expectSheet = auth.filter((id) => !silent.has(id)).length;
  if (sheetSel.length < Math.min(1, expectSheet)) {
    v.push({ law: 'd/sheet-selection-empty', detail: { auth, sheet: sheetSel, silent: [...silent] } });
  }
  const stale = auth.filter((id) => !feedSet.has(id));
  if (stale.length) v.push({ law: 'd/selection-holds-dead-ids', detail: stale });

  if (softNotes.length || reallocated.length) {
    v.soft = [
      ...softNotes,
      ...(reallocated.length
        ? [{ why: 'beat-reallocated-onsets', count: reallocated.length, detail: reallocated.slice(0, 6) }]
        : [])
    ];
  }
  return v;
}

/** Pick the next action, resolved to concrete parameters, from the last settled snapshot. */
function chooseAction(r, geo, snap) {
  const painted = geo ? geo.painted : [];
  const rowH = geo ? geo.rowH : 8;
  const gutter = geo ? geo.gutterPx : 40;
  const width = geo ? geo.width : 900;
  const feedIds = (snap.feedIds ?? []).filter(Boolean);

  /*
   * THE WEIGHTS ARE NOT UNIFORM, and the reason is the brief: the reported fault is a ROLL ADD
   * corrupting its neighbours, so adds — and specifically adds stacked directly above and below
   * an existing note at the SAME onset, which is the case the owner describes — get the largest
   * share. The rest of the mix exists to move the app through the states an add can race with
   * (a rebuild from a snap flip, a re-layout from a zoom, a re-derivation from an undo).
   */
  const table = [
    ['addStacked', 26],
    ['addRandom', 12],
    ['move', 12],
    ['resize', 10],
    ['select', 8],
    ['delete', 6],
    ['dblDelete', 4],
    ['wheel', 8],
    ['snap', 5],
    ['grid', 4],
    ['undo', 4],
    ['redo', 3],
    ['sheetMenu', 4]
  ];
  const total = table.reduce((s, [, wt]) => s + wt, 0);
  let roll_ = r() * total;
  let kind = 'addRandom';
  for (const [k, wt] of table) { roll_ -= wt; if (roll_ <= 0) { kind = k; break; } }

  const anyNote = painted.length ? r.pick(painted) : null;

  if ((kind === 'addStacked' || kind === 'addRandom') && !anyNote) kind = 'wheel';
  if ((kind === 'move' || kind === 'resize' || kind === 'dblDelete') && !anyNote) kind = 'wheel';
  if ((kind === 'delete' || kind === 'select') && !feedIds.length) kind = 'wheel';

  switch (kind) {
    case 'addStacked': {
      /*
       * DIRECTLY ABOVE OR BELOW AN EXISTING NOTE, AT THE SAME ONSET. The owner's own description
       * of when it goes wrong, and the case with the most to disturb: a new note that shares an
       * attack with an existing one lands in the same chord event, the same bar, the same
       * quantisation decision — so a write-back that is one index out has an obvious neighbour to
       * damage. `x` is the existing rectangle's own left edge plus a pixel, so the onset is the
       * one on screen rather than one the harness computed.
       */
      const rows = r.pick([1, 1, 2, 3, -1, -1, -2, -3]);
      const y = anyNote.y + anyNote.h / 2 - rows * rowH;
      return {
        kind: 'add', tag: 'stacked', anchorId: anyNote.id, rows,
        x: Math.round(anyNote.x + 1), y: Math.round(y),
        alt: r.chance(0.25), gapMs: Math.round(r.range(8, 40)),
        // 2-5 px of hand wobble between the two presses, half the time. See dbl().
        driftX: r.chance(0.5) ? r.pick([2, 3, -2, -3, 4, 5]) : 0,
        driftY: r.chance(0.4) ? r.pick([2, -2, 3, -3]) : 0
      };
    }
    case 'addRandom': {
      const x = Math.round(r.range(gutter + 8, Math.max(gutter + 24, width - 12)));
      const y = Math.round(anyNote.y + anyNote.h / 2 + r.pick([-5, -4, -3, 3, 4, 5]) * rowH);
      return { kind: 'add', tag: 'random', x, y, alt: r.chance(0.25), gapMs: Math.round(r.range(8, 40)),
        // 2-5 px of hand wobble between the two presses, half the time. See dbl().
        driftX: r.chance(0.5) ? r.pick([2, 3, -2, -3, 4, 5]) : 0,
        driftY: r.chance(0.4) ? r.pick([2, -2, 3, -3]) : 0 };
    }
    case 'move': {
      const fromX = Math.round(anyNote.x + Math.max(2, anyNote.w * 0.4));
      const fromY = Math.round(anyNote.y + anyNote.h / 2);
      const dx = Math.round(r.range(-70, 70));
      const dy = Math.round(r.pick([0, 0, 0, rowH, -rowH, 2 * rowH, -2 * rowH]));
      return {
        kind: 'move', noteId: anyNote.id, fromX, fromY,
        toX: Math.max(gutter + 2, Math.min(width - 2, fromX + dx)), toY: fromY + dy,
        steps: 1 + r.int(4), holdMs: Math.round(r.range(4, 30)), alt: r.chance(0.2)
      };
    }
    case 'resize': {
      // Within RESIZE_GRIP_PX of the right edge is what arms a resize rather than a move.
      const fromX = Math.round(anyNote.x + anyNote.w - 2);
      const fromY = Math.round(anyNote.y + anyNote.h / 2);
      const dx = Math.round(r.range(-30, 110));
      return {
        kind: 'resize', noteId: anyNote.id, fromX, fromY,
        toX: Math.max(gutter + 2, Math.min(width - 2, fromX + dx)), toY: fromY,
        steps: 1 + r.int(3), holdMs: Math.round(r.range(4, 30)), alt: r.chance(0.2)
      };
    }
    case 'select': {
      const n = 1 + r.int(Math.min(3, feedIds.length));
      const ids = [];
      for (let i = 0; i < n; i++) ids.push(r.pick(feedIds));
      return { kind: 'select', ids: [...new Set(ids)] };
    }
    case 'delete': {
      const ids = [r.pick(feedIds)];
      return { kind: 'delete', ids, useBackspace: r.chance(0.5) };
    }
    case 'dblDelete':
      return {
        kind: 'dblDelete', noteId: anyNote.id,
        x: Math.round(anyNote.x + Math.max(2, anyNote.w / 2)),
        y: Math.round(anyNote.y + anyNote.h / 2),
        gapMs: Math.round(r.range(8, 40))
      };
    case 'wheel': {
      const overGutter = r.chance(0.2);
      return {
        kind: 'wheel',
        x: overGutter ? Math.round(r.range(2, Math.max(3, gutter - 2))) : Math.round(r.range(gutter + 8, Math.max(gutter + 20, width - 8))),
        y: Math.round(r.range(4, Math.max(8, geo ? geo.height - 4 : 120))),
        deltaY: Math.round(r.range(-240, 240)),
        ctrl: r.chance(0.25), shift: r.chance(0.25)
      };
    }
    case 'snap':
      // Restrictable, because Beat is a GLOBAL allocator and its derived re-placements fire the
      // (a2) law on almost every add — a real finding, but once caught it masks every other class.
      // '--snap-modes=off,grid' keeps the soak hunting where (a2) is supposed to hold absolutely.
      return { kind: 'snap', value: r.pick(SNAP_MODES) };
    case 'grid':
      return { kind: 'grid', value: r.pick(['quarter', 'eighth', 'triplet', 'sixteenth', 'thirtysecond', 'free', 'off']) };
    case 'undo':
      return { kind: 'undo' };
    case 'redo':
      return { kind: 'redo' };
    case 'sheetMenu':
      return { kind: 'sheetMenu', pickIndex: r.int(6), headIndex: r.int(8), menuMs: Math.round(r.range(80, 200)) };
    default:
      return { kind: 'wheel', x: 200, y: 40, deltaY: 100 };
  }
}

/** Which pre-existing raw ids this action is ALLOWED to rewrite, and whether (a) applies at all. */
function authorityOf(action, before, after) {
  switch (action.kind) {
    // A new id is absent from `before`, so nothing has to be excused: adds are fully strict.
    case 'add':
      return { allowed: [], wide: false };
    case 'select':
    case 'wheel':
    // SNAP AND GRID ARE PROJECTIONS, NOT WRITE-BACKS. "switching it back to Off restores the
    // recording exactly, because nothing was ever written over" — ui/app.ts, the snap control.
    // So they are strict on the recording, which is the strongest claim in this file after adds.
    case 'snap':
    case 'grid':
      return { allowed: [], wide: false };
    case 'delete':
    case 'dblDelete': {
      // Same reasoning as move/resize: a double-click delete removes whatever rectangle is
      // under the pointer, which is not necessarily the one a recorded coordinate was aimed at —
      // so the transaction's own claim is taken beside the harness's aim. See the ledger note
      // under 'move' below.
      const claimed = new Set([...(action.ids ?? [action.noteId]), ...(before.sel ?? [])]);
      for (const c of newCommits(before, after)) {
        if (c.kind !== 'delete' && c.kind !== 'deleteMany') continue;
        for (const id of c.authoredIds ?? []) claimed.add(id);
      }
      return { allowed: [...claimed], wide: false };
    }
    case 'move':
    case 'resize': {
      // The grabbed note, plus whatever the SELECTION was when the drag started (a grab inside a
      // multi-selection moves the whole group, by design), plus whatever the app itself claims to
      // have touched. An id in none of those changing is the failure.
      /*
       * THE NOTE THE APP SAYS IT GRABBED, not the one the harness aimed at.
       *
       * A plain press on a rectangle REPLACES the selection with that one note before any edit
       * is applied (pianoroll.ts, onPointerDown -- "A RECTANGLE AND EMPTY SPACE MEAN DIFFERENT
       * THINGS"), so the selection AFTER the gesture is the app's own statement of what the drag
       * was about. Trusting the recorded noteId instead cost a false positive that looked exactly
       * like the fault under investigation: a replayed coordinate landed on a neighbouring
       * rectangle, the app moved THAT note perfectly correctly, and the harness reported the
       * recording of an "untouched" id changing by 671 ms. In replay there is no fresh geometry
       * read to re-resolve the aim against, so this is not a nicety -- it is the only honest
       * source for the answer.
       */
      const claimed = new Set([
        ...(action.noteId ? [action.noteId] : []),
        ...(before.sel ?? []),
        ...(after.sel ?? []),
        ...(after.rippleWriteback ?? [])
      ]);
      for (const id of after.userTouched ?? []) if (!(before.userTouched ?? []).includes(id)) claimed.add(id);
      /*
       * …AND THE LEDGER, WHICH IS THE APP SAYING IT RATHER THAN THE HARNESS GUESSING IT.
       *
       * `userTouched` is a cumulative set, so its DELTA is empty for a note that had been edited
       * before — which is most notes late in a soak. The recorded `noteId` is the harness's AIM,
       * and a replayed coordinate lands on whatever rectangle is there now. Together those two
       * gaps produce a specific false positive that looks exactly like the fault under
       * investigation: seed 8020 step 159 aimed at `add41`, the app moved `add45` (correctly, and
       * said so), and the harness reported an untouched recording changing by 218 ms.
       *
       * `App.commitLog` is the transaction's own statement of what it authored, written inside the
       * transaction. It is the only honest source, and it is bounded to the rows this burst
       * produced — so a gesture that authored more than it should still fails law (a5).
       */
      for (const c of newCommits(before, after)) {
        if (c.kind !== 'move' && c.kind !== 'resize' && c.kind !== 'moveMany' && c.kind !== 'resizeMany') continue;
        for (const id of c.authoredIds ?? []) claimed.add(id);
      }
      return { allowed: [...claimed], wide: false };
    }
    case 'sheetMenu': {
      const claimed = new Set([...(before.sel ?? []), ...(after.rippleWriteback ?? [])]);
      for (const id of after.userTouched ?? []) if (!(before.userTouched ?? []).includes(id)) claimed.add(id);
      return { allowed: [...claimed], wide: false };
    }
    // Undo and redo REVERSE an earlier write, so they legitimately rewrite ids this step did not
    // author. (a) is skipped for them and only for them; (b), (c) and (d) still apply.
    case 'undo':
    case 'redo':
      return { allowed: [], wide: true };
    default:
      return { allowed: [], wide: true };
  }
}

const nowMs = () => Date.now();

// =============================================================================
// DRIVER
// =============================================================================

/**
 * A FRESH PAGE, AND A FRESH DOCUMENT BEHIND IT.
 *
 * `Page.navigate` alone is not a clean start: the app PERSISTS its settings, so a run inherits
 * the snap mode, the grid, the zoom and the pane heights the previous run happened to leave
 * behind. Measured, and it cost a headline: seed 8020 violated when it ran second in a session
 * and was clean when it ran first, with the identical RNG sequence — because the two runs began
 * from different snap modes. A seeded harness whose seeds are not independent is not a seeded
 * harness, so the storage is cleared between them and every run starts from the product default.
 *
 * The clear has to happen ON THE ORIGIN, which means a navigation first; the second navigation is
 * the one the run actually uses.
 */
async function boot(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await new Promise((o) => setTimeout(o, 250));
  await evalIn(cdp, '(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* opaque origin */ } return true; })()');
  await cdp.send('Page.navigate', { url });
  for (let i = 0; ; i++) {
    const ready = await evalIn(cdp, '!!window.__RIFFSHEET_DEMO_READY__ && (document.querySelector(".at-host .at-surface")?.childElementCount ?? 0) > 0');
    if (ready === true) break;
    if (i > 80) throw new Error('demo never became ready');
    await new Promise((o) => setTimeout(o, 200));
  }
  await new Promise((o) => setTimeout(o, 900));
  await evalIn(cdp, SOAK_INSTALL);
}

async function evalIn(cdp, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval threw');
  return r.result.value;
}
const jsonIn = async (cdp, expr, awaitPromise = false) => {
  const v = await evalIn(cdp, expr, awaitPromise);
  return typeof v === 'string' ? JSON.parse(v) : v;
};

/*
 * `JSON.stringify` GOES INSIDE THE `.then`, NOT AROUND THE CALL.
 *
 * `Runtime.evaluate` with `awaitPromise` awaits the value the EXPRESSION produced. Wrapping an
 * async call in `JSON.stringify(...)` produces the string "{}" — a Promise has no own enumerable
 * properties — instantly and synchronously, so there is nothing left to await and the harness
 * reads an empty object as the answer. Measured: every `quiesce` returned `{}`, which parses to
 * `ok: undefined`, so the very first step of every run reported a quiescence timeout with no
 * reason attached. The stringify has to happen on the RESOLVED value.
 */
const asyncJson = (cdp, expr) => jsonIn(cdp, `(${expr}).then((v) => JSON.stringify(v ?? null))`, true);

const snapshot = (cdp) => jsonIn(cdp, 'JSON.stringify(window.__SOAK.snapshot())');
const geometry = (cdp) => jsonIn(cdp, 'JSON.stringify(window.__SOAK.geometry())');
const quiesce = (cdp, ms) => asyncJson(cdp, `window.__SOAK.quiesce(${ms})`);
const busy = (cdp) => evalIn(cdp, 'window.__SOAK.busy()');
const doAct = (cdp, a) => asyncJson(cdp, `window.__SOAK.act(${JSON.stringify(a)})`);

/**
 * Resolve the two actions whose parameters cannot be chosen without asking the page: a sheet
 * right-click needs a notehead's CLIENT position, and the menu label it will pick has to be one
 * the menu is actually offering.
 */
async function resolveSheetMenu(cdp, action) {
  const heads = await jsonIn(cdp, 'JSON.stringify(window.__SOAK.heads())');
  const notation = (heads ?? []).filter((h) => h.staff === 'notation');
  if (!notation.length) return null;
  const head = notation[action.headIndex % notation.length];
  const clientX = Math.round(head.x);
  const clientY = Math.round(head.y);
  /*
   * THE MENU IS OPENED ONCE TO SEE WHAT IT OFFERS, and the recorded action opens it again and
   * picks. Two openings rather than one, because the LOG has to replay without this lookup: a
   * replay must depend only on the label the choice resolved to, never on the state that made
   * the choice. The first opening changes nothing but which menu is up, and the second
   * right-click replaces it.
   */
  const menu = await asyncJson(cdp, `window.__SOAK.openMenu(${clientX}, ${clientY}, ${action.menuMs})`);
  const items = (menu?.items ?? []).filter((i) => !i.disabled && i.label);
  if (!items.length) return null;
  const label = items[action.pickIndex % items.length].label;
  return { ...action, clientX, clientY, label };
}

async function runSeed(cdp, seed, steps, opts) {
  const r = rng(seed);
  const log = [];
  const url = `http://127.0.0.1:${PORT}/index.html?demo=${DEMO}&bars=${BARS}&tab=bass&verify=1`;
  await boot(cdp, url);

  let before = await snapshot(cdp);
  const timings = { injected: 0, quiesced: 0, quiesceTimeouts: 0, leftBusy: 0, bursts: 0, maxWaitMs: 0, sumWaitMs: 0 };
  let step = 0;

  while (step < steps) {
    /*
     * ONE READING OF THE SCREEN PER BURST, and the burst is aimed entirely at that reading.
     *
     * This is not a shortcut around asking again — it is what a hand working quickly actually
     * does. You look at the roll, then make two or three gestures at what you saw; you do not
     * re-read the screen between the second click and the third. It is also the only way the
     * follow-up gestures can arrive fast enough to land inside the previous engrave: a CDP round
     * trip per gesture puts a floor of several milliseconds under the gap, and this fixture's
     * engrave completes in about thirty.
     */
    const geo = await geometry(cdp);
    const burst = [];
    const want = Math.min(steps - step, r.chance(opts.inject) ? 2 + r.int(2) : 1);
    for (let k = 0; k < want; k++) {
      let action = chooseAction(r, geo, before);
      if (action.kind === 'sheetMenu') {
        // The menu's own labels can only be discovered by opening it, which cannot be done from
        // inside a burst without a round trip — so a menu edit is always a burst of its own.
        if (k > 0) { action = { kind: 'wheel', x: 200, y: 40, deltaY: 100 }; }
        else {
          const resolved = await resolveSheetMenu(cdp, action);
          action = resolved ?? { kind: 'wheel', x: 200, y: 40, deltaY: 100 };
        }
      }
      /*
       * THE JITTER IS PART OF THE EVENT, not the harness's pacing, so it is logged with it and
       * replayed with it.
       *
       * TWO BANDS. The gesture that OPENS a burst waits 0-400 ms — the band a hand works in, and
       * wide enough that most of the run is ordinary use. The ones that CHASE it wait 0-30 ms,
       * which is inside the engrave rather than after it. With a single 0-400 ms band the probe
       * measured zero gestures landing mid-rebuild over forty steps while the app really did
       * leave a window open on two of them: the window existed, and waiting a uniform random
       * quarter-second closed it before the harness could fire into it.
       */
      action.preDelayMs = k === 0
        ? Math.round(r.range(0, 400))
        // Zero more often than not. Measured on this fixture: the whole engrave — model rebuilt,
        // bounds caught up, provisional rectangle replaced — lands inside about 30-50 ms, so a
        // uniform 0-30 ms chase is a coin flip on whether it arrives during or after. A zero-delay
        // chase arrives in the next microtask, which is the only way to be sure.
        : (r.chance(0.6) ? 0 : Math.round(r.range(1, 25)));
      action.settled = k === want - 1;
      burst.push(action);
    }

    const t0 = nowMs();
    const outcomes = await asyncJson(cdp, `window.__SOAK.actMany(${JSON.stringify(burst)})`);
    const ms = nowMs() - t0;

    let burstAllowed = new Set();
    let burstWide = false;
    burst.forEach((action, k) => {
      const outcome = (outcomes ?? [])[k] ?? null;
      const wasBusy = !!(outcome && outcome.busyBefore);
      if (wasBusy) timings.injected++;
      if (outcome && outcome.busyAfter && outcome.busyAfter.busy) timings.leftBusy++;
      /*
       * THE LEDGER, per step: the gesture as delivered, the lifecycle state either side of it, and
       * the gate a replay must reproduce. 'gate' is what makes the log a regression rather than a
       * recording — see actMany.
       */
      log.push({
        step: step + k, burst: timings.bursts, ...action,
        gate: { busy: wasBusy, maxWaitMs: 400 },
        injectedIntoRebuild: wasBusy,
        lifecycle: outcome ? { before: outcome.busyBeforeWhy ?? null, after: outcome.busyAfter ?? null } : null,
        outcome, ms
      });
      const auth = authorityOf(action, before, before);
      for (const id of auth.allowed) burstAllowed.add(id);
      burstWide = burstWide || auth.wide;
    });
    timings.bursts++;
    const lastStep = step + burst.length - 1;
    step += burst.length;

    const q = await quiesce(cdp, 6000);
    if (!q.ok) timings.quiesceTimeouts++; else timings.quiesced++;
    timings.maxWaitMs = Math.max(timings.maxWaitMs, q.waitedMs ?? 0);
    timings.sumWaitMs += q.waitedMs ?? 0;
    const after = await snapshot(cdp);

    // The authored set is recomputed with the SETTLED `after` in hand, because the app's own
    // claim about what it touched (`userTouched`, `rippleWriteback`) is only final once it has.
    for (const action of burst) {
      const finalAuth = authorityOf(action, before, after);
      for (const id of finalAuth.allowed) burstAllowed.add(id);
    }

    const projectionMayMove = burst.some((a) => a.kind === 'snap' || a.kind === 'grid');
    const violations = checkInvariants(before, after, [...burstAllowed], burstWide, projectionMayMove);
    if (!q.ok) violations.push({ law: 'quiescence-timeout', detail: q.why, waitedMs: q.waitedMs });

    if (violations.length) {
      return {
        seed, failedAtStep: lastStep, burstFrom: lastStep - burst.length + 1, violations, log,
        before, after, allowed: [...burstAllowed], wide: burstWide, timings
      };
    }

    before = after;
    if (VERBOSE && timings.bursts % 20 === 0) {
      console.log(`      seed ${seed} step ${lastStep}  raw=${Object.keys(after.raw ?? {}).length} painted=${Object.keys(after.painted).length} rev=${after.rev} injected=${timings.injected}`);
    }
  }
  return { seed, failedAtStep: null, log, timings, before };
}

/**
 * Re-fire a recorded log, exactly — same bursts, same delays — and report whether it still fails.
 *
 * The bursts are reconstructed from the `settled` flag each step carries, and each one is handed
 * to the page in a single call, because the gap between two gestures is the experiment.
 */
async function replayLog(cdp, record, opts) {
  const url = `http://127.0.0.1:${PORT}/index.html?demo=${DEMO}&bars=${BARS}&tab=bass&verify=1`;
  await boot(cdp, url);
  let before = await snapshot(cdp);
  const entries = record.log;
  let i = 0;
  while (i < entries.length) {
    const burst = [];
    while (i < entries.length) {
      const a = entries[i++];
      burst.push(a);
      if (a.settled ?? true) break;
    }
    await asyncJson(cdp, `window.__SOAK.actMany(${JSON.stringify(burst)})`);
    let burstAllowed = new Set();
    let burstWide = false;
    for (const a of burst) {
      const auth = authorityOf(a, before, before);
      for (const id of auth.allowed) burstAllowed.add(id);
      burstWide = burstWide || auth.wide;
    }
    const q = await quiesce(cdp, 6000);
    const after = await snapshot(cdp);
    for (const a of burst) {
      const finalAuth = authorityOf(a, before, after);
      for (const id of finalAuth.allowed) burstAllowed.add(id);
    }
    const projectionMayMove = burst.some((a) => a.kind === 'snap' || a.kind === 'grid');
    const violations = checkInvariants(before, after, [...burstAllowed], burstWide, projectionMayMove);
    if (!q.ok) violations.push({ law: 'quiescence-timeout', detail: q.why });
    if (violations.length) {
      return { reproduced: true, atStep: burst[burst.length - 1].step, violations, before, after };
    }
    before = after;
  }
  return { reproduced: false };
}

/**
 * SHRINK A FAILING LOG to the shortest prefix that still fails.
 *
 * A prefix bisect and not a delta-debug over arbitrary subsets, deliberately: the log is a
 * sequence of gestures against evolving state, and removing a step from the MIDDLE changes what
 * every later step's recorded coordinates land on — the "minimised" log would then be a different
 * experiment wearing the original's numbers. A prefix keeps every remaining step's context
 * exactly as it was recorded, so a shorter prefix that still fails is a real reduction.
 */
async function shrink(cdp, record, opts) {
  let lo = 1;
  let hi = record.log.length;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = { ...record, log: record.log.slice(0, mid) };
    let hit = false;
    for (let attempt = 0; attempt < opts.attempts; attempt++) {
      const res = await replayLog(cdp, candidate, opts);
      if (res.reproduced) { hit = true; best = { length: mid, res }; break; }
    }
    if (hit) hi = mid - 1; else lo = mid + 1;
  }
  return best;
}

// -----------------------------------------------------------------------------
// THE CONVICTION GATES — one caught failure each, frozen as a deterministic case
// -----------------------------------------------------------------------------
/*
 * WHY THESE EXIST BESIDE THE SOAK AND THE MATRIX.
 *
 * The soak found the faults by firing two hundred randomly-timed gestures and comparing whole
 * states; the matrix found one of them in a single gesture. Neither is a REGRESSION: a random run
 * that goes green tomorrow may simply not have drawn the failing sequence, and a matrix cell is a
 * statement about one axis. A gate is the smallest scripted gesture that reproduces a fault whose
 * MECHANISM is now known, asserted against the smallest law that mechanism breaks — so it can be
 * run red before the fix, green after it, and red again the day somebody re-opens the hole.
 *
 * Each one names the evidence it was distilled from:
 *
 *   C1  anchored adds under Beat at 25/40 ms — `anchored-matrix.json` cells 52/54/56-59. Beyond
 *       the 20 ms chord window the added attack becomes a separate event, gets its own slot, and
 *       the allocator re-places (and, before the release-translation fix, re-shapes) the note the
 *       player was aiming beside.
 *   C2  a micro-resize swallowed by a double-click — `soak-15939.json` step 140. Re-expressed as a
 *       DIRECT scripted case rather than replayed, because the cause is now known exactly: the
 *       press lands in the note's right-edge resize grip, travels DRAG_SLOP_PX, and the pointerup
 *       commits a resize that the dblclick then follows with a second edit. A replay would carry
 *       139 irrelevant steps and their timing; the case is three parameters.
 *   C3  an add re-phasing the document's origin — `soak-8020.json` step 82, origin 0.809 -> 0.536.
 *       Scripted rather than replayed on purpose: the MINIMISED 8020 log stops on an earlier
 *       raw-corruption violation (`replay-dump.json`), so it is not a gate for this fault at all.
 *   N2  a part that asks for tablature and is not given any — the missing second tab.
 */

/** Every pre-existing rectangle that is not where it was. The owner's sentence, as a function. */
function rectDriftOf(before, after, exceptIds = []) {
  const skip = new Set(exceptIds);
  const out = [];
  for (const [id, was] of Object.entries(before.painted ?? {})) {
    if (skip.has(id)) continue;
    const now = (after.painted ?? {})[id];
    if (!now) { out.push({ id, was, now: null, why: 'rectangle vanished' }); continue; }
    if (JSON.stringify(was.slice(0, 3)) !== JSON.stringify(now.slice(0, 3))) out.push({ id, was, now });
  }
  return out;
}

/** The ledger rows this step produced. See `App.commitLog`. */
const newCommits = (before, after) => {
  const seen = (before.commits ?? []).reduce((m, c) => Math.max(m, c.seq ?? 0), 0);
  return (after.commits ?? []).filter((c) => (c.seq ?? 0) > seen);
};

/** Zoom the time axis in through the app's own gesture, so a pixel is worth a few milliseconds. */
async function zoomIn(cdp, notches) {
  for (let i = 0; i < notches; i++) {
    await doAct(cdp, { kind: 'wheel', x: 300, y: 8, deltaY: -120 });
    await quiesce(cdp, 3000);
  }
}

/**
 * C2 — ONE USER GESTURE, ONE HISTORY ENTRY.
 *
 * The press lands inside the target's right-edge resize grip (`RESIZE_GRIP_PX`, view/pianoroll.ts),
 * travels exactly `DRAG_SLOP_PX`, releases, and is followed by the second press and the dblclick
 * of one native double-click. Under today's contract the point was ON a note when the gesture
 * began, so the whole gesture means DELETE — one command, one ledger row, one undo step.
 */
async function gateGestureAtomicity(cdp, url) {
  const name = 'C2/gesture-atomicity';
  await boot(cdp, url);
  await doAct(cdp, { kind: 'snap', value: 'off' });
  await quiesce(cdp, 6000);
  // 'free' so `PianoRoll.snap()` is the identity and three pixels of travel is three pixels of
  // length rather than a value rounded back onto the grid — the fault, not a grid decision.
  await doAct(cdp, { kind: 'grid', value: 'free' });
  await quiesce(cdp, 6000);
  await zoomIn(cdp, 4);

  const geo = await geometry(cdp);
  if (!geo || geo.painted.length < 3) return { name, error: 'not enough painted notes' };
  const mid = geo.painted
    .slice()
    .sort((a, b) => a.x - b.x)
    .filter((r, i, all) => i > 0 && i < all.length - 1 && r.w >= 12);
  if (!mid.length) return { name, error: 'no interior rectangle wide enough to grip' };
  const target = mid[Math.floor(mid.length / 2)];

  const before = await snapshot(cdp);
  const x = Math.round(target.x + target.w - 3);
  const y = Math.round(target.y + target.h / 2);
  await doAct(cdp, { kind: 'add', tag: 'atomicity', x, y, alt: false, gapMs: 14, driftX: 3, driftY: 0 });
  const q = await quiesce(cdp, 8000);
  const after = await snapshot(cdp);

  const violations = [];
  if (!q.ok) violations.push({ law: 'quiescence-timeout', detail: q.why });

  // ONE TRANSACTION. Two rows is the fault itself: a resize the player never asked for, followed
  // by the double-click's own edit.
  const commits = newCommits(before, after);
  if (commits.length !== 1) {
    violations.push({
      law: 'C2/one-gesture-one-commit',
      detail: { commits: commits.map((c) => ({ seq: c.seq, kind: c.kind, label: c.label, authoredIds: c.authoredIds, changedExistingIds: c.changedExistingIds })) }
    });
  }
  // …AND IT IS THE ONE THE PRE-GESTURE HIT ASKED FOR. The point was on `target` when the first
  // press landed, so the gesture is a delete of `target` and nothing else.
  const only = commits[commits.length - 1] ?? null;
  if (!only || only.kind !== 'delete' || (only.removedIds ?? []).join() !== target.id) {
    violations.push({
      law: 'C2/edit-is-the-pre-gesture-hit',
      detail: { expectedDeleteOf: target.id, got: only ? { kind: only.kind, removedIds: only.removedIds, addedIds: only.addedIds } : null }
    });
  }
  const gained = Object.keys(after.feed ?? {}).filter((id) => !(id in (before.feed ?? {})));
  if (gained.length) violations.push({ law: 'C2/gesture-also-added', detail: gained });
  const { hard } = strayedRaw(before.raw, after.raw, [target.id]);
  if (hard.length) violations.push({ law: 'C2/raw-corruption', detail: hard.slice(0, 8), count: hard.length });
  const drift = rectDriftOf(before, after, [target.id]);
  if (drift.length) violations.push({ law: 'C2/neighbour-rect-moved', detail: drift.slice(0, 8), count: drift.length });

  // EXACT UNDO. One gesture, one ⌘Z, and the recording is byte-identical to what it was.
  await doAct(cdp, { kind: 'undo' });
  await quiesce(cdp, 8000);
  const undone = await snapshot(cdp);
  const back = strayedRaw(before.raw, undone.raw, []).hard;
  const missing = Object.keys(before.raw ?? {}).filter((id) => !(id in (undone.raw ?? {})));
  if (back.length || missing.length) {
    violations.push({ law: 'C2/undo-not-exact', detail: { changed: back.slice(0, 8), missing: missing.slice(0, 8) } });
  }

  return { name, target: target.id, violations, before: violations.length ? before : null, after: violations.length ? after : null };
}

/**
 * C3 — THE DOCUMENT'S ORIGIN IS NOT A FUNCTION OF ITS CONTENT.
 *
 * Written second 0 on the recording's clock is derived on every rebuild as
 * `firstPerformedSec - firstWrittenSec`, and BOTH ends are content that an ordinary edit moves.
 * Three scripted cases, all under Snap Off where nothing but the note being edited is allowed to
 * move, and all asserting the same thing: the origin did not move, and therefore neither did any
 * rectangle the player was not editing.
 *
 *   before-first  an add in the take's LEADING SILENCE, well before the first attack. It moves
 *                 `firstPerformedSec` outright, and — because the pipeline then has to find a bar
 *                 for it — usually re-phases `firstWrittenSec` by a different amount.
 *   stacked       seed 8020's own gesture: an interior stacked add, which moved the origin from
 *                 0.809 to 0.536 by re-phasing the ENGRAVING while the recording stood still.
 *   delete-first  the same defect from the other side and the sharpest form of it: remove the
 *                 first note and BOTH ends jump to the second one — by the raw gap on one side and
 *                 by the WRITTEN gap on the other, which are not the same number under
 *                 quantization. Nothing about the remaining notes changed, and the whole page
 *                 re-phases.
 */
async function gateOriginPinned(cdp, url, where) {
  const name = `C3/origin-pinned-${where}`;
  await boot(cdp, url);
  await doAct(cdp, { kind: 'snap', value: 'off' });
  await quiesce(cdp, 6000);
  await zoomIn(cdp, 3);

  const geo = await geometry(cdp);
  if (!geo || geo.painted.length < 3) return { name, error: 'not enough painted notes' };
  const byX = geo.painted.slice().sort((a, b) => a.x - b.x);
  const rowH = geo.rowH || 8;

  // --- the delete case: no geometry to aim, just the take's own earliest note ---------------
  if (where === 'delete-first') {
    const first = byX[0];
    const before = await snapshot(cdp);
    await doAct(cdp, { kind: 'delete', ids: [first.id], useBackspace: false });
    const q = await quiesce(cdp, 8000);
    const after = await snapshot(cdp);
    const violations = [];
    if (!q.ok) violations.push({ law: 'quiescence-timeout', detail: q.why });
    if (first.id in (after.feed ?? {})) violations.push({ law: 'C3/delete-did-nothing', detail: { id: first.id } });
    const was = before.originSec;
    const now = after.originSec;
    if (typeof was === 'number' && typeof now === 'number' && Math.abs(now - was) > 1e-6) {
      violations.push({ law: 'C3/origin-moved', detail: { before: was, after: now, deltaSec: Number((now - was).toFixed(6)) } });
    }
    const drift = rectDriftOf(before, after, [first.id]);
    if (drift.length) violations.push({ law: 'C3/neighbour-rect-moved', detail: drift.slice(0, 8), count: drift.length });
    return { name, deletedId: first.id, originBefore: before.originSec, originAfter: after.originSec, violations, before: violations.length ? before : null, after: violations.length ? after : null };
  }

  const anchor = where === 'before-first' ? byX[0] : byX[Math.floor(byX.length / 2)];
  /*
   * WHERE THE NEW NOTE GOES.
   *
   * For `before-first`, as far into the LEAD-IN as the pane allows rather than a rectangle's width
   * to the left of the first note: at this zoom a note's width is a few tens of milliseconds, and
   * an attack that early still lands in the same bar, on the same beat, with the same barring — so
   * `firstPerformedSec` and `firstWrittenSec` move by the same amount and their difference does
   * not. The fault is about the two ends moving by DIFFERENT amounts, which needs a gap the
   * engraver has to find room for.
   */
  const x = where === 'before-first'
    ? Math.round((geo.gutterPx ?? 40) + 6)
    : Math.round(anchor.x + 1);
  let y = null;
  for (let k = where === 'before-first' ? 0 : 1; k <= 7; k++) {
    const candidate = Math.round(anchor.y + anchor.h / 2 - k * rowH);
    if ((await evalIn(cdp, `window.__SOAK.occupiedAt(${x}, ${candidate})`)) === false) { y = candidate; break; }
  }
  if (y === null) return { name, error: 'no empty row to add into' };

  const before = await snapshot(cdp);
  await doAct(cdp, { kind: 'add', tag: 'origin', x, y, alt: where !== 'before-first', gapMs: 14, driftX: 0, driftY: 0 });
  const q = await quiesce(cdp, 8000);
  const after = await snapshot(cdp);
  const addedId = Object.keys(after.feed ?? {}).find((id) => !(id in (before.feed ?? {}))) ?? null;

  const violations = [];
  if (!q.ok) violations.push({ law: 'quiescence-timeout', detail: q.why });
  if (!addedId) violations.push({ law: 'C3/add-did-nothing', detail: { before: Object.keys(before.feed ?? {}).length, after: Object.keys(after.feed ?? {}).length } });
  const was = before.originSec;
  const now = after.originSec;
  if (typeof was === 'number' && typeof now === 'number' && Math.abs(now - was) > 1e-6) {
    violations.push({ law: 'C3/origin-moved', detail: { before: was, after: now, deltaSec: Number((now - was).toFixed(6)) } });
  }
  const drift = rectDriftOf(before, after, addedId ? [addedId] : []);
  if (drift.length) violations.push({ law: 'C3/neighbour-rect-moved', detail: drift.slice(0, 8), count: drift.length });
  const { hard } = strayedRaw(before.raw, after.raw, addedId ? [addedId] : []);
  if (hard.length) violations.push({ law: 'C3/raw-corruption', detail: hard.slice(0, 8), count: hard.length });
  for (const c of newCommits(before, after)) {
    const stray = (c.changedExistingIds ?? []).filter((id) => !(c.authoredIds ?? []).includes(id));
    if (stray.length) violations.push({ law: 'C3/commit-changed-unauthored', detail: { seq: c.seq, kind: c.kind, stray } });
  }

  return { name, addedId, originBefore: before.originSec, originAfter: after.originSec, violations, before: violations.length ? before : null, after: violations.length ? after : null };
}

/**
 * C3 — THE ORIGIN IS A PROPERTY OF THE DOCUMENT, AND THE PAGE USES THAT ONE.
 *
 * The three cases above assert the CONSEQUENCE (nothing moved) and are the permanent regression
 * gates; this asserts the MECHANISM, and it is the cell that is red before the fix. The reason the
 * distinction is worth two gates is written into `soak-8020.json`: the origin moved there after
 * eighty-two steps had accumulated a ripple log and a re-barred engraving, and no single scripted
 * gesture on a pristine metronomic fixture reproduces that state. What CAN be stated in one
 * assertion, and what the conviction actually is, is that
 * `firstPerformedSec - firstWrittenSec` is not an authority: both ends are content, so any edit
 * that changes which note is played or engraved first re-phases the whole page. A document that
 * carries its own `writtenOriginAudioSec` cannot have that happen to it, whatever the content
 * does, and the page must be reading THAT number rather than re-deriving one beside it.
 *
 * Checked again after an ordinary add, because a stored value nothing reads is not a fix.
 */
async function gateOriginIsADocumentProperty(cdp, url) {
  const name = 'C3/origin-is-a-document-property';
  await boot(cdp, url);
  await doAct(cdp, { kind: 'snap', value: 'off' });
  await quiesce(cdp, 6000);
  const read = () => jsonIn(cdp, 'JSON.stringify(window.__RIFFSHEET_SHEETEDIT__())');

  const violations = [];
  const at = (sh, when) => {
    const stored = sh?.writtenOriginAudioSec;
    if (stored === null || stored === undefined) {
      violations.push({ law: 'C3/no-stored-origin', detail: { when, originSec: sh?.originSec ?? null } });
      return;
    }
    if (Math.abs(stored - (sh.originSec ?? 0)) > 1e-6) {
      violations.push({ law: 'C3/page-not-using-stored-origin', detail: { when, originSec: sh.originSec, stored } });
    }
  };
  const first = await read();
  at(first, 'at-open');

  const geo = await geometry(cdp);
  if (geo && geo.painted.length >= 3) {
    const byX = geo.painted.slice().sort((a, b) => a.x - b.x);
    const anchor = byX[Math.floor(byX.length / 2)];
    const rowH = geo.rowH || 8;
    const x = Math.round(anchor.x + 1);
    let y = null;
    for (let k = 1; k <= 7; k++) {
      const candidate = Math.round(anchor.y + anchor.h / 2 - k * rowH);
      if ((await evalIn(cdp, `window.__SOAK.occupiedAt(${x}, ${candidate})`)) === false) { y = candidate; break; }
    }
    if (y !== null) {
      await doAct(cdp, { kind: 'add', tag: 'origin-property', x, y, alt: false, gapMs: 14, driftX: 0, driftY: 0 });
      await quiesce(cdp, 8000);
      const after = await read();
      at(after, 'after-add');
      if (
        first?.writtenOriginAudioSec !== null && first?.writtenOriginAudioSec !== undefined &&
        after?.writtenOriginAudioSec !== null && after?.writtenOriginAudioSec !== undefined &&
        Math.abs(after.writtenOriginAudioSec - first.writtenOriginAudioSec) > 1e-9
      ) {
        violations.push({ law: 'C3/stored-origin-rewritten-by-an-edit', detail: { before: first.writtenOriginAudioSec, after: after.writtenOriginAudioSec } });
      }
    }
  }
  return { name, stored: first?.writtenOriginAudioSec ?? null, originSec: first?.originSec ?? null, violations };
}

/**
 * N=2 — A PART THAT ASKS FOR TABLATURE GETS TABLATURE.
 *
 * Two parts, deliberately different tunings (six strings and four), and the only question is
 * arithmetic: how many tracks requested a tab, and how many had one engraved. `decorationProbe()`
 * answers both off the built model and the rendered bounds respectively.
 */
async function gateEveryPartRendersItsTab(cdp, url) {
  const name = 'N2/every-part-renders-its-tab';
  await boot(cdp, url);
  const setup = await asyncJson(cdp, 'window.__RIFFSHEET_PARTSVISUAL__(2)');
  if (!setup || setup.error) return { name, error: setup?.error ?? 'PARTSVISUAL failed' };
  await evalIn(cdp, 'window.__SOAK.sleep(800)', true);
  const d = await jsonIn(cdp, 'JSON.stringify(window.__SOAK.decorations())');
  const violations = [];
  const tracks = d?.tracks ?? [];
  const requested = tracks.filter((t) => t.hasTab).length;
  const rendered = tracks.filter((t) => t.tabRendered).length;
  if (tracks.length !== 2) violations.push({ law: 'N2/track-count', detail: { tracks } });
  if (requested !== 2 || rendered !== requested) {
    violations.push({ law: 'N2/requested-tabs-not-rendered', detail: { requested, rendered, tracks } });
  }
  // The tuning lanes must belong to the tracks that were drawn, with the right number of letters.
  const lanes = d?.stringLanes ?? [];
  for (const t of tracks) {
    const mine = lanes.filter((l) => l.trackIndex === t.trackIndex);
    if (t.tabRendered && !mine.length) violations.push({ law: 'N2/legend-missing', detail: { trackIndex: t.trackIndex } });
    for (const lane of mine) {
      if (lane.letters !== t.strings) {
        violations.push({ law: 'N2/legend-wrong-string-count', detail: { trackIndex: t.trackIndex, strings: t.strings, letters: lane.letters, texts: lane.texts } });
      }
    }
  }
  await evalIn(cdp, 'window.__RIFFSHEET_PARTSRESET__ && window.__RIFFSHEET_PARTSRESET__()');
  return { name, requested, rendered, violations, decorations: violations.length ? d : null };
}

/** Every gate, in the order the fixes land. Returns one row per gate. */
async function convictionGates(cdp) {
  const url = `http://127.0.0.1:${PORT}/index.html?demo=${DEMO}&bars=${BARS}&tab=bass&verify=1`;
  const out = [];

  // C1 — the convicted anchored cells, and only those: Beat, beyond the 20 ms chord window.
  console.log('  GATE  C1/anchored-beat-25-40');
  const cells = await anchoredAddMatrix(cdp, { snaps: ['beat'], jitters: [25, 40] });
  const badCells = cells.filter((c) => !c.error && c.violations.length);
  out.push({
    name: 'C1/anchored-beat-25-40',
    cells: cells.length,
    skipped: cells.filter((c) => c.error).length,
    violations: badCells.map((c) => ({
      law: `C1/cell snap=${c.snap} jitter=${c.jitterMs}ms rows=${c.rows} ${c.free ? 'free' : 'snapped'} (achieved ${c.achievedJitterMs}ms)`,
      detail: c.violations.map((v) => v.law)
    })),
    cellDetail: badCells
  });

  console.log('  GATE  C2/gesture-atomicity');
  out.push(await gateGestureAtomicity(cdp, url));
  console.log('  GATE  C3/origin-pinned-before-first');
  out.push(await gateOriginPinned(cdp, url, 'before-first'));
  console.log('  GATE  C3/origin-pinned-stacked');
  out.push(await gateOriginPinned(cdp, url, 'stacked'));
  console.log('  GATE  C3/origin-pinned-delete-first');
  out.push(await gateOriginPinned(cdp, url, 'delete-first'));
  console.log('  GATE  C3/origin-is-a-document-property');
  out.push(await gateOriginIsADocumentProperty(cdp, url));
  console.log('  GATE  N2/every-part-renders-its-tab');
  out.push(await gateEveryPartRendersItsTab(cdp, url));
  return out;
}

// -----------------------------------------------------------------------------
// THE N=2 PARTS MINI-SOAK — the tuning leak
// -----------------------------------------------------------------------------
// THE ANCHORED-ADD MATRIX — the owner's literal gesture, stated as an assertion
// -----------------------------------------------------------------------------
/**
 * "ADD A NOTE DIRECTLY ABOVE OR BELOW AN EXISTING ONE AND NOTHING ELSE MOVES."
 *
 * This is not a soak. It is the owner's own gesture turned into a deterministic matrix, and it is
 * run FIRST because a fault that is reachable in one gesture should never be found by two hundred.
 * Random soaking finds races; this finds a law being broken in the open.
 *
 * WHAT THE MATRIX VARIES, and why each axis is there (Codex's race analysis §2):
 *
 *   SNAP MODE — off, grid, beat. These are three different theories of where a note goes and only
 *     one of them is local. `snap.ts` maps each note independently under Grid, so an added event
 *     cannot relocate an old one; BEAT IS A GLOBAL ALLOCATOR, so it can, and it is allowed to move
 *     a neighbour's derived placement. The prediction under test is that it moves it WRONGLY:
 *     attacks are grouped into one slot only when they fall within 20 ms of each other, so a new
 *     note snapped onto the pulse and a neighbour played 25 ms off it split into two slots, and
 *     the next-derived-attack rule then reshapes the neighbour.
 *
 *   ANCHOR JITTER — 0, 5, 15, 25, 40 ms off the anchor's recorded onset. The 20 ms grouping
 *     threshold sits inside that range on purpose: 0/5/15 ms should group, 25/40 ms should not, and
 *     the pair of results either side of the threshold is what turns "it sometimes breaks" into a
 *     boundary. The jitter is applied THROUGH THE INTERFACE — the roll's own free (Alt) drag, at a
 *     zoom chosen so that a millisecond is several pixels — so nothing here depends on a hook that
 *     can write the recording directly, and the ACHIEVED offset is measured and reported rather
 *     than assumed.
 *
 *   DIRECTION — the new note above the anchor and below it. Above and below are not symmetric:
 *     they land in different places in the chord's member order and in the stave's voice
 *     assignment, and a write-back that is one index out will only be wrong on one of them.
 *
 *   SNAPPED VS FREE ADD — the plain double-click and the Alt one. A plain add rounds to the ROLL
 *     GRID rather than anchoring to the target note's onset (pianoroll.ts, onDoubleClick §snap),
 *     so a near-simultaneous pair that is not quite a chord can engrave differently; the Alt add
 *     asks for the pointer's own second and takes that axis out of the experiment.
 *
 * THE ASSERTION IS ON THE DERIVED LAYER AS WELL AS THE RECORDING. Every pre-existing id must have
 * the same feed row (start, end, midi) and the same painted rectangle after the add as before it,
 * and the same recording bytes. The new note's own id is the only thing allowed to appear.
 */
async function anchoredAddMatrix(cdp, opts) {
  const url = `http://127.0.0.1:${PORT}/index.html?demo=${DEMO}&bars=${BARS}&tab=bass&verify=1`;
  const results = [];
  const snaps = opts.snaps ?? (argOf('snaps', '') ? argOf('snaps', '').split(',') : null) ?? ['off', 'grid', 'beat'];
  const jitters = opts.jitters ?? (argOf('jitters', '') ? argOf('jitters', '').split(',').map(Number) : null) ?? [0, 5, 15, 25, 40];
  const directions = opts.directions ?? [1, -1];
  const frees = opts.frees ?? [false, true];

  for (const snap of snaps) {
    for (const jitterMs of jitters) {
      for (const rows of directions) {
        for (const free of frees) {
          const cell = await anchoredCell(cdp, url, { snap, jitterMs, rows, free });
          results.push(cell);
          const tag = `snap=${snap} jitter=${jitterMs}ms rows=${rows > 0 ? '+' : ''}${rows} ${free ? 'free' : 'snapped'}`;
          if (cell.error) console.log(`  ANCHOR  ${tag}: skipped — ${cell.error}`);
          else if (cell.violations.length) {
            console.log(`  ANCHOR  ${tag}: VIOLATION (achieved jitter ${cell.achievedJitterMs}ms)`);
            for (const v of cell.violations) console.log(`      ${v.law}  ${JSON.stringify(v.detail ?? null).slice(0, 320)}`);
          } else console.log(`  ANCHOR  ${tag}: clean (achieved jitter ${cell.achievedJitterMs}ms, added ${cell.addedId ?? 'nothing'})`);
        }
      }
    }
  }
  return results;
}

/** One cell of the matrix, from a fresh page: jitter the anchor, add beside it, compare. */
async function anchoredCell(cdp, url, { snap, jitterMs, rows, free }) {
  await boot(cdp, url);
  // The snap mode first, so the jitter drag and the add both happen under the mode being tested.
  await doAct(cdp, { kind: 'snap', value: snap });
  await quiesce(cdp, 6000);

  /*
   * ZOOM THE TIME AXIS IN BEFORE MEASURING ANYTHING.
   *
   * The jitter has to be delivered in milliseconds through a gesture that speaks pixels, and at
   * the default window a pixel is several milliseconds — a 5 ms nudge would be a rounding error.
   * Zooming in first makes a millisecond worth several pixels, so the drag can ask for 5 ms and
   * land on it. The zoom is a real wheel over the ruler, which is the app's own gesture for it.
   */
  for (let i = 0; i < 6; i++) {
    await doAct(cdp, { kind: 'wheel', x: 300, y: 8, deltaY: -120 });
    await quiesce(cdp, 3000);
  }

  let geo = await geometry(cdp);
  let snapBefore = await snapshot(cdp);
  if (!geo || geo.painted.length < 4) return { snap, jitterMs, rows, free, error: 'not enough painted notes' };

  /*
   * THE ANCHOR IS A NOTE WITH A NEIGHBOUR ON EITHER SIDE and an empty row above and below it, so
   * the experiment has something to damage and somewhere to put the new note. Picked from the
   * middle of the frame rather than the first rectangle: the first note of a take is the origin,
   * and an origin note is a special case in the bar arithmetic that would confound the result.
   */
  const mid = geo.painted
    .slice()
    .sort((a, b) => a.x - b.x)
    .filter((r, i, all) => i > 0 && i < all.length - 1);
  if (!mid.length) return { snap, jitterMs, rows, free, error: 'no interior note to anchor on' };
  const anchor = mid[Math.floor(mid.length / 2)];

  // --- the jitter, through the interface ------------------------------------
  let achievedJitterMs = 0;
  if (jitterMs !== 0) {
    const secPerPx = geo.secPerPx ?? null;
    if (!secPerPx || !Number.isFinite(secPerPx) || secPerPx <= 0) {
      return { snap, jitterMs, rows, free, error: 'no time ruler to measure' };
    }
    const dx = Math.round((jitterMs / 1000) / secPerPx);
    if (dx === 0) return { snap, jitterMs, rows, free, error: `zoom too coarse for ${jitterMs}ms (secPerPx ${secPerPx})` };
    const y = Math.round(anchor.y + anchor.h / 2);
    // Alt, so the drag is FREE and the nudge is not swallowed by the very snap under test.
    await doAct(cdp, {
      kind: 'move', noteId: anchor.id,
      fromX: Math.round(anchor.x + Math.max(2, anchor.w * 0.4)), fromY: y,
      toX: Math.round(anchor.x + Math.max(2, anchor.w * 0.4) + dx), toY: y,
      steps: 3, holdMs: 8, alt: true
    });
    await quiesce(cdp, 6000);
    const afterJitter = await snapshot(cdp);
    /*
     * MEASURED ON THE RECORDING, NOT ON THE FEED — and this was a rig defect, not a nicety.
     *
     * The axis under test is the RAW distance between two attacks, because that is the only
     * number `snapPerformanceToBeat` groups on (its chord window is stated over `n.startSec` of
     * the input take). The feed is the SNAPPED derivation: under Beat a 25 ms nudge is rounded
     * straight back onto the same slot the anchor already occupies, so `feed` reports an achieved
     * jitter of 0 ms while the recording underneath really did move 25 ms. Every convicted Beat
     * cell therefore printed "achieved jitter 0ms" beside a violation caused by a jitter of 25 —
     * a rig that cannot state its own independent variable. `rawStarts` is the recording.
     */
    const was = (snapBefore.rawStarts ?? {})[anchor.id];
    const now = (afterJitter.rawStarts ?? {})[anchor.id];
    achievedJitterMs =
      typeof was === 'number' && typeof now === 'number' ? Math.round((now - was) * 1000) : 0;
    // The jitter is SETUP, not the experiment: the comparison baseline is taken after it.
    snapBefore = afterJitter;
    geo = await geometry(cdp);
  }

  const live = (geo.painted ?? []).find((r) => r.id === anchor.id);
  if (!live) return { snap, jitterMs, rows, free, achievedJitterMs, error: 'the anchor left the frame' };

  // --- the add, directly above or below the anchor, at the anchor's own onset
  /*
   * x IS THE ANCHOR'S OWN LEFT EDGE PLUS ONE PIXEL — the onset that is on screen, not one the
   * harness computed from a clock. y is a whole number of rows away from the anchor's centre, and
   * the roll is asked whether that row is empty before the gesture is aimed there.
   */
  const rowH = geo.rowH || 8;
  let y = null;
  for (let k = Math.abs(rows); k <= Math.abs(rows) + 6; k++) {
    const candidate = Math.round(live.y + live.h / 2 - Math.sign(rows) * k * rowH);
    const occupied = await evalIn(cdp, `window.__SOAK.occupiedAt(${Math.round(live.x + 1)}, ${candidate})`);
    if (occupied === false) { y = candidate; break; }
  }
  if (y === null) return { snap, jitterMs, rows, free, achievedJitterMs, error: 'no empty row beside the anchor' };

  const idsBefore = new Set(Object.keys(snapBefore.feed ?? {}));
  await doAct(cdp, {
    kind: 'add', tag: 'anchored', anchorId: anchor.id,
    x: Math.round(live.x + 1), y, alt: free, gapMs: 14, driftX: 0, driftY: 0
  });
  const q = await quiesce(cdp, 8000);
  const after = await snapshot(cdp);
  const addedId = Object.keys(after.feed ?? {}).find((id) => !idsBefore.has(id)) ?? null;

  const violations = checkInvariants(snapBefore, after, addedId ? [addedId] : [], false, false);
  if (!q.ok) violations.push({ law: 'quiescence-timeout', detail: q.why });
  if (!addedId) violations.push({ law: 'anchored/add-did-nothing', detail: { feedBefore: idsBefore.size, feedAfter: Object.keys(after.feed ?? {}).length } });

  /*
   * THE PAINTED LAYER, COMPARED DIRECTLY AS WELL. `checkInvariants` already asserts that each
   * rectangle agrees with its own feed row, which is a different claim: a rectangle can agree with
   * a feed row that has itself moved. This is the owner's sentence — "the rectangles around it
   * moved" — asserted as written.
   */
  const rectDrift = [];
  for (const [id, was] of Object.entries(snapBefore.painted ?? {})) {
    if (id === addedId) continue;
    const now = (after.painted ?? {})[id];
    if (!now) { rectDrift.push({ id, was, now: null, why: 'rectangle vanished' }); continue; }
    if (JSON.stringify(was.slice(0, 3)) !== JSON.stringify(now.slice(0, 3))) rectDrift.push({ id, was, now });
  }
  if (rectDrift.length) {
    violations.push({ law: 'anchored/neighbour-rect-moved', detail: rectDrift.slice(0, 10), count: rectDrift.length });
  }

  return {
    snap, jitterMs, rows, free, achievedJitterMs, addedId,
    anchorId: anchor.id,
    anchorFeedBefore: snapBefore.feed[anchor.id] ?? null,
    anchorFeedAfter: after.feed[anchor.id] ?? null,
    addedFeed: addedId ? after.feed[addedId] ?? null : null,
    violations,
    soft: violations.soft ?? null,
    before: violations.length ? snapBefore : null,
    after: violations.length ? after : null
  };
}

// -----------------------------------------------------------------------------
/*
 * A SEPARATE, MUCH SHORTER SOAK, because the fault has a different shape.
 *
 * `__RIFFSHEET_PARTSVISUAL__(2)` builds the exact two-part page the visual proof uses, with
 * DELIBERATELY DIFFERENT tunings per part (a six-string and a four-string). That difference is
 * the whole instrument: a legend that reads the wrong part's tuning is invisible when both parts
 * are tuned the same, which is why a single-part probe and a same-tuning probe both pass while
 * the fault is live. `decorationProbe()` publishes, per rendered system and per track, the open
 * string letters actually drawn and the number of strings the model says that track has — so
 * "the legend beside part B's tab is part A's tuning" becomes an arithmetic disagreement rather
 * than something somebody has to notice in a screenshot.
 *
 * The coherence law, per track, after every toggle:
 *   - a track whose tab was RENDERED has a string lane, and that lane has exactly as many letters
 *     as the track has strings;
 *   - a track whose tab was NOT rendered has no string lane at all (a legend beside a staff that
 *     was never drawn is the same fault from the other side);
 *   - no two tracks share a lane, and no lane names a track that does not exist.
 */
async function partsSoak(cdp, seed, steps) {
  const r = rng(seed);
  const url = `http://127.0.0.1:${PORT}/index.html?demo=${DEMO}&bars=${BARS}&tab=bass&verify=1`;
  await boot(cdp, url);
  const setup = await asyncJson(cdp, 'window.__RIFFSHEET_PARTSVISUAL__(2)');
  if (!setup || setup.error) return { seed, error: setup?.error ?? 'PARTSVISUAL failed', steps: 0 };
  await new Promise((o) => setTimeout(o, 600));

  const decorations = () => jsonIn(cdp, 'JSON.stringify(window.__SOAK.decorations())');
  const log = [];

  const coherence = (d) => {
    const bad = [];
    if (!d) return [{ law: 'parts/no-decorations' }];
    const tracks = d.tracks ?? [];
    const lanes = d.stringLanes ?? [];
    const byTrack = new Map();
    for (const lane of lanes) {
      const list = byTrack.get(lane.trackIndex) ?? [];
      list.push(lane);
      byTrack.set(lane.trackIndex, list);
    }
    for (const t of tracks) {
      const mine = byTrack.get(t.trackIndex) ?? [];
      /*
       * A TAB THAT WAS ASKED FOR AND NOT DRAWN IS A FAILURE, not a configuration.
       *
       * Every obligation below is conditioned on `tabRendered`, which is what the renderer
       * actually produced — so a part whose model says `showTablature` and whose page carries no
       * tab staff satisfies all of them vacuously: no lane is owed, none is present, coherent.
       * That is exactly the N=2 state (`TriView.load` engraved track 0 alone), and it is why a
       * mini-soak that ran for sixty toggles never said a word about the missing tablature. The
       * MODEL's request is the obligation; the render either meets it or the page is wrong.
       */
      if (t.hasTab && !t.tabRendered) {
        bad.push({ law: 'parts/tab-requested-not-rendered', detail: { trackIndex: t.trackIndex, strings: t.strings } });
      }
      if (t.tabRendered && mine.length === 0) {
        bad.push({ law: 'parts/legend-missing', detail: { trackIndex: t.trackIndex, strings: t.strings } });
      }
      if (!t.tabRendered && mine.length > 0) {
        bad.push({ law: 'parts/legend-without-tab', detail: { trackIndex: t.trackIndex, lanes: mine.map((l) => l.lane) } });
      }
      for (const lane of mine) {
        if (lane.letters !== t.strings) {
          bad.push({
            law: 'parts/legend-wrong-string-count',
            detail: { trackIndex: t.trackIndex, strings: t.strings, letters: lane.letters, texts: lane.texts, lane: lane.lane }
          });
        }
      }
    }
    // A LEAK IS TWO TRACKS WEARING THE SAME LETTERS while the model says they are tuned
    // differently. Stated over the letters actually drawn, per system, so a legend that is the
    // OTHER part's tuning is a straight string comparison.
    const sigByTrack = new Map();
    for (const lane of lanes) {
      const sig = lane.texts.join(' ');
      const seen = sigByTrack.get(lane.trackIndex);
      if (seen && seen !== sig) {
        bad.push({ law: 'parts/legend-inconsistent-across-systems', detail: { trackIndex: lane.trackIndex, a: seen, b: sig } });
      }
      sigByTrack.set(lane.trackIndex, sig);
    }
    const distinctStringCounts = new Set(tracks.filter((t) => t.tabRendered).map((t) => t.strings));
    if (distinctStringCounts.size > 1) {
      const sigs = [...sigByTrack.values()];
      if (sigs.length > 1 && new Set(sigs).size === 1) {
        bad.push({ law: 'parts/tuning-leak', detail: { sigs, tracks } });
      }
    }
    const known = new Set(tracks.map((t) => t.trackIndex));
    for (const lane of lanes) {
      if (lane.trackIndex === null || !known.has(lane.trackIndex)) {
        bad.push({ law: 'parts/lane-for-unknown-track', detail: lane });
      }
    }
    return bad;
  };

  const first = await decorations();
  if (VERBOSE) console.log(`      parts baseline: tracks=${JSON.stringify(first?.tracks)} lanes=${JSON.stringify((first?.stringLanes ?? []).map((l) => [l.lane, l.trackIndex, l.letters, l.texts.join(" ")]))}`);
  const base = coherence(first);
  if (base.length) return { seed, failedAtStep: -1, violations: base, log, decorations: first };

  for (let step = 0; step < steps; step++) {
    const kind = r.pick(['tabView', 'tabView', 'partView', 'order', 'snap', 'rebuild', 'theme']);
    let action;
    if (kind === 'tabView') {
      const opts = await jsonIn(cdp, `JSON.stringify([...(document.querySelector('[data-role="tab-view"]')?.options ?? [])].map(o => ({v:o.value,d:o.disabled})))`);
      const usable = (opts ?? []).filter((o) => !o.d);
      if (!usable.length) continue;
      action = { kind: 'tabView', value: r.pick(usable).v };
    } else if (kind === 'partView') {
      const opts = await jsonIn(cdp, `JSON.stringify([...(document.querySelector('[data-role="part-view"]')?.options ?? [])].map(o => ({v:o.value,d:o.disabled})))`);
      const usable = (opts ?? []).filter((o) => !o.d && o.v.startsWith('part:'));
      if (!usable.length) continue;
      action = { kind: 'partView', value: r.pick(usable).v };
    } else if (kind === 'order') {
      /*
       * REORDERING IS THE LEAK'S OWN GESTURE (codex finding 8): the tuning legend and the note
       * name row used to read whichever track came FIRST, which is the take only by luck of
       * ordering. Move an imported part above it and every decoration beside every staff is
       * suddenly the wrong part's. So the mini-soak shuffles the order through the same
       * `setParts` call Move up and Move down make.
       */
      const opts = await jsonIn(cdp, `JSON.stringify([...(document.querySelector('[data-role="part-view"]')?.options ?? [])].map(o => o.value).filter(v => v.startsWith('part:')))`);
      const keys = (opts ?? []).map((v) => v.slice('part:'.length));
      if (keys.length < 2) continue;
      for (let i = keys.length - 1; i > 0; i--) {
        const j = r.int(i + 1);
        [keys[i], keys[j]] = [keys[j], keys[i]];
      }
      await evalIn(cdp, `window.__RIFFSHEET_PARTSORDER__(${JSON.stringify(keys)})`);
      action = { kind: 'partOrder', order: keys };
    } else if (kind === 'snap') {
      action = { kind: 'snap', value: r.pick(['off', 'grid', 'beat']) };
    } else if (kind === 'rebuild') {
      await evalIn(cdp, 'window.__RIFFSHEET_REBUILD__ && window.__RIFFSHEET_REBUILD__()');
      action = { kind: 'rebuild' };
    } else {
      // The real theme ids (`ui/theme.ts`). A theme change is a full `renderMain` remount — both
      // canvases destroyed and rebuilt — which is the heaviest rebuild a decoration has to survive.
      await evalIn(cdp, `window.__RIFFSHEET_SETTHEME__ && window.__RIFFSHEET_SETTHEME__(${JSON.stringify(r.pick(['midnight', 'daylight', 'ember', 'tide']))})`);
      action = { kind: 'theme' };
    }
    if (action && (action.kind === 'tabView' || action.kind === 'partView' || action.kind === 'snap')) {
      await doAct(cdp, action);
    }
    if (!action) continue;
    const delay = Math.round(r.range(0, 400));
    log.push({ step, ...action, preDelayMs: delay });
    await evalIn(cdp, `window.__SOAK.sleep(${delay + 250})`, true);
    const d = await decorations();
    const bad = coherence(d);
    if (bad.length) return { seed, failedAtStep: step, violations: bad, log, decorations: d };
  }
  await evalIn(cdp, 'window.__RIFFSHEET_PARTSRESET__ && window.__RIFFSHEET_PARTSRESET__()');
  return { seed, failedAtStep: null, log, steps };
}

// -----------------------------------------------------------------------------

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const server = await serve();
  const chromePath = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.CHROME_PATH
  ].filter(Boolean).find((p) => existsSync(p));
  if (!chromePath) { console.error('No Chrome found'); process.exit(1); }

  const profileDir = join(tmpdir(), `riffsheet-soak-${process.pid}-${Date.now()}`);
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required'
  ];
  if (!HEADFUL) args.push('--headless=new', '--disable-gpu');
  const { dispose: reapChrome } = launchChrome(chromePath, args, { profileDir });

  let cdp;
  const errors = [];
  let exitCode = 0;
  try {
    const deadline = Date.now() + 25000;
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

    // ---- replay mode --------------------------------------------------------
    if (REPLAY) {
      const record = JSON.parse(await readFile(resolve(REPLAY), 'utf8'));
      console.log(`REPLAY  ${REPLAY}  seed=${record.seed}  steps=${record.log.length}  runs=${RUNS}`);
      let hits = 0;
      for (let i = 0; i < RUNS; i++) {
        const res = await replayLog(cdp, record, { inject: INJECT });
        if (res.reproduced) { hits++; if (i === 0) await writeFile(join(OUT, 'replay-dump.json'), JSON.stringify(res, null, 2)); }
        console.log(`   run ${i + 1}/${RUNS}: ${res.reproduced ? `REPRODUCED at step ${res.atStep} — ${res.violations.map((v) => v.law).join(', ')}` : 'clean'}`);
      }
      console.log(`FLAKE RATE  ${hits}/${RUNS} = ${(100 * hits / RUNS).toFixed(0)}%`);
      exitCode = hits ? 1 : 0;
      return;
    }

    // ---- the conviction gates, before everything -----------------------------
    /*
     * FIRST OF ALL, because a gate is the cheapest and the most specific thing here: each one is
     * a known mechanism reproduced by a scripted gesture, so a red gate names the fix that is
     * missing rather than the state that is wrong. The matrix and the soak run after.
     */
    if (!NO_GATES && !ONLY_PARTS && !ONLY_ANCHOR) {
      console.log('CONVICTION GATES');
      const gates = await convictionGates(cdp);
      const file = join(OUT, 'gates.json');
      await writeFile(file, JSON.stringify(gates, null, 2));
      let red = 0;
      for (const g of gates) {
        if (g.error) { console.log(`  ${g.name}: SKIPPED — ${g.error}`); continue; }
        if (g.violations?.length) {
          red++;
          console.log(`  ${g.name}: RED`);
          for (const v of g.violations) console.log(`      ${v.law}  ${JSON.stringify(v.detail ?? null).slice(0, 320)}`);
        } else console.log(`  ${g.name}: GREEN`);
      }
      console.log(`  gates: ${gates.length - red} green, ${red} red -> ${file}`);
      if (red) exitCode = 1;
      if (ONLY_GATES) return;
    }

    // ---- the anchored-add matrix, FIRST -------------------------------------
    /*
     * BEFORE THE SOAK, ALWAYS. A law that can be broken by one gesture must not be discovered by
     * two hundred random ones: the matrix is deterministic, it names the axis that broke, and it
     * runs in a couple of minutes. The soak's job is the races the matrix cannot reach.
     */
    if (!NO_ANCHOR && !ONLY_PARTS) {
      console.log('ANCHORED-ADD MATRIX  snap x jitter x direction x free');
      const cells = await anchoredAddMatrix(cdp, {});
      const bad = cells.filter((c) => !c.error && c.violations.length);
      const file = join(OUT, 'anchored-matrix.json');
      await writeFile(file, JSON.stringify(cells, null, 2));
      console.log(`  matrix: ${cells.length} cells, ${bad.length} with violations, ${cells.filter((c) => c.error).length} skipped -> ${file}`);
      if (bad.length) exitCode = 1;
      if (ONLY_ANCHOR) return;
    }

    // ---- parts mini-soak ----------------------------------------------------
    if (WANT_PARTS) {
      const seeds = [];
      for (let i = 0; i < Math.max(1, RUNS); i++) seeds.push((SEED0 + i * 7919) >>> 0);
      for (const seed of seeds) {
        const res = await partsSoak(cdp, seed, Math.min(STEPS, 60));
        if (res.error) { console.log(`PARTS  seed ${seed}: setup failed — ${res.error}`); continue; }
        if (res.failedAtStep !== null && res.failedAtStep !== undefined) {
          const file = join(OUT, `parts-${seed}.json`);
          await writeFile(file, JSON.stringify(res, null, 2));
          console.log(`PARTS  seed ${seed}: VIOLATION at step ${res.failedAtStep} — ${res.violations.map((v) => v.law).join(', ')}`);
          console.log(`       ${file}`);
          exitCode = 1;
        } else {
          console.log(`PARTS  seed ${seed}: clean over ${res.log.length} toggles`);
        }
      }
      if (ONLY_PARTS) return;
    }

    // ---- the main soak ------------------------------------------------------
    const stopAt = MINUTES > 0 ? Date.now() + MINUTES * 60_000 : Infinity;
    let seed = SEED0 >>> 0;
    let runs = 0;
    let caught = null;
    const perRun = [];
    while (runs < (MINUTES > 0 ? Infinity : RUNS) && Date.now() < stopAt) {
      runs++;
      const t0 = Date.now();
      console.log(`SOAK  run ${runs}  seed=${seed}  steps=${STEPS}  inject=${INJECT}`);
      const res = await runSeed(cdp, seed, STEPS, { inject: INJECT });
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      perRun.push({ seed, steps: res.failedAtStep ?? STEPS, secs, timings: res.timings });
      if (res.failedAtStep !== null) {
        const file = join(OUT, `soak-${seed}.json`);
        await writeFile(file, JSON.stringify(res, null, 2));
        console.log(`  VIOLATION  seed ${seed} step ${res.failedAtStep} after ${secs}s`);
        for (const v of res.violations) console.log(`     ${v.law}  ${JSON.stringify(v.detail ?? null).slice(0, 400)}`);
        console.log(`     dump: ${file}`);
        caught = { seed, file, res };
        break;
      }
      console.log(`  clean  ${STEPS} steps in ${secs}s  (injected mid-rebuild: ${res.timings.injected}, quiesce timeouts: ${res.timings.quiesceTimeouts}, leftBusy: ${res.timings.leftBusy ?? 0}, maxWait: ${res.timings.maxWaitMs ?? 0}ms, rawNotes ${Object.keys(res.before?.raw ?? {}).length}, kinds ${JSON.stringify(res.log.reduce((m,e)=>{m[e.kind]=(m[e.kind]??0)+1;return m;},{}))})`);
      seed = (seed + 7919) >>> 0;
    }

    if (caught) {
      console.log(`\nDETERMINISM  re-running the recorded log ${Math.max(3, RUNS)}x`);
      let hits = 0;
      const attempts = Math.max(3, RUNS);
      for (let i = 0; i < attempts; i++) {
        const res = await replayLog(cdp, caught.res, { inject: INJECT });
        if (res.reproduced) hits++;
        console.log(`   replay ${i + 1}/${attempts}: ${res.reproduced ? `REPRODUCED at step ${res.atStep}` : 'clean'}`);
      }
      console.log(`   flake rate ${hits}/${attempts}`);
      if (hits) {
        console.log(`\nSHRINK  bisecting to the shortest failing prefix`);
        const best = await shrink(cdp, caught.res, { attempts: hits === attempts ? 1 : 3 });
        if (best) {
          const file = join(OUT, `soak-${caught.seed}-min.json`);
          await writeFile(file, JSON.stringify({ ...caught.res, log: caught.res.log.slice(0, best.length), minimised: true }, null, 2));
          console.log(`   shortest failing prefix: ${best.length} steps of ${caught.res.log.length}  -> ${file}`);
          console.log(`   ${best.res.violations.map((v) => `${v.law} ${JSON.stringify(v.detail ?? null).slice(0, 300)}`).join('\n   ')}`);
        } else {
          console.log('   no prefix reproduced; the failure needs the whole log');
        }
      }
      exitCode = 1;
    } else if (!ONLY_PARTS) {
      console.log(`\nNO VIOLATION over ${runs} run(s) / ${perRun.reduce((s, x) => s + x.steps, 0)} steps.`);
      for (const x of perRun) console.log(`   seed ${x.seed}: ${x.steps} steps, ${x.secs}s, injected ${x.timings?.injected ?? 0}, timeouts ${x.timings?.quiesceTimeouts ?? 0}`);
    }

    if (errors.length) {
      console.log(`\nCONSOLE ERRORS (${errors.length}):`);
      for (const e of errors.slice(0, 10)) console.log(`   ${e}`);
    }
  } catch (e) {
    console.error('soak: ' + (e?.stack ?? e));
    exitCode = 1;
  } finally {
    try { cdp?.close(); } catch { /* already gone */ }
    server.close();
    reapChrome();
  }
  process.exit(exitCode);
};

main();
