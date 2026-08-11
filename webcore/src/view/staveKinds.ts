/**
 * WHICH RENDERED STAVE IS WHICH — derived, never counted.
 *
 * alphaTab's `BoundsLookup` reports one `BarBounds` per RENDERED STAVE per master bar, in
 * top-to-bottom render order. Everything in the tri-view that has to answer "is this the
 * notation or the tab?" used to answer it positionally: two entries meant notation at index 0
 * and tab at index 1, because for a very long time that was the only shape this app produced —
 * one alphaTab `Staff` with `showStandardNotation` AND `showTablature` set.
 *
 * That assumption is wrong for every other shape, and the app now produces three of them:
 *
 *   notation + tab   one Staff, two rendered staves   -> ['notation', 'tab']
 *   grand staff      two Staffs, notation each        -> ['notation', 'notation']
 *   grand + tab      three rendered staves            -> ['notation', 'notation', 'tab']
 *
 * On a grand staff the positional rule reported the BASS staff as tablature, so clicking a
 * note on it began a STRING drag on a staff that has no strings; and the open-string letters
 * were drawn down the left of the bass staff, which is a legend for something that is not there.
 *
 * So the kind is derived from the model that produced the bounds. `BarBounds.bar.staff` is the
 * `Staff` the stave was rendered from, and a Staff says for itself what it shows. One Staff can
 * produce SEVERAL staves (that is the notation+tab case), which is why this counts occurrences
 * of the same Staff object rather than assuming one BarBounds per Staff.
 *
 * Typed structurally rather than against `alphaTab.model.*` so the rule is unit-testable
 * without constructing a renderer: the tests feed it plain objects of exactly this shape.
 */

/**
 * What one rendered stave is.
 *
 * 'other' is not a failure — it is a stave this app does not model (slash, numbered). It is
 * carried rather than dropped so the INDEX of everything below it stays right; a caller that
 * needs a `StaffKind` turns it into null.
 */
export type StaveKind = 'notation' | 'tab' | 'other';

/** The parts of `alphaTab.model.Staff` that decide what gets rendered. */
export interface StaveSource {
  showStandardNotation: boolean;
  showTablature: boolean;
  showSlash?: boolean;
  showNumbered?: boolean;
}

/** The part of `alphaTab.rendering.BarBounds` that says which staff it came from. */
export interface BarBoundsLike {
  bar?: { staff?: StaveSource | null } | null;
}

/**
 * The staves ONE `Staff` renders, top to bottom.
 *
 * The order is alphaTab's, not a preference: standard notation is engraved above the tablature
 * for the same staff, which is what the whole tri-view is laid out around (the note-names row
 * lives in the gap between exactly those two). Slash and numbered are counted between them
 * because this app never emits either — they exist here only so that a score which somehow
 * carries one does not shift the tab's index and put the fret digits back where the bass clef is.
 */
export function staveKindsOf(staff: StaveSource): StaveKind[] {
  const kinds: StaveKind[] = [];
  if (staff.showStandardNotation) kinds.push('notation');
  if (staff.showSlash) kinds.push('other');
  if (staff.showNumbered) kinds.push('other');
  if (staff.showTablature) kinds.push('tab');
  return kinds;
}

/**
 * The kind of every `BarBounds` in one master bar, in the order the bounds are in.
 *
 * The same `Staff` appearing twice means it renders two staves, and the second one is the
 * second entry of `staveKindsOf`. Anything unresolvable comes back as 'other' rather than
 * guessing, because a wrong kind is a drag that edits the wrong property.
 */
export function staveKindsFromBars(bars: ReadonlyArray<BarBoundsLike>): StaveKind[] {
  const seen = new Map<StaveSource, number>();
  return bars.map((bounds) => {
    const staff = bounds?.bar?.staff;
    if (!staff) return 'other';
    const nth = seen.get(staff) ?? 0;
    seen.set(staff, nth + 1);
    return staveKindsOf(staff)[nth] ?? 'other';
  });
}

/** Every stave a track renders, top to bottom. The model-only answer, for before anything is engraved. */
export function staveKindsFromStaves(staves: ReadonlyArray<StaveSource>): StaveKind[] {
  return staves.flatMap((staff) => staveKindsOf(staff));
}

/** Index of the tablature stave among the rendered staves, or -1. The first one wins. */
export function tabStaveIndex(kinds: ReadonlyArray<StaveKind>): number {
  return kinds.indexOf('tab');
}

/** Index of the FIRST standard-notation stave, or -1. */
export function notationStaveIndex(kinds: ReadonlyArray<StaveKind>): number {
  return kinds.indexOf('notation');
}

/**
 * The only kind on offer, when there is exactly one kind on offer.
 *
 * Null when the staves are mixed: with several kinds rendered, WHICH one a pointer is on is a
 * question about geometry, and this function has none. That null is the honest answer, and the
 * caller falls back to a hit test rather than to a coin toss.
 */
export function soleStaveKind(kinds: ReadonlyArray<StaveKind>): 'notation' | 'tab' | null {
  let found: 'notation' | 'tab' | null = null;
  for (const kind of kinds) {
    if (kind === 'other') continue;
    if (found === null) found = kind;
    else if (found !== kind) return null;
  }
  return found;
}
