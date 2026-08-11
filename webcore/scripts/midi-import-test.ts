import { parseMidi } from '../src/import/midiFile';
import { buildRiffScore, type InputNote } from '@pipeline';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/app/state';
import { applyRollEditToNotes, type RollEditContext } from '../src/edit/rollPerformance';

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function file(track: number[], division = 96): ArrayBuffer {
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (division >>> 8) & 0xff, division & 0xff,
    0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track
  ]).buffer as ArrayBuffer;
}

function multiFile(tracks: number[][], division = 96): ArrayBuffer {
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 1,
    (tracks.length >>> 8) & 0xff, tracks.length & 0xff,
    (division >>> 8) & 0xff, division & 0xff,
    ...tracks.flatMap((track) => [0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track])
  ]).buffer as ArrayBuffer;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rejects(bytes: ArrayBuffer, fragment: string): void {
  try {
    parseMidi(bytes);
  } catch (error) {
    assert((error as Error).message.toLowerCase().includes(fragment.toLowerCase()), `wrong error: ${(error as Error).message}`);
    return;
  }
  throw new Error(`expected MIDI parser to reject ${fragment}`);
}

const overlapping = parseMidi(file([
  0, 0x90, 60, 100,
  0, 0x91, 60, 90,
  96, 0x80, 60, 0,
  0, 0x81, 60, 0,
  0, 0xff, 0x2f, 0
]));
assert(overlapping.notes.length === 2, 'same-pitch notes on separate channels must not overwrite each other');
assert(overlapping.notes.every((note) => note.sourceTiming?.endTick === 96), 'MIDI ticks/durations must survive import');

const sameChannelOverlap = parseMidi(file([
  0, 0x90, 60, 100,
  10, 0x90, 60, 90,
  10, 0x80, 60, 0,
  10, 0x80, 60, 0,
  0, 0xff, 0x2f, 0
]));
assert(sameChannelOverlap.notes.length === 2, 'overlapping same-channel notes must use a queue, not overwrite');
assert(sameChannelOverlap.notes[0].sourceTiming?.startTick === 0 && sameChannelOverlap.notes[0].sourceTiming?.endTick === 20, 'first same-pitch note-off paired incorrectly');
assert(sameChannelOverlap.notes[1].sourceTiming?.startTick === 10 && sameChannelOverlap.notes[1].sourceTiming?.endTick === 30, 'second same-pitch note-off paired incorrectly');

const structured = parseMidi(multiFile([
  [
    0, 0xff, 0x03, 5, 0x50, 0x69, 0x61, 0x6e, 0x6f,
    0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20,
    0, 0xff, 0x58, 4, 4, 2, 24, 8,
    0, 0x90, 60, 100,
    96, 0x80, 60, 0,
    96, 0xff, 0x58, 4, 3, 2, 24, 8,
    0, 0x90, 62, 90,
    96, 0x80, 62, 0,
    0, 0xff, 0x2f, 0
  ],
  [
    0, 0xff, 0x03, 4, 0x42, 0x61, 0x73, 0x73,
    0, 0x91, 40, 88,
    96, 0xff, 0x51, 3, 0x09, 0x27, 0xc0,
    0x82, 0x20, 0x81, 40, 0,
    0, 0xff, 0x2f, 0
  ]
]));
assert(structured.tracks.length === 2, 'format-1 MIDI must expose its note tracks for part selection');
assert(structured.tracks[0].name === 'Piano' && structured.tracks[1].name === 'Bass', 'MIDI track names were lost');
assert(structured.tempoChanges.some((change) => change.tick === 96 && Math.round(change.bpm) === 100), 'later tempo change was lost');
assert(structured.timeSignatureChanges.some((change) => change.tick === 192 && change.numerator === 3), 'later meter change was lost');
assert(structured.durationTicks === 384, 'format-1 duration ticks were not retained');
for (const track of structured.tracks) {
  const carrier = structured.notes.find((note) => note.sourceTrackIndex === track.index && note.sourceBars);
  assert(carrier?.sourceBars?.[0]?.durationTicks === 192, `track ${track.index} lost the shared bar map`);
  assert(carrier.sourceTempoChanges?.some((change) => change.tick === 96), `track ${track.index} lost the shared tempo map`);
}

