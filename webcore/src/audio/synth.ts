/**
 * The MIDI side of the fader: the thing that plays the notes the app heard.
 *
 * Deliberately not alphaTab's synthesizer. alphaTab is running in
 * PlayerMode.EnabledExternalMedia — our clock is the master, and in that mode alphaTab
 * does not synthesize at all, it only follows. So the "MIDI" half of the crossfade is
 * ours, which also means it works identically in a browser and in a JUCE WebView with no
 * soundfont loading and no AudioWorklet bring-up.
 *
 * This class is now a router as well as a synth. Recorded instruments are the only voices
 * exposed in the product UI. Legacy sources remain readable for old fixtures and sessions:
 *
 *   sampled voices recorded multisamples          -> ./sampler.ts   (six instruments)
 *   'pad'          compatibility-only pad          -> ./pad.ts
 *   basic voices   compatibility-only oscillators  -> below
 *
 * Everything above still calls `setVoice()` and nothing else, so the transport does not
 * know or care which source is playing.
 *
 * **Only one sampled instrument is ever in memory.** They are loaded the first time they
 * are chosen and dropped when the choice moves on — six sets decoded at once would be tens
 * of megabytes of float buffers next to a transcription model, on machines where RAM is
 * already the complaint (design notes §6.1 item 9). Coming back to an instrument costs one
 * more load from the bundle, which is local and quick.
 *
 * Scheduling strategy: on play, schedule every remaining note at once. Riffs are short
 * (a few hundred notes), so a look-ahead scheduler would be complexity for nothing. The
 * cost of that choice is that a source swap mid-playback has to re-schedule from the
 * current position — `restart()` does exactly that, which is what makes switching sounds
 * (or samples finishing their load) seamless instead of silent until the next play.
 */

import { SampledInstrument, isSampledVoice, type SampledVoice } from './sampler';
import { schedulePad } from './pad';

const MAX_SCHEDULED_NOTES = 4000;

/** Transparent below -1.4 dBFS; smoothly bounds anything the limiter did not catch. */
function safetyCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(65537);
  const threshold = 0.85;
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    if (x > threshold) curve[i] = threshold + (1 - threshold) * Math.tanh((x - threshold) / (1 - threshold));
    else if (x < -threshold) curve[i] = -threshold + (1 - threshold) * Math.tanh((x + threshold) / (1 - threshold));
    else curve[i] = x;
  }
  return curve;
}

export interface SynthNote {
  startSec: number;
  endSec: number;
  midi: number;
  velocity?: number;
}

/**
 * What the user picked in the sound picker.
 *
 * The sound *source* travels inside this one value rather than as a second setting, so the
 * transport's `setVoice()` carries it with no new plumbing, and one remembered string is
 * the whole of the persisted preference.
 *
 * Written out longhand as well as by reference, because this union is the contract
 * `app/state.ts` persists and the settings panel offers:
 *
 *   'finger-bass' | 'upright-piano' | 'electric-piano' | 'steel-guitar' |
 *   'electric-guitar' | 'marimba' | 'pad' | 'bass' | 'guitar' | 'piano' | 'sine'
 */
export type SynthVoice = SampledVoice | 'pad' | BasicVoice;

/** Compatibility oscillator voices. They are deliberately absent from the user-facing picker. */
export const BASIC_VOICES = ['bass', 'guitar', 'piano', 'sine'] as const;
export type BasicVoice = (typeof BASIC_VOICES)[number];

export function isBasicVoice(voice: SynthVoice): voice is BasicVoice {
  return (BASIC_VOICES as readonly string[]).includes(voice);
}

export class ScoreSynth {
  private ctx: AudioContext;
  private master: GainNode;
  private limiter: DynamicsCompressorNode;
  private safetyClipper: WaveShaperNode;
  private active: AudioScheduledSourceNode[] = [];
  private notes: SynthNote[] = [];
  private voice: SynthVoice = 'finger-bass';
  /** Destination gain requested by the Original/MIDI fader. */
  private targetGain = 0;

