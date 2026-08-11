/**
 * Session persistence — the fix for plugin amnesia.
 *
 * THE PROBLEM. In REAPER (and every other DAW) the plugin editor is destroyed the moment
 * the user clicks another track or another FX. The WebView goes with it, and so does every
 * JavaScript object in this app: the loaded take, the engraved score, the user's edits. Come
 * back to the track and the plugin is empty. It was reported twice, and it is the single
 * worst thing about using Riffsheet in a DAW.
 *
 * THE FIX. State that must survive the editor cannot live in the editor. The host's
 * PROCESSOR outlives it (shell/BRIDGE.md §5), so the page hands a blob down on every
 * meaningful change and asks for it back on boot. The shell also writes that blob into
 * `getStateInformation()`, so the same mechanism carries a saved project across a reload.
 *
 * WHAT IS IN THE BLOB, AND WHAT IS NOT. Not the score: the score is a pure function of the
 * detected notes, the settings and the bar-1 position, and rebuilding it costs milliseconds
 * (`rebuildNotation`) against seconds for a transcription. So we store the CHEAP inputs and
 * recompute — the take's identity, the detected notes, the settings, and the edit log — and
 * a restore never re-listens to the audio.
 *
 * Two things are stored that are not strictly inputs, both for the same reason: the app must
 * come back looking right even when the audio itself cannot be recovered.
 *   - the waveform peaks, quantised to one byte per bucket (~5 KB), so the strip draws
 *     without re-fetching a few million floats;
 *   - the audio's identity (token AND path), because a token is only good for the life of
 *     the process while a path survives a project reload.
 */

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

import type { InputNote } from '../pipeline';
import type { EditSpec } from '../edit/actions';
import type { NativeBridge } from '../bridge';
import type { TrimResult } from '../audio/trim';
import type { AppSettings, HostGrid, SourceAudio } from './state';
import { normalizeCuts, type CutSpan } from '../edit/cuts';

/** Raise this AND add a case in `readSession()` when the shape has to change under people. */
export const SESSION_VERSION = 1;

/** How the take can be got back. See the file header. */
export interface PersistedAudio {
  /** 'file' can be re-opened by path; 'capture' is a legacy unsaved capture; 'midi' has no audio. */
  kind: 'file' | 'capture' | 'midi';
  name: string;
  /** Empty only for legacy captures, browser-side drops and MIDI. */
  path: string;
  /** The shell's handle. Valid until the process ends — dead after a project reload. */
  token?: string;
  /**
   * Where the decoded mono samples can be fetched as binary.
   *
   * Kept so the tuner can get the actual audio back after the plugin window has been closed
   * and rebuilt. It dies with the token — after a project reload the fetch 404s and a fresh
   * one comes back from `loadAudioPath`, which is exactly the same lifetime the token has.
   */
  pcmUrl?: string;
  durationSec: number;
}

export interface PersistedPeaks {
  buckets: number;
  /** Base64 of one signed byte per bucket. A waveform strip cannot see the difference. */
  min: string;
  max: string;
}

export interface PersistedSource {
  name: string;
  durationSec: number;
  barOneSec: number;
  trim: TrimResult | null;
  hostGrid?: HostGrid;
  tempoBpm?: number;
  timeSignature?: { numerator: number; denominator: number };
  keyFifths?: number;
  documentBars?: number;
  peaks?: PersistedPeaks;
  /** The detections. THIS is what makes a restore free — no re-transcription. */
  detected?: { notes: InputNote[]; beats?: number[]; downbeats?: number[] };
  /**
   * F16 — the spans the player cut out, in AUDIO seconds (`edit/cuts.ts`).
   *
   * Has to be written, and cannot be recomputed: a cut is a decision, not a derivation. Leaving
   * it out of the blob meant a restore came back with the full take — the silence back at the
   * front, the edited clock reset — while the notation edits, which are keyed on note ids that
   * a cut deliberately does not renumber, replayed on top of it. The list is the cheapest thing
   * in the whole blob: a handful of number pairs.
   *
   * Omitted rather than written as `[]` when there are no cuts, so a take that was never cut
   * serialises to exactly the bytes it did before this field existed.
   */
  cuts?: CutSpan[];
}

export interface PersistedSession {
  v: number;
  /** Guards against reading somebody else's blob out of a shared store. */
  app: 'riffsheet';
  savedAt: number;
  source: PersistedSource | null;
  audio: PersistedAudio | null;
  /** Original MIDI for symbolic imports, so an exact source export survives editor rebuilds. */
  sourceMidi?: string;
  /** Only the keys the user can actually change; merged over defaults on the way back. */
  settings: Partial<AppSettings>;
  /** View state that is not a setting. The fader is the whole of it, so far. */
  view: { blend: number };
  /** The user's edits, in order. Replayed over a freshly built score. */
  edits: EditSpec[];
  /** How far into `edits` the user is — undo moves it back without discarding anything. */
  editCursor: number;
}

