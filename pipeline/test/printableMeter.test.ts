/**
 * EVERY GLYPH THE PIPELINE EMITS HAS A NAME — the regression suite for the live browser-harness
 * failure "bar 1 voice 1: <type>32nd</type> is 3 ticks but the glyph lasts 1".
 *
 * WHAT HAPPENED. The simulated-plugin fixture reports a DAW at 222 BPM in 3/6 (a real user's
 * REAPER reproduction, `webcore/src/bridge/mock.ts`), and 3/6 was believed verbatim. The tracked
 * beat became a SIXTH of a whole note — 16 ticks at DIVISIONS=24 — and 16 ticks is not the sum of
 * any combination of printable glyphs, whose tick lengths are 3, 6, 9, 12, 18, 24, 36, 48, 72 and
 * 96. `toDurationList` recursed down its halving ladder to 1/96, `greedyDecompose` fell through
 * to its documented "un-notatable remainder", and `typeOf` rounded each 1-tick fragment to the
 * nearest value it could name — a 32nd, which is 3 ticks. Sixteen of them per beat.
 *
 * It arrived by BOTH doors of webcore's tempo-source control: `Follow DAW` passes the host's
 * signature as `externalGrid.timeSig`, and switching to `Manual` freezes whatever meter is on
 * screen onto the take, which comes back as `timeSigOverride`. Both are checked below.
 *
 * The invariant the fixes establish, and the thing the property sweep measures: NO STATION MAY
 * PRODUCE A PIECE THE ENGRAVER CANNOT NAME. Three producers were closed —
 *
 *   1. `printableTimeSig` — a denominator that names no note value never reaches the skeleton,
 *      so no lattice derived from it can be unprintable (timeSkeleton.ts);
 *   2. `statesFor` — a tuplet lattice whose one-unit WRITTEN value is finer than a 1/32 is never
 *      offered to the quantizer (quantize.ts);
 *   3. `tupletUnitPieces` / `groupBeatLen` — a span inside a group is written against the beat
 *      the group was decided on, cut into unit counts that have printed values (buildScore.ts).
 *
 * `validateIR` is not weakened anywhere; these tests assert it has nothing to say.
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { printableTimeSig } from '../src/timeSkeleton.js';
import { quantizeOnsets } from '../src/quantize.js';
import { tupletUnitPieces, tupletWrittenLen, glyphFor, VOCABULARY } from '../src/meter.js';
import { validateIR } from '../src/validate.js';
import { DIVISIONS, THIRTYSECOND_TICKS } from '../src/ir.js';
import { R } from '../src/rational.js';
import { settings } from './helpers.js';
import type { BuildInput, BuildSettings, InputNote } from '../src/types.js';

/** Every tick length the vocabulary can name. Nothing else may leave the engraver. */
const GLYPH_TICKS = new Set(VOCABULARY.map((g) => g.len.toTicksExact(DIVISIONS)));

/**
 * `webcore/src/score/fixtures.ts` `straightRiff(2)` plus the demo's 0.9 s lead-in — the exact
 * take the harness holds when it drives the tempo-source select. Copied rather than imported:
 * the pipeline does not depend on webcore, and a fixture that drifts is the point of a
 * regression test.
 */
function straightDemo(bars = 2, bpm = 110, leadInSec = 0.9): { notes: InputNote[]; beats: number[]; durationSec: number } {
  const beatSec = 60 / bpm;
  const eighth = beatSec / 2;
  const pattern = [28, 28, 35, 33, 31, 31, 33, 28];
  const notes: InputNote[] = [];
  const beats: number[] = [];
  let id = 0;
  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * 4 * beatSec;
    for (let b = 0; b < 4; b++) beats.push(leadInSec + barStart + b * beatSec);
    pattern.forEach((midi, i) => {
      const start = leadInSec + barStart + i * eighth;
      notes.push({
        id: `f${id++}`,
        startSec: start,
        endSec: start + eighth * 0.9,
        midi: midi + (bar % 2 === 1 && i === 7 ? 5 : 0),
        velocity: 96
      });
    });
  }
  return { notes, beats, durationSec: leadInSec + bars * 4 * beatSec };
}

