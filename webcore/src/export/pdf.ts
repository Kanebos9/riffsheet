/**
 * PDF export.
 *
 * A hidden, second alphaTab instance configured for print (LayoutMode.Page, lazy loading
 * OFF — mandatory, or partials never render into a hidden host) engraves the score once.
 * Its SVGs then feed two consumers:
 *
 *   buildPrintDocument()  -> a standalone HTML document (browser printing, and the harness)
 *   renderScorePdf()      -> real PDF bytes, in-page, for bridge.exportFile()
 *
 * WHY THE FONT INLINE IS NOT OPTIONAL: alphaTab renders glyphs as <text> in a webfont, not
 * as paths. A naked alphaTab <svg> dropped into a fresh document — or into an <img> — draws
 * blank noteheads. The data-URI @font-face fixes it in both.
 *
 * WHY BYTES AND NOT window.print(): the print popup is blocked in a plugin WebView, so the
 * PDF button was simply dead there. `printScore()` survives as a browser-only fallback and
 * is never called in plugin mode. The rasterise-and-embed decision behind the byte path is
 * argued in ./pdfWriter.ts — short version: Bravura is a CFF font, so no JS PDF library can
 * embed it, and substitute glyphs would be worse than a crisp raster.
 */

import * as alphaTab from '@coderline/alphatab';
import { createPrintSettings, FONT_DIRECTORY } from '../view/atSettings';
import { stringLettersFromBounds, tuningLowToHighFromScore, type StringLetter } from '../view/stringLetters';
import { stripRendererCredit, stripRendererCreditFromMarkup } from '../view/watermark';
import { buildAlphaTabScore } from '../score/fromPipeline';
import { A4_HEIGHT_PT, A4_WIDTH_PT, PX_PER_PT, canvasesToPdf, mmToPx } from './pdfWriter';
import { cleanTakeTitle } from './takeTitle';
import type { RiffScore } from '../pipeline';

let cachedFontCss: string | null = null;

/** Fetch Bravura once and turn it into an inline @font-face rule. */
async function bravuraFontFace(): Promise<string> {
  if (cachedFontCss) return cachedFontCss;
  const response = await fetch(new URL('Bravura.woff2', FONT_DIRECTORY).href);
  if (!response.ok) throw new Error(`Could not load Bravura for printing (${response.status}).`);
  const buffer = await response.arrayBuffer();

  let binary = '';
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const base64 = btoa(binary);

  cachedFontCss = `@font-face{font-family:alphaTab;src:url(data:font/woff2;base64,${base64}) format('woff2');font-weight:normal;font-style:normal;}`;
  return cachedFontCss;
}

export interface PrintOptions {
  title?: string;
  subtitle?: string;
}

/**
 * Engrave the score in a hidden print instance and hand the SVGs to `use`.
 *
 * The instance is always torn down, including when `use` throws — a leaked AlphaTabApi
 * keeps a font-loading listener and a detached 820px host alive for the session.
 */
/**
 * What the print render knows beyond the pictures: where each SVG sits in the hidden host, and
 * the tab's open-string letters in those same host coordinates.
 *
 * Both are needed for one reason — the string letters (view/stringLetters.ts) are OUR drawing,
 * not alphaTab's, so the paper has to place them itself, and it can only do that if it knows
 * how each rasterised system relates to the coordinates the bounds lookup speaks.
 */
interface PrintGeometry {
  /** Top-left of each SVG inside the hidden host, index-parallel with the svgs array. */
  offsets: Array<{ x: number; y: number }>;
  letters: StringLetter[];
}