// ---------------------------------------------------------------------------
// Peaks: Float32Array <-> one byte per bucket
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeChannel(values: Float32Array): string {
  const bytes = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    // -1..1 -> -127..127, clamped. Peaks outside that range are already a lie.
    const q = Math.max(-127, Math.min(127, Math.round(values[i] * 127)));
    bytes[i] = q & 0xff;
  }
  return bytesToBase64(bytes);
}

function decodeChannel(b64: string, buckets: number): Float32Array {
  const bytes = base64ToBytes(b64);
  const out = new Float32Array(buckets);
  const n = Math.min(buckets, bytes.length);
  for (let i = 0; i < n; i++) {
    const signed = bytes[i] > 127 ? bytes[i] - 256 : bytes[i];
    out[i] = signed / 127;
  }
  return out;
}

export function encodePeaks(peaks: { min: Float32Array; max: Float32Array } | null): PersistedPeaks | undefined {
  if (!peaks || peaks.min.length === 0) return undefined;
  return { buckets: peaks.min.length, min: encodeChannel(peaks.min), max: encodeChannel(peaks.max) };
}

export function decodePeaks(peaks: PersistedPeaks | undefined): { min: Float32Array; max: Float32Array } | null {
  if (!peaks || !peaks.buckets) return null;
  try {
    return { min: decodeChannel(peaks.min, peaks.buckets), max: decodeChannel(peaks.max, peaks.buckets) };
  } catch {
    // A corrupt blob must cost the waveform strip, not the whole session.
    return null;
  }
}

// ---------------------------------------------------------------------------
// SourceAudio <-> PersistedSource
// ---------------------------------------------------------------------------

export function encodeSource(source: SourceAudio | null): PersistedSource | null {
  if (!source) return null;
  return {
    name: source.name,
    durationSec: source.durationSec,
    barOneSec: source.barOneSec,
    trim: source.trim,
    hostGrid: source.hostGrid,
    tempoBpm: source.tempoBpm,
    timeSignature: source.timeSignature,
    keyFifths: source.keyFifths,
    documentBars: source.documentBars,
    peaks: encodePeaks(source.peaks),
    // Note times are NOT rounded. They are the input the whole sheet is quantised from, and
    // a note sitting on a grid boundary must land on the same side of it after a restore.
    detected: source.detected
      ? { notes: source.detected.notes, beats: source.detected.beats, downbeats: source.detected.downbeats }
      : undefined,
    // Copied, not aliased: the blob is handed to `JSON.stringify` asynchronously (SessionStore
    // debounces), and a list that keeps changing underneath the writer is a race nobody would
    // find. Empty stays undefined — see the field's note.
    cuts: source.cuts?.length ? source.cuts.map((c) => ({ fromSec: c.fromSec, toSec: c.toSec })) : undefined
  };
}

export function decodeSource(source: PersistedSource | null | undefined): SourceAudio | null {
  if (!source || typeof source.name !== 'string') return null;
  return {
    name: source.name,
    durationSec: Number(source.durationSec) || 0,
    peaks: decodePeaks(source.peaks),
    trim: source.trim ?? null,
    barOneSec: Number(source.barOneSec) || 0,
    // A blob written before HostGrid grew a `source` field can only have come from a capture —
    // that was the sole way to get one. Filled in rather than left undefined so nothing
    // downstream has to ask "and what if it is missing?".
    hostGrid: source.hostGrid ? { ...source.hostGrid, source: source.hostGrid.source ?? 'capture' } : undefined,
    tempoBpm: finiteInRange(source.tempoBpm, 20, 400),
    timeSignature: validTimeSignature(source.timeSignature),
    keyFifths: finiteInRange(source.keyFifths, -7, 7, true),
    documentBars: finiteInRange(source.documentBars, 1, 512, true),
    detected: Array.isArray(source.detected?.notes)
      ? { notes: source.detected.notes, beats: source.detected.beats, downbeats: source.detected.downbeats }
      : undefined,
    // Through the SAME gate the live app uses. Everything downstream of `state.source.cuts`
    // assumes a normalized list — disjoint, sorted, in range — and none of it re-checks, so a
    // hand-edited or truncated blob carrying overlapping spans would silently break the
    // audio<->edited clocks being inverses of each other. Normalizing on the way in costs a
    // sort of a handful of pairs and makes the restored list indistinguishable from a live one.
    cuts: decodeCuts(source.cuts, Number(source.durationSec) || 0)
  };
}