const DEMO = straightDemo();
const DEMO_INPUT: BuildInput = {
  notes: DEMO.notes,
  beats: DEMO.beats,
  audioDurationSec: DEMO.durationSec,
  startOffsetSec: 0.9
};

/** Every glyph in the score, so a claim can be made about all of them at once. */
function allBeats(ir: { bars: { voices: { beats: unknown[] }[] }[] }): {
  durTicks: number;
  durationType: string;
  dots: number;
  measureRest?: boolean;
  tuplet?: { actual: number; normal: number };
}[] {
  return ir.bars.flatMap((bar) => bar.voices.flatMap((voice) => voice.beats)) as never;
}

describe('a time signature denominator names a note value', () => {
  it('leaves every printable denominator exactly as it was', () => {
    for (const den of [1, 2, 4, 8, 16, 32]) expect(printableTimeSig(4, den)).toEqual([4, den]);
    expect(printableTimeSig(7, 8)).toEqual([7, 8]);
    expect(printableTimeSig(6, 8)).toEqual([6, 8]);
  });

  it('rewrites one that does not to the nearest power of two', () => {
    // The reported case. log2(6) is 2.58, so an eighth is nearer than a quarter.
    expect(printableTimeSig(3, 6)).toEqual([3, 8]);
    expect(printableTimeSig(4, 3)).toEqual([4, 4]);
    expect(printableTimeSig(4, 5)).toEqual([4, 4]);
    expect(printableTimeSig(4, 7)).toEqual([4, 8]);
    expect(printableTimeSig(4, 12)).toEqual([4, 16]);
  });

  it('clamps below a 1/32, because that is the finest value the vocabulary has', () => {
    // A 1/64 beat is not merely unusual: `Rational.toTicksExact` cannot express one at
    // DIVISIONS=24 and throws, so this clamp is what keeps the skeleton buildable at all.
    expect(printableTimeSig(4, 64)).toEqual([4, 32]);
    expect(printableTimeSig(4, 128)).toEqual([4, 32]);
  });

  it('survives nonsense rather than propagating it', () => {
    expect(printableTimeSig(4, 0)).toEqual([4, 4]);
    expect(printableTimeSig(0, 4)).toEqual([4, 4]);
    expect(printableTimeSig(Number.NaN, Number.NaN)).toEqual([4, 4]);
  });
});

describe('the reported failure: the mock DAW at 222 BPM in 3/6', () => {
  it('Follow DAW builds a score instead of throwing', () => {
    const r = buildScore(
      { ...DEMO_INPUT, externalGrid: { bpm: 222, timeSig: [3, 6] } },
      settings()
    );
    expect(validateIR(r.ir)).toEqual([]);
    expect(r.ir.timeSig).toEqual([3, 8]);
  });

  it('…and says in the diagnostics that the host asked for something unprintable', () => {
    const r = buildScore(
      { ...DEMO_INPUT, externalGrid: { bpm: 222, timeSig: [3, 6] } },
      settings()
    );
    expect(r.diagnostics.meterReason).toContain('3/6');
    expect(r.diagnostics.meterReason).toContain('no note value');
  });

  it('Manual — the same meter arriving back as an override — builds too', () => {
    // webcore's `setTempoSource('manual')` freezes what is on screen onto the take, so the
    // signature reaches the pipeline a second time by a different door.
    const r = buildScore(DEMO_INPUT, settings({ timeSigOverride: [3, 6], bpmOverride: 222 }));
    expect(validateIR(r.ir)).toEqual([]);
    expect(r.ir.timeSig).toEqual([3, 8]);
    expect(r.diagnostics.meterReason).toContain('no note value');
  });

  it('emits no glyph the vocabulary cannot name — the 1-tick "32nd" is gone', () => {
    const r = buildScore(
      { ...DEMO_INPUT, externalGrid: { bpm: 222, timeSig: [3, 6] } },
      settings()
    );
    for (const beat of allBeats(r.ir)) {
      if (beat.measureRest || beat.tuplet) continue;
      expect(GLYPH_TICKS.has(beat.durTicks)).toBe(true);
      expect(beat.durTicks).toBeGreaterThanOrEqual(THIRTYSECOND_TICKS);
    }
  });

  it('exports, which is what an unengravable score could never do', () => {
    const r = buildScore(
      { ...DEMO_INPUT, externalGrid: { bpm: 222, timeSig: [3, 6] } },
      settings()
    );
    expect(r.toMusicXML()).toContain('<beat-type>8</beat-type>');
    expect(r.toMidi(true).length).toBeGreaterThan(0);
  });
});

