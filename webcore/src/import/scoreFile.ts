/**
 * Guitar Pro / MusicXML import through alphaTab's bundled importers.
 *
 * The returned `notes` are deliberately pipeline-ready rather than alphaTab model objects:
 * Riffsheet can re-engrave them through its normal path and all edit/undo identities stay stable.
 * `score` is retained for callers that need source metadata, and `midi()` exports alphaTab's
 * original playback (including repeats and score effects) instead of the re-engraved result.
 */

import * as alphaTab from '@coderline/alphatab';
import type { InputNote } from '../pipeline';
// Straight from `bridge/types`, not the barrel — that one pulls in the JUCE and mock bridges and
// this module is loaded headless by the test scripts.
import { RIFFSHEET_LIMITS } from '../bridge/types';

const TICKS_PER_QUARTER = 960; // alphaTab MidiUtils.QuarterTime (not publicly exported)
/** "a MusicXML/MIDI/GP import" is named in `RIFFSHEET_LIMITS`' own doc — so it is read, not copied. */
const MAX_SCORE_FILE_BYTES = RIFFSHEET_LIMITS.containerBytes;
const MAX_SCORE_TRACKS = 1024;
const MAX_SCORE_BARS = 100_000;
/** The same realistic ceiling the MIDI reader enforces, and for the same reasons — see there. */
const MAX_SCORE_NOTES = 200_000;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_ENTRY_BYTES = RIFFSHEET_LIMITS.containerBytes;
/**
 * The SUM of a `.mxl`'s declared entry sizes — deliberately two containers' worth rather than one.
 *
 * An `.mxl` is a score plus its own media, so the honest budget is more than a single entry may
 * be; it is written against the shared constant so that raising the family raises this with it.
 */
const MAX_ARCHIVE_EXPANDED_BYTES = 2 * RIFFSHEET_LIMITS.containerBytes;

