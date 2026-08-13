/**
 * The `.riffsheet` document format, v1 through v3.
 *
 * v2 put the RECORDING inside the file (#34). Before it, a document named a path and hoped — mail
 * it to somebody, open it on another machine, or move the wav, and the sheet arrived with a silent
 * fader. v3 keeps that promise and changes the CONTAINER to a zip, because base64-inside-JSON cost
 * seven or eight copies of the recording to write one file.
 *
 * What is worth proving is what is easy to get wrong:
 *
 *  1. the audio that comes out is the audio that went in, BYTE FOR BYTE;
 *  2. every document a user might already have — v1, v2 — still opens, because a reader that
 *     rejects the files its own users hold is not a reader;
 *  3. the container is told apart by its MAGIC BYTES rather than by its extension or a guess;
 *  4. the size ceiling is enforced on the way OUT as well as the way in, with a sentence;
 *  5. an opened document never claims an Original it is about to play as silence.
 */

import { strToU8, zipSync } from 'fflate';

import {
  MAX_DOCUMENT_AUDIO_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_COMPRESSION_RATIO,
  MAX_DOCUMENT_ENTRIES,
  MAX_DOCUMENT_INFLATED_BYTES,
  MAX_SCORE_JSON_BYTES,
  RIFFSHEET_DOCUMENT_VERSION,
  SESSION_VERSION,
  audioEntryName,
  base64ToBytes,
  bytesToBase64,
  decodeSource,
  documentScoreText,
  encodeSource,
  encodeWavPcm16,
  originalPlaybackAfterLoad,
  readRiffsheetDocument,
  readSession,
  writeRiffsheetDocument,
  type PersistedSession,
  type PersistedSource,
  type RiffsheetDocument
} from '../src/app/persist';
import { ratValue, rational } from '../src/edit/ripple';
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  TAKE_SCOPED_SETTING_KEYS,
  applyDocumentSettings,
  isTakeScopedSetting,
  mergeStoredSettings,
  takeScopedDefaults,
  type AppSettings,
  type SourceAudio
} from '../src/app/state';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rejects(bytes: Uint8Array, fragment: string): void {
  try {
    readRiffsheetDocument(bytes);
  } catch (error) {
    const message = (error as Error).message;
    assert(
      message.toLowerCase().includes(fragment.toLowerCase()),
      `wrong document error: expected something about "${fragment}", got "${message}"`
    );
    return;
  }
  throw new Error(`expected the reader to reject ${fragment}`);
}

function throws(run: () => unknown, fragment: string): void {
  try {
    run();
  } catch (error) {
    const message = (error as Error).message;
    assert(
      message.toLowerCase().includes(fragment.toLowerCase()),
      `wrong error: expected something about "${fragment}", got "${message}"`
    );
    return;
  }
  throw new Error(`expected a throw about ${fragment}`);
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// 1. Base64 survives every byte value
// ---------------------------------------------------------------------------
//
// v3 no longer base64s the AUDIO — that is the whole point of the zip — but the helper is still
// what carries the imported MIDI and the waveform peaks through the JSON, so the property it rests
// on is still worth proving: a JSON string cannot hold arbitrary bytes, and the failure is silent.
const everyByte = new Uint8Array(256);
for (let i = 0; i < 256; i++) everyByte[i] = i;
const throughJson = JSON.parse(JSON.stringify({ b: bytesToBase64(everyByte) })) as { b: string };
const backAgain = base64ToBytes(throughJson.b);
assert(backAgain.length === 256, 'base64 round trip must preserve length');
for (let i = 0; i < 256; i++) {
  assert(backAgain[i] === i, `byte ${i} did not survive the base64 round trip (got ${backAgain[i]})`);
}

// ---------------------------------------------------------------------------
// 2. The WAV encoder
// ---------------------------------------------------------------------------

const pcm = new Float32Array(1000);
for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((i / 44100) * 2 * Math.PI * 440);
const wav = encodeWavPcm16(pcm, 44100);

const ascii = (bytes: Uint8Array, at: number, len: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + len));
assert(ascii(wav, 0, 4) === 'RIFF', 'a wav starts with RIFF');
assert(ascii(wav, 8, 4) === 'WAVE', 'a wav declares WAVE');
assert(ascii(wav, 12, 4) === 'fmt ', 'a wav carries a fmt chunk');
assert(ascii(wav, 36, 4) === 'data', 'a wav carries a data chunk');
assert(wav.length === 44 + pcm.length * 2, 'mono 16-bit: two bytes a sample after a 44-byte header');

const wavView = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
assert(wavView.getUint16(22, true) === 1, 'the embedded take is mono');
assert(wavView.getUint16(34, true) === 16, 'the embedded take is 16-bit');
assert(wavView.getUint32(24, true) === 44100, 'the sample rate is written as given');
assert(wavView.getUint32(4, true) === 36 + pcm.length * 2, 'the RIFF size field covers the payload');

// Clipping rather than wrapping. A sample outside -1..1 is already broken; wrapping it would
// turn a peak into a full-scale click pointing the other way.
const hot = encodeWavPcm16(new Float32Array([2, -2]), 8000);
const hotView = new DataView(hot.buffer, hot.byteOffset, hot.byteLength);
assert(hotView.getInt16(44, true) === 32767, 'a sample over 1.0 clamps to full scale');
assert(hotView.getInt16(46, true) === -32767, 'a sample under -1.0 clamps to negative full scale');

// ---------------------------------------------------------------------------
// 3. A v3 document round-trips its audio and its performance
// ---------------------------------------------------------------------------

const source: PersistedSource = {
  name: 'take.wav',
  durationSec: 4.5,
  barOneSec: 0.9,
  trim: null,
  detected: {
    // Unrounded on purpose: these are the numbers the whole sheet is quantised from, and a note
    // sitting a hair off a grid boundary has to land on the same side of it after a reopen.
    notes: [
      { id: 'n0', startSec: 0.9123456789, endSec: 1.4987654321, midi: 40 },
      { id: 'n1', startSec: 1.5000000001, endSec: 1.9, midi: 45 }
    ],
    beats: [0.9, 1.4, 1.9, 2.4]
  }
};

const document: RiffsheetDocument = {
  app: 'riffsheet-document',
  version: RIFFSHEET_DOCUMENT_VERSION,
  savedAt: 1_700_000_000_000,
  name: 'take',
  source,
  settings: { grid: 'free', rollSnapToGrid: true, rollGrid: 'eighth' },
  edits: [],
  editCursor: -1,
  audio: { kind: 'file', name: 'take.wav', path: '/somewhere/take.wav', durationSec: 4.5 },
  audioData: {
    name: 'take.wav',
    mime: 'audio/wav',
    bytes: wav,
    durationSec: 4.5,
    sampleRate: 44100
  }
};

const written = writeRiffsheetDocument(document);
const reopened = readRiffsheetDocument(written);

