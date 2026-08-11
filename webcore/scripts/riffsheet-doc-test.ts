/**
 * The `.riffsheet` document format, v1 and v2.
 *
 * v2 puts the RECORDING inside the file (#34). Before it, a document named a path and hoped —
 * mail it to somebody, open it on another machine, or move the wav, and the sheet arrived with a
 * silent fader. The two things worth proving about that are the two that are easy to get wrong:
 *
 *  1. the audio that comes out is the audio that went in, BYTE FOR BYTE, through a JSON string;
 *  2. a v1 document written before any of this still opens, because a reader that rejects the
 *     files its own users already have is not a reader.
 */

import {
  RIFFSHEET_DOCUMENT_VERSION,
  base64ToBytes,
  bytesToBase64,
  encodeWavPcm16,
  readRiffsheetDocument,
  writeRiffsheetDocument,
  type PersistedSource,
  type RiffsheetDocument
} from '../src/app/persist';

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

// ---------------------------------------------------------------------------
// 1. Base64 survives every byte value
// ---------------------------------------------------------------------------
//
// This is the whole reason the audio is base64 and not, say, a raw string: a JSON string cannot
// hold arbitrary bytes, and the failure is silent — 0x00 and everything above 0x7F come back
// mangled rather than throwing. So the encoding is proved over the full range first, because
// every other claim in this file rests on it.
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
// 3. A v2 document round-trips its audio and its performance
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
    encoding: 'base64',
    bytes: bytesToBase64(wav),
    durationSec: 4.5,
    sampleRate: 44100
  }
};

const written = writeRiffsheetDocument(document);
const reopened = readRiffsheetDocument(written);

assert(reopened.version === 2, 'a document written by this build reports version 2');
assert(!!reopened.audioData, 'a v2 document comes back with its recording');

// THE CLAIM: byte-identical audio.
const restored = base64ToBytes(reopened.audioData!.bytes);
assert(restored.length === wav.length, `audio length changed: ${wav.length} -> ${restored.length}`);
for (let i = 0; i < wav.length; i++) {
  assert(restored[i] === wav[i], `audio byte ${i} changed in the round trip`);
}
assert(reopened.audioData!.sampleRate === 44100, 'the sample rate travels with the audio');
assert(reopened.audioData!.mime === 'audio/wav', 'the container type travels with the audio');

// …and an identical performance layer beside it.
const beforeNotes = JSON.stringify(source.detected!.notes);
const afterNotes = JSON.stringify(reopened.source.detected!.notes);
assert(beforeNotes === afterNotes, 'the performance layer must survive the round trip exactly');
assert(reopened.source.barOneSec === 0.9, 'bar 1 survives');
assert(JSON.stringify(reopened.source.detected!.beats) === JSON.stringify([0.9, 1.4, 1.9, 2.4]), 'beats survive');
// The reference is still written as well: it is what lets a reopened document find the original
// file on the machine that made it, which is the only route "Listen again" has.
assert(reopened.audio?.path === '/somewhere/take.wav', 'the take reference is still recorded');

// ---------------------------------------------------------------------------
// 4. A v1 document still opens
// ---------------------------------------------------------------------------
//
// The old reader demanded an exact version match, so every bump would have orphaned every file
// already on disk. This is the check that keeps that from ever being true again.
const v1 = new TextEncoder().encode(
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

// A v2 document that was saved from a symbolic import has no recording either, and that is not
// an error — it is a document of something that never had one.
const v2NoAudio = readRiffsheetDocument(
  writeRiffsheetDocument({ ...document, audioData: null })
);
assert(v2NoAudio.audioData === null, 'a v2 document may legitimately carry no recording');

// ---------------------------------------------------------------------------
// 5. What the reader refuses
// ---------------------------------------------------------------------------

// A FUTURE version is the only version refused, and it says what to do about it.
rejects(
  new TextEncoder().encode(JSON.stringify({ ...document, version: 3 })),
  'newer version'
);
rejects(new TextEncoder().encode(JSON.stringify({ ...document, app: 'something-else' })), 'not a readable');
rejects(new TextEncoder().encode('{ not json'), 'not a readable');
// A document with nothing to draw.
rejects(new TextEncoder().encode(JSON.stringify({ ...document, source: null })), 'no score data');

// Corrupt embedded audio costs the audio and nothing else: the sheet still opens.
const badAudio = readRiffsheetDocument(
  new TextEncoder().encode(JSON.stringify({ ...document, audioData: { encoding: 'raw', bytes: 'xx' } }))
);
assert(badAudio.audioData === null, 'unreadable embedded audio is dropped rather than thrown');
assert(
  JSON.stringify(badAudio.source.detected!.notes) === beforeNotes,
  'a document with broken audio still opens with its notes'
);

// The size ceiling is 512 MB now rather than 32 MB — base64 inflates audio by about a third, so
// the old one turned away any take over roughly 24 MB. Checked by its message rather than by
// building half a gigabyte of test data.
try {
  readRiffsheetDocument(new Uint8Array(0));
  throw new Error('unreachable');
} catch (e) {
  assert((e as Error).message.includes('not a readable'), 'an empty file is unreadable, not oversized');
}

console.log('riffsheet-doc-test: all assertions passed');
