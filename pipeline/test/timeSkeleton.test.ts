import { describe, it, expect } from 'vitest';
import { buildTimeSkeleton, compoundEvidence, DOWNBEAT_ANTICIPATION_SEC } from '../src/timeSkeleton.js';
import { buildScore } from '../src/buildScore.js';
import { BASS4, grid, input, playedNotes, settings } from './helpers.js';
import type { InputNote } from '../src/types.js';

describe('STATION 1 — seconds to beats by interpolation, not by a global tempo', () => {
  it('interpolates linearly between supplied beats and extrapolates past both ends', () => {
    // A deliberately uneven grid: a global BPM cannot describe this.
    const beats = [0, 0.5, 1.0, 1.8, 2.6, 3.4];
    const s = buildTimeSkeleton(
      { notes: [{ startSec: 0, endSec: 3.4, midi: 40 }], beats, downbeats: [0] },
      settings()
    );
    expect(s.secondsToBeatIdx(0)).toBeCloseTo(s.secondsToBeatIdx(0), 6);
    // beat 2 sits at 1.0s and beat 3 at 1.8s, so 1.4s is exactly halfway between them
    const b2 = s.secondsToBeatIdx(1.0);
    const b3 = s.secondsToBeatIdx(1.8);
    expect(s.secondsToBeatIdx(1.4)).toBeCloseTo((b2 + b3) / 2, 6);
    expect(b3 - b2).toBeCloseTo(1, 9);
    // before the first supplied beat: extrapolated with the first inter-beat interval
    expect(s.secondsToBeatIdx(-0.25)).toBeCloseTo(s.secondsToBeatIdx(0) - 0.5, 6);
  });

  it('rebuilds ticks from each bar OWN downbeat — no global-tempo accumulation', () => {
    // Bars 1 and 2 at 120 BPM, bar 3 suddenly at 60 BPM. A constant-tempo quantizer drifts a
    // whole bar by the end; per-bar origin does not.
    const beats = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 7.0, 8.0];
    const downbeats = [0, 2.0, 4.0, 8.0];
    const s = buildTimeSkeleton(
      { notes: [{ startSec: 0, endSec: 7.9, midi: 40 }], beats, downbeats },
      settings()
    );
    expect(s.bars.length).toBeGreaterThanOrEqual(3);
    // the downbeat of bar 3 is at 4.0 s and must land exactly on its bar's start tick
    const bar3 = s.bars.find((b) => !b.implicit && b.number === 3)!;
    expect(s.secondsToTick(4.0)).toBeCloseTo(bar3.startTick, 6);
    // and the note halfway through bar 3 (a slow bar) lands on beat 3 of that bar, not beat 5
    expect(s.secondsToTick(6.0)).toBeCloseTo(bar3.startTick + 2 * s.ticksPerBeat, 6);
  });

  it('24 ticks per simple beat, 96 per 4/4 bar', () => {
    const s = buildTimeSkeleton({ notes: [{ startSec: 0, endSec: 2, midi: 40 }], ...grid(2) }, settings());
    expect(s.divisions).toBe(24);
    expect(s.ticksPerBeat).toBe(24);
    expect(s.bars[0].ticks).toBe(96);
  });

  it('36 ticks per compound beat when 6/8 is manually overridden', () => {
    const g = grid(4, 2, 80); // two dotted-quarter pulses per bar
    const s = buildTimeSkeleton(
      { notes: [{ startSec: 0, endSec: 5, midi: 40 }], ...g },
      settings({ timeSigOverride: [6, 8] })
    );
    expect(s.compound).toBe(true);
    expect(s.ticksPerBeat).toBe(36);
    expect(s.beatUnit.toString()).toBe('3/8');
    expect(s.bars[0].ticks).toBe(72); // a 6/8 bar is three quarters = 72 ticks
  });

  it('display BPM is 60 / median inter-beat interval, rounded', () => {
    const s = buildTimeSkeleton({ notes: [{ startSec: 0, endSec: 4, midi: 40 }], ...grid(2, 4, 132) }, settings());
    expect(s.displayBpm).toBe(132);
  });

  it('tolerates a downbeat that anticipates its beat by up to 50 ms', () => {
    const g = grid(4);
    const nudged = g.downbeats.map((d, i) => (i === 2 ? d - 0.04 : d));
    const s = buildTimeSkeleton(
      { notes: [{ startSec: 0, endSec: 8, midi: 40 }], beats: g.beats, downbeats: nudged },
      settings()
    );
    expect(DOWNBEAT_ANTICIPATION_SEC).toBe(0.05);
    // all four bars are still four beats long: the early downbeat was absorbed
    for (const b of s.bars.filter((x) => !x.implicit)) expect(b.beats).toBe(4);
  });
});