// --- the notation grid must not touch an imported file's timing ---------------------------
//
// A symbolic import already says exactly when every note happened; re-quantizing it can only
// destroy information. The pipeline's exemption is in buildScore.ts (`exactSymbolicTiming`
// forces the quantizer to 'free' and turns fillGaps off whenever every note carries
// `sourceTiming`), and the reason it needs a test rather than a comment is that it is invisible
// from webcore: nothing in the UI says the grid is being ignored, so a regression would look
// like nothing at all until somebody noticed their sixteenths had become quarter notes.
//
// Sixteenths at 96 ticks per quarter, played against the most destructive override there is.
const sixteenths = parseMidi(
  file([
    0, 0x90, 60, 100, 24, 0x80, 60, 0,
    0, 0x90, 62, 100, 24, 0x80, 62, 0,
    0, 0x90, 64, 100, 24, 0x80, 64, 0,
    0, 0x90, 65, 100, 24, 0x80, 65, 0,
    0, 0xff, 0x2f, 0
  ])
);
assert(sixteenths.notes.length === 4, 'the sixteenth-note fixture did not parse');
assert(
  sixteenths.notes.every((note) => !!note.sourceTiming),
  'every imported note must carry its source ticks, or the exemption cannot apply'
);

/** Every written note as `absoluteTick:writtenDuration:pitch` — onset, value and pitch at once. */
const engraveImport = (grid: AppSettings['grid']): string[] => {
  const built = buildRiffScore(
    { notes: sixteenths.notes, audioDurationSec: sixteenths.durationSec, startOffsetSec: 0, title: 'import' },
    { ...DEFAULT_SETTINGS, grid, useHostGrid: false, tempoBpm: sixteenths.tempoBpm }
  );
  const out: string[] = [];
  for (const bar of built.ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest) continue;
        for (const note of beat.notes) out.push(`${bar.startTick + beat.startTick}:${beat.durTicks}:${note.midi}`);
      }
    }
  }
  return out;
};

const engravedFree = engraveImport('free');
assert(engravedFree.length === 4, `imported notes were lost: ${engravedFree.length} of 4 survived`);
for (const grid of ['auto', 'quarter', 'eighth', 'sixteenth'] as const) {
  const engraved = engraveImport(grid);
  assert(
    engraved.length === engravedFree.length && engraved.every((n, i) => n === engravedFree[i]),
    `notation grid '${grid}' re-wrote a symbolic import: ${engraved.join(' ')} vs ${engravedFree.join(' ')}`
  );
}

// --- a roll edit must move the SOURCE TICKS, not only the seconds -------------------------
//
// The exemption above is all-or-nothing and keyed on `sourceTiming`, which makes editing an
// imported score two silent failures waiting to happen:
//
//   1. a move/resize that copies the note (`...n`) keeps the OLD ticks, and since the exact
//      path reads ticks and ignores seconds, the engraver prints the note where it used to be
//      — the drag looks like it did nothing at all;
//   2. an ADDED note has no ticks, which flips the every-note predicate false and requantizes
//      the WHOLE import — one new note silently rewrites every other note's rhythm.
//
// Both are invisible in the note list and only show up in the engraved output, so they are
// asserted here against the engraved output, at the most destructive grid override there is.

/** Ids come from `parseMidi`: m0..m3, in time order. */
const rollCtx: RollEditContext = {
  originSec: 0,
  tempoBpm: sixteenths.tempoBpm,
  newNoteId: () => 'added1'
};

