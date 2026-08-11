/**
 * Unit checks for the pure rules added in this round (G15, G18, G19).
 *
 * A SEPARATE FILE from scripts/view-units-test.ts, which is shared and whose check count other
 * people assert on. Same shape, same runner:
 *
 *   node scripts/run-ts-tests.mjs scripts/view-board-test.ts
 */

import { wheelZoomFactor } from '../src/view/pianoroll';
import { gridDetail, gridMarks, subdivisionsPerBeat, SUBS_PER_BEAT, type BarSpan } from '../src/view/timeAxis';
import { cleanTakeTitle } from '../src/export/takeTitle';

let passed = 0;
const failures: string[] = [];
function assert(ok: boolean, what: string): void {
  if (ok) passed++;
  else failures.push(what);
}

// ---------------------------------------------------------------------------
// G19 — the roll's grid vocabulary
// ---------------------------------------------------------------------------

assert(subdivisionsPerBeat('off') === 0, "'off' is ZERO parts per beat — the signal for bars only");
assert(subdivisionsPerBeat('thirtysecond') === 8, '1/32 is eight per beat');
assert(subdivisionsPerBeat('quarter') === 1, 'a quarter grid is the beat itself');
assert(subdivisionsPerBeat('triplet') === 3, 'a triplet is three per beat');
assert(subdivisionsPerBeat('free') === SUBS_PER_BEAT, 'free still draws the default subdivision');

const roomy = 0.5 / 60; // 60px to a beat: room for anything
const off = gridDetail(0.5, roomy, subdivisionsPerBeat('off'));
assert(off.bars, "'off' still draws BAR lines — the bar number is the ruler's whole job");
assert(!off.beats, "'off' draws no beat lines");
assert(!off.subs, "'off' draws no subdivisions");
assert(off.subsPerBeat === 0, "'off' carries its zero through to the detail");
assert(off.labelEvery >= 1, "'off' still labels bars");

const fine = gridDetail(0.5, roomy, subdivisionsPerBeat('thirtysecond'));
assert(fine.subsPerBeat === 8, '1/32 reaches the detail as eight');
assert(fine.subs, 'eight per beat fit in 60px');
assert(!gridDetail(0.5, 0.5 / 40, 8).subs, '...and do not fit in 40px');

const bars: BarSpan[] = [
  { index: 0, number: 1, implicit: false, startSec: 0, endSec: 2, beats: 4, beatSec: 0.5 },
  { index: 1, number: 2, implicit: false, startSec: 2, endSec: 4, beats: 4, beatSec: 0.5 }
];
const offMarks = gridMarks(bars, { fromSec: 0, toSec: 4 }, off);
assert(offMarks.length === 2, `'off' draws exactly one mark per bar (got ${offMarks.length})`);
assert(offMarks.every((m) => m.level === 'bar'), "every mark 'off' draws is a bar line");
assert(offMarks.map((m) => m.sec).join(',') === '0,2', "'off' puts them on the downbeats");

const fineMarks = gridMarks(bars, { fromSec: 0, toSec: 4 }, fine);
// 2 bars * (1 bar line + 3 beat lines + 4 beats * 7 subdivisions) = 2 * 32
assert(fineMarks.length === 64, `1/32 draws 32 columns a bar (got ${fineMarks.length})`);
assert(
  fineMarks.filter((m) => m.level === 'bar').length === 2,
  'the bar lines are still bar lines at the finest grid'
);

// ---------------------------------------------------------------------------
// G15 — the damped trackpad zoom
// ---------------------------------------------------------------------------

assert(wheelZoomFactor(0) === 1, 'no movement is no zoom');
assert(wheelZoomFactor(-10) > 1, 'up/left zooms IN');
assert(wheelZoomFactor(10) < 1, 'down/right zooms OUT');
assert(
  Math.abs(wheelZoomFactor(-10) * wheelZoomFactor(10) - 1) < 1e-9,
  'a flick and its opposite land exactly where they started'
);
assert(
  Math.abs(wheelZoomFactor(-10) * wheelZoomFactor(-10) - wheelZoomFactor(-20)) < 1e-9,
  'two small events are worth exactly one big one — the factor composes'
);
assert(wheelZoomFactor(-10) < 1.02, 'a small trackpad delta is a SMALL zoom');
assert(wheelZoomFactor(-100000) <= 1.06 + 1e-9, 'a runaway delta is clamped, in');
assert(wheelZoomFactor(100000) >= 1 / 1.06 - 1e-9, 'a runaway delta is clamped, out');
assert(
  wheelZoomFactor(-120) <= 1.06 + 1e-9,
  'one mouse notch (120px) cannot exceed the per-event clamp either'
);
assert(
  wheelZoomFactor(-3, 1) > wheelZoomFactor(-3, 0),
  'deltaMode 1 is LINES, so the same number means more travel'
);
assert(wheelZoomFactor(-1, 2) > wheelZoomFactor(-1, 1), 'deltaMode 2 is PAGES, more still');

// ---------------------------------------------------------------------------
// G18 — the printed title is the piece, not the file
// ---------------------------------------------------------------------------

assert(
  cleanTakeTitle('2.wav-20260810-193842-3f9c1a') === '2',
  `the stored name loses its date, its hash and its extension (got "${cleanTakeTitle('2.wav-20260810-193842-3f9c1a')}")`
);
assert(cleanTakeTitle('riff.wav-20260810-193842') === 'riff', 'the hash is optional');
assert(cleanTakeTitle('Slow Blues.wav') === 'Slow Blues', 'a plain file name loses only its extension');
assert(cleanTakeTitle('Slow Blues') === 'Slow Blues', 'a name that is already clean is untouched');
assert(
  cleanTakeTitle('Take 2.wav mix') === 'Take 2.wav mix',
  'an extension in the MIDDLE of a name is part of the name'
);
assert(
  cleanTakeTitle('20260810-193842-3f9c1a') === '20260810-193842-3f9c1a',
  'stripping everything leaves the raw name rather than a blank title'
);
assert(cleanTakeTitle('  padded.mp3  ') === 'padded', 'whitespace goes with it');

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error(`\nview-board-test: ${failures.length} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`view-board-test: passed (${passed} checks)`);