describe('STATION 1 — time signature', () => {
  it('defaults to 4/4 (94% of pop is 4/4; a detector must beat that to break even)', () => {
    const s = buildTimeSkeleton({ notes: [{ startSec: 0, endSec: 4, midi: 40 }], ...grid(2) }, settings());
    expect(s.timeSig).toEqual([4, 4]);
  });

  it('accepts 3/4 only when all four gates pass', () => {
    const s = buildTimeSkeleton({ notes: [{ startSec: 0, endSec: 12, midi: 40 }], ...grid(6, 3) }, settings());
    expect(s.timeSig).toEqual([3, 4]);
    expect(s.meterReason).toContain('mode 3');
  });

  it('keeps the 4/4 prior when there are too few bars', () => {
    const s = buildTimeSkeleton({ notes: [{ startSec: 0, endSec: 4, midi: 40 }], ...grid(2, 3) }, settings());
    expect(s.timeSig).toEqual([4, 4]);
    expect(s.meterReason).toContain('complete bars');
  });

  it('NEVER auto-selects 6/8 — including 6 makes rock get misclassified', () => {
    const s = buildTimeSkeleton({ notes: [{ startSec: 0, endSec: 20, midi: 40 }], ...grid(8, 6) }, settings());
    expect(s.timeSig).not.toEqual([6, 8]);
    expect(s.timeSig).toEqual([4, 4]);
  });

  it('exposes 3/4-vs-6/8 subdivision evidence as a hint without acting on it', () => {
    const g = grid(8, 3, 120);
    const notes = playedNotes(
      Array.from({ length: 24 }, (_, i) => ({ beat: i / 3, midi: 40 })), // thirds of the beat
      0.8
    );
    const s = buildTimeSkeleton({ notes, ...g }, settings());
    const ev = compoundEvidence(notes.map((n) => n.startSec), s);
    expect(ev.compoundMass).toBeGreaterThan(ev.simpleMass);
    expect(ev.suggests).toBe('compound');
    expect(s.timeSig).toEqual([3, 4]); // still not 6/8 automatically
  });
});

describe('STATION 1 — no beats supplied', () => {
  it('synthesises a uniform grid from bpmOverride', () => {
    const notes = playedNotes([{ beat: 0, midi: 40 }, { beat: 1, midi: 43 }, { beat: 2, midi: 45 }], 0.8, 100);
    const s = buildTimeSkeleton({ notes }, settings({ bpmOverride: 100 }));
    expect(s.synthesised).toBe(true);
    expect(s.displayBpm).toBe(100);
    expect(s.timeSig).toEqual([4, 4]);
  });

  it('falls back to 120 BPM with neither beats nor an override', () => {
    const notes = playedNotes([{ beat: 0, midi: 40 }, { beat: 1, midi: 43 }], 0.8);
    const s = buildTimeSkeleton({ notes }, settings());
    expect(s.synthesised).toBe(true);
    expect(s.displayBpm).toBe(120);
  });

  it('an empty document keeps the requested number of full-rest bars', () => {
    const skeleton = buildTimeSkeleton({ notes: [], blankBars: 8 }, settings());
    expect(skeleton.bars).toHaveLength(8);
    const built = buildScore({ notes: [], blankBars: 8 }, settings({ instrument: 'staff', tuningMidi: [] }));
    expect(built.ir.bars).toHaveLength(8);
    expect(built.ir.bars.every((bar) => bar.voices[0].beats.length === 1 && bar.voices[0].beats[0].measureRest)).toBe(true);
  });
});

/**
 * MINIMUM DOCUMENT LENGTH (Codex point 4, the bar-ops prerequisite).
 *
 * `blankBars` used to extend the document only while it held exactly zero notes, so the eight bars
 * a user asked for collapsed to one the moment a note was placed and grew back when it was deleted
 * — a length that was a function of the contents. Bar operations need the reverse: a floor the
 * caller owns, which content is written into and deleted out of without the page reflowing.
 */