/**
 * IR ticks per quarter note, as the pipeline itself reports it.
 *
 * Read from the score rather than hardcoded, because the assertions below are written in IR
 * ticks and that resolution is not a constant of the format: it went 12 -> 24 in the tick/tie
 * migration and silently invalidated every baseline in this file. Reading it back means a
 * future change to it re-derives the arithmetic instead of failing on it, and the assertions
 * keep testing what they were written to test — where the notes are and what they are worth.
 */
let irDivisions = 0;

const engraveEdited = (notes: InputNote[]): string[] => {
  const built = buildRiffScore(
    // A fixed, generous audio length for every run: the past-end guard drops notes starting at
    // or after it, and an edit that lengthens the take must not be judged against its own end.
    { notes, audioDurationSec: 8, startOffsetSec: 0, title: 'import' },
    { ...DEFAULT_SETTINGS, grid: 'quarter', useHostGrid: false, tempoBpm: sixteenths.tempoBpm }
  );
  irDivisions = built.ir.divisions;
  const out: string[] = [];
  for (const bar of built.ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest) continue;
        for (const note of beat.notes) out.push(`${bar.startTick + beat.startTick}:${beat.durTicks}:${note.midi}`);
      }
    }
  }
  return out;
};

const roll = (edit: Parameters<typeof applyRollEditToNotes>[1], notes = sixteenths.notes): InputNote[] => {
  const result = applyRollEditToNotes(notes, edit, rollCtx);
  assert(result, `roll edit ${edit.kind} was refused`);
  return result.notes;
};

// 4 sixteenths at 96 ppq / 120 bpm: source ticks 0/24/48/72, one sixteenth apart in the IR too.
const editBaseline = engraveEdited(sixteenths.notes);

// Note VALUES, in the IR's own units — see `irDivisions`. Everything below is written in these
// rather than in literal tick counts, because the tick counts are an artefact of the IR's
// resolution and were never the thing under test.
assert(irDivisions > 0 && irDivisions % 4 === 0, `implausible IR divisions: ${irDivisions}`);
const QUARTER = irDivisions;
const EIGHTH = irDivisions / 2;
const SIXTEENTH = irDivisions / 4;
/** `absoluteTick:writtenDuration:pitch`, the shape `engraveEdited` returns. */
const at = (tick: number, dur: number, midi: number): string => `${tick}:${dur}:${midi}`;

assert(
  editBaseline.join(' ') ===
    [
      at(0, SIXTEENTH, 60),
      at(SIXTEENTH, SIXTEENTH, 62),
      at(2 * SIXTEENTH, SIXTEENTH, 64),
      at(3 * SIXTEENTH, SIXTEENTH, 65)
    ].join(' '),
  `unexpected baseline engraving: ${editBaseline.join(' ')}`
);

// MOVE — one sixteenth (0.125 s) later. Source tick 72 -> 96, so the last note lands on beat 2.
const movedOne = engraveEdited(roll({ kind: 'move', noteId: 'm3', deltaSec: 0.125, deltaSemitones: 0 }));
assert(
  movedOne.slice(0, 3).join(' ') === editBaseline.slice(0, 3).join(' '),
  `moving one note disturbed the others: ${movedOne.join(' ')}`
);
assert(
  movedOne[3] === at(QUARTER, SIXTEENTH, 65),
  `a move on a symbolic import was not engraved: ${movedOne.join(' ')} (expected the last note at ${QUARTER})`
);

// MOVE, whole selection — the `*Many` variant shares the code path and the bug.
const movedMany = engraveEdited(
  roll({ kind: 'moveMany', noteIds: ['m2', 'm3'], deltaSec: 0.25, deltaSemitones: 0 })
);
assert(
  movedMany.join(' ') ===
    [
      at(0, SIXTEENTH, 60),
      at(SIXTEENTH, SIXTEENTH, 62),
      at(QUARTER, SIXTEENTH, 64),
      at(QUARTER + SIXTEENTH, SIXTEENTH, 65)
    ].join(' '),
  `moveMany on a symbolic import was not engraved: ${movedMany.join(' ')}`
);

