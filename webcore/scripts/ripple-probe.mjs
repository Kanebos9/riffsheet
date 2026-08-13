#!/usr/bin/env node
/**
 * THE RIPPLE PROBE — a duration edit pushes the whole rest of the score, on a live page.
 *
 * WHY A PROBE AS WELL AS src/edit/ripple.test.ts. That test proves the LAW over plain arrays and
 * a synthetic tick map, which is the right shape for it. It cannot prove any of the things the
 * feature is actually made of, and every one of them is a fault of RELATIONSHIP between layers
 * that only exist together at runtime:
 *
 *   - that the log is applied AFTER cuts and snap, in `performanceFeed()`, and therefore that the
 *     RECORDING is not touched by a ripple at all;
 *   - that the ROLL and the SHEET agree note for note afterwards, because both are drawn from the
 *     one feed rather than from two implementations kept in step by hand;
 *   - that ONE undo puts the notes, the log, the structural end and the bar floor back together;
 *   - that `userTouchedIds` gained the CHORD and not the entire tail of the take, which is the
 *     trap that would have switched the automatic edit pass off for a whole document;
 *   - that a bar operation goes through the same storage and no longer writes edited-clock
 *     seconds into audio-coordinate storage.
 *
 * Each section states its claim and what it would have looked like before. Its own port pair
 * (5405/9345) so it can run beside verify, ghost, scrollzoom, sheet-edit and seam.
 *
 *   node scripts/ripple-probe.mjs [--headful] [--shots]
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
const PORT = 5405;
const DEBUG_PORT = 9345;
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

  const profileDir = join(tmpdir(), `riffsheet-ripple-${process.pid}-${Date.now()}`);
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
      await writeFile(join(OUT, `ripple-${name}.png`), Buffer.from(r.data, 'base64'));
    };
    const check = (label, ok, detail) => {
      results.push({ label, ok: !!ok, detail });
      if (!ok) failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    };
    const say = (label, value) => console.log(`      ${label}: ${JSON.stringify(value)}`);


    const load = async (query) => {
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?${query}` });
      for (let i = 0; ; i++) {
        const ready = await ev(
          '!!window.__RIFFSHEET_DEMO_READY__ && (document.querySelector(".at-host .at-surface")?.childElementCount ?? 0) > 0'
        );
        if (ready === true) break;
        if (i > 60) throw new Error('demo never became ready');
        await settle(200);
      }
      await settle(1000);
    };

    /** Everything the sheet, the roll and the structural layer say about themselves, in one frame. */
    const state = () => json('JSON.stringify(window.__RIFFSHEET_SHEETEDIT__ ? window.__RIFFSHEET_SHEETEDIT__() : null)');
    const noteHeadAt = async (nth) => {
      const s = await state();
      const heads = (s?.noteHeads ?? []).filter((h) => h.staff === 'notation').sort((a, b) => a.x - b.x);
      return heads.length ? heads[Math.min(nth, heads.length - 1)] : null;
    };
    const rightClick = (x, y) => ev(`(() => {
      const el = document.elementFromPoint(${x}, ${y}) || document.querySelector('.triview-scroll');
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, button: 2, buttons: 2 });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    })()`);
    const pick = (label) => ev(`(() => {
      const row = [...document.querySelectorAll('[data-menu-item]')].find((e) => e.getAttribute('data-menu-item') === ${JSON.stringify(label)});
      if (!row) return 'missing';
      if (row.getAttribute('aria-disabled') === 'true') return 'disabled';
      row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));
      return 'picked';
    })()`);
    const undo = () => ev(`(() => { document.querySelector('[data-role="undo"]')?.click(); return true; })()`);
    /** Pick a written value on the notehead at `nth`, and wait for the rebuild. */
    const setDuration = async (nth, value) => {
      const head = await noteHeadAt(nth);
      if (!head) return { picked: 'missing', head: null };
      await rightClick(Math.round(head.x), Math.round(head.y));
      await settle(260);
      const picked = await pick(value);
      await settle(1500);
      return { picked, head };
    };
    const byId = (s, id) => s.notes.find((n) => n.id === id) ?? null;
    const rollById = (s, id) => s.rollNotes.find((n) => n.id === id) ?? null;

    await load('demo=straight&bars=4&tab=bass&verify=1');

    // ===================================================================
    // 1 — THE RIPPLE ITSELF: lengthening pushes everything after it
    // ===================================================================
    //
    // WHAT THIS LOOKED LIKE BEFORE. Three answers, all wrong, in order: the chosen value was taken
    // and the notes it now covered were DELETED (the audit's first Critical); then the value was
    // clamped back to the next attack, so picking Half silently gave a sixteenth; then neither —
    // the chord took the value and nothing moved, leaving an overlap the engraver truncated on the
    // page. The law is that the rest of the score MOVES.
    const before = await state();
    const target = await noteHeadAt(1);
    check('a notehead was found to ripple from', !!target, JSON.stringify(target));
    if (!target) throw new Error('nothing engraved to edit');

    const suffixIds = before.notes
      .filter((n) => n.startSec > (byId(before, target.id)?.endSec ?? 0) + 1e-6)
      .map((n) => n.id);
    check('the take has material after the edited note to push', suffixIds.length >= 2, `${suffixIds.length} notes`);

    const picked = await setDuration(1, 'Whole');
    const after = await state();
    await shot('01-lengthened');
    say('ops', after.rippleOps);
    check('ripple: the duration was picked', picked.picked === 'picked', picked.picked);
    check(
      'ripple: ONE operation was appended to the log — not a rewritten note list',
      after.rippleOps.length === 1 && after.rippleOps[0].delta > 0,
      JSON.stringify(after.rippleOps)
    );
    check(
      'ripple: the chord is the ATOM, and it is the only thing the operation names',
      (after.rippleOps[0].chordIds ?? []).includes(target.id),
      JSON.stringify(after.rippleOps[0].chordIds)
    );
    const moved = suffixIds.filter((id) => {
      const was = byId(before, id);
      const now = byId(after, id);
      return was && now && now.startSec > was.startSec + 1e-3;
    });
    check(
      'ripple: EVERY note after the seam was pushed, not only the next one',
      moved.length === suffixIds.length,
      `${moved.length}/${suffixIds.length} moved`
    );
    check(
      'ripple: nothing was deleted — the destruction law is gone and did not come back',
      after.notes.length === before.notes.length,
      `${before.notes.length} -> ${after.notes.length}`
    );
    // EQUAL DISPLACEMENT: the suffix keeps its own internal rhythm. It moved as a block.
    const gapsBefore = suffixIds.map((id) => byId(before, id).startSec);
    const gapsAfter = suffixIds.map((id) => byId(after, id).startSec);
    const spreads = gapsBefore.map((s, i) => Number((gapsAfter[i] - s).toFixed(3)));
    check(
      'ripple: the suffix moved as a BLOCK — its own rhythm is untouched',
      new Set(spreads).size === 1,
      JSON.stringify(spreads)
    );

    // ===================================================================
    // 2 — THE RECORDING IS NOT TOUCHED
    // ===================================================================
    //
    // The whole reason the ripple is a stored log rather than a reducer. Writing the shifted feed
    // back would promote every snapped, cut-closed second into `source.detected.notes` — the snap
    // could never be switched off again, and every note hidden under a cut would be deleted.
    const rawUnchanged = Object.keys(before.rawStarts).every(
      (id) => Math.abs((after.rawStarts[id] ?? -1) - before.rawStarts[id]) < 1e-9
    );
    check(
      'storage: not one second of the RECORDING moved — the log is the storage',
      rawUnchanged && Object.keys(after.rawStarts).length === Object.keys(before.rawStarts).length,
      `${Object.keys(after.rawStarts).length} raw notes`
    );

    // ===================================================================
    // 3 — THE TOUCHED CONTRACT IS SPLIT (the trap named by line number)
    // ===================================================================
    //
    // `applySheetEdit` used to add every touched id to `userTouchedIds`, which is what exempts a
    // note from the automatic edit pass FOREVER. A ripple touches the whole tail of a take, so one
    // duration pick would have switched that pass off for almost the entire document.
    say('writeback vs authored', { writeback: after.rippleWriteback.length, touched: after.userTouched.length });
    check(
      'touched: the WRITEBACK set names the whole suffix — the ripple knows what it moved',
      after.rippleWriteback.length > (after.rippleOps[0].chordIds ?? []).length,
      `${after.rippleWriteback.length} moved`
    );
    check(
      'touched: `userTouchedIds` gained only the CHORD, never the tail',
      after.userTouched.length <= (after.rippleOps[0].chordIds ?? []).length &&
        (after.rippleOps[0].chordIds ?? []).every((id) => after.userTouched.includes(id)),
      JSON.stringify({ authored: after.rippleOps[0].chordIds, touched: after.userTouched })
    );

    // ===================================================================
    // 4 — THE ROLL MIRRORS THE SHEET, note for note
    // ===================================================================
    //
    // Structural rather than approximate: both are drawn from `performanceFeed()`, so there is no
    // second implementation to keep in step. The check is that every id agrees to the millisecond.
    const mismatch = after.notes.filter((n) => {
      const r = rollById(after, n.id);
      return !r || Math.abs(r.startSec - n.startSec) > 1e-3 || Math.abs(r.endSec - n.endSec) > 1e-3;
    });
    check(
      'mirror: after the ripple the roll and the sheet agree note for note',
      mismatch.length === 0 && after.rollNotes.length === after.notes.length,
      JSON.stringify(mismatch.slice(0, 3))
    );

    // ===================================================================
    // 5 — THE STRUCTURAL END GREW, and the document is detached
    // ===================================================================
    check(
      'end: the document declares a structural end in exact ticks',
      typeof after.documentEndTick === 'number' && after.documentEndTick > 0,
      String(after.documentEndTick)
    );
    check(
      'end: the timeline is detached, so the audio-end guards cannot clamp the tail',
      after.timelineDetached === true && before.audioDurationSec === after.audioDurationSec,
      `audio ${before.audioDurationSec} -> ${after.audioDurationSec}`
    );

    // ===================================================================
    // 6 — ONE UNDO PUTS ALL OF IT BACK
    // ===================================================================
    //
    // Notes, log, structural end and bar floor are one transaction. Undo used to restore the notes
    // and leave the structure where the edit had put it.
    await undo();
    await settle(1500);
    const undone = await state();
    await shot('02-undone');
    check('undo: the log is empty again — NOT an empty log, no log', undone.rippleOps.length === 0, JSON.stringify(undone.rippleOps));
    const restored = suffixIds.every((id) => {
      const was = byId(before, id);
      const now = byId(undone, id);
      return was && now && Math.abs(now.startSec - was.startSec) < 1e-3;
    });
    check('undo: every pushed note is back where it was played', restored, `${suffixIds.length} notes`);
    const rollRestored = suffixIds.every((id) => {
      const was = rollById(before, id);
      const now = rollById(undone, id);
      return was && now && Math.abs(now.startSec - was.startSec) < 1e-3;
    });
    check('undo: and so is the ROLL — both surfaces come back together', rollRestored);

    // ===================================================================
    // 7 — REPEATED RIPPLES ACCUMULATE WITHOUT DRIFT
    // ===================================================================
    //
    // The canonical state is the log, and the log is rational. Four lengthenings and four
    // shortenings of the same note must return the document to the tick it started on — which
    // adding and subtracting floating-point seconds eight times does not.
    // A KNOWN BASELINE FIRST. The cycle has to end on the value it began on or the residue it
    // measures is the edit the player actually made rather than drift — which is the first thing
    // this check caught about itself.
    await setDuration(1, 'Quarter');
    const cycleStart = await state();
    const opsAtStart = cycleStart.rippleOps.length;
    for (let i = 0; i < 4; i++) {
      await setDuration(1, 'Whole');
      await setDuration(1, 'Quarter');
    }
    const cycled = await state();
    say('ops after eight edits', cycled.rippleOps.length - opsAtStart);
    check(
      'drift: eight edits are eight operations, appended in order',
      cycled.rippleOps.length === opsAtStart + 8,
      `${cycled.rippleOps.length - opsAtStart} ops`
    );
    const drift = cycled.notes
      .map((n) => {
        const was = byId(cycleStart, n.id);
        return was ? Math.abs(n.startSec - was.startSec) : 0;
      })
      .reduce((a, b) => Math.max(a, b), 0);
    say('worst drift', drift);
    check(
      'drift: four lengthenings and four shortenings leave every note on the second it started on',
      drift < 1e-9,
      `worst ${drift.toFixed(6)}s`
    );

    // ===================================================================
    // 7b — AND IT PULLS. The same law with a negative delta.
    // ===================================================================
    //
    // A shortening is not a different feature and must not be a different code path: the same
    // operation with the sign reversed, and the rest of the score comes BACK by exactly as much.
    const pullBefore = await state();
    await setDuration(1, 'Sixteenth');
    const pullAfter = await state();
    await shot('04-shortened');
    const pulled = pullBefore.notes
      .filter((n) => n.startSec > (byId(pullBefore, target.id)?.endSec ?? 0) + 1e-6)
      .map((n) => {
        const now = byId(pullAfter, n.id);
        return now ? Number((now.startSec - n.startSec).toFixed(3)) : null;
      })
      .filter((v) => v !== null);
    say('pull', { delta: pullAfter.rippleOps[pullAfter.rippleOps.length - 1].delta, spreads: [...new Set(pulled)] });
    check(
      'pull: shortening appends a NEGATIVE delta and drags the whole suffix back as a block',
      pullAfter.rippleOps[pullAfter.rippleOps.length - 1].delta < 0 &&
        pulled.length > 0 &&
        new Set(pulled).size === 1 &&
        pulled[0] < 0,
      JSON.stringify([...new Set(pulled)])
    );
    const pullMismatch = pullAfter.notes.filter((n) => {
      const r = rollById(pullAfter, n.id);
      return !r || Math.abs(r.startSec - n.startSec) > 1e-3;
    });
    check('pull: the roll mirrors the sheet after a pull too', pullMismatch.length === 0, JSON.stringify(pullMismatch.slice(0, 3)));

    // ===================================================================
    // 8 — A BAR OPERATION IS THE SAME STORAGE
    // ===================================================================
    //
    // It used to run a reducer over the FEED and merge back with `mergeEditedOntoRaw`, which drops
    // cut-hidden notes and writes edited-clock seconds into audio-coordinate storage. Now it is a
    // `RippleOp` with a seam, a delta and the split law — and the recording is not touched at all.
    await load('demo=straight&bars=4&tab=bass&verify=1');
    const barBefore = await state();
    const barHead = await noteHeadAt(2);
    if (barHead) {
      await rightClick(Math.round(barHead.x), Math.round(barHead.y));
      await settle(260);
      const barPicked = await pick('Insert bar before');
      await settle(1600);
      const barAfter = await state();
      await shot('03-bar-inserted');
      say('bar op', barAfter.rippleOps);
      check('bar op: the item was picked', barPicked === 'picked', barPicked);
      check(
        'bar op: it is stored as a rational operation with the split law, not as rewritten notes',
        barAfter.rippleOps.length === 1 && barAfter.rippleOps[0].split === true && barAfter.rippleOps[0].delta > 0,
        JSON.stringify(barAfter.rippleOps)
      );
      check(
        'bar op: the RECORDING did not move — the old road wrote edited-clock seconds into it',
        Object.keys(barBefore.rawStarts).every(
          (id) => Math.abs((barAfter.rawStarts[id] ?? -1) - barBefore.rawStarts[id]) < 1e-9
        ),
        `${Object.keys(barAfter.rawStarts).length} raw notes`
      );
      check(
        'bar op: the waveform is the same photograph it was',
        barAfter.audioDurationSec === barBefore.audioDurationSec,
        `${barBefore.audioDurationSec} -> ${barAfter.audioDurationSec}`
      );
      check(
        'bar op: the declared bar floor went up by one and the timeline is detached',
        barAfter.documentBars === (barBefore.documentBars ?? barBefore.bars.length) + 1 && barAfter.timelineDetached === true,
        `${barBefore.documentBars} -> ${barAfter.documentBars}`
      );
      const barMismatch = barAfter.notes.filter((n) => {
        const r = rollById(barAfter, n.id);
        return !r || Math.abs(r.startSec - n.startSec) > 1e-3;
      });
      check('bar op: the roll mirrors the sheet after it too', barMismatch.length === 0, JSON.stringify(barMismatch.slice(0, 3)));
      await undo();
      await settle(1500);
      const barUndone = await state();
      check(
        'bar op: one undo puts the log, the bar floor and the notes back together',
        // `?? null` on BOTH sides: `null ?? undefined` is `undefined`, and a document that
        // declared no bar count reports `null` here — so the naive comparison compared the two
        // spellings of "no floor" and called them different.
        barUndone.rippleOps.length === 0 && (barUndone.documentBars ?? null) === (barBefore.documentBars ?? null),
        JSON.stringify({ ops: barUndone.rippleOps.length, bars: barUndone.documentBars })
      );
    } else {
      check('bar op: a notehead was found to open the menu on', false, 'none');
    }

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${results.length} checks)`);
    await writeFile(join(OUT, 'ripple-probe.json'), JSON.stringify({ results }, null, 2));
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