/*
 * THE EXPECTED VERSION MOVED, INTENTIONALLY: 4 -> 5. The old claim, quoted:
 *
 *   assert(
 *     reopened.version === RIFFSHEET_DOCUMENT_VERSION && RIFFSHEET_DOCUMENT_VERSION === 4,
 *     'a document written by this build reports version 4'
 *   );
 *
 * v5 is v4 plus the STRUCTURAL SCORE-TIME LAYER — `timelineDetached`, `rippleOps` and
 * `documentEndTick` (`persist.ts §RIFFSHEET_DOCUMENT_VERSION`). It passes the same test v4's bump
 * did: a v4 reader handed one of these shows the take with every ripple undone and the timeline
 * re-attached, and then writes the file back WITHOUT them. That is a reader being wrong about the
 * music and destroying the evidence, which is what the gate is for. Everything about a document
 * that has none of those fields is byte-identical, which §"the bytes do not move" below asserts.
 *
 * AND AGAIN, 5 -> 6, ON THE SAME TEST. The old claim, quoted:
 *
 *   assert(
 *     reopened.version === RIFFSHEET_DOCUMENT_VERSION && RIFFSHEET_DOCUMENT_VERSION === 5,
 *     'a document written by this build reports version 5'
 *   );
 *
 * v6 is v5 plus the CANONICAL PLACEMENTS (`rollPlacements`) and the PER-PART FRETBOARD
 * (`ImportedPart.tab`) — one bump for two fields that landed together. A v5 reader handed either
 * would be wrong about the music and would then write the file back without it: it would re-apply
 * the ripple log over an override that exists to stop it (the rectangle snaps back to the written
 * value the player dragged it off), and it would print an imported guitar's tablature as a plain
 * notation staff. Both fields are omitted when empty, so a document that uses neither still
 * serialises to the bytes v5 wrote.
 */
assert(
  reopened.version === RIFFSHEET_DOCUMENT_VERSION && RIFFSHEET_DOCUMENT_VERSION === 6,
  'a document written by this build reports version 6'
);
assert(!!reopened.audioData, 'a v6 document comes back with its recording');

// THE CONTAINER: a real zip, recognisable to anything that reads them.
assert(
  written[0] === 0x50 && written[1] === 0x4b && written[2] === 0x03 && written[3] === 0x04,
  'a v3 document begins with the zip magic PK\\x03\\x04'
);
// The audio is STORED, not deflated, so the file is about the size of the recording plus a small
// deflated score. A file SMALLER than the audio would mean the audio had been compressed.
assert(
  written.byteLength > wav.byteLength,
  `a document must be at least as large as the recording it stores (${written.byteLength} vs ${wav.byteLength})`
);

// The score is real JSON inside the zip, and the audio bytes are NOT in it.
const scoreText = documentScoreText(written);
const scoreJson = JSON.parse(scoreText) as { audioData: { entry: string; encoding: string; bytes?: unknown } };
assert(scoreJson.audioData.encoding === 'zip', 'a v3 score.json points at a zip entry');
assert(scoreJson.audioData.entry === 'audio/take.wav', 'the recording is stored under its own name');
assert(scoreJson.audioData.bytes === undefined, 'no audio bytes may remain inside score.json');

// Writing the same document twice gives the same bytes: mtime is pinned to `savedAt`, so nothing
// about the container drifts under a byte comparison.
const writtenAgain = writeRiffsheetDocument(document);
assert(writtenAgain.byteLength === written.byteLength, 'the writer is deterministic (length)');
for (let i = 0; i < written.length; i++) {
  assert(writtenAgain[i] === written[i], `the writer is deterministic (byte ${i})`);
}

// A zip entry's timestamp is a DOS date and cannot hold a year outside 1980-2099. `savedAt` is 0
// for a document that never carried one, and 0 is 1970 — passing it straight to the zip writer
// turns "save" into a thrown exception, which is what happened the first time this ran. Every one
// of these must produce a readable document rather than an error.
for (const savedAt of [0, -1, 1, Number.NaN, 4_102_444_800_000, 99_999_999_999_999]) {
  const odd = readRiffsheetDocument(writeRiffsheetDocument({ ...document, savedAt }));
  assert(odd.audioData!.bytes.length === wav.length, `savedAt ${savedAt} must still write its audio`);
  assert(
    JSON.stringify(odd.source.detected!.notes) === JSON.stringify(source.detected!.notes),
    `savedAt ${savedAt} must still write its notes`
  );
}

// THE CLAIM: byte-identical audio.
const restored = reopened.audioData!.bytes;
assert(restored.length === wav.length, `audio length changed: ${wav.length} -> ${restored.length}`);
for (let i = 0; i < wav.length; i++) {
  assert(restored[i] === wav[i], `audio byte ${i} changed in the round trip`);
}
assert(reopened.audioData!.sampleRate === 44100, 'the sample rate travels with the audio');
assert(reopened.audioData!.mime === 'audio/wav', 'the container type travels with the audio');
assert(reopened.audioData!.name === 'take.wav', 'the recording keeps the name it came in under');

// …and an identical performance layer beside it.
const beforeNotes = JSON.stringify(source.detected!.notes);
const afterNotes = JSON.stringify(reopened.source.detected!.notes);
assert(beforeNotes === afterNotes, 'the performance layer must survive the round trip exactly');
assert(reopened.source.barOneSec === 0.9, 'bar 1 survives');
assert(JSON.stringify(reopened.source.detected!.beats) === JSON.stringify([0.9, 1.4, 1.9, 2.4]), 'beats survive');
assert(JSON.stringify(reopened.settings) === JSON.stringify(document.settings), 'the settings survive');
assert(reopened.name === 'take', 'the document name survives');
assert(reopened.savedAt === 1_700_000_000_000, 'the save time survives');
// The reference is still written as well: it is what lets a reopened document find the original
// file on the machine that made it.
assert(reopened.audio?.path === '/somewhere/take.wav', 'the take reference is still recorded');

// Binary audio that is not text at all — the case base64 existed to survive — goes through a zip
// entry untouched, which is the point of STORE.
const rawBinary = new Uint8Array(1024);
for (let i = 0; i < rawBinary.length; i++) rawBinary[i] = (i * 7) & 0xff;
const binaryDoc = readRiffsheetDocument(
  writeRiffsheetDocument({
    ...document,
    audioData: { name: 'noise.bin', mime: '', bytes: rawBinary, durationSec: 1 }
  })
);
assert(binaryDoc.audioData!.bytes.length === 1024, 'arbitrary bytes keep their length');
for (let i = 0; i < rawBinary.length; i++) {
  assert(binaryDoc.audioData!.bytes[i] === rawBinary[i], `arbitrary byte ${i} survives the zip`);
}
// A name with no extension still lands somewhere a decoder can identify.
assert(
  JSON.parse(documentScoreText(writeRiffsheetDocument({
    ...document,
    audioData: { name: 'Take 3', mime: 'audio/mpeg', bytes: rawBinary, durationSec: 1 }
  }))).audioData.entry === 'audio/Take 3.mp3',
  'a name with no extension borrows one from the mime type'
);

