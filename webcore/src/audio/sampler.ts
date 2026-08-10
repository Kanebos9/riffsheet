/**
 * The recorded instruments — the "real sound" half of the sound picker.
 *
 * The oscillator synth next door is fine for checking rhythm, but it does not sound like an
 * instrument, and the player's complaint was exactly that: at mid-fader you are comparing
 * your own playing against a buzz. These are real recorded notes, so the comparison is
 * musical.
 *
 * It started as one bass (`SampledBass`) because the app was bass-only. It transcribes
 * anything now, so this is a general sampler with a small registry of sets, and
 * `SampledBass` survives as the finger-bass entry under its old name because `ui/app.ts`
 * and the verify harness both import it.
 *
 * The sets are converted from the author's own multisample library, assembled for their
 * earlier BASAMAK project and read here read-only. Each keeps one velocity layer as portable
 * PCM WAV. Native 22.05 kHz mono sets stay at that rate; the upright, marimba and steel
 * guitar retain their native 44.1 kHz, with the piano/marimba stereo image preserved and only
 * long inaudible tails capped. Every licence travels with its folder as `LICENSE.txt`; all
 * six are MIT or CC0 — see `webcore/CREDITS.md` for where each set came from.
 *
 * They are copied into the bundle rather than read from disk at runtime for three reasons:
 * the plugin has to work with no filesystem access and no network, the bridge has no
 * file-read call (see shell/BRIDGE.md), and WAV decoding is dependable across all three
 * JUCE WebViews (unlike relying on a host's optional FLAC/GStreamer codec).
 *
 * Design notes:
 *  - **Nearest sample, then repitch.** No set is denser than a major third, so a note is
 *    stretched at most ~3.5 semitones inside the recorded range. Outside it the nearest
 *    edge sample is ridden up or down, which is what a sampler with no further zones can do.
 *  - **Gate = note duration.** The recording keeps its own natural decay while the gate is
 *    open and is closed with a short release.
 *  - **One instrument in memory at a time.** Loading all six at boot would be ~5.7 MB of
 *    compressed audio decoding into roughly 25 MB of float buffers on a machine that is
 *    already running a transcription model. `ScoreSynth` drops the previous instrument when
 *    the choice changes; within one instrument the decoded buffers are cached, because a
 *    riff can trigger the same note hundreds of times.
 */

/** The voices that come from recordings. Every one of these has a folder under `public/samples/`. */
export const SAMPLED_VOICES = [
  'finger-bass',
  'upright-piano',
  'electric-piano',
  'steel-guitar',
  'electric-guitar',
  'marimba'
] as const;

export type SampledVoice = (typeof SAMPLED_VOICES)[number];

export function isSampledVoice(voice: string): voice is SampledVoice {
  return (SAMPLED_VOICES as readonly string[]).includes(voice);
}

/** One recorded note. */
export interface SampleRef {
  midi: number;
  file: string;
}

export interface InstrumentDefinition {
  id: SampledVoice;
  /** What the picker shows. Sentence case, no jargon. */
  label: string;
  /** Folder under `public/samples/`. */
  directory: string;
  /** Where the recordings came from, for the credit line under the picker. */
  source: string;
  samples: ReadonlyArray<SampleRef>;
  /** Authored attack from the source instrument, in seconds. */
  attackSec: number;
  /** Time for the held envelope to settle toward `sustain`. */
  decaySec: number;
  /** Held level after the decay, 0..1. */
  sustain: number;
  /** Whether held notes need a stable sustain cycle after the recorded attack. */
  loop: boolean;
  /** Envelope release in seconds — how long the note takes to let go after the gate closes. */
  releaseSec: number;
  /**
   * Level trim, so the sets sit at roughly one loudness.
   *
   * Measured, not guessed: mean RMS over the first second of every note in the set, against
   * the finger bass at -11.6 dBFS. Full equalisation would want +4.6 dB on the piano, but
   * The lifts stop at 1.15; the shared limiter/soft ceiling handles release overlap and
   * real chords. Everything ends up within about 3 dB, and a polyphonic instrument being a
   * little quieter per note than a monophonic bass is right anyway — its notes stack.
   */
  gain: number;
  /**
   * Which oscillator timbre stands in when the recordings are missing from the build.
   * A missing sample set must cost you a nicer tone, never silence and never a surprise.
   */
  fallback: 'bass' | 'guitar' | 'piano' | 'sine';
}

/**
 * The finger bass, exported under its old name because `ui/app.ts` and `scripts/verify.mjs`
 * both import it and neither is ours to edit.
 *
 * File names carry `s` for sharp rather than `#`: a literal `#` in a URL is a fragment
 * separator, and relying on every host in the chain (Vite, the verify server, JUCE's
 * resource provider) to percent-decode it identically is a bug waiting to happen.
 */
