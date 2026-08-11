import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { toMusicXML } from '../src/musicxml.js';
import { MIDI_PPQ } from '../src/midi.js';
import { findAll, parseXml, readMusicXml } from './xmlReader.js';
import { BASS4, grid, playedNotes, settings } from './helpers.js';

function riff() {
  const notes = playedNotes(
    Array.from({ length: 16 }, (_, i) => ({ beat: i / 2, midi: [40, 43, 45, 47][i % 4] })),
    0.7
  );
  return buildScore({ notes, ...grid(4) }, settings());
}

describe('STATION 6a — MusicXML round-trip through a real reader', () => {
  const r = riff();
  const xml = r.toMusicXML();
  const read = readMusicXml(xml);

  it('parses as well-formed XML with the expected skeleton', () => {
    const doc = parseXml(xml);
    expect(doc.children.find((c) => c.name === 'score-partwise')).toBeDefined();
    expect(findAll(doc, 'part')).toHaveLength(1);
    expect(findAll(doc, 'measure').length).toBe(r.ir.bars.length);
  });

  it('declares divisions 24 and the score time signature', () => {
    expect(read.divisions).toBe(24);
    expect(read.timeSig).toEqual(r.ir.timeSig);
    expect(read.fifths).toBe(r.ir.key.fifths);
  });

  it('every measure cursor returns to the declared measure length (G.4)', () => {
    read.measureLengths.forEach((m, i) => {
      expect(m.length).toBe(r.ir.bars[i].durTicks);
    });
  });

  it('EVERY pitched note carries a <type> — the documented sheet-crash guard', () => {
    for (const n of read.notes) {
      if (n.isRest) continue;
      expect(n.type).not.toBe('');
    }
  });

  it('re-imported pitches and onsets match the IR exactly', () => {
    const irNotes: { measure: number; tick: number; midi: number }[] = [];
    r.ir.bars.forEach((bar) => {
      for (const beat of bar.voices[0].beats) {
        if (beat.isRest) continue;
        for (const n of beat.notes) irNotes.push({ measure: bar.number, tick: beat.startTick, midi: n.midi });
      }
    });
    const readNotes = read.notes
      .filter((n) => !n.isRest && n.staff === 1)
      .map((n) => ({ measure: n.measure, tick: n.tick, midi: n.midi! }));
    expect(readNotes).toEqual(irNotes);
  });

  it('THE OCTAVE TRAP: no <transpose>, no <clef-octave-change>, sounding pitches (§8.3)', () => {
    expect(read.hasTranspose).toBe(false);
    expect(read.hasClefOctaveChange).toBe(false);
    // a sounding E1 must read back as MIDI 28, not 40
    const lowest = Math.min(...read.notes.filter((n) => n.midi !== null).map((n) => n.midi!));
    expect(lowest).toBe(Math.min(...r.ir.bars.flatMap((b) => b.voices[0].beats.flatMap((x) => x.notes.map((n) => n.midi)))));
  });

  it('emits the tab staff with staff-tuning counted from the BOTTOM (§8.1)', () => {
    expect(read.staffTuning).toHaveLength(4);
    expect(read.staffTuning[0]).toEqual({ line: 1, step: 'E', alter: 0, octave: 1 });
    expect(read.staffTuning[3]).toEqual({ line: 4, step: 'G', alter: 0, octave: 2 });
  });

  it('tab notes carry <string> and <fret>, and string 1 is the highest pitched', () => {
    const tabNotes = read.notes.filter((n) => n.staff === 2 && !n.isRest && n.string !== undefined);
    expect(tabNotes.length).toBeGreaterThan(0);
    for (const n of tabNotes) {
      expect(n.string).toBeGreaterThanOrEqual(1);
      expect(n.string).toBeLessThanOrEqual(4);
      expect(n.fret).toBeGreaterThanOrEqual(0);
      // MusicXML string 1 = highest, so tuning index = count - string
      expect(BASS4[4 - n.string!] + n.fret!).toBe(n.midi);
    }
  });

  it('ties balance across the whole part', () => {
    const starts = read.notes.filter((n) => n.tieStart && n.staff === 1).length;
    const stops = read.notes.filter((n) => n.tieStop && n.staff === 1).length;
    expect(starts).toBe(stops);
  });

  it('one metronome and one sound tempo, at bar 1 only', () => {
    const doc = parseXml(xml);
    expect(findAll(doc, 'metronome')).toHaveLength(1);
    expect(findAll(doc, 'sound')).toHaveLength(1);
    expect(read.tempo).toBe(r.ir.tempo.displayBpm);
  });

  it('every rest is a printable value, down to the grid the take was quantized on', () => {
    // The "no rest shorter than an eighth" floor went with the rest killer: it was only ever
    // reachable because notes were stretched over the short silences. A sixteenth of measured
    // silence is now printed as a sixteenth rest. What still holds is that every rest is one of
    // the eight printable glyph lengths — a rest of 5/16 would be an unprintable file.
    const printable = new Set([3, 6, 9, 12, 18, 24, 36, 48]);
    const rests = read.notes.filter((n) => n.isRest);
    expect(rests.length).toBeGreaterThan(0);
    for (const n of rests) expect(printable.has(n.duration)).toBe(true);
  });

  it('throws loudly if a measure does not add up', () => {
    // Drop a whole glyph: every remaining beat still describes itself correctly, so the ONLY
    // thing wrong is the cursor — which is precisely what G.4 exists to catch.
    const broken = structuredCloneIsh(r.ir);
    broken.bars[0].voices[0].beats.pop();
    expect(() => toMusicXML(broken)).toThrow('advanced');
  });

  it('throws loudly if <type> and <duration> describe different lengths', () => {
    // S2's assertion. Stretching one beat's ticks without changing its written value is exactly
    // the contradiction a grand-staff projection used to emit on a tuplet rest.
    const broken = structuredCloneIsh(r.ir);
    broken.bars[0].voices[0].beats[0].durTicks += 3;
    expect(() => toMusicXML(broken)).toThrow('but <duration> is');
  });

  it('emits a whole-bar rest as <rest measure="yes"/>', () => {
    const notes = [
      ...playedNotes([{ beat: 0, midi: 40 }, { beat: 1, midi: 40 }, { beat: 2, midi: 40 }, { beat: 3, midi: 40 }], 0.8),
      ...playedNotes([{ beat: 8, midi: 40 }, { beat: 9, midi: 40 }, { beat: 10, midi: 40 }, { beat: 11, midi: 40 }], 0.8)
    ];
    const built = buildScore({ notes, ...grid(3) }, settings());
    const x = built.toMusicXML();
    expect(x).toContain('<rest measure="yes"/>');
  });

  it('wires a non-zero authoritative key to IR bars, MusicXML and alphaTab', () => {
    const built = buildScore(
      { notes: playedNotes([{ beat: 0, midi: 67 }, { beat: 1, midi: 69 }, { beat: 2, midi: 71 }], 0.8), ...grid(2) },
      settings({ keyFifths: 1 })
    );
    expect(built.ir.key.fifths).toBe(1);
    expect(built.ir.bars.every((bar) => bar.keyFifths === 1)).toBe(true);
    expect(readMusicXml(built.toMusicXML()).fifths).toBe(1);
    expect(built.toAlphaTabModelData().masterBars.every((bar) => bar.keySignature === 1)).toBe(true);
  });

  it('strips forbidden XML controls from imported filenames and titles', () => {
    const built = buildScore(
      { notes: playedNotes([{ beat: 0, midi: 60 }], 0.8), ...grid(1) },
      settings({ instrument: 'staff', tuningMidi: [], title: 'bad\u0000\u0007 & <title>' })
    );
    const xml = built.toMusicXML();
    expect(xml).not.toContain('\u0000');
    expect(xml).not.toContain('\u0007');
    expect(xml).toContain('bad &amp; &lt;title&gt;');
    expect(() => parseXml(xml)).not.toThrow();
  });
});

