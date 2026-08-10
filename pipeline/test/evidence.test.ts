/**
 * REGRESSION — the integration clip that exposed the unplaced-note bug.
 *
 * 92 notes on a normal bass line. Six of them are D#1 (MIDI 27), a semitone below the low E of a
 * four-string bass. Before the fix those six emptied their lattice slots, the Viterbi had no way
 * to restart, the backtrack found no finite endpoint, and EVERY lead note in the score came back
 * without a string or fret — 63 of 92 unplaced, the surviving 29 being only chord members, which
 * are placed greedily and bypass the path.
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { assignStrings, assignStringsLowestFret, detectLegatoPairs } from '../src/tab.js';
import { EVIDENCE_CLIP, EVIDENCE_TUNING } from '../fixtures/evidence.js';
import { readMusicXml } from './xmlReader.js';
import { settings } from './helpers.js';

const inRange = (midi: number): boolean =>
  EVIDENCE_TUNING.some((open) => midi - open >= 0 && midi - open <= 24);

describe('EVIDENCE CLIP — every note gets a position', () => {
  const tabNotes = EVIDENCE_CLIP.map((n, i) => ({ id: `n${i}`, ...n }));

  it('the clip really does contain out-of-range pitches (or this test proves nothing)', () => {
    expect(EVIDENCE_CLIP).toHaveLength(92);
    const out = EVIDENCE_CLIP.filter((n) => !inRange(n.midi));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((n) => n.midi === 27)).toBe(true);
  });

  it('the assigner places EVERY note — none unplayable', () => {
    const r = assignStrings(tabNotes, {
      tuningMidi: EVIDENCE_TUNING,
      fingeringStyle: 'minMovement',
      legatoPairs: detectLegatoPairs(tabNotes)
    });
    expect(r.filter((a) => a.position)).toHaveLength(92);
    expect(r.filter((a) => a.unplayable)).toHaveLength(0);
  });

  it('in-range notes get an EXACT position — no octave shift, right pitch', () => {
    const r = assignStrings(tabNotes, { tuningMidi: EVIDENCE_TUNING, fingeringStyle: 'minMovement' });
    r.forEach((a, i) => {
      const midi = tabNotes[i].midi;
      if (!inRange(midi)) return;
      expect(a.tabOctaveShift ?? 0).toBe(0);
      expect(EVIDENCE_TUNING[a.position!.string - 1] + a.position!.fret).toBe(midi);
    });
  });

  it('out-of-range notes degrade by a whole octave, and the shift is recorded', () => {
    const r = assignStrings(tabNotes, { tuningMidi: EVIDENCE_TUNING, fingeringStyle: 'minMovement' });
    r.forEach((a, i) => {
      const midi = tabNotes[i].midi;
      if (inRange(midi)) return;
      expect(a.position).toBeDefined();
      expect(Math.abs(a.tabOctaveShift!) % 12).toBe(0);
      expect(EVIDENCE_TUNING[a.position!.string - 1] + a.position!.fret).toBe(midi + a.tabOctaveShift!);
    });
  });

  it('ONE unplayable note can no longer poison the path (the actual bug)', () => {
    const withHole = [
      { id: 'a', midi: 40, startSec: 0.0, endSec: 0.2 },
      { id: 'b', midi: 43, startSec: 0.5, endSec: 0.7 },
      // 200 is unreachable at any octave on a bass, so this slot genuinely stays empty
      { id: 'c', midi: 200, startSec: 1.0, endSec: 1.2 },
      { id: 'd', midi: 45, startSec: 1.5, endSec: 1.7 },
      { id: 'e', midi: 47, startSec: 2.0, endSec: 2.2 }
    ];
    const r = assignStrings(withHole, { tuningMidi: EVIDENCE_TUNING, fingeringStyle: 'minMovement' });
    expect(r.filter((a) => a.position)).toHaveLength(4);
    expect(r.find((a) => a.id === 'c')!.unplayable).toBe(true);
    // the notes AFTER the hole are placed, which is the whole point
    expect(r.find((a) => a.id === 'd')!.position).toBeDefined();
    expect(r.find((a) => a.id === 'e')!.position).toBeDefined();
  });

  it('the lowest-fret baseline places everything too', () => {
    const r = assignStringsLowestFret(tabNotes, EVIDENCE_TUNING);
    expect(r.filter((a) => a.position).length).toBeGreaterThanOrEqual(86);
  });
});

describe('EVIDENCE CLIP — end to end, and in the exported MusicXML', () => {
  const built = buildScore(
    { notes: EVIDENCE_CLIP },
    settings({ tuningMidi: EVIDENCE_TUNING, fingeringStyle: 'minMovement' })
  );

  it('no IR note is left unplayable', () => {
    const all = built.ir.bars.flatMap((b) => b.voices.flatMap((v) => v.beats.flatMap((x) => x.notes)));
    expect(all.length).toBeGreaterThan(80);
    expect(all.filter((n) => n.unplayable)).toHaveLength(0);
    expect(all.filter((n) => n.string === undefined || n.fret === undefined)).toHaveLength(0);
  });

  it('the exported tab staff carries a fret for every attack', () => {
    const read = readMusicXml(built.toMusicXML());
    const tab = read.notes.filter((n) => n.staff === 2 && !n.isRest);
    // A tie continuation deliberately repeats no fret digit; every ATTACK must have one.
    const attacks = tab.filter((n) => !n.tieStop);
    expect(attacks.length).toBeGreaterThan(80);
    expect(attacks.filter((n) => n.fret === undefined)).toHaveLength(0);
  });

  it('was genuinely broken before: 63 of 92 tab digits were missing in the shipped export', () => {
    // Documented here so the number in the bug report stays attached to the test.
    expect(92 - 29).toBe(63);
  });
});