export const FINGER_BASS_SAMPLES: ReadonlyArray<SampleRef> = [
  { midi: 28, file: 'E1.wav' },
  { midi: 30, file: 'Fs1.wav' },
  { midi: 32, file: 'Gs1.wav' },
  { midi: 34, file: 'As1.wav' },
  { midi: 36, file: 'C2.wav' },
  { midi: 39, file: 'Ds2.wav' },
  { midi: 41, file: 'F2.wav' },
  { midi: 43, file: 'G2.wav' },
  { midi: 48, file: 'C3.wav' }
];

/**
 * The registry, in the order the picker offers them: the bass the app started with, then
 * the two keyboards, then the two guitars, then the one that sounds like nothing you would
 * have recorded.
 *
 * That last one is not a joke. The fader crossfades your recording against what the app
 * heard, and the most useful place to sit is the middle with both playing. Two guitars at
 * once turn into one blurred guitar and a wrong note hides inside it; a marimba against a
 * guitar stays separate, and its hard attack makes a note the app placed slightly early or
 * late obvious rather than merely suspicious.
 */
export const SAMPLED_INSTRUMENTS: ReadonlyArray<InstrumentDefinition> = [
  {
    id: 'finger-bass',
    label: 'Finger bass',
    directory: 'finger-bass',
    source: 'FluidR3 GM by Frank Wen, MIT',
    attackSec: 0.001,
    decaySec: 2.5,
    sustain: 1,
    loop: true,
    releaseSec: 0.12,
    gain: 1,
    fallback: 'bass',
    samples: FINGER_BASS_SAMPLES
  },
  {
    id: 'upright-piano',
    label: 'Upright piano',
    directory: 'upright-piano',
    source: 'Versilian Community Sample Library, CC0',
    attackSec: 0.001,
    decaySec: 1.5,
    sustain: 0.2,
    loop: false,
    // The source instrument's authored damper tail.
    releaseSec: 0.3,
    gain: 1.15,
    fallback: 'piano',
    samples: [
      { midi: 24, file: 'C1.wav' },
      { midi: 31, file: 'G1.wav' },
      { midi: 36, file: 'C2.wav' },
      { midi: 43, file: 'G2.wav' },
      { midi: 48, file: 'C3.wav' },
      { midi: 55, file: 'G3.wav' },
      { midi: 60, file: 'C4.wav' },
      { midi: 67, file: 'G4.wav' },
      { midi: 72, file: 'C5.wav' },
      { midi: 79, file: 'G5.wav' },
      { midi: 84, file: 'C6.wav' },
      { midi: 91, file: 'G6.wav' },
      { midi: 96, file: 'C7.wav' }
    ]
  },
  {
    id: 'electric-piano',
    label: 'Electric piano',
    directory: 'electric-piano',
    source: 'FluidR3 GM by Frank Wen, MIT',
    attackSec: 0.001,
    decaySec: 2,
    sustain: 1,
    loop: true,
    releaseSec: 0.15,
    gain: 0.75,
    fallback: 'piano',
    samples: [
      { midi: 24, file: 'C1.wav' },
      { midi: 31, file: 'G1.wav' },
      { midi: 36, file: 'C2.wav' },
      { midi: 40, file: 'E2.wav' },
      { midi: 48, file: 'C3.wav' },
      { midi: 55, file: 'G3.wav' },
      { midi: 60, file: 'C4.wav' },
      { midi: 67, file: 'G4.wav' },
      { midi: 72, file: 'C5.wav' },
      { midi: 79, file: 'G5.wav' },
      { midi: 84, file: 'C6.wav' },
      { midi: 91, file: 'G6.wav' },
      { midi: 96, file: 'C7.wav' }
    ]
  },
  {
    id: 'steel-guitar',
    label: 'Acoustic guitar',
    directory: 'steel-guitar',
    source: 'FluidR3 GM by Frank Wen, MIT',
    attackSec: 0.001,
    decaySec: 3,
    sustain: 0,
    loop: false,
    releaseSec: 0.12,
    gain: 1.15,
    fallback: 'guitar',
    samples: [
      { midi: 40, file: 'E2.wav' },
      { midi: 45, file: 'A2.wav' },
      { midi: 50, file: 'D3.wav' },
      { midi: 55, file: 'G3.wav' },
      { midi: 59, file: 'B3.wav' },
      { midi: 64, file: 'E4.wav' },
      { midi: 69, file: 'A4.wav' },
      { midi: 71, file: 'B4.wav' },
      { midi: 76, file: 'E5.wav' },
      { midi: 84, file: 'C6.wav' }
    ]
  },
  {
    id: 'electric-guitar',
    label: 'Electric guitar',
    directory: 'electric-guitar',
    source: 'FluidR3 GM by Frank Wen, MIT',
    attackSec: 0.001,
    decaySec: 2.8,
    sustain: 1,
    loop: true,
    releaseSec: 0.12,
    gain: 1.15,
    fallback: 'guitar',
    samples: [
      { midi: 40, file: 'E2.wav' },
      { midi: 45, file: 'A2.wav' },
      { midi: 50, file: 'D3.wav' },
      { midi: 55, file: 'G3.wav' },
      { midi: 59, file: 'B3.wav' },
      { midi: 64, file: 'E4.wav' },
      { midi: 69, file: 'A4.wav' },
      { midi: 71, file: 'B4.wav' },
      { midi: 76, file: 'E5.wav' },
      { midi: 79, file: 'G5.wav' }
    ]
  },
  {
    id: 'marimba',
    label: 'Marimba',
    directory: 'marimba',
    source: 'Versilian Community Sample Library, CC0',
    attackSec: 0.001,
    // This set has no authored sidecar; let the recording carry its natural decay.
    decaySec: 1,
    sustain: 1,
    loop: false,
    // A struck wooden bar has no sustain to let go of.
    releaseSec: 0.08,
    gain: 1.15,
    fallback: 'piano',
    samples: [
      { midi: 41, file: 'F2.wav' },
      { midi: 48, file: 'C3.wav' },
      { midi: 55, file: 'G3.wav' },
      { midi: 59, file: 'B3.wav' },
      { midi: 65, file: 'F4.wav' },
      { midi: 72, file: 'C5.wav' },
      { midi: 79, file: 'G5.wav' },
      { midi: 83, file: 'B5.wav' },
      { midi: 89, file: 'F6.wav' },
      { midi: 96, file: 'C7.wav' }
    ]
  }
];

