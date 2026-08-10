/**
 * A minimal PDF writer: canvases in, PDF bytes out.
 *
 * WHY THIS EXISTS AND NOT jsPDF + svg2pdf.
 *
 * The obvious route is svg2pdf, which turns the engraved SVG into real PDF vectors. It
 * cannot work here, and the reason is one byte long: `dist/font/Bravura.otf` starts with
 * `OTTO`, meaning PostScript/CFF outlines. jsPDF's `addFont` only parses TrueType (`glyf`)
 * — it has no CFF reader — so Bravura cannot be embedded, and alphaTab draws every
 * notehead, clef and rest as a `<text>` run in that font. The result would be a vector PDF
 * of neatly laid out *substitute glyphs*: a page of garbage that looks like it worked.
 * Tracing the outlines instead means shipping a CFF parser (opentype.js, ~200 KB) to solve
 * a problem the browser's own SVG rasteriser already solves for free.
 *
 * So: the page is rasterised at PDF_DPI and embedded as one image per page. What the user
 * gets is exactly what the print preview showed, at print resolution, in a file the plugin
 * can hand to a save dialog — which is the whole point, since `window.print()` opens a
 * popup a WKWebView will not give us.
 *
 * Two encodings, in preference order:
 *   1. `/FlateDecode` + `/DeviceGray` — lossless, and grayscale is honest for black ink on
 *      white paper at a third of the bytes. Needs `CompressionStream`, which every engine
 *      we target has (Chrome 80+, Safari 16.4+).
 *   2. `/DCTDecode` (JPEG) — the fallback where it does not, via `canvas.toBlob`.
 */

/** Raster resolution. 200 keeps a stave crisp on paper without a 10 MB file. */
export const PDF_DPI = 200;

/** A4 portrait, in PDF points (1/72"). */
export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;

export const PX_PER_PT = PDF_DPI / 72;

/** Millimetres to raster pixels, for laying content out on the page canvas. */
export function mmToPx(mm: number): number {
  return Math.round((mm / 25.4) * PDF_DPI);
}

export interface PdfDocumentOptions {
  title?: string;
  /** Page size in points. Defaults to A4 portrait. */
  widthPt?: number;
  heightPt?: number;
}

interface EncodedImage {
  data: Uint8Array;
  width: number;
  height: number;
  /** 'FlateDecode' | 'DCTDecode' */
  filter: string;
  colorSpace: 'DeviceGray' | 'DeviceRGB';
}

/**
 * One page per canvas, each drawn edge to edge (margins are already baked into the raster).
 */
export async function canvasesToPdf(
  pages: HTMLCanvasElement[],
  options: PdfDocumentOptions = {}
): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('There are no pages to write.');
  const widthPt = options.widthPt ?? A4_WIDTH_PT;
  const heightPt = options.heightPt ?? A4_HEIGHT_PT;

  const images: EncodedImage[] = [];
  for (const canvas of pages) images.push(await encodeCanvas(canvas));

  // Object numbering: 1 catalog, 2 pages, then three per page, then the info dict.
  const pageObj = (i: number) => 3 + i * 3;
  const contentObj = (i: number) => 4 + i * 3;
  const imageObj = (i: number) => 5 + i * 3;
  const infoObj = 3 + images.length * 3;

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    length += bytes.length;
  };
  const pushText = (text: string) => push(latin1(text));
  /** Record where object `n` starts, then write its header. */
  const beginObject = (n: number) => {
    offsets[n] = length;
    pushText(`${n} 0 obj\n`);
  };

  pushText('%PDF-1.4\n%âãÏÓ\n');

  beginObject(1);
  pushText('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  pushText(
    `<< /Type /Pages /Count ${images.length} /Kids [${images
      .map((_, i) => `${pageObj(i)} 0 R`)
      .join(' ')}] >>\nendobj\n`
  );

  images.forEach((image, i) => {
    beginObject(pageObj(i));
    pushText(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt.toFixed(2)} ${heightPt.toFixed(2)}]` +
        ` /Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> >>` +
        ` /Contents ${contentObj(i)} 0 R >>\nendobj\n`
    );

    // Place the image over the whole page: `w 0 0 h 0 0 cm` scales the unit square.
    const stream = `q\n${widthPt.toFixed(2)} 0 0 ${heightPt.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`;
    beginObject(contentObj(i));
    pushText(`<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);

    beginObject(imageObj(i));
    pushText(
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height}` +
        ` /ColorSpace /${image.colorSpace} /BitsPerComponent 8 /Filter /${image.filter}` +
        ` /Length ${image.data.length} >>\nstream\n`
    );
    push(image.data);
    pushText('\nendstream\nendobj\n');
  });

  beginObject(infoObj);
  pushText(
    `<< /Producer ${pdfString('Riffsheet')} /Creator ${pdfString('Riffsheet')}` +
      (options.title ? ` /Title ${pdfString(options.title)}` : '') +
      ' >>\nendobj\n'
  );

  const xrefAt = length;
  const count = infoObj + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) {
    xref += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  pushText(xref);
  pushText(`trailer\n<< /Size ${count} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image encoding
// ---------------------------------------------------------------------------

async function encodeCanvas(canvas: HTMLCanvasElement): Promise<EncodedImage> {
  const width = canvas.width;
  const height = canvas.height;

  if (typeof CompressionStream === 'function') {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const gray = new Uint8Array(width * height);
      for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
        // Rec. 601 luma. Engraved music is black on white, so this is lossless in practice
        // and costs two thirds of the bytes a DeviceRGB image would.
        gray[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
      }
      return { data: await deflate(gray), width, height, filter: 'FlateDecode', colorSpace: 'DeviceGray' };
    }
  }

  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.92));
  if (!blob) throw new Error('The page could not be encoded.');
  return {
    data: new Uint8Array(await blob.arrayBuffer()),
    width,
    height,
    filter: 'DCTDecode',
    colorSpace: 'DeviceRGB'
  };
}

/** zlib-wrapped deflate, which is what /FlateDecode expects (not 'deflate-raw'). */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------------------
// Bytes and strings
// ---------------------------------------------------------------------------

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** UTF-16BE hex string with a BOM — the only PDF string form safe for any file name. */
function pdfString(text: string): string {
  let hex = 'FEFF';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0xffff) {
      const v = code - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0').toUpperCase();
      hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0').toUpperCase();
    } else {
      hex += code.toString(16).padStart(4, '0').toUpperCase();
    }
  }
  return `<${hex}>`;
}
