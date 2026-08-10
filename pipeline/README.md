# @riffsheet/pipeline

Performed notes + beats → readable notation. Pure TypeScript, zero runtime dependencies, zero DOM.

```ts
import { buildScore } from '@riffsheet/pipeline';

const { ir, toMusicXML, toMidi, toAlphaTabModelData } = buildScore(
  { notes, beats, downbeats, audioDurationSec },
  { grid: 'auto', fillGaps: true, instrument: 'bass4', tuningMidi: [28, 33, 38, 43], fingeringStyle: 'minMovement' }
);
```

The output contract is [IR.md](IR.md). Start there if you are consuming this package.

---

## The problem this package exists to solve

A performed note stops sounding before the next one starts. The old converter wrote the note at
its *measured* length and turned every leftover gap into a rest, so a funk line of eighths came
out as an unbroken chain of 16th/16th-rest pairs.

Measured on 17 real bass lines with a realistic 70–90% gate:

| | rest density | rests shorter than an eighth |
|---|---|---|
| gaps written as measured (`fillGaps: false`) | **26.8 %** | 426 |
| this pipeline (`fillGaps: true`) | **0.49 %** | **0** |
| human transcribers, for reference (FiloBass, 46,281 glyphs) | 0.6 % | 0 |

The fix is MuseScore's: **rests are never removed, they are prevented.** Off-times are pushed
forward, before any rest object exists, choosing the endpoint that minimises
(notated note glyphs + notated rest glyphs). There is no gap threshold anywhere in this package —
the algorithm answers "is the page more readable with or without this rest?" directly.

---

## The stations

| # | Module | Job |
|---|---|---|
| 1 | `timeSkeleton.ts` | seconds → beats → ticks. Per-beat tempo track, per-bar tick origin, meter, pickup, host grid |
| 1b | `quantize.ts` | per-beat whole-division hypotheses, de-trended, Viterbi; tuplet admission |
| 2a | `meter.ts` | metric division tree; `toDurationList` with the note/rest `tol` asymmetry |
| 2b | `simplify.ts` | **the rest killer**: `lengthenNote` / `minimizeNumberOfRests`, staccato |
| 3 | `key.ts`, `spelling.ts`, `clef.ts` | key signature, enharmonic spelling, accidental display, clef |
| 4 | `chords.ts` | chord grouping (before quantization), overlap clamp |
| 5 | `tab.ts` | legato pairs (before assignment), string/fret DAG |
| 6 | `musicxml.ts`, `midi.ts`, `alphatab.ts` | emitters |
| 7 | `guards.ts` | past-end filter, repeat-loop suspects |
| — | `rational.ts` | exact rational arithmetic; no float ever enters a metric decision |
| — | `buildScore.ts` | the orchestration, and the only place the ordering constraints live |

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

`test/golden/*.ts` hold committed MusicXML for three cases. Regenerate deliberately:

```bash
scripts/update-golden.sh            # all three
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
