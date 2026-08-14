/** Focused non-browser contracts for P3/P5/P6. Run with `npm run test:notation-layout`. */

import { DEFAULT_SETTINGS, mergeStoredSettings } from '../src/app/state';
import { stringLettersFromBounds, tuningLowToHighFromScore } from '../src/view/stringLetters';

let failures = 0;
let checks = 0;
function check(what: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) return;
  failures++;
  console.error(`FAIL ${what}${detail ? ` — ${detail}` : ''}`);
}

const staff = (trackIndex: number) => ({
  showStandardNotation: true,
  showTablature: true,
  track: { index: trackIndex }
});
const bass = staff(0);
const guitar = staff(1);
const bar = (source: ReturnType<typeof staff>, y: number, h: number) => ({
  bar: { staff: source },
  visualBounds: { x: 40, y, w: 300, h },
  realBounds: { x: 40, y, w: 300, h },
  beats: []
});
const lookup = {
  staffSystems: [
    {
      bars: [
        {
          // Each alphaTab Staff appears twice: standard notation, then its tablature.
          bars: [bar(bass, 20, 30), bar(bass, 70, 30), bar(guitar, 150, 30), bar(guitar, 200, 50)]
        }
      ]
    }
  ]
};

const bassLetters = stringLettersFromBounds(lookup as never, [28, 33, 38, 43], 3, null, 0);
const guitarLetters = stringLettersFromBounds(lookup as never, [40, 45, 50, 55, 59, 64], 3, null, 1);
check('bass legend has its own four strings', bassLetters.length === 4);
check('guitar legend has its own six strings', guitarLetters.length === 6);
check('every bass letter carries track identity', bassLetters.every((letter) => letter.trackIndex === 0));
check('every guitar letter carries track identity', guitarLetters.every((letter) => letter.trackIndex === 1));
check(
  'mixed tunings stay independent',
  bassLetters.map((letter) => letter.text).join(' ') === 'G2 D2 A1 E1' &&
    guitarLetters.map((letter) => letter.text).join(' ') === 'E4 B3 G3 D3 A2 E2'
);
check(
  'an explicit missing track never falls back to another part',
  stringLettersFromBounds(lookup as never, [40, 45, 50, 55], 3, null, 9).length === 0
);

const tuningScore = {
  tracks: [
    { staves: [{ showTablature: true, stringTuning: { tunings: [43, 38, 33, 28] } }] },
    { staves: [{ showTablature: true, stringTuning: { tunings: [64, 59, 55, 50, 45, 40] } }] }
  ]
};
check(
  'bass tuning is read from the requested part',
  tuningLowToHighFromScore(tuningScore as never, 0).join(',') === '28,33,38,43'
);
check(
  'guitar tuning is read from the requested part',
  tuningLowToHighFromScore(tuningScore as never, 1).join(',') === '40,45,50,55,59,64'
);
check(
  'a missing tuning track never falls back to track zero',
  tuningLowToHighFromScore(tuningScore as never, 9).length === 0
);

check('spacing defaults to the collision-safe baseline', DEFAULT_SETTINGS.notationSpacingPx === 0);
check(
  'negative stored spacing clamps to zero',
  mergeStoredSettings({ ...DEFAULT_SETTINGS, notationSpacingPx: -9 }).notationSpacingPx === 0
);
check(
  'oversized stored spacing clamps to sixteen',
  mergeStoredSettings({ ...DEFAULT_SETTINGS, notationSpacingPx: 99 }).notationSpacingPx === 16
);
check(
  'invalid stored spacing returns to the default',
  mergeStoredSettings({ ...DEFAULT_SETTINGS, notationSpacingPx: Number.NaN }).notationSpacingPx === 0
);

// atSettings resolves its offline font URL at module initialisation. A minimal document base is
// enough for this arithmetic-only test; no renderer or DOM is constructed.
(globalThis as unknown as { document: { baseURI: string } }).document = { baseURI: 'file:///' };
const alphaTab = await import('@coderline/alphatab');
const { applyStaffTabGap, applyTrackNameGap } = await import('../src/view/atSettings');
const {
  NAME_LABEL_HEIGHT_PX,
  NAME_LABEL_STACK_STEP_PX,
  pitchNameLaneY
} = await import('../src/view/triview');
check(
  'stacked chord-name boxes never touch',
  NAME_LABEL_STACK_STEP_PX >= NAME_LABEL_HEIGHT_PX,
  `${NAME_LABEL_STACK_STEP_PX}px step for ${NAME_LABEL_HEIGHT_PX}px boxes`
);
check(
  'the first part clears the whole system rather than its lower staff box',
  pitchNameLaneY(154, 81, true, 0) + NAME_LABEL_HEIGHT_PX === 65
);
check(
  'a lower part keeps its own independently reserved lane',
  pitchNameLaneY(300, 81, false, 0) + NAME_LABEL_HEIGHT_PX === 284
);
for (const scale of [0.6, 1, 3]) {
  const settings = new alphaTab.Settings();
  settings.display.scale = scale;
  applyStaffTabGap(settings, false, true, 0);
  const baseline = settings.display.notationStaffPaddingTop * scale;
  applyStaffTabGap(settings, false, true, 8);
  check(
    `8px staff spacing stays physical at ${scale}x`,
    Math.abs(settings.display.notationStaffPaddingTop * scale - baseline - 8) < 1e-9
  );
  applyTrackNameGap(settings, 65, 8);
  check(
    `65px part lane stays physical at ${scale}x`,
    Math.abs(settings.display.trackStaffPaddingBetween * scale - 65) < 1e-9
  );
}

if (failures > 0) {
  console.error(`\nnotation-layout-test: ${failures}/${checks} failed`);
  process.exit(1);
}
console.log(`notation-layout-test: ${checks}/${checks} passed`);
