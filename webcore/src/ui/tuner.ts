/**
 * The tuner — a lie-detector for the transcriber, not a guitar tuner bolted on.
 *
 * WHY THIS EXISTS, because it decides every design question in the file. The transcriber
 * hears notes that were never played (95 reported where 73 were played) and goes silent on
 * notes that were. Everything downstream — the staff, the tab, the piano roll — repeats it
 * with total confidence. This panel is the one place in the app where the RECORDING gets to
 * answer back: you pick a stretch of audio, you hear it, and you are told what pitch is
 * actually in it, measured off the samples with no model involved.
 *
 * THE CASE THAT MATTERS MOST IS THE ONE WITH NO NOTE IN IT. In the user's own words: "below
 * it there may not be any recognized note, and in that case users cannot click anywhere."
 * A stretch the app heard nothing in is exactly the stretch you most need to interrogate, so
 * nothing here hangs off an existing note. The input is a time range dragged on the waveform
 * — see the handle lane in `ui/waveform.ts` — and a range over silence is a perfectly good
 * question with a perfectly good answer ("nothing pitched here", or "an E1, actually").
 *
 * IT IS ALLOWED TO SAY IT DOES NOT KNOW, AND IT MUST. A confident wrong note here is worse
 * than no note at all, because the player will trust it and "fix" a sheet that was right. So
 * `audio/pitch.ts` returns null below a clarity of about 0.6 and this panel prints "No clear
 * pitch here" rather than a greyed-out guess. There is no code path that shows a note name
 * the detector was not sure of.
 *
 * PLAYBACK IS OURS, NOT THE SHELL'S. There is no "play a range" call in the bridge — the
 * shell's transport does play, pause and seek on the whole take and nothing else. So the
 * slice is played here, with Web Audio, out of the decoded samples we already hold: an
 * AudioBuffer built from the selection and fired at the app's AudioContext. That reaches the
 * user's ears inside a DAW as well, because the browser-side synth already does. The app's
 * transport is not touched, not paused and not consulted.
 *
 * ANALYSIS RUNS ON THE NEXT FRAME, NOT INSIDE THE GESTURE. Listening costs about 3.4 ms per
 * 73 ms frame (measured — see `audio/pitch.ts`), so a three-second selection is about 200 ms
 * of arithmetic. That is short enough to be worth doing and long enough to feel like a hang
 * if it happens between a mouse-up and the next paint. So `show()` paints "Listening…" first
 * and does the work afterwards. A second `show()` cancels the first.
 *
 * WHAT IT DOES NOT DO. It never edits anything, never re-runs the pipeline and never tells
 * the sheet it is wrong — it puts the two claims side by side and leaves the judgement to the
 * player. That is the same rule the pipeline's guards follow (§4.8): delete, never invent.
 */

import { el, formatTime } from './dom';
import { detectPitchTrack, midiToHz, type PitchReading } from '../audio/pitch';
import { midiToName } from '../score/notes';

export interface TunerOptions {
  /** The decoded mono samples of the ORIGINAL recording, and its rate. Null when there is none. */
  getAudio: () => { pcm: Float32Array; sampleRate: number } | null;
  /** Where to play through. The integrator passes the app's AudioContext. */
  ctx: AudioContext;
  onClose?: () => void;
  /** Offered only after a confident headline reading; the app still owns undo and insertion. */
  onAddDetected?: (midi: number) => void;
}

/**
 * One stretch of the selection that held one steady note.
 *
 * `midi` is null for a stretch with nothing pitched in it — a rest, a mute, or noise — and
 * those are kept rather than dropped, because "note, gap, note" is a different answer from
 * "two notes" and the player needs to be able to tell them apart.
 */
interface Run {
  midi: number | null;
  hz: number | null;
  cents: number;
  clarity: number;
  /** How many analysis frames agreed. The only honest measure of "how much of this is it". */
  frames: number;
}

/** Cents inside which a note counts as in tune, for the meter's colour only. */
const IN_TUNE_CENTS = 5;
/**
 * A pitched run has to last at least this many frames to be called a note.
 *
 * One frame of agreement in the middle of a pluck's attack is a transient, not a note, and
 * printing it would make a clean single note read as a three-note run. Two frames at the
 * default hop is 100 ms, which is about the shortest thing anybody plays on purpose.
 */
const MIN_RUN_FRAMES = 2;
/** Visible waveform probes are 100 ms; low notes need a wider hidden analysis window. */
const ANALYSIS_MIN_SEC = 0.24;
/** Fade in and out of a played slice, so a cut mid-cycle does not click. */
const FADE_SEC = 0.006;
/** Web Audio will not make a buffer outside this range; outside it we refuse rather than detune. */
const MIN_BUFFER_RATE = 8000;
const MAX_BUFFER_RATE = 96000;

