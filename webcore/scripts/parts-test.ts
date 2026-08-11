/**
 * PARTS — several instruments on one sheet, checked where a browser is not needed.
 *
 * `scripts/verify.mjs` drives the chips, the file picker and the engraving. This checks the half
 * underneath them, which is where the two things that could go silently wrong live:
 *
 *   1. NOTE IDS. The pipeline namespaces parts by ROW (`p2-`, `p3-`, …), so dragging the guitar
 *      above the bass would rename every id the LIVE take owns — and the app's selection, its
 *      edit log and the performance the synth is retimed from are all keyed on those ids.
 *      `score/parts.ts` puts them back on the app's own namespace; if that ever stops happening,
 *      the symptom in the product is a take that silently loses its edits and its human timing
 *      when a chip is dragged, which is not a thing anybody would think to look for.
 *   2. WHAT IS PLAYED. An imported part must be flagged `notationOnly` on the data the sheet is
 *      built from, because that flag is the only thing standing between "reference chart" and
 *      "second instrument playing over your take".
 *
 * Run: npm run test:parts
 */

import { buildRiffScore, type BuildRequest } from '../src/pipeline';
import {
  buildPartedRiffScore,
  LIVE_PART_ID,
  nudgeStepMs,
  orderedPartSlots,
  snapNudgeMs,
  type ImportedPart
} from '../src/score/parts';
import { parseScoreFile } from '../src/import/scoreFile';
import { GUITAR_PART_MUSICXML, tripletRiff } from '../src/score/fixtures';
import { DEFAULT_SETTINGS } from '../src/app/state';

let failures = 0;
function assert(ok: boolean, what: string): void {
  if (ok) return;
  failures++;
  console.error(`FAIL ${what}`);
}

const take = tripletRiff(4);
const request: BuildRequest = {
  notes: take.notes,
  beats: take.beats,
  audioDurationSec: take.durationSec,
  startOffsetSec: 0,
  title: 'Take'
};
const settings = { ...DEFAULT_SETTINGS, tabMode: 'bass' as const, instrument: 'bass' as const };

const parsed = parseScoreFile(new TextEncoder().encode(GUITAR_PART_MUSICXML));
assert(parsed.notes.length === 16, `the fixture parses to 16 notes (got ${parsed.notes.length})`);
assert(parsed.tracks[0]?.name === 'Guitar', `the part names itself from <part-name> (got ${parsed.tracks[0]?.name})`);
assert(
  parsed.notes.every((note) => !!note.sourceTiming),
  'every imported note carries its written ticks'
);

const guitar: ImportedPart = { id: 'imp1', name: 'Guitar', nudgeMs: 0, notes: parsed.notes };

// ---------------------------------------------------------------------------
// 1. Two parts, live on top
// ---------------------------------------------------------------------------

const liveFirst = buildPartedRiffScore(request, settings, orderedPartSlots([guitar], [LIVE_PART_ID, 'imp1']));

assert(liveFirst.data.tracks.length === 2, 'two parts produce two alphaTab tracks');
assert(liveFirst.data.tracks[0].notationOnly !== true, 'the live track is playable');
assert(liveFirst.data.tracks[1].notationOnly === true, 'the imported track is notation-only');
assert(liveFirst.parts.map((p) => p.role).join(',') === 'live,imported', 'the roles are in printed order');
assert(liveFirst.parts[0].name === 'Bass' && liveFirst.parts[1].name === 'Guitar', 'both parts are named');
assert(liveFirst.parts[0].idPrefix === '' && liveFirst.parts[1].idPrefix === 'imp1~', 'prefixes are per part');

const idsOf = (score: typeof liveFirst, track: number): string[] => {
  const out: string[] = [];
  for (const staff of score.data.tracks[track].staves) {
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) for (const note of beat.notes) out.push(note.id);
      }
    }
  }
  return out;
};

assert(
  idsOf(liveFirst, 0).every((id) => id.startsWith('f')),
  'the live take keeps the ids the performance gave it'
);
assert(
  idsOf(liveFirst, 1).every((id) => id.startsWith('imp1~')),
  'the imported part is namespaced by its own document id'
);

const xml = liveFirst.musicxml();
const names = [...xml.matchAll(/<part-name>([^<]*)<\/part-name>/g)].map((m) => m[1]);
assert(names.length === 2 && names[0] === 'Bass' && names[1] === 'Guitar', `MusicXML lists both parts (${names})`);
assert(liveFirst.midi(true).byteLength > 0, 'the MIDI export writes every part');

// ---------------------------------------------------------------------------
// 2. Reordered: the guitar on top, and the live ids UNMOVED
// ---------------------------------------------------------------------------
//
// This is the check the whole file exists for. The pipeline would have given the live take the
// prefix `p2-` here, because it is the second row.

const guitarFirst = buildPartedRiffScore(request, settings, orderedPartSlots([guitar], ['imp1', LIVE_PART_ID]));

assert(guitarFirst.parts[0].name === 'Guitar', 'a dragged chip changes the printed order');
assert(
  idsOf(guitarFirst, 1).every((id) => id.startsWith('f')),
  'the live take keeps its bare ids even when it prints second'
);
assert(
  idsOf(guitarFirst, 0).every((id) => id.startsWith('imp1~')),
  'the imported part keeps its own namespace wherever it prints'
);
assert(
  JSON.stringify(idsOf(liveFirst, 0)) === JSON.stringify(idsOf(guitarFirst, 1)),
  'reordering does not renumber one note of the take'
);
assert(guitarFirst.data.tracks[0].notationOnly === true, 'notation-only follows the part, not the row');
const reorderedNames = [...guitarFirst.musicxml().matchAll(/<part-name>([^<]*)<\/part-name>/g)].map((m) => m[1]);
assert(reorderedNames[0] === 'Guitar', 'the export follows the order too');

