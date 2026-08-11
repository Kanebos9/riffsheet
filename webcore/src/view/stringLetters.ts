/**
 * The open-string letters down the left edge of every tab staff.
 *
 * WHY THIS EXISTS. The tuning used to be one line of prose under the toolbar — "Tuning low →
 * high: E1 A1 D2 G2" — which is the right information in the wrong place three times over. It
 * was on the screen and not on the paper, so a printed sheet said nothing about what the fret
 * numbers meant. It was one line for a whole document, so on a page of four systems you had to
 * scroll back to the top to remember. And it was prose, so you had to count words against
 * strings to work out which line was which.
 *
 * What replaces it is what every tab book has always done: the letter sits ON the line it
 * belongs to, at the left of the staff, on every system. Nothing to read, nothing to count —
 * the line the 7 is on is the line the D is on.
 *
 * ALWAYS, INCLUDING STANDARD TUNING. Printing them only for unusual tunings would make their
 * absence mean "standard", which is a thing you can only know if you already knew it. The
 * letters are not a warning about a special case; they are the legend for the staff.
 *
 * WHERE THEY GO, and why it costs no layout. alphaTab already leaves `LEFT_INSET_PX` of empty
 * page padding at the left — the tri-view sets it so the sheet reserves exactly the piano
 * roll's label gutter and the two panes line up (see triview.ts §D). The letters are drawn
 * INTO that existing column, right-aligned against the staff. So they add no gutter of their
 * own, and the shared x-axis Align depends on is untouched — which is checked, not assumed.
 *
 * PURE, and shared by two renderers on purpose: the tri-view on screen and the hidden
 * paginated instance `export/pdf.ts` builds. One function, so the paper cannot disagree with
 * the screen about where a letter goes.
 */

import type * as alphaTab from '@coderline/alphatab';
import { midiNoteName } from '../score/tuning';
import { staveKindsFromBars, tabStaveIndex } from './staveKinds';

/** Air between the right edge of a letter and the left edge of the staff, in px. */
export const STRING_LETTER_GAP_PX = 3;

export interface StringLetter {
  /** The RIGHT edge of the text, in the same coordinates the bounds came in. */
  x: number;
  /** The VERTICAL CENTRE of the text — the tab line it names. */
  y: number;
  text: string;
  /** 0 = the fattest/lowest string. Only for tests and debugging. */
  stringIndex: number;
  /** Which system it belongs to, in render order. */
  system: number;
}

/**
 * One letter per string per system, or an empty list when there is no tab to label.
 *
 * `tuningLowToHigh` is Riffsheet's own order (see score/tuning.ts). alphaTab draws string 1 —
 * the fattest — on the BOTTOM line, so the list is walked from the bottom up. Anything with
 * fewer than two strings has no line spacing to derive and is skipped rather than guessed at.
 */
export function stringLettersFromBounds(
  lookup: alphaTab.rendering.BoundsLookup | null | undefined,
  tuningLowToHigh: ReadonlyArray<number>,
  gapPx = STRING_LETTER_GAP_PX
): StringLetter[] {
  const out: StringLetter[] = [];
  const strings = tuningLowToHigh.length;
  if (!lookup || strings < 2) return out;

  let system = 0;
  for (const staffSystem of lookup.staffSystems) {
    // The FIRST bar of the system that reports a tab stave. Bars after the first sit further
    // right, and a letter is a legend for the line, not for the bar.
    let tab: { x: number; y: number; h: number } | null = null;
    for (const masterBar of staffSystem.bars) {
      const bars = masterBar.bars ?? [];
      // One BarBounds per RENDERED stave, and which of them is the tablature is asked of the
      // staves themselves. It used to be index 1, which is the tab only when a single alphaTab
      // Staff shows notation and tab together. On a grand staff plus tab the tab is index 2 and
      // index 1 is the bass clef — so the letters were drawn as a legend down the side of a
      // staff that has no strings.
      const index = tabStaveIndex(staveKindsFromBars(bars));
      if (index < 0) continue;
      const v = bars[index].visualBounds;
      if (!(v.h > 0)) continue;
      tab = { x: v.x, y: v.y, h: v.h };
      break;
    }
    if (!tab) {
      system++;
      continue;
    }

    // `visualBounds` spans the outermost tab lines, so N strings give N-1 gaps between them.
    const step = tab.h / (strings - 1);
    for (let line = 0; line < strings; line++) {
      const stringIndex = strings - 1 - line; // top line is the thinnest string
      out.push({
        x: tab.x - gapPx,
        y: tab.y + line * step,
        text: midiNoteName(tuningLowToHigh[stringIndex]),
        stringIndex,
        system
      });
    }
    system++;
  }
  return out;
}

/**
 * The engraved tuning, lowest string first, read back off the score alphaTab is drawing.
 *
 * Read from the model rather than from the settings because the model is what is on the page:
 * a score loaded from a file carries its own tuning, and a legend that reported the app's
 * current preference instead would be captioning someone else's staff.
 */
export function tuningLowToHighFromScore(
  score: alphaTab.model.Score | null | undefined
): number[] {
  const staves = score?.tracks?.[0]?.staves ?? [];
  // The TAB staff's tuning, not `staves[0]`'s. On a grand staff plus tab, staves[0] is the
  // treble clef and carries no tuning at all, so the letters silently disappeared — which
  // reads exactly like "this score has no tab" rather than like a bug. A notation staff that
  // happens to carry a leftover tuning must not answer for the tab either, so the tab staff is
  // preferred outright and only then does anything with strings get a look in.
  const staff =
    staves.find((s) => s.showTablature && (s.stringTuning?.tunings?.length ?? 0) > 0) ??
    staves.find((s) => (s.stringTuning?.tunings?.length ?? 0) > 0) ??
    staves[0];
  const tunings = staff?.stringTuning?.tunings ?? [];
  // alphaTab stores index 0 = the HIGHEST string (score/fromPipeline.ts §13). Ours is the
  // other way round, everywhere, so it is reversed exactly once — here.
  return [...tunings].reverse();
}