describe('a tuplet lattice must be sayable on the written side too', () => {
  /** Six evenly spaced onsets per beat — a textbook sextuplet, at whatever the beat is. */
  const sextupletOnsets = (ticksPerBeat: number, beats = 4) => {
    const unit = ticksPerBeat / 6;
    const out: { id: string; rawStartTick: number; rawOffTick: number }[] = [];
    for (let beat = 0; beat < beats; beat++) {
      for (let k = 0; k < 6; k++) {
        const t = beat * ticksPerBeat + k * unit;
        out.push({ id: `n${beat}-${k}`, rawStartTick: t, rawOffTick: t + unit });
      }
    }
    return out;
  };

  it('a x/16 meter is offered the triplet whose unit is a 32nd and NOT the sextuplet below it', () => {
    // A 1/16 beat is 6 ticks. A 3:2 group over it has a 32nd for its unit — printable, so it
    // stays. A 6:4 group's unit would be 1 tick, written as a 1/64: no symbol names one, and
    // `typeOf` used to round it to the nearest thing it could name, which is the whole bug.
    const q = quantizeOnsets(sextupletOnsets(6), {
      grid: 'auto',
      ticksPerBeat: 6,
      compound: false,
      totalTicks: 96
    });
    expect(q.tuplets.length).toBeGreaterThan(0);
    for (const group of q.tuplets) {
      expect(group.normal).toBe(2);
      const written = tupletWrittenLen(R(group.unitTicks * group.actual, 4 * DIVISIONS), 1, group.normal);
      expect(glyphFor(written)).not.toBeNull();
      expect(written.toTicksExact(DIVISIONS)).toBeGreaterThanOrEqual(THIRTYSECOND_TICKS);
    }
  });

  it('a quarter-note beat keeps its sextuplet, because a 16th is perfectly printable', () => {
    // The gate must not cost the ordinary case anything, and this is the case it could have.
    const q = quantizeOnsets(sextupletOnsets(24), {
      grid: 'auto',
      ticksPerBeat: 24,
      compound: false,
      totalTicks: 96
    });
    expect(q.tuplets.length).toBeGreaterThan(0);
    expect(q.tuplets.every((g) => g.actual === 6 && g.normal === 4 && g.unitTicks === 4)).toBe(true);
  });
});