function decodeCuts(value: unknown, durationSec: number): CutSpan[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cuts = normalizeCuts(value as CutSpan[], durationSec);
  return cuts.length ? cuts : undefined;
}

function finiteInRange(value: unknown, min: number, max: number, integer = false): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return integer ? Math.round(n) : n;
}

function validTimeSignature(value: unknown): { numerator: number; denominator: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { numerator?: unknown; denominator?: unknown };
  const numerator = finiteInRange(v.numerator, 1, 32, true);
  const denominator = finiteInRange(v.denominator, 1, 32, true);
  return numerator && denominator ? { numerator, denominator } : undefined;
}

// ---------------------------------------------------------------------------
// Portable .riffsheet documents
// ---------------------------------------------------------------------------

/**
 * What this build WRITES. Readers accept anything from v1 up to this — see
 * `readRiffsheetDocument` — so a document made before the audio moved inside still opens.
 */
export const RIFFSHEET_DOCUMENT_VERSION = 3;

/**
 * THE CONTAINER, and why it changed twice.
 *
 * v1 carried only a REFERENCE — a path and a name — which made a `.riffsheet` a note about a
 * recording rather than a copy of one. Mail it to somebody, open it on another machine, or simply
 * move the wav, and the sheet arrived with a silent Original fader and a dead "Listen again".
 *
 * v2 put the bytes inside the file, base64'd into the JSON. That fixed portability and bought a
 * memory problem with it. Saving a 50 MB take meant, at the peak, all of these alive at once: the
 * audio itself, a base64 STRING of it (4/3 the bytes, and a JS string is UTF-16, so 8/3 the
 * memory), the whole `JSON.stringify` output with that string inside it, and the UTF-8 encoding of
 * THAT — before the bridge then base64'd the lot a second time on its way to the shell. Roughly
 * seven to eight times the recording, to write a file that is meant to be about the size of the
 * recording.
 *
 * v3 is a ZIP, which is the format that was always right for "a document plus a media file":
 *
 *   score.json          — the document, DEFLATE'd. It is JSON and compresses well.
 *   audio/<filename>    — the recording, STORED (uncompressed).
 *
 * The audio is STORED rather than deflated for two reasons. Compressed audio (mp3, flac, m4a) does
 * not shrink — running deflate over it spends CPU and memory to save a fraction of a percent — and
 * STORE means the bytes sit in the file verbatim, so writing is a copy and reading is a slice.
 * That is what makes the round trip byte-identical by construction rather than by luck.
 *
 * The name inside `audio/` is the take's own file name, so anyone who renames a `.riffsheet` to
 * `.zip` and opens it finds their recording under the name they gave it.
 */
const SCORE_ENTRY = 'score.json';
const AUDIO_DIR = 'audio/';

/**
 * The most audio a document may carry, going in and coming out.
 *
 * There is no product reason for a ceiling at all; this one exists so that a corrupt or hostile
 * file cannot ask the process to allocate without limit. It is enforced on the WRITE side too —
 * an open-ended save that dies somewhere inside the allocator is worse than a refusal that says
 * what happened.
 */
export const MAX_DOCUMENT_AUDIO_BYTES = 512 * 1024 * 1024;

/**
 * The take's actual audio, inside the document (#34).
 *
 * `bytes` is RAW here, and raw all the way to the zip entry. It used to be a base64 string,
 * because the v2 container was JSON and a JSON string cannot hold arbitrary bytes; a zip entry
 * can, so the encode/decode pair either side of it is simply gone. That is the single biggest
 * saving on both paths — see the container note above.
 *
 * The bytes are the ORIGINAL FILE verbatim wherever there was one, so an mp3 stays an mp3 and
 * re-opening it decodes exactly what the player imported. Only a recorded take, which never had a
 * container of its own, is encoded here — as WAV, by `encodeWavPcm16`.
 */
export interface EmbeddedAudio {
  /** The original file's name, so a re-export can offer it back under the name it came in as. */
  name: string;
  /** The container actually stored, e.g. 'audio/wav'. Empty when the import did not say. */
  mime: string;
  bytes: Uint8Array;
  durationSec: number;
  /** Present for takes this app encoded itself; absent for a verbatim copy of an import. */
  sampleRate?: number;
}

/**
 * The audio block as it appears inside a v3 `score.json`: everything about the recording EXCEPT
 * the recording, which is the zip entry named by `entry`.
 */
interface StoredAudioRef {
  name: string;
  mime: string;
  /** 'zip' in v3. The legacy 'base64' form is read from plain JSON documents only. */
  encoding: 'zip';
  entry: string;
  durationSec: number;
  sampleRate?: number;
}

