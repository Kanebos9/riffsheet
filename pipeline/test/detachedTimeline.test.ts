/**
 * DETACHED TIMELINE — the score outliving its audio.
 *
 * Bar insert/delete is a pure note-time edit made app-side: it shifts real, user-owned material
 * later while the waveform underneath stays exactly as long as it was recorded. From that moment
 * `audioDurationSec` is no longer a statement about the notes, and station 7's past-end filter —
 * which exists to kill a detector that never stopped — would answer "insert four bars" by
 * deleting everything the insert moved. `BuildInput.detachedTimeline` lifts exactly that one
 * rule, and this file pins what must follow from it:
 *
 *   1. GUARD. Past-end drop and ring-out clamp off; the sub-30 ms filter and every other guard on.
 *   2. CHAIN. Skeleton length, tempo map, tick<->seconds map and `validateIR` all already derive
 *      from the material rather than from the audio, so nothing else may trim. Swept as a
 *      property over every grid x 4/4 and 6/8 x shifts of one and two bars past the audio end.
 *   3. SEAM SPLIT. Inserting a bar at a seam splits a crossing note into a pre-seam piece and a
 *      post-seam piece SEPARATED BY THE INSERTED EMPTY BAR. They are not abutting, so the merge
 *      law cannot reach them and no tie is wanted across a bar of silence: two honest attacks.
 *      The abutting case is pinned too, because the merge law fuses same-START-tick collisions
 *      and a split produces same-pitch notes that only TOUCH — those must stay two attacks.
 */

import { describe, it, expect } from 'vitest';
import { applyGuards } from '../src/guards.js';
import { buildScore } from '../src/buildScore.js';
import { validateIR } from '../src/validate.js';
import { buildTickSecondsMap } from '../src/tickSeconds.js';
import { settings } from './helpers.js';
import type { BuildInput, GridSetting, InputNote } from '../src/types.js';
import type { RiffsheetIR } from '../src/ir.js';

const note = (startSec: number, endSec: number, midi = 40, id?: string): InputNote => ({
  startSec,
  endSec,
  midi,
  ...(id ? { id } : {})
});

const GRIDS: GridSetting[] = ['auto', '1/4', '1/8', '1/16', '1/8T', 'thirtysecond', 'free'];

/** Every glyph that is a fresh attack — a tie continuation is the same note, not another one. */
function attacks(ir: RiffsheetIR): { id: string; midi: number }[] {
  const out: { id: string; midi: number }[] = [];
  for (const bar of ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        for (const n of beat.notes) if (!n.tieStop) out.push({ id: n.id, midi: n.midi });
      }
    }
  }
  return out;
}

/** Wall-clock length of the engraved page, through the tempo map the IR itself declares. */
function scoreSeconds(ir: RiffsheetIR): number {
  const map = buildTickSecondsMap(ir);
  const last = ir.bars[ir.bars.length - 1];
  return map.tickToSec(last.startTick + last.durTicks);
}

describe('STATION 7 — detachedTimeline lifts the audio-length rules and nothing else', () => {
  it('keeps a note that starts after the audio ends', () => {
    const notes = [note(0, 0.5), note(3.2, 3.7)];
    expect(applyGuards(notes, 3.0).notes).toHaveLength(1);
    expect(applyGuards(notes, 3.0, true).notes).toHaveLength(2);
    expect(applyGuards(notes, 3.0, true).pastEndDropped).toBe(0);
  });

  it('keeps the full sounding length of a note that rings past the end', () => {
    expect(applyGuards([note(2.5, 4.0)], 3.0).notes[0].endSec).toBe(3.0);
    expect(applyGuards([note(2.5, 4.0)], 3.0, true).notes[0].endSec).toBe(4.0);
  });

  it('still drops sub-30 ms fragments — that rule is about a detector, not about the audio end', () => {
    const r = applyGuards([note(0, 0.02), note(9, 9.5)], 3.0, true);
    expect(r.notes).toHaveLength(1);
    expect(r.tooShortDropped).toBe(1);
  });

  it('is exactly the old behaviour when absent or false', () => {
    const notes = [note(0, 0.5), note(3.2, 3.7), note(2.5, 4.0, 41)];
    expect(applyGuards(notes, 3.0, false)).toEqual(applyGuards(notes, 3.0));
    expect(applyGuards(notes, 3.0, false).pastEndDropped).toBe(1);
  });

  it('still flags repeat loops that live entirely past the audio end', () => {
    const loop: InputNote[] = [];
    for (let i = 0; i < 12; i++) loop.push(note(10 + i * 0.125, 10 + i * 0.125 + 0.1, 40));
    expect(applyGuards(loop, 3.0, true).repeatLoops).toHaveLength(1);
  });
});

