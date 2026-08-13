#!/usr/bin/env node
/**
 * THE CORRESPONDENCE-SEAM PROBE — one live browser, one model, five claims.
 *
 * WHY A PROBE AND NOT MORE UNIT TESTS. Every fault this file exists to catch is a fault of
 * RELATIONSHIP between things that only exist together at runtime: a selection held in four
 * places, an alphaTab bounds table that has fallen behind the index beside it, an id counter that
 * was never told what the document it just loaded is already called. None of those can be
 * constructed out of plain arrays, which is exactly why the unit suites were green throughout the
 * period the owner was reporting the bugs.
 *
 * Each section states its claim, and each one FAILED BEFORE the seam was rebuilt — the mechanism
 * is quoted in the section header so the check cannot quietly become a tautology later.
 *
 * Its own port pair (5403/9343) so it can run beside verify, ghost, scrollzoom and sheet-edit.
 *
 *   node scripts/seam-probe.mjs [--headful] [--shots]
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
const PORT = 5403;
const DEBUG_PORT = 9343;
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

  const profileDir = join(tmpdir(), `riffsheet-seam-${process.pid}-${Date.now()}`);
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
      await writeFile(join(OUT, `seam-${name}.png`), Buffer.from(r.data, 'base64'));
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
      await settle(900);
    };

    /** The whole model in one frame. See `ui/app.ts §__RIFFSHEET_SEAM__`. */
    const seam = () => json('JSON.stringify(window.__RIFFSHEET_SEAM__ ? window.__RIFFSHEET_SEAM__() : null)');
    const sheet = () => json('JSON.stringify(window.__RIFFSHEET_SHEETEDIT__ ? window.__RIFFSHEET_SHEETEDIT__() : null)');
    const rects = () => json('JSON.stringify((window.__RIFFSHEET_ROLLRECTS__ && window.__RIFFSHEET_ROLLRECTS__()) ?? [])');

    const noteHeadAt = async (nth) => {
      const s = await sheet();
      const heads = (s?.noteHeads ?? []).filter((h) => h.staff === 'notation');
      return heads.length ? heads[Math.min(nth, heads.length - 1)] : null;
    };
    const clickAt = (x, y) => ev(`(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return 'nothing there';
      for (const type of ['pointerdown', 'pointerup']) {
        el.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
          button: 0, buttons: type === 'pointerdown' ? 1 : 0, clientX: ${x}, clientY: ${y}
        }));
      }
      return 'clicked';
    })()`);
    const rightClickAt = (x, y) => ev(`(() => {
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

    await load('demo=straight&bars=4&tab=bass&verify=1');

    const first = await seam();
    check('the seam probe exists and the model is published', !!first, JSON.stringify(first?.projection));
    if (!first) throw new Error('no seam probe');
    say('projection', first.projection);
    say('ids', first.ids);

    // ===================================================================
    // 1 — TOTALITY: every note the build was handed has an outcome
    // ===================================================================
    //
    // BEFORE: there was no table at all. A note the guards dropped and a note the quantizer fused
    // into its neighbour were both simply ABSENT from `ScoreIndex`, and absence was the only
    // signal any consumer had — so a roll rectangle could be selected, light up, and resolve to
    // zero sheet glyphs with nothing anywhere able to say why (audit finding 5).
    check(
      'projection: totality — engraved + merged + dropped accounts for every input',
      first.projection.total === first.projection.inputs &&
        first.projection.engraved + first.projection.merged + first.projection.dropped ===
          first.projection.total,
      JSON.stringify(first.projection)
    );
    check(
      'projection: it carries the revision it was built for',
      first.projection.revision === first.revision && first.revision > 0,
      `projection r${first.projection.revision} / app r${first.revision}`
    );

    // ===================================================================
    // 2 — IDENTITY: no two notes share a name
    // ===================================================================
    //
    // BEFORE: `add<N>`, `auto<N>` and `split<N>` came from process-local counters that restore
    // never seeded, so a document saved with `add1` in it minted `add1` again for the next note
    // drawn. Two distant notes, one name — and the duration command rewrites every note carrying
    // a named id, so editing either changed both (audit finding 3).
    check(
      'identity: no duplicate ids in the feed',
      first.ids.duplicateIds.length === 0,
      JSON.stringify(first.ids.duplicateIds.slice(0, 5))
    );
    check(
      'identity: the allocator knows every name the document is using',
      first.ids.known >= first.ids.feed,
      `known ${first.ids.known} >= feed ${first.ids.feed}`
    );

    // ===================================================================
    // 3 — ONE SELECTION AUTHORITY
    // ===================================================================
    //
    // BEFORE: four. `rebuildNotation` cleared only the runtime's, `TriView.load` retained its own
    // across a score replacement, `PianoRoll.setPerformanceNotes` retained its own across a note
    // replacement, and `renderMain` destroyed both views and rebuilt them empty while the runtime
    // and the waveform still held a selection (audit finding 7).
    const head = await noteHeadAt(2);
    check('a notehead was found to point at', !!head, JSON.stringify(head));
    if (!head) throw new Error('nothing engraved to select');

    await clickAt(Math.round(head.x), Math.round(head.y));
    await settle(300);
    const selected = await seam();
    say('after a click', {
      selection: selected.selection,
      sheet: selected.sheetSelection,
      roll: selected.rollSelection
    });
    check(
      'selection: a click on a notehead selects exactly one note',
      selected.selection.length === 1,
      JSON.stringify(selected.selection)
    );
    const selectedId = selected.selection[0];
    check(
      'selection: all three answers agree — authority, sheet, roll',
      selected.sheetSelection?.length === 1 &&
        selected.rollSelection?.length === 1 &&
        selected.rollSelection[0] === selectedId,
      `auth=${JSON.stringify(selected.selection)} sheet=${JSON.stringify(selected.sheetSelection)} roll=${JSON.stringify(selected.rollSelection)}`
    );
    check(
      'selection: the waveform brackets it too',
      !!selected.waveformRange,
      JSON.stringify(selected.waveformRange)
    );
    await shot('01-selected');

    /**
     * THE DIVERGENCE TEST, run after every rebuild road there is.
     *
     * The audit's repro list is exactly this: "select a note, then resize it, change duration,
     * quantize, bar-edit, undo, or redo. Separately, select a note then toggle the roll, theme,
     * or note names." Each of those reaches a different rebuild path, and the old code updated a
     * different subset of the four authorities on each one.
     */
    const agrees = async (what) => {
      const s = await seam();
      const auth = s.selection;
      const roll = s.rollSelection ?? [];
      const sheetSel = s.sheetSelection ?? [];
      // The sheet's list is the authority mapped through the projection: an id the page merged
      // into another rings its proxy, so the lists agree in LENGTH and in membership-after-mapping
      // rather than literally. A dropped id has no proxy and legitimately drops out.
      const silent = new Set((s.sheetSilence ?? []).map((r) => r.id));
      const expectSheet = auth.filter((id) => !silent.has(id)).length;
      const ok =
        auth.length === roll.length &&
        auth.every((id) => roll.includes(id)) &&
        sheetSel.length >= Math.min(1, expectSheet);
      check(
        `selection survives ${what}, and all authorities still agree`,
        ok,
        `auth=${JSON.stringify(auth)} roll=${JSON.stringify(roll)} sheet=${JSON.stringify(sheetSel)}`
      );
      return s;
    };

    // --- a duration edit (rebuildNotation) ---------------------------------
    await rightClickAt(Math.round(head.x), Math.round(head.y));
    await settle(250);
    const picked = await pick('Quarter');
    await settle(700);
    check('a duration was picked', picked === 'picked', String(picked));
    await agrees('a duration edit');

    // --- the note-names toggle (renderMain: both views destroyed & rebuilt) --
    //
    // An `<optgroup data-role="clef-names">` inside the clef `<select>`, not a chip: the
    // note-names switch shares the clef drop-down. Driven by setting the SELECT's value to one of
    // the group's `names:on`/`names:off` options and firing `change`, which is the road the
    // browser itself takes.
    const toggleNames = await ev(`(() => {
      const group = document.querySelector('optgroup[data-role="clef-names"]');
      const sel = group?.closest('select');
      if (!group || !sel) return 'missing';
      const opts = [...group.querySelectorAll('option')];
      const off = opts.find((o) => o.value === 'names:off');
      const on = opts.find((o) => o.value === 'names:on');
      const target = /✓/.test(on?.textContent || '') ? off : on;
      if (!target) return 'no target option';
      sel.value = target.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'toggled';
    })()`);
    await settle(800);
    if (toggleNames === 'toggled') await agrees('the note-names toggle (a full remount)');
    else check('the note-names chip was found', false, String(toggleNames));

    // --- a theme change (renderMain again, both canvases rebuilt) -----------
    await ev(`(() => { window.__RIFFSHEET_SETTHEME__ && window.__RIFFSHEET_SETTHEME__('ember'); return true; })()`);
    await settle(800);
    const themed = await seam();
    check(
      'selection survives a theme change',
      themed.selection.length === (await seam()).selection.length,
      JSON.stringify(themed.selection)
    );
    await shot('02-ember-selected');

    // --- undo (the performance history road) --------------------------------
    await ev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })); return true; })()`);
    await settle(800);
    await agrees('an undo');

    // ===================================================================
    // 4 — THE DEAD CLICK: bounds and index are one revision
    // ===================================================================
    //
    // BEFORE: `TriView.load` published a new score, index and model and then asked for a render.
    // A render into a hidden or zero-width host returns early WITHOUT replacing alphaTab's
    // `boundsLookup`, so the bounds still described the PREVIOUS engraving. A hit test then
    // resolved a real Note object out of them, failed to find it in the new index, and returned
    // `noteId: null` — which `onNoteClick` answered with a SEEK. A click on a plainly visible
    // notehead moved the playhead and selected nothing (audit finding 8).
    const rev = (await seam()).sheet;
    say('sheet revisions', rev);
    check(
      'revisions: after a settled render the bounds and the model agree',
      rev.current === true && rev.bounds === rev.model,
      JSON.stringify(rev)
    );
    check(
      'revisions: no stale hit was silently answered during this session',
      rev.staleHitRejections === 0,
      `${rev.staleHitRejections} rejections`
    );

    /*
     * ...and now force the condition the gate exists for. Hiding the sheet host makes the next
     * render a zero-size one, which alphaTab declines to complete — so the model advances and
     * the bounds do not. The claim is that a click in that state does NOTHING: it must not
     * resolve against the old bounds, and it must not fall through to the seek either.
     */
    const before = await seam();
    await ev(`(() => {
      const h = document.querySelector('.at-host');
      if (!h) return 'no host';
      h.style.display = 'none';
      return 'hidden';
    })()`);
    // A rebuild while hidden: the settings road is the shortest one that reaches rebuildNotation.
    await ev(`(() => { window.__RIFFSHEET_REBUILD__ && window.__RIFFSHEET_REBUILD__(); return true; })()`);
    await settle(600);
    const whileHidden = await seam();
    say('while hidden', whileHidden.sheet);
    const posBefore = await json('JSON.stringify(window.__RIFFSHEET_PIANOROLL__().positionSec)');
    await clickAt(Math.round(head.x), Math.round(head.y));
    await settle(250);
    const afterBlind = await seam();
    const posAfter = await json('JSON.stringify(window.__RIFFSHEET_PIANOROLL__().positionSec)');
    check(
      'dead click: a press against stale bounds does not seek the transport',
      Math.abs(posAfter - posBefore) < 1e-6,
      `${posBefore}s -> ${posAfter}s`
    );
    check(
      'dead click: and it does not silently change the selection either',
      JSON.stringify(afterBlind.selection) === JSON.stringify(whileHidden.selection),
      `${JSON.stringify(whileHidden.selection)} -> ${JSON.stringify(afterBlind.selection)}`
    );
    void before;
    await ev(`(() => { const h = document.querySelector('.at-host'); if (h) h.style.display = ''; return true; })()`);
    await settle(600);

    // ===================================================================
    // 5 — CHORD MEMBERSHIP IS THE PAGE'S, NOT A WINDOW'S
    // ===================================================================
    //
    // BEFORE: the editor asked "is anything within 35 ms of the note I clicked", which is a
    // different relation from the greedy partition the engraver runs — it chains across group
    // boundaries the page has drawn and refuses groups the page has made at slow tempi
    // (audit finding 2).
    await load('demo=straight&bars=4&tab=bass&verify=1');
    const chordHead = await noteHeadAt(1);
    if (chordHead) {
      await clickAt(Math.round(chordHead.x), Math.round(chordHead.y));
      await settle(300);
      const withChord = await seam();
      say('chord events', withChord.chordEvents);
      check(
        'chords: the page publishes its own grouping, and the editor reads it',
        withChord.chordEvents.count > 0 &&
          withChord.chordEvents.membersOfSelection.length >= 1 &&
          withChord.chordEvents.membersOfSelection.includes(withChord.selection[0]),
        JSON.stringify(withChord.chordEvents)
      );
    }

    // ===================================================================
    // 6 — THE VISUALS ATTRACT, at every face scale
    // ===================================================================
    //
    // BEFORE: the ring was 2.5 units and the halo 6, in ENGRAVING units, on a face scaled by
    // `min(1, viewport/base)`. At REAPER's 360x280 that scale is ~0.273, so the ring landed at
    // 0.68 SCREEN PIXELS and the halo at 1.64 of them at 30% opacity — a highlight that
    // technically rendered on every glyph and looked like nothing (audit finding 11).
    const measureSelection = () => json(`JSON.stringify((() => {
      const g = document.querySelector('.triview-overlay');
      const rects = [...(g?.querySelectorAll('.sel-rect') ?? [])];
      const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--face-scale')) || 1;
      const widths = rects.map((r) => Number(r.style.strokeWidth) || 0);
      return {
        count: rects.length,
        firm: rects.filter((r) => r.classList.contains('sel-rect-firm')).length,
        scale,
        // What the player's eye actually receives: engraving units x the one face scale.
        screenWidths: widths.map((w) => Number((w * scale).toFixed(3))),
        labelSelected: document.querySelectorAll('.note-name.selected').length
      };
    })())`);

    for (const [w, h] of [[1440, 900], [900, 620], [380, 300]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: false
      });
      await settle(700);
      const hd = await noteHeadAt(2);
      if (!hd) { check(`visuals @${w}x${h}: a notehead was found`, false, 'none'); continue; }
      await clickAt(Math.round(hd.x), Math.round(hd.y));
      await settle(400);
      const m = await measureSelection();
      say(`visuals @${w}x${h}`, m);
      check(
        `visuals @${w}x${h}: the selection is drawn`,
        m.count > 0 && m.firm > 0,
        JSON.stringify(m)
      );
      check(
        `visuals @${w}x${h}: every stroke clears the 1.4 screen-pixel floor`,
        m.screenWidths.length > 0 && m.screenWidths.every((v) => v >= 1.4),
        `scale ${m.scale} -> ${JSON.stringify(m.screenWidths)}`
      );
      await shot(`03-visuals-${w}x${h}`);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await settle(500);

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${results.length} checks)`);
    await writeFile(join(OUT, 'seam-probe.json'), JSON.stringify({ results }, null, 2));
    void rects;
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
