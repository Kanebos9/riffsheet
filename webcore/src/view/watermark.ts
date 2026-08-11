/**
 * "rendered by alphaTab" — why it is not a setting, and what is done instead.
 *
 * alphaTab 1.8.4 draws a credit line under every engraving and there is no way to ask it not
 * to. The text is a string literal inside `ScoreLayout._layoutAndRenderAnnotation`; that method
 * contains no condition at all, and every layout engine calls it unconditionally —
 * `HorizontalScreenLayout` once per render, `VerticalLayoutBase` on layout, on incremental
 * update and on resize. The `NotationElement` enum has 58 members and not one of them names it;
 * `isNotationElementVisible` is consulted at 19 places and none of them is this one. And
 * `ScoreLayout` is not exported from the package, at runtime or in the type definitions, so
 * there is no prototype to patch either.
 *
 * `NotationElement.ScoreCopyright` — which `atSettings.createSettings` already disables — is the
 * easy thing to mistake for this one: the annotation borrows its FONT, so turning it off
 * restyles the credit and leaves it exactly where it was.
 *
 * So the credit is removed from the emitted SVG. alphaTab registers the annotation as its own
 * render partial, so it arrives as an ordinary `<text>` node and deleting that node is the whole
 * operation. Nothing in alphaTab is modified, monkey-patched or vendored.
 *
 * WHAT THIS DOES NOT RECOVER: the layout still returns `y + 12`, so the 12px of vertical space
 * the annotation reserved stays reserved. Reclaiming it would mean changing the layout, which
 * would mean modifying alphaTab — the thing this approach exists to avoid. Accepted, on the
 * record, rather than worked around with a negative margin that would break at another zoom.
 */

/** The literal alphaTab emits. Matched exactly, after trimming — see `stripRendererCredit`. */
export const ALPHATAB_CREDIT_TEXT = 'rendered by alphaTab';

/**
 * Delete alphaTab's credit line from every SVG under `root`. Returns how many were removed.
 *
 * Matched on the TEXT, not on a class or a position, because the text is the only handle
 * alphaTab gives us: the node carries no identifying attribute, and its place in the partial
 * list depends on the layout mode. An exact (trimmed) match is narrow enough that it cannot take
 * a bar number or a tempo mark with it — and if a future alphaTab renames the credit, this
 * quietly removes nothing rather than quietly removing something else.
 *
 * Idempotent, and cheap enough to call on every partial: one `querySelectorAll('text')` over
 * what has just been appended.
 */
export function stripRendererCredit(root: ParentNode | null | undefined): number {
  if (!root) return 0;
  let removed = 0;
  for (const node of Array.from(root.querySelectorAll('text'))) {
    if ((node.textContent ?? '').trim() !== ALPHATAB_CREDIT_TEXT) continue;
    node.remove();
    removed++;
  }
  return removed;
}

/**
 * The same removal on SVG MARKUP, for a path that has already left the document.
 *
 * The PDF writer serialises alphaTab's partials, so a string is all it has by the time the
 * credit would matter. Anchored on a `<text>` element whose entire content is the credit;
 * nothing else this app emits is allowed to be that.
 *
 * Returns the markup unchanged when there is nothing to remove, so a caller can apply it
 * unconditionally.
 */
export function stripRendererCreditFromMarkup(svg: string): string {
  if (!svg.includes(ALPHATAB_CREDIT_TEXT)) return svg;
  return svg.replace(/<text\b[^>]*>\s*rendered by alphaTab\s*<\/text>/g, '');
}

/**
 * Every credit node still present under `root`. The harness's question, not the app's.
 *
 * A count rather than a boolean because "how many are left" is the number a check wants to
 * assert is zero, and because a paginated print instance legitimately has several partials and
 * therefore several chances to have missed one.
 */
export function countRendererCredits(root: ParentNode | null | undefined): number {
  if (!root) return 0;
  let found = 0;
  for (const node of Array.from(root.querySelectorAll('text'))) {
    if ((node.textContent ?? '').trim() === ALPHATAB_CREDIT_TEXT) found++;
  }
  return found;
}
