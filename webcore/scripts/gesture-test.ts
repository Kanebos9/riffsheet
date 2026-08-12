/**
 * THE PINCH LAW, REPLAYED. One physical gesture must produce ONE semantic zoom command.
 *
 * WHY A REPLAY AND NOT A LIVE TEST. The thing under test is what happens when macOS delivers the
 * same pinch down TWO roads at once — a ctrl-wheel and WebKit's `gesturestart`/`gesturechange`/
 * `gestureend` — and no headless browser on any CI machine will ever do that: Chromium has never
 * implemented `GestureEvent` at all. Synthesising the events proves the handler runs, not that
 * the platform sends them. So the streams are DATA (scripts/fixtures/gesture/*.json), each one
 * carrying its own provenance, and this file replays them through the one state machine that
 * decides — `view/gesture.ts` — asserting on the COMMANDS that come out rather than on pixels.
 *
 * WHAT EACH FIXTURE'S `provenance` MEANS, and it is the honest part of this file:
 *
 *   captured   recorded from a real event stream by a capture-phase listener on the real app.
 *              `roll-ctrlwheel-chromium.json` is such a recording, taken by
 *              scripts/scrollzoom-probe.mjs. Every event in it was dispatched by the browser to
 *              the shipped handlers, and `isTrusted` is recorded per event so a synthesised one
 *              cannot be mistaken for a delivered one.
 *   constructed the WKWebView shape, written from WebKit's `GestureEvent` contract (cumulative
 *              `scale` from 1 at `gesturestart`, monotone during the pinch, `gestureend` on
 *              lift). NOT a hardware capture — see the fixture's own note for the recipe that
 *              turns it into one, and treat any claim about WKWebView timing as unverified until
 *              somebody runs it.
 *
 * THE FOUR CLAIMS, one per finding in the audit:
 *
 *   1. wheel-only        (Windows/WebView2, and every Chromium): one pinch, one road, N commands
 *                        of the right sign and no phantom road switch.
 *   2. GestureEvent-only (WKWebView builds that do not synthesise the wheel): same total zoom.
 *   3. BOTH, either order: still ONE command per event pair — never two.
 *   4. Option+pinch on both roads: exactly one PITCH zoom per gesture, which is the bug that
 *      was live in pianoroll.ts (the altKey branch returned before the road was claimed).
 */

// IMPORTED, NOT READ FROM DISK: `run-ts-tests.mjs` bundles this file into a temp directory, so a
// path relative to `import.meta.dirname` points at the temp directory and not at the fixtures.
// Bundling them in also means a stale fixture cannot be silently picked up from somewhere else.
import ctrlWheelChromium from './fixtures/gesture/roll-ctrlwheel-chromium.json';
import webkitBothRoads from './fixtures/gesture/roll-webkit-both-roads.json';
import {
  PinchGesture,
  PINCH_IDLE_MS,
  PINCH_ROADS,
  wheelZoomFactor,
  clampZoomStep,
  WHEEL_ZOOM_MAX_STEP,
  type PinchInput,
  type PinchOutcome
} from '../src/view/gesture';

let checks = 0;

function assert(condition: unknown, message: string): asserts condition {
  checks++;
  if (!condition) throw new Error(message);
}

function near(actual: number, expected: number, message: string, epsilon = 1e-9): void {
  assert(
    Math.abs(actual - expected) <= epsilon,
    `${message} (got ${actual}, wanted ${expected} +/- ${epsilon})`
  );
}

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

interface Trace {
  name: string;
  provenance: 'captured' | 'constructed';
  engine: string;
  note: string;
  events: Array<PinchInput & { isTrusted?: boolean; cancelable?: boolean; defaultPrevented?: boolean }>;
}

const TRACES: Readonly<Record<string, Trace>> = {
  'roll-ctrlwheel-chromium.json': ctrlWheelChromium as unknown as Trace,
  'roll-webkit-both-roads.json': webkitBothRoads as unknown as Trace
};

function load(name: string): Trace {
  const trace = TRACES[name];
  if (!trace) throw new Error(`no such gesture fixture: ${name}`);
  return trace;
}

