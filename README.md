# Riffsheet

Riffsheet turns recordings and music files into an editable score, tablature and piano roll. It
runs as a standalone application or a DAW plugin, keeps all processing local, and exports MIDI,
MusicXML and PDF.

Play something, and you get all three views of it at once — standard notation, note names and
tablature, kept in step with each other and with the recording. Every view is editable, and an
edit in one is an edit in all of them.

## What it opens

- Audio files and audio captured from a DAW track
- MIDI files
- MusicXML/MXL and Guitar Pro files
- Printed score images and PDFs through an optional Audiveris installation
- Native `.riffsheet` documents, or a blank score created in the app

MIDI, MusicXML, Guitar Pro and blank-score editing need no engine at all. Score-image recognition
uses Audiveris, which is not bundled.

## Transcription engines

Audio transcription works out of the box, and three further engines can be added:

| Engine | Setup | Good at |
|---|---|---|
| **Basic Pitch** (Spotify, Apache-2.0) | **Built in** — nothing to install | Fast and general purpose. Always available. |
| Instrument-Agnostic AMT (MIT) | One click, inside the app | Bass especially, with a general checkpoint for the rest |
| Transkun v2 (MIT) | One click, inside the app | Piano, and very good at it |
| MuScriptor (weights CC BY-NC 4.0, gated) | Guided setup you run yourself | Highest quality; knows 35 instrument groups |

Basic Pitch runs in-process over a statically linked ONNX Runtime, so a fresh install transcribes
audio immediately. The one-click engines are downloaded at install time and checked against pinned
hashes. MuScriptor's weights are non-commercial and gated, so Riffsheet will never fetch them for
you — it shows you the steps and leaves the choice with you. No model weights with non-commercial
terms are distributed in this repository or in a release.

Beat and downbeat tracking also runs in-process (*Beat This!*, MIT), so a transcription gets bar
lines and a tempo it can defend rather than an assumed 4/4.

## Platforms and formats

The project builds VST3 and standalone applications on macOS, Windows and Linux, plus Audio Unit
on macOS. macOS is the currently tested runtime. Windows and Linux are compiled in CI, but still
need broader testing in real DAW hosts; see [BUILDING.md](BUILDING.md#what-ci-proves--read-this-before-you-trust-a-green-badge).

## Build

Riffsheet has three parts:

```text
pipeline/   performed notes to readable notation, MIDI and MusicXML
webcore/    TypeScript interface, score editor and playback
shell/      JUCE application/plugin and native integration
```

Build the web interface before the native shell:

```bash
cd pipeline && npm ci && npm test
cd ../webcore && npm ci && npm run build
cd ../shell
cmake -S . -B build -DRIFFSHEET_RELEASE=ON -DRIFFSHEET_REQUIRE_WEBCORE=ON \
  -DJUCE_DIR=/path/to/JUCE
cmake --build build --config Release --parallel
```

JUCE 8.0.13, Node 22 and CMake 3.22 or newer are recommended. Platform dependencies, WebView2
setup, local installation commands, engine setup and release packaging are documented in
[BUILDING.md](BUILDING.md).

## Development

- `cd pipeline && npm test` runs the notation tests.
- `cd webcore && npm run test:regressions` runs focused browser-independent regressions.
- `cd webcore && npm run verify` builds the interface and runs the headless browser harness.
- `.github/workflows/build.yml` compiles the native targets on all three operating systems.

Generated output, dependencies, local engine environments, private working notes and release
packages are intentionally excluded from Git. Required playback samples are versioned with their
license notices; alphaTab supplies the Bravura music font during the reproducible web build.

## License

Unless a directory says otherwise, Riffsheet is licensed under
[AGPL-3.0-only](LICENSE). The notation pipeline is GPL-3.0-only because it contains code derived
from MuseScore 4; GPLv3 section 13 permits it to be combined with the AGPL application. See
[NOTICE.md](NOTICE.md), [pipeline/ATTRIBUTIONS.md](pipeline/ATTRIBUTIONS.md) and
[webcore/CREDITS.md](webcore/CREDITS.md) for complete attribution and bundled-asset licenses.
