import { describe, it, expect } from 'vitest';
import { R } from '../src/rational.js';
import { buildBarMetric, depthAt, durationCount, glyphFor, nextBeatAfter, toDurationList, tupletWrittenLen } from '../src/meter.js';
import { buildScore } from '../src/buildScore.js';
import { grid, playedNotes, settings } from './helpers.js';

const FOUR_FOUR = buildBarMetric(4, 4);
const THREE_FOUR = buildBarMetric(3, 4);
const SIX_EIGHT = buildBarMetric(6, 8, true);

const strs = (rs: ReturnType<typeof toDurationList>): string[] => rs.map((r) => r.toString());

describe('metricDivisionsOfBar', () => {
  it('4/4 subdivides /2 then /4 — the "additional central accent"', () => {
    expect(FOUR_FOUR.divLengths.slice(0, 4).map((r) => r.toString())).toEqual(['1/1', '1/2', '1/4', '1/8']);
    expect(FOUR_FOUR.beatLen.toString()).toBe('1/4');
  });

  it('3/4 subdivides /3', () => {
    expect(THREE_FOUR.divLengths.slice(0, 3).map((r) => r.toString())).toEqual(['3/4', '1/4', '1/8']);
  });

  it('6/8 gets the dotted beat then /3', () => {
    expect(SIX_EIGHT.beatLen.toString()).toBe('3/8');
    expect(SIX_EIGHT.divLengths.slice(0, 3).map((r) => r.toString())).toEqual(['3/4', '3/8', '1/8']);
  });

  it('metric depth: bar start strongest, offbeats weakest', () => {
    expect(depthAt(FOUR_FOUR, R(0, 1))).toBe(0);
    expect(depthAt(FOUR_FOUR, R(1, 2))).toBe(1); // beat 3
    expect(depthAt(FOUR_FOUR, R(1, 4))).toBe(2); // beat 2
    expect(depthAt(FOUR_FOUR, R(3, 4))).toBe(2); // beat 4
    expect(depthAt(FOUR_FOUR, R(1, 8))).toBe(3); // "and of 1"
    expect(depthAt(FOUR_FOUR, R(1, 16))).toBe(4); // "e of 1"
  });

  it('nextBeatAfter is the growth cap rule 3 of the endTime clamp', () => {
    expect(nextBeatAfter(FOUR_FOUR, R(0, 1)).toString()).toBe('1/4');
    expect(nextBeatAfter(FOUR_FOUR, R(1, 8)).toString()).toBe('1/4');
    expect(nextBeatAfter(FOUR_FOUR, R(3, 4)).toString()).toBe('1/1');
  });
});

describe('toDurationList — THE note/rest tol asymmetry (tol=1 vs tol=0)', () => {
  it('a syncopated quarter NOTE on the "and of 1" stays one glyph', () => {
    expect(strs(toDurationList(FOUR_FOUR, R(1, 8), R(1, 4), 'note'))).toEqual(['1/4']);
  });

  it('the SAME span as a REST splits at the beat — the engraving error the old code shipped', () => {
    // §3.2: "a 960-tick gap starting on the 'and of 1' becomes a single quarter rest
    // straddling beat 2 — a plain engraving error."
    expect(strs(toDurationList(FOUR_FOUR, R(1, 8), R(1, 4), 'rest'))).toEqual(['1/8', '1/8']);
  });

  it('a half NOTE on beat 2 crosses the middle of the bar; a half REST does not', () => {
    expect(strs(toDurationList(FOUR_FOUR, R(1, 4), R(1, 2), 'note'))).toEqual(['1/2']);
    expect(strs(toDurationList(FOUR_FOUR, R(1, 4), R(1, 2), 'rest'))).toEqual(['1/4', '1/4']);
  });

  it('rests that ARE metrically legal stay whole', () => {
    expect(strs(toDurationList(FOUR_FOUR, R(0, 1), R(1, 1), 'rest'))).toEqual(['1/1']);
    expect(strs(toDurationList(FOUR_FOUR, R(0, 1), R(1, 2), 'rest'))).toEqual(['1/2']);
    expect(strs(toDurationList(FOUR_FOUR, R(1, 2), R(1, 4), 'rest'))).toEqual(['1/4']);
  });

  it('a dotted-quarter NOTE from beat 1 stays whole; the rest splits', () => {
    expect(strs(toDurationList(FOUR_FOUR, R(0, 1), R(3, 8), 'note'))).toEqual(['3/8']);
    expect(strs(toDurationList(FOUR_FOUR, R(0, 1), R(3, 8), 'rest'))).toEqual(['1/4', '1/8']);
  });

  it('triple meter: a 2/3-bar REST at the bar start always splits — but the NOTE does not', () => {
    // Gould p.161: no minim rest in 3/4. The half NOTE is the normal spelling of beats 1-2.
    expect(strs(toDurationList(THREE_FOUR, R(0, 1), R(1, 2), 'rest'))).toEqual(['1/4', '1/4']);
    expect(strs(toDurationList(THREE_FOUR, R(0, 1), R(1, 2), 'note'))).toEqual(['1/2']);
  });

  it('never produces a rest shorter than an eighth', () => {
    // An eighth-long gap starting on the second sixteenth would split tol=0 into two 16th
    // rests; the vocabulary cap merges it back.
    const pieces = toDurationList(FOUR_FOUR, R(1, 16), R(1, 8), 'rest');
    for (const p of pieces) expect(p.gte(R(1, 8))).toBe(true);
  });

  it('never emits more than one dot', () => {
    for (const g of [R(7, 16), R(7, 8), R(15, 16)]) {
      for (const piece of toDurationList(FOUR_FOUR, R(0, 1), g, 'note')) {
        const found = glyphFor(piece);
        if (found) expect(found.dots).toBeLessThanOrEqual(1);
      }
    }
  });

  it('every produced piece is printable', () => {
    for (let startTick = 0; startTick < 48; startTick += 3) {
      for (let lenTick = 3; startTick + lenTick <= 48; lenTick += 3) {
        for (const kind of ['note', 'rest'] as const) {
          const pieces = toDurationList(FOUR_FOUR, R(startTick, 48), R(lenTick, 48), kind);
          const sum = pieces.reduce((a, b) => a.add(b), R(0, 1));
          expect(sum.eq(R(lenTick, 48))).toBe(true);
          for (const p of pieces) expect(glyphFor(p)).toBeTruthy();
        }
      }
    }
  });
});

