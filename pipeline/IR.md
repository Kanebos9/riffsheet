# Riffsheet pipeline contract

The pipeline is a pure TypeScript package. `buildScore(input, settings)` returns one canonical
`RiffsheetIR` plus MusicXML, MIDI, and alphaTab adapters. The canonical pitch domain is **sounding
MIDI**: middle C is MIDI 60, MusicXML C4, and alphaTab `{ octave: 5, tone: 0 }`. alphaTab's octave
number is deliberately one greater than scientific pitch notation, so its invariant is
`octave * 12 + tone === midi`.

Several instruments print as one document through `buildMultiPartScore` — N of these builds
sharing one clock, merged at the output layer. See **Multi-part scores** below; a single-part
build is byte-for-byte unaffected by any of it.

## Input

```ts
interface BuildInput {
  notes: InputNote[];
  beatTimesSec?: number[];
  tempoBpm?: number;
  audioDurationSec?: number;
  detachedTimeline?: boolean;
  timeSignature?: [number, number];
  minimumBars?: number;               // floor on printed bars, 1..256
  blankBars?: number;                 // DEPRECATED name for minimumBars
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

### `detachedTimeline` — the score's clock is no longer the audio's

`audioDurationSec` drives one rule: station 7's past-end filter drops a detected note starting at
or after the last sample and clamps a note that merely rings past it. That rule is only true while
the note list is a *transcript* of the audio.

Bar insert/delete makes it false on purpose. Inserting a bar is a pure note-time edit — real,
user-owned material moves later while the waveform stays exactly as long as it was recorded — so
the score's timeline legitimately exceeds and diverges from the audio's. `detachedTimeline: true`
says so, and turns that one rule off:

* notes beyond `audioDurationSec` are engraved normally, with their full sounding length;
* the time skeleton extends to hold them (its length has always been derived from the material and
  `minimumBars`, never from the audio) — the tempo map, the tick↔seconds map and `validateIR` need
  no change and no other guard trims;
* `audioDurationSec` may still be passed and remains meaningful to the app as the waveform's
  extent; it simply stops being an authority over the notes.

Everything else is unchanged. The sub-30 ms filter is a statement about detection quality, not
about where the audio stops, so it still applies; so do chord grouping, the overlap clamp and the
repeat-loop flag. Symbolic notes were already exempt from both audio-length rules.

For a multi-part build the flag lives on `SharedBuildInput` and applies to every part.

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
  tab?: 'two-staves' | 'omit';        // whether the TAB staff is printed; default 'two-staves'
  displayPitchOffset?: number;        // written-staff offset from sounding pitch, in semitones
}
```

`fillGaps` and `showStaccato` are accepted so existing callers keep compiling, and are read by
nothing. Notes are written at the length they were played; the pass that lengthened them over the
following silence, and the staccato dots it inferred from having done so, are both deleted.
`IRNote.staccato` and `IRStats.staccatoNotes` / `IRStats.gapsAbsorbed` stay in the shape — the
first for a future editing surface to set by hand, the other two pinned at 0.

`instrument` here describes engraving only. The transcription-engine constraint is a separate
webcore setting. Enabling TAB or changing tuning must never alter staff pitches or clefs.

**`tab` is visibility, `instrument` is identity, and they are not the same field.** `tab: 'omit'`
hides the tablature staff and changes nothing else — same instrument, same tuning, same string
count, same written octave — and it reaches `RiffsheetIR.tab`, which both emitters honour.
Hiding the tab by rebuilding as `instrument: 'staff'` with an empty tuning is the bug this field
replaces: the conventional 8va engraving of a fretted part rides on the instrument, so that
route dropped the whole notation an octave onto ledger lines.

`displayPitchOffset` states the part's written octave directly (+12 = the staff reads an octave
above what sounds). A symbolic import that declares its own written octave still wins: its notes
carry the offset and the source is the authority on how it was engraved.

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
11. Assemble the projection: account for every input note. See "Projection" below.

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

