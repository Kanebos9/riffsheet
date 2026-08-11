import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { readMusicXml } from './xmlReader.js';
import { grid, playedNotes, settings } from './helpers.js';
import type { InputNote } from '../src/types.js';

/** Every one of these used to be a plausible crash. They are now pinned. */
describe('ROBUSTNESS — degenerate inputs must produce a valid score, not an exception', () => {
  const cases: { name: string; notes: InputNote[]; extra?: Record<string, unknown> }[] = [
    { name: 'no notes at all', notes: [] },
    { name: 'a single note', notes: [{ startSec: 0, endSec: 0.4, midi: 40 }] },
    { name: 'one very long held note', notes: [{ startSec: 0, endSec: 9.5, midi: 33 }] },
    {
      name: 'two notes at the same instant (a double-stop)',
      notes: [
        { startSec: 0, endSec: 0.4, midi: 40 },
        { startSec: 0.004, endSec: 0.4, midi: 47 }
      ]
    },
    {
      name: 'notes out of order in the input array',
      notes: [
        { startSec: 1.0, endSec: 1.4, midi: 43 },
        { startSec: 0.0, endSec: 0.4, midi: 40 },
        { startSec: 0.5, endSec: 0.9, midi: 41 }
      ]
    },
    {
      name: 'an unplayable pitch below the lowest string',
      notes: [
        { startSec: 0, endSec: 0.4, midi: 12 },
        { startSec: 0.5, endSec: 0.9, midi: 40 }
      ]
    },
    { name: 'everything before the first beat', notes: playedNotes([{ beat: -3, midi: 40 }, { beat: -2, midi: 43 }], 0.8) }
  ];

  for (const c of cases) {
    it(`${c.name}: builds, emits and re-reads`, () => {
      const r = buildScore({ notes: c.notes, ...grid(2), ...(c.extra ?? {}) }, settings());
      expect(r.ir.bars.length).toBeGreaterThan(0);
      const xml = r.toMusicXML();
      const read = readMusicXml(xml);
      read.measureLengths.forEach((m, i) => expect(m.length).toBe(r.ir.bars[i].durTicks));
      expect(r.toMidi(true).length).toBeGreaterThan(20);
      expect(r.toMidi(false).length).toBeGreaterThan(20);
      expect(() => JSON.stringify(r.toAlphaTabModelData())).not.toThrow();
    });
  }

  it('no beats and no bpmOverride still produces a 4/4 score at 120', () => {
    const r = buildScore({ notes: playedNotes([{ beat: 0, midi: 40 }, { beat: 1, midi: 43 }], 0.8) }, settings());
    expect(r.ir.tempo.displayBpm).toBe(120);
    expect(r.ir.tempo.synthesised).toBe(true);
    expect(r.toMusicXML()).toContain('<score-partwise');
  });

  it("grid 'free' produces a readable file with no musical grid imposed", () => {
    const notes = playedNotes(
      Array.from({ length: 8 }, (_, i) => ({ beat: i / 2 + (i % 3) * 0.037, midi: 40 })),
      0.62
    );
    const r = buildScore({ notes, ...grid(2) }, settings({ grid: 'free' }));
    expect(r.ir.quantized).toBe(false);
    const read = readMusicXml(r.toMusicXML());
    read.measureLengths.forEach((m, i) => expect(m.length).toBe(r.ir.bars[i].durTicks));
    for (const n of read.notes) if (!n.isRest) expect(n.type).not.toBe('');
  });

  it('a 5-string bass and a 6-string guitar both work end to end', () => {
    const bass5 = buildScore(
      { notes: playedNotes([{ beat: 0, midi: 23 }, { beat: 1, midi: 28 }, { beat: 2, midi: 33 }], 0.8), ...grid(2) },
      settings({ instrument: 'bass5', tuningMidi: [23, 28, 33, 38, 43] })
    );
    expect(bass5.ir.instrument.stringCount).toBe(5);
    expect(bass5.toMusicXML()).toContain('<staff-lines>5</staff-lines>');

    const gtr = buildScore(
      { notes: playedNotes([{ beat: 0, midi: 64 }, { beat: 1, midi: 67 }, { beat: 2, midi: 71 }], 0.8), ...grid(2) },
      settings({ instrument: 'guitar6', tuningMidi: [40, 45, 50, 55, 59, 64] })
    );
    expect(gtr.ir.bars[0].clef.sign).toBe('G');
    expect(gtr.toMusicXML()).toContain('<staff-lines>6</staff-lines>');
  });

  it('a wide universal profile becomes a real two-staff grand staff with no invented frets', () => {
    const universal = buildScore(
      {
        notes: playedNotes(
          [
            { beat: 0, midi: 36 },
            { beat: 1, midi: 60 },
            { beat: 2, midi: 76 }
          ],
          0.8
        ),
        ...grid(2)
      },
      settings({ instrument: 'staff', tuningMidi: [] })
    );

    expect(universal.ir.instrument.stringCount).toBe(0);
    expect(universal.ir.instrument.tuningMidi).toEqual([]);
    const universalNotes = universal.ir.bars.flatMap((bar) =>
      bar.voices[0].beats.flatMap((beat) => beat.notes)
    );
    expect(universalNotes.every((note) => note.string === undefined && note.fret === undefined)).toBe(true);

    const data = universal.toAlphaTabModelData();
    expect(data.tracks[0].name).toBe('Music');
    expect(data.tracks[0].program).toBe(0);
    expect(data.tracks[0].staves[0].showTablature).toBe(false);
    expect(data.tracks[0].staves[0].tuningsHighToLow).toEqual([]);
    expect(data.grandStaff).toBe(true);
    expect(data.tracks[0].staves).toHaveLength(2);
    expect(data.tracks[0].staves.map((staff) => staff.bars[0].clef)).toEqual(['G2', 'F4']);

    const xml = universal.toMusicXML();
    expect(xml).toContain('<staves>2</staves>');
    expect(xml).toContain('<clef number="1"><sign>G</sign><line>2</line></clef>');
    expect(xml).toContain('<clef number="2"><sign>F</sign><line>4</line></clef>');
    expect(xml).toContain('<staff>2</staff>');
    expect(readMusicXml(xml).notes.filter((note) => !note.isRest).length).toBeGreaterThan(0);
    expect(String.fromCharCode(...universal.toMidi(false).slice(0, 4))).toBe('MThd');
  });

  it('an imported grand staff keeps source staff placement instead of guessing by pitch', () => {
    const timing = { startTick: 0, endTick: 960, ppq: 960 };
    const built = buildScore(
      {
        notes: [
          { id: 'source-upper', startSec: 0, endSec: 0.5, midi: 55, sourceTiming: timing, sourceClef: 'treble', sourceStaffIndex: 0 },
          { id: 'source-lower', startSec: 0, endSec: 0.5, midi: 67, sourceTiming: timing, sourceClef: 'bass', sourceStaffIndex: 1 }
        ]
      },
      settings({ instrument: 'staff', tuningMidi: [] })
    );
    const data = built.toAlphaTabModelData();
    expect(data.tracks[0].staves).toHaveLength(2);
    const upperIds = data.tracks[0].staves[0].bars.flatMap((bar) => bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => note.id))));
    const lowerIds = data.tracks[0].staves[1].bars.flatMap((bar) => bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => note.id))));
    expect(upperIds).toContain('source-upper');
    expect(upperIds).not.toContain('source-lower');
    expect(lowerIds).toContain('source-lower');
    expect(lowerIds).not.toContain('source-upper');
    const xml = built.toMusicXML();
    expect(xml).toContain('<staves>2</staves>');
    expect(xml).toContain('<staff>1</staff>');
    expect(xml).toContain('<staff>2</staff>');
  });

  /**
   * THE TWO DEGENERATE GRAND-STAFF SHAPES.
   *
   * A grand staff is emitted by projecting the single voice onto two staves and then walking the
   * cursor back with a <backup>. Both halves of that are only exercised when both staves have
   * material, so the interesting cases are the ones where one of them has none: the projection
   * turns every beat into a rest, and the backup still has to be the distance staff 1 ACTUALLY
   * advanced. Get it wrong and `assertMeasureLength` throws — or worse, it does not, and the file
   * renders voice 2 in the wrong horizontal position while staying schema-valid. That is the
   * failure §G.4 exists to catch, so the balance check is the real assertion in both tests.
   */
  it('a grand staff whose upper staff is empty still balances both cursors', () => {
    const built = buildScore(
      {
        notes: [40, 43, 45, 47].map((midi, i) => ({
          id: `low${i}`,
          startSec: i * 0.5,
          endSec: i * 0.5 + 0.45,
          midi
        })),
        ...grid(2)
      },
      // Forced, not inferred: every pitch is below middle C, so nothing lands on staff 1.
      settings({ instrument: 'staff', tuningMidi: [], clefMode: 'grand' })
    );
    expect(built.ir.grandStaff).toBe(true);

    const data = built.toAlphaTabModelData();
    expect(data.tracks[0].staves).toHaveLength(2);
    const notesOn = (staff: number): unknown[] =>
      data.tracks[0].staves[staff].bars.flatMap((bar) =>
        bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes))
      );
    expect(notesOn(0)).toHaveLength(0);
    expect(notesOn(1).length).toBeGreaterThan(0);
    // The empty staff keeps its bars and its clef rather than collapsing away.
    expect(data.tracks[0].staves[0].bars).toHaveLength(built.ir.bars.length);
    expect(data.tracks[0].staves.map((staff) => staff.bars[0].clef)).toEqual(['G2', 'F4']);

    const xml = built.toMusicXML();
    expect(xml).toContain('<staves>2</staves>');
    const read = readMusicXml(xml);
    read.measureLengths.forEach((m, i) => expect(m.length).toBe(built.ir.bars[i].durTicks));
    // Staff 1 is present and entirely silent; staff 2 carries every pitch.
    expect(read.notes.filter((n) => n.staff === 1 && !n.isRest)).toHaveLength(0);
    expect(read.notes.filter((n) => n.staff === 2 && !n.isRest).length).toBeGreaterThan(0);
  });

  it('an empty document on a grand staff emits both staves as full-bar rests', () => {
    const built = buildScore(
      { notes: [], blankBars: 2 },
      settings({ instrument: 'staff', tuningMidi: [], clefMode: 'grand' })
    );
    expect(built.ir.bars.filter((bar) => !bar.implicit)).toHaveLength(2);
    expect(built.ir.stats.noteGlyphs).toBe(0);

    const data = built.toAlphaTabModelData();
    for (const staff of data.tracks[0].staves) {
      expect(staff.bars).toHaveLength(built.ir.bars.length);
      for (const bar of staff.bars) {
        for (const voice of bar.voices) for (const beat of voice.beats) expect(beat.isEmpty).toBe(true);
      }
    }

    const xml = built.toMusicXML();
    const read = readMusicXml(xml);
    read.measureLengths.forEach((m, i) => expect(m.length).toBe(built.ir.bars[i].durTicks));
    expect(read.notes.filter((n) => !n.isRest)).toHaveLength(0);
    expect(read.notes.length).toBeGreaterThan(0);
    // A blank document is still a valid MIDI file.
    expect(String.fromCharCode(...built.toMidi(false).slice(0, 4))).toBe('MThd');
  });

  /**
   * THE ACCEPTANCE CASE FOR THE DELETED REST KILLER.
   *
   * The complaint that killed it: a realistic take came back with long notes that ran over their
   * neighbours' attacks — sustain nobody played, invented by the engraver stretching each note
   * toward the next onset, which reads as polyphony on a monophonic line. The fixture is a
   * staccato riff at a hard 50% gate, so every played length lands exactly on the tick lattice
   * and "engine length" is a number, not a tolerance: an eighth-slot note sounds for 6 ticks at
   * divisions=24.
   *
   * WHAT ISSUE #31 CHANGED HERE, and it is a deliberate narrowing. This used to demand the engine
   * length on EVERY grid, which the old quantizer delivered by letting an off-time fall through
   * to a finer lattice than the onset — at `grid: '1/8'` a 6-tick note kept 6 ticks and printed
   * as a 32nd. That is how a take of repeated strikes came back as a row of eighth-note flags
   * under a quarter-note grid. A grid is a contract about the finest value the page may print,
   * so the claim is now the correct one:
   *
   *   - the played length is snapped to the grid step and to nothing else, so the most a note can
   *     gain is ONE step. Nothing walks toward the next onset, which is what the deleted
   *     lengthening pass did and is what this file exists to keep dead;
   *   - at `grid: 'free'` the step is a 1/32, so the engine length survives EXACTLY. That is the
   *     case the acceptance criterion actually named.
   */
  it('ACCEPTANCE: a staccato take gains at most one grid step, and nothing at all on free', () => {
    const positions = Array.from({ length: 32 }, (_, i) => ({
      beat: i / 2,
      midi: [40, 43, 45, 47, 45, 43][i % 6],
      lengthBeats: 0.5
    }));
    // 50% of a half-beat slot at 120 BPM = 62.5 ms = exactly 6 ticks at divisions 24.
    const notes = playedNotes(positions, 0.5);
    const PLAYED_TICKS = 6;
    /** The finest straight step each grid puts on offer, in ticks at divisions=24. */
    const STEP = { free: 3, auto: 6, '1/8': 12, '1/16': 6 } as const;

    for (const g of ['free', 'auto', '1/8', '1/16'] as const) {
      const step = STEP[g];
      const r = buildScore({ notes, ...grid(4) }, settings({ grid: g }));
      const written = new Map<string, number>();
      const occupied: { from: number; to: number; id: string }[] = [];
      for (const bar of r.ir.bars) {
        for (const beat of bar.voices[0].beats) {
          if (beat.isRest) continue;
          const from = bar.startTick + beat.startTick;
          for (const n of beat.notes) {
            written.set(n.id, (written.get(n.id) ?? 0) + beat.durTicks);
            occupied.push({ from, to: from + beat.durTicks, id: n.id });
          }
        }
      }
      expect(written.size, `grid ${g}: every note reaches the page`).toBe(notes.length);
      // The played length rounded onto this grid's step — never the next onset.
      const allowed = Math.max(step, Math.round(PLAYED_TICKS / step) * step);
      for (const [id, ticks] of written) {
        expect(ticks, `grid ${g}: ${id} was stretched past its snapped engine length`).toBeLessThanOrEqual(allowed);
        expect(ticks, `grid ${g}: ${id} was written shorter than one grid step`).toBeGreaterThanOrEqual(step);
      }
      occupied.sort((a, b) => a.from - b.from || a.to - b.to);
      for (let i = 1; i < occupied.length; i++) {
        expect(occupied[i - 1].to, `grid ${g}: ${occupied[i - 1].id} runs into ${occupied[i].id}`).toBeLessThanOrEqual(
          occupied[i].from
        );
      }
      expect(r.ir.stats.gapsAbsorbed, `grid ${g}`).toBe(0);
      // The silence reaches the page wherever the chosen grid is fine enough to show it. At
      // grid '1/8' the note and its slot are the same size, so there is no silence left to print
      // — that is the grid the caller asked for, not a gap that got absorbed.
      if (step < PLAYED_TICKS * 2) {
        expect(r.ir.stats.restGlyphs, `grid ${g}`).toBeGreaterThanOrEqual(notes.length - 1);
      } else {
        expect(r.ir.stats.restGlyphs, `grid ${g}`).toBe(0);
      }
    }
  });

  it('ACCEPTANCE: grid free writes the engine length exactly, to the 1/32', () => {
    const positions = Array.from({ length: 32 }, (_, i) => ({
      beat: i / 2,
      midi: [40, 43, 45, 47, 45, 43][i % 6],
      lengthBeats: 0.5
    }));
    const r = buildScore({ notes: playedNotes(positions, 0.5), ...grid(4) }, settings({ grid: 'free' }));
    const written = new Map<string, number>();
    for (const bar of r.ir.bars) {
      for (const beat of bar.voices[0].beats) {
        if (beat.isRest) continue;
        for (const n of beat.notes) written.set(n.id, (written.get(n.id) ?? 0) + beat.durTicks);
      }
    }
    expect(written.size).toBe(32);
    for (const [id, ticks] of written) expect(ticks, `${id} on free`).toBe(6);
  });

  it('ACCEPTANCE: the same holds across the whole stress corpus at grid free', async () => {
    const { SYNTHETIC_FIXTURES, SYNTHETIC_TUNING } = await import('../fixtures/synthetic.js');
    let checkedNotes = 0;
    for (const f of SYNTHETIC_FIXTURES) {
      const r = buildScore(
        { notes: f.notesRaw, beats: f.beats, downbeats: f.downbeats, audioDurationSec: f.audioDurationSec },
        settings({ grid: 'free', tuningMidi: SYNTHETIC_TUNING })
      );
      const secondsPerTick = 1 / ((r.ir.tempo.displayBpm / 60) * r.ir.divisions);
      const written = new Map<string, number>();
      const occupied: { from: number; to: number; id: string }[] = [];
      for (const bar of r.ir.bars) {
        for (const beat of bar.voices[0].beats) {
          if (beat.isRest) continue;
          const from = bar.startTick + beat.startTick;
          for (const n of beat.notes) {
            written.set(n.id, (written.get(n.id) ?? 0) + beat.durTicks);
            occupied.push({ from, to: from + beat.durTicks, id: n.id });
          }
        }
      }

      // 1. ENGINE LENGTHS ONLY. Nothing is written longer than it sounded, beyond the one tick
      //    of slack that rounding seconds onto the lattice can cost.
      f.notesRaw.forEach((note, i) => {
        const ticks = written.get(`n${i}`);
        if (ticks === undefined) return;
        expect(ticks * secondsPerTick, `${f.id} n${i} written longer than played`).toBeLessThan(
          note.endSec - note.startSec + 2 * secondsPerTick
        );
        checkedNotes++;
      });

      // 2. NO FAKE POLYPHONY. Sort the written spans and check none overlaps the next.
      occupied.sort((a, b) => a.from - b.from || a.to - b.to);
      for (let i = 1; i < occupied.length; i++) {
        if (occupied[i].from === occupied[i - 1].from) continue; // a real chord, one IRBeat
        expect(occupied[i - 1].to, `${f.id}: ${occupied[i - 1].id} runs into ${occupied[i].id}`).toBeLessThanOrEqual(
          occupied[i].from
        );
      }

      // 3. And nothing was absorbed on the way.
      expect(r.ir.stats.gapsAbsorbed, f.id).toBe(0);
    }
    expect(checkedNotes).toBeGreaterThan(700);
  });

  it('every synthetic stress phrase survives all four grid settings without throwing', async () => {
    const { SYNTHETIC_FIXTURES, SYNTHETIC_TUNING } = await import('../fixtures/synthetic.js');
    for (const f of SYNTHETIC_FIXTURES.slice(0, 4)) {
      for (const g of ['auto', '1/8', '1/16', 'free'] as const) {
        for (const fill of [true, false]) {
          const r = buildScore(
            { notes: f.notes, beats: f.beats, downbeats: f.downbeats, audioDurationSec: f.audioDurationSec },
            settings({ grid: g, fillGaps: fill, tuningMidi: SYNTHETIC_TUNING })
          );
          const read = readMusicXml(r.toMusicXML());
          read.measureLengths.forEach((m, i) => expect(m.length).toBe(r.ir.bars[i].durTicks));
        }
      }
    }
  });
});
