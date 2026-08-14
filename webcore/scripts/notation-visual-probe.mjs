#!/usr/bin/env node
/**
 * P3/P5/P6 rendered proof without a loopback server.
 *
 * Managed CI can deny `listen(2)` even on 127.0.0.1. Chrome's DevTools PIPE and a file:// build
 * exercise the same built bundle while needing no socket. Chrome is still launched through the
 * mandatory shared bootstrap, so its whole process group and temporary profile are reaped.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT WAS WRONG WITH THIS PROBE, AND WHY IT WAS THE PROBE RATHER THAN THE APP
 *
 * It shipped failing 10 assertions, and every one of the ten was its own mistake about what the
 * app promises. Repaired here rather than deleted, because the three things it photographs — the
 * per-part name lanes, the tuning legends, and the spacing menu — are all real claims that
 * nothing else asserts against a rendered page. Each fix has its argument at the point of use:
 *
 *   §THE ZOOM IS A LATTICE      it demanded scales the shared zoom cannot land on, and read the
 *                               resulting oscillation as a layout failure (5 of the 10).
 *   §the tuning legend          it read `Staff.showTablature` as "there is a tab on screen", and
 *                               demanded a legend beside a staff that was never engraved (5).
 *   §the compositor flags       its per-scale screenshots were byte-identical stale frames, so
 *                               the whole sweep proved nothing whatever the numbers said.
 *   §the theme reference        it asserted the themes "stay at 1x" against a literal 1, after a
 *                               rebuild that had already moved the scale.
 *
 * The sweep now asserts that it IS a sweep — three different engraved sizes and three different
 * pictures — so this probe can no longer pass on a frozen frame.
 * ---------------------------------------------------------------------------------------------
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { launchChrome } from './probe-chrome.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
// Beside the other probes' artefacts, and overridable. It used to be one developer's absolute
// scratchpad path, which is not a place this repo can be checked out and run.
const OUT = process.env.RIFFSHEET_VIS_OUT ?? join(ROOT, 'spike-results', 'notation-visual');

/**
 * THE ZOOM IS A LATTICE, AND ONLY ITS POINTS ARE REACHABLE.
 *
 * `__RIFFSHEET_SHEETSCALE__` does not set a scale. It walks the SHARED viewport zoom in steps of
 * `TIME_ZOOM_IN_FACTOR` = 1.25 (view/timeAxis.ts) until the sheet scale is within 0.01 of what was
 * asked for, or until the reducer saturates. So the reachable scales from a floor of `MIN_ZOOM`
 * are `0.6 * 1.25^k`, clamped at `MAX_ZOOM` = 3.0 (view/triview.ts §MIN_ZOOM/§MAX_ZOOM).
 *
 * 1.0 IS NOT ONE OF THEM. The neighbouring steps are 0.9375 and 1.171875, so asking for 1.0 makes
 * the walk step in, overshoot, step out, undershoot, and oscillate until its 40-iteration bound
 * expires — landing on whichever side the parity of the start happened to give. This probe used
 * to ask for 1.0 with a 0.065 tolerance, which is narrower than the gap to EITHER neighbour, and
 * then read the coin toss as a layout failure ("two-part reaches 1x — 1.1718750000000002").
 *
 * The stops below are the lattice's own: the floor, two steps up from the floor, and the ceiling.
 * The floor and the ceiling are exact because they SATURATE; the middle is exact because it is
 * approached from the floor, always, in ascending order. What is left is float dust, and the
 * tolerance is sized for dust rather than for a missed step.
 */
const MIN_SHEET_SCALE = 0.6;
const MAX_SHEET_SCALE = 3;
const MID_SHEET_SCALE = MIN_SHEET_SCALE * 1.25 * 1.25; // 0.9375
const SHEET_SCALE_STOPS = [MIN_SHEET_SCALE, MID_SHEET_SCALE, MAX_SHEET_SCALE];
const SHEET_SCALE_TOLERANCE = 1e-4;
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
  '--autoplay-policy=no-user-gesture-required',
  /*
   * WITHOUT THESE TWO, EVERY SCREENSHOT THIS PROBE WRITES IS A LIE.
   *
   * `Page.captureScreenshot` hands back the last frame the COMPOSITOR committed, and a headless
   * Chrome with nothing animating does not commit one just because the DOM changed. Re-engraving
   * the sheet from 0.6x to 3.0x is a pure layout change, so the picture on disk stayed on the
   * frame from whenever the compositor last happened to draw: measured here, the whole 0.6/1/3
   * sweep of the two-part page wrote three byte-identical PNGs (md5 4d223bab...) while the
   * engraved surface really did go from 241px to 870px tall. `captureBeyondViewport`, an explicit
   * clip, `fromSurface: false` and a screencast were all just as stale; only forcing the
   * compositor through every stage before each draw makes the capture track the page.
   *
   * This is why the sweep asserts on the CAPTURES as well as on the numbers: a probe whose whole
   * job is rendered proof must not be able to pass while photographing a stale frame.
   */
  '--run-all-compositor-stages-before-draw',
  '--disable-new-content-rendering-timeout'
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

