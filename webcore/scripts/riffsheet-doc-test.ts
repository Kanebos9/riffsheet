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

import {
  MAX_DOCUMENT_AUDIO_BYTES,
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
import type { SourceAudio } from '../src/app/state';

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

assert(reopened.version === 3, 'a document written by this build reports version 3');
assert(!!reopened.audioData, 'a v3 document comes back with its recording');

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
// 5. Magic-byte detection
// ---------------------------------------------------------------------------
//
// Three containers, told apart by their first bytes and nothing else. The extension is the same
// for all of them, so sniffing is the only honest route.
assert(readRiffsheetDocument(written).version === 3, 'PK\\x03\\x04 is read as a zip');
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
assert(MAX_DOCUMENT_AUDIO_BYTES === 512 * 1024 * 1024, 'the ceiling is 512 MB');

const hugeAudio = {
  name: 'huge.wav',
  mime: 'audio/wav',
  durationSec: 9000,
  // A view whose byteLength LIES, which is all the guard reads. Nothing allocates.
  bytes: { byteLength: MAX_DOCUMENT_AUDIO_BYTES + 1 } as unknown as Uint8Array
};
throws(
  () => writeRiffsheetDocument({ ...document, audioData: hugeAudio }),
  'at most 512 MB of audio'
);
// The refusal names the size and offers a way forward rather than only saying "no".
try {
  writeRiffsheetDocument({ ...document, audioData: hugeAudio });
} catch (e) {
  const m = (e as Error).message;
  assert(m.includes('513 MB'), `the write refusal should name the size, got "${m}"`);
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
  guardFired = /at most 512 MB/.test((e as Error).message);
}
assert(!guardFired, 'exactly 512 MB is allowed; only more than that is refused');

// The read guard, on a file whose declared length is over the ceiling.
rejects({ byteLength: MAX_DOCUMENT_AUDIO_BYTES + 1 } as unknown as Uint8Array, 'over 512 MB');

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

console.log('riffsheet-doc-test: all assertions passed');
