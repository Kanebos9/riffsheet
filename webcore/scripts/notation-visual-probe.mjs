#!/usr/bin/env node
/**
 * P3/P5/P6 rendered proof without a loopback server.
 *
 * Managed CI can deny `listen(2)` even on 127.0.0.1. Chrome's DevTools PIPE and a file:// build
 * exercise the same built bundle while needing no socket. Chrome is still launched through the
 * mandatory shared bootstrap, so its whole process group and temporary profile are reaped.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { launchChrome } from './probe-chrome.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT =
  process.env.RIFFSHEET_VIS_OUT ??
  '/private/tmp/claude-501/-Users-oguzhanyazici-Desktop-riffsheet/b3efb297-1129-44c7-8504-0e0877773412/scratchpad/vis';
// `__RIFFSHEET_SHEETSCALE__` walks the shared zoom in 1.25x steps. From the shipped starting
// scale the closest reachable step to 1 is 0.9375, exactly 1/16 away; the extra 0.0025 is only
// floating-point/render-settle slack and cannot mistake a neighbouring 0.75 or 1.171875 step.
const SHEET_SCALE_TOLERANCE = 0.065;
const chrome = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  process.env.CHROME_PATH
].filter(Boolean).find((path) => existsSync(path));

if (!chrome) throw new Error('No Chrome found');
if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html missing — run npm run build first');

class PipeCdp {
  constructor(input, output) {
    this.input = input;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    output.on('data', (chunk) => this.onData(Buffer.from(chunk)));
    output.on('error', (error) => this.rejectAll(error));
    output.on('close', () => this.rejectAll(new Error('Chrome DevTools pipe closed')));
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf(0);
      if (end < 0) return;
      const text = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      if (!text) continue;
      const message = JSON.parse(text);
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }
  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  send(method, params = {}, sessionId = undefined, timeoutMs = 45_000) {
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }
}

const profileDir = join(tmpdir(), `riffsheet-notation-visual-${process.pid}-${Date.now()}`);
const args = [
  '--remote-debugging-pipe',
  `--user-data-dir=${profileDir}`,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--allow-file-access-from-files',
  '--disable-web-security',
  '--autoplay-policy=no-user-gesture-required'
];
const launched = launchChrome(chrome, args, {
  profileDir,
  // Chrome's remote-debugging-pipe reads fd 3 and writes fd 4.
  stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
});
const { proc, dispose } = launched;
let stderr = '';
proc.stderr?.on('data', (chunk) => {
  stderr = (stderr + String(chunk)).slice(-16_000);
});

let failures = 0;
let checks = 0;
function check(what, ok, detail = '') {
  checks++;
  if (ok) return;
  failures++;
  console.error(`FAIL ${what}${detail ? ` — ${detail}` : ''}`);
}

/** Lane ids are `${system}:${track}`; acceptance counts tracks, then audits every lane instance. */
function laneTrackIndices(lanes) {
  return [...new Set((lanes ?? []).map((lane) => lane.trackIndex).filter(Number.isInteger))].sort(
    (a, b) => a - b
  );
}