describe('STATION 1 — minimumBars is a floor, not a blank-document special case', () => {
  const STAFF = { instrument: 'staff' as const, tuningMidi: [] };
  const printed = (bars: { implicit: boolean }[]): number => bars.filter((bar) => !bar.implicit).length;

  it('a blank document still gets exactly the bars it asked for', () => {
    const skeleton = buildTimeSkeleton({ notes: [], minimumBars: 8 }, settings());
    expect(skeleton.bars).toHaveLength(8);
    expect(skeleton.minimumBars).toBe(8);
  });

  it('placing the first note does not collapse the document', () => {
    const note: InputNote[] = [{ id: 'n0', startSec: 0, endSec: 0.4, midi: 40 }];
    const before = buildScore({ notes: [], minimumBars: 8 }, settings(STAFF));
    const after = buildScore({ notes: note, minimumBars: 8, ...grid(1) }, settings(STAFF));
    expect(printed(before.ir.bars)).toBe(8);
    expect(printed(after.ir.bars)).toBe(8);
    // ...and the note is really in it, in bar 1, with the other seven bars still full-bar rests.
    const ids = after.ir.bars.flatMap((bar) => bar.voices[0].beats.flatMap((beat) => beat.notes.map((n) => n.id)));
    expect(ids).toEqual(['n0']);
    expect(after.ir.bars.slice(1).every((bar) => bar.voices[0].beats[0].measureRest)).toBe(true);
  });

  it('deleting the trailing content does not shorten it below the minimum', () => {
    const notes = playedNotes([{ beat: 0, midi: 40 }, { beat: 12, midi: 43 }], 0.8);
    const full = buildScore(input(notes, grid(4), { minimumBars: 8 }), settings(STAFF));
    const trimmed = buildScore(input(notes.slice(0, 1), grid(4), { minimumBars: 8 }), settings(STAFF));
    expect(printed(full.ir.bars)).toBe(8);
    expect(printed(trimmed.ir.bars)).toBe(8);
  });

  it('never shortens a document that is already longer than the minimum', () => {
    const notes = playedNotes([{ beat: 0, midi: 40 }, { beat: 12, midi: 43 }], 0.8);
    const built = buildScore(input(notes, grid(4), { minimumBars: 2 }), settings(STAFF));
    expect(printed(built.ir.bars)).toBe(4);
    expect(built.skeleton.minimumBars).toBe(2);
  });

  it('bars added by the floor are ordinary bars: numbered, metered and tick-contiguous', () => {
    const notes = playedNotes([{ beat: 0, midi: 40 }], 0.8);
    const built = buildScore(input(notes, grid(1), { minimumBars: 5 }), settings(STAFF));
    expect(built.ir.bars.map((bar) => bar.number)).toEqual([1, 2, 3, 4, 5]);
    let tick = 0;
    for (const bar of built.ir.bars) {
      expect(bar.startTick).toBe(tick);
      expect(bar.timeSig).toEqual([4, 4]);
      tick += bar.durTicks;
    }
    expect(built.skeleton.totalTicks).toBe(tick);
    // A bar the floor added still has a real downbeat time, so the roll can draw its barline.
    expect(built.ir.tempo.downbeatTimesSec).toHaveLength(5);
    for (let i = 1; i < built.ir.tempo.downbeatTimesSec.length; i++) {
      expect(built.ir.tempo.downbeatTimesSec[i]).toBeGreaterThan(built.ir.tempo.downbeatTimesSec[i - 1]);
    }
  });

  it('a pickup measure does not count towards the minimum', () => {
    const notes = playedNotes([{ beat: 0, midi: 40 }, { beat: 1, midi: 43 }], 0.8, 120, 0.5);
    const built = buildScore(
      input(notes, grid(2), { startOffsetSec: 1.0, minimumBars: 3 }),
      settings(STAFF)
    );
    expect(built.ir.bars.some((bar) => bar.implicit)).toBe(true);
    expect(printed(built.ir.bars)).toBe(3);
  });

  it('a symbolic import inside a document keeps the document its length', () => {
    const sourceBars: NonNullable<InputNote['sourceBars']> = [
      { startTick: 0, durationTicks: 1920, ppq: 480, timeSig: [4, 4], number: 1, implicit: false }
    ];
    const notes: InputNote[] = [
      {
        id: 's0',
        startSec: 0,
        endSec: 0.5,
        midi: 60,
        sourceTiming: { startTick: 0, endTick: 480, ppq: 480 },
        sourceBars
      }
    ];
    const built = buildScore({ notes, minimumBars: 6 }, settings(STAFF));
    expect(printed(built.ir.bars)).toBe(6);
    expect(built.skeleton.symbolic).toBe(true);
  });

  it('minimumBars wins over the deprecated blankBars, and both are clamped the same way', () => {
    expect(buildTimeSkeleton({ notes: [], minimumBars: 3, blankBars: 9 }, settings()).bars).toHaveLength(3);
    expect(buildTimeSkeleton({ notes: [], minimumBars: 0 }, settings()).minimumBars).toBe(1);
    expect(buildTimeSkeleton({ notes: [], minimumBars: 9999 }, settings()).minimumBars).toBe(256);
    expect(buildTimeSkeleton({ notes: [], minimumBars: 2.6 }, settings()).bars).toHaveLength(3);
    expect(buildTimeSkeleton({ notes: [] }, settings()).minimumBars).toBe(0);
    expect(buildTimeSkeleton({ notes: [], minimumBars: Number.NaN }, settings()).minimumBars).toBe(0);
  });

  it('keeps a short last onset that quantizes forward onto the final barline', () => {
    const notes = [{ id: 'last', startSec: 7.96, endSec: 8.0, midi: 60 }];
    const built = buildScore({ notes, ...grid(4), audioDurationSec: 8.01 }, settings({ instrument: 'staff', tuningMidi: [] }));
    const ids = built.ir.bars.flatMap((bar) => bar.voices[0].beats.flatMap((beat) => beat.notes.map((note) => note.id)));
    expect(ids).toContain('last');
    expect(built.ir.bars).toHaveLength(5);
  });

  it('symbolic ticks bypass audio quantization and retain authoritative source clefs', () => {
    const sourceBars: NonNullable<InputNote['sourceBars']> = [
      { startTick: 0, durationTicks: 3840, ppq: 960, timeSig: [4, 4], number: 1, implicit: false },
      { startTick: 3840, durationTicks: 2880, ppq: 960, timeSig: [3, 4], number: 2, implicit: false }
    ];
    const notes: InputNote[] = [
      {
        id: 'upper', startSec: 0, endSec: 0.125, midi: 72,
        sourceTiming: { startTick: 0, endTick: 240, ppq: 960 }, sourceClef: 'treble',
        sourceBars,
        sourceTempoChanges: [{ tick: 0, ppq: 960, bpm: 120 }, { tick: 3840, ppq: 960, bpm: 90 }]
      },
      {
        id: 'lower', startSec: 2, endSec: 2.5, midi: 48,
        sourceTiming: { startTick: 3840, endTick: 4800, ppq: 960 }, sourceClef: 'bass' as const
      }
    ];
    const built = buildScore({ notes }, settings({ instrument: 'staff', tuningMidi: [], bpmOverride: 120 }));
    expect(built.ir.quantized).toBe(false);
    const upperBeat = built.ir.bars[0].voices[0].beats.find((beat) => beat.notes.some((note) => note.id === 'upper'))!;
    expect(upperBeat.durTicks).toBe(6);
    expect(built.ir.bars[0].clef.sign).toBe('G');
    expect(built.ir.bars[1].clef.sign).toBe('F');
    expect(built.ir.bars[1].clef.changed).toBe(true);
    expect(built.ir.bars.map((bar) => bar.timeSig)).toEqual([[4, 4], [3, 4]]);
    expect(built.ir.tempo.changes).toEqual([{ tick: 0, bpm: 120 }, { tick: 96, bpm: 90 }]);
    expect(built.toAlphaTabModelData().tempoChanges).toEqual([{ tick: 0, bpm: 120 }, { tick: 96, bpm: 90 }]);
    expect(built.toMusicXML()).toContain('<per-minute>90</per-minute>');
  });
});