export interface RiffsheetDocument {
  app: 'riffsheet-document';
  version: number;
  savedAt: number;
  name: string;
  source: PersistedSource;
  settings: Partial<AppSettings>;
  edits: EditSpec[];
  editCursor: number;
  sourceMidi?: string;
  /**
   * The take itself, when it could be got. Absent in every v1 document and in one written from
   * a symbolic import, where there is no recording to embed.
   *
   * `audio` below stays as well and is still worth writing: it names WHERE the take came from,
   * which is what lets a re-opened document offer the original path, and it is the only thing a
   * v1 reader would have understood.
   */
  audioData?: EmbeddedAudio | null;
  /**
   * Which take this document is OF, so reopening it can find the audio again.
   *
   * Optional, and deliberately not a version bump: `readRiffsheetDocument` rejects any version
   * it does not recognise, so raising the number would make every document written before this
   * field unopenable. A document without it simply has no take to look for.
   *
   * Only the durable half of `PersistedAudio` is written — see `portableAudioRef`.
   */
  audio?: PersistedAudio | null;
}

/**
 * What has to happen before a document's embedded recording can actually SOUND.
 *
 * THE BUG THIS ENCODES THE FIX FOR. Opening a document with audio inside it reported the Original
 * as available and then played silence. `Transport` sounds the Original through `bridge.play()`,
 * the JUCE shell addresses audio by TOKEN, and the restore called `loadOriginal` with a ref that
 * carried bytes and no token — which that shell answers with `durationSec: 0`, having done
 * nothing. Nobody read the answer. The browser's mock bridge decodes `ref.bytes` directly and
 * genuinely works, so every test that ran outside a DAW passed.
 *
 * Pulled out of ui/app.ts as a pure function for one reason: it is a RULE, not a gesture, and a
 * rule that can only be exercised by building a WebView and clicking play is a rule that gets
 * broken again. `scripts/riffsheet-doc-test.ts` checks all three branches directly.
 *
 * The rule: never report an Original that will be silent.
 */
export type OriginalPlayback =
  /** The host took the bytes. Playable now. */
  | { state: 'ready' }
  /** The host wants a token. Playable once one is minted — lazily, on the first press of play. */
  | { state: 'needs-token' }
  /** No route to sound at all. The fader must go dark, and the player must be told why. */
  | { state: 'unplayable'; message: string };

export function originalPlaybackAfterLoad(
  loadedDurationSec: number,
  canLoadAudioBytes: boolean
): OriginalPlayback {
  if (loadedDurationSec > 0) return { state: 'ready' };
  if (canLoadAudioBytes) return { state: 'needs-token' };
  return {
    state: 'unplayable',
    message:
      'The recording is inside this document and the waveform and tuner can read it, but this ' +
      'version of the app cannot hand it to the player. Update the app to hear the original again.'
  };
}

/**
 * The half of an audio handle that is worth writing into a FILE.
 *
 * A session blob lives inside one process and can carry `token`/`pcmUrl`, which are handles
 * into that process's memory. A `.riffsheet` document outlives the process and can be opened
 * on another machine entirely, where those two are worse than useless: they name a decode that
 * no longer exists, and `reopenOriginal` would try the dead token before the path that would
 * have worked. So they are dropped here rather than at every call site.
 */
export function portableAudioRef(audio: PersistedAudio | null | undefined): PersistedAudio | null {
  if (!audio) return null;
  return { kind: audio.kind, name: audio.name, path: audio.path, durationSec: audio.durationSec };
}

/**
 * A container type for a file name, for the embedded-audio block.
 *
 * Only used as a LABEL — nothing decodes by it, since `decodeAudioData` sniffs the bytes — so an
 * unknown extension is answered with '' rather than a guess that would be wrong more often than
 * the empty string is unhelpful.
 */
export function audioMimeForName(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  switch (ext) {
    case 'wav':
    case 'wave':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'ogg':
    case 'oga':
      return 'audio/ogg';
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'aif':
    case 'aiff':
      return 'audio/aiff';
    default:
      return '';
  }
}

/**
 * A file name the SHELL can decode by, for embedded bytes handed to `loadAudioBytes`.
 *
 * The page decodes audio by sniffing the bytes, so a name is only a label to it (see
 * `audioMimeForName`). The shell does not: it stages the bytes as a file and JUCE's format
 * manager picks its reader from the extension, so a document whose embedded block was named
 * "recording" or "Take 3" would be handed to no decoder at all and come back "unsupported".
 *
 * So: keep the name whenever it already carries an extension — the original one is the most
 * accurate thing available — and otherwise borrow one from the stored mime type, falling back
 * to `.wav`, which is what `encodeWavPcm16` writes for every recorded take.
 */
