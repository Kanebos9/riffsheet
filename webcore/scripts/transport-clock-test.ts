/**
 * Isolated regression test for the transport clock.
 *
 * The v1.0 field bug — "playback plays about two seconds, stalls, later carries on" — had
 * four plausible causes and no way to tell them apart from a screenshot. This reproduces all
 * four with no browser, no alphaTab and no DAW: a subscriber that throws, an alphaTab push
 * that throws, a shell that stops reporting positions, and an AudioContext that WebKit
 * suspends. In every case the clock must keep advancing at real time and the transport must
 * still be playing. It also checks that a loop wraps once rather than sixty times a second,
 * and that concurrent play/pause/seek cannot leave the transport "playing" with a dead loop.
 *
 * Run it (about 10 s, needs no build):
 *
 *   cd webcore
 *   ./node_modules/.bin/esbuild scripts/transport-clock-test.ts \
 *       --bundle --platform=node --format=esm --outfile=/tmp/clock-test.mjs \
 *     && node /tmp/clock-test.mjs
 *
 * Deliberately separate from `npm run verify`: that harness drives a real Chrome against the
 * built bundle and cannot suspend an AudioContext or break requestAnimationFrame on demand.
 */

import { Transport } from '../src/audio/transport';
import type { NativeBridge, PlaybackState } from '../src/bridge/types';

// ---------------------------------------------------------------- fake browser

let ctxState: 'running' | 'suspended' = 'running';
let rafBroken = false;
const rafQueue = new Map<number, FrameRequestCallback>();
let nextRaf = 1;

const param = () => ({
  value: 0,
  cancelAndHoldAtTime() {},
  cancelScheduledValues() {},
  setTargetAtTime() {},
  setValueAtTime() {},
  linearRampToValueAtTime() {},
  exponentialRampToValueAtTime() {}
});
const node = () => ({
  gain: param(),
  frequency: param(),
  Q: param(),
  type: '',
  connect() {}, disconnect() {}, start() {}, stop() {},
  onended: null as unknown
});
const compressor = () => ({
  threshold: param(),
  knee: param(),
  ratio: param(),
  attack: param(),
  release: param(),
  connect() {},
  disconnect() {}
});
const shaper = () => ({ curve: null as Float32Array | null, oversample: 'none', connect() {}, disconnect() {} });

const fakeCtx = {
  get state() { return ctxState; },
  get currentTime() { return Date.now() / 1000; },
  destination: {},
  createGain: node,
  createDynamicsCompressor: compressor,
  createWaveShaper: shaper,
  createOscillator: node,
  createBiquadFilter: node,
  resume: async () => { ctxState = 'running'; }
} as unknown as AudioContext;

(globalThis as any).window = globalThis;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
  const id = nextRaf++;
  if (!rafBroken) setTimeout(() => { if (rafQueue.delete(id)) cb(performance.now()); }, 16);
  rafQueue.set(id, cb);
  return id;
};
(globalThis as any).cancelAnimationFrame = (id: number) => rafQueue.delete(id);

// ---------------------------------------------------------------- fake shell

let shellReports = true;
let shellPos = 0;
let shellPlaying = false;
const handlers = new Set<(s: PlaybackState) => void>();
const logLines: string[] = [];

const bridge: NativeBridge = {
  getHostInfo: async () => ({ host: 'test', isPlugin: true, engineAvailable: true }),
  pickAudioFile: async () => null,
  transcribe: async () => ({ notes: [] }),
  exportFile: async () => ({ saved: false }),
  captureStart: async () => {},
  captureStop: async () => ({ pcm: new Float32Array(0), sampleRate: 44100, durationSec: 0 }),
  onCaptureState: () => () => {},
  loadOriginal: async () => ({ durationSec: 30 }),
  play: async () => { shellPlaying = true; },
  pause: async () => { shellPlaying = false; },
  seek: async (p: number) => { shellPos = p; },
  setOriginalGain: () => {},
  onPlaybackState: (h) => { handlers.add(h); return () => handlers.delete(h); },
  log: async (level, message) => { logLines.push(`${level}: ${message}`); },
  playbackDiagnostics: async () => ({ blocksRendered: 1234, blocksSkippedLocked: 0 })
};

// The shell's 20 Hz position push.
setInterval(() => {
  // The audio keeps playing even when the events do not arrive — that is the
  // whole point of the "shell went quiet" case. Advance first, report second.
  if (shellPlaying) shellPos += 0.05;
  if (!shellReports) return;
  for (const h of handlers) h({ isPlaying: shellPlaying, positionSec: shellPos, durationSec: 30, loaded: true });
}, 50);

