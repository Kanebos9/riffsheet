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
  grid?: 'auto' | '1/4' | '1/8' | '1/16' | '1/8T' | 'thirtysecond' | 'free';
  timeSignature?: 'auto' | [number, number];
  fillGaps?: boolean;                 // DEPRECATED, ignored — see below
  showStaccato?: boolean;             // DEPRECATED, ignored — see below
  instrument?: 'staff' | 'bass4' | 'bass5' | 'bass6' | 'guitar6';
  tuningMidi?: number[];              // low to high, exact sounding MIDI
  fingeringStyle?: 'low' | 'minMovement' | 'openStrings' | 'aroundFret';
  anchorFret?: number;                // anchor for 'aroundFret'; default 5
  clefMode?: 'auto' | 'treble' | 'bass' | 'grand';
  keyFifths?: number;                 // authoritative override, clamped to -7..7
}
```

`fillGaps` and `showStaccato` are accepted so existing callers keep compiling, and are read by
nothing. Notes are written at the length they were played; the pass that lengthened them over the
following silence, and the staccato dots it inferred from having done so, are both deleted.
`IRNote.staccato` and `IRStats.staccatoNotes` / `IRStats.gapsAbsorbed` stay in the shape — the
first for a future editing surface to set by hand, the other two pinned at 0.

`instrument` here describes engraving only. The transcription-engine constraint is a separate
webcore setting. Enabling TAB or changing tuning must never alter staff pitches or clefs.

## Canonical IR invariants

- All ticks use `DIVISIONS = 24` per quarter note, exported from the package. A 1/32 is 3 ticks,
  a 1/16 is 6, an eighth-note triplet unit is 8, a quarter is 24, a 4/4 bar is 96, and a compound
  (dotted-quarter) beat is 36. Read it from `DIVISIONS`; never hard-code the number.
- A GRID IS A CEILING ON WHAT THE PAGE MAY PRINT, binding durations exactly as tightly as onsets.
  Under `grid: '1/4'` no glyph is finer than a quarter, under `'1/8'` none finer than an eighth,
  and so on. A coarse grid may MERGE two events onto one slot — keeping the pitch with the most
  duration-weighted evidence — but it never fabricates an extra attack.
- `grid: 'thirtysecond'` is the only setting that offers a 1/32 lattice; `'auto'` never volunteers
  one. The literal is spelled out, not `'1/32'`, and is shared verbatim with the webcore union.
- `grid: 'free'` is a read-only view of the input, not a looser quantizer: one attack group per
  played event, in play order, nothing merged or dropped, positions and durations on the 1/32
  lattice (the finest the printable vocabulary can express), engraved as the fewest glyphs that
  add up rather than as a maximal-precision tie chain.
- A printed `<type>` always equals the `<duration>` it is printed against. A tied chain is ONE
  attack: only the head of a chain has `tieStop: false`.
- All pitches are sounding MIDI integers. Note spelling is stored separately.
- Bars cover the score contiguously; beats cover every bar without gaps or overlaps.
- A note split at a barline has matching tie start/stop flags.
- Generated single-staff scores choose one stable clef for the whole part.
- Authoritative imported treble/bass changes are preserved.
- A grand part has two simultaneous standard-notation staves, not alternating clefs. `grandStaff`
  does not depend on the instrument: a fretted part gets the pair too, with its TAB staff beneath.
- `RiffsheetIR.grandStaffClefs` is the pair itself, upper first, and is present exactly when
  `grandStaff` is true. `IRNote.staffIndex` (0 upper, 1 lower) says which of the two prints each
  note, and is absent on a non-grand score. Both are decided once, during the build; an emitter
  reads them and never re-derives the split.
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

MusicXML and alphaTab both emit real stacked staves for a grand staff, and a fretted grand part
gets THREE: treble, bass, then TAB. Imported staff identity controls which staff receives a note;
otherwise the split is middle C on sounding pitch. Each projected notation staff retains the full
measure rhythm by replacing the other staff's notes with rests, while the TAB staff always shows
the whole part — a fretboard is not split by a notation boundary.

Beam groups and tuplet brackets belong to ONE STAFF'S sequence, so both are recomputed per staff
AFTER the projection (`beaming.ts`), never inherited from the merged rhythm the bars were built
from: a group straddling the split otherwise leaves one staff a beam `continue` whose `begin` went
to the other, or a `<tuplet type="stop"/>` with no start. A rest created by the projection inside a
tuplet keeps the group's `<time-modification>` and can carry a bracket edge, because a written
`<type>` and a sounding `<duration>` may only ever differ by that element — and both emitters
assert it, on every note and rest they write.

A TAB staff that sits under notation staves prints no rest glyphs: the rests are already on the
notation. The rest is not removed — MusicXML keeps the `<note>` and its `<duration>` and marks it
`print-object="no"`, and the alphaTab hand-off flags the staff `showRests: false` while still
sending every rest beat at full length. Deleting them instead would leave the staff short of the
barline and corrupt the `<backup>` that follows.

Staff numbering is 1-based, top to bottom, notation first and TAB last, so MusicXML `<staves>` is
1, 2 or 3 and the TAB clef/`<staff-details>` carry whichever number is last. The measure body is a
stack of layers: emit a layer, assert its cursor reached the barline, back up by exactly what it
advanced, emit the next. The alphaTab hand-off is plain JSON, never alphaTex, so a three-staff
track is expressed directly as three `Track.staves` entries; the notation staves of a fretted
grand part deliberately omit string/fret, because their tuning is empty and alphaTab resolves a
stringed note's pitch through its own staff's tuning.

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
