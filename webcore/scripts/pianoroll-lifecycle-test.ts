/**
 * The authoritative-publish half of a real roll gesture.
 *
 * A browser double-click reaches `PianoRoll.emit()`, which installs a provisional add and calls
 * the app synchronously. The app commits the edit, rebuilds the score, and publishes the new
 * performance through `setPerformanceNotes()` before the callback returns. This focused harness
 * keeps that exact order while replacing only DOM/canvas plumbing with deterministic geometry.
 * It catches the lifecycle defect the older reducer-only purity probe could not see: retaining
 * the provisional add after the authoritative note has arrived paints both rectangles.
 */

import { PianoRoll, type PerformanceNote } from '../src/view/pianoroll';
import { snapPerformanceToBeat, snapPerformanceToGrid } from '../src/app/snap';
import { DEFAULT_SETTINGS } from '../src/app/state';
import { buildRiffScore } from '../src/pipeline';

let checks = 0;
let failures = 0;

function check(label: string, condition: unknown, detail: unknown): void {
  checks++;
  const ok = !!condition;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — ${JSON.stringify(detail)}`);
}

type Snapshot = {
  pending: unknown;
  notes: Array<{ noteId: string | null; startSec: number; endSec: number; midi: number; overlapped: boolean }>;
  nullIds: number;
};

const roll = Object.create(PianoRoll.prototype) as any;
const existing: PerformanceNote = { id: 'anchor', startSec: 1, endSec: 1.5, midi: 60 };
let authoritative: PerformanceNote[] = [existing];
let callbackCount = 0;
let afterPublish: Snapshot | null = null;

Object.assign(roll, {
  canvas: { clientWidth: 834, clientHeight: 200 },
  handle: null,
  durationSec: 4,
  appOriginSec: 0,
  barOneSec: 0,
  score: null,
  timeWindow: null,
  performance: null,
  notes: [],
  pending: null,
  pendingIds: new Set<string>(),
  rects: [],
  opts: {}
});

// Keep the production performance->roll mapping and production rectangle layout. Only the
// drawing calls themselves are replaced; the test cares about what would be painted, not pixels.
roll.rebuildNotes = function rebuildNotes(): void {
  this.notes = (this.performance ?? []).map((note: PerformanceNote) => ({
    startSec: note.startSec - this.originSec,
    endSec: note.endSec - this.originSec,
    midi: note.midi,
    noteId: String(note.id),
    velocity: note.velocity
  }));
};
roll.draw = function draw(): void {
  this.rects = this.layoutRects(12, (midi: number) => 120 - (midi - 60) * 12, 834, 34);
};

const snapshot = (): Snapshot => {
  const notes = roll.paintedRects().map((rect: any) => ({
    noteId: rect.noteId,
    startSec: rect.startSec,
    endSec: rect.endSec,
    midi: rect.midi,
    overlapped: rect.overlapped
  }));
  return {
    pending: roll.pending,
    notes,
    nullIds: notes.filter((note) => note.noteId === null).length
  };
};

roll.opts.onEdit = (edit: { kind: string; midi: number; startSec: number; durationSec: number }) => {
  callbackCount++;
  authoritative = [
    existing,
    {
      id: 'add-1',
      startSec: edit.startSec,
      endSec: edit.startSec + edit.durationSec,
      midi: edit.midi
    }
  ];
  // This is the app's synchronous authoritative publish inside the edit callback.
  roll.setPerformanceNotes(authoritative);
  afterPublish = snapshot();
};

roll.setPerformanceNotes(authoritative);
const before = snapshot();
roll.emit({ kind: 'add', midi: 64, startSec: 1, durationSec: 0.5 });
const settled = snapshot();

console.log(`      lifecycle: ${JSON.stringify({ before, afterPublish, settled })}`);
check('the real edit callback ran exactly once', callbackCount === 1, callbackCount);
check(
  'the existing authoritative note stayed byte-identical',
  JSON.stringify(authoritative[0]) === JSON.stringify(existing),
  authoritative[0]
);
check('the authoritative publish contains exactly one new id', authoritative.length === 2, authoritative);
check('the publish acknowledges the provisional edit', afterPublish?.pending === null, afterPublish);
check('the callback frame has one rectangle per authoritative note', afterPublish?.notes.length === 2, afterPublish);
check('the callback frame has no null-id rectangle', afterPublish?.nullIds === 0, afterPublish);
check('the settled frame remains authoritative-only', settled.notes.length === 2 && settled.nullIds === 0, settled);

// An App undo is another authoritative publication. It must remove the authored rectangle and
// cannot resurrect the provisional proposal the original callback acknowledged.
roll.setPerformanceNotes([existing]);
const undone = snapshot();
check('an authoritative undo restores the original painted state exactly', JSON.stringify(undone) === JSON.stringify(before), undone);

let samePitchFrame: Snapshot | null = null;
roll.opts.onEdit = (edit: { midi: number; startSec: number; durationSec: number }) => {
  roll.setPerformanceNotes([
    existing,
    { id: 'overlap-1', startSec: edit.startSec, endSec: edit.startSec + edit.durationSec, midi: edit.midi }
  ]);
  samePitchFrame = snapshot();
};
roll.emit({ kind: 'add', midi: 60, startSec: 1, durationSec: 0.25 });
check(
  'same-pitch overlap keeps two authoritative ids and no provisional third rectangle',
  samePitchFrame?.notes.length === 2 &&
    samePitchFrame.nullIds === 0 &&
    samePitchFrame.notes.every((note) => note.noteId !== null),
  samePitchFrame
);
check(
  'same-pitch overlap is classified as deliberate overlap rendering',
  samePitchFrame?.notes.some((note) => note.overlapped) === true,
  samePitchFrame
);

roll.setPerformanceNotes([
  { id: 'nested-long', startSec: 0, endSec: 3, midi: 60 },
  { id: 'nested-short', startSec: 0.5, endSec: 0.75, midi: 60 },
  { id: 'nested-later', startSec: 1, endSec: 1.25, midi: 60 }
]);
const nested = snapshot();
check(
  'nested same-row intervals all retain overlap clarity against the furthest active release',
  nested.notes.length === 3 && nested.notes.every((note) => note.overlapped),
  nested
);

// Grid is a per-note projection: appending an event cannot change the old projection. Beat is a
// global allocator and may change its derived positions, but neither mode may mutate raw input.
const snapRaw = [
  { id: 'old-a', startSec: 0.02, endSec: 0.23, midi: 60 },
  { id: 'old-b', startSec: 0.24, endSec: 0.46, midi: 62 }
];
const snapRawBytes = JSON.stringify(snapRaw);
const snapAdded = [...snapRaw, { id: 'new', startSec: 0.03, endSec: 0.18, midi: 67 }];
const gridBefore = snapPerformanceToGrid(snapRaw, 0.125, 0, 120);
const gridAfter = snapPerformanceToGrid(snapAdded, 0.125, 0, 120);
const gridOld = (notes: typeof gridAfter) =>
  notes.filter((note) => note.id !== 'new').map((note) => JSON.stringify(note));
check('Grid add leaves every old derived note byte-identical', JSON.stringify(gridOld(gridAfter)) === JSON.stringify(gridOld(gridBefore)), gridAfter);
snapPerformanceToBeat(snapAdded, 0.5, 0.125, 0, 120);
check('Grid and Beat projections never rewrite the raw take', JSON.stringify(snapRaw) === snapRawBytes, snapRaw);

const engraved = buildRiffScore(
  {
    notes: [
      { id: 'anchor', startSec: 1, endSec: 1.5, midi: 60 },
      { id: 'add-1', startSec: 1, endSec: 1.5, midi: 64 }
    ],
    audioDurationSec: 4,
    startOffsetSec: 0,
    title: 'P1 lifecycle chord'
  },
  { ...DEFAULT_SETTINGS, grid: 'free', useHostGrid: false, tempoBpm: 120 }
);
const attackEvents = engraved.ir.bars.flatMap((bar) =>
  bar.voices.flatMap((voice) =>
    voice.beats
      .filter((beat) => !beat.isRest)
      .map((beat) => beat.notes.filter((note) => !note.tieStop).map((note) => note.id))
  )
);
check(
  'the sheet publishes the anchor and add as members of one exact-onset event',
  attackEvents.some((ids) => ids.includes('anchor') && ids.includes('add-1')),
  attackEvents
);

const unequalRaw = [
  { id: 'short-anchor', startSec: 1, endSec: 1.5, midi: 60 },
  { id: 'long-add', startSec: 1, endSec: 1.75, midi: 64 }
];
const unequalRawBytes = JSON.stringify(unequalRaw);
const unequal = buildRiffScore(
  { notes: unequalRaw, audioDurationSec: 4, startOffsetSec: 0, title: 'P1 duration confound' },
  { ...DEFAULT_SETTINGS, grid: 'free', useHostGrid: false, tempoBpm: 120 }
);
const writtenSpan = (id: string): [number, number] | null => {
  let from = Infinity;
  let to = -Infinity;
  for (const bar of unequal.ir.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (!beat.notes.some((note) => note.id === id)) continue;
        from = Math.min(from, bar.startTick + beat.startTick);
        to = Math.max(to, bar.startTick + beat.startTick + beat.durTicks);
      }
    }
  }
  return Number.isFinite(from) && Number.isFinite(to) ? [from, to] : null;
};
const shortWritten = writtenSpan('short-anchor');
const longWritten = writtenSpan('long-add');
check(
  'different performed durations at one onset are classified as one shared written chord span',
  shortWritten !== null && JSON.stringify(shortWritten) === JSON.stringify(longWritten),
  { shortWritten, longWritten }
);
check('shared chord engraving never mutates the older raw note', JSON.stringify(unequalRaw) === unequalRawBytes, unequalRaw);

console.log(`pianoroll lifecycle: ${checks - failures} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