async function withPrintRender<T>(
  score: RiffScore,
  use: (svgs: SVGSVGElement[], geometry: PrintGeometry) => Promise<T>
): Promise<T> {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:820px;background:#fff;';
  document.body.appendChild(host);

  const settings = createPrintSettings();
  const api = new alphaTab.AlphaTabApi(host, settings);

  try {
    const built = await new Promise<ReturnType<typeof buildAlphaTabScore>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Print render timed out.')), 30000);
      const result = buildAlphaTabScore(score.data, settings);
      api.postRenderFinished.on(() => {
        clearTimeout(timer);
        resolve(result);
      });
      api.renderScore(result.score, [0]);
    });

    // #40: alphaTab's "rendered by alphaTab" credit, out of the PRINTED sheet as well as the
    // screen one. Removed BEFORE the rectangles below are measured, because the credit is
    // centred over the score and would otherwise widen the box a page is laid out against —
    // and before `inlineTextStyles`, so there is one fewer <text> to walk. See view/watermark.ts
    // for why this is a DOM removal and not a setting.
    stripRendererCredit(host);

    const svgs = Array.from(host.querySelectorAll('svg'));
    for (const svg of svgs) inlineTextStyles(svg);

    // Measured, not assumed: alphaTab may put several systems in one partial SVG, and the
    // paper decides which letters belong to which picture by comparing rectangles.
    const hostRect = host.getBoundingClientRect();
    const offsets = svgs.map((svg) => {
      const r = svg.getBoundingClientRect();
      return { x: r.left - hostRect.left, y: r.top - hostRect.top };
    });
    const letters = stringLettersFromBounds(
      api.renderer.boundsLookup,
      tuningLowToHighFromScore(built.score)
    );

    return await use(svgs, { offsets, letters });
  } finally {
    api.destroy();
    host.remove();
  }
}

/**
 * Write each `<text>`'s computed font onto the element itself.
 *
 * THIS IS WHAT MAKES THE NOTEHEADS APPEAR. alphaTab does not put the music font on the
 * glyphs it emits — the SVG it produces carries no `font-family` of its own anywhere.
 * (It did once say "the SVG contains the string 'alphaTab' exactly zero times", which was
 * never quite true and is now plainly false: the renderer emits a "rendered by alphaTab"
 * credit line as a `<text>` node. `stripRendererCredit` above removes it before we get here,
 * so by this point the claim holds again — but the reason it holds is that we deleted it, not
 * that alphaTab never wrote it. See view/watermark.ts.)
 * The family and size arrive by inheritance from a rule in the *document's* stylesheet onto
 * `<g class="at">`. Lift that SVG out of the document (serialise it into a print file, clone
 * it into an `<img>`) and the rule does not come with it, so every notehead, clef and rest
 * falls back to a text font that has nothing at U+E000 and up, and renders as an empty box.
 *
 * The page looks *almost* right when this is wrong — staff lines, stems and beams are plain
 * shapes and survive — which is exactly why it went unnoticed in the HTML print path.
 *
 * Reading the computed value rather than hard-coding `36px alphaTab` keeps this correct
 * across alphaTab's own scale settings and its mixed sizes (grace notes, bar numbers in
 * Arial, the tempo mark), and it cannot drift when alphaTab changes its CSS.
 */
function inlineTextStyles(svg: SVGSVGElement): void {
  for (const text of Array.from(svg.querySelectorAll('text'))) {
    const computed = getComputedStyle(text);
    text.style.fontFamily = computed.fontFamily;
    text.style.fontSize = computed.fontSize;
    text.style.fontWeight = computed.fontWeight;
    text.style.fontStyle = computed.fontStyle;
    // Same story one level down: a fill that came from CSS rather than an attribute would
    // be lost too, and a black bar number is less obvious than a missing notehead.
    text.style.fill = computed.fill;
  }
}

/**
 * Render the score into a hidden print instance and hand back a standalone HTML document.
 * Exposed separately from `printScore` so it can be unit-tested and so a future
 * bridge-side "save as PDF" can take the HTML without touching the DOM twice.
 */