/**
 * LARGEST LEGAL SYMBOL. A span that has one printable glyph must be printed as that glyph
 * unless a house rule forbids it. The three things that forbid it, in order:
 *   (a) a barline — enforced structurally, `toDurationList` is only ever called within one bar;
 *   (b) beat-structure visibility — the level test, which is what splits real syncopations;
 *   (c) a tuplet edge — enforced structurally, a tuplet group never reaches this function.
 * Nothing else may fragment a note.
 */
describe('toDurationList — largest legal symbol', () => {
  const TWO_FOUR = buildBarMetric(2, 4);

  it('two on-beat quarters merge into one half note, in every meter that can hold one', () => {
    // 4/4 beats 1-2, 2-3 and 3-4 — beat 2 is the one that crosses the middle of the bar.
    expect(strs(toDurationList(FOUR_FOUR, R(0, 1), R(1, 2), 'note'))).toEqual(['1/2']);
    expect(strs(toDurationList(FOUR_FOUR, R(1, 4), R(1, 2), 'note'))).toEqual(['1/2']);
    expect(strs(toDurationList(FOUR_FOUR, R(1, 2), R(1, 2), 'note'))).toEqual(['1/2']);
    // 3/4 beats 1-2 and 2-3 — the case that used to come out as two tied quarters.
    expect(strs(toDurationList(THREE_FOUR, R(0, 1), R(1, 2), 'note'))).toEqual(['1/2']);
    expect(strs(toDurationList(THREE_FOUR, R(1, 4), R(1, 2), 'note'))).toEqual(['1/2']);
  });

  it('a bar-filling note is one symbol, not a tie chain', () => {
    expect(strs(toDurationList(FOUR_FOUR, R(0, 1), R(1, 1), 'note'))).toEqual(['1/1']);
    expect(strs(toDurationList(THREE_FOUR, R(0, 1), R(3, 4), 'note'))).toEqual(['3/4']);
    expect(strs(toDurationList(TWO_FOUR, R(0, 1), R(1, 2), 'note'))).toEqual(['1/2']);
    expect(strs(toDurationList(SIX_EIGHT, R(0, 1), R(3, 4), 'note'))).toEqual(['3/4']);
  });

  it('three on-beat quarters merge into a dotted half wherever the level test allows it', () => {
    expect(strs(toDurationList(FOUR_FOUR, R(0, 1), R(3, 4), 'note'))).toEqual(['3/4']);
    expect(strs(toDurationList(FOUR_FOUR, R(1, 4), R(3, 4), 'note'))).toEqual(['3/4']);
  });

  it('the merge is position-independent, which the old triple-meter override was not', () => {
    // The bug's own tell: the same half note an eighth later already printed as one glyph,
    // because the override keyed on "touches the barline" instead of on the metric structure.
    expect(strs(toDurationList(THREE_FOUR, R(1, 8), R(1, 2), 'note'))).toEqual(['1/2']);
    expect(strs(toDurationList(THREE_FOUR, R(0, 1), R(1, 2), 'note'))).toEqual(['1/2']);
  });

  it('SYNCOPATION still splits: mid-bar clarity outranks symbol size', () => {
    // A half note on the "and of 1" in 4/4 hides beat 3, so it stays two glyphs.
    expect(strs(toDurationList(FOUR_FOUR, R(1, 8), R(1, 2), 'note'))).toEqual(['3/8', '1/8']);
    // A dotted quarter from beat 2 ends mid-eighth on the far side of the middle of the bar.
    expect(strs(toDurationList(FOUR_FOUR, R(1, 4), R(3, 8), 'note'))).toEqual(['1/4', '1/8']);
    // Compound: the beat is dotted, so a quarter starting on its last eighth still splits.
    expect(strs(toDurationList(SIX_EIGHT, R(1, 4), R(3, 16), 'note'))).toEqual(['1/8', '1/16']);
  });

  it('rests are unaffected: they never merge across a metric level', () => {
    expect(strs(toDurationList(FOUR_FOUR, R(1, 4), R(1, 2), 'rest'))).toEqual(['1/4', '1/4']);
    expect(strs(toDurationList(THREE_FOUR, R(0, 1), R(1, 2), 'rest'))).toEqual(['1/4', '1/4']);
    expect(strs(toDurationList(FOUR_FOUR, R(0, 1), R(1, 1), 'rest'))).toEqual(['1/1']);
  });
});

