# Team C ⇄ Team B integration notes

**Status: integrated.** Team C's `@riffsheet/pipeline` at `../pipeline` is the live source of
notation. Team B's earlier mock IR has been **deleted** rather than left alongside — two competing
IRs in one tree is the kind of thing that rots.

The normative contract is Team C's own `../pipeline/src/types.ts` (input) and `src/ir.ts` (output).
This file records only the **seam**: how webcore talks to it, and the two things that bit us.

---

## The seam

```
src/pipeline/index.ts     the ONLY file that imports @pipeline-impl (Team C's package)
  toBuildSettings()       webcore's UI vocabulary  -> BuildSettings
  buildRiffScore()        BuildInput + settings    -> RiffScore
src/score/fromPipeline.ts AlphaTabScoreData (plain JSON) -> real alphaTab objects
```

Two Vite aliases keep this honest (`vite.config.ts`, mirrored in `tsconfig.json`):

| alias | resolves to | who may import it |
|---|---|---|
| `@pipeline-impl` | `../pipeline/src/index.ts` | **only** `src/pipeline/index.ts` |
| `@pipeline` | `src/pipeline/index.ts` | everything else in webcore |

`RiffScore` is what the rest of webcore holds: `{ data, ir, musicxml(), midi(quantized),
tempoBpm, timeSignature, divisions, durationSec, beatTimesSec, tuningLowToHigh, stringCount,
capo, diagnostics }`.

### Vocabulary translation

webcore's UI deliberately does not speak the pipeline's enum names, so a rename on either side
does not ripple through every settings control:

| UI (`src/app/state.ts`) | pipeline (`BuildSettings`) |
|---|---|
| `instrument: 'bass' \| 'guitar' \| 'auto'` + a `TuningPreset` | `instrument: 'bass4' \| 'bass5' \| 'bass6' \| 'guitar6'` + `tuningMidi` |
| `grid: 'auto' \| 'eighth' \| 'sixteenth' \| 'free'` | `grid: 'auto' \| '1/8' \| '1/16' \| 'free'` |
| `fingering: 'low-positions' \| 'minimize-movement'` | `fingeringStyle: 'low' \| 'minMovement'` |
| `tempoBpm?`, `timeSignature?` | `bpmOverride?`, `timeSigOverride?` |

`'auto'` instrument is resolved on webcore's side from the chosen tuning, because the pipeline's
`instrument` is a single discriminator with no auto value.

---

## The two things that bit us

### 1. String numbering — the doc comment is wrong, and it mirrored the tab

`../pipeline/src/tab.ts` §8.1 is correct and clear: **IR string 1 = the LOWEST (fattest) string**,
deliberately matching alphaTab; only the MusicXML emitter flips to `stringCount + 1 - irString`.

But `../pipeline/src/alphatab.ts` documents the opposite in two places:

```ts
 *   1. `<string>` / `IRNote.string` counts 1 from the HIGHEST pitched string.
...
  /** 1 = highest pitched string. Omitted when the note has no playable position. */
  string?: number;
```

Team B believed the comment, applied an inversion, and produced a tab that was **vertically
mirrored while looking entirely plausible** — exactly the failure mode §8.1 warns about. The Phase 0
spike caught it (`stringFretInversionOk: false`); a human reading the render very likely would not.

**Fixed.** `../pipeline/src/alphatab.ts` now says LOWEST in both places (the file header and the
`AlphaTabNoteData.string` doc comment), matching the code and `tab.ts` §8.1. Verified during
integration; the 201-test pipeline suite still passes.

**What webcore does now** (`src/score/fromPipeline.ts`): it does not trust *either* convention. The
open pitch is `midi - fret - capo`, and exactly one tuning entry has that value, so the alphaTab
string number is derived from the pitch. The declared number is only a fallback, and a
disagreement is recorded in `ScoreIndex.stringWarnings`. This is immune to either side changing
its mind.

### 1b. A note with NO string is not safe to hand a tablature staff (found in integration)

The mirror image of the above, and it cost a whole night's render. When the pipeline cannot place
a note inside the fret limit it emits no `string`/`fret` at all, and webcore used to pass the pitch
through instead. alphaTab's tab renderer indexes its staff-line array with
`tuning.length - note.string`, so a note with no string reads past the end of that array and throws
`undefined is not an object` inside `collectSpaces` — killing the render of the **entire score**,
not just that note. On a real 10 s bass transcription 34 of 63 notes had no position, so the plugin
showed a blank page.

`fromPipeline.ts` now gives every note on a tablature staff a position: nearest string, whatever
fret that takes, uncapped (and negative below the lowest string, which reads as obviously wrong
rather than silently retuning the note). The count lands in `ScoreIndex.pastFretLimit`.

### 2. alphaTab model build order (webcore's own trap, recorded so nobody re-learns it)

`MasterBar.keySignature`'s **setter** propagates the key through
`score.tracks[0].staves[...].bars[i]`. Two orderings throw with unhelpful messages:

- setting it before `score.addMasterBar()` → `cannot read properties of undefined (reading 'tracks')`
- setting it before the track/staff/bars exist → `... (reading 'staves')`

So `buildAlphaTabScore` runs in three phases: master bars (structure only) → tracks/staves/bars →
key signatures.

---

## What webcore feeds in

Both of the input fields the UI needed already existed in Team C's contract, which is why the
capture and bar-1 features needed no negotiation:

- **`startOffsetSec`** — where bar 1 / beat 1 sits. webcore sets it from the auto-trim point (RMS
  gate, −50 dBFS for >300 ms) and the user can override it by dragging the "bar 1" marker on the
  waveform. Releasing the marker re-runs `buildScore` only — never the transcription.
- **`externalGrid`** — from a plugin capture's `captureContext` (Team A). Authoritative when
  present; the UI shows a *"synced to DAW grid"* chip with an override back to detected beats.
  webcore passes `bpm` straight through because Team C's `bpm` is quarter-notes-per-minute, the
  same DAW convention the host reports.
- **`audioDurationSec`** — enables the past-end filter.
- **`notes[].id`** — assigned at detection time (`n0`, `n1`, …) and never re-derived, because the
  undo stack and the selection are keyed on them and the pipeline re-runs on every settings change.

## What webcore takes out

- `toAlphaTabModelData()` → the screen. Team C already does the IR→alphaTab mapping as plain JSON,
  so `src/score/fromPipeline.ts` is a thin constructor rather than a second engraver.
- `toMusicXML()` → the MusicXML export button, unmodified.
- `toMidi(quantized)` → both MIDI export variants. webcore's own MIDI writer was deleted; having
  one writer means the exported `.mid` and the `.musicxml` cannot disagree about the rhythm.
- `ir.tempo.beatTimesSec` → the metronome and the transport's duration.
- `ir.stats` + `diagnostics` → the settings panel's engine row (rest density, meter reason, swing
  verdict, dropped-note counts).

## Not yet used

`ir.suspects.repeatLoops` is surfaced as a diagnostic line only. Team C marks runs that may be
repeats and notes that webcore should resolve them with audio evidence; that is not built yet.
`ir.grandStaff` is read but webcore always renders a single staff.