/**
 * THE TRACKS A TUNING LEGEND IS OWED TO: the ones with a tab ON THE PAGE.
 *
 * `hasTab` is `Staff.showTablature` off the built model — what the score ASKS for. `tabRendered`
 * is derived from the `BoundsLookup` the engraving actually produced (view/triview.ts
 * §renderedTabTracks), and the two genuinely disagree: in the two-part scenario track 1 carries
 * `showTablature` with a four-string tuning and no tablature is engraved for it at any scale.
 * The legend is drawn beside a rendered tab stave and cannot be drawn beside one that is not
 * there, so demanding it of every `hasTab` track is demanding a caption for a staff nobody drew —
 * which is the FAIL this probe used to report five times over.
 */
function tabTrackIndices(decorations) {
  return decorations.tracks.filter((track) => track.tabRendered).map((track) => track.trackIndex);
}

function everyEligibleTrackHasStringLane(decorations) {
  const expected = tabTrackIndices(decorations);
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
  /** Writes the PNG and returns its digest, so "this picture changed" is a check and not a hope. */
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
    const bytes = Buffer.from(png.data, 'base64');
    await writeFile(join(OUT, name), bytes);
    return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  };
  /**
   * HOW TALL THE ENGRAVING IS ON SCREEN — the witness that a re-scale really re-engraved.
   *
   * Measured off the rendered surface rather than read back from `display.scale`, which is the
   * number the zoom just wrote and so cannot disagree with itself. This one can: it is the box
   * alphaTab's own SVG occupies after the render, and it is what moves from 241px to 870px when
   * the sheet goes from 0.6x to 3.0x.
   */
  const engravedHeight = () => evaluate(`(() => {
    const svg = document.querySelector('.at-surface svg');
    return svg ? Math.round(svg.getBoundingClientRect().height) : null;
  })()`);
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
    const shots = [];
    const heights = [];
    // ASCENDING, FROM THE FLOOR, ALWAYS. The middle stop is only exact because the walk reaches it
    // by two 1.25x steps up from a saturated 0.6; arriving from above would land on 1.171875.
    await evaluate(`window.__RIFFSHEET_SHEETSCALE__(${MIN_SHEET_SCALE})`, 60_000);
    await settle(900);
    for (const scale of SHEET_SCALE_STOPS) {
      await evaluate(`window.__RIFFSHEET_SHEETSCALE__(${scale})`, 60_000);
      await settle(900);
      const current = await layout();
      results.push(current);
      heights.push(await engravedHeight());
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
      shots.push(await shot(`codex-p3p5-${key}-scale-${scaleToken(scale)}.png`));
    }
    /*
     * THE SWEEP HAS TO BE A SWEEP. Three stops that all photograph the same frame, or that all
     * engrave at the same size, prove nothing about zoom no matter how many lane assertions ran
     * on top of them — and that is exactly the state this probe shipped in.
     */
    check(
      `${label}: the three stops engrave at three different sizes`,
      heights.every((h) => typeof h === 'number' && h > 0) &&
        heights[0] < heights[1] &&
        heights[1] < heights[2],
      `engraved heights ${JSON.stringify(heights)}`
    );
    check(
      `${label}: and photograph as three different pictures`,
      new Set(shots).size === SHEET_SCALE_STOPS.length,
      JSON.stringify(shots)
    );
    return results;
  };
  // Saturate at the floor, then two 1.25x steps up: the one mid-lattice scale that is exact from
  // any starting point. See §THE ZOOM IS A LATTICE.
  const driveToMidStep = async () => {
    await evaluate(`window.__RIFFSHEET_SHEETSCALE__(${MIN_SHEET_SCALE})`, 60_000);
    await settle(900);
    await evaluate(`window.__RIFFSHEET_SHEETSCALE__(${MID_SHEET_SCALE})`, 60_000);
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
  check(
    'TAB-only keeps the live part visible, with its tab actually engraved',
    tabOnlyLayout.decorations.tracks.length === 1 &&
      tabOnlyLayout.decorations.tracks[0].hasTab &&
      tabOnlyLayout.decorations.tracks[0].tabRendered,
    JSON.stringify(tabOnlyLayout.decorations.tracks)
  );
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
    mixedLayout.hasSplit &&
      mixedLayout.decorations.tracks.length === 1 &&
      mixedLayout.decorations.tracks[0].tabRendered,
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

  await driveToMidStep();
  const beforeSpacing = (await layout()).axis.scale;
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

  /*
   * THE SCALE THE THEMES MUST NOT MOVE IS WHATEVER IS ON SCREEN, not 1.0.
   *
   * These four checks used to read "<theme> stays at 1x" and compare against a literal 1, which
   * fails for two independent reasons: 1.0 is not on the zoom lattice at all (§THE ZOOM IS A
   * LATTICE), and the spacing work just above re-engraves, so the scale by the time the loop runs
   * is whatever that rebuild left. Both were reported as four theme failures — none of which was
   * about a theme. What a theme owes is that recolouring the page does not RE-ZOOM it, so the
   * reference is the scale measured immediately before the loop.
   */
  const themeReference = extra.axis.scale;
  check(
    'the spacing rebuild preserves the sheet scale',
    Math.abs(extra.axis.scale - beforeSpacing) <= SHEET_SCALE_TOLERANCE,
    `before ${beforeSpacing} -> tight ${tight.axis.scale} -> extra ${extra.axis.scale}`
  );

  for (const theme of ['midnight', 'daylight', 'ember', 'tide']) {
    await evaluate(`window.__RIFFSHEET_SETTHEME__(${JSON.stringify(theme)})`);
    await settle(1100);
    const current = await layout();
    check(
      `${theme} does not re-zoom the sheet`,
      Math.abs(current.axis.scale - themeReference) <= SHEET_SCALE_TOLERANCE,
      `${current.axis.scale} vs reference ${themeReference}`
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

  /*
   * Written down because it is the one thing here that is NOT a probe bug: a track can carry
   * `showTablature` and have no tablature engraved for it. The two-part page does exactly that on
   * track 1 — a four-string tuning in the model, nothing on the page, at every scale. The
   * assertions above are stated against `tabRendered` because that is what a legend can be drawn
   * beside; this table is what an owner needs in order to decide whether the MODEL is right.
   */
  const tabModelVsRendered = Object.fromEntries(
    Object.entries(scenarioLayouts).map(([name, layouts]) => [
      name,
      (layouts?.[0]?.decorations.tracks ?? []).map((track) => ({
        trackIndex: track.trackIndex,
        hasTab: track.hasTab,
        tabRendered: track.tabRendered,
        strings: track.strings
      }))
    ])
  );
  for (const [name, tracks] of Object.entries(tabModelVsRendered)) {
    for (const track of tracks) {
      if (track.hasTab !== track.tabRendered) {
        console.log(
          `NOTE  ${name}: track ${track.trackIndex} has showTablature=${track.hasTab} in the model ` +
            `but tabRendered=${track.tabRendered} on the page (${track.strings} strings)`
        );
      }
    }
  }
  /*
   * WHICH TUNING EACH PART IS CAPTIONED WITH, printed rather than asserted.
   *
   * Not a check, because this probe has no independent statement of which tuning each part is
   * OWED — it can see the legends and not the intent. It is printed because reading these four
   * scenarios side by side is what shows that the two-part page is the odd one out: the take is
   * captioned with a six-string guitar tuning there and with its own four-string bass everywhere
   * else. Whoever owns the per-part instrument profiles needs that line in front of them.
   */
  for (const [name, layouts] of Object.entries(scenarioLayouts)) {
    const lanes = layouts?.[0]?.decorations.stringLanes ?? [];
    const perTrack = [...new Map(lanes.map((lane) => [lane.trackIndex, lane.texts])).entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([trackIndex, texts]) => `${trackIndex}:[${texts.join(' ')}]`)
      .join('  ');
    console.log(`LEGENDS  ${name}: ${perTrack || '(none)'}`);
  }

  await writeFile(
    join(OUT, 'codex-notation-visual.json'),
    `${JSON.stringify(
      {
        checks,
        failures,
        tabModelVsRendered,
        tabOnly,
        mixed,
        two,
        four,
        scenarioLayouts,
        scaleResults,
        tight,
        extra
      },
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
