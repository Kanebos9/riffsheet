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
 * PPQ is 480, not the IR's 24 — MIDI has no reason to inherit the notation grid, and 480 is
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

/** The note-on/note-off stream of ONE part, on one channel. No meta events. */
function performanceEvents(
  ir: RiffsheetIR,
  skel: TimeSkeleton,
  sourceNotes: InputNote[],
  quantized: boolean,
  channel: number
): MidiEvent[] {
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
            pushNote(events, Math.round(startTick * scale), Math.round(endTick * scale), n.midi, n.velocity ?? 96, channel);
          }
        }
      }
    }
  } else {
    // As-played: seconds -> ticks at the display tempo, so wall-clock playback matches the audio.
    const bpm = ir.tempo.displayBpm > 0 ? ir.tempo.displayBpm : 120;
    const perSec = (bpm / 60) * MIDI_PPQ;
    for (const n of sourceNotes) {
      const start = Math.max(0, Math.round((n.startSec - originSec(skel)) * perSec));
      const end = Math.max(start + 1, Math.round((n.endSec - originSec(skel)) * perSec));
      pushNote(events, start, end, n.midi, n.velocity ?? 96, channel);
    }
  }
  return events;
}

/**
 * The tempo and meter CHANGES of the score. These belong to the timeline, not to any one part,
 * which is why a format-1 file puts them in the conductor track and nowhere else. Empty on the
 * as-played variant: that file has a constant tick clock by definition.
 */
function conductorEvents(ir: RiffsheetIR, quantized: boolean): MidiEvent[] {
  if (!quantized) return [];
  const events: MidiEvent[] = [];
  const scale = MIDI_PPQ / ir.divisions;
  for (const change of ir.tempo.changes ?? []) {
    // Tick zero belongs to the header meta run, which now writes the SOURCE tempo rather than
    // `displayBpm`; emitting it again here would be a duplicate set-tempo at delta 0.
    if (change.tick <= 0) continue;
    if (!Number.isFinite(change.bpm) || change.bpm <= 0) continue;
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
  return events;
}

/** The score-level meta run every file opens with: tempo, meter, key. */
function headerMeta(ir: RiffsheetIR, bpm: number): number[] {
  const out: number[] = [];
  const usPerQuarter = Math.round(60000000 / bpm);
  // tempo
  out.push(...vlq(0), 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);
  // time signature: numerator, log2(denominator), MIDI clocks per metronome click, 32nds per quarter
  const [num, den] = ir.timeSig;
  out.push(...vlq(0), 0xff, 0x58, 0x04, num, Math.round(Math.log2(den)), ir.compound ? 36 : 24, 8);
  // key signature
  const sf = ir.key.fifths < 0 ? 256 + ir.key.fifths : ir.key.fifths;
  out.push(...vlq(0), 0xff, 0x59, 0x02, sf, ir.key.mode === 'minor' ? 1 : 0);
  return out;
}

/**
 * UTF-8, not `charCodeAt(0) & 0x7f`.
 *
 * The old encoding took the low seven bits of each UTF-16 code unit, so "Bas Gitar" survived and
 * "Bağlama" did not: ğ (U+011F) became 0x1f, a control character, and every non-Latin name came
 * out as mojibake or worse. SMF meta text has no declared charset, but UTF-8 is what every DAW
 * and every notation program written this century reads and writes, and it is the only encoding
 * that can carry the names Riffsheet's users actually type. Surrogate pairs are joined before
 * encoding (`[...name]` iterates code POINTS), so astral characters emit four bytes rather than
 * two broken three-byte sequences.
 */
export function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return out;
}

function trackNameMeta(name: string): number[] {
  const bytes = utf8Bytes(name);
  return [...vlq(0), 0xff, 0x03, ...vlq(bytes.length), ...bytes];
}

/**
 * The tempo the file OPENS at.
 *
 * A symbolic source that declares its tempo at tick zero is stating the score's opening tempo,
 * and it is the authority on it; `displayBpm` is a derived summary of the whole take and was
 * being written in its place, so a file whose first bar said 90 exported as its own average.
 * The conductor track then skipped the tick-zero change (`change.tick <= 0`) because the header
 * was assumed to have covered it, which left no statement of the opening tempo anywhere.
 *
 * The AS-PLAYED variant is a different file with a different contract: its ticks are seconds
 * scaled by `displayBpm`, so its header must declare `displayBpm` or the wall clock is wrong.
 */
function headerBpm(ir: RiffsheetIR, quantized: boolean): number {
  const fallback = ir.tempo.displayBpm > 0 ? ir.tempo.displayBpm : 120;
  if (!quantized) return fallback;
  const atZero = (ir.tempo.changes ?? [])
    .filter((change) => change.tick <= 0 && Number.isFinite(change.bpm) && change.bpm > 0)
    .sort((a, b) => a.tick - b.tick)
    .pop();
  return atZero ? atZero.bpm : fallback;
}

