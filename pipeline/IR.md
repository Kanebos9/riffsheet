# Riffsheet pipeline contract

The pipeline is a pure TypeScript package. `buildScore(input, settings)` returns one canonical
`RiffsheetIR` plus MusicXML, MIDI, and alphaTab adapters. The canonical pitch domain is **sounding
MIDI**: middle C is MIDI 60, MusicXML C4, and alphaTab `{ octave: 5, tone: 0 }`. alphaTab's octave
number is deliberately one greater than scientific pitch notation, so its invariant is
`octave * 12 + tone === midi`.

## Input

```ts
interface BuildInput {
  notes: InputNote[];
  beatTimesSec?: number[];
  tempoBpm?: number;
  audioDurationSec?: number;
  timeSignature?: [number, number];
  blankBars?: number;
}

interface InputNote {
  id?: string;
  startSec: number;
  endSec: number;
  midi: number;
  velocity?: number;
  confidence?: number;

  // Authoritative symbolic-import metadata. Audio detections omit these fields.
  sourceTiming?: { startTick: number; endTick: number; ppq: number };
  sourceClef?: 'treble' | 'bass';
  sourceTrackIndex?: number;
  sourceStaffIndex?: number;
  sourceBarIndex?: number;
  sourceVoiceIndex?: number;
  displayPitchOffset?: number;
  sourceBars?: SourceBar[];
  sourceTempoChanges?: { tick: number; ppq: number; bpm: number }[];
}
```

`sourceTiming`, bar structure, meter, tempo, clefs, and staff identity are used only when an
importer marks them as authoritative. They bypass audio quantization. A source display
transposition never changes canonical sounding pitch. For an OMR file whose notes were entered as
written octave, the caller may reinterpret once at ingest: canonical MIDI moves down an octave and
`displayPitchOffset` keeps the printed pitch unchanged.

## Settings

```ts
interface BuildSettings {
  grid?: 'auto' | '1/4' | '1/8' | '1/16' | '1/8T' | 'free';
  timeSignature?: 'auto' | [number, number];
  fillGaps?: boolean;
  showStaccato?: boolean;
  instrument?: 'staff' | 'bass4' | 'bass5' | 'bass6' | 'guitar6';
  tuningMidi?: number[];              // low to high, exact sounding MIDI
  clefMode?: 'auto' | 'treble' | 'bass' | 'grand';
  keyFifths?: number;                 // authoritative override, clamped to -7..7
}
```

`instrument` here describes engraving only. The transcription-engine constraint is a separate
webcore setting. Enabling TAB or changing tuning must never alter staff pitches or clefs.

## Canonical IR invariants

- All ticks use `DIVISIONS = 960` per quarter note.
- All pitches are sounding MIDI integers. Note spelling is stored separately.
- Bars cover the score contiguously; beats cover every bar without gaps or overlaps.
- A note split at a barline has matching tie start/stop flags.
- Generated single-staff scores choose one stable clef for the whole part.
- Authoritative imported treble/bass changes are preserved.
- A grand part has two simultaneous standard-notation staves, not alternating clefs.
- TAB assignment uses the exact low-to-high tuning and never octave-folds a canonical note.
- Metric decisions use integer ticks or exact rationals, never floating-point equality.
- Stable source note IDs survive settings-only rebuilds.

## Stage order

1. Validate and guard input notes.
2. Build the time skeleton, or apply authoritative imported bars.
3. Group chords before quantization.
4. Quantize audio notes; retain exact ticks for symbolic notes.
5. Simplify rests and durations.
6. Detect or apply key, then spell notes and display accidentals.
7. Choose stable clefs; preserve authoritative source clefs/staves.
8. Detect legato before assigning strings and frets.
9. Split across bars, compute ties, tuplets, and beams.
10. Emit the shared IR and adapt it to MusicXML, MIDI, and alphaTab.

## Output behavior

MusicXML and alphaTab both emit two real staves for grand staff. Imported staff identity controls
which staff receives a note; generated grand staff uses middle C as the split. Each projected staff
retains full measure rhythm by replacing notes belonging to the other staff with rests.

The alphaTab adapter uses its native octave convention while preserving the MIDI invariant above.
MusicXML uses scientific pitch numbering. Stringed output includes an explicit low-to-high tuning
summary in the part/track name so printed and exported sheets are self-describing.

Quantized MIDI follows IR tempo and meter changes. As-played MIDI uses the original note seconds and
a constant tick clock, preserving wall-clock performance timing. A symbolic MIDI import retains its
original bytes for exact re-export at the webcore boundary.

## Safety limits

Webcore importers reject empty or oversized files, impossible header/chunk lengths, invalid MIDI
division, overlong variable-length quantities, excessive tracks/events/notes, and unsupported
independent/SMPTE MIDI timelines. Invalid imports throw a user-facing error instead of allocating or
looping without a bound.

## Tests

`scripts/run-tests.sh` bundles the Vitest-compatible suite for JavaScriptCore. `npm test` remains the
normal Node-based entry point on development machines with Node installed. Golden regeneration is
atomic: a fixture is replaced only after generation succeeds.
