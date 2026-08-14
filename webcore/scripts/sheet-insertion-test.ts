/**
 * The always-forward sheet insertion law, outside the browser.
 *
 * This is deliberately separate from `src/edit/ripple.test.ts`: the required edit-unit floor has
 * a fixed 65-check count, while this new persisted operation needs its own acceptance matrix.
 */

import type { InputNote } from '@pipeline';
import { quantizeOnsets } from '@pipeline-impl';
import { decodeSource, encodeSource } from '../src/app/persist';
import { DEFAULT_SETTINGS, type SourceAudio } from '../src/app/state';
import { buildRiffScore } from '../src/pipeline';
import {
  applyRippleOps,
  nextRippleOperationId,
  notationIntentMatchingSpan,
  planSheetInsertion,
  rational,
  ratValue,
  rippleEndTick,
  rippleOpForForeignPart,
  rippleWindow,
  sheetInsertionBarAtTick,
  sheetInsertionBeatTicks,
  sheetInsertionGridTicks,
  sheetInsertionSnapTick,
  type RippleOp,
  type RippleTickMap,
  unrippleNotes,
  withRollPlacements
} from '../src/edit/ripple';

let checks = 0;
let failures = 0;

function check(label: string, condition: unknown, detail: unknown = null): void {
  checks++;
  const ok = !!condition;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === null ? '' : `  — ${JSON.stringify(detail)}`}`);
}

const DIVISIONS = 24;
const flat: RippleTickMap = { toTick: (sec) => sec * 48, toSec: (tick) => tick / 48 };
const changeTick = 96;
const changeSec = changeTick / 48;
const tempoMap: RippleTickMap = {
  toTick: (sec) => (sec <= changeSec ? sec * 48 : changeTick + (sec - changeSec) * 24),
  toSec: (tick) => (tick <= changeTick ? tick / 48 : changeSec + (tick - changeTick) / 24)
};
const note = (id: string, startTick: number, endTick: number, map = flat, midi = 60): InputNote => ({
  id,
  midi,
  startSec: map.toSec(startTick),
  endSec: map.toSec(endTick)
});
const ticks = (n: InputNote | undefined, map = flat): [number, number] | null =>
  n ? [Number(map.toTick(n.startSec).toFixed(6)), Number(map.toTick(n.endSec).toFixed(6))] : null;

check('Auto sheet placement defaults to a 1/16 lattice', sheetInsertionGridTicks('auto', 24) === 6);
check('Free sheet placement also retains the 1/16 add lattice', sheetInsertionGridTicks('free', 24) === 6);
check('an explicitly active 1/32 grid is honoured', sheetInsertionGridTicks('thirtysecond', 24) === 3);

const mixedMeterBars = [
  { startTick: 0, durTicks: 96, timeSig: [4, 4] as [number, number] },
  { startTick: 96, durTicks: 72, timeSig: [6, 8] as [number, number] }
];
check('an internal barline belongs to the bar on its right', sheetInsertionBarAtTick(mixedMeterBars, 96) === mixedMeterBars[1]);
const finalEdgeBar = sheetInsertionBarAtTick(mixedMeterBars, 168);
check('the final right edge inherits the final bar meter', finalEdgeBar === mixedMeterBars[1]);
check('the final edge of a 6/8 score authors the local eighth beat', sheetInsertionBeatTicks(finalEdgeBar, DIVISIONS) === 12);
check('a point beyond the score invents no containing bar', sheetInsertionBarAtTick(mixedMeterBars, 169) === null);
const fiveEight = { startTick: 0, durTicks: 60, timeSig: [5, 8] as [number, number] };
check(
  'a coarse quarter grid clamps an odd-meter final edge to the bar, not past it',
  sheetInsertionSnapTick(fiveEight, 60, 24) === 60
);
check(
  'the clamped 5/8 final edge keeps its local eighth-note default',
  sheetInsertionBeatTicks(sheetInsertionBarAtTick([fiveEight], sheetInsertionSnapTick(fiveEight, 60, 24)), DIVISIONS) === 12
);

{
  const quantized = quantizeOnsets(
    [
      { id: 'left', rawStartTick: 0, rawOffTick: 4 },
      { id: 'sheet', rawStartTick: 6, rawOffTick: 30, fixedStartTick: 6, intentTicks: 24 },
      { id: 'right', rawStartTick: 24, rawOffTick: 30 }
    ],
    { grid: '1/8', ticksPerBeat: DIVISIONS, compound: false, totalTicks: 96 }
  );
  check(
    'an editor-authored onset survives a coarser quantizer grid',
    quantized.notes.find((event) => event.id === 'sheet')?.startTick === 6,
    quantized.notes
  );
}

const tight = planSheetInsertion({
  startTick: 0,
  durationTicks: 24,
  midi: 67,
  newNoteId: 'add1',
  events: [{ startTick: 12, endTick: 18, memberIds: ['next'], midis: [62] }],
  opId: 'ins1',
  label: 'Add note'
});
check('a tight gap produces a sheet-insert op', tight.op?.kind === 'sheet-insert', tight.op);
check('the shortfall is exact and forward-only', ratValue(tight.op!.deltaTick) === 12, tight.op);
check('the next distinct event is the seam', ratValue(tight.op!.seamTick) === 12, tight.op);
check('the new note is the fixed insertion atom', tight.op!.fixedIds?.join() === 'add1', tight.op);

{
  const input = [
    note('add1', 0, 24, flat, 67),
    note('release-at-seam', 0, 12),
    note('crossing', 6, 18),
    note('attack-at-seam', 12, 18),
    note('later', 30, 42)
  ];
  const out = applyRippleOps(input, [tight.op!], { map: flat, divisions: DIVISIONS });
  const by = (id: string) => out.find((n) => n.id === id);
  check('the insertion atom keeps its whole desired span', String(ticks(by('add1'))) === String([0, 24]), ticks(by('add1')));
  check('a release exactly at the half-open seam stays', String(ticks(by('release-at-seam'))) === String([0, 12]), ticks(by('release-at-seam')));
  check('a release strictly after the seam moves', String(ticks(by('crossing'))) === String([6, 30]), ticks(by('crossing')));
  check('an attack exactly at the seam moves', String(ticks(by('attack-at-seam'))) === String([24, 30]), ticks(by('attack-at-seam')));
  check('the whole suffix moves by only the shortfall', String(ticks(by('later'))) === String([42, 54]), ticks(by('later')));
  /*
   * The old assertion was: "a structurally shifted attack carries its exact written onset into
   * the rebuild". That invented a declaration from the detector's raw tick, which is not the
   * page's quantized onset and could freeze jitter or fuse formerly distinct notes. The exact
   * feed displacement is already asserted above; an un-authored detector note stays measured.
   */
  check(
    'a structural shift does not invent written-onset authority for a detector note',
    by('later')?.notationOnset === undefined,
    by('later')?.notationOnset
  );
  /*
   * The old assertion was: "the visible musical window grows at the insertion instead of culling
   * the suffix". That claim was too broad: changing the SHARED viewport rescales the engraved
   * click target and the immutable audio photograph. The score-only ROLL window does follow the
   * suffix; the sheet scale and the waveform's audio window do not.
   */
  check(
    'the score-only roll window grows at the insertion without moving the audio window',
    JSON.stringify(rippleWindow({ fromSec: flat.toSec(0), toSec: flat.toSec(48) }, tight.op!, flat)) ===
      JSON.stringify({ fromSec: flat.toSec(0), toSec: flat.toSec(60) })
  );

  // No kind tag means a stored v5/v6 op. Its inclusive release rule must remain unchanged.
  const legacy: RippleOp = { id: 'legacy', seamTick: rational(12), deltaTick: rational(12) };
  const legacyOut = applyRippleOps([note('release-at-seam', 0, 12)], [legacy], {
    map: flat,
    divisions: DIVISIONS
  });
  check('legacy persisted ops keep their inclusive release seam', String(ticks(legacyOut[0])) === String([0, 24]), ticks(legacyOut[0]));
}

const exactFit = planSheetInsertion({
  startTick: 0,
  durationTicks: 24,
  midi: 67,
  newNoteId: 'fit',
  events: [{ startTick: 24, endTick: 36, memberIds: ['next'], midis: [62] }],
  opId: 'fit-op'
});
check('an exact fit needs no ripple', exactFit.op === null, exactFit);

const open = planSheetInsertion({
  startTick: 0,
  durationTicks: 24,
  midi: 67,
  newNoteId: 'open',
  events: [{ startTick: 30, endTick: 42, memberIds: ['next'], midis: [62] }],
  opId: 'open-op'
});
check('a larger gap also needs no ripple', open.op === null && ratValue(open.endTick) === 24, open);

const joined = planSheetInsertion({
  startTick: 12,
  durationTicks: 24,
  midi: 67,
  newNoteId: 'chord-new',
  events: [{ startTick: 12, endTick: 36, memberIds: ['low'], midis: [60] }],
  opId: 'join-op'
});
check('a different pitch at an exact engraved onset joins without ripple', joined.op === null && joined.joinedEventIds.join() === 'low', joined);
check('a joined pitch inherits the event canonical span', ratValue(joined.startTick) === 12 && ratValue(joined.endTick) === 36, joined);
check(
  'a first tied glyph cannot shorten the full joined span',
  notationIntentMatchingSpan({ denominator: 8, dots: 0 }, 24, DIVISIONS) === null
);
check(
  'a declaration is retained when it exactly names the joined span',
  notationIntentMatchingSpan({ denominator: 4, dots: 0 }, 24, DIVISIONS)?.denominator === 4
);
check(
  'a tuplet span carries no invented straight-note declaration',
  notationIntentMatchingSpan({ denominator: 16, dots: 0 }, 8, DIVISIONS) === null
);

{
  const inherited = notationIntentMatchingSpan({ denominator: 8, dots: 0 }, 36, DIVISIONS);
  const built = buildRiffScore(
    {
      notes: [
        { id: 'tied-low', startSec: 0, endSec: 0.75, midi: 60 },
        { id: 'joined-high', startSec: 0, endSec: 0.75, midi: 67, ...(inherited ? { notationIntent: inherited } : {}) }
      ],
      audioDurationSec: 2,
      startOffsetSec: 0,
      title: 'exact-onset joined span'
    },
    { ...DEFAULT_SETTINGS, grid: 'free', useHostGrid: false, tempoBpm: 120 }
  );
  const spanOf = (id: string): [number, number] | null => {
    let from = Infinity;
    let to = -Infinity;
    for (const bar of built.ir.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          if (!beat.notes.some((member) => member.id === id)) continue;
          from = Math.min(from, bar.startTick + beat.startTick);
          to = Math.max(to, bar.startTick + beat.startTick + beat.durTicks);
        }
      }
    }
    return Number.isFinite(from) && Number.isFinite(to) ? [from, to] : null;
  };
  check(
    'the built exact-onset chord retains the complete tied/compound span',
    String(spanOf('joined-high')) === String([0, 36]) && String(spanOf('tied-low')) === String([0, 36]),
    { low: spanOf('tied-low'), high: spanOf('joined-high') }
  );
}

{
  const built = buildRiffScore(
    {
      notes: [
        { id: 'left', startSec: 0, endSec: 0.1, midi: 60 },
        {
          id: 'sheet-authored',
          startSec: 0.125,
          endSec: 0.625,
          midi: 67,
          notationOnset: { startTick: 6, ppq: DIVISIONS },
          notationIntent: { denominator: 4, dots: 0 }
        },
        { id: 'right', startSec: 1, endSec: 1.2, midi: 62 }
      ],
      beats: [0, 0.5, 1, 1.5, 2],
      downbeats: [0, 2],
      audioDurationSec: 2.1,
      startOffsetSec: 0,
      title: 'sheet-authored onset'
    },
    { ...DEFAULT_SETTINGS, grid: 'eighth', useHostGrid: false, tempoBpm: 120 }
  );
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const bar of built.ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (!beat.notes.some((member) => member.id === 'sheet-authored')) continue;
        from = Math.min(from, bar.startTick + beat.startTick);
        to = Math.max(to, bar.startTick + beat.startTick + beat.durTicks);
      }
    }
  }
  check(
    'the full pipeline engraves a sheet-authored onset and duration at their declared ticks',
    from === 6 && to === 30,
    { from, to }
  );
}

const duplicate = planSheetInsertion({
  startTick: 12,
  durationTicks: 24,
  midi: 60,
  newNoteId: 'duplicate',
  events: [{ startTick: 12, endTick: 36, memberIds: ['low'], midis: [60] }],
  opId: 'duplicate-op'
});
check('the same pitch at an exact event selects/refuses instead of folding a duplicate', duplicate.duplicateId === 'low' && duplicate.op === null, duplicate);

{
  const plan = planSheetInsertion({
    startTick: 84,
    durationTicks: 24,
    midi: 67,
    newNoteId: 'tempo-add',
    events: [{ startTick: 100, endTick: 112, memberIds: ['after'], midis: [62] }],
    opId: 'tempo-op'
  });
  const input = [note('tempo-add', 84, 108, tempoMap, 67), note('after', 100, 112, tempoMap), note('far', 120, 144, tempoMap)];
  const out = applyRippleOps(input, [plan.op!], { map: tempoMap, divisions: DIVISIONS });
  check('tempo changes do not alter the rational shortfall', ratValue(plan.op!.deltaTick) === 8, plan.op);
  check('the near suffix moves eight ticks through the tempo map', String(ticks(out.find((n) => n.id === 'after'), tempoMap)) === String([108, 120]), ticks(out.find((n) => n.id === 'after'), tempoMap));
  check('the far suffix also moves eight ticks, not one scalar second', String(ticks(out.find((n) => n.id === 'far'), tempoMap)) === String([128, 152]), ticks(out.find((n) => n.id === 'far'), tempoMap));
}

{
  const restored: RippleOp[] = [
    { id: 'r1', seamTick: rational(12), deltaTick: rational(6) },
    { id: 'b9', seamTick: rational(24), deltaTick: rational(96), split: true },
    { id: 'custom', seamTick: rational(120), deltaTick: rational(-12) }
  ];
  const minted = nextRippleOperationId(restored, 0, 'r');
  check('a restored log seeds the next operation id past every prior numeric id', minted.id === 'r10' && minted.sequence === 10, minted);

  const appended: RippleOp = {
    id: minted.id,
    kind: 'sheet-insert',
    seamTick: rational(144),
    deltaTick: rational(12),
    fixedIds: ['reopened-add']
  };
  const shown = note('reopened-add', 132, 156);
  const ops = [...restored, appended];
  const placements = withRollPlacements(undefined, [shown], ['reopened-add'], ops, flat);
  const raw = unrippleNotes([shown], restored, flat, DIVISIONS);
  const replayed = applyRippleOps(raw, ops, { map: flat, divisions: DIVISIONS, placements });
  check(
    'a post-restore placement resumes after the actual last op, not an older same-looking id',
    String(ticks(replayed[0])) === String([132, 156]) && placements?.['reopened-add']?.afterOpId === 'r10',
    { replayed: ticks(replayed[0]), placement: placements?.['reopened-add'] }
  );
}

{
  // A prior insert created time with no raw pre-image. The placement pins the newly authored note
  // in those output coordinates, and replay stays exact.
  const prior: RippleOp = { id: 'bar', seamTick: rational(24), deltaTick: rational(96), split: true };
  const dropped: InputNote = {
    ...note('inside-new-time', 60, 72),
    notationOnset: { startTick: 60, ppq: DIVISIONS }
  };
  const stored = unrippleNotes([dropped], [prior], flat, DIVISIONS)[0];
  const placements = withRollPlacements(undefined, [dropped], ['inside-new-time'], [prior], flat);
  const redrawn = applyRippleOps([stored], [prior], { map: flat, divisions: DIVISIONS, placements });
  check('a note inserted inside prior ripple time stays where it was authored', String(ticks(redrawn[0])) === String([60, 72]), { stored: ticks(stored), redrawn: ticks(redrawn[0]) });
  check(
    'its written-onset authority follows the inverse and placement round trip',
    stored.notationOnset?.startTick === 24 && redrawn[0].notationOnset?.startTick === 60,
    { stored: stored.notationOnset, redrawn: redrawn[0].notationOnset }
  );
}

{
  // A real horizontal sheet drag happens after the current log has already shaped the feed. Its
  // beat and its written-onset marker must cross the inverse write-back together, then the
  // placement must prevent replay from applying that old log over the gesture a second time.
  const prior: RippleOp = { id: 'prior-insert', seamTick: rational(24), deltaTick: rational(24) };
  const dropped: InputNote = {
    ...note('sheet-dragged', 72, 84),
    notationOnset: { startTick: 72, ppq: DIVISIONS }
  };
  const placements = withRollPlacements(undefined, [dropped], ['sheet-dragged'], [prior], flat);
  const stored = unrippleNotes([dropped], [prior], flat, DIVISIONS);
  const replayed = applyRippleOps(stored, [prior], { map: flat, divisions: DIVISIONS, placements });
  check(
    'a sheet drag after a prior ripple replays at the exact beat where the hand dropped it',
    String(ticks(replayed[0])) === String([72, 84]),
    { stored: ticks(stored[0]), replayed: ticks(replayed[0]) }
  );
  check(
    'the dragged glyph keeps the same authored onset through inverse write-back and replay',
    stored[0].notationOnset?.startTick === 48 && replayed[0].notationOnset?.startTick === 72,
    { stored: stored[0].notationOnset, replayed: replayed[0].notationOnset }
  );
}

{
  // On a bijective prior ripple, the inverse restates symbolic ticks as well as seconds. Otherwise
  // replay would move an exact import's sourceTiming twice even while its rectangle looked right.
  const prior: RippleOp = { id: 'grow', seamTick: rational(24), deltaTick: rational(24) };
  const shown: InputNote = {
    ...note('symbolic-new', 60, 72),
    sourceTiming: { startTick: 1200, endTick: 1440, ppq: 480 }
  };
  const stored = unrippleNotes([shown], [prior], flat, DIVISIONS);
  const redrawn = applyRippleOps(stored, [prior], { map: flat, divisions: DIVISIONS });
  check(
    'prior-ripple round trips symbolic source timing exactly',
    JSON.stringify(redrawn[0].sourceTiming) === JSON.stringify(shown.sourceTiming),
    { stored: stored[0].sourceTiming, redrawn: redrawn[0].sourceTiming }
  );
}

{
  const foreign = note('add1', 12, 18);
  const wronglyScoped = applyRippleOps([foreign], [tight.op!], { map: flat, divisions: DIVISIONS })[0];
  const correctlyScoped = applyRippleOps([foreign], [rippleOpForForeignPart(tight.op!)], {
    map: flat,
    divisions: DIVISIONS
  })[0];
  check('a colliding imported id would be wrongly exempt without namespacing', String(ticks(wronglyScoped)) === String([12, 18]), ticks(wronglyScoped));
  check('the foreign-part op strips the live atom and shifts that imported note', String(ticks(correctlyScoped)) === String([24, 30]), ticks(correctlyScoped));
}

{
  const source: SourceAudio = {
    name: 'insert.riffsheet',
    durationSec: 2,
    peaks: null,
    trim: null,
    barOneSec: 0,
    detected: {
      notes: [{ ...note('add1', 0, 24), notationOnset: { startTick: 0, ppq: DIVISIONS } }]
    },
    rippleOps: [tight.op!]
  };
  const wire = encodeSource(source)!;
  const back = decodeSource(JSON.parse(JSON.stringify(wire)))!.rippleOps![0];
  check('the new op kind survives persistence', back.kind === 'sheet-insert', back);
  check('the fixed insertion atom survives persistence', back.fixedIds?.join() === 'add1', back);
  check(
    'the sheet-authored onset survives document persistence',
    decodeSource(JSON.parse(JSON.stringify(wire)))!.detected!.notes[0].notationOnset?.ppq === DIVISIONS
  );
}

check(
  'a shortfall beyond the old tail extends the structural end exactly',
  ratValue(rippleEndTick([tight.op!], rational(12), 0)) === 24,
  rippleEndTick([tight.op!], rational(12), 0)
);

console.log(`sheet insertion: ${checks - failures} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