/** Replay one stream and keep every zoom the law asked for. */
function replay(events: readonly PinchInput[]): Array<Extract<PinchOutcome, { kind: 'zoom' }>> {
  const g = new PinchGesture();
  const out: Array<Extract<PinchOutcome, { kind: 'zoom' }>> = [];
  for (const e of events) {
    const r = g.read(e);
    if (r.kind === 'zoom') out.push(r);
  }
  return out;
}

/** The product of every factor: "how far did the view actually move", the semantic answer. */
function totalZoom(zooms: ReadonlyArray<{ factor: number }>): number {
  return zooms.reduce((acc, z) => acc * z.factor, 1);
}

// ---------------------------------------------------------------------------
// 0 — the law's own arithmetic
// ---------------------------------------------------------------------------
{
  near(wheelZoomFactor(0), 1, 'no movement is no zoom');
  assert(wheelZoomFactor(-10) > 1, 'up/left zooms IN');
  assert(wheelZoomFactor(10) < 1, 'down/right zooms OUT');
  near(
    wheelZoomFactor(-10) * wheelZoomFactor(10),
    1,
    'a flick one way and back lands exactly where it started',
    1e-12
  );
  near(wheelZoomFactor(-10000), WHEEL_ZOOM_MAX_STEP, 'one violent event is clamped', 1e-12);
  near(clampZoomStep(1000), WHEEL_ZOOM_MAX_STEP, 'so is a violent gesture ratio', 1e-12);
  near(clampZoomStep(0), 1, 'and rubbish is the identity rather than a jump');
  assert(
    PINCH_ROADS.chromium.length === 1 && PINCH_ROADS.chromium[0] === 'wheel',
    'Chromium — and therefore WebView2 on Windows — has only the wheel road'
  );
  assert(PINCH_ROADS.webkit.length === 2, 'WKWebView has both roads, which is why the dedupe exists');
}

// ---------------------------------------------------------------------------
// 1 — WHEEL ONLY. The Windows/WebView2 road, and the one this repo can capture.
// ---------------------------------------------------------------------------
{
  const trace = load('roll-ctrlwheel-chromium.json');
  assert(trace.provenance === 'captured', 'the wheel fixture is a recording, not a hand-written stream');
  assert(
    trace.events.length > 0 && trace.events.every((e) => e.kind === 'wheel'),
    'and it is wheel events end to end — Chromium never dispatched a GestureEvent'
  );
  assert(
    trace.events.every((e) => e.ctrlKey === true),
    'every one of them carries ctrlKey, which is how macOS and Windows both spell "pinch"'
  );
  assert(
    trace.events.every((e) => e.isTrusted === true),
    'and every one was dispatched by the ENGINE, not by a script — that is what makes it a capture'
  );
  assert(
    trace.events.every((e) => e.defaultPrevented === true),
    'the handler swallowed all of them: an unhandled ctrl-wheel is the plugin window page-zooming'
  );

  const zooms = replay(trace.events);
  assert(
    zooms.length === trace.events.length,
    `every wheel event of a pinch is one zoom on the wheel road (got ${zooms.length} of ${trace.events.length})`
  );
  assert(zooms.every((z) => z.road === 'wheel'), 'and they all came down the wheel road');
  assert(zooms.every((z) => z.axis === 'time'), 'a pinch with no Option is the TIME axis');
  assert(
    totalZoom(zooms) > 1,
    'a pinch OUT (negative deltas) zooms in, which is the direction the fixture was recorded in'
  );

  // The same events replayed one at a time through one machine must not start refusing
  // themselves: same road again is always allowed, however long the gesture runs.
  const slow = trace.events.map((e, i) => ({ ...e, atMs: i * (PINCH_IDLE_MS * 4) }));
  assert(
    replay(slow).length === trace.events.length,
    'a road never locks itself out, however slowly its own events arrive'
  );
}