export function stagingNameForAudio(name: string, mime: string): string {
  const base = name.trim() || 'recording';
  if (/\.[a-z0-9]+$/i.test(base)) return base;
  const ext =
    { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/flac': 'flac', 'audio/ogg': 'ogg',
      'audio/mp4': 'm4a', 'audio/aiff': 'aiff' }[mime] ?? 'wav';
  return `${base}.${ext}`;
}

/**
 * The name the recording gets INSIDE the zip, under `audio/`.
 *
 * A zip entry name is a path, so anything that could be read as one has to go: a take called
 * `../../etc/passwd` must not become that on extraction, and a Windows name carrying a backslash
 * must not become a directory on a Mac. Everything is flattened to its last segment, and a name
 * that survives none of that borrows an extension from the mime type — the same fallback
 * `stagingNameForAudio` uses, and for the same reason: whatever unpacks this should be able to
 * tell what the file is.
 */
export function audioEntryName(name: string, mime: string): string {
  const flat = name.split(/[\\/]/).pop()?.trim() ?? '';
  // '.' and '..' are directory names, not file names, and both are empty once you take the
  // extension off. Treated as "no usable name" rather than escaped into something odd.
  return stagingNameForAudio(/^\.+$/.test(flat) ? '' : flat, mime);
}

/**
 * Mono 16-bit PCM WAV from the decoded samples.
 *
 * For RECORDED takes only. An imported file is copied verbatim instead — re-encoding somebody's
 * audio to store it would make the document's copy quietly worse than the original, and this
 * format exists to make the document complete rather than approximate.
 *
 * 16-bit because it is the format every decoder on every platform reads without negotiation.
 * The samples reaching here are the mono mixdown the app already works from, so nothing is lost
 * at this step that was not already lost when the take was decoded.
 */
export function encodeWavPcm16(pcm: Float32Array, sampleRate: number): Uint8Array {
  const rate = Math.max(1, Math.round(sampleRate) || 44100);
  const frames = pcm.length;
  const out = new Uint8Array(44 + frames * 2);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // format: integer PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    // Clamped before scaling: a sample outside -1..1 is already broken, and wrapping it would
    // turn a peak into a full-scale click in the opposite direction.
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return out;
}

/**
 * The metadata around an embedded take, from either container. Null for anything malformed, which
 * costs the document its audio and nothing else — the sheet and the edits are independent of it.
 *
 * The BYTES are not resolved here, because where they live is exactly what differs between the two
 * formats: a v3 reader looks up a zip entry, a legacy reader decodes a base64 string. Both hand
 * the result to `withAudioBytes` below.
 */
function decodeAudioMeta(
  value: unknown
): { meta: Omit<EmbeddedAudio, 'bytes'>; encoding: 'zip' | 'base64'; entry: string; b64: string } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<StoredAudioRef> & { bytes?: unknown };
  const encoding = v.encoding === 'zip' ? 'zip' : v.encoding === 'base64' ? 'base64' : null;
  if (!encoding) return null;
  const entry = typeof v.entry === 'string' ? v.entry : '';
  const b64 = typeof v.bytes === 'string' ? v.bytes : '';
  // Each form has one thing it cannot be missing: an entry to find, or a string to decode.
  if (encoding === 'zip' ? !entry : !b64) return null;
  return {
    encoding,
    entry,
    b64,
    meta: {
      name: typeof v.name === 'string' ? v.name : '',
      mime: typeof v.mime === 'string' ? v.mime : '',
      durationSec: Number.isFinite(Number(v.durationSec)) ? Math.max(0, Number(v.durationSec)) : 0,
      ...(Number.isFinite(Number(v.sampleRate)) && Number(v.sampleRate) > 0
        ? { sampleRate: Number(v.sampleRate) }
        : {})
    }
  };
}

function withAudioBytes(
  meta: Omit<EmbeddedAudio, 'bytes'>,
  bytes: Uint8Array | undefined
): EmbeddedAudio | null {
  if (!bytes || bytes.byteLength === 0) return null;
  return { ...meta, bytes };
}

function decodeAudioRef(value: unknown): PersistedAudio | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<PersistedAudio>;
  if (v.kind !== 'file' && v.kind !== 'capture' && v.kind !== 'midi') return null;
  if (typeof v.name !== 'string' || typeof v.path !== 'string') return null;
  return {
    kind: v.kind,
    name: v.name,
    path: v.path,
    durationSec: Number.isFinite(Number(v.durationSec)) ? Math.max(0, Number(v.durationSec)) : 0
  };
}

export function isRiffsheetFile(name: string): boolean {
  return name.toLowerCase().endsWith('.riffsheet');
}

