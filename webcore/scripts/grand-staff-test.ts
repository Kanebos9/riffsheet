import * as alphaTab from '@coderline/alphatab';
import { buildScore, type BuildSettings } from '../../pipeline/src/index';
import { parseScoreFile, scoreToInputNotes } from '../src/import/scoreFile';
import { buildAlphaTabScore } from '../src/score/fromPipeline';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rejectsScore(bytes: Uint8Array, fragment: string): void {
  try {
    parseScoreFile(bytes);
  } catch (error) {
    assert((error as Error).message.toLowerCase().includes(fragment.toLowerCase()), `wrong score-import error: ${(error as Error).message}`);
    return;
  }
  throw new Error(`expected score importer to reject ${fragment}`);
}

const settings: BuildSettings = {
  grid: '1/8',
  fillGaps: true,
  instrument: 'staff',
  tuningMidi: [],
  fingeringStyle: 'minMovement',
  clefMode: 'grand'
};

const built = buildScore({
  notes: [
    { id: 'low', startSec: 0, endSec: 0.45, midi: 48 },
    { id: 'middle', startSec: 0.5, endSec: 0.95, midi: 60 },
    { id: 'high', startSec: 1, endSec: 1.45, midi: 84 }
  ],
  beats: [0, 0.5, 1, 1.5, 2]
}, settings);
const data = built.toAlphaTabModelData();
assert(data.tracks[0].staves.length === 2, 'grand DTO must contain two real staves');
assert(data.tracks[0].staves.every((staff) => staff.showStandardNotation && !staff.showTablature), 'grand staves must both be standard notation');

const live = buildAlphaTabScore(data, new alphaTab.Settings());
assert(live.score.tracks[0].staves.length === 2, 'fromPipeline must construct two live alphaTab staves');
const middle = [...live.index.noteToInfo].find(([, info]) => info.id === 'middle')?.[0];
assert(middle?.realValue === 60, 'middle C must remain sounding MIDI 60 in the live alphaTab model');
assert(middle.octave === 5 && middle.tone === 0, 'alphaTab middle C contract is octave 5/tone 0');

const omr = buildScore({
  notes: [{ id: 'written-c4', startSec: 0, endSec: 0.45, midi: 48, displayPitchOffset: 12 }],
  beats: [0, 0.5, 1, 1.5, 2]
}, { ...settings, clefMode: 'treble' });
const omrLive = buildAlphaTabScore(omr.toAlphaTabModelData(), new alphaTab.Settings());
const writtenC4 = [...omrLive.index.noteToInfo].find(([, info]) => info.id === 'written-c4')?.[0];
assert(writtenC4?.realValue === 48, 'written-octave interpretation must keep canonical playback at sounding C3');
assert(writtenC4.displayValue === 60, 'written-octave interpretation must preserve the printed C4');

// A symbolic source's playback transposition belongs at the ingest boundary. displayTransposition
// is recorded separately so it affects only engraving and can never be subtracted twice.
const sourceScore = live.score;
const sourceStaff = sourceScore.tracks[0].staves[0];
// alphaTab stores playback transposition as the amount subtracted from written pitch.
sourceStaff.transpositionPitch = 12;
sourceStaff.displayTranspositionPitch = -12;
const imported = scoreToInputNotes(sourceScore, { trackIndexes: [0], idPrefix: 'transposed' });
const importedMiddle = imported.notes.find((note) => note.staffIndex === 0 && note.midi === 48);
assert(importedMiddle?.midi === 48, 'symbolic source playback transposition must be applied exactly once');
assert(importedMiddle.sourceTranspositionPitch === 12, 'source playback transposition metadata must survive import');
assert(importedMiddle.displayPitchOffset === 12, 'source written-octave display metadata must stay separate');

rejectsScore(new Uint8Array(), 'empty');
rejectsScore(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'directory is missing');

// One syntactically complete ZIP directory whose single entry claims >128 MiB expanded.
const zipBombHeader = new Uint8Array(30 + 46 + 22);
const zipBombView = new DataView(zipBombHeader.buffer);
zipBombView.setUint32(0, 0x04034b50, true);
zipBombView.setUint32(30, 0x02014b50, true);
zipBombView.setUint32(30 + 24, 128 * 1024 * 1024 + 1, true);
zipBombView.setUint32(30 + 42, 0, true);
zipBombView.setUint32(76, 0x06054b50, true);
zipBombView.setUint16(76 + 8, 1, true);
zipBombView.setUint16(76 + 10, 1, true);
zipBombView.setUint32(76 + 12, 46, true);
zipBombView.setUint32(76 + 16, 30, true);
rejectsScore(zipBombHeader, 'expands beyond');

globalThis.console?.log('grand-staff-test: passed');