/** The same rule, reached the way a user reaches it: notes and beats in, glyphs out. */
describe('largest legal symbol — end to end through buildScore', () => {
  /** Every glyph of voice 1, as `type[dots] tieIn>tieOut`. */
  const written = (ir: ReturnType<typeof buildScore>['ir']): string[][] =>
    ir.bars.map((bar) =>
      bar.voices[0].beats.map((b) => {
        const notes = b.notes;
        const tie = notes.length ? `${notes[0].tieStop ? '<' : ''}${notes[0].tieStart ? '>' : ''}` : '';
        return `${b.isRest ? 'R' : ''}${b.durationType}${b.dots ? '.' : ''}${tie}`;
      })
    );

  it('two on-beat quarters held as one note print as ONE half note in 3/4', () => {
    const notes = playedNotes(
      [{ beat: 0, midi: 40, lengthBeats: 2 }, { beat: 2, midi: 43, lengthBeats: 1 }],
      1,
      120
    );
    const r = buildScore({ notes, ...grid(1, 3) }, settings({ timeSigOverride: [3, 4] }));
    expect(r.ir.timeSig).toEqual([3, 4]);
    expect(written(r.ir)[0]).toEqual(['half', 'quarter']);
  });

  it('a bar-length note prints as ONE whole note in 4/4', () => {
    const notes = playedNotes([{ beat: 0, midi: 40, lengthBeats: 4 }], 1, 120);
    const r = buildScore({ notes, ...grid(1) }, settings());
    expect(written(r.ir)[0]).toEqual(['whole']);
  });

  it('across a barline it STAYS tied — the one split that is not negotiable', () => {
    // Two beats before the barline and two after: a half note either side, tied.
    const notes = playedNotes(
      [{ beat: 0, midi: 40, lengthBeats: 2 }, { beat: 2, midi: 43, lengthBeats: 4 }],
      1,
      120
    );
    const r = buildScore({ notes, ...grid(2) }, settings());
    const bars = written(r.ir);
    expect(bars[0]).toEqual(['half', 'half>']);
    expect(bars[1][0]).toBe('half<');
    expect(r.ir.stats.tiedGlyphs).toBe(2);
  });

  it('a tuplet edge is never crossed, however large the legal symbol would be', () => {
    const positions: { beat: number; midi: number }[] = [];
    for (let b = 0; b < 8; b++) for (let u = 0; u < 3; u++) positions.push({ beat: b + u / 3, midi: 40 });
    const r = buildScore({ notes: playedNotes(positions, 0.95), ...grid(2) }, settings());
    for (const bar of r.ir.bars) {
      for (const beat of bar.voices[0].beats) {
        if (!beat.tuplet) continue;
        const from = beat.startTick;
        const to = from + beat.durTicks;
        // Every tuplet member sits inside the one beat its group was decoded on.
        expect(Math.floor(from / 24), 'a tuplet glyph crossed its own beat').toBe(Math.floor((to - 1) / 24));
      }
    }
  });
});

describe('durationCount — a dotted value counts 1.5', () => {
  it('counts glyphs the way lengthenNote scores them', () => {
    expect(durationCount([R(1, 4)])).toBe(1);
    expect(durationCount([R(3, 8)])).toBe(1.5);
    expect(durationCount([R(1, 4), R(1, 8)])).toBe(2);
  });
});

describe('tuplet written lengths', () => {
  it('an eighth-triplet unit is written as an eighth', () => {
    expect(tupletWrittenLen(R(1, 4), 1, 2).toString()).toBe('1/8');
    expect(tupletWrittenLen(R(1, 4), 2, 2).toString()).toBe('1/4');
    expect(tupletWrittenLen(R(1, 4), 3, 2).toString()).toBe('3/8');
  });
  it('a sixteenth-triplet (sextuplet) unit is written as a sixteenth', () => {
    expect(tupletWrittenLen(R(1, 4), 1, 4).toString()).toBe('1/16');
  });
});