## Projection — what happened to every input note

`BuildResult.projection` is a TOTAL account of the build's input. For every id the build was
handed, `projection.byId` holds exactly one outcome, and

```
counts.engraved + counts.merged + counts.dropped === counts.input === byId.size
```

holds on every build, on every grid. This is the contract the sheet/roll seam is built against: the
roll draws every performed note and the sheet draws what survived engraving, so "this note is not on
the page" must be answerable with a reason rather than inferred from a note count. `PartBuild`
carries the same structure per part, keyed by the NAMESPACED id (`p2-n0`) — the id the IR and both
emitters carry.

```ts
interface Projection {
  byId: Map<string, NoteProjection>;      // total: one entry per input id
  chordGroups: ChordGroupProjection[];    // the chord law's own partition, in onset order
  counts: { input: number; engraved: number; merged: number; dropped: number };
}

type NoteProjection =
  | { kind: 'engraved'; id: string; glyphs: GlyphRef[]; engravedTicks: number;
      intentIgnored?: IntentIgnored }
  | { kind: 'merged'; id: string; mergedInto: string; reason: MergeReason }
  | { kind: 'dropped'; id: string; reason: DropReason };

interface GlyphRef {
  bar: number;      // index into ir.bars
  voice: number;    // IRVoice.id (1 or 2), NOT an index
  beat: number;     // index into that voice's beats
  note: number;     // index into that beat's notes
  startTick: number;  // absolute: bar.startTick + beat.startTick
  durTicks: number;
  tieStart: boolean;
  tieStop: boolean;
}

type MergeReason =
  | 'chord-duplicate-pitch'     // chords.ts: one notehead cannot be printed twice
  | 'quantize-collision'        // quantize.ts: two events landed on one grid tick
  | 'symbolic-tick-collision';  // symbolic.ts / the exact quantizer: one printable slot

type DropReason =
  | 'past-audio-end'          // guards.ts: onset at or past audioDurationSec
  | 'below-min-duration'      // guards.ts: under MIN_NOTE_SEC and nothing declared it
  | 'past-score-end'          // buildScore.ts: quantized onset at or past the last barline
  | 'zero-length-after-clamp' // buildScore.ts: the overlap clamp left it no ticks
  | 'unengraved';             // BACKSTOP — see below
```

`glyphs` lists EVERY glyph the note became, in printed order: a span the bar law split into tied
pieces is several entries, and `engravedTicks` is their sum. A consumer that wants "the notehead for
note X" must take all of them.

`merged` means the note is still audible on the page, inside another note's slot. `mergedInto` is
resolved TRANSITIVELY: it always names an id that is not itself merged, so a consumer follows one
pointer and never a chain. Do not treat a merged note as deleted.

`unengraved` is a BACKSTOP, and its presence in a build is a bug report rather than a normal
outcome: it means a station removed a note without recording it. The assembly ends with a sweep over
the input ids that assigns it to anything no station claimed, so a loss point added upstream cannot
re-open the silent door — it surfaces as an honest count instead. The property sweep in
`test/projection.test.ts` asserts it never fires.

Precedence in the assembly is: the page wins, then the ledger, then the backstop. An id with a glyph
is `engraved` whatever any station recorded, because the glyph is the observable fact.

### The chord law, published

`chords.ts` owns the only definition of "these notes are one chord", and it is a GREEDY PARTITION of
the whole note list, not a pairwise predicate:

```ts
interface ChordGroupProjection {
  id: string;              // build-local event id (`e0`, `e1`, ...); stable within ONE build
  memberIds: string[];     // every id the LAW admitted, low pitch first, merged members included
  engravedIds: string[];   // the subset that reached the page
  onsetSec: number;
  endSec: number;
  windowSec: number;       // the window as it stood when the group closed; 0 on a written source
  law: 'performance-window' | 'written-tick';
}
```