/** Lookup by voice. Never throws: an unknown id falls back to the bass. */
export function instrumentFor(voice: string): InstrumentDefinition {
  return SAMPLED_INSTRUMENTS.find((i) => i.id === voice) ?? SAMPLED_INSTRUMENTS[0];
}

/** Never let a gate be so short the attack transient is cut in half. */
const MIN_GATE_SEC = 0.08;
/** Basamak considers its exponential release inaudible after this many authored releases. */
const RELEASE_TAIL_MULTIPLIER = 3.2;

export type SampleState = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface SampleStatus {
  state: SampleState;
  /** Plain-language detail for the settings panel. */
  message?: string;
  loaded?: number;
  total?: number;
  /**
   * Which instrument this is about. Undefined only in the initial 'idle' status.
   * Added when the sampler stopped being bass-only; nothing that reads the older fields
   * had to change.
   */
  voice?: SampledVoice;
}

interface LoadedSample {
  buffer: AudioBuffer;
  /** Peak-normalisation, capped at +18 dB like the source sampler. */
  gain: number;
  loopStartSec?: number;
  loopEndSec?: number;
}

let status: SampleStatus = { state: 'idle' };
const statusListeners = new Set<(s: SampleStatus) => void>();

export function sampleStatus(): SampleStatus {
  return status;
}

export function onSampleStatus(listener: (s: SampleStatus) => void): () => void {
  statusListeners.add(listener);
  listener(status);
  return () => statusListeners.delete(listener);
}

function setStatus(next: SampleStatus): void {
  status = next;
  for (const l of [...statusListeners]) l(next);
}

