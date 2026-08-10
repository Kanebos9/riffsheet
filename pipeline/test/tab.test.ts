import { describe, it, expect } from 'vitest';
import {
  assignStrings,
  assignStringsLowestFret,
  detectLegatoPairs,
  irStringFromMusicXmlString,
  irStringFromTuningIndex,
  musicXmlStringFromIrString,
  staffTuningLineFromIrString,
  survivingLegato,
  tuningIndexFromIrString,
  type TabNoteInput
} from '../src/tab.js';
import { BASS4 } from './helpers.js';

const n = (id: string, midi: number, startSec: number, endSec: number): TabNoteInput => ({ id, midi, startSec, endSec });

describe('STATION 5 — THE string-numbering trap (§8.1), three systems', () => {
  it('IR/alphaTab numbering counts 1 from the LOWEST string', () => {
    // 4-string bass, tuning low->high [E1, A1, D2, G2]
    expect(irStringFromTuningIndex(0)).toBe(1); // E1 (lowest)  -> IR string 1
    expect(irStringFromTuningIndex(1)).toBe(2); // A1
    expect(irStringFromTuningIndex(2)).toBe(3); // D2
    expect(irStringFromTuningIndex(3)).toBe(4); // G2 (highest) -> IR string 4
  });

  it('MusicXML numbering is the INVERSE: 1 = highest pitched', () => {
    expect(musicXmlStringFromIrString(1, 4)).toBe(4); // lowest string -> MusicXML 4
    expect(musicXmlStringFromIrString(4, 4)).toBe(1); // highest string -> MusicXML 1
  });

  it('every conversion round-trips, for 4, 5 and 6 strings', () => {
    for (const count of [4, 5, 6]) {
      for (let s = 1; s <= count; s++) {
        expect(irStringFromMusicXmlString(musicXmlStringFromIrString(s, count), count)).toBe(s);
        expect(irStringFromTuningIndex(tuningIndexFromIrString(s))).toBe(s);
        // <staff-tuning line> counts from the bottom, which IS the IR numbering
        expect(staffTuningLineFromIrString(s)).toBe(s);
        expect(musicXmlStringFromIrString(s, count)).toBe(count + 1 - staffTuningLineFromIrString(s));
      }
    }
  });
});

describe('STATION 5 — legato pairs, detected BEFORE assignment', () => {
  it('finds an ascending pair with no re-pluck as a hammer-on', () => {
    const pairs = detectLegatoPairs([n('a', 40, 0, 0.5), n('b', 43, 0.503, 1.0)]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].kind).toBe('hammer');
  });

  it('finds a descending pair as a pull-off', () => {
    const pairs = detectLegatoPairs([n('a', 45, 0, 0.5), n('b', 42, 0.5, 1.0)]);
    expect(pairs[0].kind).toBe('pull');
  });

  it('rejects a re-plucked pair (a real gap)', () => {
    expect(detectLegatoPairs([n('a', 40, 0, 0.4), n('b', 43, 0.6, 1.0)])).toHaveLength(0);
  });

  it('rejects an interval wider than a hand span — that is a slide, not a hammer-on', () => {
    expect(detectLegatoPairs([n('a', 40, 0, 0.5), n('b', 47, 0.5, 1.0)])).toHaveLength(0);
  });
});