Two laws, chosen per group. A PERFORMED group takes attacks inside `max(35 ms, 1/64 whole note)`
measured from the group's first note, WIDENED by half a base window for every arrival in the last
quarter of the current one, with no ceiling. A WRITTEN group (a note carrying `sourceTiming`) admits
exactly the notes on its own written tick and consults no window at all.

`CHORD_WINDOW_MIN_SEC` IS NOT A CONSERVATIVE APPROXIMATION OF THIS, in either direction, and a
caller that groups with it will disagree with the page. Two counterexamples, both in the test file:

- **Chaining.** Onsets at 0, 34 and 68 ms with a 35 ms base. The engraver takes 0 and 34 (the window
  widens to 52.5 ms), then finds 68 > 52.5 and starts a second group. A caller asking "is anything
  within 35 ms of this note" calls 34 and 68 one chord — it merged a pair the page splits.
- **Written sources.** Two imported notes 3 ms apart on different written ticks are two events here
  and one chord to anything holding a millisecond threshold. No number fixes this: the law on that
  path is not a window.

Ask the partition, never a threshold: `chordGroupsOf(notes, beatPeriodSec)` answers without a build,
and `projection.chordGroups` is the answer a particular engraved page was made from.

### Notation intent, and when it goes stale

A stored `notationIntent` is HONOURED when the note's quantized span could legally carry it — the
page gave it the declared number of ticks to within ONE SUBDIVISION of the lattice the note was
measured against (the containing tuplet's `unitTicks` inside a group, `basicQuantTicks` outside one;
the same `durUnit` the quantizer snaps with). Otherwise the projection raises a verdict:

```ts
interface IntentIgnored {
  reason: 'not-carried' | 'tuplet-lattice' | 'chord-superseded' | 'symbolic-source' | 'unprintable';
  declaredTicks: number | null;  // null when the value names nothing printable
  engravedTicks: number;         // summed over every piece of a tie split
  toleranceTicks: number;
}
```

- `not-carried` — THE STALE CASE. The declaration asked for a length the note's position cannot
  hold: the next attack trimmed it, or the last barline clipped it. A declaration is stored together
  with the seconds that match it, and a later timing edit — a roll drag, a snap, a cut ripple, a
  neighbour moving — changes what the span can hold while leaving the declaration behind.
- `tuplet-lattice` — not a whole number of the containing group's units, so nothing else was
  printable there.
- `chord-superseded` — a chord is one slot with one value, and a longer declaration from another
  member of the same chord won.
- `symbolic-source` — a written source decided every tick before a declaration could be consulted.
  The stored intent is inert rather than wrong.
- `unprintable` — `notationIntentTicks` refused the value (a dotted 1/32 names no length).

THE PIPELINE REPORTS AND DOES NOT CLEAR. It is a pure function of its input and the stored intent
lives in the caller's document; clearing it here would last exactly one build and then be
re-supplied. The seam owns the value, so the SEAM clears it on seeing `not-carried`, and the next
build measures the note. That loop converges: with no declaration there is nothing left to
contradict. The pipeline cannot tell "stale" from "fresh" by comparing the declaration against the
seconds, because the whole point of a declaration is that it outranks the measurement — what it can
tell is that the page could not carry the value, which is exactly the condition under which the
stored intent is a lie.

## Multi-part scores (Parts)

Several instruments print as ONE document — a guitar part over a bass part — through a second
entry point beside `buildScore`. Nothing about the IR changes: `RiffsheetIR` is, as it has always
been, ONE part's engraving. A multi-part score is N ordinary builds merged at the OUTPUT layer,
because every invariant the IR carries (ties, tuplet balance, type-vs-duration, the measure
cursor, the grand-staff split) is a statement about one part's staves and means nothing across
parts.