// ---------------------------------------------------------------------------
// 2 — GESTUREEVENT ONLY, and 3 — BOTH ROADS, both orderings
// ---------------------------------------------------------------------------
{
  const trace = load('roll-webkit-both-roads.json');
  assert(trace.provenance === 'constructed', 'the WKWebView fixture says so on its face');

  const gestureOnly = trace.events.filter((e) => e.kind !== 'wheel');
  const wheelOnly = trace.events.filter((e) => e.kind === 'wheel');
  assert(gestureOnly.length > 2 && wheelOnly.length > 0, 'the fixture carries both roads to interleave');

  const alone = replay(gestureOnly);
  assert(alone.length > 0, 'a GestureEvent-only build still zooms');
  assert(alone.every((z) => z.road === 'gesture'), 'on the gesture road');

  // THE CLAIM THAT MATTERS. Delivered on both roads, in either order, the same physical pinch
  // must be worth what it was worth on one road — not twice. WHICH road speaks first is not
  // knowable in advance (it is a property of the WebKit build), so both orderings are replayed:
  // as captured, `gesturestart` opens the stream; the other ordering is the same events with the
  // first ctrl-wheel arriving before it.
  const gestureFirst = replay(trace.events);
  const firstWheel = trace.events.findIndex((e) => e.kind === 'wheel');
  const reordered = [...trace.events];
  reordered.splice(0, 0, ...reordered.splice(firstWheel, 1));
  const wheelFirst = replay(reordered);

  assert(
    gestureFirst.every((z) => z.road === gestureFirst[0].road),
    'one gesture, ONE road: no event of it was answered on the other'
  );
  assert(
    wheelFirst.length > 0 && wheelFirst.every((z) => z.road === 'wheel'),
    'whichever road speaks first owns the whole gesture (wheel first)'
  );
  assert(
    gestureFirst.every((z) => z.road === 'gesture'),
    'and the same the other way round (gesture first)'
  );
  assert(
    wheelFirst.every((z) => z.road === wheelFirst[0].road),
    'the reordering changes WHICH road wins, never that only one does'
  );

  // The old code's fault, stated as a number: the two roads' zooms multiplied together is what
  // the user used to get. Neither ordering may reach it.
  const doubled = totalZoom(replay(wheelOnly)) * totalZoom(alone);
  assert(
    Math.abs(totalZoom(wheelFirst) - doubled) > 1e-6 && Math.abs(totalZoom(gestureFirst) - doubled) > 1e-6,
    'and it is nowhere near the doubled zoom the un-deduped code produced'
  );
}

// ---------------------------------------------------------------------------
// 4 — OPTION+PINCH, the bug that was live in pianoroll.ts
// ---------------------------------------------------------------------------
{
  // The exact shape of the fault: a ctrl-wheel with altKey, followed by WebKit's copy of the
  // same event. The old wheel handler applied the vertical zoom and returned BEFORE claiming the
  // road, so the gesture road was free and applied it a second time.
  const events: PinchInput[] = [
    { kind: 'gesturestart', atMs: 0, scale: 1 },
    { kind: 'wheel', atMs: 1, delta: -12, ctrlKey: true, altKey: true },
    { kind: 'gesturechange', atMs: 2, scale: 1.05, altKey: true },
    { kind: 'wheel', atMs: 16, delta: -12, ctrlKey: true, altKey: true },
    { kind: 'gesturechange', atMs: 17, scale: 1.1, altKey: true },
    { kind: 'gestureend', atMs: 40 }
  ];
  const zooms = replay(events);
  assert(zooms.length === 2, `Option+pinch is applied once per event pair, not twice (got ${zooms.length})`);
  assert(zooms.every((z) => z.axis === 'pitch'), 'Option picks the PITCH axis');
  assert(zooms.every((z) => z.road === 'gesture'), 'on the one road that spoke first, and only that one');

  // The same gesture with the ctrl-wheel arriving first — which is the shape that was actually
  // broken, because the old wheel handler applied the pitch zoom without claiming anything.
  const wheelLed = replay([events[1], ...events]);
  assert(
    wheelLed.every((z) => z.road === 'wheel' && z.axis === 'pitch'),
    'and when the wheel copy arrives first it owns the gesture, gesturestart notwithstanding'
  );
  assert(
    wheelLed.length === 3,
    `three wheel events, three pitch zooms, and the GestureEvent copies added none (got ${wheelLed.length})`
  );

  // Alt with NO pinch is a plain mouse and is on no road at all — it must never be deduped away,
  // and it must never claim a road a real pinch would then be refused from.
  const mouse = replay([
    { kind: 'wheel', atMs: 0, delta: -120, altKey: true },
    { kind: 'wheel', atMs: 16, delta: -120, altKey: true }
  ]);
  assert(mouse.length === 2, 'a mouse wheel with Alt is two zooms, because it is two notches');
  const g = new PinchGesture();
  g.read({ kind: 'wheel', atMs: 0, delta: -120, altKey: true });
  assert(g.road === null, 'and it claimed no road, so a real pinch straight after it is not refused');
}