describe('STATION 5 — string assignment', () => {
  it("fingeringStyle 'low' reproduces the lowest-fret baseline on a simple line", () => {
    const notes = [n('a', 40, 0, 0.4), n('b', 43, 0.5, 0.9), n('c', 45, 1.0, 1.4), n('d', 47, 1.5, 1.9)];
    const dp = assignStrings(notes, { tuningMidi: BASS4, fingeringStyle: 'low' });
    const base = assignStringsLowestFret(notes, BASS4);
    expect(dp.map((a) => a.position)).toEqual(base.map((a) => a.position));
  });

  it("fingeringStyle 'minMovement' stays on one string where 'low' jumps to open strings", () => {
    // A1 C2 D2 G2. Lowest-fret hops A->D->G string by string; minMovement walks up one string.
    const notes = [n('a', 33, 0, 0.4), n('b', 36, 0.5, 0.9), n('c', 38, 1.0, 1.4), n('d', 43, 1.5, 1.9)];
    const low = assignStrings(notes, { tuningMidi: BASS4, fingeringStyle: 'low' });
    const min = assignStrings(notes, { tuningMidi: BASS4, fingeringStyle: 'minMovement' });
    const stringChanges = (r: typeof low): number => {
      let c = 0;
      for (let i = 1; i < r.length; i++) if (r[i].position!.string !== r[i - 1].position!.string) c++;
      return c;
    };
    const travel = (r: typeof low): number => {
      let t = 0;
      for (let i = 1; i < r.length; i++) t += Math.abs(r[i].position!.fret - r[i - 1].position!.fret);
      return t;
    };
    expect(stringChanges(min)).toBeLessThan(stringChanges(low));
    expect(travel(min) + stringChanges(min)).toBeLessThanOrEqual(travel(low) + stringChanges(low));
    // and 'low' really is the open-string-hungry one
    expect(low.filter((a) => a.position!.fret === 0).length).toBeGreaterThan(
      min.filter((a) => a.position!.fret === 0).length
    );
  });

  it('honours a pinned string override from an IR edit', () => {
    // IR string 3 is the D string (low->high index 2); G2 sits at fret 5 there.
    const notes: TabNoteInput[] = [{ ...n('a', 43, 0, 0.4), stringOverride: 3 }];
    const out = assignStrings(notes, { tuningMidi: BASS4, fingeringStyle: 'low' });
    expect(out[0].position).toEqual({ string: 3, fret: 5 });
  });

  it('a pitch below the lowest string degrades by a whole OCTAVE, and records the shift', () => {
    // The documented rule: never a hole in the tab, never a wrong-by-a-semitone fret. A low
    // G#0 is played an octave up, exactly as a player would, and the shift is recorded so the
    // UI can mark it. The notation staff keeps the true sounding pitch.
    const out = assignStrings([n('a', 20, 0, 0.4)], { tuningMidi: BASS4, fingeringStyle: 'low' });
    expect(out[0].unplayable).toBe(false);
    expect(out[0].tabOctaveShift).toBe(12);
    expect(BASS4[out[0].position!.string - 1] + out[0].position!.fret).toBe(32);
  });

  it('a pitch unreachable at EVERY octave stays honestly unplayable', () => {
    const out = assignStrings([n('a', 200, 0, 0.4)], { tuningMidi: BASS4, fingeringStyle: 'low' });
    expect(out[0].unplayable).toBe(true);
    expect(out[0].position).toBeUndefined();
  });

  it('an unplayable note does not stop its NEIGHBOURS being placed', () => {
    const out = assignStrings(
      [n('a', 40, 0, 0.4), n('b', 200, 0.5, 0.9), n('c', 43, 1.0, 1.4)],
      { tuningMidi: BASS4, fingeringStyle: 'minMovement' }
    );
    expect(out[0].position).toBeDefined();
    expect(out[1].unplayable).toBe(true);
    expect(out[2].position).toBeDefined();
  });

  it('places a double-stop on distinct strings within reach', () => {
    const out = assignStrings([n('a', 40, 0, 0.5), n('b', 47, 0, 0.5)], {
      tuningMidi: BASS4,
      fingeringStyle: 'low'
    });
    expect(out[0].position!.string).not.toBe(out[1].position!.string);
    expect(Math.abs(out[0].position!.fret - out[1].position!.fret)).toBeLessThanOrEqual(5);
  });

  it('the legato discount keeps an ascending legato run on one string', () => {
    // E2(40) -> F2(41) -> G2(43): lowest-fret would scatter these; the discount should not.
    const notes = [n('a', 40, 0, 0.5), n('b', 41, 0.5, 1.0), n('c', 43, 1.0, 1.5)];
    const pairs = detectLegatoPairs(notes);
    expect(pairs).toHaveLength(2);
    const out = assignStrings(notes, { tuningMidi: BASS4, fingeringStyle: 'minMovement', legatoPairs: pairs });
    const survived = survivingLegato(pairs, out);
    expect(survived.length).toBeGreaterThanOrEqual(1);
  });

  it('honours a capo by shifting the fret floor', () => {
    const out = assignStrings([n('a', 45, 0, 0.4)], { tuningMidi: BASS4, fingeringStyle: 'low', capo: 3 });
    expect(out[0].position!.fret).toBeGreaterThanOrEqual(3);
  });
});
