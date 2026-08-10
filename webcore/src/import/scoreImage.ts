/**
 * Printed score image/PDF -> compressed MusicXML handoff.
 *
 * Audiveris runs as a local native process; the browser never tries to perform
 * OMR. The eventual NativeBridge functions should use this exact JSON shape:
 *
 *   omrStatus(): Promise<OmrStatus>
 *   recognizeScoreImage(name, base64): Promise<NativeOmrResult>
 *
 * `contents` is Audiveris's .mxl output, not MIDI. It then enters the same
 * score-file importer as MusicXML/Guitar Pro and that importer supplies the
 * notes used by Riffsheet's existing MIDI exporter.
 *
 * This is printed standard-notation OMR. Audiveris deliberately ignores
 * tablature staff contents, and does not support handwritten scores. A page
 * containing staff + tab can still use the recognized staff; Riffsheet can
 * regenerate tab from those pitches afterward. A tab-only image cannot.
 */

export const SCORE_IMAGE_ACCEPT = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.omr';
export const SCORE_IMAGE_SCOPE =
  'Printed standard notation is supported. Handwriting and tab-only images are not.';

const SCORE_IMAGE_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'tif',
  'tiff',
  'bmp',
  'omr'
]);

const SCORE_IMAGE_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/bmp'
]);

export interface OmrStatus {
  available: boolean;
  executable?: string;
  version?: string;
  message: string;
}

export interface NativeOmrResult {
  ok: boolean;
  sourceName: string;
  name?: string;
  /** Base64-encoded .mxl bytes. */
  contents: string;
  convertedBy: 'audiveris';
  elapsedMs: number;
  log?: string;
}

export interface RecognizedScoreDocument {
  sourceName: string;
  name: string;
  bytes: Uint8Array;
  format: 'mxl';
  convertedBy: 'audiveris';
  elapsedMs: number;
}

export function isScoreImageName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && SCORE_IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function isScoreImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  return isScoreImageName(file.name) || SCORE_IMAGE_MIME_TYPES.has(file.type.toLowerCase());
}

/** Validate and decode the native payload before handing it to alphaTab. */
export function decodeRecognizedScore(result: NativeOmrResult): RecognizedScoreDocument {
  if (!result?.ok || result.convertedBy !== 'audiveris') {
    throw new Error('The score reader did not return a usable result.');
  }
  if (!result.contents) throw new Error('The score reader returned an empty MusicXML file.');

  let binary: string;
  try {
    binary = atob(result.contents.replace(/\s/g, ''));
  } catch {
    throw new Error('The score reader returned invalid MusicXML bytes.');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  // Audiveris exports compressed MusicXML (.mxl), which is a ZIP container.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('Audiveris did not return a compressed MusicXML file.');
  }

  return {
    sourceName: result.sourceName,
    name: result.name || `${stripExtension(result.sourceName)}.mxl`,
    bytes,
    format: 'mxl',
    convertedBy: 'audiveris',
    elapsedMs: result.elapsedMs
  };
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