// A zip entry name is a path. A take called `../../evil.wav` must not become one.
assert(audioEntryName('../../evil.wav', '') === 'evil.wav', 'a traversing name is flattened');
assert(audioEntryName('C:\\takes\\riff.wav', '') === 'riff.wav', 'a Windows path is flattened');
assert(audioEntryName('..', 'audio/wav') === 'recording.wav', 'a directory name is not a file name');
assert(audioEntryName('', 'audio/flac') === 'recording.flac', 'an empty name still gets an extension');

// ---------------------------------------------------------------------------
// 4. Every older document still opens
// ---------------------------------------------------------------------------
//
// The old reader demanded an exact version match, so every bump would have orphaned every file
// already on disk. This is the check that keeps that from ever being true again — and it matters
// more now than it did, because v3 is a different CONTAINER and not merely a different shape.

// v1: a reference and no recording.
const v1 = utf8(
  JSON.stringify({
    app: 'riffsheet-document',
    version: 1,
    savedAt: 1,
    name: 'old',
    source,
    settings: { grid: 'auto' },
    edits: [],
    editCursor: -1,
    audio: { kind: 'file', name: 'take.wav', path: '/old/take.wav', durationSec: 4.5 }
  })
);
const oldDoc = readRiffsheetDocument(v1);
assert(oldDoc.version === 1, 'a v1 document reports the version it actually is');
assert(oldDoc.audioData === null, 'a v1 document has no embedded recording, and says so');
assert(oldDoc.audio?.path === '/old/take.wav', 'a v1 document still yields its take reference');
assert(
  JSON.stringify(oldDoc.source.detected!.notes) === beforeNotes,
  'a v1 document still yields its performance layer'
);

// v2: base64 audio inside the JSON. Written here exactly as the v2 writer wrote it.
const v2 = utf8(
  JSON.stringify({
    app: 'riffsheet-document',
    version: 2,
    savedAt: 2,
    name: 'embedded',
    source,
    settings: { grid: 'free' },
    edits: [],
    editCursor: -1,
    audio: { kind: 'file', name: 'take.wav', path: '/old/take.wav', durationSec: 4.5 },
    audioData: {
      name: 'take.wav',
      mime: 'audio/wav',
      encoding: 'base64',
      bytes: bytesToBase64(wav),
      durationSec: 4.5,
      sampleRate: 44100
    }
  })
);
const v2Doc = readRiffsheetDocument(v2);
assert(v2Doc.version === 2, 'a v2 document reports the version it actually is');
assert(!!v2Doc.audioData, 'a v2 document still yields its embedded recording');
assert(v2Doc.audioData!.bytes.length === wav.length, 'the v2 recording comes back at full length');
for (let i = 0; i < wav.length; i++) {
  assert(v2Doc.audioData!.bytes[i] === wav[i], `v2 audio byte ${i} did not survive`);
}
assert(v2Doc.audioData!.sampleRate === 44100, 'the v2 sample rate survives');
assert(
  JSON.stringify(v2Doc.source.detected!.notes) === beforeNotes,
  'a v2 document still yields its performance layer'
);

// A v2 document whose base64 is corrupt loses its audio and keeps its notes.
const v2Corrupt = readRiffsheetDocument(
  utf8(
    JSON.stringify({
      app: 'riffsheet-document',
      version: 2,
      savedAt: 2,
      name: 'broken',
      source,
      settings: {},
      edits: [],
      editCursor: -1,
      audioData: { name: 'x.wav', mime: 'audio/wav', encoding: 'base64', bytes: '!!!not base64!!!' }
    })
  )
);
assert(v2Corrupt.audioData === null, 'corrupt v2 base64 costs the audio, not the document');
assert(
  JSON.stringify(v2Corrupt.source.detected!.notes) === beforeNotes,
  'a v2 document with broken audio still opens with its notes'
);

// A v3 document saved from a symbolic import has no recording either, and that is not an error —
// it is a document of something that never had one.
const v3NoAudio = readRiffsheetDocument(writeRiffsheetDocument({ ...document, audioData: null }));
assert(v3NoAudio.audioData === null, 'a v3 document may legitimately carry no recording');
assert(
  JSON.stringify(v3NoAudio.source.detected!.notes) === beforeNotes,
  'a v3 document with no recording still carries its notes'
);

// ---------------------------------------------------------------------------
// 4b. PARTS travel inside the document (v4)
// ---------------------------------------------------------------------------
//
// A part is STORED, never referenced: the guitar chart somebody dropped in goes into the file, so
// the document opens on another machine as the document they were looking at. That is the whole
// reason the version moved — a v3 reader would have shown the take alone and then written the
// parts back out of existence.
const withParts = readRiffsheetDocument(
  writeRiffsheetDocument({
    ...document,
    source: {
      ...source,
      importedParts: [
        {
          id: 'imp1',
          name: 'Guitar',
          nudgeMs: -40,
          notes: [
            { id: 'g0', startSec: 0, endSec: 0.5, midi: 64, sourceTiming: { startTick: 0, endTick: 960, ppq: 960 } },
            { id: 'g1', startSec: 0.5, endSec: 1, midi: 67, sourceTiming: { startTick: 960, endTick: 1920, ppq: 960 } }
          ]
        }
      ],
      partOrder: ['imp1', 'live']
    }
  })
);
assert(withParts.source.importedParts?.length === 1, 'an imported part survives the round trip');
assert(withParts.source.importedParts![0].name === 'Guitar', 'the part keeps its name');
assert(withParts.source.importedParts![0].nudgeMs === -40, 'the part keeps its nudge');
assert(
  withParts.source.importedParts![0].notes.length === 2 &&
    withParts.source.importedParts![0].notes[0].sourceTiming?.ppq === 960,
  'the part keeps its symbolic notes, written ticks and all'
);
assert(
  JSON.stringify(withParts.source.partOrder) === JSON.stringify(['imp1', 'live']),
  'the printed order survives — a part dragged above the take stays above it'
);

// A v3 file IS a single-part document, and reads as exactly that rather than as a broken v4.
const v3SinglePart = readRiffsheetDocument(
  utf8(
    JSON.stringify({
      app: 'riffsheet-document',
      version: 3,
      savedAt: 3,
      name: 'older',
      source,
      settings: {},
      edits: [],
      editCursor: -1,
      audioData: null
    })
  )
);
assert(v3SinglePart.version === 3, 'a v3 document reports the version it actually is');
assert(v3SinglePart.source.importedParts === undefined, 'a v3 document has no parts, and says so by absence');

