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

// ---------------------------------------------------------------------------
// P8 — THE KEY SIGNATURE IS ON EVERY BAR OF EVERY STAFF
// ---------------------------------------------------------------------------
//
// THE FAULT, photographed: a key signature printed on the treble staff of a grand system and
// nowhere else. `fromPipeline` assigned `MasterBar.keySignature`, which reads like a property of
// the master bar and, in the pinned alphaTab, is a DEPRECATED setter whose entire body writes
// `score.tracks[0].staves[0].bars[index]`. One bar out of two, three or six.
//
// Checked on the MODEL rather than on a rendering, because that is where the fault was and a
// screenshot cannot say which of six bars carries the value. The engraved proof is the
// grand-mode screenshot the wave also produces; this is the one that fails on a regression.
{
  const keyed = (fifths: number, clefMode: BuildSettings['clefMode'], tab = false): alphaTab.model.Score =>
    buildAlphaTabScore(
      buildScore(
        {
          notes: [
            { id: 'lo', startSec: 0, endSec: 0.45, midi: 48 },
            { id: 'hi', startSec: 0.5, endSec: 0.95, midi: 72 }
          ],
          beats: [0, 0.5, 1, 1.5, 2]
        },
        tab
          ? { ...settings, clefMode, keyFifths: fifths, instrument: 'bass4', tuningMidi: [28, 33, 38, 43] }
          : { ...settings, clefMode, keyFifths: fifths }
      ).toAlphaTabModelData(),
      new alphaTab.Settings()
    ).score;

  for (const [label, score] of [
    ['grand', keyed(3, 'grand')],
    ['grand + tab', keyed(-2, 'grand', true)],
    ['treble', keyed(3, 'treble')]
  ] as Array<[string, alphaTab.model.Score]>) {
    const staves = score.tracks.flatMap((t) => t.staves);
    assert(staves.length >= 1, `${label}: the score has staves`);
    const wanted = staves[0].bars[0].keySignature;
    assert(
      wanted !== alphaTab.model.KeySignature.C || label === 'treble',
      `${label}: the fixture actually asks for a key signature (got ${wanted})`
    );
    for (let s = 0; s < staves.length; s++) {
      for (let b = 0; b < staves[s].bars.length; b++) {
        assert(
          staves[s].bars[b].keySignature === wanted,
          `${label}: staff ${s} bar ${b} has key ${staves[s].bars[b].keySignature}, wanted ${wanted}` +
            ' — this is the bug where only track 0 / staff 0 was written'
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ...AND IT CHANGES NOTHING THAT MAKES A SOUND (fromPipeline is sound-sacred)
// ---------------------------------------------------------------------------
//
// The playback dump, either side of a key change: every note's sounding value and every beat's
// place and length on the playback timeline. A key signature is an ENGRAVING instruction — it
// tells the reader which accidentals are assumed — and if any of it reached the tick cache or a
// `realValue` this comparison is what says so.
{
  const dump = (fifths: number): string => {
    const score = buildAlphaTabScore(
      buildScore(
        {
          notes: [
            { id: 'a', startSec: 0, endSec: 0.45, midi: 48 },
            { id: 'b', startSec: 0.5, endSec: 0.95, midi: 55 },
            { id: 'c', startSec: 1, endSec: 1.95, midi: 72 }
          ],
          beats: [0, 0.5, 1, 1.5, 2]
        },
        { ...settings, clefMode: 'grand', keyFifths: fifths }
      ).toAlphaTabModelData(),
      new alphaTab.Settings()
    ).score;
    const rows: string[] = [];
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        for (const bar of staff.bars) {
          for (const voice of bar.voices) {
            for (const beat of voice.beats) {
              rows.push(
                `${beat.absolutePlaybackStart}/${beat.playbackDuration}/${beat.notes
                  .map((n) => `${n.realValue}:${n.isTieDestination ? 't' : '-'}`)
                  .join(',')}`
              );
            }
          }
        }
      }
    }
    return rows.join('|');
  };
  assert(
    dump(0) === dump(4) && dump(0) === dump(-5),
    'the key signature must not move a tick or change a sounding pitch — fromPipeline is sound-sacred'
  );
}

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
