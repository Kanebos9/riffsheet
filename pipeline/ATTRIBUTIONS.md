# Attributions

`@riffsheet/pipeline` is **GPL-3.0-only**. This file records, per module, what was ported, what
was written from published numbers, and what licence each source carries.

The distinction that matters: **copying or transliterating a `.cpp` file makes this a derivative
work; re-implementing from published thresholds and observed behaviour does not** — constants and
algorithms are facts, not protected expression. Everything below in the "re-implemented" column
was written fresh in TypeScript from the cited papers and upstream sources. GPL-3.0 is declared
regardless, because the algorithmic debt to MuseScore is real and worth acknowledging plainly.

The full GPL-3.0 text this package is under is in [`LICENSE`](LICENSE), beside this file
(`PIPELINE-LICENSE` in a release package, where `LICENSE` is the AGPL text). The rest
of Riffsheet is AGPL-3.0-only; GPLv3 section 13 is what lets the two be combined, and `pipeline/`
stays GPL-3.0-only when distributed on its own (see the root `NOTICE.md`).

---

## Per-module record

| Module | Status | Source | Licence |
|---|---|---|---|
| `meter.ts` | **ported** — `metricDivisionsOfBar`, `toDurationList`, the `tol = NOTE ? 1 : 0` asymmetry, the compound-rest split convention. The triple-meter 2/3-bar split is applied to RESTS only (Gould p.161); applying it to notes printed a 3/4 half note as two tied quarters | MuseScore 4 `src/importexport/midi/internal/midiimport/importmidi_meter.cpp` | **GPL-3.0-only** |
| `simplify.ts` | **the port was DELETED** — `Simplify::lengthenNote`, `minimizeNumberOfRests`, the four-rule `endTime` clamp, `STACCATO_TOL`, `quantForLen` and `reduceQuantIfDottedNote` are all gone (see the module header for why). What remains — a tick-domain overlap clamp and a leading-onset snap — is Riffsheet's own. The row is kept because the deleted code shaped this package's design and GPL-3.0 is declared regardless | MuseScore 4 `importmidi_simplify.cpp`, `importmidi_quant.cpp` | **GPL-3.0-only** |
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

## Licence texts kept in the tree

- **GPL-3.0-only** — [`LICENSE`](LICENSE), beside this file (`PIPELINE-LICENSE` in a release
  package): the licence this package is under, the official Free Software Foundation text from
  <https://www.gnu.org/licenses/gpl-3.0.txt>.
- **music21, BSD-3-Clause** — `third-party/music21/LICENSE`, copied verbatim from
  <https://raw.githubusercontent.com/cuthbertLab/music21/v10.5.0/LICENSE> (identical to `master` at
  the time of copying). Copyright © 2006-2026 Michael Scott Asato Cuthbert. BSD-3 asks that the
  copyright notice, the three conditions and the disclaimer be retained by anything carrying the
  code forward, which the `spelling.ts` display half and the `key.ts` Bellman–Budge weights above
  do; that file is the retained copy.

## Referenced but not vendored

alphaTab (MPL-2.0) — the model shape is targeted, the library is never imported.
partitura (Apache-2.0), Meredith's ps13 (patent-encumbered — deliberately avoided in favour of
Cambouropoulos), gtrsnipe (PolyForm Noncommercial — read, not used), Melisma (no OSI licence).

## Build-time tools

`scripts/run-tests.sh` and `scripts/update-golden.sh` invoke `esbuild` (MIT) and macOS's
JavaScriptCore. Neither is a runtime dependency and neither ships.