  /** The one sampled instrument currently in memory, if the chosen voice is a sampled one. */
  private sampler: SampledInstrument | null = null;
  /** Where the current playback started, so a mid-flight swap can pick up the position. */
  private playing = false;
  private playFrom = 0;
  private playOrigin = 0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    // Recorded voices overlap even in a monophonic line because their release tails ring.
    // A false OCR chord makes the sum larger still. Keep those peaks out of hard clipping;
    // this is deliberately a safety limiter, not an audible bus-compressor effect.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.06;
    this.safetyClipper = ctx.createWaveShaper();
    this.safetyClipper.curve = safetyCurve();
    this.safetyClipper.oversample = '2x';
    this.master.connect(this.limiter);
    this.limiter.connect(this.safetyClipper);
    this.safetyClipper.connect(ctx.destination);
  }

  setNotes(notes: SynthNote[]): void {
    this.notes = notes;
  }

  setVoice(voice: SynthVoice): void {
    if (this.voice === voice) {
      // Still worth a load: the first setVoice() arrives before anything is playing.
      this.ensureSamples();
      return;
    }
    this.voice = voice;
    this.ensureSamples();
    // A sampled voice restarts when its COMPLETE set lands. Restarting immediately would
    // play an oscillator (or whichever one sample decoded first) and switch timbre mid-note.
    if (!isSampledVoice(voice) || this.sampler?.ready) this.restart();
  }

  /**
   * Make sure the chosen instrument — and only the chosen instrument — is in memory, and
   * re-schedule when it lands.
   *
   * Loading is asynchronous but `start()` is not, so the first play after picking a
   * recorded instrument may begin on the oscillator fallback. Re-scheduling on arrival
   * means the user hears the real instrument a beat later instead of having to press stop
   * and play.
   */
  private ensureSamples(): void {
    const wanted = isSampledVoice(this.voice) ? this.voice : null;
    if (this.sampler && this.sampler.id !== wanted) {
      // Notes already sounding hold their own buffer alive, so this never cuts anything off.
      this.sampler.release();
      this.sampler = null;
    }
    if (!wanted) return;

    this.sampler ??= new SampledInstrument(this.ctx, wanted);
    if (this.sampler.ready) return;
    const sampler = this.sampler;
    void sampler.load().then((ok) => {
      if (ok && this.voice === wanted && this.sampler === sampler) this.restart();
    });
  }

  /** Used by Transport before it starts the clock, so first play starts with the real set. */
  async ready(): Promise<void> {
    if (!isSampledVoice(this.voice)) return;
    this.ensureSamples();
    const sampler = this.sampler;
    if (sampler && sampler.id === this.voice) await sampler.load();
  }

  /** Re-schedule the rest of the performance from wherever the playhead is now. */
  private restart(): void {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    this.start(this.playFrom + (now - this.playOrigin), now);
  }

  /**
   * Gain, ramped rather than assigned.
   *
   * A raw `gain.value = x` on every input event of a dragged fader is one step change per
   * pixel — that is zipper noise. setTargetAtTime smooths it for free.
   */
  setGain(gain: number): void {
    this.targetGain = Math.max(0, Math.min(1, gain));
    this.master.gain.setTargetAtTime(this.targetGain, this.ctx.currentTime, 0.01);
  }

  get gain(): number {
    return this.master.gain.value;
  }

  /** Schedule everything from `fromSec` onward. `ctxOrigin` is the AudioContext time that maps to fromSec. */
  start(fromSec: number, ctxOrigin: number): void {
    this.stop();
    // Remembered so a sound change (or the sampler finishing its load) can re-schedule
    // from the right place without asking the transport where the playhead is.
    this.playing = true;
    this.playFrom = fromSec;
    this.playOrigin = ctxOrigin;
    let count = 0;
    for (const note of this.notes) {
      if (note.endSec <= fromSec) continue;
      if (++count > MAX_SCHEDULED_NOTES) break;
      const when = ctxOrigin + Math.max(0, note.startSec - fromSec);
      const duration = Math.max(0.06, note.endSec - Math.max(note.startSec, fromSec));
      this.scheduleNote(note.midi, when, duration, (note.velocity ?? 96) / 127);
    }
    // THE METRONOME IS GONE, and this loop is where it was. It scheduled a square-wave click on
    // every entry of a `beatTimes` array, straight to `ctx.destination`, past the crossfade
    // master. Nothing above it changed when it went: the note loop is untouched, and there is a
    // schedule dump either side of the removal proving the note events are identical.
    //
    // Why remove the feature and not merely the switch: a click track is what a DAW is for, and
    // this one could only ever tick the beats Riffsheet had guessed at — so it agreed with the
    // player's session exactly when they did not need it and disagreed when they did.
  }

  stop(): void {
    this.playing = false;
    const old = this.active;
    this.active = [];

    // Stopping a BufferSource/Oscillator at an arbitrary sample creates a step and an audible
    // click. Fade the shared voice bus for 8 ms, stop the old sources at silence, then restore
    // the requested fader gain. start() can immediately schedule the replacement performance;
    // it simply receives the same short click-free fade-in.
    const now = this.ctx.currentTime;
    const silentAt = now + 0.008;
    const restoredAt = silentAt + 0.008;
    const gain = this.master.gain;
    try {
      gain.cancelAndHoldAtTime(now);
    } catch {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
    }
    gain.linearRampToValueAtTime(0, silentAt);
    gain.setValueAtTime(0, silentAt);
    gain.linearRampToValueAtTime(this.targetGain, restoredAt);

    for (const node of old) {
      try {
        node.stop(silentAt);
      } catch {
        /* already stopped */
      }
    }
  }

  /**
   * One note, on whichever source is selected.
   *
   * Recorded instruments never change into an oscillator mid-note. Transport waits for their
   * complete sample set; if a build is missing that set, the UI reports it and playback stays
   * silent rather than substituting the harsh synthetic sound the user explicitly removed.
   */
  private scheduleNote(midi: number, when: number, duration: number, velocity: number): void {
    if (isSampledVoice(this.voice)) {
      if (this.sampler?.ready && this.sampler.id === this.voice) {
        const nodes = this.sampler.schedule(this.master, midi, when, duration, velocity);
        if (nodes.length > 0) this.active.push(...nodes);
      }
      return;
    }
    if (this.voice === 'pad') {
      this.active.push(...schedulePad(this.ctx, this.master, midi, when, duration, velocity));
      return;
    }
    this.scheduleOscillatorNote(midi, when, duration, velocity);
  }

  private scheduleOscillatorNote(midi: number, when: number, duration: number, velocity: number): void {
    const ctx = this.ctx;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);

    const amp = ctx.createGain();
    amp.connect(this.master);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.connect(amp);

    const osc = ctx.createOscillator();
    osc.frequency.value = freq;

    const timbre: BasicVoice = isBasicVoice(this.voice) ? this.voice : 'bass';

    switch (timbre) {
      case 'bass':
        osc.type = 'sawtooth';
        filter.frequency.setValueAtTime(Math.max(200, freq * 6), when);
        filter.frequency.exponentialRampToValueAtTime(Math.max(120, freq * 2), when + 0.25);
        filter.Q.value = 3;
        break;
      case 'guitar':
        osc.type = 'sawtooth';
        filter.frequency.setValueAtTime(Math.max(400, freq * 9), when);
        filter.frequency.exponentialRampToValueAtTime(Math.max(200, freq * 3), when + 0.3);
        filter.Q.value = 1.5;
        break;
      case 'piano':
        osc.type = 'triangle';
        filter.frequency.value = Math.max(800, freq * 8);
        break;
      case 'sine':
      default:
        osc.type = 'sine';
        filter.frequency.value = 20000;
        break;
    }

    const peak = 0.28 * velocity;
    amp.gain.setValueAtTime(0, when);
    amp.gain.linearRampToValueAtTime(peak, when + 0.006);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.55), when + 0.09);
    const release = Math.min(0.18, duration * 0.4);
    amp.gain.setTargetAtTime(0.0001, when + duration - release, release / 3);

    osc.connect(filter);
    osc.start(when);
    osc.stop(when + duration + 0.25);
    osc.onended = () => {
      osc.disconnect();
      filter.disconnect();
      amp.disconnect();
    };
    this.active.push(osc);

    // A short sub sine under the bass makes it read as a bass rather than a buzz.
    if (timbre === 'bass') {
      const sub = ctx.createOscillator();
      const subAmp = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.value = freq;
      subAmp.gain.setValueAtTime(0, when);
      subAmp.gain.linearRampToValueAtTime(peak * 0.7, when + 0.008);
      subAmp.gain.setTargetAtTime(0.0001, when + duration - release, release / 3);
      sub.connect(subAmp);
      subAmp.connect(this.master);
      sub.start(when);
      sub.stop(when + duration + 0.25);
      sub.onended = () => {
        sub.disconnect();
        subAmp.disconnect();
      };
      this.active.push(sub);
    }
  }

}
