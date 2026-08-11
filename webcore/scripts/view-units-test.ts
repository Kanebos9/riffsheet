/**
 * The three view modules that are pure enough to test without a browser.
 *
 *   view/staveKinds.ts   which rendered stave is which
 *   view/timeAxis.ts     the roll's time window, its grid, and the Align coupling
 *   view/watermark.ts    alphaTab's "rendered by alphaTab" credit, removed
 *
 * The watermark section renders a real score through `alphaTab.rendering.ScoreRenderer` with the
 * SVG engine. That works in Node — no DOM, no canvas — and it is the point of the section: the
 * credit is asserted to be IN what alphaTab emits and OUT of what we pass on, against the
 * renderer's own output rather than against a hand-written sample of it. If a future alphaTab
 * stops emitting the credit, the first assertion fails and tells us the strip can go.
 */

import * as alphaTab from '@coderline/alphatab';
import { buildScore, type BuildSettings } from '../../pipeline/src/index';
import { buildAlphaTabScore } from '../src/score/fromPipeline';
import {
  notationStaveIndex,
  soleStaveKind,
  staveKindsFromBars,
  staveKindsFromStaves,
  staveKindsOf,
  tabStaveIndex,
  type StaveSource
} from '../src/view/staveKinds';
import {
  ALIGN_GUTTER_PX,
  MIN_WINDOW_SEC,
  SUBS_PER_BEAT,
  TIME_ZOOM_IN_FACTOR,
  TIME_ZOOM_OUT_FACTOR,
  absoluteSheetScale,
  alignOriginSec,
  audioSecAt,
  barGrid,
  clampWindow,
  clampXToEngraving,
  subdivisionsPerBeat,
  writtenSecAt,
  coupledSheetScale,
  fracToSec,
  fullWindow,
  gridDetail,
  gridMarks,
  isFullWindow,
  medianBeatSec,
  panWindow,
  secPerPx,
  secToFrac,
  sheetScrollForSec,
  windowFollowing,
  windowFromSheet,
  windowShowing,
  zoomWindowAt,
  zoomWindowCentred,
  type BarSpan,
  type TimeLimits,
  type TimeWindow
} from '../src/view/timeAxis';
import {
  ALPHATAB_CREDIT_TEXT,
  countRendererCredits,
  stripRendererCredit,
  stripRendererCreditFromMarkup
} from '../src/view/watermark';

let checks = 0;

function assert(condition: unknown, message: string): asserts condition {
  checks++;
  if (!condition) throw new Error(message);
}