describe('STATION 1 — externalGrid (host DAW grid, authoritative)', () => {
  it('skips beat detection entirely and uses the host numbers', () => {
    const notes = playedNotes([{ beat: 0, midi: 40 }, { beat: 1, midi: 43 }, { beat: 2, midi: 45 }, { beat: 3, midi: 47 }], 0.75, 90);
    const s = buildTimeSkeleton(
      {
        notes,
        // deliberately WRONG detected beats, to prove they are ignored
        beats: [0, 0.31, 0.62, 0.93, 1.24],
        downbeats: [0, 1.24],
        externalGrid: { bpm: 90, timeSig: [4, 4] }
      },
      settings()
    );
    expect(s.external).toBe(true);
    expect(s.displayBpm).toBe(90);
    expect(s.timeSig).toEqual([4, 4]);
    expect(s.meterReason).toContain('external grid');
    // one beat is 60/90 s; the second note sits exactly on beat 2 of bar 1
    expect(s.secondsToTick(60 / 90)).toBeCloseTo(24, 6);
  });

  it('honours a piecewise-constant tempo map', () => {
    const s = buildTimeSkeleton(
      {
        notes: [{ startSec: 0, endSec: 6, midi: 40 }],
        externalGrid: { bpm: 120, timeSig: [4, 4], tempoChanges: [{ atSec: 2, bpm: 60 }] }
      },
      settings()
    );
    // 0..2 s at 120 BPM is four beats; then beats last 1 s each
    expect(s.secondsToTick(2.0)).toBeCloseTo(96, 4);
    expect(s.secondsToTick(3.0)).toBeCloseTo(120, 4);
  });

  it('takes explicit bar starts verbatim', () => {
    const s = buildTimeSkeleton(
      {
        notes: [{ startSec: 0, endSec: 7, midi: 40 }],
        externalGrid: { bpm: 120, timeSig: [4, 4], barStartsSec: [0, 2, 4, 6] }
      },
      settings()
    );
    const real = s.bars.filter((b) => !b.implicit);
    expect(real.length).toBeGreaterThanOrEqual(3);
    expect(s.secondsToTick(4)).toBeCloseTo(real[2].startTick, 6);
  });

  it('derives a dotted pulse for a compound external grid (bpm counts quarters)', () => {
    const s = buildTimeSkeleton(
      { notes: [{ startSec: 0, endSec: 4, midi: 40 }], externalGrid: { bpm: 120, timeSig: [6, 8] } },
      settings()
    );
    expect(s.compound).toBe(true);
    expect(s.ticksPerBeat).toBe(36);
    // one dotted-quarter beat at 120 quarter-BPM is 0.75 s
    expect(s.beatTimesSec[s.originBeatIdx + 1] - s.beatTimesSec[s.originBeatIdx]).toBeCloseTo(0.75, 6);
  });
});