/**
 * A zip entry's timestamp is a DOS date: 1980 to 2099, and nothing else exists. Anything outside
 * that — 0 for a document with no save time, a clock set to 1970, a corrupt far-future number —
 * becomes the floor rather than an exception thrown out of the save button.
 */
const ZIP_TIME_FLOOR = Date.UTC(1980, 0, 1);
const ZIP_TIME_CEIL = Date.UTC(2099, 11, 31);

function zipSafeTime(savedAt: number): number {
  return Number.isFinite(savedAt) && savedAt >= ZIP_TIME_FLOOR && savedAt <= ZIP_TIME_CEIL
    ? savedAt
    : ZIP_TIME_FLOOR;
}

const OVERSIZE_MESSAGE =
  'That Riffsheet document is over 512 MB, which is larger than a document with a recording inside ' +
  'it should ever be. It may be damaged.';

/**
 * Write a v3 document. ALWAYS v3 — there is no way to ask for the old container, because the only
 * reason to want one would be to open it in a build that predates this one, and that build is not
 * the one holding the file.
 *
 * COPIES OF THE AUDIO ON THIS PATH: one. The recording goes into `zipSync`'s output buffer and
 * nothing else touches it — no base64, no intermediate JSON string, no separate UTF-8 encode. What
 * happens after this function returns is the bridge's business and is not free (see BRIDGE note in
 * ui/app.ts `saveRiffsheetDocument`), but nothing here adds to it.
 */
export function writeRiffsheetDocument(document: RiffsheetDocument): Uint8Array {
  const audio = document.audioData ?? null;
  // Refused HERE rather than left to fail somewhere inside the allocator, so the user gets a
  // sentence instead of a dead button. The read side enforces the same ceiling.
  if (audio && audio.bytes.byteLength > MAX_DOCUMENT_AUDIO_BYTES) {
    throw new Error(
      // CEIL, not round: this number is only ever printed for a size that is strictly over the
      // ceiling, and rounding 512 MB + 1 byte down to "512 MB" produces the sentence "that
      // recording is 512 MB, and the limit is 512 MB", which reads as a bug in the app.
      `That recording is ${Math.ceil(audio.bytes.byteLength / (1024 * 1024))} MB, and a Riffsheet ` +
        'document can carry at most 512 MB of audio. Export the MusicXML or MIDI instead, or trim ' +
        'the take and try again.'
    );
  }

  const entry = audio ? AUDIO_DIR + audioEntryName(audio.name, audio.mime) : '';
  const stored: StoredAudioRef | null = audio
    ? {
        name: audio.name,
        mime: audio.mime,
        encoding: 'zip',
        entry,
        durationSec: audio.durationSec,
        ...(audio.sampleRate ? { sampleRate: audio.sampleRate } : {})
      }
    : null;

  const score: Omit<RiffsheetDocument, 'audioData'> & { audioData: StoredAudioRef | null } = {
    ...document,
    version: RIFFSHEET_DOCUMENT_VERSION,
    audioData: stored
  };

  // `mtime` is pinned to the document's own timestamp rather than left to default to "now", so
  // writing the same document twice produces the same bytes. A format that changes under a
  // byte-comparison for no reason is a format nobody can test.
  //
  // CLAMPED, because a zip timestamp is a DOS date and cannot represent a year outside 1980-2099
  // — fflate throws rather than truncating. `savedAt` is 0 for a document that never carried one
  // (every v1 file, and anything hand-built in a test), and 0 is 1970: passing it straight through
  // turned "save this document" into an exception. The floor is used for anything out of range,
  // which keeps the write deterministic instead of falling back to "now".
  const mtime = zipSafeTime(document.savedAt);
  const files: Zippable = {
    [SCORE_ENTRY]: [strToU8(`${JSON.stringify(score, null, 2)}\n`), { level: 6, mtime }]
  };
  // level 0 is STORE. See the container note: audio does not compress, and storing it keeps the
  // round trip byte-identical by construction.
  if (audio) files[entry] = [audio.bytes, { level: 0, mtime }];
  return zipSync(files, { mtime });
}

/**
 * Read any document this app has ever written, told apart by its FIRST FOUR BYTES rather than by
 * its extension or by a guess:
 *
 *   50 4B 03 04  ('PK\x03\x04')  a zip — v3
 *   '{'                          plain JSON — v1 (no audio) or v2 (base64 audio)
 *
 * Anything else is refused with the same sentence a corrupt file gets, because from the user's
 * side those are the same event.
 */
export function readRiffsheetDocument(bytes: Uint8Array): RiffsheetDocument {
  if (bytes.byteLength > MAX_DOCUMENT_AUDIO_BYTES) throw new Error(OVERSIZE_MESSAGE);
  if (isZip(bytes)) return readZipDocument(bytes);
  if (isJsonStart(bytes)) return readJsonDocument(bytes);
  throw new Error('That is not a readable Riffsheet document.');
}

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
  );
}

