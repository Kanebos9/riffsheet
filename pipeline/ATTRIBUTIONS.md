# Attributions

`@riffsheet/pipeline` is **GPL-3.0-only**. This file records, per module, what was ported, what
was written from published numbers, and what licence each source carries.

The distinction that matters: **copying or transliterating a `.cpp` file makes this a derivative
work; re-implementing from published thresholds and observed behaviour does not** — constants and
algorithms are facts, not protected expression. Everything below in the "re-implemented" column
was written fresh in TypeScript from the cited papers and upstream sources. GPL-3.0 is declared
regardless, because the algorithmic debt to MuseScore is real and worth acknowledging plainly.

---

## Per-module record

| Module | Status | Source | Licence |
|---|---|---|---|
| `meter.ts` | **ported** — `metricDivisionsOfBar`, `toDurationList`, the `tol = NOTE ? 1 : 0` asymmetry, the triple-meter and compound-rest split conventions | MuseScore 4 `src/importexport/midi/internal/midiimport/importmidi_meter.cpp` | **GPL-3.0-only** |
| `simplify.ts` | **ported** — `Simplify::lengthenNote`, `minimizeNumberOfRests`, the four-rule `endTime` clamp, `STACCATO_TOL = 0.3`, `quantForLen`, `reduceQuantIfDottedNote` | MuseScore 4 `importmidi_simplify.cpp`, `importmidi_quant.cpp` | **GPL-3.0-only** |
| `spelling.ts` (spelling half) | **ported** — 9-note window, stride 3, 512-combination search, `intervalPenalty[13]`, ×4 key weighting | MuseScore 4 `src/engraving/dom/pitchspelling.cpp`, implementing Cambouropoulos (2001) | **GPL-3.0-only** |
| `spelling.ts` (display half) | **ported** — the `Pitch.updateAccidentalDisplay` decision cascade, `cautionaryPitchClass` / `cautionaryNotImmediateRepeat` defaults | music21 `music21/pitch.py`, `stream/makeNotation.py` | BSD-3-Clause |
| `key.ts` | **profile tables transcribed**, algorithm written | Bellman–Budge weights via music21 `analysis/discrete.py`; bias documentation from Humdrum `keycor`; second estimator after MuseScore `importmidi_key.cpp` (crediting Kilian 2004) | BSD-3-Clause / GPL-3.0-only |
| `clef.ts` | **constants adopted**, DP not ported | MuseScore 4 `importmidi_clef.cpp` (`midPitch = 60`, `dx = 5`) | GPL-3.0-only |
| `quantize.ts` | **ported forward from our own prior work**, restructured | Riffsheet's predecessor app, `src/renderer/src/engine/quantize.ts` — the de-trended per-beat decoder with strict tuplet admission | own code |
| `musicxml.ts` | **ported forward from our own prior work** — XSD element ordering, explicit beam emission, the "no `<note>` without a `<type>`" guard, the two-staff tab layout, backup-by-what-staff-one-advanced | Riffsheet's predecessor app, `src/renderer/src/engine/musicxml.ts` | own code |
| `chords.ts` | written from documented constants | MuseScore `collectChords` "quickthresh" window (1/64 whole, human ×2, quarter-window fudge); the 35 ms floor from the MIR literature (PM2S) | — |
| `tab.ts` | written | Sayegh's optimum-path formulation; Radicioni et al.'s DAG framing; the legato-first ordering is Riffsheet's own | — |
| `timeSkeleton.ts` | written | Beat This! (Foscarin, Schlüter, Widmer, ISMIR 2024) supplies beats/downbeats; the meter gates are from the survey numbers in the research | Beat This! is MIT |
| `midi.ts`, `alphatab.ts`, `guards.ts`, `rational.ts`, `buildScore.ts` | written | `rational.ts` fills the role of MuseScore's `ReducedFraction`; `alphatab.ts` targets alphaTab's model shape without importing it | — |

## Test data

The checked-in notation stress fixtures are original, deterministically generated Riffsheet test
phrases. No third-party corpus note lists, beat grids or audio are redistributed.

Measurements quoted in code comments and the README (rest density and note-value distributions)
come from FiloBass (Riley & Dixon, QMUL, ISMIR 2023), GuitarSet v1.1 (CC BY 4.0) and babySlakh.

## Referenced but not vendored

alphaTab (MPL-2.0) — the model shape is targeted, the library is never imported.
partitura (Apache-2.0), Meredith's ps13 (patent-encumbered — deliberately avoided in favour of
Cambouropoulos), gtrsnipe (PolyForm Noncommercial — read, not used), Melisma (no OSI licence).

## Build-time tools

`scripts/run-tests.sh` and `scripts/update-golden.sh` invoke `esbuild` (MIT) and macOS's
JavaScriptCore. Neither is a runtime dependency and neither ships.