describe('a tuplet is written against the beat it was decided on, not the bar it lands in', () => {
  /**
   * A 7/8 host grid whose supplied bar starts do not divide into sevens, so the first bar comes
   * out IRREGULAR — 72 ticks — and `timeSkeleton` gives it its own printed signature, 6/8.
   * `buildScore` then reads that back as COMPOUND (x/8, numerator divisible by three, greater
   * than three), so the bar metric's beat is a dotted quarter, 36 ticks. The tracked pulse behind
   * it is still a plain eighth of 12, and the triplet group in that bar has a unit of 4.
   *
   * Reading the written value off `metric.beatLen` therefore printed a DOTTED QUARTER, 24 ticks,
   * over a 8-tick triplet piece. The group's own `unitTicks x actual` cannot disagree with itself,
   * so that is what the engraver uses now.
   */
  const NOTES: InputNote[] = [
    { id: 'n0', midi: 34, startSec: 1.006336, endSec: 1.797315, velocity: 90 },
    { id: 'n3', midi: 28, startSec: 1.151511, endSec: 1.687533, velocity: 90 },
    { id: 'n5', midi: 38, startSec: 1.437709, endSec: 2.09622, velocity: 90 },
    { id: 'n1', midi: 54, startSec: 2.252587, endSec: 2.387055, velocity: 90 },
    { id: 'n4', midi: 49, startSec: 2.900791, endSec: 3.092734, velocity: 90 },
    { id: 'n6', midi: 29, startSec: 4.031122, endSec: 4.673632, velocity: 90 },
    { id: 'n7', midi: 32, startSec: 4.256505, endSec: 4.990424, velocity: 90 },
    { id: 'n2', midi: 37, startSec: 5.641955, endSec: 6.57505, velocity: 90 }
  ];
  const BEATS = [0.9, 1.51555, 2.132442, 2.742424, 3.365962, 3.998111, 4.610653, 5.215773, 5.830616];
  const DOWNBEATS = [0.9, 3.365962, 5.830616];
  const INPUT: BuildInput = {
    notes: NOTES,
    beats: BEATS,
    downbeats: DOWNBEATS,
    audioDurationSec: 6.348453608247423,
    startOffsetSec: 0.9,
    externalGrid: { bpm: 75, timeSig: [7, 8], barStartsSec: DOWNBEATS }
  };

  it('builds, and the bar really is the irregular compound-reading one', () => {
    const r = buildScore(INPUT, settings({ grid: '1/8T' }));
    expect(validateIR(r.ir)).toEqual([]);
    expect(r.ir.bars[0].timeSig).toEqual([6, 8]);
    expect(r.ir.bars[0].durTicks).toBe(72);
    expect(r.skeleton.ticksPerBeat).toBe(12);
  });

  it('and every tuplet glyph in it agrees with its own duration', () => {
    const r = buildScore(INPUT, settings({ grid: '1/8T' }));
    const tuplets = allBeats(r.ir).filter((beat) => beat.tuplet);
    expect(tuplets.length).toBeGreaterThan(0);
    for (const beat of tuplets) {
      // The sounding length scaled back up by normal/actual is the printed value, and it has to
      // be one the vocabulary contains — this is `validateIR`'s arithmetic, stated on the glyph.
      const written = R(beat.durTicks * beat.tuplet!.actual, 4 * DIVISIONS * beat.tuplet!.normal);
      expect(glyphFor(written)).not.toBeNull();
    }
  });
});

describe('a span inside a tuplet is cut into unit counts that have printed values', () => {
  it('1, 2, 3 and 4 units of a sextuplet are one glyph each', () => {
    const beat = R(1, 4);
    for (const units of [1, 2, 3, 4, 6]) {
      expect(tupletUnitPieces(beat, units, 4)).toEqual([units]);
    }
  });

  it('five units are not — 5/16 of a whole note has no symbol — so they are tied', () => {
    const pieces = tupletUnitPieces(R(1, 4), 5, 4);
    expect(pieces.reduce((a, b) => a + b, 0)).toBe(5);
    expect(pieces.length).toBeGreaterThan(1);
    for (const u of pieces) expect(glyphFor(tupletWrittenLen(R(1, 4), u, 4))).not.toBeNull();
  });

  it('every count a group can hold is spelled without a leftover', () => {
    for (const beatTicks of [96, 48, 24, 12, 6]) {
      for (const [actual, normal] of [[3, 2], [6, 4]] as const) {
        if (beatTicks / normal < THIRTYSECOND_TICKS) continue;
        const beat = R(beatTicks, 4 * DIVISIONS);
        for (let units = 1; units <= actual; units++) {
          const pieces = tupletUnitPieces(beat, units, normal);
          expect(pieces.reduce((a, b) => a + b, 0)).toBe(units);
          for (const u of pieces) expect(glyphFor(tupletWrittenLen(beat, u, normal))).not.toBeNull();
        }
      }
    }
  });
});