export class Tuner {
  private host: HTMLElement;
  private opts: TunerOptions;
  private root: HTMLElement;

  // The pieces that get rewritten, held rather than re-queried.
  private rangeEl: HTMLElement;
  private noteEl: HTMLElement;
  private hzEl: HTMLElement;
  private needleEl: HTMLElement;
  private centsEl: HTMLElement;
  private meterEl: HTMLElement;
  private verdictEl: HTMLElement;
  private sequenceEl: HTMLElement;
  private playButton: HTMLButtonElement;
  private addButton: HTMLButtonElement | null = null;
  private hintEl: HTMLElement;
  private closeButton: HTMLButtonElement;
  private onKeyDown: (e: KeyboardEvent) => void;

  private fromSec: number | null = null;
  private toSec: number | null = null;
  private expectedMidi: number | null = null;
  private runs: Run[] = [];
  private headline: PitchReading | null = null;
  private analysing = false;
  private frameCount = 0;
  /** Set when the samples were there but too short to say anything about. */
  private tooShort = false;

  private pending: number | null = null;
  private source: AudioBufferSourceNode | null = null;
  private playing = false;
  private destroyed = false;

  constructor(host: HTMLElement, opts: TunerOptions) {
    this.host = host;
    this.opts = opts;
    ensureStyles();

    this.rangeEl = el('span', { class: 'tuner-range mono dim' });
    this.noteEl = el('div', { class: 'tuner-note', text: '—' });
    this.hzEl = el('div', { class: 'tuner-hz mono dim' });
    this.needleEl = el('div', { class: 'tuner-needle' });
    this.centsEl = el('div', { class: 'tuner-cents mono dim' });
    this.meterEl = el(
      'div',
      { class: 'tuner-meter' },
      el(
        'div',
        { class: 'tuner-track' },
        el('div', { class: 'tuner-tick' }),
        this.needleEl
      ),
      el(
        'div',
        { class: 'tuner-scale dim' },
        el('span', { text: 'flat' }),
        el('span', { text: 'in tune' }),
        el('span', { text: 'sharp' })
      ),
      this.centsEl
    );
    // The verdict is the answer to the question the player asked, and it arrives a beat after
    // they asked it, so it is announced rather than silently swapped in.
    this.verdictEl = el('div', { class: 'tuner-verdict', 'aria-live': 'polite' });
    this.sequenceEl = el('div', { class: 'tuner-sequence' });
    this.hintEl = el('span', { class: 'tuner-hint dim' });
    this.playButton = el('button', {
      class: 'tuner-play',
      text: 'Play this bit',
      onClick: () => (this.playing ? this.stop() : this.play())
    }) as HTMLButtonElement;
    if (this.opts.onAddDetected) {
      this.addButton = el('button', {
        class: 'tuner-add',
        text: 'Add detected note',
        disabled: true,
        onClick: () => {
          if (this.headline?.midi !== null && this.headline?.midi !== undefined) {
            this.opts.onAddDetected?.(this.headline.midi);
          }
        }
      }) as HTMLButtonElement;
    }

    /**
     * The way out, at the FAR RIGHT EDGE of the panel.
     *
     * It used to sit next to the title, which put it in the middle of a four-column strip —
     * the one place on a horizontal bar nobody looks for a close button, and directly beside
     * the reading it is nothing to do with. It is now the last thing in the row, styled as a
     * chip like every other control the player can press here rather than as bare punctuation,
     * so it reads as a button instead of as a stray glyph in the readout.
     */
    this.closeButton = el('button', {
      class: 'chip tuner-close',
      'data-role': 'tuner-close',
      'aria-label': 'Close the audio check',
      title: 'Close the audio check (Esc)',
      onClick: () => this.requestClose()
    }) as HTMLButtonElement;
    this.closeButton.append(el('span', { 'aria-hidden': 'true', text: '✕' }), el('span', { class: 'tuner-close-word', text: 'Close' }));

    this.root = el(
      'section',
      { class: 'tuner', role: 'region', 'aria-label': 'What is actually in this bit of the recording' },
      el(
        'div',
        { class: 'tuner-head' },
        // Title and range share a group that is allowed to wrap inside itself, so the panel
        // stays on one line at 360px. A media query cannot do this: the panel's width is its
        // host's, not the window's, and in the plugin those are different numbers.
        el(
          'div',
          { class: 'tuner-headline' },
          el('span', { class: 'tuner-title', text: 'Audio check' }),
          this.rangeEl
        )
      ),
      el(
        'div',
        { class: 'tuner-main' },
        el('div', { class: 'tuner-readout' }, this.noteEl, this.hzEl),
        this.meterEl
      ),
      this.verdictEl,
      this.sequenceEl,
      el('div', { class: 'tuner-actions' }, this.playButton, this.addButton, this.hintEl),
      this.closeButton
    );

    // Esc closes it, as a second way out and never as the only one.
    //
    // The player runs this inside REAPER, which eats most keyboard shortcuts before the plugin
    // sees them — so the mouse path is the one that has to work and the key is a convenience.
    // It is bound on the document with capture off and it does not preventDefault, because the
    // waveform below also clears its selection on Esc and both of those are the right answer
    // to the same key press.
    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || this.destroyed) return;
      this.requestClose();
    };
    document.addEventListener('keydown', this.onKeyDown);

    this.host.appendChild(this.root);
    this.render();
  }

  /** Stop the sound, then hand back to the integrator. Both ways out come through here. */
  private requestClose(): void {
    this.stop();
    this.opts.onClose?.();
  }

  // =========================================================================
  // Asking the question
  // =========================================================================

  /**
   * Analyse and show a stretch of the recording, in RECORDING seconds.
   *
   * Returns immediately. The panel shows the range and says it is listening; the arithmetic
   * happens on the next frame so the paint lands first. Calling it again cancels whatever
   * was pending — a player dragging a selection edge generates a lot of these.
   */
  show(fromSec: number, toSec: number): void {
    if (this.destroyed) return;
    const from = Math.max(0, Math.min(fromSec, toSec));
    const to = Math.max(fromSec, toSec);
    this.fromSec = from;
    this.toSec = to;
    this.runs = [];
    this.headline = null;
    this.frameCount = 0;
    this.tooShort = false;
    this.analysing = true;
    this.stop();
    this.render();

    if (this.pending !== null) cancelAnimationFrame(this.pending);
    this.pending = requestAnimationFrame(() => {
      this.pending = null;
      this.analyse();
      this.analysing = false;
      this.render();
    });
  }

  /** What the sheet SAYS is here, so the two can be shown side by side. */
  setExpected(midi: number | null): void {
    this.expectedMidi = midi === null || !Number.isFinite(midi) ? null : Math.round(midi);
    if (!this.destroyed) this.render();
  }

  private analyse(): void {
    const audio = this.opts.getAudio();
    if (!audio || this.fromSec === null || this.toSec === null) return;
    const { pcm, sampleRate } = audio;
    if (!(sampleRate > 0) || pcm.length === 0) return;

    const centre = (this.fromSec + this.toSec) / 2;
    const duration = pcm.length / sampleRate;
    const wanted = Math.max(this.toSec - this.fromSec, ANALYSIS_MIN_SEC);
    let analysisFrom = Math.max(0, centre - wanted / 2);
    let analysisTo = Math.min(duration, analysisFrom + wanted);
    analysisFrom = Math.max(0, analysisTo - wanted);
    const a = Math.max(0, Math.min(pcm.length, Math.round(analysisFrom * sampleRate)));
    const b = Math.max(a, Math.min(pcm.length, Math.round(analysisTo * sampleRate)));
    // Under about 25 ms there is not enough signal for even a high note to show two periods,
    // and saying so is better than analysing it and reporting the nothing we would find.
    if (b - a < sampleRate * 0.025) {
      this.tooShort = true;
      return;
    }

    const readings = detectPitchTrack(pcm.subarray(a, b), sampleRate);
    this.frameCount = readings.length;
    this.runs = groupRuns(readings);
    this.headline = headlineOf(this.runs);
  }

  // =========================================================================
  // Playing it
  // =========================================================================

  /**
   * Play that stretch of the original recording.
   *
   * Straight out of the samples we already hold. The shell's transport is not involved and
   * is not disturbed: this is a second, independent voice, exactly like the built-in synth.
   */
  play(): void {
    if (this.destroyed) return;
    const audio = this.opts.getAudio();
    if (!audio || this.fromSec === null || this.toSec === null) return;
    this.stop();

    const { pcm, sampleRate } = audio;
    const a = Math.max(0, Math.min(pcm.length, Math.round(this.fromSec * sampleRate)));
    const b = Math.max(a, Math.min(pcm.length, Math.round(this.toSec * sampleRate)));
    if (b - a < 8) return;
    // Web Audio refuses a buffer outside this range outright. Retuning the slice to fit
    // would play it back at the wrong pitch, in a panel whose entire job is pitch, so a rate
    // this strange is refused instead.
    if (sampleRate < MIN_BUFFER_RATE || sampleRate > MAX_BUFFER_RATE) {
      this.hintEl.textContent = 'That recording has a sample rate this browser cannot play back.';
      return;
    }

    const ctx = this.opts.ctx;
    // WebKit suspends contexts when the page is occluded or the audio session moves; a
    // suspended context accepts everything and makes no sound.
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);

    try {
      const buffer = ctx.createBuffer(1, b - a, sampleRate);
      // `set` rather than `copyToChannel`: the samples we hold may be a view onto somebody
      // else's buffer, and this copies them without caring whose it is.
      buffer.getChannelData(0).set(pcm.subarray(a, b));
      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const gain = ctx.createGain();
      const start = ctx.currentTime + 0.02;
      const dur = (b - a) / sampleRate;
      const fade = Math.min(FADE_SEC, dur / 4);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(1, start + fade);
      gain.gain.setValueAtTime(1, start + dur - fade);
      gain.gain.linearRampToValueAtTime(0, start + dur);

      source.connect(gain);
      gain.connect(ctx.destination);
      source.onended = () => {
        if (this.source === source) {
          this.source = null;
          this.playing = false;
          this.renderActions();
        }
      };
      source.start(start);
      source.stop(start + dur + 0.01);
      this.source = source;
      this.playing = true;
      this.renderActions();
    } catch {
      // A rate the context will not build, a closed context, a buffer too large — none of
      // these is worth an exception in the console on a button press.
      this.playing = false;
      this.hintEl.textContent = 'That bit could not be played back.';
    }
  }

  stop(): void {
    const source = this.source;
    this.source = null;
    this.playing = false;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      try {
        source.disconnect();
      } catch {
        /* already gone */
      }
    }
    if (!this.destroyed) this.renderActions();
  }

  // =========================================================================
  // Drawing it
  // =========================================================================

  private render(): void {
    if (this.destroyed) return;
    const hasRange = this.fromSec !== null && this.toSec !== null;
    const span = hasRange ? this.toSec! - this.fromSec! : 0;
    this.rangeEl.textContent = hasRange
      ? `${formatTime(this.fromSec!)} – ${formatTime(this.toSec!)} · ${span.toFixed(2)} s`
      : '';

    const audio = this.opts.getAudio();
    if (!audio) {
      this.setReadout(null, 'no audio');
      this.setVerdict('There is no recording behind this sheet, so there is nothing to listen to. This happens when the notes came from a MIDI file rather than from audio.');
      this.sequenceEl.replaceChildren();
      this.renderActions();
      return;
    }
    if (!hasRange) {
      this.setReadout(null, 'nothing picked');
      this.setVerdict('Drag across the waveform to pick a stretch of the recording, and this will say what is actually in it — even where the app heard no notes at all.');
      this.sequenceEl.replaceChildren();
      this.renderActions();
      return;
    }
    if (this.analysing) {
      this.setReadout(null, 'listening…');
      this.setVerdict('Listening to that stretch of the recording.');
      this.sequenceEl.replaceChildren();
      this.renderActions();
      return;
    }
    if (this.tooShort) {
      this.setReadout(null, 'too short');
      this.setVerdict('That is too short a stretch to hear a pitch in. Drag out a little more — about a tenth of a second is enough for a bass note.');
      this.sequenceEl.replaceChildren();
      this.renderActions();
      return;
    }

    this.setReadout(this.headline);
    this.renderVerdict();
    this.renderSequence();
    this.renderActions();
  }

  /**
   * The big note, the frequency and the meter.
   *
   * Null means "we could not tell", and the slot then says so in words at ordinary size
   * rather than showing a dash in 40px type — a big dash reads as a rendering fault, and
   * this panel's whole credibility rests on its "I don't know" looking deliberate.
   */
  private setReadout(reading: PitchReading | null, emptyLabel = 'no note'): void {
    if (!reading || reading.midi === null || reading.hz === null) {
      this.noteEl.textContent = emptyLabel;
      this.noteEl.dataset.empty = '1';
      this.hzEl.textContent = '';
      this.centsEl.textContent = '';
      this.needleEl.style.left = '50%';
      this.meterEl.dataset.state = 'none';
      return;
    }
    delete this.noteEl.dataset.empty;
    this.noteEl.textContent = reading.noteName ?? midiToName(reading.midi);
    this.hzEl.textContent = `${reading.hz.toFixed(2)} Hz`;
    const cents = Math.max(-50, Math.min(50, reading.cents));
    this.needleEl.style.left = `${50 + cents}%`;
    const rounded = Math.round(cents);
    this.centsEl.textContent =
      Math.abs(rounded) <= IN_TUNE_CENTS
        ? `in tune (${rounded > 0 ? '+' : ''}${rounded} cents)`
        : `${rounded > 0 ? '+' : ''}${rounded} cents ${rounded > 0 ? 'sharp' : 'flat'}`;
    this.meterEl.dataset.state = Math.abs(rounded) <= IN_TUNE_CENTS ? 'intune' : 'off';
  }

  /**
   * The sentence that does the actual work: what the sheet claims, against what is there.
   *
   * Written out in words rather than as two note names side by side, because "G2 / E1" is a
   * puzzle and "the sheet says G2, the recording sounds like E1 — fifteen semitones lower" is
   * an answer. The octave case is called out by name because it is this transcriber's
   * commonest mistake and the one a player is most likely to have half-noticed already.
   */
  private renderVerdict(): void {
    const heard = this.headline;
    const notes = this.runs.filter((r) => r.midi !== null);
    const expected = this.expectedMidi;

    if (!heard || heard.midi === null) {
      if (expected !== null) {
        this.setVerdict(
          `The sheet says ${midiToName(expected)} here, but there is no clear pitch in the recording at this point. Either nothing was played, or it was too quiet or too muted to hear a note in.`,
          'warn'
        );
      } else {
        this.setVerdict(
          'No clear pitch here. Nothing steady enough to name — it may be a rest, a muted note, a slide, or just noise.'
        );
      }
      return;
    }

    const heardName = heard.noteName ?? midiToName(heard.midi);
    if (expected === null) {
      const extra =
        notes.length > 1
          ? ` There are ${notes.length} notes in this stretch — the sequence is below.`
          : '';
      this.setVerdict(`The recording sounds like ${heardName}.${extra}`, 'ok');
      return;
    }

    const expectedName = midiToName(expected);
    if (expected === heard.midi) {
      const extra =
        notes.length > 1
          ? ` There are ${notes.length} notes in this stretch though, and the sheet has one.`
          : '';
      this.setVerdict(
        `The sheet says ${expectedName}, and that is what is here.${extra}`,
        notes.length > 1 ? 'warn' : 'ok'
      );
      return;
    }

    const diff = heard.midi - expected;
    this.setVerdict(
      `The sheet says ${expectedName}. The recording sounds like ${heardName} — ${describeGap(diff)}. They do not agree.` +
        (Math.abs(diff) % 12 === 0
          ? ' Octaves are this transcriber’s commonest mistake, so the sheet is the more likely one to be wrong.'
          : ''),
      'bad'
    );
  }

  private setVerdict(text: string, tone: 'plain' | 'ok' | 'warn' | 'bad' = 'plain'): void {
    this.verdictEl.textContent = text;
    this.verdictEl.dataset.tone = tone;
  }

  /**
   * The sequence, when the selection holds more than one note.
   *
   * Each run gets a share of the row in proportion to how many analysis frames agreed with
   * it, so a long note is a wide chip and a passing one is narrow. Deliberately no clock
   * times: the analysis frames overlap and the honest resolution is about a twentieth of a
   * second, so printing "0:03.18" would be claiming a precision this does not have. Order
   * and proportion are both true.
   */
  private renderSequence(): void {
    const notes = this.runs.filter((r) => r.midi !== null);
    if (notes.length < 2) {
      this.sequenceEl.replaceChildren();
      return;
    }
    const total = this.runs.reduce((sum, r) => sum + r.frames, 0) || 1;
    this.sequenceEl.replaceChildren(
      el('div', { class: 'tuner-seq-label dim', text: `${notes.length} notes in this stretch` }),
      el(
        'div',
        { class: 'tuner-seq-row' },
        ...this.runs.map((run) =>
          el('div', {
            class: run.midi === null ? 'tuner-seq-gap' : 'tuner-seq-chip',
            style: { flexGrow: String(Math.max(1, run.frames)), flexBasis: '0' },
            text: run.midi === null ? '' : midiToName(run.midi),
            title:
              run.midi === null
                ? 'Nothing pitched here'
                : `${midiToName(run.midi)} · ${run.hz?.toFixed(2)} Hz · ${Math.round(run.cents)} cents · about ${((run.frames / total) * 100).toFixed(0)}% of the selection`
          })
        )
      )
    );
  }

  private renderActions(): void {
    const audio = this.opts.getAudio();
    const canPlay = !!audio && this.fromSec !== null && this.toSec !== null;
    this.playButton.disabled = !canPlay;
    this.playButton.textContent = this.playing ? 'Stop' : 'Play this bit';
    if (this.addButton) {
      const midi = this.headline?.midi;
      this.addButton.disabled = midi === null || midi === undefined;
      this.addButton.textContent = midi === null || midi === undefined
        ? 'Add detected note'
        : `Add ${this.headline?.noteName ?? midiToName(midi)} to this segment`;
    }
    if (!audio) {
      this.hintEl.textContent = 'No recording behind this sheet.';
    } else if (!canPlay) {
      this.hintEl.textContent = 'Drag across the waveform to pick a stretch.';
    } else {
      this.hintEl.textContent = this.headline
        ? `${Math.round(this.headline.clarity * 100)}% confidence`
        : this.frameCount > 0
          ? `heard over ${this.frameCount} readings`
          : '';
    }
  }

  /** Everything a bug report or the harness needs, and nothing it has to interpret. */
  probe(): Record<string, unknown> {
    const audio = this.opts.getAudio();
    const panel = this.root.getBoundingClientRect();
    const close = this.closeButton.getBoundingClientRect();
    const closeStyle = getComputedStyle(this.closeButton);
    return {
      // --- the panel's own size, and where the way out is ---------------------------
      // Halved in this round (58-86px -> 29-43px), so the number is reported rather than
      // described: a check that reads "looks compact" is a check that cannot fail.
      panelHeight: Math.round(panel.height),
      panelWidth: Math.round(panel.width),
      panelRight: Math.round(panel.right),
      /** How far the close button's right edge sits from the panel's. Small = far right. */
      closeInsetPx: Math.round(panel.right - close.right),
      closeWidth: Math.round(close.width),
      closeVisible: close.width > 0 && close.height > 0,
      /** Its own colours, so "visually highlighted" is a fact and not a stylesheet promise. */
      closeBorderColor: closeStyle.borderTopColor,
      closeColor: closeStyle.color,
      closeIsChip: this.closeButton.classList.contains('chip'),
      /**
       * A PLAIN button in the same panel, for comparison.
       *
       * "Highlighted" is only meaningful against something that is not. Asserting the close
       * button's own colour against a literal would pass on a stylesheet that had turned every
       * control that colour; asserting it differs from its neighbour is the actual claim.
       */
      plainBorderColor: getComputedStyle(this.playButton).borderTopColor,
      /** Nothing at all is drawn to the right of it. */
      closeIsLastChild: this.root.lastElementChild === this.closeButton,
      /** Does the panel fit inside itself, or is `overflow: hidden` doing the work? */
      contentFits: this.root.scrollHeight <= this.root.clientHeight + 1,
      hasAudio: !!audio,
      sampleRate: audio?.sampleRate ?? null,
      fromSec: this.fromSec === null ? null : Number(this.fromSec.toFixed(3)),
      toSec: this.toSec === null ? null : Number(this.toSec.toFixed(3)),
      spanSec:
        this.fromSec === null || this.toSec === null
          ? null
          : Number((this.toSec - this.fromSec).toFixed(3)),
      analysing: this.analysing,
      tooShort: this.tooShort,
      frames: this.frameCount,
      hz: this.headline?.hz ?? null,
      midi: this.headline?.midi ?? null,
      cents: this.headline?.cents ?? null,
      clarity: this.headline?.clarity ?? null,
      noteName: this.headline?.noteName ?? null,
      noteCount: this.runs.filter((r) => r.midi !== null).length,
      sequence: this.runs.map((r) => (r.midi === null ? '-' : midiToName(r.midi))),
      expectedMidi: this.expectedMidi,
      expectedName: this.expectedMidi === null ? null : midiToName(this.expectedMidi),
      expectedHz: this.expectedMidi === null ? null : Number(midiToHz(this.expectedMidi).toFixed(3)),
      // Null means "no comparison was possible" — no expectation, or nothing heard — which
      // is a different answer from "they disagree" and must not read as one.
      agrees:
        this.expectedMidi === null || !this.headline || this.headline.midi === null
          ? null
          : this.headline.midi === this.expectedMidi,
      verdict: this.verdictEl.textContent,
      playing: this.playing
    };
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
    // The one listener that is NOT on an element inside `root` — see the note below — so it is
    // the one that has to be taken off by hand. The panel is rebuilt on every main render, so
    // leaking this would mean a stray Esc handler per render.
    document.removeEventListener('keydown', this.onKeyDown);
    if (this.pending !== null) {
      cancelAnimationFrame(this.pending);
      this.pending = null;
    }
    // Every listener this panel owns is on an element inside `root` (they were attached by
    // `el()` on creation), so removing it drops all of them with it.
    this.root.remove();
    releaseStyles();
  }
}