// A document with a part list that has lost its order, or an order naming a part that is gone,
// must still open. Reconciling the two is `orderedPartSlots`; the reader's job is only to not
// invent either half.
const halfParts = readRiffsheetDocument(
  writeRiffsheetDocument({
    ...document,
    source: {
      ...source,
      importedParts: [{ id: 'imp1', name: '  ', nudgeMs: Number.NaN, notes: [{ startSec: 0, endSec: 1, midi: 60 }] }],
      partOrder: ['live', 'imp1', 'ghost']
    }
  })
);
assert(halfParts.source.importedParts?.[0].name === 'Part', 'a nameless part is named rather than dropped');
assert(halfParts.source.importedParts?.[0].nudgeMs === 0, 'a nonsense nudge reads as no nudge');

// ---------------------------------------------------------------------------
// 4c. THE LIVE PART'S NAME travels too (Z2b) — and does NOT move the version
// ---------------------------------------------------------------------------
//
// It is the name the player typed over the take: on the menu, engraved down the left of the
// system, in the exported `<part-name>`. It has to survive a save, because a document that
// re-opens under a different name than it was saved with has lost something the player wrote.
//
// STILL v4, deliberately. The field is additive and degrades to the documented fallback — an
// older reader ignores one key and shows the take under its instrument's name — whereas a version
// bump would make that reader refuse the whole file. See `persist.ts §PersistedSource.livePartName`.
const renamedTake = readRiffsheetDocument(
  writeRiffsheetDocument({ ...document, source: { ...source, livePartName: 'Low end' } })
);
assert(renamedTake.source.livePartName === 'Low end', 'the take keeps the name it was given');
assert(renamedTake.version === RIFFSHEET_DOCUMENT_VERSION, 'a renamed take does not move the format version');

// A take nobody has renamed writes no such key at all, so its bytes are what they always were.
const unnamedTake = writeRiffsheetDocument({ ...document, source: { ...source, livePartName: '   ' } });
assert(
  readRiffsheetDocument(unnamedTake).source.livePartName === undefined,
  'a name of nothing but spaces is stored as no name at all'
);
assert(
  readRiffsheetDocument(writeRiffsheetDocument(document)).source.livePartName === undefined,
  'a take that was never renamed carries no name field'
);
// Bounded on the way back in, exactly as it is on the way in: a hand-edited document cannot put a
// 4000-character label down the side of somebody's staff.
const hugeName = readRiffsheetDocument(
  writeRiffsheetDocument({ ...document, source: { ...source, livePartName: `  ${'x'.repeat(400)}  ` } })
);
assert((hugeName.source.livePartName ?? '').length === 40, 'an over-long stored name is bounded on the way back');

// ---------------------------------------------------------------------------
// 4d. THE STRUCTURAL SCORE-TIME LAYER (v5) — the ship-blocker and the ripple log
// ---------------------------------------------------------------------------
//
// THE SHIP-BLOCKER. `timelineDetached` is what tells the pipeline the score's clock and the
// recording's have parted company and what stops the snap layer from clamping notes back inside
// the tape. It was set by every bar operation and written by NEITHER encoder — so reopening a
// bar-edited document re-armed every guard the edit had disarmed, and the material past the old
// audio end was piled onto the last line inside the recording or dropped outright. The document
// said one thing on screen and another after a restart.
{
  const detached = readRiffsheetDocument(
    writeRiffsheetDocument({ ...document, source: { ...source, timelineDetached: true } })
  );
  assert(detached.source.timelineDetached === true, 'a detached timeline survives a save and reopen');
  assert(
    readRiffsheetDocument(writeRiffsheetDocument(document)).source.timelineDetached === undefined,
    'and a document nobody has detached carries no such key — the bytes do not move'
  );

  // THE RIPPLE LOG. A ripple is a decision, exactly as a cut is, and cannot be recomputed: without
  // it the document reopens with every note back at its played position while the notation edits —
  // keyed on ids the ripple deliberately does not renumber — replay on top.
  const ops = [
    { id: 'r1', seamTick: rational(48), deltaTick: rational(24), chordIds: ['n0'], chordEndTick: rational(72) },
    { id: 'b1', seamTick: rational(1234, 1000), deltaTick: rational(-96), dropSpan: true as const, label: 'Delete bar' }
  ];
  // THROUGH THE APP'S OWN ENCODER AND BACK, which is the pair that has to be inverses: the
  // document is a container for exactly what `encodeSource` produced.
  const live: SourceAudio = {
    name: 'rippled.wav',
    durationSec: 12,
    peaks: null,
    trim: null,
    barOneSec: 0,
    detected: { notes: [{ id: 'n0', startSec: 1, endSec: 1.5, midi: 40 }] },
    rippleOps: ops,
    documentEndTick: rational(577, 3),
    timelineDetached: true
  };
  const wire = JSON.parse(JSON.stringify(encodeSource(live))) as PersistedSource;
  const back = decodeSource(wire)!.rippleOps ?? [];
  assert(back.length === 2, 'both operations come back');
  assert(back[0].id === 'r1' && back[1].id === 'b1', '…and in the order they were made, which is the whole contract');
  assert(ratValue(back[0].deltaTick) === 24 && back[0].chordIds?.join() === 'n0', 'the atom travels with its operation');
  assert(back[1].dropSpan === true && ratValue(back[1].seamTick) === 1.234, 'a bar delete keeps its law and its sub-tick seam');
  assert(decodeSource(wire)!.timelineDetached === true, 'and the detached flag rides with them');
  // EXACTLY, not approximately. 577/3 is not representable as a decimal, and writing it as one
  // would spend the exactness the layer exists for on the first save.
  const end = decodeSource(wire)!.documentEndTick!;
  assert(end.n === 577 && end.d === 3, 'the structural end is stored as a rational and comes back bit-identical');

  // …AND THROUGH THE DOCUMENT CONTAINER, so the .riffsheet file carries them too.
  const inDocument = readRiffsheetDocument(writeRiffsheetDocument({ ...document, source: wire }));
  assert((inDocument.source.rippleOps ?? []).length === 2, 'the log travels inside the portable document');
  assert(inDocument.source.timelineDetached === true, 'so does the detached flag');

  // Through the same gate the live app uses: a hand-edited blob with a broken operation in it loses
  // the operation, never the document.
  const hostile = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
  (hostile.rippleOps as unknown[])[1] = { id: 'x', seam: [1, 0], delta: [1, 1] };
  const repaired = decodeSource(hostile as PersistedSource);
  assert(repaired!.rippleOps!.length === 1, 'an operation with a zero denominator is dropped, not divided by');
  // …and the 512/256 contradiction is resolved on the way in: the pipeline clamps `minimumBars`
  // to 256, so a document declaring 400 bars was engraved with 256 and every consumer that
  // trusted the declaration was wrong about where the score ended.
  assert(
    decodeSource({ ...wire, documentBars: 400 } as PersistedSource)!.documentBars === undefined,
    'a bar count past the pipeline’s own 256 is refused rather than silently truncated by the engraver'
  );
}