```ts
buildMultiPartScore(
  parts: ScorePart[],                 // PRINTED ORDER, top to bottom. 1..MAX_PARTS (4).
  sharedInput: SharedBuildInput,      // = Omit<BuildInput, 'notes'>
  sharedSettings: BuildSettings       // the ordinary settings; timing/key/title half is score-wide
): MultiPartBuildResult;

interface ScorePart {
  notes: InputNote[];         // the part's content, in the form the app already produces it
  name?: string;              // printed part name; omitted, the part names itself as today
  abbreviation?: string;      // <part-abbreviation>
  role?: 'live' | 'imported'; // default: 'live' for index 0, 'imported' for the rest
  nudgeSec?: number;          // move this part against the shared clock, before quantize. Default 0
  // engraving-only overrides; anything absent falls back as described below
  instrument?: Instrument;
  tuningMidi?: number[];
  fingeringStyle?: FingeringStyle;
  anchorFret?: number;
  capo?: number;
  maxFret?: number;
  clefMode?: ClefMode;
  tab?: 'two-staves' | 'omit';
  octaveTransposition?: 'none' | 'conventional';
  midiProgram?: number;       // General MIDI program - 1
}

interface MultiPartBuildResult {
  parts: PartBuild[];
  liveIndex: number;          // index of the live take; -1 if the caller declared none
  toMusicXML(): string;
  toMidi(quantized: boolean): Uint8Array;
  toAlphaTabModelData(): AlphaTabScoreData;
}

interface PartBuild {
  index: number;              // 0-based printed order
  id: string;                 // 'P1', 'P2', ... — the MusicXML part id AND the tracks[] index
  name: string;               // the resolved display name, as the file actually contains it
  abbreviation?: string;
  role: 'live' | 'imported';
  idPrefix: string;           // what was prepended to this part's note ids ('' for part 0)
  nudgeSec: number;
  ir: RiffsheetIR;
  diagnostics: BuildDiagnostics;
}
```

**What parts share, and it is exactly two things.** THE CLOCK — same tempo, same meter, same bars,
bar 1 aligned — and THE KEY SIGNATURE. Both are derived once from every note in the score, so a
bass entering on bar 3 does not number that bar 1 and two parts of one piece never print different
accidentals. An imported part's `sourceBars` / `sourceTempoChanges` become the whole score's bar
and tempo map, not just its own. Everything else — clefs, grand staff, tuning, tab, string
assignment, rests, beams, stats, diagnostics — is decided from that part's notes alone, exactly as
on a single-part build, and no code path exists by which one part's content could reach another's
engraving.

**Defaults per role.** The live part inherits `sharedSettings` verbatim, so it keeps the full
grand-staff/TAB options it has today. An imported part defaults to `instrument: 'staff'` — a plain
notation staff with no invented fretboard — and its tuning follows its instrument rather than the
shared settings, so a bass tuning left in the shared settings cannot give a `'staff'` part a
tablature staff nobody asked for. TAB is not hard-blocked: name an instrument on an imported part
and it gets tab like any other.

**The nudge** is a translation, in seconds, applied before quantization; positive is later. A part
carrying its own written ticks (`sourceTiming`) is shifted in ticks too, by `nudgeSec` at the
score's display tempo — ONE constant shift for the whole part, so its internal rhythm survives
exactly. `sourceBars` / `sourceTempoChanges` are never nudged: they ARE the shared clock.

**Note ids are unique across the SCORE.** Part 0 keeps its ids untouched; every later part is
namespaced `p2-`, `p3-`, ... Read `PartBuild.idPrefix` and strip it to recover the id you passed in.

**Bar alignment.** Both output formats stack parts by measure, so every part must cover the same
bars. The shared clock does almost all of this; a part whose last note rings past the final barline
can still come out one bar longer, and shorter parts are then padded with whole-bar rests
(`alignPartBars`, also exported). A disagreement about a bar two parts BOTH have is a broken clock
and throws rather than being papered over.

**Outputs.**

- MusicXML: one `score-partwise` with a real `<part-list>` — `P1..PN`, part names and
  abbreviations from the labels, one MIDI channel each. Metronome marks are written on the top
  part only (N stacked tempo marks is not a score).