/** "Acoustic guitar" -> "acoustic guitar", so it reads inside a sentence. */
function lower(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * One recorded instrument: fetch, decode, cache, and schedule notes from it.
 *
 * Loading is lazy and single-flight. Nothing here throws at the caller — a set that will
 * not load reports itself through `sampleStatus()` and schedules nothing, and the synth
 * plays its oscillator fallback instead.
 */
export class SampledInstrument {
  readonly definition: InstrumentDefinition;
  private ctx: AudioContext;
  private buffers = new Map<number, LoadedSample>();
  private loading: Promise<boolean> | null = null;
  private complete = false;
  /** Invalidates asynchronous fetch/decode work after this instrument is released. */
  private generation = 0;
  private released = false;
  private baseUrl: string;

  constructor(ctx: AudioContext, voice: SampledVoice | InstrumentDefinition = 'finger-bass', baseUrl?: string) {
    this.definition = typeof voice === 'string' ? instrumentFor(voice) : voice;
    this.ctx = ctx;
    // Resolved here rather than at module load: the document's base can differ between the
    // dev server, the verify harness and JUCE's resource provider.
    this.baseUrl =
      baseUrl ?? new URL(`samples/${this.definition.directory}/`, document.baseURI).href;
  }

  get id(): SampledVoice {
    return this.definition.id;
  }

  /** True once at least one sample decoded — a partial set still plays, just less well. */
  get ready(): boolean {
    return this.complete && this.buffers.size > 0;
  }

  /**
   * Fetch and decode the set. Single-flight: repeated calls share one load, and a set that
   * came back empty is not retried on every note.
   */
  load(): Promise<boolean> {
    if (this.released) return Promise.resolve(false);
    if (this.loading) return this.loading;
    if (this.ready) return Promise.resolve(true);

    const def = this.definition;
    const generation = this.generation;
    setStatus({
      state: 'loading',
      message: `Loading the ${lower(def.label)} samples…`,
      loaded: 0,
      total: def.samples.length,
      voice: def.id
    });

    this.loading = (async () => {
      const results = await Promise.all(
        def.samples.map(async (sample) => {
          try {
            const response = await fetch(new URL(sample.file, this.baseUrl).href);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
            if (this.released || generation !== this.generation) return false;
            const loop = def.loop ? findSustainLoop(buffer, sample.midi) : null;
            this.buffers.set(sample.midi, {
              buffer,
              gain: normalizationGain(buffer),
              ...(loop ? { loopStartSec: loop.startSec, loopEndSec: loop.endSec } : {})
            });
            return true;
          } catch {
            return false;
          }
        })
      );

      // A sound change may have released this set while WebKit was decoding it. Do not let
      // the abandoned load repopulate buffers or overwrite the status for the new sound.
      if (this.released || generation !== this.generation) return false;

      const loaded = results.filter(Boolean).length;
      if (loaded === 0) {
        this.complete = false;
        setStatus({
          state: 'unavailable',
          message: `The ${lower(def.label)} recordings are missing from this build — using the basic synth.`,
          loaded: 0,
          total: results.length,
          voice: def.id
        });
        // Allow a later retry: an empty set is a failure, not a decided answer.
        this.loading = null;
        return false;
      }
      this.complete = true;
      setStatus({
        state: 'ready',
        message:
          loaded === results.length
            ? `Recorded ${lower(def.label)}, ready.`
            : `Recorded ${lower(def.label)} — ${loaded} of ${results.length} notes loaded.`,
        loaded,
        total: results.length,
        voice: def.id
      });
      return true;
    })();

    return this.loading;
  }

  /**
   * Let go of the decoded audio.
   *
   * Called when the player picks a different instrument. Notes already sounding keep their
   * buffer alive through their own source node, so this never cuts anything off — it only
   * stops us holding megabytes for a sound nobody is listening to any more.
   */
  release(): void {
    this.released = true;
    this.generation++;
    this.buffers.clear();
    this.loading = null;
    this.complete = false;
  }

  /**
   * Schedule one note. Returns the source nodes so the caller can keep them alive and stop
   * them on a transport stop; empty when nothing is loaded yet.
   */
  schedule(
    destination: AudioNode,
    midi: number,
    when: number,
    duration: number,
    velocity: number
  ): AudioScheduledSourceNode[] {
    const nearest = this.nearest(midi);
    if (!nearest) return [];

    const { attackSec: attack, decaySec: decay, sustain, releaseSec: release } = this.definition;
    const source = this.ctx.createBufferSource();
    source.buffer = nearest.sample.buffer;
    source.playbackRate.value = Math.pow(2, (midi - nearest.midi) / 12);
    if (nearest.sample.loopStartSec !== undefined && nearest.sample.loopEndSec !== undefined) {
      source.loop = true;
      source.loopStart = nearest.sample.loopStartSec;
      source.loopEnd = nearest.sample.loopEndSec;
    }

    const amp = this.ctx.createGain();
    const peak = 0.9 * this.definition.gain * velocity * nearest.sample.gain;
    const gateEnd = when + Math.max(MIN_GATE_SEC, duration);
    const attackEnd = when + attack;

    amp.gain.setValueAtTime(0, when);
    amp.gain.linearRampToValueAtTime(peak, attackEnd);
    if (sustain < 1) amp.gain.setTargetAtTime(peak * sustain, attackEnd, decay / 3);

    // Match the authored held level at key-up, then give the exponential release enough
    // time to become genuinely silent. The old source stop happened while the gain was
    // still audible, which put a discontinuity (a click) at the end of every note.
    const decayAge = Math.max(0, gateEnd - attackEnd);
    const held = peak * (sustain + (1 - sustain) * Math.exp((-3 * decayAge) / decay));
    amp.gain.cancelScheduledValues(gateEnd);
    amp.gain.setValueAtTime(held, gateEnd);
    amp.gain.setTargetAtTime(0, gateEnd, release / 3);

    source.connect(amp);
    amp.connect(destination);
    source.start(when);
    source.stop(gateEnd + RELEASE_TAIL_MULTIPLIER * release + 0.01);
    source.onended = () => {
      source.disconnect();
      amp.disconnect();
    };
    return [source];
  }

  private nearest(midi: number): { midi: number; sample: LoadedSample } | null {
    let best: { midi: number; sample: LoadedSample } | null = null;
    let bestDistance = Infinity;
    for (const [sampleMidi, sample] of this.buffers) {
      const distance = Math.abs(sampleMidi - midi);
      if (distance < bestDistance || (distance === bestDistance && best && sampleMidi < best.midi)) {
        bestDistance = distance;
        best = { midi: sampleMidi, sample };
      }
    }
    return best;
  }
}

function normalizationGain(buffer: AudioBuffer): number {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  return Math.min(1 / Math.max(0.0001, peak), 7.94);
}

/**
 * Find a stable sustain cycle after the recorded attack.
 *
 * BufferSource has no loop crossfade, so the two ends must already agree. Start on an
 * upward zero crossing, then compare complete pitch-period multiples and choose the end
 * whose following waveform best matches the start. If no useful region exists, playback
 * safely falls back to the recording's natural tail.
 */
export function findSustainLoop(
  buffer: Pick<AudioBuffer, 'length' | 'sampleRate' | 'getChannelData'>,
  rootMidi: number
): { startSec: number; endSec: number } | null {
  const n = buffer.length;
  if (n < 4096) return null;
  const data = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const window = Math.min(1024, Math.floor(n / 8));

  let start = Math.min(n - window - 2, Math.floor(n * 0.4));
  const startLimit = Math.min(n - window - 2, start + Math.floor(n * 0.25));
  while (start < startLimit && !(data[start] <= 0 && data[start + 1] > 0)) start++;
  if (start >= startLimit) return null;

  const hz = 440 * Math.pow(2, (rootMidi - 69) / 12);
  const period = Math.max(16, Math.round(sampleRate / hz));
  const firstEnd = start + Math.max(period, Math.ceil((sampleRate * 0.05) / period) * period);
  const lastEnd = n - window - 1;
  if (firstEnd >= lastEnd) return null;

  let bestEnd = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  let compared = 0;
  for (let end = firstEnd; end <= lastEnd; end += period) {
    let score = 0;
    let points = 0;
    for (let i = 0; i < window; i += 4) {
      const delta = data[start + i] - data[end + i];
      score += delta * delta;
      points++;
    }
    if (score < bestScore) {
      bestScore = score;
      bestEnd = end;
      compared = points;
    }
  }

  if (bestEnd <= start + 64 || !Number.isFinite(bestScore)) return null;

  // AudioBufferSource loops have no crossfade. A merely "least bad" candidate can still
  // put a large step at the wrap point (several real guitar/piano samples did), producing
  // a click on every cycle. Reject uncertain loops and let the natural recording play out.
  let startEnergy = 0;
  for (let i = 0; i < window; i += 4) startEnergy += data[start + i] * data[start + i];
  const seamRms = Math.sqrt(bestScore / Math.max(1, compared));
  const startRms = Math.sqrt(startEnergy / Math.max(1, compared));
  const endpointJump = Math.abs(data[start] - data[bestEnd]);
  // Keep the absolute step below -40 dBFS even for a loud source. Scaling this allowance
  // with the note level admitted a -34 dBFS click in a real electric-piano zone.
  if (endpointJump > 0.01) return null;
  if (seamRms > Math.max(0.02, startRms * 0.15)) return null;

  return { startSec: start / sampleRate, endSec: bestEnd / sampleRate };
}

/**
 * The finger bass, still under the name it had when it was the only sampled instrument.
 *
 * `ui/app.ts` and the verify harness both do `new SampledBass(ctx)` and
 * `new SampledBass(ctx, someUrl)` — the second form is how the harness proves that a
 * missing sample set degrades quietly instead of throwing. Neither file is ours to edit, so
 * this signature is fixed.
 */
export class SampledBass extends SampledInstrument {
  constructor(ctx: AudioContext, baseUrl?: string) {
    super(ctx, 'finger-bass', baseUrl);
  }
}
