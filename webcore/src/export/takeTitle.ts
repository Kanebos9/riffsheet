/**
 * The take's NAME, out of the name it is STORED under.
 *
 * Its own module, and DOM-free on purpose: `export/pdf.ts` reaches for the document at import
 * time (the inlined Bravura resolves against `document.baseURI`), so a rule that lives there
 * cannot be unit-tested outside a browser. This one is arithmetic on a string and is tested in
 * scripts/view-board-test.ts.
 */

/**
 * The take's NAME, out of the name it is STORED under.
 *
 * A captured take is filed as `<original>-YYYYMMDD-HHMMSS-<hash>` so two recordings of the same
 * riff cannot collide on disk. That is a filing decision, and it was being printed at the top of
 * the sheet: real exported PDFs came out titled "2.wav-20260810-193842-3f9c1a". Nobody wants a
 * timestamp and a content hash as the title of their music, and the extension is not part of the
 * piece either.
 *
 * Both suffixes are stripped ONLY in the exact shapes the app writes, anchored to the end, so a
 * piece a player has genuinely called "Take 2.wav mix" keeps its name. If stripping would leave
 * nothing at all the raw name is kept — a title is better than a blank line.
 */
export function cleanTakeTitle(raw: string): string {
  const source = raw.trim();
  let name = source.replace(/-\d{8}-\d{6}(?:-[0-9a-z]+)?$/i, '');
  name = name.replace(/\.(wav|wave|mp3|m4a|aac|aif|aiff|flac|ogg|opus|mid|midi)$/i, '');
  name = name.trim();
  return name.length > 0 ? name : source;
}
