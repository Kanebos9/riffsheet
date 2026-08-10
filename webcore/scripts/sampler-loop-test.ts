/** Fast, browser-free regression checks for the sampled-instrument sustain loop finder. */

import { findSustainLoop, instrumentFor } from '../src/audio/sampler';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`PASS  ${message}`);
}

const sampleRate = 44100;
const midi = 45; // A2 = 110 Hz, an exact 400.9-sample period at this rate.
const data = new Float32Array(sampleRate * 2);
const hz = 440 * Math.pow(2, (midi - 69) / 12);
for (let i = 0; i < data.length; i++) {
  // A quiet second partial makes the test less forgiving than a perfect single sine.
  data[i] = 0.8 * Math.sin((2 * Math.PI * hz * i) / sampleRate)
    + 0.12 * Math.sin((4 * Math.PI * hz * i) / sampleRate + 0.2);
}

const loop = findSustainLoop(
  { length: data.length, sampleRate, getChannelData: () => data },
  midi
);
check(loop !== null, 'a pitched two-second sample gets a sustain loop');
if (loop) {
  const a = Math.round(loop.startSec * sampleRate);
  const b = Math.round(loop.endSec * sampleRate);
  check(b - a >= sampleRate * 0.05, 'the loop is long enough to avoid a buzzy micro-cycle');
  check(Math.abs(data[a] - data[b]) < 0.02, 'the loop boundary is waveform-continuous');
}

check(
  findSustainLoop({ length: 1000, sampleRate, getChannelData: () => new Float32Array(1000) }, midi) === null,
  'a sample too short for a safe loop is left natural'
);

const changing = new Float32Array(sampleRate * 2);
for (let i = 0; i < changing.length; i++) {
  const phase = (2 * Math.PI * hz * i) / sampleRate;
  // The second half has a large DC/timbre change. There is still a least-bad candidate,
  // but looping it without a crossfade would click on every wrap.
  changing[i] = i < changing.length * 0.42 ? 0.7 * Math.sin(phase) : 0.35 + 0.2 * Math.sin(phase * 1.03);
}
check(
  findSustainLoop(
    { length: changing.length, sampleRate, getChannelData: () => changing },
    midi
  ) === null,
  'a poor loop seam is rejected instead of clicking'
);
check(instrumentFor('finger-bass').loop, 'finger bass keeps its authored sustain-loop setting');
check(instrumentFor('electric-piano').loop, 'electric piano keeps its authored sustain-loop setting');
check(instrumentFor('electric-guitar').loop, 'electric guitar keeps its authored sustain-loop setting');
check(!instrumentFor('steel-guitar').loop, 'steel guitar is not incorrectly looped');