function near(actual: number, expected: number, message: string, epsilon = 1e-6): void {
  assert(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, got ${actual}`);
}

function windowIs(win: TimeWindow, from: number, to: number, message: string): void {
  near(win.fromSec, from, `${message} (fromSec)`);
  near(win.toSec, to, `${message} (toSec)`);
}

// ---------------------------------------------------------------------------
// staveKinds
// ---------------------------------------------------------------------------

const notationTab: StaveSource = { showStandardNotation: true, showTablature: true };
const notationOnly: StaveSource = { showStandardNotation: true, showTablature: false };
const tabOnly: StaveSource = { showStandardNotation: false, showTablature: true };
const slashy: StaveSource = { showStandardNotation: true, showTablature: true, showSlash: true };

assert(
  staveKindsOf(notationTab).join() === 'notation,tab',
  'one Staff showing both must render notation above tab'
);
assert(staveKindsOf(notationOnly).join() === 'notation', 'notation-only Staff renders one stave');
assert(staveKindsOf(tabOnly).join() === 'tab', 'tab-only Staff renders one stave');
assert(
  staveKindsOf(slashy).join() === 'notation,other,tab',
  'a slash stave sits BETWEEN notation and tab — the tab index must move with it'
);
assert(
  staveKindsOf({ showStandardNotation: false, showTablature: false }).length === 0,
  'a Staff that shows nothing renders nothing'
);

// The three shapes the app produces, as BOUNDS — one BarBounds per rendered stave.
assert(
  staveKindsFromBars([{ bar: { staff: notationTab } }, { bar: { staff: notationTab } }]).join() ===
    'notation,tab',
  'notation+tab: the SAME Staff twice must resolve to notation then tab'
);
{
  const upper: StaveSource = { showStandardNotation: true, showTablature: false };
  const lower: StaveSource = { showStandardNotation: true, showTablature: false };
  const grand = staveKindsFromBars([{ bar: { staff: upper } }, { bar: { staff: lower } }]);
  assert(grand.join() === 'notation,notation', 'grand staff: the bass stave is NOT tablature');
  assert(tabStaveIndex(grand) === -1, 'a grand staff has no tab stave');
  assert(soleStaveKind(grand) === 'notation', 'a grand staff is unambiguously notation');

  const grandTab = staveKindsFromBars([
    { bar: { staff: upper } },
    { bar: { staff: lower } },
    { bar: { staff: tabOnly } }
  ]);
  assert(grandTab.join() === 'notation,notation,tab', 'grand+tab: tab is the third rendered stave');
  assert(tabStaveIndex(grandTab) === 2, 'grand+tab tab index');
  assert(notationStaveIndex(grandTab) === 0, 'grand+tab first notation index');
  assert(soleStaveKind(grandTab) === null, 'mixed staves have no sole kind — the caller must hit-test');
}

// A third appearance of a Staff that only renders two staves has no kind to give.
assert(
  staveKindsFromBars([
    { bar: { staff: notationTab } },
    { bar: { staff: notationTab } },
    { bar: { staff: notationTab } }
  ]).join() === 'notation,tab,other',
  'more bounds than the Staff renders must fall back to other, not wrap around'
);
assert(
  staveKindsFromBars([{}, { bar: null }, { bar: { staff: null } }]).join() === 'other,other,other',
  'bounds with no staff must be carried as other so the indexes below stay right'
);
assert(
  staveKindsFromStaves([notationOnly, notationTab]).join() === 'notation,notation,tab',
  'the model-only answer flattens Staffs in order'
);
assert(soleStaveKind([]) === null, 'no staves, no sole kind');
assert(soleStaveKind(['other', 'tab', 'other']) === 'tab', 'other must not veto a sole kind');

// ---------------------------------------------------------------------------
// timeAxis: the window
// ---------------------------------------------------------------------------

const limits: TimeLimits = { durationSec: 10, minSpanSec: MIN_WINDOW_SEC };

windowIs(fullWindow(limits), 0, 10, 'fullWindow is the whole take');
assert(isFullWindow(fullWindow(limits), limits), 'fullWindow must report as full');
assert(!isFullWindow({ fromSec: 1, toSec: 9 }, limits), 'a narrowed window is not full');
windowIs(
  fullWindow({ durationSec: 0.001, minSpanSec: MIN_WINDOW_SEC }),
  0,
  MIN_WINDOW_SEC,
  'a take shorter than the minimum span still gets a legal window'
);

windowIs(clampWindow({ fromSec: 0, toSec: 100 }, limits), 0, 10, 'a window wider than the take collapses onto it');
windowIs(
  clampWindow({ fromSec: 8, toSec: 12 }, limits),
  6,
  10,
  'a window panned past the end SLIDES back and keeps its span'
);
windowIs(clampWindow({ fromSec: -5, toSec: -1 }, limits), 0, 4, 'a window panned before zero slides back');
windowIs(clampWindow({ fromSec: 3, toSec: 3 }, limits), 0, 10, 'a zero span is not a window; fall back to the take');
windowIs(
  clampWindow({ fromSec: 1, toSec: 1.001 }, limits),
  1,
  1 + MIN_WINDOW_SEC,
  'a span under the minimum opens back up to the minimum'
);
windowIs(
  clampWindow({ fromSec: Number.NaN, toSec: Number.NaN }, limits),
  0,
  10,
  'NaN in must not produce NaN out'
);

near(secPerPx({ fromSec: 0, toSec: 9 }, 900), 0.01, 'secPerPx');
near(secPerPx({ fromSec: 0, toSec: 9 }, 0), 9, 'secPerPx treats a zero-width plot as one pixel');
{
  const win = { fromSec: 2, toSec: 6 };
  near(secToFrac(win, 3), 0.25, 'secToFrac');
  near(fracToSec(win, 0.25), 3, 'fracToSec');
  near(fracToSec(win, secToFrac(win, 5.5)), 5.5, 'secToFrac and fracToSec must invert');
  near(secToFrac(win, 8), 1.5, 'secToFrac extrapolates outside the window rather than clamping');
}

// Zoom: the second under the pointer stays under the pointer.
{
  const win = { fromSec: 2, toSec: 6 };
  const zoomed = zoomWindowAt(win, 2, 0.25, { durationSec: 100, minSpanSec: MIN_WINDOW_SEC });
  windowIs(zoomed, 2.5, 4.5, 'zoom in about frac 0.25');
  near(fracToSec(zoomed, 0.25), fracToSec(win, 0.25), 'the anchored second must not move');

  const out = zoomWindowAt(zoomed, 0.5, 0.25, { durationSec: 100, minSpanSec: MIN_WINDOW_SEC });
  windowIs(out, 2, 6, 'zooming out by the inverse factor must return the original window');

  const roundTrip = zoomWindowAt(
    zoomWindowAt(win, TIME_ZOOM_IN_FACTOR, 0.7, limits),
    TIME_ZOOM_OUT_FACTOR,
    0.7,
    limits
  );
  windowIs(roundTrip, 2, 6, 'one notch in then one notch out is a no-op');

  windowIs(
    zoomWindowCentred(win, 2, { durationSec: 100, minSpanSec: MIN_WINDOW_SEC }),
    3,
    5,
    'the buttons zoom about the middle'
  );
  windowIs(zoomWindowAt(win, 0, 0.5, limits), 2, 6, 'a nonsense factor clamps rather than divides by zero');
  windowIs(zoomWindowAt(win, 8, 1, limits), 5.5, 6, 'zooming in at the right edge keeps the edge');
}
{
  // The hard stop, reached by zooming in far past it.
  let win: TimeWindow = fullWindow(limits);
  for (let i = 0; i < 200; i++) win = zoomWindowAt(win, TIME_ZOOM_IN_FACTOR, 0.5, limits);
  near(win.toSec - win.fromSec, MIN_WINDOW_SEC, 'zoom in must stop at MIN_WINDOW_SEC');
  for (let i = 0; i < 200; i++) win = zoomWindowAt(win, TIME_ZOOM_OUT_FACTOR, 0.5, limits);
  assert(isFullWindow(win, limits), 'zoom out must stop at the whole take');
}

windowIs(panWindow({ fromSec: 2, toSec: 6 }, 1, limits), 3, 7, 'pan slides the window');
windowIs(panWindow({ fromSec: 2, toSec: 6 }, 99, limits), 6, 10, 'pan stops at the end without narrowing');
windowIs(panWindow({ fromSec: 2, toSec: 6 }, Number.NaN, limits), 2, 6, 'a NaN pan is not a pan');
windowIs(windowShowing(5, 0.5, 4, limits), 3, 7, 'windowShowing places a second at a fraction');
windowIs(windowShowing(5, 0, 4, limits), 5, 9, 'windowShowing at the left edge');

{
  const win = { fromSec: 0, toSec: 10 };
  const wide: TimeLimits = { durationSec: 60, minSpanSec: MIN_WINDOW_SEC };
  assert(windowFollowing(win, 5, wide) === win, 'a playhead in the middle must not scroll anything');
  windowIs(windowFollowing(win, 9.5, wide), 1, 11, 'a playhead past the right margin pulls the window along');
  windowIs(windowFollowing(win, 0.5, wide), 0, 10, 'a playhead near zero cannot scroll before zero');
  windowIs(windowFollowing({ fromSec: 20, toSec: 30 }, 21, wide), 19.5, 29.5, 'following backwards');
}

// ---------------------------------------------------------------------------
// timeAxis: the grid
// ---------------------------------------------------------------------------

{
  // 120 bpm, 12 ticks per quarter: one 4/4 bar is 48 ticks and two seconds long.
  const bars = barGrid(
    {
      tempoBpm: 120,
      divisions: 12,
      bars: [
        { index: 0, number: 1, implicit: false, startTick: 0, durTicks: 48, timeSig: [4, 4] },
        { index: 1, number: 2, implicit: false, startTick: 48, durTicks: 48, timeSig: [4, 4] },
        { index: 2, number: 3, implicit: false, startTick: 96, durTicks: 36, timeSig: [3, 4] }
      ]
    },
    0.25
  );
  assert(bars.length === 3, 'barGrid returns one span per bar');
  near(bars[0].startSec, 0.25, 'the origin offsets every bar');
  near(bars[0].endSec, 2.25, 'a 4/4 bar at 120bpm is two seconds');
  near(bars[0].beatSec, 0.5, 'a beat at 120bpm is half a second');
  assert(bars[2].beats === 3, 'the beat count is the time signature numerator');
  near(bars[2].endSec, 5.75, '3/4 at 120bpm is a second and a half');
  near(medianBeatSec(bars), 0.5, 'medianBeatSec');
  near(medianBeatSec([]), 0, 'no bars, no median');
}
{
  const sixEight = barGrid(
    {
      tempoBpm: 120,
      divisions: 12,
      bars: [{ index: 0, number: 1, implicit: false, startTick: 0, durTicks: 36, timeSig: [6, 8] }]
    },
    0
  );
  assert(sixEight[0].beats === 6, '6/8 is six beats, not two — the edit grid already assumes it');
}

{
  const detailDeep = gridDetail(0.5, 0.5 / 40);
  assert(detailDeep.bars && detailDeep.beats && detailDeep.subs, 'a wide beat gets every level');
  assert(detailDeep.labelEvery === 1, 'a wide beat labels every bar');

  const detailMid = gridDetail(0.5, 0.5 / 10);
  assert(detailMid.beats && !detailMid.subs, 'ten pixels a beat is too tight for subdivisions');

  const detailTight = gridDetail(0.5, 0.5 / 5);
  assert(!detailTight.beats && !detailTight.subs, 'five pixels a beat is a tint, not a grid');
  assert(detailTight.bars, 'bar lines are drawn at every zoom');
  assert(detailTight.labelEvery === 2, 'bar numbers thin out before bar lines do');

  assert(gridDetail(0.5, 0.5 / 0.5).labelEvery === 32, 'a whole take on screen labels every 32nd bar');
  assert(gridDetail(0.5, 0).labelEvery === 1, 'a zero seconds-per-pixel must not divide by zero');
}

{
  const spans: BarSpan[] = [
    { index: 0, number: 1, implicit: false, startSec: 0, endSec: 2, beats: 4, beatSec: 0.5 },
    { index: 1, number: 2, implicit: false, startSec: 2, endSec: 4, beats: 4, beatSec: 0.5 },
    { index: 2, number: 3, implicit: false, startSec: 4, endSec: 6, beats: 4, beatSec: 0.5 }
  ];
  const all = gridMarks(spans, { fromSec: 0, toSec: 6 }, { bars: true, beats: true, subs: false, labelEvery: 1, subsPerBeat: 4 });
  assert(all.filter((m) => m.level === 'bar').length === 3, 'three bar lines');
  assert(all.filter((m) => m.level === 'beat').length === 9, 'three beats between the four bar positions of each bar');
  assert(
    all.every((mark, i) => i === 0 || all[i - 1].sec <= mark.sec),
    'marks come back in time order'
  );
  assert(
    all.filter((m) => Math.abs(m.sec - 2) < 1e-9).length === 1,
    'a position that is both a bar and a beat appears once'
  );
  assert(
    all.find((m) => Math.abs(m.sec - 2) < 1e-9)?.level === 'bar',
    'and it appears as the STRONGER weight'
  );
  assert(all.map((m) => m.label).filter(Boolean).join() === '1,2,3', 'every bar is labelled at labelEvery 1');

  const thinned = gridMarks(spans, { fromSec: 0, toSec: 6 }, { bars: true, beats: false, subs: false, labelEvery: 2, subsPerBeat: 4 });
  assert(thinned.map((m) => m.label).join() === '1,,3', 'labelEvery 2 labels every other bar');

  const windowed = gridMarks(
    spans,
    { fromSec: 2.6, toSec: 4.2 },
    { bars: true, beats: true, subs: false, labelEvery: 1, subsPerBeat: 4 }
  );
  assert(
    windowed.every((m) => m.sec >= 2.6 && m.sec <= 4.2),
    'only marks inside the window come back'
  );
  assert(
    windowed.find((m) => m.level === 'bar')?.label === '3',
    'bars scrolled off the left still count towards labelEvery, so bar 3 keeps its number'
  );

  const subs = gridMarks(
    [spans[0]],
    { fromSec: 0, toSec: 2 },
    { bars: true, beats: true, subs: true, labelEvery: 1, subsPerBeat: 4 }
  );
  assert(subs.filter((m) => m.level === 'sub').length === 12, 'four beats give twelve subdivisions');

  const anacrusis: BarSpan[] = [
    { index: 0, number: 0, implicit: true, startSec: 0, endSec: 0.5, beats: 1, beatSec: 0.5 },
    ...spans.map((s) => ({ ...s, startSec: s.startSec + 0.5, endSec: s.endSec + 0.5 }))
  ];
  const withPickup = gridMarks(
    anacrusis,
    { fromSec: 0, toSec: 7 },
    { bars: true, beats: false, subs: false, labelEvery: 1, subsPerBeat: 4 }
  );
  assert(withPickup.length === 4, 'the pickup bar still gets a bar line');
  assert(withPickup[0].label === null, 'an implicit bar prints no number');
  assert(withPickup.map((m) => m.label).join() === ',1,2,3', 'and does not shift the numbering after it');

  assert(gridMarks([], { fromSec: 0, toSec: 1 }, { bars: true, beats: true, subs: true, labelEvery: 1, subsPerBeat: 4 }).length === 0,
    'no bars, no marks');
}

// ---------------------------------------------------------------------------
// timeAxis: Align
// ---------------------------------------------------------------------------

{
  const view = { scrollLeft: 0, viewportWidth: 400, contentWidth: 1000, scale: 1 };
  near(sheetScrollForSec(2, () => 500, view) ?? -1, 500 - ALIGN_GUTTER_PX, 'the gutter comes off the scroll');
  near(sheetScrollForSec(2, () => 20, view) ?? -1, 0, 'a scroll before zero clamps to zero');
  near(sheetScrollForSec(2, () => 5000, view) ?? -1, 600, 'a scroll past the end clamps to the last page');
  assert(sheetScrollForSec(2, () => null, view) === null, 'an unengraved second means leave the scroll alone');
  assert(sheetScrollForSec(2, () => Number.NaN, view) === null, 'and so does a NaN');

  const win = windowFromSheet({ scrollLeft: 100, viewportWidth: 400, contentWidth: 2000, scale: 1 },
    (x) => x / 100, { durationSec: 30, minSpanSec: MIN_WINDOW_SEC });
  assert(win !== null, 'the sheet can answer here');
  near(win!.fromSec, (100 + ALIGN_GUTTER_PX) / 100, 'the window starts at the sheet left edge past the gutter');
  near(win!.toSec, 5, 'and ends at the sheet right edge');
  assert(windowFromSheet({ scrollLeft: 0, viewportWidth: 400, contentWidth: 2000, scale: 1 }, () => null,
    { durationSec: 30, minSpanSec: MIN_WINDOW_SEC }) === null, 'nothing engraved, no window');
  assert(windowFromSheet({ scrollLeft: 0, viewportWidth: 400, contentWidth: 2000, scale: 1 }, () => 4,
    { durationSec: 30, minSpanSec: MIN_WINDOW_SEC }) === null, 'a backwards or empty span is not a window');
}

// THE COUPLING RULE: newScale / oldScale === oldSpan / newSpan.
{
  near(coupledSheetScale(1, 4, 2, 0.25, 4), 2, 'halving the roll span doubles the sheet scale');
  near(coupledSheetScale(2, 2, 4, 0.25, 4), 1, 'and doubling it halves the scale back');
  near(coupledSheetScale(1, 4, 1, 0.25, 3), 3, 'the coupling is clamped at the top');
  near(coupledSheetScale(1, 1, 100, 0.5, 4), 0.5, 'and at the bottom');
  near(coupledSheetScale(1.5, 0, 2, 0.25, 4), 1.5, 'a zero old span leaves the scale alone');
  near(coupledSheetScale(1.5, 2, 0, 0.25, 4), 1.5, 'so does a zero new span');
  for (const [scale, oldSpan, newSpan] of [[1, 4, 2], [0.8, 3.3, 7.1], [2, 10, 0.4]] as const) {
    const next = coupledSheetScale(scale, oldSpan, newSpan, 0.01, 100);
    near(next / scale, oldSpan / newSpan, 'the ratio rule holds away from the clamps', 1e-9);
  }

  near(absoluteSheetScale(1, 100, 900, 3, 0.25, 4), 3, 'the measured form reaches the wanted span in one step');
  near(absoluteSheetScale(1, 100, 900, 9, 0.25, 4), 1, 'already right, no change');
  near(absoluteSheetScale(1, 0, 900, 3, 0.25, 4), 1, 'nothing measured, no change');
  near(absoluteSheetScale(1, 100, 0, 3, 0.25, 4), 1, 'no viewport, no change');
  near(absoluteSheetScale(1, 100, 900, 0.01, 0.25, 4), 4, 'the measured form is clamped too');
}

// ---------------------------------------------------------------------------
// watermark: against the renderer's own output
// ---------------------------------------------------------------------------

const buildSettings: BuildSettings = {
  grid: '1/8',
  fillGaps: true,
  instrument: 'guitar',
  tuningMidi: [40, 45, 50, 55, 59, 64],
  fingeringStyle: 'minMovement',
  clefMode: 'treble'
};
const built = buildScore(
  {
    notes: [
      { id: 'a', startSec: 0, endSec: 0.45, midi: 64 },
      { id: 'b', startSec: 0.5, endSec: 0.95, midi: 67 }
    ],
    beats: [0, 0.5, 1, 1.5, 2]
  },
  buildSettings
);

const atSettings = new alphaTab.Settings();
atSettings.core.engine = 'svg';
atSettings.core.enableLazyLoading = false;
const live = buildAlphaTabScore(built.toAlphaTabModelData(), atSettings);

const renderer = new alphaTab.rendering.ScoreRenderer(atSettings);
renderer.width = 900;
const partials: string[] = [];
renderer.partialRenderFinished.on((e) => {
  partials.push(String((e as { renderResult?: unknown }).renderResult ?? ''));
});
const renderErrors: string[] = [];
renderer.error.on((error) => renderErrors.push(String(error)));
renderer.renderScore(live.score, [0]);

assert(renderErrors.length === 0, `alphaTab failed to render: ${renderErrors.join('; ')}`);
assert(partials.length > 0, 'the SVG engine produced no partials');
const emitted = partials.join('\n');

/** Every `<text>` node in some markup whose content mentions alphaTab. The claim under test. */
function alphaTabTextNodes(markup: string): string[] {
  return Array.from(markup.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g))
    .map((match) => match[1])
    .filter((content) => content.includes('alphaTab'));
}

// If this fails, alphaTab has stopped emitting the credit and view/watermark.ts can be deleted.
assert(
  alphaTabTextNodes(emitted).length === 1,
  `alphaTab 1.8.4 emits exactly one credit text node; found ${alphaTabTextNodes(emitted).length}`
);
assert(alphaTabTextNodes(emitted)[0].trim() === ALPHATAB_CREDIT_TEXT, 'the credit text is the literal we match on');

const stripped = stripRendererCreditFromMarkup(emitted);
assert(alphaTabTextNodes(stripped).length === 0, 'no <text> node containing "alphaTab" may survive the strip');
assert(!stripped.includes(ALPHATAB_CREDIT_TEXT), 'and the string itself is gone from the markup');
assert(
  (stripped.match(/<text\b/g) ?? []).length === (emitted.match(/<text\b/g) ?? []).length - 1,
  'exactly one text node was removed — no bar number or tempo mark went with it'
);
assert(stripRendererCreditFromMarkup(stripped) === stripped, 'the markup strip is idempotent');
assert(stripRendererCreditFromMarkup('<svg><text>Moderato</text></svg>') === '<svg><text>Moderato</text></svg>',
  'markup with no credit comes back unchanged, so a caller can apply it unconditionally');

// ---------------------------------------------------------------------------
// watermark: the DOM path, on a stand-in for the one node type it touches
// ---------------------------------------------------------------------------

/**
 * The three members `stripRendererCredit` uses — `querySelectorAll`, `textContent`, `remove` —
 * and nothing else. A real DOM is not available in Node here and is not what is being tested:
 * the question is which nodes the rule selects, and that is answerable with a list.
 */
class FakeText {
  constructor(public textContent: string | null, private readonly parent: FakeRoot) {}
  remove(): void {
    this.parent.removeChild(this);
  }
}
class FakeRoot {
  private children: FakeText[] = [];
  add(text: string | null): FakeText {
    const node = new FakeText(text, this);
    this.children.push(node);
    return node;
  }
  removeChild(node: FakeText): void {
    this.children = this.children.filter((child) => child !== node);
  }
  querySelectorAll(selector: string): FakeText[] {
    return selector === 'text' ? [...this.children] : [];
  }
  get remaining(): (string | null)[] {
    return this.children.map((child) => child.textContent);
  }
}

const root = new FakeRoot();
root.add('1');
root.add(ALPHATAB_CREDIT_TEXT);
root.add('  rendered by alphaTab\n');
root.add('rendered by alphaTab and then some');
root.add('alphaTab');
root.add(null);
const asParent = root as unknown as ParentNode;

assert(countRendererCredits(asParent) === 2, 'the count sees the exact match and the whitespace-padded one');
assert(stripRendererCredit(asParent) === 2, 'both are removed and the count is returned');
assert(countRendererCredits(asParent) === 0, 'and none is left');
assert(
  root.remaining.join('|') === '1|rendered by alphaTab and then some|alphaTab|',
  'a text node that merely CONTAINS the words is not the credit and must survive'
);
assert(stripRendererCredit(asParent) === 0, 'the DOM strip is idempotent');
assert(stripRendererCredit(null) === 0, 'no root, nothing removed');
assert(countRendererCredits(undefined) === 0, 'no root, nothing counted');

// ---------------------------------------------------------------------------
// score/fromPipeline: the TAB metadata comes from the TAB staff (#38)
//
// Here rather than in its own file because the score is already built above and this is one
// question: `index.stringCount/tuningLowToHigh/capo` are a single answer for the whole score, and
// they used to be whatever the LAST staff of the LAST track happened to carry.
// ---------------------------------------------------------------------------

{
  const guitar = built.toAlphaTabModelData();
  const piano = buildScore(
    { notes: [{ id: 'p', startSec: 0, endSec: 0.5, midi: 60 }], beats: [0, 0.5, 1] },
    { ...buildSettings, instrument: 'staff', tuningMidi: [], clefMode: 'grand' }
  ).toAlphaTabModelData();

  const tuned = buildAlphaTabScore(guitar, new alphaTab.Settings()).index;
  assert(tuned.stringCount === 6, 'a single guitar track keeps its six strings');
  assert(tuned.tuningLowToHigh.join() === '40,45,50,55,59,64', 'and its tuning, low to high');

  const untunedOnly = buildAlphaTabScore(piano, new alphaTab.Settings()).index;
  assert(untunedOnly.stringCount === 0, 'a grand staff with no strings reports none');
  assert(untunedOnly.tuningLowToHigh.length === 0, 'and no tuning');

  // The bug: the tab staff is not last. Every edit gesture asks the index for a fretboard, so
  // an empty tuning here is a tab that cannot be dragged at all.
  const tabFirst = buildAlphaTabScore({ ...guitar, tracks: [...guitar.tracks, ...piano.tracks] },
    new alphaTab.Settings()).index;
  assert(tabFirst.stringCount === 6, 'a trailing untuned track must not erase the tab track\'s strings');
  assert(tabFirst.tuningLowToHigh.join() === '40,45,50,55,59,64', 'nor its tuning');

  const tabLast = buildAlphaTabScore({ ...piano, tracks: [...piano.tracks, ...guitar.tracks] },
    new alphaTab.Settings()).index;
  assert(tabLast.stringCount === 6, 'and the order the tracks arrive in changes nothing');
  assert(
    tabLast.tuningLowToHigh.join() === tabFirst.tuningLowToHigh.join(),
    'the same score in either track order must produce the same fretboard'
  );
}

// ---------------------------------------------------------------------------
// F3c — the drawn grid follows the Grid selector, triplets included
// ---------------------------------------------------------------------------

{
  assert(subdivisionsPerBeat('quarter') === 1, 'a quarter-note grid has no subdivision of the beat');
  assert(subdivisionsPerBeat('eighth') === 2, 'eighths are two per beat');
  assert(subdivisionsPerBeat('sixteenth') === 4, 'sixteenths are four per beat');
  assert(subdivisionsPerBeat('triplet') === 3, 'a triplet is THREE per beat — the whole point of F3c');
  assert(subdivisionsPerBeat('free') === SUBS_PER_BEAT, 'free placement falls back to the default');

  // Plenty of room, so the only thing deciding the answer is the selector.
  const roomy = 0.5 / 60;
  assert(gridDetail(0.5, roomy, 3).subsPerBeat === 3, 'the detail carries the selected subdivision');
  assert(!gridDetail(0.5, roomy, 1).subs, 'a quarter grid draws no subdivisions at all');

  const bar: BarSpan[] = [
    { index: 0, number: 1, implicit: false, startSec: 0, endSec: 2, beats: 4, beatSec: 0.5 }
  ];
  const win = { fromSec: 0, toSec: 2 };

  const triplets = gridMarks(bar, win, gridDetail(0.5, roomy, 3));
  const tripletSecs = triplets.filter((m) => m.level === 'sub').map((m) => m.sec);
  assert(tripletSecs.length === 8, 'four beats at three parts each give eight subdivision lines');
  // THE REPORTED SYMPTOM, as arithmetic: a triplet-snapped note sits a third of a beat in, and
  // there has to be a drawn line there. At four subdivisions the nearest column is a 12th of a
  // beat away, which on a zoomed-in pane is the gap the user photographed.
  assert(
    tripletSecs.some((sec) => Math.abs(sec - 0.5 / 3) < 1e-9),
    'a line is drawn exactly where a triplet-snapped note lands'
  );
  const quarters = gridMarks(bar, win, gridDetail(0.5, roomy, 4));
  assert(
    !quarters.some((sec) => Math.abs(sec.sec - 0.5 / 3) < 1e-9),
    'and the old fixed grid of four had none there — which is the bug'
  );
  assert(
    quarters.filter((m) => m.level === 'sub').length === 12,
    'four subdivisions per beat is still twelve lines, so nothing else changed'
  );

  assert(
    gridMarks(bar, win, gridDetail(0.5, roomy, 1)).every((m) => m.level !== 'sub'),
    'a quarter grid draws bars and beats and nothing finer'
  );

  // Three columns fit where four do not: the density check has to use the chosen number.
  assert(gridDetail(0.5, 0.5 / 24, 3).subs, 'three subdivisions fit in 24px a beat');
  assert(!gridDetail(0.5, 0.5 / 24, 4).subs, 'four do not');
}

// ---------------------------------------------------------------------------
// Review MAJOR — the align window is clamped to what is actually engraved
// ---------------------------------------------------------------------------

{
  const extent = { firstX: 40, lastX: 400 };
  assert(clampXToEngraving(200, extent) === 200, 'an x inside the engraving is left alone');
  assert(clampXToEngraving(900, extent) === 400, 'an x past the last bar becomes the last bar');
  assert(clampXToEngraving(-50, extent) === 40, 'an x before the first beat becomes the first beat');
  assert(clampXToEngraving(900, null) === 900, 'with no extent measured, nothing is clamped');
  assert(
    clampXToEngraving(900, { firstX: 400, lastX: 40 }) === 900,
    'a nonsense extent is ignored rather than inverting the answer'
  );

  // THE FAILURE, END TO END, with the numbers written out.
  //
  // A 20 s take engraved at 36 px per second: the first beat is at content x 40 and the last bar
  // ends at x 760. The page is 900 px wide (alphaTab's trailing padding), the pane is 500 px,
  // and the reader has scrolled to 400 — so the sheet is showing 10.94 s .. 20 s, and its right
  // viewport edge (x 900) is 140 px PAST the end of the music.
  const limits: TimeLimits = { durationSec: 20, minSpanSec: MIN_WINDOW_SEC };
  const secAt = (x: number): number => (x - 40) / 36;
  const music = { firstX: 40, lastX: 760 };
  const view = { scrollLeft: 400, viewportWidth: 500, contentWidth: 900, scale: 1 };
  const sheetLeftSec = secAt(400 + ALIGN_GUTTER_PX);

  // Extrapolated, x 900 reads as 23.89 s. The window is then 12.94 s wide but ends past the end
  // of the take, so `clampWindow` SLIDES it back keeping its span — and the left edge, which was
  // the one number Align exists to get right, moves 3.9 s (about 140 px) away from the music the
  // sheet is really showing. That is the drift.
  const unclamped = windowFromSheet(view, secAt, limits)!;
  assert(
    Math.abs(unclamped.fromSec - sheetLeftSec) > 3,
    'unclamped, the window no longer starts where the sheet does'
  );
  assert(unclamped.toSec > limits.durationSec - 1e-9, 'and it has been shoved against the end');

  const clamped = windowFromSheet(view, secAt, limits, music)!;
  near(clamped.fromSec, sheetLeftSec, 'clamped, the left edge is the second the sheet shows');
  near(clamped.toSec, 20, 'and the right edge is the end of the engraving, not somewhere past it');
  assert(clamped.toSec <= limits.durationSec + 1e-9, 'the window never runs off the end of the take');

  // Scrolled into the middle of a long engraving, the clamp must do nothing at all.
  const wide = { firstX: 40, lastX: 5000 };
  const mid = { scrollLeft: 200, viewportWidth: 500, contentWidth: 5000, scale: 1 };
  const a = windowFromSheet(mid, secAt, limits)!;
  const b = windowFromSheet(mid, secAt, limits, wide)!;
  near(a.fromSec, b.fromSec, 'inside the engraving the clamp changes nothing (from)');
  near(a.toSec, b.toSec, 'inside the engraving the clamp changes nothing (to)');
}

// ---------------------------------------------------------------------------
// F13 — bar 1 is pinned to the FIRST NOTE, not to the top of the tape
// ---------------------------------------------------------------------------

{
  // A take with 2.5 s of silence in front of it. The pipeline engraves the first attack in
  // bar 1 (written second 0); the roll and the waveform draw it at 2.5 s, where it was played.
  const origin = alignOriginSec(0, 2.5);
  near(origin, 2.5, 'written second 0 sits 2.5 s into the recording');
  near(audioSecAt(0, origin), 2.5, 'bar 1 maps to the first note, not to the start of the tape');
  near(writtenSecAt(2.5, origin), 0, 'and back again');

  // Round trip, at an arbitrary moment, is the property everything else rests on.
  near(writtenSecAt(audioSecAt(1.75, origin), origin), 1.75, 'written -> audio -> written is identity');

  // A pickup: the first attack was played BEFORE written second 0, so the origin is negative
  // and must stay negative. Clamping it to 0 re-opens the same misalignment from the other end.
  const pickup = alignOriginSec(0.5, 0.2);
  near(pickup, -0.3, 'a pickup gives a negative origin, and it is kept');

  assert(alignOriginSec(null, 2.5, 7) === 7, 'no first note falls back');
  assert(alignOriginSec(0, null, 7) === 7, 'no performed time falls back');
  assert(alignOriginSec(0, Number.NaN, 7) === 7, 'a NaN is a missing answer, not an answer');
  assert(alignOriginSec(null, null) === 0, 'and the default fallback is zero');

  // The sheet PARKS at its start rather than scrolling negative. Everything left of the first
  // note is silence the roll and the waveform still draw; the sheet simply has no page there.
  const sheet = { scrollLeft: 0, viewportWidth: 800, contentWidth: 2000, scale: 1 };
  const contentXAt = (sec: number): number => 40 + sec * 36; // written seconds -> content x
  assert(
    sheetScrollForSec(-2.5, contentXAt, sheet) === 0,
    'a second before bar 1 parks the sheet at its start'
  );
  assert(
    sheetScrollForSec(-100, contentXAt, sheet) === 0,
    'and it stays parked however far left the other strips scroll — no jump to the far end'
  );
  assert(
    sheetScrollForSec(4, contentXAt, sheet) === 40 + 4 * 36 - ALIGN_GUTTER_PX,
    'inside the take it is the plain mapping, gutter removed'
  );
  assert(
    sheetScrollForSec(1000, contentXAt, sheet) === 2000 - 800,
    'and it stops at the end of the page rather than scrolling past it'
  );
}

// ---------------------------------------------------------------------------
// F2a — hiding the tab rests changes the picture and NOT the playback
//
// The sound-sacred proof for score/fromPipeline.ts: every beat's playback identity is dumped
// with and without the flag and the two dumps must be byte-identical. See `hideTabRests`.
// ---------------------------------------------------------------------------

{
  const request = {
    notes: [
      { id: 'a', startSec: 0, endSec: 0.4, midi: 45 },
      { id: 'b', startSec: 1.0, endSec: 1.4, midi: 52 }
    ],
    beats: [0, 0.5, 1, 1.5, 2]
  };
  const built = buildScore(request, {
    grid: '1/8',
    fillGaps: true,
    instrument: 'guitar',
    tuningMidi: [40, 45, 50, 55, 59, 64],
    fingeringStyle: 'minMovement',
    clefMode: 'grand'
  });
  const data = built.toAlphaTabModelData();

  const tabStaves = data.tracks.flatMap((t) => t.staves).filter((s) => s.showTablature);
  assert(tabStaves.length > 0, 'the grand + tab fixture really does carry a tab staff');

  /** Everything that decides WHEN a beat sounds and for how long. Nothing about how it looks. */
  const playbackDump = (score: alphaTab.model.Score): string => {
    const rows: string[] = [];
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        for (const bar of staff.bars) {
          for (const voice of bar.voices) {
            for (const beat of voice.beats) {
              rows.push(
                [
                  beat.absolutePlaybackStart,
                  beat.playbackDuration,
                  beat.duration,
                  beat.dots,
                  beat.isEmpty ? 1 : 0,
                  beat.isRest ? 1 : 0,
                  beat.notes.map((n) => `${n.realValue}:${n.string ?? ''}:${n.fret ?? ''}`).join('+')
                ].join('|')
              );
            }
          }
        }
      }
    }
    return rows.join('\n');
  };

  const withFlag = buildAlphaTabScore(data, new alphaTab.Settings()).score;
  // The control: the same data with every staff claiming it prints its rests, which is the
  // branch `hideTabRests` is never reached from.
  const control = buildAlphaTabScore(
    {
      ...data,
      tracks: data.tracks.map((t) => ({
        ...t,
        staves: t.staves.map((s) => ({ ...s, showRests: true }))
      }))
    },
    new alphaTab.Settings()
  ).score;

  assert(
    playbackDump(withFlag) === playbackDump(control),
    'playback dump is byte-identical with and without the hidden tab rests'
  );

  /** Beats carrying the transparent GuitarTabRests override, per staff. */
  const hidden = (score: alphaTab.model.Score): number[] =>
    score.tracks.flatMap((t) =>
      t.staves.map((s) =>
        s.bars.reduce(
          (n, bar) =>
            n +
            bar.voices.reduce(
              (m, v) =>
                m +
                v.beats.filter((b) =>
                  b.style?.colors.has(alphaTab.model.BeatSubElement.GuitarTabRests)
                ).length,
              0
            ),
          0
        )
      )
    );

  assert(hidden(control).every((n) => n === 0), 'a staff that prints its rests is left untouched');
  const marked = hidden(withFlag);
  assert(marked.some((n) => n > 0), 'the tab-only staff of grand + tab has its rests suppressed');
  // Exactly one staff: the notation staves must keep their rests, which is what makes the tab's
  // column a duplicate rather than the only one.
  assert(marked.filter((n) => n > 0).length === 1, 'and it is the ONLY staff that does');
  const colors = withFlag.tracks
    .flatMap((t) => t.staves)
    .flatMap((s) => s.bars)
    .flatMap((b) => b.voices)
    .flatMap((v) => v.beats)
    .map((b) => b.style?.colors.get(alphaTab.model.BeatSubElement.GuitarTabRests))
    .filter((c) => c !== undefined);
  assert(colors.length > 0 && colors.every((c) => c!.a === 0), 'the override is fully transparent');

  // AND THE LIVE RENDER AGREES. alphaTab's own SVG engine, in Node, on the grand + tab score:
  // the flagged render must lay the page out identically to the control and differ from it only
  // in ink. That is the whole claim in one comparison — no rest glyph moved, none was removed,
  // and the ones on the tab staff are painted with nothing.
  const renderMarkup = (score: alphaTab.model.Score): string => {
    const s = new alphaTab.Settings();
    s.core.engine = 'svg';
    s.core.enableLazyLoading = false;
    s.core.useWorkers = false;
    s.display.layoutMode = alphaTab.LayoutMode.Horizontal;
    const r = new alphaTab.rendering.ScoreRenderer(s);
    r.width = 900;
    const out: string[] = [];
    const errs: string[] = [];
    r.partialRenderFinished.on((e) => out.push(String((e as { renderResult?: unknown }).renderResult ?? '')));
    r.error.on((e) => errs.push(String(e)));
    r.renderScore(score, [0]);
    assert(errs.length === 0, `grand + tab failed to render: ${errs.join('; ')}`);
    assert(out.length > 0, 'the grand + tab render produced no partials');
    return out.join('\n');
  };

  const hiddenMarkup = renderMarkup(withFlag);
  const shownMarkup = renderMarkup(control);
  const transparent = (m: string): number => (m.match(/rgba\(\d+,\s*\d+,\s*\d+,\s*0\)/g) ?? []).length;
  assert(transparent(hiddenMarkup) > 0, 'the tab rests are painted with a transparent fill');
  assert(transparent(shownMarkup) === 0, 'and the control paints nothing transparent at all');
  // Colour out — `fill`/`stroke`, which is where the override lands — and alphaTab's group
  // classes out with it, because they carry beat ids and ids are a global counter, so the second
  // score built in this process gets higher numbers for the same music. Everything that survives
  // is geometry: transforms, coordinates, glyph codepoints, in order.
  const inkless = (m: string): string =>
    m.replace(/ (fill|stroke|class)="[^"]*"/g, '');
  assert(
    inkless(hiddenMarkup) === inkless(shownMarkup),
    'the two renders are byte-identical once colour is removed: nothing moved, nothing was dropped'
  );
}

console.log(`view-units-test: passed (${checks} checks)`);
