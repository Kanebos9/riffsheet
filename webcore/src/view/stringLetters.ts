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
  gapPx = STRING_LETTER_GAP_PX,
  columnX: number | null = null,
  /**
   * Which alphaTab track the legend is FOR, or null for "the first tab stave in the system".
   *
   * Null is right for every single-part score and wrong for every reordered multi-part one: the
   * search below takes the first tablature it finds, and with an imported chart moved above the
   * take that is the CHART'S tab. The legend then captions the take's staff with the tuning of a
   * staff two systems away, in the same silent way `tuningLowToHighFromScore` used to. Both ends
   * of that mistake are closed by naming the track once. See triview.ts §liveTrackIndex.
   */
  trackIndex: number | null = null
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
      const all = masterBar.bars ?? [];
      const mine =
        trackIndex === null ? all : all.filter((b) => b.bar?.staff?.track?.index === trackIndex);
      // Never nothing: a legend that disappears because a back-reference went missing is a worse
      // answer than the one this has always drawn.
      const bars = mine.length > 0 ? mine : all;
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
    /*
     * WHERE THE COLUMN IS: OUTSIDE THE BAR, and the midpoint it was is what put it on the clef.
     *
     * G18 moved these to `(staffEdgeX + columnX) / 2` — halfway between the staff's left edge and
     * the first notehead — to stop them being marooned in the page padding. That midpoint is
     * INSIDE the first bar, and the first thing engraved inside a tab bar is the TAB clef: three
     * stacked letters, drawn exactly where the legend was now landing. Photographed on Grand +
     * Tab at every zoom including 1.0 — a grey "G2 D2 A1 E1" smeared over "T A B".
     *
     * `visualBounds.x` is the BAR's left edge and the clef is drawn from it, so the only x that
     * is guaranteed clear of engraved ink is left of it. That is where they go, and the marooning
     * argument no longer applies: the row is pinned to the viewport (triview.ts
     * §placeStringLetters), so it sits in the pane's own left-hand column — the same column the
     * piano roll spends on its pitch labels — rather than drifting off with the page.
     *
     * `columnX` is still taken, as a CEILING rather than a target: on a staff with no clef to
     * clear (or a future alphaTab that measures the bar differently) it stops the letters from
     * ever reaching the first notehead.
     */
    const staffEdgeX = tab.x - gapPx;
    const rightX =
      columnX !== null && Number.isFinite(columnX)
        ? Math.min(staffEdgeX, columnX)
        : staffEdgeX;
    for (let line = 0; line < strings; line++) {
      const stringIndex = strings - 1 - line; // top line is the thinnest string
      out.push({
        x: rightX,
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
  score: alphaTab.model.Score | null | undefined,
  trackIndex = 0
): number[] {
  // THE LIVE PART'S TRACK, NOT `tracks[0]` (Codex finding 8). Parts can be reordered, and an
  // imported MusicXML part moved above the take becomes track 0 — after which the legend down the
  // side of the TAKE'S tab reported the imported chart's tuning. It is captioning one staff with
  // another instrument's strings, and it is silent about it, which is the worst shape a wrong
  // number comes in. The caller knows which track is live; the default keeps every single-part
  // caller exactly where it was.
  const staves = score?.tracks?.[trackIndex]?.staves ?? score?.tracks?.[0]?.staves ?? [];
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