// ---------------------------------------------------------------------------
// 5. Magic-byte detection
// ---------------------------------------------------------------------------
//
// Three containers, told apart by their first bytes and nothing else. The extension is the same
// for all of them, so sniffing is the only honest route.
assert(
  readRiffsheetDocument(written).version === RIFFSHEET_DOCUMENT_VERSION,
  'PK\\x03\\x04 is read as a zip'
);
assert(readRiffsheetDocument(v1).version === 1, '{ is read as legacy JSON');
assert(readRiffsheetDocument(v2).version === 2, '{ with base64 audio is read as legacy JSON');
// Leading whitespace is legal JSON and must not defeat the sniff.
assert(
  readRiffsheetDocument(utf8(`\n  ${new TextDecoder().decode(v1)}`)).version === 1,
  'leading whitespace before the brace is still JSON'
);
// Anything else is refused with the ordinary message, not a stack trace.
rejects(utf8('not a document at all'), 'not a readable');
rejects(new Uint8Array([0x00, 0x01, 0x02, 0x03]), 'not a readable');
rejects(new Uint8Array(0), 'not a readable');
// A zip that is not one of ours: right magic, no score.json.
rejects(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), 'not a readable');

// ---------------------------------------------------------------------------
// 6. What the reader refuses
// ---------------------------------------------------------------------------

// A FUTURE version is the only version refused, and it says what to do about it. Written as JSON
// because this build cannot produce a v4 zip — which is precisely the situation being simulated.
rejects(
  utf8(JSON.stringify({ ...document, audioData: null, version: RIFFSHEET_DOCUMENT_VERSION + 1 })),
  'newer version'
);
rejects(utf8(JSON.stringify({ ...document, audioData: null, app: 'something-else' })), 'not a readable');
rejects(utf8('{ not json'), 'not a readable');
// A document with nothing to draw — in both containers.
rejects(utf8(JSON.stringify({ ...document, audioData: null, source: null })), 'no score data');
rejects(writeRiffsheetDocument({ ...document, source: null as unknown as PersistedSource }), 'no score data');

// Embedded audio pointing at an entry that is not there costs the audio and nothing else.
const danglingSource = readRiffsheetDocument(
  utf8(
    JSON.stringify({
      app: 'riffsheet-document',
      version: 3,
      savedAt: 3,
      name: 'dangling',
      source,
      settings: {},
      edits: [],
      editCursor: -1,
      // A v3-shaped block in a JSON container: the entry can never be found, so the audio is
      // dropped. The sheet still opens, which is the property being asserted.
      audioData: { name: 'take.wav', mime: 'audio/wav', encoding: 'zip', entry: 'audio/take.wav' }
    })
  )
);
assert(danglingSource.audioData === null, 'an audio entry that cannot be found is dropped');
assert(
  JSON.stringify(danglingSource.source.detected!.notes) === beforeNotes,
  'a document with unreachable audio still opens with its notes'
);

// ---------------------------------------------------------------------------
// 7. The size ceiling, on BOTH sides
// ---------------------------------------------------------------------------
//
// The read guard has always existed. The write guard is new: a save with no ceiling at all dies
// somewhere inside the allocator, and "Riffsheet quit" is a worse answer than a sentence. Checked
// by faking the length rather than by allocating half a gigabyte of test data.
// UPDATED IN THIS WAVE, and this line is the reason the number is worth asserting at all: the
// reader, the writer and the native shell now enforce ONE ceiling. The old 512 MB was a number
// only this file believed — the writer permitted a 512 MB audio entry the reader's own whole-file
// check would then refuse, and the shell capped the same document at 64 MB.
assert(MAX_DOCUMENT_AUDIO_BYTES === 128 * 1024 * 1024, 'the ceiling is 128 MB');
assert(MAX_DOCUMENT_BYTES === MAX_DOCUMENT_AUDIO_BYTES, 'the container and the audio share one ceiling');

const hugeAudio = {
  name: 'huge.wav',
  mime: 'audio/wav',
  durationSec: 9000,
  // A view whose byteLength LIES, which is all the guard reads. Nothing allocates.
  bytes: { byteLength: MAX_DOCUMENT_AUDIO_BYTES + 1 } as unknown as Uint8Array
};
throws(
  () => writeRiffsheetDocument({ ...document, audioData: hugeAudio }),
  'at most 128 MB of audio'
);
// The refusal names the size and offers a way forward rather than only saying "no".
try {
  writeRiffsheetDocument({ ...document, audioData: hugeAudio });
} catch (e) {
  const m = (e as Error).message;
  assert(m.includes('129 MB'), `the write refusal should name the size, got "${m}"`);
  assert(/MusicXML|MIDI|trim/i.test(m), `the write refusal should offer a way forward, got "${m}"`);
}
// One byte under the ceiling is a size question, not a refusal — proved by the guard not firing.
// (It fails later, on allocation, which is the caller's problem and not the guard's.)
let guardFired = false;
try {
  writeRiffsheetDocument({
    ...document,
    audioData: { ...hugeAudio, bytes: { byteLength: MAX_DOCUMENT_AUDIO_BYTES } as unknown as Uint8Array }
  });
} catch (e) {
  guardFired = /at most 128 MB/.test((e as Error).message);
}
assert(!guardFired, 'exactly 128 MB is allowed; only more than that is refused');

// The read guard, on a file whose declared length is over the ceiling.
rejects({ byteLength: MAX_DOCUMENT_BYTES + 1 } as unknown as Uint8Array, 'over 128 MB');

// ---------------------------------------------------------------------------
// 8. THE SILENT ORIGINAL — the reviewer's scenario
// ---------------------------------------------------------------------------
//
// Open a document with embedded audio; the app reports the Original as available; press play and
// hear nothing. The cause: the restore called `loadOriginal` with bytes and no TOKEN, which the
// JUCE shell answers with `durationSec: 0` having done nothing, and the answer was never read.
// The browser's mock bridge decodes those bytes directly, so every test outside a DAW passed.
//
// The rule, stated once and checked here: never report an Original that will be silent.

// The browser: the host took the bytes and reported a real length. Playable now.
assert(originalPlaybackAfterLoad(4.5, true).state === 'ready', 'a host that took the bytes is ready');
assert(
  originalPlaybackAfterLoad(4.5, false).state === 'ready',
  'a host that took the bytes is ready even with no loadAudioBytes to fall back on'
);

// THE BUG, exactly: the shell did nothing and said so. This must NOT be reported as playable
// without first minting a token — which is what `needs-token` schedules, on the first press of
// play rather than eagerly on open, so looking at the sheet never ships 50 MB to the shell.
const shell = originalPlaybackAfterLoad(0, true);
assert(shell.state === 'needs-token', 'a token-addressed host owes a hand-off before it can sound');