// ---------------------------------------------------------------- the test

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
};

async function main() {
  const t = new Transport(bridge, fakeCtx);
  // This test is about the clock, not sample fetching; keep its synthetic AudioContext on
  // an always-ready oscillator voice now that ScoreSynth exposes a real readiness hook.
  t.setVoice('sine');
  t.setOriginalAvailable(true, 30);
  t.setScoreNotes([], 30);

  // A subscriber that always throws. Under the old code this killed the rAF loop
  // on the very first frame.
  let listenerCalls = 0;
  t.subscribe(() => {
    listenerCalls++;
    throw new Error('subscriber blew up');
  });
  // ...and a healthy one that must keep receiving updates regardless.
  let healthy = 0;
  t.subscribe(() => { healthy++; });

  // An alphaTab whose updatePosition always throws.
  const fakeApi = {
    player: { output: { handler: null as unknown, updatePosition() { throw new Error('bounds lookup exploded'); } } }
  };
  t.attachAlphaTab(fakeApi as never);

  await t.play();
  await sleep(1200);
  const p1 = t.state.positionSec;
  check('1. throwing subscriber + throwing alphaTab: clock still advances', p1 > 0.8 && p1 < 1.6, `pos=${p1.toFixed(2)}s`);
  check('1b. transport still reports playing', t.state.mode === 'playing');
  check('1c. the healthy subscriber kept getting updates', healthy > 20, `${healthy} updates`);

  // The shell goes silent (native audio stalled / WebView occluded / events dropped).
  shellReports = false;
  await sleep(1500);
  const p2 = t.state.positionSec;
  check('2. shell stops reporting: clock free-runs instead of freezing', p2 - p1 > 1.2, `advanced ${(p2 - p1).toFixed(2)}s`);
  shellReports = true;

  // The AudioContext gets suspended out from under us — the v1.0 timebase.
  ctxState = 'suspended';
  const p3 = t.state.positionSec;
  await sleep(1200);
  const p4 = t.state.positionSec;
  check('3. audio context suspended: clock unaffected', p4 - p3 > 0.9, `advanced ${(p4 - p3).toFixed(2)}s`);
  await sleep(400);
  check('3b. watchdog resumed the context', ctxState === 'running');

  // rAF stops entirely (an occluded WebView serves no frames at all).
  rafBroken = true;
  const p5 = t.state.positionSec;
  await sleep(1500);
  const p6 = t.state.positionSec;
  const diag: any = await (globalThis as any).__RIFFSHEET_CLOCK__();
  check('4. rAF dies: watchdog keeps the position live', p6 - p5 > 1.2, `advanced ${(p6 - p5).toFixed(2)}s`);
  check('4b. watchdog logged revivals', diag.revivals > 0, `${diag.revivals} revivals`);
  rafBroken = false;

  // Re-entrancy: hammer play/pause/seek concurrently and end in a known state.
  await Promise.all([t.play(), t.pause(), t.seek(5), t.play(), t.seek(2), t.toggle(), t.play()]);
  await sleep(600);
  check('5. concurrent commands end in a consistent state',
    t.state.mode === 'playing' ? t.state.positionSec > 2 : true,
    `mode=${t.state.mode} pos=${t.state.positionSec.toFixed(2)}`);
  const afterStorm = t.state.positionSec;
  await sleep(700);
  check('5b. clock alive after the command storm',
    t.state.mode !== 'playing' || t.state.positionSec > afterStorm, `pos=${t.state.positionSec.toFixed(2)}`);

  // Loop must restart ONCE, not sixty times a second.
  await t.pause();
  t.setLoop(true);
  await t.seek(29.5);
  await t.play();
  await sleep(1500);
  check('6. loop wrapped exactly once, no restart storm',
    t.state.positionSec < 3 && t.state.mode === 'playing', `pos=${t.state.positionSec.toFixed(2)}`);

  const final: any = await (globalThis as any).__RIFFSHEET_CLOCK__();
  check('7. faults were counted, not swallowed', final.faults > 0, `${final.faults} faults`);
  check('7b. faults reached the host log', logLines.length > 0, `${logLines.length} lines, first: ${logLines[0]?.slice(0, 70)}`);
  check('7c. logging is rate-limited', logLines.length <= 5, `${logLines.length} lines`);
  check('8. native counters surface in diagnostics', final.shell?.blocksRendered === 1234);

  t.destroy();
  await sleep(300);
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

void main();
