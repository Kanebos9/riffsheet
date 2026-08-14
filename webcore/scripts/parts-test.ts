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
  cleanPartName,
  importedPartName,
  legacyDerivedLivePartName,
  LIVE_PART_ID,
  livePartName,
  MAX_PART_NAME_LENGTH,
  nudgeStepMs,
  orderedPartSlots,
  restoredLivePartName,
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

const liveFirst = buildPartedRiffScore(
  request,
  settings,
  orderedPartSlots([guitar], [LIVE_PART_ID, 'imp1'], 'Take')
);

assert(liveFirst.data.tracks.length === 2, 'two parts produce two alphaTab tracks');
assert(liveFirst.data.tracks[0].notationOnly !== true, 'the live track is playable');
assert(liveFirst.data.tracks[1].notationOnly === true, 'the imported track is notation-only');
assert(liveFirst.parts.map((p) => p.role).join(',') === 'live,imported', 'the roles are in printed order');
// Old claim: "both parts are named" meant `Bass,Guitar`, because the live name followed TAB.
// P4 makes the first word canonical; instrument settings cannot rename it.
assert(liveFirst.parts[0].name === 'Take' && liveFirst.parts[1].name === 'Guitar', 'both parts are named');
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
// Old claim: MusicXML listed `Bass,Guitar`; it must now carry the same canonical `Take,Guitar`
// pair the page and part control use.
assert(names.length === 2 && names[0] === 'Take' && names[1] === 'Guitar', `MusicXML lists both parts (${names})`);
assert(liveFirst.midi(true).byteLength > 0, 'the MIDI export writes every part');

// ---------------------------------------------------------------------------
// 2. Reordered: the guitar on top, and the live ids UNMOVED
// ---------------------------------------------------------------------------
//
// This is the check the whole file exists for. The pipeline would have given the live take the
// prefix `p2-` here, because it is the second row.

const guitarFirst = buildPartedRiffScore(
  request,
  settings,
  orderedPartSlots([guitar], ['imp1', LIVE_PART_ID], 'Take')
);

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
const aloneNamed = buildPartedRiffScore(request, settings, orderedPartSlots(undefined, undefined, 'Take'));
assert(alone.data.tracks.length === 1, 'a take on its own is one track');
assert(JSON.stringify(aloneNamed.ir) === JSON.stringify(alone.ir), 'the named one-part path keeps the IR byte-identical');
assert(
  JSON.stringify(aloneNamed.data.tracks[0].staves) === JSON.stringify(alone.data.tracks[0].staves),
  'the named one-part path keeps every engraved bar, beat and rational duration byte-identical'
);
assert(aloneNamed.musicxml().includes('<part-name>Take</part-name>'), 'the named one-part path exports its canonical name');
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

// A NUDGE IS STILL ROUNDED TO THE FINEST UNIT NOTATION CAN SPELL — the PIPELINE does it now
// (`nudgeNote`, pipeline/multipart.ts), in the written domain and against the `displayBpm` that
// build actually computed. So it is asserted on what comes out of a build rather than on a
// rounding helper: the helper that used to do it (`snapNudgeMs`) is off the build path, and a
// test of it would no longer be a test of the page.
//
// The box's arrows still step by a 1/32, which at 96 BPM is 78.125 ms.
assert(Math.abs(nudgeStepMs(96) - 78.125) < 1e-9, 'the nudge box steps by exactly a 32nd');
assert(liveFirst.tempoBpm === 96, `the fixture builds at 96 BPM, which the numbers below are of (${liveFirst.tempoBpm})`);

// THE ROUNDING, SEEN FROM OUTSIDE: the shift lands on a whole 1/32 or it does not happen. Half a
// 1/32 is 39.0625 ms here, so 39 ms leaves the imported part's engraving byte-identical and 40 ms
// moves it. That threshold is the signature of a round-to-NEAREST-32nd, and it sits at half a
// 1/32 of THIS score's display tempo — the number only the build knows, which is why the rounding
// is the build's to do.
const halfThirtysecond = nudgeStepMs(liveFirst.tempoBpm) / 2;
const printedPart = (ms: number): string =>
  JSON.stringify(
    buildPartedRiffScore(request, settings, orderedPartSlots([{ ...guitar, nudgeMs: ms }], [LIVE_PART_ID, 'imp1']))
      .data.tracks[1]
  );