// The live IR is the LIVE part's, wherever it printed: same tempo, same bars, same engraving.
assert(
  liveFirst.tempoBpm === guitarFirst.tempoBpm && liveFirst.ir.bars.length === guitarFirst.ir.bars.length,
  'the live part is engraved the same whichever row it is on'
);

// ---------------------------------------------------------------------------
// 3. The take on its own is untouched by any of it
// ---------------------------------------------------------------------------
//
// Not merely equal: `App.buildScoreFrom` does not route a single-part take through the parts
// path at all. This asserts the property that makes that safe — a one-part document engraves the
// same take, at the same tempo, with the same ids, as the parts path would.

const alone = buildRiffScore(request, settings);
assert(alone.data.tracks.length === 1, 'a take on its own is one track');
assert(alone.tempoBpm === liveFirst.tempoBpm, 'adding a part does not change the take’s tempo');
assert(
  JSON.stringify(alone.data.tracks[0].staves.map((s) => s.bars.length)) ===
    JSON.stringify(liveFirst.data.tracks[0].staves.map((s) => s.bars.length)),
  'adding a part does not change the take’s staves'
);
assert(alone.data.tracks[0].notationOnly === undefined, 'a single-part score carries no notation-only flag');

// THE TAKE IS THE DOCUMENT, AND ITS CLOCK IS THE DOCUMENT'S CLOCK (`referenceNotes`). A
// reference chart carries its source file's whole bar and tempo map, which the pipeline would
// otherwise adopt for the WHOLE score — the reported symptom being a page that re-letters itself
// at the chart's default 120 the moment a part is added to a take at 96.
const perMinute = (score: typeof alone) =>
  [...score.musicxml().matchAll(/<per-minute>([^<]*)<\/per-minute>/g)].map((m) => m[1]);
assert(
  liveFirst.data.tempo === alone.data.tempo && guitarFirst.data.tempo === alone.data.tempo,
  'adding a part does not re-tempo the page'
);
assert(
  JSON.stringify(liveFirst.data.tempoChanges) === JSON.stringify([{ tick: 0, bpm: alone.tempoBpm }]),
  'and it does not smuggle the chart’s tempo in as a change'
);
assert(
  JSON.stringify(perMinute(liveFirst)) === JSON.stringify(perMinute(alone)) &&
    JSON.stringify(perMinute(guitarFirst)) === JSON.stringify(perMinute(alone)),
  'the printed metronome mark is the take’s, whichever part is on top'
);
assert(
  liveFirst.data.masterBars.length === alone.data.masterBars.length,
  'and the chart’s bar map does not replace the take’s'
);

// ---------------------------------------------------------------------------
// 4. The nudge moves one part and nothing else
// ---------------------------------------------------------------------------

const nudged = buildPartedRiffScore(
  request,
  settings,
  orderedPartSlots([{ ...guitar, nudgeMs: 500 }], [LIVE_PART_ID, 'imp1'])
);
assert(
  JSON.stringify(idsOf(nudged, 0)) === JSON.stringify(idsOf(liveFirst, 0)),
  'nudging a part leaves the take alone'
);
assert(
  JSON.stringify(nudged.data.tracks[1]) !== JSON.stringify(liveFirst.data.tracks[1]),
  'nudging a part moves it'
);

// A nudge is rounded to the finest unit notation can spell — see `snapNudgeMs`. At 96 BPM a
// 1/32 is 78.125 ms, so 60 ms is a 1/32 and 10 ms is nothing at all.
assert(Math.abs(snapNudgeMs(60, 96) - 78.125) < 1e-9, 'a nudge rounds to a whole 32nd');
assert(snapNudgeMs(10, 96) === 0 && snapNudgeMs(0, 96) === 0, 'a nudge under half a 32nd is no nudge');
assert(Math.abs(nudgeStepMs(96) - 78.125) < 1e-9, 'and the box steps by exactly that');

// THE SWEEP, and it is the reason the rounding exists. An unrounded nudge slides the part's
// written ticks off the printable lattice and the last note in a bar comes out as a one-tick
// crumb, which the MusicXML emitter refuses outright ("<type>32nd</type> is 3 ticks but
// <duration> is 1"). Measured before the fix: every value here except 0 and ±10 ms threw.
let sweepFailures = 0;
for (let ms = -400; ms <= 400; ms += 13) {
  for (const order of [[LIVE_PART_ID, 'imp1'], ['imp1', LIVE_PART_ID]]) {
    try {
      const built = buildPartedRiffScore(request, settings, orderedPartSlots([{ ...guitar, nudgeMs: ms }], order));
      built.musicxml();
      built.midi(true);
      built.midi(false);
    } catch {
      sweepFailures++;
    }
  }
}
assert(sweepFailures === 0, `every nudge from -400 to +400 ms engraves and exports (${sweepFailures} failed)`);

// ---------------------------------------------------------------------------
// 5. `orderedPartSlots` reconciles whatever a document actually holds
// ---------------------------------------------------------------------------

assert(orderedPartSlots(undefined, undefined).length === 1, 'no parts is the live take alone');
assert(orderedPartSlots([guitar], undefined)[0].kind === 'live', 'a missing order prints the take first');
assert(orderedPartSlots([guitar], ['ghost', 'imp1']).length === 2, 'an order naming a part that is gone still opens');
assert(
  orderedPartSlots([guitar], ['imp1', 'imp1', LIVE_PART_ID]).length === 2,
  'a duplicated order entry is counted once'
);
assert(
  orderedPartSlots([guitar], ['imp1'])[0].kind === 'live',
  'an order that forgot the live take gets it back, at the top'
);

if (failures > 0) {
  console.error(`\nparts-test: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('parts-test: all assertions passed');