/**
 * THE SWEEP. Randomised — but from a fixed seed, so a failure is a reproducible input and not a
 * story about a build that once went wrong.
 *
 * It walks the shape the harness walks: a detected take, engraved at every grid the app offers,
 * under each of the three tempo sources in turn AND across the rebuild between them, with the
 * host's meter drawn from a list that deliberately includes denominators no note value has.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRIDS: BuildSettings['grid'][] = ['auto', '1/4', '1/8', '1/16', 'thirtysecond', '1/8T', 'free'];
const HOST_SIGS: [number, number][] = [
  [3, 6], [4, 4], [7, 8], [6, 8], [5, 4], [3, 4], [9, 12], [4, 3], [12, 16], [4, 64], [1, 1], [5, 7]
];

describe('property sweep — a detected take, every grid, every tempo source', () => {
  it('never produces a score validateIR objects to', () => {
    const problems: string[] = [];
    let builds = 0;

    for (let seed = 0; seed < 40; seed++) {
      const rnd = mulberry32(seed);
      const bpm = 50 + Math.floor(rnd() * 180);
      const period = 60 / bpm;
      const bars = 2 + Math.floor(rnd() * 2);
      const beats: number[] = [];
      const downbeats: number[] = [];
      let at = 0.9;
      for (let i = 0; i <= bars * 4; i++) {
        beats.push(at);
        if (i % 4 === 0) downbeats.push(at);
        // A detected grid wobbles; a perfectly even one is the easy case, not the real one.
        at += period * (1 + (rnd() - 0.5) * 0.05);
      }
      const notes: InputNote[] = [];
      const count = 4 + Math.floor(rnd() * 14);
      for (let i = 0; i < count; i++) {
        const start = 0.9 + rnd() * bars * 4 * period;
        notes.push({
          id: `n${i}`,
          midi: 28 + Math.floor(rnd() * 28),
          startSec: start,
          endSec: start + period * (0.05 + rnd() * 1.7),
          velocity: 90
        });
      }
      notes.sort((a, b) => a.startSec - b.startSec);

      const detected: BuildInput = {
        notes,
        beats,
        downbeats,
        audioDurationSec: 0.9 + bars * 4 * period + 0.5,
        startOffsetSec: 0.9
      };
      const hostSig = HOST_SIGS[seed % HOST_SIGS.length];
      const hostBpm = 20 + Math.floor(rnd() * 360);

      for (const gridSetting of GRIDS) {
        const attempt = (label: string, input: BuildInput, over: Partial<BuildSettings>) => {
          builds++;
          try {
            const r = buildScore(input, settings({ grid: gridSetting, ...over }));
            for (const problem of validateIR(r.ir)) {
              problems.push(`seed ${seed} grid ${gridSetting} ${label}: ${problem}`);
            }
            return r;
          } catch (e) {
            problems.push(`seed ${seed} grid ${gridSetting} ${label} threw: ${(e as Error).message}`);
            return null;
          }
        };

        // "From recording", then "Follow DAW" both ways the host can supply a grid…
        attempt('recording', detected, {});
        const daw = attempt('daw', { ...detected, externalGrid: { bpm: hostBpm, timeSig: hostSig } }, {});
        attempt(
          'daw with bar starts',
          { ...detected, externalGrid: { bpm: hostBpm, timeSig: hostSig, barStartsSec: downbeats } },
          {}
        );
        // …then "Manual", which freezes the score just built onto the take and rebuilds from it.
        if (daw) {
          attempt('manual frozen from the DAW build', detected, {
            bpmOverride: daw.ir.tempo.displayBpm,
            timeSigOverride: [daw.ir.timeSig[0], daw.ir.timeSig[1]]
          });
        }
        attempt('manual with the raw host meter', detected, {
          bpmOverride: hostBpm,
          timeSigOverride: hostSig
        });
        // …and back to the DAW, which is the transition the harness actually drives.
        attempt('daw again', { ...detected, externalGrid: { bpm: hostBpm, timeSig: hostSig } }, {});
      }
    }

    expect(builds).toBeGreaterThan(1000);
    expect(problems.slice(0, 8)).toEqual([]);
  });

  it('and never a glyph outside the printable vocabulary', () => {
    // The same claim one level lower: `validateIR` proves <type> agrees with <duration>, this
    // proves the value printed is one a reader has a symbol for.
    const offenders: string[] = [];
    for (const hostSig of HOST_SIGS) {
      for (const gridSetting of GRIDS) {
        const r = buildScore(
          { ...DEMO_INPUT, externalGrid: { bpm: 222, timeSig: hostSig } },
          settings({ grid: gridSetting })
        );
        for (const beat of allBeats(r.ir)) {
          if (beat.measureRest) continue;
          const len = beat.tuplet
            ? R(beat.durTicks * beat.tuplet.actual, 4 * DIVISIONS * beat.tuplet.normal)
            : R(beat.durTicks, 4 * DIVISIONS);
          if (!glyphFor(len)) {
            offenders.push(`${hostSig.join('/')} ${gridSetting}: ${len.toString()} (${beat.durTicks} ticks)`);
          }
        }
      }
    }
    expect(offenders.slice(0, 8)).toEqual([]);
  });
});
