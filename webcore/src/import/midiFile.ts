/** Bounded Standard MIDI File reader used by desktop/drop import. */

import type { InputNote } from '../pipeline';
// Direct, not through the barrel — that pulls in the JUCE and mock bridges, and this module runs
// headless in the test scripts.
import { RIFFSHEET_LIMITS } from '../bridge/types';

/** "a MusicXML/MIDI/GP import" is named in `RIFFSHEET_LIMITS`' own doc — so it is read, not copied. */
const MAX_FILE_BYTES = RIFFSHEET_LIMITS.containerBytes;
const MAX_TRACKS = 1024;
const MAX_TRACK_BYTES = 64 * 1024 * 1024;
const MAX_EVENTS = 2_000_000;
/**
 * A REALISTIC NOTE CAP (finding 12), and the number is a published promise, not a formality.
 *
 * One million was never openable. The pipeline spread whole note arrays into `Math.min/max`,
 * which throws `RangeError` in JavaScriptCore — the engine the plugin's WebView runs — long
 * before it computes anything, so the documented limit was unreachable by construction. Those
 * spreads are gone, but the honest ceiling is still far lower than a million: 200k notes is
 * already a densely-written orchestral hour, it is the point past which the quantizer's per-beat
 * work and the WebView's memory stop being comfortable on the 8 GB machines this ships to, and a
 * file above it is far more likely to be malformed or hostile than musical.
 *
 * Above the cap the import is REJECTED with a sentence the user can act on. It is never
 * truncated: half a score is a wrong score, and silently dropping bar 400 onwards is worse than
 * declining to open the file.
 */
const MAX_NOTES = 200_000;
const MAX_ABSOLUTE_TICK = 0x7fffffff;

export interface ParsedMidi {
  notes: InputNote[];
  tracks: { index: number; name: string; noteCount: number }[];
  tempoBpm: number;
  timeSignature: { numerator: number; denominator: number };
  tempoChanges: { tick: number; atSec: number; bpm: number }[];
  timeSignatureChanges: { tick: number; atSec: number; numerator: number; denominator: number }[];
  durationSec: number;
  durationTicks: number;
  ppq: number;
}

export function isMidiFile(name: string, bytes: ArrayBuffer): boolean {
  if (/\.midi?$/i.test(name)) return true;
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return head.length === 4 && head[0] === 0x4d && head[1] === 0x54 && head[2] === 0x68 && head[3] === 0x64;
}

interface RawEvent {
  tick: number;
  order: number;
  track: number;
  channel?: number;
  type: 'on' | 'off' | 'tempo' | 'timesig';
  midi?: number;
  velocity?: number;
  usPerQuarter?: number;
  numerator?: number;
  denominator?: number;
}

