import { describe, it, expect } from 'vitest';
import { applyGuards, detectRepeatLoops, MIN_NOTE_SEC, REPEAT_IOI_STDDEV_SEC, REPEAT_MIN_RUN } from '../src/guards.js';
import { buildScore } from '../src/buildScore.js';
import { grid, playedNotes, settings } from './helpers.js';
import type { InputNote } from '../src/types.js';

const note = (startSec: number, endSec: number, midi = 40): InputNote => ({ startSec, endSec, midi });

describe('STATION 7 — past-end filter', () => {
  it('drops notes that start at or after the audio ends', () => {
    const r = applyGuards([note(0, 0.5), note(1, 1.5), note(3.2, 3.7)], 3.0);
    expect(r.notes).toHaveLength(2);
    expect(r.pastEndDropped).toBe(1);
  });

  it('clamps — does not drop — a note that merely RINGS past the end', () => {
    const r = applyGuards([note(2.5, 4.0)], 3.0);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0].endSec).toBe(3.0);
    expect(r.pastEndDropped).toBe(0);
  });

  it('is inert when no audio duration is supplied', () => {
    const r = applyGuards([note(0, 0.5), note(99, 99.5)]);
    expect(r.notes).toHaveLength(2);
    expect(r.pastEndDropped).toBe(0);
  });

  it('drops sub-30 ms fragments (barely one cycle of a low E)', () => {
    expect(MIN_NOTE_SEC).toBe(0.03);
    const r = applyGuards([note(0, 0.02), note(1, 1.5)]);
    expect(r.notes).toHaveLength(1);
    expect(r.tooShortDropped).toBe(1);
  });
});

describe('STATION 7 — repeat-loop detector (marks suspects, never resolves them)', () => {
  it('flags a machine-regular run of one pitch', () => {
    const notes: InputNote[] = [];
    for (let i = 0; i < 12; i++) notes.push(note(i * 0.125, i * 0.125 + 0.1, 40));
    const suspects = detectRepeatLoops(notes);
    expect(suspects).toHaveLength(1);
    expect(suspects[0].count).toBe(12);
    expect(suspects[0].midi).toBe(40);
    expect(suspects[0].stddevIoiSec).toBeLessThan(REPEAT_IOI_STDDEV_SEC);
  });

  it('does NOT flag a human-timed run of the same pitch', () => {
    const jitter = [0, 0.02, -0.018, 0.025, -0.022, 0.019, -0.026, 0.021, -0.017, 0.024, -0.02, 0.018];
    const notes = jitter.map((j, i) => note(i * 0.25 + j, i * 0.25 + j + 0.2, 40));
    expect(detectRepeatLoops(notes)).toHaveLength(0);
  });

  it('does NOT flag a short run', () => {
    const notes: InputNote[] = [];
    for (let i = 0; i < REPEAT_MIN_RUN - 1; i++) notes.push(note(i * 0.125, i * 0.125 + 0.1, 40));
    expect(detectRepeatLoops(notes)).toHaveLength(0);
  });

  it('a changing pitch breaks the run', () => {
    const notes: InputNote[] = [];
    for (let i = 0; i < 12; i++) notes.push(note(i * 0.125, i * 0.125 + 0.1, i === 6 ? 43 : 40));
    expect(detectRepeatLoops(notes)).toHaveLength(0);
  });

  it('indices point back into the ORIGINAL input array, past dropped notes', () => {
    const notes: InputNote[] = [note(0, 0.01, 99)]; // dropped: too short
    for (let i = 0; i < 10; i++) notes.push(note(1 + i * 0.125, 1 + i * 0.125 + 0.1, 40));
    const r = applyGuards(notes);
    expect(r.tooShortDropped).toBe(1);
    expect(r.repeatLoops).toHaveLength(1);
    expect(r.repeatLoops[0].noteIndices[0]).toBe(1);
  });

  it('the suspects reach the IR so the webcore can resolve them with audio', () => {
    const notes: InputNote[] = [];
    for (let i = 0; i < 16; i++) notes.push(note(i * 0.25, i * 0.25 + 0.2, 40));
    const r = buildScore({ notes, ...grid(4) }, settings());
    expect(r.ir.suspects.repeatLoops.length).toBeGreaterThan(0);
    // and the pipeline did NOT act on it: every note is still in the score
    const glyphCount = r.ir.bars.reduce(
      (a, b) => a + b.voices[0].beats.filter((x) => !x.isRest).length,
      0
    );
    expect(glyphCount).toBeGreaterThanOrEqual(16);
  });

  it('a clean riff produces no suspects at all', () => {
    const notes = playedNotes(
      [0, 1, 2, 3, 4, 5, 6, 7].map((b) => ({ beat: b, midi: 40 + (b % 4) })),
      0.8
    );
    const r = buildScore({ notes, ...grid(2) }, settings());
    expect(r.ir.suspects.repeatLoops).toHaveLength(0);
  });
});