// RESIZE — to a quarter (0.5 s). The written value becomes a quarter note's worth of ticks,
// summed across any tie split rather than read off one beat.
const resized = engraveEdited(roll({ kind: 'resize', noteId: 'm3', newDurationSec: 0.5 }));
assert(
  resized.slice(0, 3).join(' ') === editBaseline.slice(0, 3).join(' '),
  `resizing one note disturbed the others: ${resized.join(' ')}`
);
const resizedWritten = resized
  .filter((entry) => entry.endsWith(':65'))
  .reduce((total, entry) => total + Number(entry.split(':')[1]), 0);
assert(
  resizedWritten === QUARTER,
  `a resize on a symbolic import was not engraved: ${resized.join(' ')} (written ${resizedWritten}/${QUARTER})`
);

// ADD — a written eighth at written second 0.5, i.e. source tick 96, i.e. beat 2 of the IR.
const added = engraveEdited(roll({ kind: 'add', midi: 67, startSec: 0.5, durationSec: 0.25 }));
assert(
  added.slice(0, 4).join(' ') === editBaseline.join(' '),
  `adding a note requantized the rest of the import: ${added.join(' ')}`
);
assert(
  added.length === 5 && added[4] === at(QUARTER, EIGHTH, 67),
  `the added note is not at its roll-grid position: ${added.join(' ')}`
);

// DELETE — the deleted note must not take the source bar/meter map down with it. Only the
// FIRST note of each track carries it (see midiFile.ts), so deleting note 1 of a 3/4 import
// used to hand the whole score back to meter detection, which prints 4/4.
const threeFour = parseMidi(
  file([
    0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20,
    0, 0xff, 0x58, 4, 3, 2, 24, 8,
    0, 0x90, 60, 100, 96, 0x80, 60, 0,
    0, 0x90, 62, 100, 96, 0x80, 62, 0,
    0, 0x90, 64, 100, 96, 0x80, 64, 0,
    0, 0x90, 65, 100, 96, 0x80, 65, 0,
    0, 0x90, 67, 100, 96, 0x80, 67, 0,
    0, 0x90, 69, 100, 96, 0x80, 69, 0,
    0, 0xff, 0x2f, 0
  ])
);
assert(threeFour.notes[0].sourceBars?.length === 2, 'the 3/4 fixture did not produce a two-bar source map');
const meterOf = (notes: InputNote[]): string => {
  const built = buildRiffScore(
    { notes, audioDurationSec: 8, startOffsetSec: 0, title: 'import' },
    { ...DEFAULT_SETTINGS, useHostGrid: false, tempoBpm: threeFour.tempoBpm }
  );
  return `${built.timeSignature.numerator}/${built.timeSignature.denominator}`;
};
assert(meterOf(threeFour.notes) === '3/4', `the 3/4 fixture did not import as 3/4: ${meterOf(threeFour.notes)}`);
const afterDelete = applyRollEditToNotes(threeFour.notes, { kind: 'delete', noteId: 'm0' }, rollCtx);
assert(afterDelete && afterDelete.notes.length === 5, 'delete did not remove exactly one note');
assert(
  meterOf(afterDelete.notes) === '3/4',
  `deleting the structure carrier lost the source meter: ${meterOf(afterDelete.notes)}`
);
assert(
  afterDelete.notes.every((note) => !!note.sourceTiming),
  'delete must not disturb the surviving notes exact timing'
);

rejects(file([0x81, 0x80, 0x80, 0x80, 0x00]), 'variable-length');

const badLength = new Uint8Array(file([]));
badLength[18] = 0x7f;
rejects(badLength.buffer as ArrayBuffer, 'too large');

rejects(file([], 0), 'ticks-per-quarter');

globalThis.console?.log('midi-import-test: passed');