const unnudgedPart = JSON.stringify(liveFirst.data.tracks[1]);
assert(printedPart(Math.floor(halfThirtysecond)) === unnudgedPart, 'a nudge under half a 32nd does not move the printed part');
assert(printedPart(Math.ceil(halfThirtysecond)) !== unnudgedPart, 'a nudge over half a 32nd moves it by one');

// AND WHAT IT LOOKS LIKE ON THE PAGE: every `<duration>` in the moved part is a whole number of
// 32nds — `duration / divisions` quarters is a multiple of 1/8. That is the invariant a printable
// shift preserves and an arbitrary one breaks: a part that lands between two printable positions
// leaves the tail of a bar as a one- or two-tick crumb, which the emitter refuses outright. The
// export therefore has to survive as well as satisfy the arithmetic, so both are asserted.
const importedDurations = (score: typeof liveFirst): { divisions: number; durations: number[] } => {
  const xml = score.musicxml();
  const cut = xml.indexOf('<part id="P2"');
  const body = cut >= 0 ? xml.slice(cut) : '';
  const divisions = Number((body.match(/<divisions>(\d+)<\/divisions>/) ?? xml.match(/<divisions>(\d+)<\/divisions>/))?.[1] ?? 0);
  return { divisions, durations: [...body.matchAll(/<duration>(\d+)<\/duration>/g)].map((m) => Number(m[1])) };
};

// One typed value far under a 1/32 and one that is a whole 1/32 at this tempo — the two ends the
// rounding has to handle, and the box only ever stores whole milliseconds.
for (const ms of [10, Math.round(nudgeStepMs(liveFirst.tempoBpm))]) {
  const built = buildPartedRiffScore(request, settings, orderedPartSlots([{ ...guitar, nudgeMs: ms }], [LIVE_PART_ID, 'imp1']));
  let printed: { divisions: number; durations: number[] } = { divisions: 0, durations: [] };
  let threw = false;
  try {
    printed = importedDurations(built);
    built.midi(true);
    built.midi(false);
  } catch {
    threw = true;
  }
  assert(!threw, `a ${ms} ms nudge exports without the emitter refusing it`);
  assert(printed.durations.length > 0, `a ${ms} ms nudge still prints the imported part`);
  assert(
    printed.divisions > 0 && printed.durations.every((d) => (d * 8) % printed.divisions === 0),
    `a ${ms} ms nudge leaves every printed value a whole 32nd (divisions ${printed.divisions})`
  );
}

// THE SWEEP, and it is the reason the rounding exists. An unrounded nudge slides the part's
// written ticks off the printable lattice and the last note in a bar comes out as a one-tick
// crumb, which the MusicXML emitter refuses outright ("<type>32nd</type> is 3 ticks but
// <duration> is 1"). Measured before the fix: every value here except 0 and ±10 ms threw.
//
// These are raw typed milliseconds, none of them a whole 1/32 of anything — which is the point.
// The app hands them to the pipeline exactly as it got them, so what this sweeps now is the snap
// in `nudgeNote`, against the tempo the build really chose rather than one the caller guessed.
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

// ---------------------------------------------------------------------------
// 6. The live part's NAME — canonical, with old derivation isolated to legacy migration (P4)
// ---------------------------------------------------------------------------

