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

import type { InputNote } from '../pipeline';
import type { EditSpec } from '../edit/actions';
import type { NativeBridge } from '../bridge';
import type { TrimResult } from '../audio/trim';
import type { AppSettings, HostGrid, SourceAudio } from './state';

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
      : undefined
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
      : undefined
  };
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

export const RIFFSHEET_DOCUMENT_VERSION = 1;

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
}

export function isRiffsheetFile(name: string): boolean {
  return name.toLowerCase().endsWith('.riffsheet');
}

export function writeRiffsheetDocument(document: RiffsheetDocument): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
}

export function readRiffsheetDocument(bytes: Uint8Array): RiffsheetDocument {
  if (bytes.byteLength > 32 * 1024 * 1024) throw new Error('That Riffsheet document is too large.');
  let parsed: Partial<RiffsheetDocument>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<RiffsheetDocument>;
  } catch {
    throw new Error('That is not a readable Riffsheet document.');
  }
  if (parsed.app !== 'riffsheet-document' || parsed.version !== RIFFSHEET_DOCUMENT_VERSION) {
    throw new Error('That Riffsheet document was made by an incompatible version.');
  }
  const source = decodeSource(parsed.source);
  if (!source || !parsed.source) throw new Error('That Riffsheet document has no score data.');
  return {
    app: 'riffsheet-document',
    version: RIFFSHEET_DOCUMENT_VERSION,
    savedAt: Number(parsed.savedAt) || 0,
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Untitled',
    source: encodeSource(source)!,
    settings: parsed.settings ?? {},
    edits: Array.isArray(parsed.edits) ? parsed.edits : [],
    editCursor: Number.isInteger(parsed.editCursor) ? (parsed.editCursor as number) : -1,
    sourceMidi: typeof parsed.sourceMidi === 'string' ? parsed.sourceMidi : undefined
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