// ---------------------------------------------------------------------------
// Turning a track of readings into something a person can read
// ---------------------------------------------------------------------------

/**
 * Collapse a frame-by-frame track into runs of one note.
 *
 * Two passes, and the second one is the point: a pitched run shorter than `MIN_RUN_FRAMES` is
 * demoted to "nothing", and then the neighbours around it are merged. Without that, the
 * moment of an attack — where the string has not settled and one frame reads a fifth up —
 * turns a single clean note into a three-note sequence, which is exactly the kind of
 * invented detail this whole feature exists to argue against.
 */
function groupRuns(readings: PitchReading[]): Run[] {
  if (readings.length === 0) return [];

  const collapse = (values: Array<PitchReading | null>): Array<{ frames: PitchReading[] }> => {
    const out: Array<{ midi: number | null; frames: PitchReading[] }> = [];
    for (const r of values) {
      const midi = r?.midi ?? null;
      const last = out[out.length - 1];
      if (last && last.midi === midi) last.frames.push(r ?? EMPTY_READING);
      else out.push({ midi, frames: [r ?? EMPTY_READING] });
    }
    return out;
  };

  const first = collapse(readings);
  const cleaned: Array<PitchReading | null> = [];
  for (const group of first) {
    const midi = group.frames[0].midi;
    const keep = midi === null || group.frames.length >= MIN_RUN_FRAMES || first.length === 1;
    for (const f of group.frames) cleaned.push(keep ? f : null);
  }

  return collapse(cleaned).map((group) => {
    const frames = group.frames;
    const midi = frames[0].midi;
    if (midi === null) {
      return { midi: null, hz: null, cents: 0, clarity: 0, frames: frames.length };
    }
    const sorted = frames.map((f) => f.hz ?? 0).sort((a, b) => a - b);
    const hz = sorted[(sorted.length - 1) >> 1];
    const cents = median(frames.map((f) => f.cents));
    const clarity = frames.reduce((s, f) => s + f.clarity, 0) / frames.length;
    return { midi, hz, cents, clarity, frames: frames.length };
  });
}