// Old claim: "a bass take is called Bass when nobody has said otherwise". Instrument choice no
// longer owns naming; an absent canonical value is the safe fixed default.
assert(livePartName(settings) === 'Take', 'an absent canonical name resolves safely to Take');
assert(livePartName(settings, 'Rhythm gtr') === 'Rhythm gtr', 'a stored name wins over the instrument');
assert(
  livePartName({ ...settings, tabMode: 'guitar', clefMode: 'grand' }, 'Rhythm gtr') === 'Rhythm gtr',
  'instrument, TAB and clef changes cannot rename a canonical live part'
);
// Old claim: whitespace fell back to `Bass`; clearing now resets to the stable `Take` default.
assert(livePartName(settings, '   ') === 'Take', 'a name of nothing but spaces resets to Take');
// Old claim: an absent override fell back to `Bass`; absence now exists only before migration.
assert(livePartName(settings, undefined) === 'Take', 'an absent legacy value has a stable fallback');
assert(legacyDerivedLivePartName(settings) === 'Bass', 'legacy migration can reproduce the former Bass name once');
assert(
  restoredLivePartName(settings, undefined) === 'Bass',
  'an absent legacy document name freezes only after its saved bass settings are effective'
);
assert(
  restoredLivePartName({ ...settings, tabMode: 'guitar' }, 'Low end') === 'Low end',
  'an explicit persisted name survives different effective instrument settings exactly'
);
assert(
  livePartName(settings, 'x'.repeat(200)).length === MAX_PART_NAME_LENGTH,
  'an over-long name is bounded rather than printed'
);
assert(cleanPartName('  Low end  ') === 'Low end', 'names are trimmed on the way in');
assert(cleanPartName(undefined) === '', 'an absent name cleans to nothing');
assert(importedPartName(undefined, 'Guitar demo.musicxml') === 'Guitar demo', 'a file name names a part');

// The override travels on the slot, so one resolved list feeds the menu AND the build.
const namedSlots = orderedPartSlots(undefined, undefined, ' Low end ');
assert(namedSlots.length === 1 && namedSlots[0].kind === 'live', 'a renamed take is still one slot');
assert(
  namedSlots[0].kind === 'live' && namedSlots[0].name === 'Low end',
  'the slot carries the cleaned override'
);
assert(
  orderedPartSlots(undefined, undefined, '  ')[0].kind === 'live' &&
    (orderedPartSlots(undefined, undefined, '  ')[0] as { name?: string }).name === undefined,
  'an empty override leaves the slot with no name at all'
);

// …and it reaches the page and the file. A one-part build is the case that matters: it is the
// commonest document this app makes and the one `buildScore` cannot name.
const renamed = buildPartedRiffScore(request, settings, orderedPartSlots(undefined, undefined, 'Low end'));
assert(renamed.data.tracks.length === 1, 'a renamed take is still a one-track score');
assert(renamed.data.tracks[0].name === 'Low end', 'the engraved track carries the typed name');
assert(renamed.parts[0].name === 'Low end', 'so does the parts sidecar the UI reads');
assert(
  renamed.musicxml().includes('<part-name>Low end</part-name>'),
  'and so does the exported MusicXML'
);
// The abbreviation is DERIVED from the new name, never sliced off a stale one.
assert(
  renamed.data.tracks[0].shortName === 'Low end',
  `a short name is printed whole (got ${renamed.data.tracks[0].shortName})`
);
const renamedLong = buildPartedRiffScore(
  request,
  settings,
  orderedPartSlots(undefined, undefined, 'Rhythm guitar')
);
assert(
  renamedLong.data.tracks[0].shortName === 'Rhyt. Gtr.',
  `a long name abbreviates by the pipeline's rule (got ${renamedLong.data.tracks[0].shortName})`
);
// Two parts: the live half follows the override, the imported half is untouched by it.
const bothNamed = buildPartedRiffScore(
  request,
  settings,
  orderedPartSlots([guitar], [LIVE_PART_ID, 'imp1'], 'Low end')
);
assert(
  bothNamed.parts.map((p) => p.name).join(',') === 'Low end,Guitar',
  'the override names the take and only the take'
);

if (failures > 0) {
  console.error(`\nparts-test: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('parts-test: all assertions passed');