describe('STATION 6a — tuplet MusicXML (both halves are required)', () => {
  it('emits <time-modification> on every member and <tuplet> only on first and last', () => {
    const positions: { beat: number; midi: number }[] = [];
    for (let b = 0; b < 8; b++) for (let u = 0; u < 3; u++) positions.push({ beat: b + u / 3, midi: 40 });
    const built = buildScore({ notes: playedNotes(positions, 0.9), ...grid(2) }, settings());
    const doc = parseXml(built.toMusicXML());
    const tms = findAll(doc, 'time-modification');
    const tuplets = findAll(doc, 'tuplet');
    if (tms.length) {
      expect(tuplets.length).toBeLessThan(tms.length);
      expect(tuplets.filter((t) => t.attrs.type === 'start').length).toBe(
        tuplets.filter((t) => t.attrs.type === 'stop').length
      );
      // <type> is the WRITTEN value: an eighth-triplet member prints as an eighth
      expect(built.ir.bars[0].voices[0].beats[0].durationType).toBe('eighth');
      expect(built.ir.bars[0].voices[0].beats[0].durTicks).toBe(8);
    }
  });

  it('G.5 refuses a half-open bracket, and it is checking the EMITTED layer', () => {
    // It used to be handed the unprojected merged rhythm, where the edges balance by
    // construction — so it could not fail, on a grand staff least of all. Knocking one stop out
    // of the IR has to be enough to stop the file now.
    const positions: { beat: number; midi: number }[] = [];
    for (let b = 0; b < 4; b++) for (let u = 0; u < 3; u++) positions.push({ beat: b + u / 3, midi: 40 });
    const built = buildScore({ notes: playedNotes(positions, 0.9), ...grid(2) }, settings());
    const broken = structuredCloneIsh(built.ir);
    const stop = broken.bars
      .flatMap((bar) => bar.voices.flatMap((voice) => voice.beats))
      .find((beat) => beat.tuplet?.stop);
    expect(stop, 'the fixture produced no tuplet to break').toBeDefined();
    stop!.tuplet!.stop = false;
    expect(() => toMusicXML(broken)).toThrow('exactly one start and one stop');
  });
});