// The unfixable case: no route to sound at all. The fader must go dark and say why, rather than
// sit there claiming an Original that will never arrive.
const stuck = originalPlaybackAfterLoad(0, false);
assert(stuck.state === 'unplayable', 'a host with no way to take the bytes cannot claim an Original');
assert(
  stuck.state === 'unplayable' && /waveform|tuner/i.test(stuck.message),
  'the refusal explains what still works'
);
assert(
  stuck.state === 'unplayable' && /update/i.test(stuck.message),
  'the refusal says what would fix it'
);

// A negative or nonsense duration is not a length. Treated as "did nothing", never as ready.
assert(originalPlaybackAfterLoad(0, true).state !== 'ready', 'zero is not a duration');
assert(originalPlaybackAfterLoad(-1, true).state !== 'ready', 'a negative length is not a duration');
assert(originalPlaybackAfterLoad(Number.NaN, true).state !== 'ready', 'NaN is not a duration');

// ---------------------------------------------------------------------------
// 9. F16 CUTS — the list survives save and restore, on BOTH paths
// ---------------------------------------------------------------------------
//
// THE BUG. `encodeSource` copies the take field by field — a whitelist, deliberately, so that a
// transient never leaks into a blob — and `cuts` was added to `SourceAudio` without being added
// here. The cost was invisible in every browser test, because nothing reloads there: cut the
// silence off the front of a take, click another track in the DAW, come back, and the take is
// whole again while the notation edits (keyed on note ids, which a cut does NOT renumber) replay
// on top of the un-cut performance. A cut is a DECISION and cannot be recomputed from anything
// else in the blob, so it has to be written.
//
// Both paths are exercised because they are two different readers over one encoder: the session
// blob goes through `JSON.stringify`/`readSession`, the document through the zip.

const cutSource: SourceAudio = {
  name: 'cut-take.wav',
  durationSec: 20,
  peaks: null,
  trim: null,
  barOneSec: 1.5,
  // Unrounded, and NOT in order, so the normalization on the way back in is doing visible work.
  cuts: [
    { fromSec: 12.25, toSec: 14.0 },
    { fromSec: 0, toSec: 1.4123456789 }
  ],
  detected: { notes: [{ id: 'n0', startSec: 2, endSec: 2.5, midi: 40 }] }
};

// -- the session blob, which is where this was actually lost --------------------------------
const blob: PersistedSession = {
  v: SESSION_VERSION,
  app: 'riffsheet',
  savedAt: 1_700_000_000_000,
  source: encodeSource(cutSource),
  audio: null,
  settings: {},
  view: { blend: 0.35 },
  edits: [],
  editCursor: -1
};
const readBack = readSession(JSON.stringify(blob));
assert(!!readBack, 'a session blob carrying cuts must still parse');
const fromBlob = decodeSource(readBack!.source);
assert(!!fromBlob, 'a session blob carrying cuts must still decode its take');
assert(fromBlob!.cuts?.length === 2, `the cut list must survive a session round trip (got ${fromBlob!.cuts?.length})`);
// SORTED on the way back: everything downstream reads a normalized list and none of it re-checks.
assert(fromBlob!.cuts![0].fromSec === 0, 'the restored cuts are sorted by start');
assert(fromBlob!.cuts![0].toSec === 1.4123456789, 'a cut boundary is not rounded — it is a clock');
assert(fromBlob!.cuts![1].fromSec === 12.25 && fromBlob!.cuts![1].toSec === 14, 'the second cut survives whole');

// -- the .riffsheet document ------------------------------------------------------------------
const cutDoc = readRiffsheetDocument(
  writeRiffsheetDocument({ ...document, source: encodeSource(cutSource)!, audioData: null })
);
assert(
  JSON.stringify(cutDoc.source.cuts) === JSON.stringify(fromBlob!.cuts),
  'a document must carry the same cut list a session blob does'
);

// -- a take that was never cut writes NOTHING, so old blobs stay byte-identical ---------------
const uncut = encodeSource({ ...cutSource, cuts: [] });
assert(uncut!.cuts === undefined, 'an empty cut list is omitted, not written as []');
assert(encodeSource({ ...cutSource, cuts: undefined })!.cuts === undefined, 'no cuts means no field');
assert(decodeSource(uncut)!.cuts === undefined, 'a blob with no cut list restores to no cut list');

// -- a hostile or hand-edited blob cannot hand the app a list it would trust ------------------
// The two clocks in edit/cuts.ts are inverses of each other ONLY over a disjoint, in-range list.
const hostile = decodeSource({
  ...uncut!,
  cuts: [
    { fromSec: 5, toSec: 9 },
    { fromSec: 6, toSec: 7 }, // swallowed by the one above
    { fromSec: 9, toSec: 11 }, // touches it — same tape as one span
    { fromSec: -5, toSec: 0.5 }, // starts before the recording
    { fromSec: 19, toSec: 900 }, // runs past the end
    { fromSec: 3, toSec: 3.000001 }, // shorter than MIN_CUT_SEC: a mis-click
    { fromSec: Number.NaN, toSec: 2 } // not a number at all
  ] as PersistedSource['cuts']
});
assert(
  JSON.stringify(hostile!.cuts) ===
    JSON.stringify([
      { fromSec: 0, toSec: 0.5 },
      { fromSec: 5, toSec: 11 },
      { fromSec: 19, toSec: 20 }
    ]),
  `a restored cut list must be clamped, merged and sorted (got ${JSON.stringify(hostile!.cuts)})`
);
// Not an array at all is "no cuts", never a throw: a bad blob costs the restore, not the app.
assert(decodeSource({ ...uncut!, cuts: 'nope' as unknown as PersistedSource['cuts'] })!.cuts === undefined,
  'a non-array cut list is ignored rather than thrown over');

// ---------------------------------------------------------------------------
// 10. THE CONTAINER AS AN ATTACK SURFACE (codex-critique §3)
// ---------------------------------------------------------------------------
/*
 * A `.riffsheet` is opened inside a DAW's process, so every byte this reader allocates is the
 * host's memory. The old guard was one per-ENTRY ceiling, which is not a guard at all: thirty
 * entries under it still add up, a few kilobytes of deflate can declare hundreds of megabytes,
 * and nothing counted how many members an archive had.
 *
 * Every fixture below is FORGED RATHER THAN BUILT. A real 200 MB bomb would have to be allocated
 * to be written, on the machine running the test, to prove a check that never allocates anything
 * — so the fixtures are ordinary tiny zips whose DECLARED sizes have been rewritten in their
 * headers, which is precisely the lie the budgets are there to catch.
 */

/** Little-endian u32 write, for patching a zip header in place. */
function putU32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
  bytes[at + 2] = (value >>> 16) & 0xff;
  bytes[at + 3] = (value >>> 24) & 0xff;
}