export const SCORE_FILE_EXTENSIONS = ['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'gp7', 'musicxml', 'mxl', 'xml'] as const;

export interface ScoreFileImportOptions {
  /** Zero-based source tracks to flatten. Omit to include every track. */
  trackIndexes?: readonly number[];
  /** Prefix for deterministic path-based note ids. */
  idPrefix?: string;
  encoding?: string;
  mergePartGroupsInMusicXml?: boolean;
}

export interface ImportedScoreNote extends InputNote {
  id: string;
  trackIndex: number;
  staffIndex: number;
  barIndex: number;
  voiceIndex: number;
  beatIndex: number;
  noteIndex: number;
  /** alphaTab/Riffsheet convention: string 1 is the lowest-pitched string. */
  string?: number;
  fret?: number;
  startTick: number;
  endTick: number;
  /** Playback/source transposition already reflected in canonical `midi` through realValue. */
  sourceTranspositionPitch: number;
  /** Display-only written-octave shift; never applied to canonical `midi`. */
  sourceDisplayTranspositionPitch: number;
}

export interface ImportedScoreStaff {
  index: number;
  capo: number;
  /** Converted from alphaTab's top-line-first array to Riffsheet's low-to-high convention. */
  tuningLowToHigh: number[];
  showStandardNotation: boolean;
  showTablature: boolean;
  isPercussion: boolean;
  transpositionPitch: number;
  displayTranspositionPitch: number;
}

export interface ImportedScoreTrack {
  index: number;
  name: string;
  program: number;
  isPercussion: boolean;
  staves: ImportedScoreStaff[];
}

export interface ImportedTempoChange {
  tick: number;
  atSec: number;
  bpm: number;
}

export interface ImportedTimeSignatureChange {
  tick: number;
  atSec: number;
  numerator: number;
  denominator: number;
}

export interface ParsedScoreFile {
  notes: ImportedScoreNote[];
  /** Initial source key signature in MusicXML/alphaTab fifths (-7 flats through +7 sharps). */
  keyFifths: number;
  tempoBpm: number;
  timeSignature: { numerator: number; denominator: number };
  tempoChanges: ImportedTempoChange[];
  timeSignatureChanges: ImportedTimeSignatureChange[];
  durationSec: number;
  durationTicks: number;
  /** Grace notes can start before written tick zero; seconds in `notes` are shifted to start at zero. */
  tickShift: number;
  title: string;
  artist: string;
  composer: string;
  tracks: ImportedScoreTrack[];
  /** First selected fretted staff, for the current single-part Riffsheet settings. */
  tuningLowToHigh: number[];
  capo: number;
  pitchInterpretation: {
    canonical: 'sounding';
    sourcePlaybackTranspositionApplied: boolean;
    sourceDisplayTranspositionPresent: boolean;
  };
  score: alphaTab.model.Score;
  /** Standard MIDI File bytes generated from the original source score. */
  midi(): Uint8Array;
}

/** Cheap routing check; the actual parser always sniffs the bytes. */
export function isScoreFile(name: string, bytes?: ArrayBuffer | Uint8Array): boolean {
  const extension = name.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? '';
  if ((SCORE_FILE_EXTENSIONS as readonly string[]).includes(extension)) return true;
  if (!bytes) return false;

  const data = asBytes(bytes);
  const head = String.fromCharCode(...data.subarray(0, Math.min(data.length, 256)));
  return /<\s*score-(?:partwise|timewise)\b/i.test(head) || /^FICHIER GUITAR PRO/i.test(head);
}

/** Load MusicXML (`.musicxml`, `.xml`, `.mxl`) or Guitar Pro (`.gp3`-`.gp7`, `.gpx`, `.gp`). */
export function parseScoreFile(
  bytes: ArrayBuffer | Uint8Array,
  options: ScoreFileImportOptions = {}
): ParsedScoreFile {
  const data = asBytes(bytes);
  if (data.byteLength === 0) throw new Error('The score file is empty.');
  if (data.byteLength > MAX_SCORE_FILE_BYTES) throw new Error('That score file is too large to open safely.');
  validateArchiveBounds(data);

  const settings = new alphaTab.Settings();
  if (options.encoding) settings.importer.encoding = options.encoding;
  if (options.mergePartGroupsInMusicXml !== undefined) {
    settings.importer.mergePartGroupsInMusicXml = options.mergePartGroupsInMusicXml;
  }

  let score: alphaTab.model.Score;
  try {
    // Includes compressed MusicXML (.mxl / ZIP) and all bundled Guitar Pro importers.
    score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(data, settings);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not read this score file. ${detail}`, { cause });
  }
  if (score.tracks.length > MAX_SCORE_TRACKS || score.masterBars.length > MAX_SCORE_BARS) {
    throw new Error('That score contains too many tracks or bars to open safely.');
  }

  const converted = scoreToInputNotes(score, options);
  return {
    ...converted,
    title: score.title ?? '',
    artist: score.artist ?? '',
    composer: score.music ?? '',
    score,
    midi: () => scoreToMidi(score, settings)
  };
}

/** Convenience for image/PDF OMR and other callers that only need a MIDI file. */
export function scoreFileToMidi(
  bytes: ArrayBuffer | Uint8Array,
  options: ScoreFileImportOptions = {}
): Uint8Array {
  return parseScoreFile(bytes, options).midi();
}

/**
 * Flatten an already-loaded alphaTab score into deterministic, pipeline-ready notes.
 * Repeats remain written once here; `scoreToMidi` follows the source playback/repeat graph.
 */
export function scoreToInputNotes(
  score: alphaTab.model.Score,
  options: Pick<ScoreFileImportOptions, 'trackIndexes' | 'idPrefix'> = {}
): Omit<ParsedScoreFile, 'title' | 'artist' | 'composer' | 'score' | 'midi'> {
  const selected = options.trackIndexes ? new Set(options.trackIndexes) : null;
  const idPrefix = options.idPrefix ?? 'score';
  const rawTempos = collectTempoChanges(score);
  const tickToSec = makeTickToSeconds(rawTempos);
  const tracks = describeTracks(score);
  const notes: ImportedScoreNote[] = [];
  // Riffsheet currently presents one editable notation layer per track. MusicXML commonly
  // represents standard notation and its TAB rendering as two alphaTab staves containing the
  // same musical events. Flattening both creates duplicate attacks (and, after quantization,
  // apparent chords) even though the source contains only one performance. Prefer the notation
  // staff when that exact standard+TAB representation is present; true grand staves remain
  // untouched because both of their staves advertise standard notation.
  const seenFlattenedNotes = new Set<string>();
  let minStartTick = 0;

  for (const track of score.tracks) {
    if (selected && !selected.has(track.index)) continue;
    const hasStandardStaff = track.staves.some((staff) => staff.showStandardNotation);
    const sourceStaves = hasStandardStaff
      ? track.staves.filter((staff) => staff.showStandardNotation || !staff.showTablature)
      : track.staves;
    for (const staff of sourceStaves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) {
              // One InputNote per attack. The tie destination is part of the origin's duration.
              if (note.isTieDestination && note.tieOrigin) continue;

              let endNote = note;
              const seen = new Set<alphaTab.model.Note>();
              while (endNote.tieDestination && !seen.has(endNote)) {
                seen.add(endNote);
                endNote = endNote.tieDestination;
              }

              const startTick = beat.absolutePlaybackStart;
              const endTick = endNote.beat.absolutePlaybackStart + endNote.beat.playbackDuration;
              const midi = soundingMidi(note, track);
              // THE SAME EVENT WRITTEN TWICE, versus TWO EVENTS THAT HAPPEN TO AGREE.
              //
              // MusicXML commonly represents one performance as a notation staff and a TAB staff
              // holding the same events; that is one note written twice and the second copy is
              // duplication, which is what this key removes. A unison in two different VOICES is
              // not that. It is two independent lines that meet, and dropping one used to delete
              // the fact that the source was polyphonic at all — the importer knew and nothing
              // downstream could find out. The voice therefore stays in the key: the identity
              // survives the import, and the single engraved voice is a decision the pipeline
              // makes in one place and COUNTS (`BuildDiagnostics.flattenedVoices`), rather than
              // an erasure spread across two modules.
              const flattenedKey = `${track.index}:${voice.index}:${startTick}:${endTick}:${midi}`;
              if (seenFlattenedNotes.has(flattenedKey)) continue;
              seenFlattenedNotes.add(flattenedKey);
              minStartTick = Math.min(minStartTick, startTick);
              const string = note.isStringed && note.string > 0 ? note.string : undefined;
              const fret = note.isStringed && note.fret >= 0 ? note.fret : undefined;
              const id = `${idPrefix}-t${track.index}-s${staff.index}-b${bar.index}-v${voice.index}-e${beat.index}-n${note.index}`;

              if (notes.length >= MAX_SCORE_NOTES) {
                throw new Error(
                  `That score has more than ${MAX_SCORE_NOTES.toLocaleString('en-US')} notes, which is more than Riffsheet can open safely.`
                );
              }

              notes.push({
                id,
                startSec: tickToSec(startTick),
                endSec: tickToSec(Math.max(endTick, startTick + 1)),
                midi,
                velocity: dynamicVelocity(note, staff),
                ...(string !== undefined ? { string, stringOverride: string } : {}),
                ...(fret !== undefined ? { fret } : {}),
                trackIndex: track.index,
                staffIndex: staff.index,
                barIndex: bar.index,
                voiceIndex: voice.index,
                beatIndex: beat.index,
                noteIndex: note.index,
                startTick,
                endTick,
                sourceTiming: { startTick, endTick, ppq: TICKS_PER_QUARTER },
                ...(sourceClef(bar.clef) ? { sourceClef: sourceClef(bar.clef) } : {}),
                sourceTrackIndex: track.index,
                sourceStaffIndex: staff.index,
                sourceBarIndex: bar.index,
                sourceVoiceIndex: voice.index,
                sourceTranspositionPitch: staff.transpositionPitch,
                sourceDisplayTranspositionPitch: staff.displayTranspositionPitch,
                ...(staff.displayTranspositionPitch !== 0 && staff.displayTranspositionPitch % 12 === 0
                  ? { displayPitchOffset: -staff.displayTranspositionPitch }
                  : {})
              });
            }
          }
        }
      }
    }
  }

  // Grace notes can be negative in alphaTab. Riffsheet's source clock always begins at zero.
  const tickShift = Math.max(0, -minStartTick);
  const secondsShift = tickShift ? -tickToSec(-tickShift) : 0;
  if (secondsShift) {
    for (const note of notes) {
      note.startSec += secondsShift;
      note.endSec += secondsShift;
    }
  }
  if (tickShift) {
    for (const note of notes) {
      // The current one-origin IR cannot encode a negative grace-note pre-roll and the source
      // bar map at the same time. Keep the notes via their shifted seconds path rather than
      // claiming inexact ticks are exact.
      note.sourceTiming = undefined;
    }
  }

  notes.sort(
    (a, b) =>
      a.startSec - b.startSec ||
      a.trackIndex - b.trackIndex ||
      a.staffIndex - b.staffIndex ||
      a.barIndex - b.barIndex ||
      a.voiceIndex - b.voiceIndex ||
      a.beatIndex - b.beatIndex ||
      a.noteIndex - b.noteIndex
  );

  const tempoChanges: ImportedTempoChange[] = rawTempos.map((change) => ({
    ...change,
    atSec: tickToSec(change.tick) + secondsShift
  }));
  const timeSignatureChanges = collectTimeSignatures(score).map((change) => ({
    ...change,
    atSec: tickToSec(change.tick) + secondsShift
  }));
  const finalMasterBar = score.masterBars[score.masterBars.length - 1];
  const durationTicks = finalMasterBar ? finalMasterBar.start + finalMasterBar.calculateDuration() : 0;
  // Iterative, never `Math.max(...notes)`: a 200k-note spread throws `RangeError` in
  // JavaScriptCore — the engine the plugin's WebView runs — before it computes anything.
  let lastNoteEndSec = 0;
  for (const note of notes) if (note.endSec > lastNoteEndSec) lastNoteEndSec = note.endSec;
  const durationSec = Math.max(tickToSec(durationTicks) + secondsShift, lastNoteEndSec);

  const selectedTrackIndexes = selected ?? new Set(score.tracks.map((track) => track.index));
  const primaryStaff = tracks
    .filter((track) => selectedTrackIndexes.has(track.index))
    .flatMap((track) => track.staves)
    .find((staff) => staff.tuningLowToHigh.length > 0);
  const firstMeter = timeSignatureChanges[0] ?? { numerator: 4, denominator: 4 };
  const firstKey = score.masterBars[0]?.keySignature ?? 0;
  if (notes.length && tickShift === 0) {
    const sourceBars: NonNullable<InputNote['sourceBars']> = score.masterBars.map((bar, index) => ({
      startTick: bar.start,
      durationTicks: bar.calculateDuration(),
      ppq: TICKS_PER_QUARTER,
      timeSig: [bar.timeSignatureNumerator || 4, bar.timeSignatureDenominator || 4],
      number: index + 1,
      implicit: bar.isAnacrusis
    }));
    const sourceTempoChanges: NonNullable<InputNote['sourceTempoChanges']> = rawTempos.map((change) => ({
      tick: change.tick,
      ppq: TICKS_PER_QUARTER,
      bpm: change.bpm
    }));
    // The UI may select any one of the imported tracks after this conversion. Give the first
    // note of every track a shared structure carrier so filtering out track 0 cannot silently
    // discard the source meter/tempo map.
    const carriedTracks = new Set<number>();
    for (const note of notes) {
      if (carriedTracks.has(note.trackIndex)) continue;
      carriedTracks.add(note.trackIndex);
      note.sourceBars = sourceBars;
      note.sourceTempoChanges = sourceTempoChanges;
    }
  }

  return {
    notes,
    keyFifths: Math.max(-7, Math.min(7, Math.round(firstKey))),
    tempoBpm: tempoChanges[0]?.bpm ?? score.tempo ?? 120,
    timeSignature: { numerator: firstMeter.numerator, denominator: firstMeter.denominator },
    tempoChanges,
    timeSignatureChanges,
    durationSec,
    durationTicks,
    tickShift,
    tracks,
    tuningLowToHigh: primaryStaff ? [...primaryStaff.tuningLowToHigh] : [],
    capo: primaryStaff?.capo ?? 0,
    pitchInterpretation: {
      canonical: 'sounding',
      sourcePlaybackTranspositionApplied: tracks.some((track) => track.staves.some((staff) => staff.transpositionPitch !== 0)),
      sourceDisplayTranspositionPresent: tracks.some((track) => track.staves.some((staff) => staff.displayTranspositionPitch !== 0))
    }
  };
}

/**
 * Apply a user-selected written-octave interpretation once, at import time (principally OMR).
 * Do not call this from a settings rebuild: tablature and tuning are views of canonical pitch.
 */
export function reinterpretWrittenOctave<T extends InputNote>(notes: readonly T[], semitones = -12): T[] {
  if (!Number.isInteger(semitones) || semitones % 12 !== 0) {
    throw new Error('Written-octave interpretation must move by a whole number of octaves.');
  }
  return notes.map((note) => ({
    ...note,
    midi: Math.max(0, Math.min(127, note.midi + semitones)),
    displayPitchOffset: (note.displayPitchOffset ?? 0) - semitones
  }));
}

/** Export the source score as a normal SMF file, preserving tracks, tempo, meter and repeats. */
export function scoreToMidi(score: alphaTab.model.Score, settings: alphaTab.Settings = new alphaTab.Settings()): Uint8Array {
  const midiFile = new alphaTab.midi.MidiFile();
  midiFile.format = score.tracks.length > 1
    ? alphaTab.midi.MidiFileFormat.MultiTrack
    : alphaTab.midi.MidiFileFormat.SingleTrackMultiChannel;
  // `true` requests SMF-1-compatible pitch bends. Without it, alphaTab emits MIDI 2 per-note
  // bends and MidiFile.toBinary() rejects them (confirmed against alphaTab 1.8.4 locally).
  const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(midiFile, true);
  const generator = new alphaTab.midi.MidiFileGenerator(score, settings, handler);
  generator.generate();
  return midiFile.toBinary();
}

function asBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

/**
 * Bound compressed MusicXML/GPX before alphaTab inflates it. The compressed input limit alone is
 * not sufficient: a small deflate stream can declare hundreds of megabytes of output. ZIP64 is
 * deliberately refused because this editor has no legitimate need for archive-scale score files.
 */
function validateArchiveBounds(data: Uint8Array): void {
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) return;
  const signature = data[2] | (data[3] << 8);
  if (signature !== 0x0403 && signature !== 0x0605 && signature !== 0x0807) return;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (offset: number): number => view.getUint16(offset, true);
  const u32 = (offset: number): number => view.getUint32(offset, true);
  const signatureAt = (offset: number, expected: number): boolean =>
    offset >= 0 && offset + 4 <= data.length && u32(offset) === expected;

  const searchStart = Math.max(0, data.length - (0xffff + 22));
  let eocd = -1;
  for (let offset = data.length - 22; offset >= searchStart; offset--) {
    if (signatureAt(offset, 0x06054b50)) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('Could not read this score archive: the ZIP directory is missing.');
  if (eocd + 22 + u16(eocd + 20) > data.length) {
    throw new Error('Could not read this score archive: the ZIP comment length is malformed.');
  }
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0) {
    throw new Error('Multi-disk score archives are not supported.');
  }

  const entriesOnDisk = u16(eocd + 8);
  const entryCount = u16(eocd + 10);
  const centralBytes = u32(eocd + 12);
  const centralOffset = u32(eocd + 16);
  if (entriesOnDisk === 0xffff || entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 score archives are outside the supported size limit.');
  }
  if (entriesOnDisk !== entryCount || entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error('That score archive contains too many entries to open safely.');
  }
  const centralEnd = centralOffset + centralBytes;
  if (!Number.isSafeInteger(centralEnd) || centralOffset > eocd || centralEnd > eocd) {
    throw new Error('Could not read this score archive: the ZIP directory length is malformed.');
  }

  let cursor = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index++) {
    if (!signatureAt(cursor, 0x02014b50) || cursor + 46 > centralEnd) {
      throw new Error('Could not read this score archive: a ZIP entry header is malformed.');
    }
    const compressedBytes = u32(cursor + 20);
    const expandedEntryBytes = u32(cursor + 24);
    const nameBytes = u16(cursor + 28);
    const extraBytes = u16(cursor + 30);
    const commentBytes = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    if (compressedBytes === 0xffffffff || expandedEntryBytes === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ZIP64 score archives are outside the supported size limit.');
    }
    expandedBytes += expandedEntryBytes;
    if (expandedEntryBytes > MAX_ARCHIVE_ENTRY_BYTES || expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
      throw new Error('That score archive expands beyond the supported size limit.');
    }

    if (!signatureAt(localOffset, 0x04034b50) || localOffset + 30 > data.length) {
      throw new Error('Could not read this score archive: a local ZIP header is missing.');
    }
    const localNameBytes = u16(localOffset + 26);
    const localExtraBytes = u16(localOffset + 28);
    const payloadOffset = localOffset + 30 + localNameBytes + localExtraBytes;
    if (!Number.isSafeInteger(payloadOffset) || payloadOffset > data.length || compressedBytes > data.length - payloadOffset) {
      throw new Error('Could not read this score archive: a compressed entry length is malformed.');
    }

    const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (!Number.isSafeInteger(next) || next > centralEnd) {
      throw new Error('Could not read this score archive: an entry name or extra field is malformed.');
    }
    cursor = next;
  }
}

function describeTracks(score: alphaTab.model.Score): ImportedScoreTrack[] {
  return score.tracks.map((track) => ({
    index: track.index,
    name: track.name || `Track ${track.index + 1}`,
    program: track.playbackInfo.program,
    isPercussion: track.isPercussion,
    staves: track.staves.map((staff) => ({
      index: staff.index,
      capo: staff.capo,
      tuningLowToHigh: [...staff.stringTuning.tunings].reverse(),
      showStandardNotation: staff.showStandardNotation,
      showTablature: staff.showTablature,
      isPercussion: staff.isPercussion,
      transpositionPitch: staff.transpositionPitch,
      displayTranspositionPitch: staff.displayTranspositionPitch
    }))
  }));
}

function collectTempoChanges(score: alphaTab.model.Score): { tick: number; bpm: number }[] {
  const changes: { tick: number; bpm: number; order: number }[] = [
    { tick: 0, bpm: positiveTempo(score.tempo), order: -1 }
  ];
  let order = 0;
  for (const bar of score.masterBars) {
    const duration = bar.calculateDuration();
    for (const automation of bar.tempoAutomations) {
      if (automation.type !== alphaTab.model.AutomationType.Tempo || !Number.isFinite(automation.value) || automation.value <= 0) {
        continue;
      }
      changes.push({ tick: bar.start + duration * automation.ratioPosition, bpm: automation.value, order: order++ });
    }
  }
  changes.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const deduped: { tick: number; bpm: number }[] = [];
  for (const change of changes) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.tick === change.tick) previous.bpm = change.bpm;
    else deduped.push({ tick: change.tick, bpm: change.bpm });
  }
  return deduped;
}

function collectTimeSignatures(score: alphaTab.model.Score): Omit<ImportedTimeSignatureChange, 'atSec'>[] {
  const changes: Omit<ImportedTimeSignatureChange, 'atSec'>[] = [];
  for (const bar of score.masterBars) {
    const candidate = {
      tick: bar.start,
      numerator: bar.timeSignatureNumerator || 4,
      denominator: bar.timeSignatureDenominator || 4
    };
    const previous = changes[changes.length - 1];
    if (!previous || previous.numerator !== candidate.numerator || previous.denominator !== candidate.denominator) {
      changes.push(candidate);
    }
  }
  if (!changes.length) changes.push({ tick: 0, numerator: 4, denominator: 4 });
  return changes;
}

function makeTickToSeconds(changes: readonly { tick: number; bpm: number }[]): (tick: number) => number {
  let initialTempo = 120;
  for (const change of changes) {
    if (change.tick > 0) break;
    initialTempo = change.bpm;
  }
  return (tick: number): number => {
    if (tick < 0) return (tick / TICKS_PER_QUARTER) * (60 / initialTempo);
    let seconds = 0;
    let previousTick = 0;
    let bpm = initialTempo;
    for (const change of changes) {
      if (change.tick <= 0) {
        bpm = change.bpm;
        continue;
      }
      if (change.tick >= tick) break;
      seconds += ((change.tick - previousTick) / TICKS_PER_QUARTER) * (60 / bpm);
      previousTick = change.tick;
      bpm = change.bpm;
    }
    return seconds + ((tick - previousTick) / TICKS_PER_QUARTER) * (60 / bpm);
  };
}

function positiveTempo(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 120;
}

function soundingMidi(note: alphaTab.model.Note, track: alphaTab.model.Track): number {
  // realValue applies Staff.transpositionPitch (playback/source semantics) exactly once. It
  // deliberately excludes displayTranspositionPitch, which is only how the written staff is
  // shown (for example conventional guitar/bass 8vb notation).
  if (!note.isPercussion) return note.realValue;
  return track.percussionArticulations[note.percussionArticulation]?.outputMidiNumber ?? note.realValue;
}

function sourceClef(clef: alphaTab.model.Clef): InputNote['sourceClef'] {
  if (clef === alphaTab.model.Clef.G2) return 'treble';
  if (clef === alphaTab.model.Clef.F4) return 'bass';
  // C and neutral clefs cannot be represented by the current IR. Do not guess.
  return undefined;
}

/** Mirrors alphaTab 1.8.4's public-score dynamics-to-velocity mapping. */
function dynamicVelocity(note: alphaTab.model.Note, staff: alphaTab.model.Staff): number {
  const dynamics = [15, 31, 47, 63, 79, 95, 111, 127, 10, 5, 3, 127, 127, 127, 111, 111, 111, 95, 95, 95, 111, 95, 111, 1, 87, 111];
  let velocity = dynamics[note.dynamics] ?? 95;
  let adjustment = 0;
  if (!staff.isPercussion && note.hammerPullOrigin) adjustment--;
  if (note.isGhost) adjustment--;
  if (note.accentuated === alphaTab.model.AccentuationType.Normal) adjustment++;
  else if (note.accentuated === alphaTab.model.AccentuationType.Heavy) adjustment += 2;
  velocity += adjustment * 16;
  return Math.max(1, Math.min(127, velocity));
}
