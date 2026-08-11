# @riffsheet/pipeline

Performed notes + beats → readable notation. Pure TypeScript, zero runtime dependencies, zero DOM.

```ts
import { buildScore } from '@riffsheet/pipeline';

const { ir, toMusicXML, toMidi, toAlphaTabModelData } = buildScore(
  { notes, beats, downbeats, audioDurationSec },
  { grid: 'auto', instrument: 'bass4', tuningMidi: [28, 33, 38, 43], fingeringStyle: 'minMovement' }
);
```

Several instruments print as one document — a guitar part over a bass part — through
`buildMultiPartScore`, which is N of the above sharing one clock and one key, merged into one
MusicXML document, one N-track alphaTab hand-off and one format-1 MIDI file:

```ts
import { buildMultiPartScore } from '@riffsheet/pipeline';

const score = buildMultiPartScore(
  [
    { name: 'Guitar', role: 'live', instrument: 'guitar6', notes: takeNotes },
    { name: 'Bass', role: 'imported', notes: importedNotes, nudgeSec: 0 }
  ],
  { beats, downbeats, audioDurationSec },
  { grid: 'auto', instrument: 'guitar6', tuningMidi: [40, 45, 50, 55, 59, 64], fingeringStyle: 'low' }
);
```

A one-part score comes out of it byte-for-byte identical to `buildScore`, so a caller can route
every build through it and never branch on part count.

The output contract is [IR.md](IR.md). Start there if you are consuming this package.

---

## What this package writes, and what it refuses to write

A performed note stops sounding before the next one starts. **It is written at the length it was
played.** The silence after it is a rest, including when that rest is short.

This package used to do the opposite, and the history is worth keeping because the numbers were
good. It carried a port of MuseScore's `Simplify::lengthenNote` / `minimizeNumberOfRests` — "rests
are never removed, they are prevented" — which pushed every off-time forward to the endpoint
minimising (note glyphs + rest glyphs). On 17 real bass lines at a 70–90% gate that took rest
density from 26.8% to 0.49%, against 0.6% for human transcribers on FiloBass.

It was deleted anyway, for two reasons the measurement could not see:

- **the staccato dots were lies.** A note earned one precisely *because* its printed value had
  been inflated past what was played. The page said "hold this, but short" about material that
  was simply short.
- **the sustain was invented.** Each note grew toward the next onset, so a staccato line came
  back reading as a legato one — polyphony nobody played, added by the engraver.

A transcription is a record of a performance. Rest density is now a *description* of the take
rather than a target: on that same corpus it reads ~19%, and the phrases have not changed —
only what we claim about them. `fillGaps` is still accepted in `BuildSettings` so existing callers
compile; nothing reads it, and passing `true` does not bring the pass back.

What the package still refuses to write: a duration that crosses a barline or a tuplet edge
without a tie, a rest that merges across a metric level, a glyph with no printable `<type>`, or a
note value that hides the middle of the bar. Those are engraving rules, and they are enforced in
`meter.ts` where they belong.

---

## The stations

| # | Module | Job |
|---|---|---|
| 1 | `timeSkeleton.ts` | seconds → beats → ticks. Per-beat tempo track, per-bar tick origin, meter, pickup, host grid |
| 1b | `quantize.ts` | per-beat whole-division hypotheses, de-trended, Viterbi; tuplet admission |
| 2a | `meter.ts` | metric division tree; `toDurationList` with the note/rest `tol` asymmetry |
| 2b | `simplify.ts` | overlap clamp and leading-onset snap. Was the rest killer; see above |
| 3 | `key.ts`, `spelling.ts`, `clef.ts` | key signature, enharmonic spelling, accidental display, clef |
| 4 | `chords.ts` | chord grouping (before quantization), overlap clamp |
| 5 | `tab.ts` | legato pairs (before assignment), string/fret DAG |
| 5b | `beaming.ts` | beam grouping, tuplet brackets, and the per-staff projection both are recomputed over |
| 6 | `musicxml.ts`, `midi.ts`, `alphatab.ts` | emitters |
| 7 | `guards.ts` | past-end filter, repeat-loop suspects |
| — | `rational.ts` | exact rational arithmetic; no float ever enters a metric decision |
| — | `buildScore.ts` | the orchestration, and the only place the ordering constraints live |
| — | `multipart.ts` | N parts, one clock, one key; merged at the emitters, not in the IR |

Six orderings are load-bearing and each one is a bug if violated. They are enforced in
`buildScore.ts` and listed in its header comment.

---

## Development

```bash
npm install
npm test            # vitest
npm run typecheck
```

The checked-in stress phrases are original deterministic test data. Benchmark corpus measurements
are recorded as aggregate results only; no third-party corpus events or audio are redistributed.

### Running the tests without Node.js

This project was built on a machine with no Node installed. `scripts/run-tests.sh` bundles the
**same** `test/*.test.ts` files with esbuild (a native binary) and runs them under JavaScriptCore,
which ships with macOS, aliasing the `vitest` import to a small shim in `scripts/jsc-shim.ts`.
The test files are not duplicated or rewritten.

```bash
scripts/run-tests.sh            # all
scripts/run-tests.sh restDensity   # one file
```

Override `ESBUILD=` and `JSC=` if the binaries live elsewhere.

### Golden files

`test/golden/*.ts` hold committed MusicXML for three single-part cases, plus a two-part
guitar-over-bass case pinned on BOTH emitters — the MusicXML document and the alphaTab hand-off,
so neither can drift from the other. Regenerate deliberately:

```bash
scripts/update-golden.sh            # all five
scripts/update-golden.sh pickup     # one
```

A diff there is a real behaviour change and wants review — the screen path no longer travels
through MusicXML, so these fixtures are the only thing dogfooding the exporter.

---

## Licence

**GPL-3.0-only.** Two modules re-implement MuseScore 4 algorithms from their documented behaviour
and constants (`meter.ts`, `simplify.ts`); MuseScore 4 is GPL-3.0-only and the lineage is kept
clean by porting from that tree rather than MuseScore 3, whose `importmidi` is GPL-2.0-**only**
and therefore incompatible. See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for the full per-file record.
