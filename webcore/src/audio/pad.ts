/**
 * "Soft synth (sustain)" — the deliberately-not-a-bass voice.
 *
 * This one is a UX device before it is an instrument. The fader crossfades your recording
 * against what the app heard, and the most useful place to sit is the middle, with both
 * playing. Two bass sounds at once turn into one muddy bass, and a wrong note hides inside
 * it. A warm pad an octave-inclusive fifth away in timbre stays audible against a bass
 * guitar at equal level, so a note the app got wrong sticks out immediately.
 *
 * The other half is sustain. The oscillator "bass" voice plucks and decays, so a long note
 * is silent for most of its length and you cannot hear whether the app thinks the note is
 * still held. Here the gate is real: full level from the attack until the note ends.
 *
 * Timbre: three slightly detuned triangles for warmth and movement, a sine an octave up
 * that carries the pitch through a bass-heavy mix, a quiet twelfth for body, all under a
 * gentle lowpass so it never reads as bright or plucked.
 */

const ATTACK_SEC = 0.045;
const RELEASE_SEC = 0.28;
const MIN_GATE_SEC = 0.1;
/** Pads stack, so a single voice has to sit well below the plucked voices' level. */
const PEAK = 0.16;

interface Partial {
  /** Multiple of the fundamental. */
  ratio: number;
  type: OscillatorType;
  gain: number;
  /** Detune in cents — what makes three identical triangles sound like one warm one. */
  detune: number;
}

const PARTIALS: Partial[] = [
  { ratio: 1, type: 'triangle', gain: 0.55, detune: -7 },
  { ratio: 1, type: 'triangle', gain: 0.55, detune: 7 },
  { ratio: 2, type: 'sine', gain: 0.5, detune: 0 },
  { ratio: 3, type: 'sine', gain: 0.14, detune: 4 }
];

export function schedulePad(
  ctx: AudioContext,
  destination: AudioNode,
  midi: number,
  when: number,
  duration: number,
  velocity: number
): AudioScheduledSourceNode[] {
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const gateEnd = when + Math.max(MIN_GATE_SEC, duration);
  const stopAt = gateEnd + RELEASE_SEC + 0.1;

  const amp = ctx.createGain();
  const peak = PEAK * velocity;
  amp.gain.setValueAtTime(0, when);
  amp.gain.linearRampToValueAtTime(peak, when + ATTACK_SEC);
  // The whole point: hold, do not decay, while the note is meant to be sounding.
  amp.gain.setValueAtTime(peak, gateEnd);
  amp.gain.setTargetAtTime(0.0001, gateEnd, RELEASE_SEC / 3);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = Math.min(4200, Math.max(900, freq * 12));
  filter.Q.value = 0.6;
  filter.connect(amp);
  amp.connect(destination);

  const sources: AudioScheduledSourceNode[] = [];
  let live = PARTIALS.length;

  for (const partial of PARTIALS) {
    const osc = ctx.createOscillator();
    osc.type = partial.type;
    osc.frequency.value = freq * partial.ratio;
    osc.detune.value = partial.detune;

    const mix = ctx.createGain();
    mix.gain.value = partial.gain;

    osc.connect(mix);
    mix.connect(filter);
    osc.start(when);
    osc.stop(stopAt);
    osc.onended = () => {
      osc.disconnect();
      mix.disconnect();
      // Tear the shared nodes down once, after the last partial has finished.
      if (--live === 0) {
        filter.disconnect();
        amp.disconnect();
      }
    };
    sources.push(osc);
  }

  return sources;
}