/**
 * THE SWEEP. One take, engraved three times — where it was recorded, and shifted one and two
 * bars past the end of the audio, which is what an app-side bar insert does to the note list.
 * Every note must survive, the page must grow to hold it, and the IR must stay engravable.
 */
describe('detachedTimeline — the whole chain tolerates notes beyond the audio', () => {
  const AUDIO_SEC = 4.0;
  const METERS: { sig: [number, number]; barSec: number }[] = [
    { sig: [4, 4], barSec: 2.0 },
    { sig: [6, 8], barSec: 1.5 }
  ];
  const PITCHES = [28, 33, 38, 43, 40, 35, 30, 45];

  /** Eight quarter-note attacks at 120 BPM, moved bodily later by `shiftSec`. */
  const take = (shiftSec: number): InputNote[] =>
    PITCHES.map((midi, i) => note(shiftSec + i * 0.5, shiftSec + i * 0.5 + 0.45, midi, `n${i}`));

  for (const { sig, barSec } of METERS) {
    for (const bars of [0, 1, 2]) {
      const shiftSec = bars * barSec;
      const label = `${sig[0]}/${sig[1]} shifted +${bars} bar(s)`;

      it(`${label}: every note is engraved, the page extends, the IR validates`, () => {
        const notes = take(shiftSec);
        const lastStart = notes[notes.length - 1].startSec;
        const input: BuildInput = {
          notes,
          audioDurationSec: AUDIO_SEC,
          detachedTimeline: true,
          externalGrid: { bpm: 120, timeSig: sig }
        };

        for (const gridSetting of GRIDS) {
          const r = buildScore(input, settings({ grid: gridSetting }));
          const ids = attacks(r.ir).map((a) => a.id);
          // THE INVARIANT THAT HOLDS EVERYWHERE: the audio's length has no influence at all. The
          // page is byte-identical to the one built with no `audioDurationSec` in the first place,
          // which is the strongest available way to say "no guard silently trimmed anything".
          const unbounded = buildScore(
            { notes, externalGrid: input.externalGrid },
            settings({ grid: gridSetting })
          );
          expect(r.ir, `${label} ${gridSetting}: audio length is inert`).toEqual(unbounded.ir);
          // THE ABSOLUTE COUNT, on the meter this material is written for. (Quarter-note material
          // under a 1/4 grid in COMPOUND 6/8 legitimately collapses onto the dotted-quarter
          // lattice — a pre-existing meter/grid law, phase-dependent and nothing to do with the
          // audio end, so the strict claim is made where the fixture is on-grid.)
          if (sig[1] === 4) {
            expect(new Set(ids), `${label} ${gridSetting}: note count`).toEqual(
              new Set(notes.map((n) => n.id!))
            );
            expect(ids.length, `${label} ${gridSetting}: no note engraved twice`).toBe(notes.length);
          }
          expect(ids.length, `${label} ${gridSetting}: nothing engraved twice`).toBe(
            new Set(ids).size
          );
          expect(validateIR(r.ir), `${label} ${gridSetting}`).toEqual([]);
          // The skeleton reached past the audio to hold the material, and the tick<->seconds map
          // agrees with the bars it was built from.
          expect(scoreSeconds(r.ir), `${label} ${gridSetting}: page holds the last attack`)
            .toBeGreaterThan(lastStart);
          if (shiftSec > 0) {
            expect(r.ir.bars.length, `${label} ${gridSetting}: bars extend`).toBeGreaterThan(
              buildScore({ ...input, notes: take(0) }, settings({ grid: gridSetting })).ir.bars.length
            );
          }
        }
      });
    }
  }

  it('without the flag the same edit deletes the material it moved', () => {
    const notes = take(4.0); // every attack now starts at or after the audio end
    const input: BuildInput = {
      notes,
      audioDurationSec: AUDIO_SEC,
      externalGrid: { bpm: 120, timeSig: [4, 4] }
    };
    expect(attacks(buildScore(input, settings()).ir)).toHaveLength(0);
    expect(attacks(buildScore({ ...input, detachedTimeline: true }, settings()).ir)).toHaveLength(
      notes.length
    );
  });

  it('minimumBars is still a floor, never a ceiling, on a detached page', () => {
    const r = buildScore(
      {
        notes: take(4.0),
        audioDurationSec: AUDIO_SEC,
        detachedTimeline: true,
        minimumBars: 2,
        externalGrid: { bpm: 120, timeSig: [4, 4] }
      },
      settings()
    );
    expect(r.ir.bars.filter((b) => !b.implicit).length).toBeGreaterThanOrEqual(4);
    expect(validateIR(r.ir)).toEqual([]);
  });
});