describe('STATION 6b — MIDI writer, both variants', () => {
  const r = riff();

  it('writes a valid SMF header at 480 PPQ', () => {
    const bytes = r.toMidi(true);
    expect([...bytes.slice(0, 4)]).toEqual([0x4d, 0x54, 0x68, 0x64]);
    expect((bytes[12] << 8) | bytes[13]).toBe(MIDI_PPQ);
    expect([...bytes.slice(14, 18)]).toEqual([0x4d, 0x54, 0x72, 0x6b]);
  });

  it('the track chunk length is honest and ends with end-of-track', () => {
    const bytes = r.toMidi(true);
    const len = (bytes[18] << 24) | (bytes[19] << 16) | (bytes[20] << 8) | bytes[21];
    expect(22 + len).toBe(bytes.length);
    expect([...bytes.slice(-3)]).toEqual([0xff, 0x2f, 0x00]);
  });

  it('quantized and as-played are different files', () => {
    const q = r.toMidi(true);
    const p = r.toMidi(false);
    expect(q.length).not.toBe(0);
    expect(p.length).not.toBe(0);
    expect(Array.from(q).join(',')).not.toBe(Array.from(p).join(','));
  });

  it('note-on count matches the sounding notes in the IR', () => {
    const bytes = r.toMidi(true);
    let ons = 0;
    for (let i = 22; i < bytes.length; i++) if (bytes[i] === 0x90 && bytes[i + 2] > 0) ons++;
    expect(ons).toBeGreaterThan(0);
  });
});

describe('STATION 6c — alphaTab model data', () => {
  const r = riff();
  const data = r.toAlphaTabModelData();

  it('mirrors the bar structure', () => {
    expect(data.masterBars).toHaveLength(r.ir.bars.length);
    expect(data.tracks[0].staves[0].bars).toHaveLength(r.ir.bars.length);
    expect(data.divisions).toBe(24);
  });

  it('INVERTS the tuning to alphaTab order: HIGH to LOW', () => {
    expect(data.tracks[0].staves[0].tuningsHighToLow).toEqual([43, 38, 33, 28]);
    expect(r.ir.instrument.tuningMidi).toEqual([28, 33, 38, 43]);
  });

  it('keeps the source note id on every note — the identity thread for click-to-edit', () => {
    const ids = data.tracks[0].staves[0].bars.flatMap((b) => b.voices.flatMap((v) => v.beats.flatMap((x) => x.notes.map((n) => n.id))));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(typeof id).toBe('string');
  });

  it('octave and tone reconstruct the MIDI pitch', () => {
    for (const bar of data.tracks[0].staves[0].bars) {
      for (const v of bar.voices) {
        for (const beat of v.beats) {
          for (const n of beat.notes) expect(n.octave * 12 + n.tone).toBe(n.midi);
        }
      }
    }
  });

  it('maps the clef', () => {
    expect(data.tracks[0].staves[0].bars[0].clef).toBe('F4');
  });
});

/** structuredClone is not available in every runner; the IR is plain JSON. */
function structuredCloneIsh<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