export async function buildPrintDocument(score: RiffScore, options: PrintOptions = {}): Promise<string> {
  // The name of the piece, not the name of the file it is filed under. See `cleanTakeTitle`.
  const title = options.title ? cleanTakeTitle(options.title) : options.title;
  return withPrintRender(score, async (elements) => {
    // The DOM strip in `withPrintRender` has already run, so this normally changes nothing and
    // returns the same string. It is here because THIS is the document that leaves the app —
    // saved, mailed, printed — and it is the last point at which the credit could be caught if
    // a future alphaTab emitted one after the strip (from a re-layout on resize, say). Cheap:
    // one `includes` on markup we have just built.
    const svgs = elements.map((svg) => stripRendererCreditFromMarkup(svg.outerHTML)).join('\n');
    const fontCss = await bravuraFontFace();

    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title ?? 'Riffsheet')}</title>
<style>
${fontCss}
@page { size: A4 portrait; margin: 14mm; }
html,body { margin:0; padding:0; background:#fff; color:#000;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
h1 { font-size: 18pt; margin: 0 0 2mm; }
h2 { font-size: 11pt; font-weight: 400; color:#555; margin: 0 0 6mm; }
svg { max-width: 100%; height: auto; page-break-inside: avoid; }
footer { margin-top: 8mm; font-size: 8pt; color:#888; }
</style></head>
<body>
${title ? `<h1>${escapeHtml(title)}</h1>` : ''}
${options.subtitle ? `<h2>${escapeHtml(options.subtitle)}</h2>` : ''}
${svgs}
<footer>Made with Riffsheet</footer>
</body></html>`;
  });
}

/**
 * Print the score. Uses a same-origin iframe rather than a popup window: popups are
 * blocked in a WKWebView and would be the wrong shape inside a plugin anyway.
 *
 * BROWSER ONLY. In the plugin even the iframe route dead-ends — WKWebView gives the page no
 * print dialog at all, which is exactly the bug the user reported. Plugin mode uses
 * `renderScorePdf()`.
 */
export async function printScore(score: RiffScore, options: PrintOptions = {}): Promise<void> {
  const html = await buildPrintDocument(score, options);

  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    throw new Error('Could not open a print view.');
  }
  doc.open();
  doc.write(html);
  doc.close();

  // Wait for the inlined font to be ready, or the first print draws blank noteheads.
  try {
    await frame.contentDocument?.fonts?.ready;
  } catch {
    /* fonts API unavailable — proceed anyway */
  }
  await new Promise((ok) => setTimeout(ok, 120));

  frame.contentWindow?.focus();
  frame.contentWindow?.print();

  // Leave it around briefly; removing it immediately can cancel the print dialog.
  setTimeout(() => frame.remove(), 60000);
}

// ---------------------------------------------------------------------------
// PDF bytes — the path the export button actually uses
// ---------------------------------------------------------------------------

/**
 * How big an open-string letter is on paper, in points.
 *
 * 4.5 pt, down from 6 (G18). At 6 they came out as big as the fret digits they are a legend
 * FOR, which inverts the hierarchy of the page: the legend shouted and the music did not. It is
 * read once per system, at reading distance, and small is what a tab book prints it at.
 *
 * It is a CEILING rather than the size: the real size is capped against the tab's own line
 * spacing as well — see `stringLetterSize`.
 */
const STRING_LETTER_PT = 4.5;

/**
 * The size an open-string letter is actually drawn at, in page pixels.
 *
 * THE LINE SPACING IS THE REAL CONSTRAINT, and ignoring it is why the letters touched. They are
 * stacked one per tab line, and the tab lines on a printed page are a few points apart — closer
 * on a shrunk system, closer still on a six-string staff. A size chosen only in points is
 * therefore sometimes larger than the gap it has to sit in, and four letters become one grey
 * smudge with no space between them.
 *
 * So the point size is a ceiling and the measured gap is the other: 68% of the smallest gap
 * between two adjacent letters leaves a clear line of white between every pair at any staff
 * size, on any page, without anything having to know how many strings there are.
 *
 * `ys` are the letters' baselines in PAGE pixels, in any order. A single letter (or none) has no
 * gap to measure and simply takes the point size.
 */
function stringLetterSize(ys: ReadonlyArray<number>, shrink: number): number {
  const sorted = [...ys].sort((a, b) => a - b);
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, sorted[i] - sorted[i - 1]);
  const fromPoints = STRING_LETTER_PT * PX_PER_PT * shrink;
  const fromSpacing = Number.isFinite(minGap) ? minGap * 0.68 : Number.POSITIVE_INFINITY;
  return Math.max(3.5, Math.min(fromPoints, fromSpacing));
}

const PAGE_MARGIN_MM = 14;
/** Breathing room between systems, as a fraction of an inch. */
const SYSTEM_GAP_MM = 4;

/**
 * Engrave the score and return a finished PDF, without a print dialog anywhere.
 *
 * Layout mirrors the print stylesheet on purpose — A4 portrait, 14 mm margins, systems
 * fitted to the text width and never split across a page break — so "print" and "save PDF"
 * cannot drift apart.
 */
export async function renderScorePdf(score: RiffScore, options: PrintOptions = {}): Promise<Uint8Array> {
  const fontCss = await bravuraFontFace();
  // The piece's name, not the file's. Applied once, here, so the heading on the page and the
  // title in the PDF's own metadata cannot disagree. See `cleanTakeTitle`.
  const title = options.title ? cleanTakeTitle(options.title) : options.title;

  const pageW = Math.round(A4_WIDTH_PT * PX_PER_PT);
  const pageH = Math.round(A4_HEIGHT_PT * PX_PER_PT);
  const margin = mmToPx(PAGE_MARGIN_MM);
  const contentW = pageW - margin * 2;
  const gap = mmToPx(SYSTEM_GAP_MM);

  const systems = await withPrintRender(score, async (elements, geometry) => {
    if (elements.length === 0) throw new Error('The sheet came out empty.');
    const out: Array<{
      image: HTMLImageElement;
      /** Host px -> page px for this picture. */
      scale: number;
      /** The letters that belong to it, already in ITS coordinates. */
      letters: StringLetter[];
    }> = [];
    for (let i = 0; i < elements.length; i++) {
      const svg = elements[i];
      const image = await svgToImage(svg, fontCss, contentW);
      const offset = geometry.offsets[i] ?? { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      const scale = rect.width > 0 ? image.width / rect.width : 1;
      // A letter belongs to this picture when its LINE falls inside it. Compared on y alone
      // because the letters sit in the page padding, a little to the LEFT of the staff, and a
      // strict x containment would drop every one of them.
      const letters = geometry.letters
        .filter((l) => l.y >= offset.y - 1 && l.y <= offset.y + rect.height + 1)
        .map((l) => ({ ...l, x: l.x - offset.x, y: l.y - offset.y }));
      out.push({ image, scale, letters });
    }
    return out;
  });

  const pages: HTMLCanvasElement[] = [];
  let cursorY = 0;

  const newPage = (): CanvasRenderingContext2D => {
    const canvas = document.createElement('canvas');
    canvas.width = pageW;
    canvas.height = pageH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser would not give us a canvas to draw the PDF on.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pageW, pageH);
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'top';
    pages.push(canvas);
    cursorY = margin;
    return ctx;
  };

  let page = newPage();

  // Heading, page 1 only — same sizes as the print stylesheet's h1/h2.
  if (title) {
    page.font = `600 ${Math.round(18 * PX_PER_PT)}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    page.fillText(title, margin, cursorY, contentW);
    cursorY += Math.round(24 * PX_PER_PT);
  }
  if (options.subtitle) {
    page.fillStyle = '#555555';
    page.font = `${Math.round(11 * PX_PER_PT)}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    page.fillText(options.subtitle, margin, cursorY, contentW);
    page.fillStyle = '#000000';
    cursorY += Math.round(18 * PX_PER_PT);
  }

  for (const system of systems) {
    const image = system.image;
    let w = image.width;
    let h = image.height;
    // A system taller than a whole page can only be shrunk; it must not be cropped.
    const maxH = pageH - margin * 2;
    if (h > maxH) {
      w = Math.round(w * (maxH / h));
      h = maxH;
    }
    if (cursorY + h > pageH - margin) {
      page = newPage();
    }
    page.drawImage(image, margin, cursorY, w, h);

    // THE TAB'S OWN LEGEND, on every system of the printed page — the whole point of moving it
    // off the toolbar. Drawn onto the page rather than into the SVG so it lands at exactly the
    // scale the picture was drawn at, whatever shrinking the page break just imposed.
    if (system.letters.length > 0) {
      const shrink = (h / image.height) * system.scale;
      const size = stringLetterSize(system.letters.map((l) => l.y * shrink), shrink);
      page.save();
      page.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      // FULL BLACK (G18). It was #444, which on a laser print of an already-small glyph comes
      // out as a grey suggestion of a letter. Everything else engraved on this page is black
      // ink; a legend printed lighter than the thing it explains reads as a watermark.
      page.fillStyle = '#000000';
      page.textAlign = 'right';
      page.textBaseline = 'middle';
      // A hair of tracking, where the browser will give it: at this size a monospace pair can
      // still look joined. Assigned through a cast because `letterSpacing` is not in every
      // TypeScript DOM lib yet, and simply ignored where it is not supported.
      (page as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0.3px';
      for (const letter of system.letters) {
        page.fillText(letter.text, margin + letter.x * shrink, cursorY + letter.y * shrink);
      }
      page.restore();
    }
    cursorY += h + gap;
  }

  // Footer on the last page, matching the print document's line.
  const footerSize = Math.round(8 * PX_PER_PT);
  const last = pages[pages.length - 1].getContext('2d');
  if (last) {
    last.fillStyle = '#888888';
    last.font = `${footerSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    last.fillText('Made with Riffsheet', margin, pageH - margin - footerSize);
  }

  return canvasesToPdf(pages, { title });
}

/**
 * One engraved SVG -> a decoded raster at `targetWidth` pixels.
 *
 * Two details make or break this:
 *
 *  1. The @font-face goes INSIDE the SVG. An `<img>` renders SVG in a sandbox with no
 *     access to the parent document's stylesheets or fonts and no network at all, so a
 *     document-level rule would be ignored and every glyph would come out blank. The
 *     data-URI src is not "external" and does load.
 *  2. The width/height ATTRIBUTES are set to the final pixel size, with a viewBox holding
 *     the original coordinate system. Browsers rasterise an SVG image at its intrinsic
 *     size and only then scale the bitmap, so passing a bigger size to `drawImage` would
 *     give a blurry stave. Making the intrinsic size the target size renders it sharp.
 */
async function svgToImage(svg: SVGSVGElement, fontCss: string, targetWidth: number): Promise<HTMLImageElement> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const naturalWidth = numeric(svg.getAttribute('width')) || svg.getBoundingClientRect().width || targetWidth;
  const naturalHeight = numeric(svg.getAttribute('height')) || svg.getBoundingClientRect().height || 1;

  if (!clone.getAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${naturalWidth} ${naturalHeight}`);
  }
  const scale = targetWidth / naturalWidth;
  clone.setAttribute('width', String(Math.round(naturalWidth * scale)));
  clone.setAttribute('height', String(Math.round(naturalHeight * scale)));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  // Only the @font-face. The per-element fonts and fills are already inline by now
  // (`inlineTextStyles`), and a blanket `text{fill:#000}` here would quietly recolour the
  // red bar numbers.
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = fontCss;
  clone.insertBefore(style, clone.firstChild);

  const markup = new XMLSerializer().serializeToString(clone);
  const image = new Image();
  // A data: URI rather than a blob: URL — it is unambiguously same-origin, so the canvas
  // it is drawn onto is never tainted and getImageData() keeps working.
  image.src = `data:image/svg+xml;base64,${base64Utf8(markup)}`;
  await imageReady(image);
  return image;
}

function imageReady(image: HTMLImageElement): Promise<void> {
  if (typeof image.decode === 'function') {
    return image.decode().catch(() => waitForLoad(image));
  }
  return waitForLoad(image);
}

function waitForLoad(image: HTMLImageElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (image.complete && image.naturalWidth > 0) return resolve();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('The engraved page could not be rasterised.'));
  });
}

function numeric(value: string | null): number {
  const n = value ? parseFloat(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