/** Every offset where this four-byte signature appears. */
function signatureOffsets(bytes: Uint8Array, a: number, b: number, c: number, d: number): number[] {
  const found: number[] = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d) found.push(i);
  }
  return found;
}

/**
 * Rewrite what every member of this archive CLAIMS about itself.
 *
 * Local file header: compressed size at +18, uncompressed at +22.
 * Central directory header: compressed at +20, uncompressed at +24.
 *
 * The fixtures are a few dozen bytes of text, chosen so a signature cannot occur inside their
 * payload; a general-purpose patcher would have to walk from the end-of-central-directory record
 * instead, and would be proving something about itself rather than about the reader.
 */
function forgeDeclaredSizes(zip: Uint8Array, originalSize: number, compressedSize: number): Uint8Array {
  const out = zip.slice();
  for (const at of signatureOffsets(out, 0x50, 0x4b, 0x03, 0x04)) {
    putU32(out, at + 18, compressedSize);
    putU32(out, at + 22, originalSize);
  }
  for (const at of signatureOffsets(out, 0x50, 0x4b, 0x01, 0x02)) {
    putU32(out, at + 20, compressedSize);
    putU32(out, at + 24, originalSize);
  }
  return out;
}

const bombScore = strToU8(JSON.stringify({ ...document, audioData: null }));

// (a) THE BOMB. One entry, a few bytes on disk, declaring 900 MB. The old reader compared it
//     against 512 MB and would have refused this one — the ratio budget is what catches the same
//     trick at 400 MB, which the old ceiling waved through.
const bomb = forgeDeclaredSizes(
  zipSync({ 'score.json': bombScore, 'audio/take.wav': strToU8('not really audio') }),
  900 * 1024 * 1024,
  64
);
rejects(bomb, 'could not be opened safely');

// The ratio budget specifically: 100 MB is under BOTH the per-entry ceiling and the old 512 MB
// one, so nothing but the ratio can catch it — and the entry is 64 bytes long.
const ratioBomb = forgeDeclaredSizes(
  zipSync({ 'audio/take.wav': strToU8('not really audio') }),
  100 * 1024 * 1024,
  64
);
rejects(ratioBomb, 'expand');

// (b) THE AGGREGATE. Three entries, each declaring 60 MB — under the per-entry ceiling, at a
//     ratio of 60:1 which is under the ratio budget — and 180 MB between them. This is the shape
//     the old reader had no answer to at all.
const aggregate = forgeDeclaredSizes(
  // No `score.json` in this one: the forge rewrites every member it finds, and score.json has a
  // ceiling of its own that would fire first and prove a different check.
  zipSync({ 'audio/one.wav': strToU8('a'), 'audio/two.wav': strToU8('b'), 'audio/three.wav': strToU8('c') }),
  60 * 1024 * 1024,
  1024 * 1024
);
rejects(aggregate, 'add up to');
assert(
  60 * 1024 * 1024 * 3 > MAX_DOCUMENT_INFLATED_BYTES,
  'the aggregate fixture has to actually exceed the aggregate budget'
);

// (c) THE ENTRY COUNT. Nothing here is large; the cost is in how many times the reader is asked.
const manyEntries: Record<string, Uint8Array> = { 'score.json': bombScore };
for (let i = 0; i < MAX_DOCUMENT_ENTRIES + 4; i++) manyEntries[`pad/${i}.bin`] = strToU8('x');
rejects(zipSync(manyEntries), 'at most');

// (d) …and an ordinary document is untouched by all four budgets. The guard is only worth having
//     if it is invisible to every real file.
const ordinary = readRiffsheetDocument(written);
assert(ordinary.audioData?.bytes.length === wav.length, 'a real document still opens with its audio');
assert(MAX_SCORE_JSON_BYTES < MAX_DOCUMENT_AUDIO_BYTES, 'score.json is capped tighter than the audio');
assert(MAX_DOCUMENT_COMPRESSION_RATIO >= 100, 'the ratio budget leaves room for real JSON');

// ---------------------------------------------------------------------------
// 11. A DAMAGED DOCUMENT REFUSES TO OPEN — it does not half-open
// ---------------------------------------------------------------------------
/*
 * `decodeSource` clamps and drops, which is right for a SESSION blob: losing a restore costs the
 * user their view state, and refusing to boot costs them the app. Applied to a FILE they opened
 * by name it produces the worst outcome available — a document that opens looking nearly right,
 * missing a bar of notes because one array was truncated, which they then edit and save over the
 * original.
 *
 * Every fixture here is the v1 JSON container, because `hydrate` is the one gate both containers
 * pass through and JSON is the form a corruption is legible in.
 */
function damagedDocument(mutate: (doc: Record<string, unknown>) => void): Uint8Array {
  const doc = JSON.parse(JSON.stringify({ ...document, audioData: null })) as Record<string, unknown>;
  mutate(doc);
  return utf8(JSON.stringify(doc));
}

const peakSource = encodeSource({
  ...(decodeSource(source) as SourceAudio),
  peaks: { min: new Float32Array([-0.5, -0.2, -0.9]), max: new Float32Array([0.5, 0.2, 0.9]) }
})!;
// A HEALTHY peaks block opens, so the checks below are about damage and not about peaks existing.
readRiffsheetDocument(damagedDocument((doc) => (doc.source = peakSource)));

// `peaks.buckets` reaches `new Float32Array(buckets)`. A count that disagrees with the bytes
// beside it used to draw a partly-empty waveform; a count of 2^31 used to be an allocation.
rejects(
  damagedDocument((doc) => (doc.source = { ...peakSource, peaks: { ...peakSource.peaks!, buckets: 9_000_000 } })),
  'buckets'
);
rejects(
  damagedDocument((doc) => (doc.source = { ...peakSource, peaks: { ...peakSource.peaks!, buckets: 1 << 30 } })),
  'buckets'
);
rejects(
  damagedDocument((doc) => (doc.source = { ...peakSource, peaks: { ...peakSource.peaks!, buckets: 0 } })),
  'buckets'
);
rejects(
  damagedDocument((doc) => (doc.source = { ...peakSource, peaks: { ...peakSource.peaks!, min: 'not base64!!' } })),
  'waveform'
);

// The notes. A NaN start is a rectangle that is never painted and a note that is never heard.
rejects(
  damagedDocument((doc) => {
    (doc.source as PersistedSource).detected!.notes[1] = { startSec: null, endSec: 1, midi: 40 } as never;
  }),
  'no usable time or pitch'
);
rejects(
  damagedDocument((doc) => {
    (doc.source as PersistedSource).detected!.notes = 'nope' as never;
  }),
  'not a list of notes'
);
rejects(
  damagedDocument((doc) => {
    (doc.source as PersistedSource).detected!.notes[0] = { startSec: 2, endSec: 1, midi: 40 };
  }),
  'ends before it starts'
);

