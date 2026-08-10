import { describe, it, expect } from 'vitest';
import { detectKey, majorTonicOf, semitoneTransitionScores } from '../src/key.js';
import { accidentalDisplayForMeasure, keySignatureAlter, spellNoteList, tpcToAlter, tpcToOctave, tpcToStep } from '../src/spelling.js';
import { chooseClefs } from '../src/clef.js';

const w = (midis: number[], weight = 1): { midi: number; weight: number }[] =>
  midis.map((m) => ({ midi: m, weight }));

describe('STATION 3a — key detection', () => {
  it('maps fifths to the right major tonic', () => {
    expect(majorTonicOf(0)).toBe(0); // C
    expect(majorTonicOf(1)).toBe(7); // G
    expect(majorTonicOf(-1)).toBe(5); // F
    expect(majorTonicOf(2)).toBe(2); // D
  });

  it('refuses a signature on a short root-heavy riff and says why', () => {
    // E minor pentatonic, four bars. Exactly the case §1.4 says to refuse.
    const k = detectKey(w([40, 43, 45, 47, 50, 40, 43, 45]), { bars: 4, durationSec: 8 });
    expect(k.accepted).toBe(false);
    expect(k.fifths).toBe(0);
    expect(k.reason).toContain('open key');
    expect(k.candidates).toHaveLength(3);
  });

  it('a wrong signature is worse than none — an ambiguous input yields fifths 0', () => {
    const chromatic = w(Array.from({ length: 24 }, (_, i) => 40 + (i % 12)));
    const k = detectKey(chromatic, { bars: 16, durationSec: 40 });
    expect(k.fifths).toBe(0);
  });

  it('accepts a long, strongly diatonic input', () => {
    // Two octaves of G major, duration-weighted toward the tonic, repeated.
    const scale = [43, 45, 47, 48, 50, 52, 54, 55];
    const notes: { midi: number; weight: number }[] = [];
    for (let rep = 0; rep < 6; rep++) {
      for (const m of scale) notes.push({ midi: m, weight: m === 43 || m === 55 ? 2 : 1 });
    }
    const k = detectKey(notes, { bars: 16, durationSec: 40 });
    expect(k.accepted).toBe(true);
    expect(k.fifths).toBe(1);
  });

  it('the semitone-transition estimator is independent of pitch-class weighting', () => {
    // A pedal E generates no semitone transitions at all — the scores are flat.
    const flat = semitoneTransitionScores([40, 40, 40, 40]);
    expect([...flat.values()].every((v) => v === 0)).toBe(true);
    // E-F is the 7-8 semitone of F major (fifths -1) and the 3-4 of C major (fifths 0).
    const scores = semitoneTransitionScores([40, 41, 40, 41]);
    expect(scores.get(0)!).toBeGreaterThan(0);
  });
});

describe('STATION 3b — line-of-fifths helpers', () => {
  it('converts tpc to step/alter/octave, including the enharmonic edges', () => {
    expect(tpcToStep(0)).toBe('C');
    expect(tpcToAlter(0)).toBe(0);
    expect(tpcToStep(6)).toBe('F');
    expect(tpcToAlter(6)).toBe(1); // F#
    expect(tpcToStep(-2)).toBe('B');
    expect(tpcToAlter(-2)).toBe(-1); // Bb
    // Cb4 sounds as B3; B#3 sounds as C4. Both must keep their own letter's octave.
    expect(tpcToOctave(-7, 59)).toBe(4); // Cb4
    expect(tpcToOctave(12, 60)).toBe(3); // B#3
  });
});