/**
 * SEAM SPLIT. The app splits a note that crosses the insertion point; the two pieces end up in
 * DIFFERENT bars with the newly inserted empty bar between them. There is nothing here for a tie
 * to do (a tie over a bar of silence is not a thing notation says) and nothing for the merge law
 * to fuse (it fuses events that land on the SAME start tick). Two attacks, honestly.
 */
describe('detachedTimeline — a seam split engraves as two independent attacks', () => {
  const SEAM = 40;
  /**
   * Bar 1 has three neighbours and the pre-seam piece; bar 2 is the inserted empty one; bar 3
   * opens with the post-seam piece. 4/4 at 120 BPM, so a bar is 2 s.
   */
  const seamNotes = (): InputNote[] => [
    note(0.0, 0.45, 28, 'a0'),
    note(0.5, 0.95, 33, 'a1'),
    note(1.0, 1.45, 38, 'a2'),
    note(1.5, 2.0, SEAM, 'pre'), // the crossing note's first half, up to the seam
    note(4.0, 4.5, SEAM, 'post'), // its second half, one inserted bar later
    note(4.5, 4.95, 33, 'b1'),
    note(5.0, 5.45, 38, 'b2'),
    note(5.5, 5.95, 43, 'b3')
  ];

  const input: BuildInput = {
    notes: seamNotes(),
    audioDurationSec: 4.0,
    detachedTimeline: true,
    externalGrid: { bpm: 120, timeSig: [4, 4] }
  };

  for (const gridSetting of GRIDS) {
    it(`${gridSetting}: both pieces survive, the inserted bar stays empty, the IR validates`, () => {
      const r = buildScore(input, settings({ grid: gridSetting }));
      const seam = attacks(r.ir).filter((a) => a.midi === SEAM);
      expect(seam.map((a) => a.id).sort(), 'two attacks, not one merged note').toEqual([
        'post',
        'pre'
      ]);
      expect(validateIR(r.ir), gridSetting).toEqual([]);

      const printed = r.ir.bars.filter((b) => !b.implicit);
      expect(printed.length).toBeGreaterThanOrEqual(3);
      // The inserted bar carries no attack at all — the whole point of inserting it.
      for (const voice of printed[1].voices) {
        for (const beat of voice.beats) {
          expect(beat.notes.filter((n) => !n.tieStop), `${gridSetting}: inserted bar is empty`)
            .toHaveLength(0);
        }
      }
      // Nothing ties ACROSS the empty bar: the pre-seam piece closes, the post-seam piece opens.
      const pre = r.ir.bars.flatMap((b) => b.voices.flatMap((v) => v.beats.flatMap((x) => x.notes)))
        .filter((n) => n.id === 'pre');
      const post = r.ir.bars.flatMap((b) => b.voices.flatMap((v) => v.beats.flatMap((x) => x.notes)))
        .filter((n) => n.id === 'post');
      expect(pre[pre.length - 1].tieStart, `${gridSetting}: pre-seam piece does not tie out`).toBe(false);
      expect(post[0].tieStop, `${gridSetting}: post-seam piece is a fresh attack`).toBe(false);
    });
  }

  it('two ABUTTING same-pitch pieces are two attacks — the merge law only fuses same-tick onsets', () => {
    // What a split with no inserted bar produces: piece one ends exactly where piece two starts.
    const notes = [
      note(0.0, 0.5, SEAM, 'first'),
      note(0.5, 1.5, SEAM, 'second'),
      note(2.0, 2.45, 33, 'tail')
    ];
    for (const gridSetting of GRIDS) {
      const r = buildScore(
        {
          notes,
          audioDurationSec: 1.0,
          detachedTimeline: true,
          externalGrid: { bpm: 120, timeSig: [4, 4] }
        },
        settings({ grid: gridSetting })
      );
      const seam = attacks(r.ir).filter((a) => a.midi === SEAM);
      expect(seam.map((a) => a.id).sort(), `${gridSetting}: never fused into one`).toEqual([
        'first',
        'second'
      ]);
      expect(validateIR(r.ir), gridSetting).toEqual([]);
    }
  });
});