// The beat grid.
rejects(
  damagedDocument((doc) => {
    (doc.source as PersistedSource).detected!.beats = [0.5, Number.NaN, 1.5] as never;
  }),
  'not a time'
);

// The cuts. `normalizeCuts` would quietly repair these; a document may not need repairing.
rejects(
  damagedDocument((doc) => {
    (doc.source as PersistedSource).cuts = [{ fromSec: 1, toSec: 'x' }] as never;
  }),
  'no usable range'
);

// The imported parts, whose note arrays used to be cast wholesale.
rejects(
  damagedDocument((doc) => {
    (doc.source as PersistedSource).importedParts = [
      { id: 'p1', name: 'Guitar', nudgeMs: 0, notes: [{ startSec: 0, endSec: 'x', midi: 40 }] }
    ] as never;
  }),
  'no usable time or pitch'
);
rejects(
  damagedDocument((doc) => {
    (doc.source as PersistedSource).importedParts = [
      { id: 'p1', name: 'Guitar', nudgeMs: 0, notes: [{ startSec: 0, endSec: 1, midi: 40 }] },
      { id: 'p1', name: 'Bass', nudgeMs: 0, notes: [{ startSec: 0, endSec: 1, midi: 28 }] }
    ] as never;
  }),
  'share the identity'
);

// The symbolic original. Left unchecked, this throws out of `atob` at EXPORT time — days after
// the file was opened, in a save button, about a file the user is no longer thinking about.
rejects(damagedDocument((doc) => (doc.sourceMidi = 'not base64!!!')), 'original MIDI');
rejects(damagedDocument((doc) => (doc.sourceMidi = 42 as never)), 'original MIDI');

// And the session blob keeps the OPPOSITE policy, deliberately: the same damage costs a restore
// and never an exception on the way up.
assert(
  readSession(JSON.stringify({ v: SESSION_VERSION, app: 'riffsheet', source: { peaks: { buckets: 1 << 30 } } })) !==
    undefined,
  'a damaged session blob is answered, never thrown over'
);

// ---------------------------------------------------------------------------
// H4 — settings must not leak from one project into the next
// ---------------------------------------------------------------------------
/*
 * THE REPORT: "I set the fret count to 22 once, and every project I have opened since starts
 * at 22." Every setting was persisted in one global blob, so a number typed about ONE
 * instrument became a standing claim about every recording afterwards.
 *
 * The three claims, in the order they have to hold:
 *
 *  1. the take-scoped keys have FIXED defaults a new take starts from;
 *  2. a profile already carrying 22 is corrected once, by a migration, rather than forever;
 *  3. a SAVED DOCUMENT still wins — its own 22 is honoured when it is reopened, and does not
 *     write itself into the player's preferences on the way.
 *
 * `resetTakeScopedSettings()` in ui/app.ts is the third piece and lives in the DOM; verify.mjs
 * drives it through the blank-score path and reads the numbers back (§ take-scope).
 */
const takeDefaults = takeScopedDefaults();
assert(takeDefaults.maxFret === DEFAULT_SETTINGS.maxFret, 'the fret default is the take default');
assert(DEFAULT_SETTINGS.maxFret === 17, 'the shipped fret default is 17');
for (const key of TAKE_SCOPED_SETTING_KEYS) {
  assert(key in takeDefaults, `${key} is take-scoped and must be in the reset patch`);
}
// A FRESH ARRAY EVERY TIME. Two takes sharing one `customTuningMidi` would let a custom tuning
// typed on the second reach back into the first.
assert(
  takeScopedDefaults().customTuningMidi !== takeScopedDefaults().customTuningMidi,
  'the reset patch must not hand two takes the same tuning array'
);
// …and the genuine app preferences are NOT reset. Resetting a guitarist to the bass sound, or
// re-opening the piano roll they closed, on every new take is the same complaint pointed the
// other way.
for (const pref of ['playbackVoice', 'showNoteNames', 'showPianoRoll', 'pianoRollHeight',
  'midiExportMode', 'engineId', 'engineModel', 'autoSplitAtAttacks', 'useHostGrid'] as const) {
  assert(!isTakeScopedSetting(pref), `${pref} is an app preference and must survive a new take`);
}

// 2. THE PROFILE ALREADY CARRYING 22. A v12 blob is migrated once (`migrationFloor()` is 0 in
//    Node, where there is no localStorage), and the leaked values go back to the defaults.
const leaked = mergeStoredSettings({
  settingsVersion: 12,
  maxFret: 22,
  capo: 4,
  tabMode: 'guitar',
  clefMode: 'treble',
  grid: 'quarter',
  rollGrid: 'quarter',
  rollSnap: 'grid',
  // one genuine preference, which must SURVIVE the same migration
  showNoteNames: false,
  playbackVoice: 'marimba'
} as Partial<AppSettings>);
assert(leaked.maxFret === 17, `a leaked fret count is re-defaulted (got ${leaked.maxFret})`);
assert(leaked.capo === 0, `a leaked capo is re-defaulted (got ${leaked.capo})`);
assert(leaked.tabMode === DEFAULT_SETTINGS.tabMode, 'a leaked tab mode is re-defaulted');
assert(leaked.clefMode === DEFAULT_SETTINGS.clefMode, 'a leaked clef is re-defaulted');
assert(leaked.grid === DEFAULT_SETTINGS.grid, 'a leaked quantize grid is re-defaulted');
assert(leaked.rollGrid === DEFAULT_SETTINGS.rollGrid, 'a leaked roll grid is re-defaulted');
assert(leaked.rollSnap === 'off', `a leaked snap mode is re-defaulted (got ${leaked.rollSnap})`);
assert(leaked.showNoteNames === false, 'an app preference survives the take-scope migration');
assert(leaked.playbackVoice === 'marimba', 'the chosen sound survives the take-scope migration');
// A CURRENT blob is left alone: the case is one-time, not a rule that re-defaults every boot.
const current = mergeStoredSettings({ settingsVersion: SETTINGS_VERSION, maxFret: 22 } as Partial<AppSettings>);
assert(current.maxFret === 22, 'a v13 blob keeps its own fret count — the case is one-time');

// 3. A SAVED DOCUMENT STILL WINS. Reopening one restores that document's own values, and the
//    floor pinned at SETTINGS_VERSION is what stops the migration above firing over them.
const openedDoc = applyDocumentSettings(
  { ...DEFAULT_SETTINGS },
  { settingsVersion: 3, maxFret: 22, capo: 2, tabMode: 'guitar' } as Partial<AppSettings>
);
assert(openedDoc.effective.maxFret === 22, 'a document is shown with the fret count it was saved with');
assert(openedDoc.effective.capo === 2, 'a document is shown with the capo it was saved with');
assert(
  openedDoc.overridden.includes('maxFret') && openedDoc.overridden.includes('capo'),
  'the document keys are reported as on loan, so they are never written to the preferences'
);

console.log('riffsheet-doc-test: all assertions passed');