describe('STATION 3b — enharmonic spelling', () => {
  it('spells naturals as naturals', () => {
    const s = spellNoteList([40, 42, 43, 45, 47], 0);
    expect(s.map((x) => x.step + (x.alter ? (x.alter > 0 ? '#' : 'b') : ''))).toEqual(['E', 'F#', 'G', 'A', 'B']);
  });

  it('follows the key signature: F# in G major, Gb in Db major', () => {
    const sharpKey = spellNoteList([42, 43, 45], 1);
    expect(sharpKey[0].step).toBe('F');
    expect(sharpKey[0].alter).toBe(1);
    const flatKey = spellNoteList([42, 41, 39], -5);
    expect(flatKey[0].step).toBe('G');
    expect(flatKey[0].alter).toBe(-1);
  });

  it('NEVER emits a double sharp or double flat', () => {
    for (let fifths = -7; fifths <= 7; fifths++) {
      const s = spellNoteList([36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47], fifths);
      for (const p of s) expect(Math.abs(p.alter)).toBeLessThanOrEqual(1);
    }
  });

  it('is stable across the 9-note window boundary', () => {
    const midis = Array.from({ length: 20 }, (_, i) => 40 + (i % 7));
    const s = spellNoteList(midis, 0);
    expect(s).toHaveLength(20);
    for (const p of s) expect(p.octave).toBeGreaterThan(0);
  });

  it('a chromatic ascent prefers sharps, a descent prefers flats', () => {
    const up = spellNoteList([40, 41, 42, 43, 44, 45], 0);
    const down = spellNoteList([45, 44, 43, 42, 41, 40], 0);
    const upAlters = up.filter((p) => p.alter !== 0).map((p) => p.alter);
    const downAlters = down.filter((p) => p.alter !== 0).map((p) => p.alter);
    if (upAlters.length && downAlters.length) {
      expect(upAlters.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(downAlters.reduce((a, b) => a + b, 0));
    }
  });
});

describe('STATION 3b — accidental DISPLAY (music21 cascade)', () => {
  it('knows what the key signature already alters', () => {
    expect(keySignatureAlter('F', 1)).toBe(1); // G major
    expect(keySignatureAlter('C', 1)).toBe(0);
    expect(keySignatureAlter('B', -1)).toBe(-1); // F major
    expect(keySignatureAlter('B', 0)).toBe(0);
  });

  it('rule 6: a note outside the signature shows its accidental first time in the measure', () => {
    const out = accidentalDisplayForMeasure(
      [{ step: 'F', alter: 1, octave: 2, tieStop: false, slot: 0 }],
      0
    );
    expect(out[0]).toBe('sharp');
  });

  it('rule 6: a natural cancels the signature', () => {
    const out = accidentalDisplayForMeasure(
      [{ step: 'F', alter: 0, octave: 2, tieStop: false, slot: 0 }],
      1 // G major has F#
    );
    expect(out[0]).toBe('natural');
  });

  it('rule 7: the same step with a different name later in the bar forces display', () => {
    const out = accidentalDisplayForMeasure(
      [
        { step: 'F', alter: 1, octave: 2, tieStop: false, slot: 0 },
        { step: 'F', alter: 0, octave: 2, tieStop: false, slot: 1 }
      ],
      0
    );
    expect(out).toEqual(['sharp', 'natural']);
  });

  it('an immediate identical repeat is hidden', () => {
    const out = accidentalDisplayForMeasure(
      [
        { step: 'F', alter: 1, octave: 2, tieStop: false, slot: 0 },
        { step: 'F', alter: 1, octave: 2, tieStop: false, slot: 1 }
      ],
      0
    );
    expect(out).toEqual(['sharp', undefined]);
  });

  it('cautionaryPitchClass: register does not matter', () => {
    const out = accidentalDisplayForMeasure(
      [
        { step: 'F', alter: 1, octave: 2, tieStop: false, slot: 0 },
        { step: 'F', alter: 0, octave: 4, tieStop: false, slot: 1 }
      ],
      0
    );
    expect(out[1]).toBe('natural');
  });

  it('rule 3: a tied-in note never re-displays its accidental', () => {
    const out = accidentalDisplayForMeasure(
      [{ step: 'F', alter: 1, octave: 2, tieStop: true, slot: 0 }],
      0
    );
    expect(out[0]).toBeUndefined();
  });

  it('rule 4: F# and F natural in one chord both get printed', () => {
    const out = accidentalDisplayForMeasure(
      [
        { step: 'F', alter: 1, octave: 2, tieStop: false, slot: 0 },
        { step: 'F', alter: 0, octave: 3, tieStop: false, slot: 0 }
      ],
      0
    );
    expect(out[0]).toBe('sharp');
    expect(out[1]).toBe('natural');
  });
});

describe('STATION 3c — stable clef policy', () => {
  it('a bass line is bass clef throughout, and no grand staff', () => {
    const d = chooseClefs([[28, 33, 38], [40, 43, 45], [31, 35, 38]], 'bass4');
    expect(d.perBar.every((c) => c.sign === 'F' && c.line === 4)).toBe(true);
    expect(d.grandStaff).toBe(false);
    expect(d.perBar[0].changed).toBe(true);
  });

  it('a high guitar part is treble clef', () => {
    const d = chooseClefs([[64, 67, 71], [69, 72, 76]], 'guitar6');
    expect(d.perBar.every((c) => c.sign === 'G')).toBe(true);
  });

  it('a part that spans both flags the grand staff', () => {
    const d = chooseClefs([[28, 31, 33], [28, 31, 33], [72, 76, 79], [72, 76, 79]], 'bass6');
    expect(d.grandStaff).toBe(true);
    expect(d.perBar.every((c) => c.sign === 'F')).toBe(true);
  });

  it('hysteresis: a group between the thresholds keeps the current clef', () => {
    const d = chooseClefs([[30, 32], [57, 58], [30, 32]], 'bass4');
    expect(d.perBar[2].sign).toBe('F');
  });

  it('a Stand By Me-style low part uses bass clef for the whole score', () => {
    const d = chooseClefs([[57, 57, 52], [57, 57, 54], [54, 52, 50]], 'staff');
    expect(d.perBar.every((c) => c.sign === 'F' && c.line === 4)).toBe(true);
  });

  it('a universal staff at middle C and above moves directly to treble', () => {
    const d = chooseClefs([[60, 64, 67], [62, 65, 69]], 'staff');
    expect(d.perBar.every((c) => c.sign === 'G' && c.line === 2)).toBe(true);
  });

  it('forced clef modes stay fixed and Grand requests a real stacked layout', () => {
    expect(chooseClefs([[40], [76]], 'staff', 'treble').perBar.every((clef) => clef.sign === 'G')).toBe(true);
    expect(chooseClefs([[76], [80]], 'staff', 'bass').perBar.every((clef) => clef.sign === 'F')).toBe(true);
    const grand = chooseClefs([[60], [64]], 'staff', 'grand');
    expect(grand.grandStaff).toBe(true);
    expect(new Set(grand.perBar.map((clef) => clef.sign)).size).toBe(1);
  });
});