function sameTrackIndices(actual, expected) {
  const a = [...actual].sort((x, y) => x - y);
  const b = [...expected].sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function everyPartHasNameLane(decorations) {
  const expected = decorations.tracks.map((track) => track.trackIndex);
  const systems = [...new Set(decorations.nameLanes.map((lane) => lane.system))];
  return (
    systems.length > 0 &&
    sameTrackIndices(laneTrackIndices(decorations.nameLanes), expected) &&
    systems.every((system) =>
      sameTrackIndices(
        laneTrackIndices(decorations.nameLanes.filter((lane) => lane.system === system)),
        expected
      )
    )
  );
}

function everyEligibleTrackHasStringLane(decorations) {
  const expected = decorations.tracks
    .filter((track) => track.hasTab)
    .map((track) => track.trackIndex);
  if (expected.length === 0) return decorations.stringLanes.length === 0;
  // Name lanes enumerate the rendered systems. Requiring the eligible string-track set in each
  // of those systems catches an entire missing tuning lane, not only a wrong global total.
  const systems = [...new Set(decorations.nameLanes.map((lane) => lane.system))];
  return (
    systems.length > 0 &&
    sameTrackIndices(laneTrackIndices(decorations.stringLanes), expected) &&
    systems.every((system) =>
      sameTrackIndices(
        laneTrackIndices(decorations.stringLanes.filter((lane) => lane.system === system)),
        expected
      )
    )
  );
}

function everyNameLaneClears(decorations) {
  return (
    decorations.nameLanes.length > 0 &&
    decorations.nameLanes.every(
      (lane) => Number.isFinite(lane.clearance) && lane.clearance >= 0
    )
  );
}

function everyNameLaneIsCollisionFree(decorations) {
  return (
    decorations.nameLanes.length > 0 &&
    decorations.nameLanes.every((lane) => lane.overlaps === 0)
  );
}

try {
  const cdp = new PipeCdp(proc.stdio[3], proc.stdio[4]);
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const session = attached.sessionId;
  await cdp.send('Runtime.enable', {}, session);
  await cdp.send('Page.enable', {}, session);
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 1800, deviceScaleFactor: 1, mobile: false },
    session
  );
  const url = `${pathToFileURL(join(DIST, 'index.html')).href}?demo=triplet&bars=16&tab=bass&verify=1`;
  await cdp.send('Page.navigate', { url }, session);

  const evaluate = async (expression, timeoutMs = 45_000) => {
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      session,
      timeoutMs
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  };
  const waitFor = async (expression, timeoutMs = 45_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`, 5_000)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`readiness timed out: ${expression}`);
  };
  const settle = (ms = 900) => evaluate(`new Promise((done) => setTimeout(() => done(true), ${ms}))`, ms + 5_000);
  const layout = async () => JSON.parse(await evaluate('JSON.stringify(window.__RIFFSHEET_LAYOUT__?.() ?? null)'));
  const shot = async (name) => {
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, session);
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const png = await cdp.send(
      'Page.captureScreenshot',
      {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: Math.max(1, Math.ceil(size.width)),
          height: Math.max(1, Math.ceil(size.height)),
          scale: 1
        }
      },
      session
    );
    await writeFile(join(OUT, name), Buffer.from(png.data, 'base64'));
  };
  const choose = (value) => evaluate(`(() => {
    const select = document.querySelector('[data-role="clef-view"]');
    if (!select || ![...select.options].some((option) => option.value === ${JSON.stringify(value)})) return false;
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const scaleToken = (scale) => String(scale).replace('.', '_');
  const captureScenarioScales = async (key, label) => {
    const results = [];
    for (const scale of [0.6, 1, 3]) {
      await evaluate(`window.__RIFFSHEET_SHEETSCALE__(${scale})`, 60_000);
      await settle(900);
      const current = await layout();
      results.push(current);
      check(
        `${label} reaches ${scale}x`,
        Math.abs(current.axis.scale - scale) <= SHEET_SCALE_TOLERANCE,
        String(current.axis.scale)
      );
      check(
        `${label} gives every part a name lane at ${scale}x`,
        everyPartHasNameLane(current.decorations),
        JSON.stringify(current.decorations.nameLanes)
      );
      check(
        `${label} gives every TAB track string letters at ${scale}x`,
        everyEligibleTrackHasStringLane(current.decorations),
        JSON.stringify(current.decorations.stringLanes)
      );
      check(
        `${label} clears every name-lane instance at ${scale}x`,
        everyNameLaneClears(current.decorations),
        JSON.stringify(current.decorations.nameLanes)
      );
      check(
        `${label} keeps every name-lane instance on-page at ${scale}x`,
        current.decorations.nameLanes.every((lane) => lane.top >= 0),
        JSON.stringify(current.decorations.nameLanes)
      );
      check(
        `${label} has zero label overlaps in every lane instance at ${scale}x`,
        everyNameLaneIsCollisionFree(current.decorations),
        JSON.stringify(current.decorations.nameLanes)
      );
      await shot(`codex-p3p5-${key}-scale-${scaleToken(scale)}.png`);
    }
    return results;
  };
  // Approach 1x from the known 0.6 floor. The app's multiplicative zoom lattice then lands on
  // 0.9375, the closest reachable step used by the tolerance above, rather than oscillating
  // around 1 from an arbitrary previous scenario and ending on whichever side step 40 reaches.
  const driveToOneStep = async () => {
    await evaluate('window.__RIFFSHEET_SHEETSCALE__(0.6)', 60_000);
    await settle(900);
    await evaluate('window.__RIFFSHEET_SHEETSCALE__(1)', 60_000);
    await settle(900);
  };

  await waitFor('window.__RIFFSHEET_DEMO_READY__ && document.querySelectorAll(".note-name").length > 0');
  await mkdir(OUT, { recursive: true });

  const scenarioLayouts = {};

  const tabOnly = JSON.parse(
    await evaluate('window.__RIFFSHEET_PARTSVISUAL__(1, true).then((value) => JSON.stringify(value))', 60_000)
  );
  await settle(1200);
  const tabOnlyLayout = await layout();
  check('TAB-only keeps the live part visible', tabOnlyLayout.decorations.tracks.length === 1 && tabOnlyLayout.decorations.tracks[0].hasTab);
  check(
    'TAB-only has its own name lane',
    everyPartHasNameLane(tabOnlyLayout.decorations),
    JSON.stringify(tabOnlyLayout.decorations.nameLanes)
  );
  check(
    'TAB-only has its own tuning lane',
    everyEligibleTrackHasStringLane(tabOnlyLayout.decorations),
    JSON.stringify(tabOnlyLayout.decorations.stringLanes)
  );
  check(
    'TAB-only name lanes clear their staff in every system',
    everyNameLaneClears(tabOnlyLayout.decorations),
    JSON.stringify(tabOnlyLayout.decorations.nameLanes)
  );
  check(
    'TAB-only pitch labels do not overlap each other',
    everyNameLaneIsCollisionFree(tabOnlyLayout.decorations),
    JSON.stringify(tabOnlyLayout.decorations.nameLanes)
  );
  check('TAB-only setup itself completed', !tabOnly.error, JSON.stringify(tabOnly));
  scenarioLayouts.tabOnly = await captureScenarioScales('tab-only', 'TAB-only');

  const mixed = JSON.parse(
    await evaluate('window.__RIFFSHEET_PARTSVISUAL__(1, false).then((value) => JSON.stringify(value))', 60_000)
  );
  await settle(1200);
  const mixedLayout = await layout();
  check(
    'mixed standard+TAB renders both notation surfaces',
    mixedLayout.hasSplit && mixedLayout.decorations.tracks.length === 1 && mixedLayout.decorations.tracks[0].hasTab,
    JSON.stringify({ hasSplit: mixedLayout.hasSplit, tracks: mixedLayout.decorations.tracks })
  );
  check(
    'mixed standard+TAB has one distinct part name lane',
    everyPartHasNameLane(mixedLayout.decorations),
    JSON.stringify(mixedLayout.decorations.nameLanes)
  );
  check(
    'mixed standard+TAB clears every name-lane instance',
    everyNameLaneClears(mixedLayout.decorations),
    JSON.stringify(mixedLayout.decorations.nameLanes)
  );
  check(
    'mixed standard+TAB has zero label overlaps',
    everyNameLaneIsCollisionFree(mixedLayout.decorations),
    JSON.stringify(mixedLayout.decorations.nameLanes)
  );
  check('mixed standard+TAB setup itself completed', !mixed.error, JSON.stringify(mixed));
  scenarioLayouts.mixedStandardTab = await captureScenarioScales(
    'mixed-standard-tab',
    'mixed standard+TAB'
  );

  const two = JSON.parse(
    await evaluate('window.__RIFFSHEET_PARTSVISUAL__(2).then((value) => JSON.stringify(value))', 60_000)
  );
  await settle(1200);
  const twoLayout = await layout();
  const twoDecorations = twoLayout.decorations;
  check(
    'two parts have two name lanes',
    everyPartHasNameLane(twoDecorations) && laneTrackIndices(twoDecorations.nameLanes).length === 2,
    JSON.stringify(twoDecorations.nameLanes)
  );
  check(
    'two-part string lanes equal tab-eligible tracks',
    everyEligibleTrackHasStringLane(twoDecorations),
    JSON.stringify(twoDecorations)
  );
  check(
    'two-part name lanes clear their own staves in every system',
    everyNameLaneClears(twoDecorations),
    JSON.stringify(twoDecorations.nameLanes)
  );
  check(
    'two-part pitch labels do not overlap each other',
    everyNameLaneIsCollisionFree(twoDecorations),
    JSON.stringify(twoDecorations.nameLanes)
  );
  scenarioLayouts.twoPart = await captureScenarioScales('two-part', 'two-part');

  const four = JSON.parse(await evaluate('window.__RIFFSHEET_PARTSVISUAL__(4).then((value) => JSON.stringify(value))', 80_000));
  await settle(1400);
  const fourLayout = await layout();
  check(
    'four parts have four independent name lanes',
    everyPartHasNameLane(fourLayout.decorations) &&
      laneTrackIndices(fourLayout.decorations.nameLanes).length === 4,
    JSON.stringify(fourLayout.decorations.nameLanes)
  );
  check(
    'four-part string letters use every eligible track',
    everyEligibleTrackHasStringLane(fourLayout.decorations),
    JSON.stringify(fourLayout.decorations.stringLanes)
  );
  check(
    'mixed tunings keep their own string counts',
    fourLayout.decorations.stringLanes.every((lane) => {
      const track = fourLayout.decorations.tracks.find((candidate) => candidate.trackIndex === lane.trackIndex);
      return !!track && lane.letters === track.strings;
    }),
    JSON.stringify(fourLayout.decorations.stringLanes)
  );
  check('four-part lanes stay on-page', fourLayout.decorations.nameLanes.every((lane) => lane.top >= 0));
  check(
    'four-part lanes clear their own staff in every system',
    everyNameLaneClears(fourLayout.decorations),
    JSON.stringify(fourLayout.decorations.nameLanes)
  );
  check(
    'four-part pitch labels do not overlap each other',
    everyNameLaneIsCollisionFree(fourLayout.decorations),
    JSON.stringify(fourLayout.decorations.nameLanes)
  );
  check('four-part setup itself completed', !four.error, JSON.stringify(four));
  scenarioLayouts.fourPart = await captureScenarioScales('four-part', 'four-part');
  const scaleResults = scenarioLayouts.fourPart;

  await driveToOneStep();
  await choose('spacing:0');
  await settle(1200);
  const tight = await layout();
  await choose('spacing:16');
  await settle(1200);
  const extra = await layout();
  check('spacing menu applies Tight', tight.decorations.spacingPx === 0);
  check('spacing menu applies Extra', extra.decorations.spacingPx === 16);
  check(
    'spacing grows within-part staff gaps monotonically',
    extra.decorations.notationStaffPaddingPx >= tight.decorations.notationStaffPaddingPx + 15.9
  );
  check(
    'spacing grows between-part name lanes monotonically',
    extra.decorations.trackStaffPaddingPx >= tight.decorations.trackStaffPaddingPx + 15.9
  );
  await shot('codex-p6-spacing-extra.png');

  for (const theme of ['midnight', 'daylight', 'ember', 'tide']) {
    await evaluate(`window.__RIFFSHEET_SETTHEME__(${JSON.stringify(theme)})`);
    await settle(1100);
    const current = await layout();
    check(
      `${theme} stays at 1x`,
      Math.abs(current.axis.scale - 1) <= SHEET_SCALE_TOLERANCE,
      String(current.axis.scale)
    );
    check(
      `${theme} retains every name lane`,
      everyPartHasNameLane(current.decorations) &&
        laneTrackIndices(current.decorations.nameLanes).length === 4,
      JSON.stringify(current.decorations.nameLanes)
    );
    check(
      `${theme} retains collision clearance`,
      everyNameLaneClears(current.decorations),
      JSON.stringify(current.decorations.nameLanes)
    );
    check(
      `${theme} retains label-to-label clearance`,
      everyNameLaneIsCollisionFree(current.decorations),
      JSON.stringify(current.decorations.nameLanes)
    );
    await shot(`codex-p3p5-theme-${theme}.png`);
  }

  for (const width of [360, 390, 900, 1440]) {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height: width < 500 ? 900 : 1200, deviceScaleFactor: 1, mobile: false },
      session
    );
    await settle(900);
    const fit = await evaluate(`(() => {
      const bar = document.querySelector('[data-role="notation-toolbar"]');
      const menu = document.querySelector('[data-role="clef-view"]');
      const spacing = menu?.querySelector('[data-role="clef-spacing"]');
      if (!bar || !menu || !spacing) return null;
      const br = bar.getBoundingClientRect();
      const mr = menu.getBoundingClientRect();
      return { overflow: Math.max(0, bar.scrollWidth - bar.clientWidth), menuLeft: mr.left, menuRight: mr.right, barLeft: br.left, barRight: br.right };
    })()`);
    check(
      `${width}px keeps spacing inside the existing Clef menu without toolbar clipping`,
      !!fit && fit.overflow <= 1 && fit.menuLeft >= fit.barLeft - 1 && fit.menuRight <= fit.barRight + 1,
      JSON.stringify(fit)
    );
  }

  await writeFile(
    join(OUT, 'codex-notation-visual.json'),
    `${JSON.stringify(
      { checks, failures, tabOnly, mixed, two, four, scenarioLayouts, scaleResults, tight, extra },
      null,
      2
    )}\n`
  );
} catch (error) {
  console.error(error?.stack ?? error);
  if (proc.exitCode === null && proc.signalCode === null) {
    await Promise.race([
      new Promise((done) => proc.once('exit', done)),
      new Promise((done) => setTimeout(done, 1_000))
    ]);
  }
  console.error(`Chrome exit: code=${String(proc.exitCode)} signal=${String(proc.signalCode)}`);
  if (stderr) console.error(`Chrome stderr:\n${stderr}`);
  process.exitCode = 1;
} finally {
  dispose();
}

if (failures > 0) process.exitCode = 1;
else if (!process.exitCode) console.log(`notation-visual-probe: ${checks}/${checks} passed`);