// ---------------------------------------------------------------------------
// 5 — THE ROAD HOLDS THROUGH THE QUIET MIDDLE OF A SLOW PINCH
// ---------------------------------------------------------------------------
{
  // THE THIRD FAULT. A slow pinch's per-event ratios sit under the accumulator's threshold, so
  // nothing is APPLIED for a while. The old rule refused the other road only while the last
  // applied zoom was under 250 ms old, so after a quarter second of gentle movement the other
  // road was let in and the second half of one gesture was counted twice.
  const events: PinchInput[] = [{ kind: 'gesturestart', atMs: 0, scale: 1 }];
  // Ratios of 1.00001 — far below `PinchAccumulator`'s 1e-4 step — for a whole second.
  for (let i = 1; i <= 60; i++) {
    events.push({ kind: 'gesturechange', atMs: i * 16, scale: 1 + i * 0.00001 });
    // The ctrl-wheel copy of the same fingers, arriving all the way through.
    events.push({ kind: 'wheel', atMs: i * 16 + 1, delta: -0.05, ctrlKey: true });
  }
  events.push({ kind: 'gestureend', atMs: 1000 });

  const g = new PinchGesture();
  const roads = new Set<string>();
  for (const e of events) {
    const out = g.read(e);
    if (out.kind === 'zoom') roads.add(out.road);
  }
  assert(
    roads.size === 1 && roads.has('gesture'),
    `one slow pinch stays on the road that started it (saw ${[...roads].join('+') || 'nothing'})`
  );
  assert(g.inContact === false, 'and gestureend put the fingers back up');
  assert(g.road === null, 'releasing the road, so the next gesture starts fresh');

  // Without `gestureend` — which is what shipped — the road would still be released, but only by
  // the idle timeout. That is the ONLY thing the timeout is for now.
  const h = new PinchGesture();
  h.read({ kind: 'wheel', atMs: 0, delta: -10, ctrlKey: true });
  assert(h.read({ kind: 'wheel', atMs: 10, delta: -10, ctrlKey: true }).kind === 'zoom', 'same road, allowed');
  const contested = h.read({ kind: 'gesturechange', atMs: 20, scale: 1.5 });
  assert(contested.kind === 'none', 'the other road is refused while the first is still live');
  // And after a real gap, the next gesture is a new one.
  h.read({ kind: 'gesturestart', atMs: 10 + PINCH_IDLE_MS + 1, scale: 1 });
  assert(h.road === 'gesture', 'after the idle gap the road is free for whoever speaks next');
}

// ---------------------------------------------------------------------------
// 6 — SHEET AND ROLL PARITY, through the fixture
// ---------------------------------------------------------------------------
{
  // The sheet swallows the pitch axis and the roll applies it; everything else must be
  // IDENTICAL, because the two panes are coupled and a pinch that is worth more over one of them
  // pulls the pair apart in the hand. Same stream, same machine, same numbers — the surfaces
  // differ only in what they do with `axis`, which is why that decision lives here.
  const trace = load('roll-webkit-both-roads.json');
  const a = replay(trace.events);
  const b = replay(trace.events);
  assert(a.length === b.length, 'the law is deterministic');
  for (let i = 0; i < a.length; i++) {
    near(a[i].factor, b[i].factor, 'and every factor is reproducible', 0);
  }
  const timeOnly = a.filter((z) => z.axis === 'time');
  assert(
    timeOnly.length === a.length,
    'a plain pinch is the time axis on every surface, so the sheet and the roll move together'
  );
}

console.log(`gesture-test: passed (${checks} checks)`);
