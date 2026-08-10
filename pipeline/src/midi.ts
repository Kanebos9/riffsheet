/**
 * STATION 6b — Standard MIDI File writer, two variants.
 *
 *   toMidi(ir, skel, notes, true)   QUANTIZED  — the notated score, metronomically exact.
 *   toMidi(ir, skel, notes, false)  AS-PLAYED  — the original performance timing.
 *
 * Both are needed and for different jobs: the quantized file is what the user drags into a DAW
 * to double the part, the as-played file is what they audition against the audio to hear
 * whether the transcription lost the feel. The old app shipped only one and the difference kept
 * being reported as a bug.
 *
 * WRITTEN. No dependency: `midi-writer-js` and `@tonejs/midi` both assume a browser/node
 * environment and this package has zero runtime deps by design.
 *
 * PPQ is 480, not the IR's 12 — MIDI has no reason to inherit the notation grid, and 480 is
 * what every DAW expects. Quantized ticks scale by exactly 40, so nothing is rounded.
 *
 */

import type { RiffsheetIR } from './ir.js';
import type { TimeSkeleton } from './timeSkeleton.js';
import type { InputNote } from './types.js';

export const MIDI_PPQ = 480;

function vlq(value: number): number[] {
  const out: number[] = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

function u32(v: number): number[] {
  return [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}
function u16(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff];
}

interface MidiEvent {
  tick: number;
  /** Note-offs sort before note-ons at the same tick so a repeated pitch retriggers cleanly. */
  order: number;
  bytes: number[];
}

export function toMidi(
  ir: RiffsheetIR,
  skel: TimeSkeleton,
  sourceNotes: InputNote[],
  quantized: boolean
): Uint8Array {
  const bpm = ir.tempo.displayBpm > 0 ? ir.tempo.displayBpm : 120;
  const events: MidiEvent[] = [];

  if (quantized) {
    const scale = MIDI_PPQ / ir.divisions;
    for (const bar of ir.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          if (beat.isRest) continue;
          for (const n of beat.notes) {
            // A tie continuation is the same sounding note: extend, do not retrigger.
            if (n.tieStop) continue;
            const startTick = bar.startTick + beat.startTick;
            const endTick = tiedEndTick(ir, bar.index, beat, n.id) ?? startTick + beat.durTicks;
            pushNote(events, Math.round(startTick * scale), Math.round(endTick * scale), n.midi, n.velocity ?? 96);
          }
        }
      }
    }
    for (const change of ir.tempo.changes ?? []) {
      if (change.tick <= 0) continue;
      const us = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / change.bpm)));
      events.push({
        tick: Math.round(change.tick * scale),
        order: -2,
        bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]
      });
    }
    for (const bar of ir.bars) {
      if (bar.index === 0 || !bar.timeSigChanged) continue;
      const [barNum, barDen] = bar.timeSig;
      events.push({
        tick: Math.round(bar.startTick * scale),
        order: -2,
        bytes: [0xff, 0x58, 0x04, barNum, Math.round(Math.log2(barDen)), barDen === 8 && barNum % 3 === 0 ? 36 : 24, 8]
      });
    }
  } else {
    // As-played: seconds -> ticks at the display tempo, so wall-clock playback matches the audio.
    const perSec = (bpm / 60) * MIDI_PPQ;
    for (const n of sourceNotes) {
      const start = Math.max(0, Math.round((n.startSec - originSec(skel)) * perSec));
      const end = Math.max(start + 1, Math.round((n.endSec - originSec(skel)) * perSec));
      pushNote(events, start, end, n.midi, n.velocity ?? 96);
    }
  }

  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  const usPerQuarter = Math.round(60000000 / bpm);
  // tempo
  track.push(...vlq(0), 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);
  // time signature: numerator, log2(denominator), MIDI clocks per metronome click, 32nds per quarter
  const [num, den] = ir.timeSig;
  track.push(...vlq(0), 0xff, 0x58, 0x04, num, Math.round(Math.log2(den)), ir.compound ? 36 : 24, 8);
  // key signature
  const sf = ir.key.fifths < 0 ? 256 + ir.key.fifths : ir.key.fifths;
  track.push(...vlq(0), 0xff, 0x59, 0x02, sf, ir.key.mode === 'minor' ? 1 : 0);
  // track name
  const name = [...`Riffsheet ${quantized ? 'quantized' : 'as played'}`].map((c) => c.charCodeAt(0) & 0x7f);
  track.push(...vlq(0), 0xff, 0x03, ...vlq(name.length), ...name);
  // program change
  const program = ir.instrument.stringCount === 0 ? 0 : ir.instrument.kind.startsWith('bass') ? 33 : 27;
  track.push(...vlq(0), 0xc0, program);

  let last = 0;
  for (const e of events) {
    track.push(...vlq(Math.max(0, e.tick - last)), ...e.bytes);
    last = e.tick;
  }
  track.push(...vlq(0), 0xff, 0x2f, 0x00);

  const bytes = [
    0x4d, 0x54, 0x68, 0x64, // MThd
    ...u32(6),
    ...u16(0), // format 0
    ...u16(1), // one track
    ...u16(MIDI_PPQ),
    0x4d, 0x54, 0x72, 0x6b, // MTrk
    ...u32(track.length),
    ...track
  ];
  return new Uint8Array(bytes);
}

function pushNote(events: MidiEvent[], startTick: number, endTick: number, midi: number, velocity: number): void {
  const pitch = Math.max(0, Math.min(127, Math.round(midi)));
  const vel = Math.max(1, Math.min(127, Math.round(velocity)));
  events.push({ tick: startTick, order: 1, bytes: [0x90, pitch, vel] });
  events.push({ tick: Math.max(startTick + 1, endTick), order: 0, bytes: [0x80, pitch, 0] });
}

/** Follow a tie chain forward to the sounding end of the note. */
function tiedEndTick(ir: RiffsheetIR, fromBarIndex: number, fromBeat: import('./ir.js').IRBeat, noteId: string): number | null {
  let end: number | null = null;
  let chasing = fromBeat.notes.some((n) => n.id === noteId && n.tieStart);
  let barIndex = fromBarIndex;
  let beatIndex = ir.bars[fromBarIndex].voices[0].beats.indexOf(fromBeat);
  end = ir.bars[barIndex].startTick + fromBeat.startTick + fromBeat.durTicks;
  while (chasing) {
    beatIndex++;
    if (beatIndex >= ir.bars[barIndex].voices[0].beats.length) {
      barIndex++;
      beatIndex = 0;
      if (barIndex >= ir.bars.length) break;
    }
    const beat = ir.bars[barIndex].voices[0].beats[beatIndex];
    if (!beat) break;
    const cont = beat.notes.find((n) => n.id === noteId && n.tieStop);
    if (!cont) break;
    end = ir.bars[barIndex].startTick + beat.startTick + beat.durTicks;
    chasing = cont.tieStart;
  }
  return end;
}

function originSec(skel: TimeSkeleton): number {
  return skel.beatIdxToSeconds(skel.bars[0].startBeatIdx);
}