describe('STATION 1 — startOffsetSec anchors bar 1', () => {
  it('material inside a beat before the origin becomes an anacrusis', () => {
    // Origin at 2.0 s; one pickup note a half-beat earlier.
    const notes = [
      { id: 'p', startSec: 1.75, endSec: 1.95, midi: 43 },
      { id: 'a', startSec: 2.0, endSec: 2.45, midi: 40 },
      { id: 'b', startSec: 2.5, endSec: 2.95, midi: 40 },
      { id: 'c', startSec: 3.0, endSec: 3.45, midi: 40 },
      { id: 'd', startSec: 3.5, endSec: 3.95, midi: 40 }
    ];
    const s = buildTimeSkeleton({ notes, ...grid(6, 4, 120), startOffsetSec: 2.0 }, settings());
    const pickup = s.bars.filter((b) => b.implicit);
    expect(pickup.length).toBe(1);
    expect(pickup[0].number).toBe(0);
    expect(pickup[0].ticks).toBe(24); // one beat
    // bar 1 starts exactly at the declared origin
    const bar1 = s.bars.find((b) => !b.implicit)!;
    expect(s.secondsToTick(2.0)).toBeCloseTo(bar1.startTick, 6);
  });

  it('never re-phases away from a declared origin, and keeps everything before it', () => {
    // Two full bars of material before the declared origin: leading rests are fine.
    const notes = playedNotes(
      Array.from({ length: 16 }, (_, i) => ({ beat: i, midi: 40 })),
      0.8
    );
    const s = buildTimeSkeleton({ notes, ...grid(6), startOffsetSec: 4.0 }, settings());
    const implicit = s.bars.filter((b) => b.implicit);
    expect(implicit.length).toBeGreaterThanOrEqual(2);
    const bar1 = s.bars.find((b) => !b.implicit)!;
    expect(bar1.number).toBe(1);
    expect(s.secondsToTick(4.0)).toBeCloseTo(bar1.startTick, 6);
  });

  it('end to end: the pickup shows up in the IR as measure 0, implicit, short', () => {
    const notes = [
      { id: 'p', startSec: 1.5, endSec: 1.9, midi: 43 },
      ...playedNotes(Array.from({ length: 8 }, (_, i) => ({ beat: i, midi: 40 })), 0.8, 120, 2.0)
    ];
    const r = buildScore({ notes, ...grid(6), startOffsetSec: 2.0 }, settings({ tuningMidi: BASS4 }));
    const first = r.ir.bars[0];
    expect(first.implicit).toBe(true);
    expect(first.number).toBe(0);
    expect(first.durTicks).toBeLessThan(96);
    expect(r.ir.bars[1].number).toBe(1);
    expect(r.ir.bars[1].durTicks).toBe(96);
  });
});