/** The first non-whitespace byte is `{`. Leading whitespace is legal JSON and costs nothing here. */
function isJsonStart(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length && i < 64; i++) {
    const b = bytes[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    // A UTF-8 BOM before the brace: written by no version of this app, but trivially survivable.
    if (b === 0xef || b === 0xbb || b === 0xbf) continue;
    return b === 0x7b;
  }
  return false;
}

/**
 * The `score.json` TEXT inside a document, whatever the container.
 *
 * For diagnostics only (`__RIFFSHEET_DOCUMENT__`). It exists because the probe used to read the
 * whole file as UTF-8 and search it for strings that must not be there — a dead token, say — and
 * a zip is not text: the score is deflated, so that search would answer "not present" for
 * everything and pass while proving nothing.
 */
export function documentScoreText(bytes: Uint8Array): string {
  if (!isZip(bytes)) return new TextDecoder().decode(bytes);
  try {
    const files = unzipSync(bytes, { filter: (file) => file.name === SCORE_ENTRY });
    const score = files[SCORE_ENTRY];
    return score ? strFromU8(score) : '';
  } catch {
    return '';
  }
}

function readZipDocument(bytes: Uint8Array): RiffsheetDocument {
  let oversize = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      // Checked BEFORE the entry is decompressed, which is the whole point of doing it in the
      // filter: a deflate bomb is refused on its declared size rather than after it has been
      // handed the memory it asked for.
      filter: (file) => {
        if (file.originalSize > MAX_DOCUMENT_AUDIO_BYTES) {
          oversize = Math.max(oversize, file.originalSize);
          return false;
        }
        return true;
      }
    });
  } catch {
    throw new Error('That is not a readable Riffsheet document.');
  }
  if (oversize > 0) throw new Error(OVERSIZE_MESSAGE);

  const scoreBytes = files[SCORE_ENTRY];
  if (!scoreBytes) throw new Error('That is not a readable Riffsheet document.');
  let parsed: Partial<RiffsheetDocument> & { audioData?: unknown };
  try {
    parsed = JSON.parse(strFromU8(scoreBytes)) as Partial<RiffsheetDocument>;
  } catch {
    throw new Error('That is not a readable Riffsheet document.');
  }

  const meta = decodeAudioMeta(parsed.audioData);
  // ONE copy of the audio on the read path: the slice `unzipSync` returns for a STORED entry.
  // It is handed onward as-is.
  const audioData = meta ? withAudioBytes(meta.meta, files[meta.entry]) : null;
  return hydrate(parsed, audioData);
}

function readJsonDocument(bytes: Uint8Array): RiffsheetDocument {
  let parsed: Partial<RiffsheetDocument> & { audioData?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<RiffsheetDocument>;
  } catch {
    throw new Error('That is not a readable Riffsheet document.');
  }
  const meta = decodeAudioMeta(parsed.audioData);
  let audioData: EmbeddedAudio | null = null;
  if (meta && meta.encoding === 'base64') {
    try {
      audioData = withAudioBytes(meta.meta, base64ToBytes(meta.b64));
    } catch {
      // Corrupt base64 costs the document its audio, not its notes.
      audioData = null;
    }
  }
  return hydrate(parsed, audioData);
}

/** Everything both containers agree on: validate the document, and answer with a whole one. */
function hydrate(
  parsed: Partial<RiffsheetDocument> & { audioData?: unknown },
  audioData: EmbeddedAudio | null
): RiffsheetDocument {
  // A RANGE, not an equality. The old check refused anything that was not exactly the current
  // number, which meant every version bump silently orphaned every document already written —
  // the reason `audio` had to be smuggled in as an optional field rather than versioned. A v1
  // document is a v3 document with no recording in it and is read as such. Only a FUTURE version
  // is refused, because that one genuinely may contain something this build would misread.
  const version = Number(parsed.version);
  if (parsed.app !== 'riffsheet-document' || !Number.isInteger(version) || version < 1) {
    throw new Error('That is not a readable Riffsheet document.');
  }
  if (version > RIFFSHEET_DOCUMENT_VERSION) {
    throw new Error(
      'That Riffsheet document was made by a newer version of Riffsheet. Update Riffsheet to open it.'
    );
  }
  const source = decodeSource(parsed.source);
  if (!source || !parsed.source) throw new Error('That Riffsheet document has no score data.');
  return {
    app: 'riffsheet-document',
    // The version READ, not the version this build writes. A caller that needs to know whether
    // there is a recording in here should not have to infer it from a field being undefined.
    version,
    savedAt: Number(parsed.savedAt) || 0,
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Untitled',
    source: encodeSource(source)!,
    settings: parsed.settings ?? {},
    edits: Array.isArray(parsed.edits) ? parsed.edits : [],
    editCursor: Number.isInteger(parsed.editCursor) ? (parsed.editCursor as number) : -1,
    sourceMidi: typeof parsed.sourceMidi === 'string' ? parsed.sourceMidi : undefined,
    // Null for a document written before this field existed, and for one saved from a symbolic
    // import. Both mean the same thing to the caller: there is no take to go looking for.
    audio: decodeAudioRef(parsed.audio),
    // Null for every v1 document. The caller falls back to `audio` above and reopens by path,
    // which is exactly what it did before this field existed.
    audioData
  };
}