/** MIDI data bytes are seven-bit. A caller-supplied program above 127 would become a status byte. */
function programByte(value: number | undefined, fallback: number): number {
  const candidate = Number.isFinite(value) ? Math.round(value as number) : fallback;
  return Math.max(0, Math.min(127, candidate));
}

/** Delta-encode a sorted event list onto a track and close it with end-of-track. */
function writeEvents(track: number[], events: MidiEvent[]): void {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let last = 0;
  for (const e of events) {
    track.push(...vlq(Math.max(0, e.tick - last)), ...e.bytes);
    last = e.tick;
  }
  track.push(...vlq(0), 0xff, 0x2f, 0x00);
}

function chunk(track: number[]): number[] {
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track];
}

function defaultProgram(ir: RiffsheetIR): number {
  return ir.instrument.stringCount === 0 ? 0 : ir.instrument.kind.startsWith('bass') ? 33 : 27;
}

export function toMidi(
  ir: RiffsheetIR,
  skel: TimeSkeleton,
  sourceNotes: InputNote[],
  quantized: boolean
): Uint8Array {
  const bpm = headerBpm(ir, quantized);
  const events = [
    ...performanceEvents(ir, skel, sourceNotes, quantized, 0),
    ...conductorEvents(ir, quantized)
  ];

  const track: number[] = [
    ...headerMeta(ir, bpm),
    ...trackNameMeta(`Riffsheet ${quantized ? 'quantized' : 'as played'}`),
    // program change
    ...vlq(0), 0xc0, programByte(undefined, defaultProgram(ir))
  ];
  writeEvents(track, events);

  const bytes = [
    0x4d, 0x54, 0x68, 0x64, // MThd
    ...u32(6),
    ...u16(0), // format 0
    ...u16(1), // one track
    ...u16(MIDI_PPQ),
    ...chunk(track)
  ];
  return new Uint8Array(bytes);
}

/** One part of a multi-track file, in the score's printed order. */
export interface MidiPart {
  ir: RiffsheetIR;
  /** The part's own clock. Every part shares one, so any of them will do; each brings its own. */
  skeleton: TimeSkeleton;
  /** The part's guarded input notes — what the as-played variant is made of. */
  notes: InputNote[];
  /** MIDI track name. Defaults to the part's display name via the caller. */
  name?: string;
  program?: number;
}

/**
 * FORMAT 1, one conductor track plus one track per part.
 *
 * THE FILE IS COMPLETE EVEN THOUGH THE APP IS NOT. Imported parts are notation-only on screen —
 * they never reach playback — but a .mid that silently dropped them would be a lie about the
 * document the user is looking at, and every DAW they drag it into expects the parts to be there.
 * So all N parts are written. (Sanctioned by the coordinator as a deliberate asymmetry between
 * what the app plays and what the file contains.)
 *
 * A ONE-PART SCORE IS NOT A MULTI-TRACK FILE. It delegates to `toMidi` and comes out byte-for-byte
 * as it always has — format 0, one track — so the caller can always route through this function
 * without changing what a single-part export produces.
 */
export function toMultiPartMidi(parts: MidiPart[], quantized: boolean): Uint8Array {
  if (!parts.length) throw new Error('MIDI: a score needs at least one part');
  if (parts.length === 1) return toMidi(parts[0].ir, parts[0].skeleton, parts[0].notes, quantized);

  const lead = parts[0].ir;
  const bpm = headerBpm(lead, quantized);

  const conductor: number[] = [
    ...headerMeta(lead, bpm),
    ...trackNameMeta(`Riffsheet ${quantized ? 'quantized' : 'as played'}`)
  ];
  writeEvents(conductor, conductorEvents(lead, quantized));

  const trackChunks: number[][] = [chunk(conductor)];
  parts.forEach((part, index) => {
    // Channel 10 (index 9) is percussion by GM convention; step over it.
    const channel = index >= 9 ? index + 1 : index;
    const track: number[] = [
      ...trackNameMeta(part.name ?? `Part ${index + 1}`),
      ...vlq(0), 0xc0 | channel, programByte(part.program, defaultProgram(part.ir))
    ];
    writeEvents(track, performanceEvents(part.ir, part.skeleton, part.notes, quantized, channel));
    trackChunks.push(chunk(track));
  });

  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, // MThd
    ...u32(6),
    ...u16(1), // format 1
    ...u16(trackChunks.length),
    ...u16(MIDI_PPQ),
    ...trackChunks.flat()
  ]);
}

function pushNote(
  events: MidiEvent[],
  startTick: number,
  endTick: number,
  midi: number,
  velocity: number,
  channel = 0
): void {
  const pitch = Math.max(0, Math.min(127, Math.round(midi)));
  const vel = Math.max(1, Math.min(127, Math.round(velocity)));
  events.push({ tick: startTick, order: 1, bytes: [0x90 | channel, pitch, vel] });
  events.push({ tick: Math.max(startTick + 1, endTick), order: 0, bytes: [0x80 | channel, pitch, 0] });
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