const EMPTY_READING: PitchReading = { hz: null, midi: null, cents: 0, clarity: 0, noteName: null };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1];
}

/**
 * The one note to put in big type: the pitched run that takes up the most of the selection.
 *
 * Longest rather than loudest or first, because the question the player asked was "what is in
 * this bit", and the answer to that is whatever most of it was.
 */
function headlineOf(runs: Run[]): PitchReading | null {
  let best: Run | null = null;
  for (const run of runs) {
    if (run.midi === null) continue;
    if (!best || run.frames > best.frames) best = run;
  }
  if (!best || best.hz === null || best.midi === null) return null;
  return {
    hz: best.hz,
    midi: best.midi,
    cents: best.cents,
    clarity: best.clarity,
    noteName: midiToName(best.midi)
  };
}

/** "an octave lower", "three semitones higher" — the gap in words rather than in numbers. */
function describeGap(semitones: number): string {
  const direction = semitones > 0 ? 'higher' : 'lower';
  const n = Math.abs(semitones);
  if (n % 12 === 0) {
    const octaves = n / 12;
    return octaves === 1 ? `an octave ${direction}` : `${octaves} octaves ${direction}`;
  }
  return `${n} semitone${n === 1 ? '' : 's'} ${direction}`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * The panel's own stylesheet, injected once.
 *
 * This file does not own `ui/styles.css`, and a component that only looks right if somebody
 * else remembers to paste something in is a component that will ship looking wrong. So it
 * carries its own rules, written against the app's existing tokens so it themes with
 * everything else. It is deliberately one block with one class prefix: move it into
 * `styles.css` verbatim and delete `ensureStyles`/`releaseStyles` whenever that is tidier.
 *
 * `--select` is the one colour this panel and the waveform's selection band would both like
 * to have as a token; the fallback in the `var()` is the same blue the strip falls back to,
 * so the two agree whether or not the token is ever added.
 */
const STYLE_ID = 'riffsheet-tuner-styles';
let styleUsers = 0;

/*
 * HALF THE HEIGHT IT WAS, and every number in here moved with it.
 *
 * It used to be 58-86px. This window is already more chrome than music, and the audio check is
 * a readout you glance at rather than a panel you work in — the space it was taking came out of
 * the sheet, which is the point of the app. So: 29-43px, and the type, padding and gaps scaled
 * to match rather than the box simply being clipped. Nothing here is `overflow: hidden` doing
 * the work; the contents genuinely fit, at 900x600 and at 360x280.
 *
 * The big note stays the biggest thing in the row (15px against 10-11px around it) because it
 * is the answer to the question the player asked. What went, in order, is the slack: the meter
 * and the sequence row were already display:none, the padding halved, the verdict is two lines
 * instead of three, and the buttons lost the padding they were carrying from the global button
 * rule.
 */
const CSS = `
.tuner {
  display: grid; grid-template-columns: auto minmax(120px, 1fr) minmax(180px, 2fr) auto auto;
  grid-template-areas: "head main verdict actions close"; align-items: center; gap: 8px;
  min-height: 29px; max-height: 43px; overflow: hidden; padding: 3px 8px;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--radius);
  min-width: 0;
}
.tuner-head { grid-area: head; display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.tuner-headline { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; flex: 1 1 auto; min-width: 0; }
.tuner-title { font-size: 11px; font-weight: 600; }
.tuner-range { font-size: 10px; white-space: nowrap; }
/*
 * The way out: last column, hard against the right edge, and lit rather than grey.
 *
 * It is a chip and not an icon glyph on purpose — every other thing the player can press on
 * this strip is a chip, and a bare "×" floating in a readout reads as debris. The accent
 * border is what makes it findable at 29px tall without it shouting: filled accent would make
 * closing the panel look like the primary action on it, which it is not.
 */
.tuner-close {
  grid-area: close; flex: 0 0 auto; justify-self: end;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 9px; font-size: 11px; line-height: 1.4;
  border-color: var(--accent); color: var(--accent); background: var(--bg-raised);
}
.tuner-close:hover:not(:disabled) { background: var(--accent); color: #1a1005; border-color: var(--accent); }
.tuner-main { grid-area: main; display: flex; align-items: center; gap: 6px; min-width: 0; }
.tuner-readout { display: flex; align-items: baseline; gap: 5px; min-width: 4.5ch; }
.tuner-note {
  font-size: 15px; font-weight: 600; line-height: 1.05;
  font-variant-numeric: tabular-nums; letter-spacing: -0.01em;
}
/* "I don't know" has to look chosen, not broken. See setReadout(). */
.tuner-note[data-empty] { font-size: 11px; font-weight: 500; color: var(--text-dim); letter-spacing: 0; }
.tuner-hz { font-size: 10px; }
.tuner-meter { display: none; }
.tuner-track {
  position: relative; height: 10px; border-radius: 5px;
  background: var(--bg); border: 1px solid var(--border);
}
.tuner-tick {
  position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px;
  background: var(--text-dim); opacity: 0.8;
}
.tuner-needle {
  position: absolute; top: -3px; bottom: -3px; width: 3px; border-radius: 2px;
  transform: translateX(-50%); background: var(--text-dim);
  transition: left 90ms linear;
}
.tuner-meter[data-state="intune"] .tuner-needle { background: var(--ok); }
.tuner-meter[data-state="off"] .tuner-needle { background: var(--warn); }
.tuner-meter[data-state="none"] .tuner-needle { opacity: 0.35; }
.tuner-scale { display: flex; justify-content: space-between; font-size: 10px; }
.tuner-cents { font-size: 11.5px; }
.tuner-verdict { grid-area: verdict; font-size: 11px; line-height: 1.3; color: var(--text); max-height: 2.6em; overflow: hidden; }
.tuner-verdict[data-tone="plain"] { color: var(--text-dim); }
.tuner-verdict[data-tone="ok"] { color: var(--text); }
.tuner-verdict[data-tone="warn"] { color: var(--warn); }
.tuner-verdict[data-tone="bad"] { color: var(--danger); }
.tuner-sequence { display: none; }
.tuner-seq-label { font-size: 11px; }
.tuner-seq-row { display: flex; gap: 2px; align-items: stretch; min-width: 0; }
.tuner-seq-chip {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 3px 4px; border-radius: 4px; text-align: center;
  font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--select, #5aa9e8); color: #06131f;
}
.tuner-seq-gap { min-width: 3px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border); }
.tuner-actions { grid-area: actions; display: flex; align-items: center; gap: 5px; min-width: 0; }
/* The global button rule is sized for a toolbar; at 29px tall it is what overflows first. */
.tuner-actions button { padding: 2px 8px; font-size: 11px; line-height: 1.4; white-space: nowrap; }
.tuner-hint { font-size: 10px; white-space: nowrap; }
/*
 * Narrow: the verdict and the confidence line go, the readout and the way out stay. The close
 * button keeps its column at every width — it was moved here to be findable, and a breakpoint
 * that hid it would put it back where it started.
 */
@media (max-width: 760px) {
  .tuner { grid-template-columns: auto 1fr auto auto; grid-template-areas: "head main actions close"; }
  .tuner-verdict { display: none; }
  .tuner-hint { display: none; }
  /* Under ~420px the word does not fit beside the readout; the glyph and the tooltip carry it. */
  .tuner-close-word { display: none; }
}
`;

function ensureStyles(): void {
  styleUsers++;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function releaseStyles(): void {
  styleUsers = Math.max(0, styleUsers - 1);
  if (styleUsers > 0) return;
  document.getElementById(STYLE_ID)?.remove();
}