// ---------------------------------------------------------------------------
// The blob
// ---------------------------------------------------------------------------

/**
 * Parse a stored blob.
 *
 * Returns null for anything we do not recognise. A restore is a convenience; a bad blob must
 * cost the user the restore and nothing else, so every failure mode here ends in "boot to the
 * drop zone" rather than an exception on the way up.
 */
export function readSession(json: string | null | undefined): PersistedSession | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<PersistedSession>;
    if (!parsed || parsed.app !== 'riffsheet') return null;
    // No migration cases yet. When v2 arrives, convert here rather than at the call site.
    if (parsed.v !== SESSION_VERSION) return null;
    return {
      v: SESSION_VERSION,
      app: 'riffsheet',
      savedAt: Number(parsed.savedAt) || 0,
      source: parsed.source ?? null,
      audio: parsed.audio ?? null,
      sourceMidi: typeof parsed.sourceMidi === 'string' ? parsed.sourceMidi : undefined,
      settings: parsed.settings ?? {},
      view: { blend: clampBlend(parsed.view?.blend) },
      edits: Array.isArray(parsed.edits) ? parsed.edits : [],
      editCursor: Number.isInteger(parsed.editCursor) ? (parsed.editCursor as number) : -1
    };
  } catch {
    return null;
  }
}

function clampBlend(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.35;
}

/** True when there is enough here to put something on screen. */
export function hasRestorableTake(session: PersistedSession | null): boolean {
  // An intentionally blank score is still a document. `detected` being present distinguishes
  // it from an incomplete/legacy blob; the note array is allowed to be empty.
  return !!session?.source?.detected && Array.isArray(session.source.detected.notes);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * Reading and writing the blob through whatever the host offers.
 *
 * Capability-gated on BOTH sides independently, because a half-built bridge is a real state
 * (see bridge/index.ts). A host with neither function degrades to today's behaviour: no
 * restore, no complaint.
 *
 * Writes are debounced and fire-and-forget. Nothing in the UI may ever wait on a save — the
 * save exists so the user does not lose work, not so they can watch it happen.
 */
export class SessionStore {
  private timer: number | undefined;
  private pending: PersistedSession | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(
    private bridge: NativeBridge,
    private debounceMs = 700
  ) {}

  get canSave(): boolean {
    return typeof this.bridge.setPersistedState === 'function';
  }

  get canLoad(): boolean {
    return typeof this.bridge.getPersistedState === 'function';
  }

  async load(): Promise<PersistedSession | null> {
    if (!this.bridge.getPersistedState) return null;
    try {
      return readSession(await this.bridge.getPersistedState());
    } catch (e) {
      console.warn('[riffsheet] could not read the stored session', e);
      return null;
    }
  }

  /** Queue a save. Later calls inside the window replace earlier ones. */
  save(session: PersistedSession): void {
    if (!this.canSave) return;
    this.pending = session;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Write whatever is queued right now. Resolves once it has actually been handed over. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const session = this.pending;
    this.pending = null;
    // Nothing queued still means "wait for the write already going out", or a caller that
    // flushes just after the debounce fired would read the store before it was written.
    if (!session || !this.bridge.setPersistedState) return this.inFlight;

    // Serialise the writes: two overlapping saves could otherwise land out of order and
    // leave the host holding the older one.
    this.inFlight = this.inFlight.then(async () => {
      try {
        await this.bridge.setPersistedState!(JSON.stringify(session));
      } catch (e) {
        // Once. A failing save that logs on every edit is worse than the failure.
        if (!this.warned) {
          this.warned = true;
          console.warn('[riffsheet] the session could not be saved', e);
        }
      }
    });
    return this.inFlight;
  }

  /** Deliberately close the current work and remove the host-owned recovery copy. */
  async clear(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = null;
    await this.inFlight;
    if (!this.bridge.setPersistedState) return;
    try {
      await this.bridge.setPersistedState('');
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        console.warn('[riffsheet] the saved session could not be cleared', e);
      }
    }
  }

}