- alphaTab: one `AlphaTabScoreData` with N `tracks`, against ONE `masterBars` list. `webcore`'s
  `fromPipeline` already loops `data.tracks`, so nothing new is needed on the screen side.
  An imported track carries `notationOnly: true`; **do not route those to playback**.
- MIDI: format 1 — a conductor track carrying tempo/meter/key, then one track per part on its own
  channel. ALL parts are written, including imported ones the app never plays: the file format
  should describe the document the user is looking at, and every DAW expects the parts to be
  there. (A deliberate asymmetry between what the app plays and what the file contains.)

**A single-part score is unchanged, byte for byte, on all three emitters.**
`buildMultiPartScore([{ notes }], input, settings)` produces exactly what `buildScore(input,
settings)` produces — the same MusicXML string, the same MIDI bytes (format 0, one track), the
same alphaTab JSON including key order, and the same IR. Callers can therefore route every build
through the multi-part entry point and never branch on part count. `multipart.test.ts` proves this
against every golden case.

The emit-level primitives are exported too, for a caller that already holds built parts:
`toMultiPartMusicXML(parts)`, `toMultiPartAlphaTabModelData(parts)`, `toMultiPartMidi(parts,
quantized)`, plus `defaultPartName(ir)` and `alignPartBars(irs)`. `buildScore` gained an optional
third argument, `BuildOptions`, whose only field is `sharedNotes` — the score's notes, from which
the clock and the key are derived. It is the one hook multi-part needed inside the pipeline.

## Tick/seconds conversion

`buildTickSecondsMap(ir)` (also accepts `{ divisions, tempo }` on its own) returns the
authoritative bidirectional map between the IR's tick domain and wall-clock seconds. It is built
from `ir.tempo` and nothing else.

```ts
const map = buildTickSecondsMap(ir);
map.tickToSec(48);        // seconds from tick 0
map.secToTick(1.5);       // the exact inverse
map.bpmAt(48);            // quarter-notes per minute in force at that tick
map.segments;             // piecewise-constant tempo segments, ascending, starting at tick 0
```

- **Segments** are half-open `[tick, nextTick)`, so a tempo change lands on exactly one of them.
  Inside a segment the relation is affine (`sec = seg.sec + (tick - seg.tick) * seg.secPerTick`),
  which makes `secToTick(tickToSec(t)) === t` to floating point for every tick, and the same the
  other way round for every second in the score.
- **`ir.tempo.changes` is authoritative when present, INCLUDING a change at tick zero** — the one
  entry every other reader of this data historically skipped. When there is no change at or
  before tick 0, `tempo.displayBpm` seeds the opening segment; when there is no usable tempo at
  all, 120 BPM does.
- **Monotonic by construction**: a non-finite or non-positive BPM is dropped rather than clamped,
  so seconds increase strictly with ticks and the inverse is a function. A repeated tempo is
  folded into the previous segment, so `segments` is a minimal description.
- Outside the score the map extrapolates linearly from the first/last segment rather than
  clamping, so a playhead slightly past the end still has a defined position.

`bpm` is always QUARTER notes per minute — the universal convention — regardless of the meter's
beat unit. In this wave the map is FOUNDATION: nothing in webcore is rewired to it yet, and the
consumers that still multiply by one `displayBpm` are listed in the wave plan as the next step.

## Safety limits

Webcore importers reject empty or oversized files, impossible header/chunk lengths, invalid MIDI
division, overlong variable-length quantities, excessive tracks/events/notes, and unsupported
independent/SMPTE MIDI timelines. Invalid imports throw a user-facing error instead of allocating or
looping without a bound.

## Tests

`scripts/run-tests.sh` bundles the Vitest-compatible suite for JavaScriptCore. `npm test` remains the
normal Node-based entry point on development machines with Node installed. Golden regeneration is
atomic: a fixture is replaced only after generation succeeds.