export function parseMidi(bytes: ArrayBuffer): ParsedMidi {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('That MIDI file is too large to open safely.');
  const view = new DataView(bytes);
  let pos = 0;
  let parsedEventCount = 0;
  let eventOrder = 0;

  const fail = (message: string): never => { throw new Error(`Malformed MIDI file: ${message}`); };
  const need = (count: number, end = view.byteLength): void => {
    if (!Number.isSafeInteger(count) || count < 0 || pos + count > end || pos + count > view.byteLength) {
      fail('unexpected end of data.');
    }
  };
  const readU8 = (end = view.byteLength): number => { need(1, end); return view.getUint8(pos++); };
  const readU16 = (): number => { need(2); const value = view.getUint16(pos); pos += 2; return value; };
  const readU32 = (): number => { need(4); const value = view.getUint32(pos); pos += 4; return value; };
  const readStr = (count: number, end = view.byteLength): string => {
    need(count, end);
    let value = '';
    for (let i = 0; i < count; i++) value += String.fromCharCode(view.getUint8(pos++));
    return value;
  };
  const readVarInt = (end: number): number => {
    let value = 0;
    for (let count = 0; count < 4; count++) {
      const byte = readU8(end);
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    return fail('a variable-length quantity exceeds four bytes.');
  };

  if (view.byteLength < 14 || readStr(4) !== 'MThd') throw new Error('That does not look like a MIDI file.');
  const headerLength = readU32();
  if (headerLength < 6) fail('the header chunk is shorter than six bytes.');
  need(headerLength);
  const headerEnd = pos + headerLength;
  const format = readU16();
  const trackCount = readU16();
  const division = readU16();
  pos = headerEnd;

  if (format > 2) fail(`unsupported format ${format}.`);
  if (format === 2) throw new Error('MIDI format 2 contains independent timelines and is not supported.');
  if (trackCount < 1 || trackCount > MAX_TRACKS) fail(`track count ${trackCount} is outside the supported limit.`);
  if (format === 0 && trackCount !== 1) fail('format 0 must contain exactly one track.');
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported yet.');
  if (division === 0) fail('ticks-per-quarter is zero.');
  const ppq = division;
  const events: RawEvent[] = [];
  const trackNames = new Map<number, string>();

  const addEvent = (event: Omit<RawEvent, 'order'>): void => {
    events.push({ ...event, order: eventOrder++ });
  };

  for (let track = 0; track < trackCount; track++) {
    if (readStr(4) !== 'MTrk') fail(`track ${track + 1} is missing its MTrk header.`);
    const length = readU32();
    if (length > MAX_TRACK_BYTES) throw new Error(`MIDI track ${track + 1} is too large to open safely.`);
    need(length);
    const end = pos + length;
    let tick = 0;
    let runningStatus = 0;

    while (pos < end) {
      if (++parsedEventCount > MAX_EVENTS) {
        throw new Error('That MIDI file contains too many events to open safely.');
      }
      const delta = readVarInt(end);
      tick += delta;
      if (!Number.isSafeInteger(tick) || tick > MAX_ABSOLUTE_TICK) {
        throw new Error('That MIDI file has an unsupported timeline length.');
      }

      let status = readU8(end);
      if (status < 0x80) {
        if (runningStatus < 0x80 || runningStatus >= 0xf0) fail('running status appears before a channel status.');
        pos--;
        status = runningStatus;
      } else if (status < 0xf0) {
        runningStatus = status;
      } else {
        runningStatus = 0;
      }

      if (status === 0xff) {
        const metaType = readU8(end);
        const metaLength = readVarInt(end);
        need(metaLength, end);
        const metaEnd = pos + metaLength;
        if (metaType === 0x51) {
          if (metaLength !== 3) fail('tempo meta event must contain exactly three bytes.');
          const usPerQuarter = (readU8(metaEnd) << 16) | (readU8(metaEnd) << 8) | readU8(metaEnd);
          if (usPerQuarter === 0) fail('tempo cannot be zero.');
          addEvent({ tick, track, type: 'tempo', usPerQuarter });
        } else if (metaType === 0x58) {
          if (metaLength < 2) fail('time-signature meta event is too short.');
          const numerator = readU8(metaEnd);
          const exponent = readU8(metaEnd);
          if (numerator === 0 || exponent > 7) fail('time signature is outside the supported range.');
          addEvent({ tick, track, type: 'timesig', numerator, denominator: 2 ** exponent });
        } else if (metaType === 0x03 && metaLength > 0) {
          let name = '';
          for (let i = pos; i < metaEnd; i++) name += String.fromCharCode(view.getUint8(i));
          name = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
          if (name) trackNames.set(track, name.slice(0, 120));
        }
        pos = metaEnd;
        if (metaType === 0x2f) {
          if (metaLength !== 0) fail('end-of-track event must have zero length.');
          pos = end;
        }
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const dataLength = readVarInt(end);
        need(dataLength, end);
        pos += dataLength;
        continue;
      }
      if (status >= 0xf0) fail(`unsupported system status 0x${status.toString(16)}.`);

      const type = status & 0xf0;
      const channel = status & 0x0f;
      const dataLength = type === 0xc0 || type === 0xd0 ? 1 : 2;
      need(dataLength, end);
      const data1 = readU8(end);
      const data2 = dataLength === 2 ? readU8(end) : 0;
      if (data1 >= 0x80 || data2 >= 0x80) fail('channel-event data bytes must be seven-bit values.');

      if (type === 0x90 || type === 0x80) {
        addEvent({
          tick,
          track,
          channel,
          type: type === 0x90 && data2 > 0 ? 'on' : 'off',
          midi: data1,
          velocity: data2
        });
      }
    }
    pos = end;
  }

  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const rawTempos = events.filter((event) => event.type === 'tempo');
  const tempoByTick = new Map<number, number>();
  for (const event of rawTempos) tempoByTick.set(event.tick, event.usPerQuarter!);
  const tempoEvents = [...tempoByTick].map(([tick, usPerQuarter]) => ({ tick, usPerQuarter })).sort((a, b) => a.tick - b.tick);

  const segments: { tick: number; seconds: number; usPerQuarter: number }[] = [];
  let segmentTick = 0;
  let segmentSeconds = 0;
  let segmentTempo = 500_000;
  for (const change of tempoEvents) {
    if (change.tick === 0) {
      segmentTempo = change.usPerQuarter;
      continue;
    }
    segmentSeconds += ((change.tick - segmentTick) / ppq) * (segmentTempo / 1_000_000);
    segmentTick = change.tick;
    segmentTempo = change.usPerQuarter;
    segments.push({ tick: segmentTick, seconds: segmentSeconds, usPerQuarter: segmentTempo });
  }
  segments.unshift({ tick: 0, seconds: 0, usPerQuarter: tempoByTick.get(0) ?? 500_000 });

  const tickToSec = (tick: number): number => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    const segment = segments[lo];
    return segment.seconds + ((tick - segment.tick) / ppq) * (segment.usPerQuarter / 1_000_000);
  };

  const open = new Map<string, { tick: number; velocity: number; track: number }[]>();
  const notes: InputNote[] = [];
  for (const event of events) {
    if ((event.type !== 'on' && event.type !== 'off') || event.midi === undefined) continue;
    const key = `${event.track}:${event.channel ?? 0}:${event.midi}`;
    const stack = open.get(key) ?? [];
    if (event.type === 'on') {
      stack.push({ tick: event.tick, velocity: event.velocity ?? 96, track: event.track });
      open.set(key, stack);
      continue;
    }
    const started = stack.shift();
    if (!started) continue;
    if (stack.length) open.set(key, stack);
    else open.delete(key);
    if (notes.length >= MAX_NOTES) {
      throw new Error(`That MIDI file has more than ${MAX_NOTES.toLocaleString('en-US')} notes, which is more than Riffsheet can open safely.`);
    }
    const endTick = Math.max(started.tick + 1, event.tick);
    notes.push({
      startSec: tickToSec(started.tick),
      endSec: tickToSec(endTick),
      midi: event.midi,
      velocity: started.velocity,
      sourceTiming: { startTick: started.tick, endTick, ppq },
      sourceTrackIndex: started.track
    });
  }
  notes.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi || a.endSec - b.endSec);
  notes.forEach((note, index) => { note.id = `m${index}`; });

  const firstTempoUs = tempoByTick.get(0) ?? 500_000;
  const rawTimeSignatureEvents = events.filter((event) => event.type === 'timesig');
  const timeSignatureByTick = new Map<number, RawEvent>();
  for (const event of rawTimeSignatureEvents) timeSignatureByTick.set(event.tick, event);
  const timeSignatureEvents = [...timeSignatureByTick.values()].sort(
    (a, b) => a.tick - b.tick || a.order - b.order
  );
  // A meter event later in the song must not retroactively become bar 1's meter.
  const firstTimeSig = timeSignatureByTick.get(0);
  const tempoChanges = segments.map((segment) => ({
    tick: segment.tick,
    atSec: segment.seconds,
    bpm: 60_000_000 / segment.usPerQuarter
  }));
  const timeSignatureChanges = timeSignatureEvents.map((event) => ({
    tick: event.tick,
    atSec: tickToSec(event.tick),
    numerator: event.numerator!,
    denominator: event.denominator!
  }));
  const durationTicks = notes.reduce(
    (largest, note) => Math.max(largest, note.sourceTiming?.endTick ?? 0),
    0
  );

  // A MIDI file is already symbolic. Carry its bar and tempo maps into the same exact-timing
  // path used by MusicXML/GP import instead of reconstructing and re-quantizing its seconds.
  // MIDI time-signature events do not explicitly list bars, so expand them into consecutive
  // full measures through the last note. An off-boundary meter change closes the current bar
  // at that event rather than silently shifting the change to a different musical moment.
  const meterAtZero = timeSignatureChanges.find((change) => change.tick === 0) ?? {
    tick: 0,
    atSec: 0,
    numerator: 4,
    denominator: 4
  };
  const meterChanges = [
    meterAtZero,
    ...timeSignatureChanges.filter((change) => change.tick > 0)
  ].sort((a, b) => a.tick - b.tick);
  const sourceBars: NonNullable<InputNote['sourceBars']> = [];
  let barStart = 0;
  let meterIndex = 0;
  while (barStart < durationTicks && sourceBars.length < 100_000) {
    while (meterIndex + 1 < meterChanges.length && meterChanges[meterIndex + 1].tick <= barStart) {
      meterIndex++;
    }
    const meter = meterChanges[meterIndex];
    const nominal = Math.max(1, Math.round((ppq * 4 * meter.numerator) / meter.denominator));
    const nextChange = meterChanges[meterIndex + 1]?.tick;
    const duration =
      nextChange !== undefined && nextChange > barStart && nextChange < barStart + nominal
        ? nextChange - barStart
        : nominal;
    sourceBars.push({
      startTick: barStart,
      durationTicks: duration,
      ppq,
      timeSig: [meter.numerator, meter.denominator],
      number: sourceBars.length + 1,
      implicit: duration !== nominal
    });
    barStart += duration;
  }
  if (barStart < durationTicks) {
    throw new Error('That MIDI file contains too many bars to open safely.');
  }
  const sourceTempoChanges: NonNullable<InputNote['sourceTempoChanges']> = tempoChanges.map((change) => ({
    tick: change.tick,
    ppq,
    bpm: change.bpm
  }));
  const carriedTracks = new Set<number>();
  for (const note of notes) {
    const track = note.sourceTrackIndex ?? 0;
    if (carriedTracks.has(track)) continue;
    carriedTracks.add(track);
    note.sourceBars = sourceBars;
    note.sourceTempoChanges = sourceTempoChanges;
  }

  const counts = new Map<number, number>();
  for (const note of notes) {
    const track = note.sourceTrackIndex ?? 0;
    counts.set(track, (counts.get(track) ?? 0) + 1);
  }
  const tracks = [...counts]
    .map(([index, noteCount]) => ({
      index,
      name: trackNames.get(index) || `MIDI track ${index + 1}`,
      noteCount
    }))
    .sort((a, b) => a.index - b.index);

  return {
    notes,
    tracks,
    tempoBpm: 60_000_000 / firstTempoUs,
    timeSignature: firstTimeSig
      ? { numerator: firstTimeSig.numerator!, denominator: firstTimeSig.denominator! }
      : { numerator: 4, denominator: 4 },
    tempoChanges,
    timeSignatureChanges,
    durationSec: notes.reduce((largest, note) => Math.max(largest, note.endSec), 0),
    durationTicks,
    ppq
  };
}
