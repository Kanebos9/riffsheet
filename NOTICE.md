# Riffsheet licensing notice

Copyright © 2026 Oğuzhan Yazıcı.

Unless a file or directory says otherwise, Riffsheet is licensed under the
GNU Affero General Public License, version 3 only (`AGPL-3.0-only`). The full
text is in `LICENSE`.

The `pipeline/` package is separately marked `GPL-3.0-only` because it contains
code derived from MuseScore 4. GPLv3 section 13 permits that package to be
combined with the AGPLv3 application; the pipeline remains GPLv3-only when
distributed on its own. See `pipeline/ATTRIBUTIONS.md` (`PIPELINE-ATTRIBUTIONS.md`
in a release package).

Third-party libraries, fonts, and sample assets keep their own licenses. See
`webcore/CREDITS.md` (`CREDITS.md` in a release package) and the license files
shipped beside those assets.

The embedded web bundle includes unmodified alphaTab under MPL-2.0. Its complete licence and
upstream notice header are not vendored in this source tree: the web build copies them out of the
pinned dependency into the bundle, at `dist/third-party/alphatab/LICENSE` and
`dist/third-party/alphatab/LICENSE.header` (see `webcore/vite.config.ts`). Bravura's OFL, FAQ and
FONTLOG are packaged beside the font at `dist/font/`.

The native shell is built with JUCE 8.0.13 under JUCE's AGPLv3 option.
JUCE is copyright Raw Material Software Limited and contributors; it is fetched
from its upstream repository during CI rather than vendored here.

Riffsheet's built-in transcription engine is Spotify's Basic Pitch, used under
Apache-2.0 and copyright 2022 Spotify AB. The model file `nmp.onnx` is
redistributed unmodified from `spotify/basic-pitch` v0.4.0 and is compiled into
the application; its licence text ships at `third-party/basic-pitch/LICENSE`. The
note-creation code in `shell/Source/engines/basicpitch/BasicPitchNotes.cpp` is
adapted from NeuralNote's `Notes.cpp` (<https://github.com/DamRsn/NeuralNote>),
also Apache-2.0 and copyright 2024 Damien Ronssin, with modifications: pitch-bend
extraction is removed, the frequency bounds and the onset peak test follow
spotify/basic-pitch's `note_creation.py` rather than NeuralNote's relaxation of
it, and the cached-state optimisation is dropped. Its licence text ships at
`third-party/neuralnote/LICENSE`.

Riffsheet's beat tracker is *Beat This!* by Francesco Foscarin, Jan Schlüter and
Gerhard Widmer at the Institute of Computational Perception, JKU Linz, used under
the MIT licence and copyright © 2024 Institute of Computational Perception, JKU
Linz, Austria. The project states the licence of the weights as well as the code:
*"The code and the published model weights are released under the MIT license."*
(<https://github.com/CPJKU/beat_this>). The bundled file
`shell/Resources/models/beat-this/small0.onnx` is the `small0` checkpoint of
`beat_this` 1.1.0 — its 2.1-million-parameter model, not the 20.3-million-parameter
`final0`, because three products × 77 MB of `final0` weights would exceed
Riffsheet's release size budget twice over. There is no official ONNX release, so
Riffsheet exported it with `torch.onnx.export`; the invocation is in `BUILDING.md`
section 5 and the digests of both the checkpoint and the export are in
`shell/Resources/models/MANIFEST.sha256`. On GTZAN the small model costs 0.3 points
of beat F-measure and 1.1 points of downbeat F-measure against the full one
(88.8 vs 89.1, and 77.2 vs 78.3; Foscarin et al., *"Beat This! Accurate beat
tracking without DBN postprocessing"*, ISMIR 2024, Table 2).

`shell/Source/engines/beats/BeatDbn.cpp` is Riffsheet's own implementation of the
bar-pointer dynamic Bayesian network of Krebs, Böck and Widmer (*"An Efficient
State Space Model for Joint Tempo and Meter Tracking"*, ISMIR 2015) as applied to
neural activations by Böck, Krebs and Widmer (ISMIR 2016). No code was copied from
madmom or from `mosynthkey/beat_this_cpp`; madmom was used only to produce the
reference outputs in `shell/test/golden/beats-*.json`, which the implementation is
tested against, and is not redistributed. For the record, because Riffsheet's own
design notes state it the other way round: madmom's `LICENSE` puts its *source*
files under BSD 2-Clause and only its `.npy/.npz/.h5/.hdf5/.pkl/.mat` model and
data files under CC BY-NC-SA 4.0, so vendoring its DBN source would have been
permitted — it was not done because a self-contained implementation removes a
dependency rather than adding one.

The MIT licence text for *Beat This!* ships at `third-party/beat-this/LICENSE`
and is reproduced here in full as well, so that this notice is itself the copy
the licence requires:

> MIT License
>
> Copyright (c) 2024 Institute of Computational Perception, JKU Linz, Austria
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Inference uses Microsoft's ONNX Runtime, statically linked, under the MIT
licence; its text ships at `third-party/onnxruntime/LICENSE`. ONNX Runtime links
its own third-party components into that static library — among them ONNX,
Abseil, Protocol Buffers, RE2, FlatBuffers, cpuinfo, Eigen and KleidiAI, under
Apache-2.0, BSD and MPL-2.0 terms. Their complete notices ship unmodified at
`third-party/onnxruntime/THIRD-PARTY-NOTICES.txt`.

## Where the test fixtures came from

Three binary fixtures are committed under `shell/test/`. None of them is third-party data: all
three were produced by this project, on this project's own machine, and they are recorded here so
that no reader has to wonder whose bytes they are.

`shell/test/BasicPitchFixture.wav` is **synthesised, not recorded** — a 4.3-second synthetic bass
riff of five notes, written out by the project's own `make_golden.py` generator script (named in
`shell/test/BasicPitchTests.cpp`). No recording of anybody's playing is committed anywhere in this
repository.

`shell/test/BasicPitchGolden.bin` and `shell/test/BasicPitchGolden.json` are **captured from this
project's own runs**. They hold the posteriorgrams and the notes that spotify/basic-pitch's own
reference code produced from that synthetic wav — `nmp.onnx` through onnxruntime's Python
bindings, then upstream's `note_creation.py` — when the same generator script ran it here. They
are the numeric output of a local run over Riffsheet's own audio, not files copied out of the
upstream repository, and they exist so that the C++ can be held to the reference implementation
rather than only to itself.

`shell/test/SidecarMidiFixture.mid` was **written by this project's own tooling**: it is the MIDI
file that a local Instrument-Agnostic AMT run (`best_model_bass_v2.pth`) left behind when driven
by Riffsheet's `shell/Resources/engines/amt_sidecar.py`, over a local take. It is committed so the
sidecar reader is tested against what an engine actually writes rather than only against what JUCE
writes. It carries note events, not audio.

The beat goldens `shell/test/golden/beats-*.json` are covered above: reference outputs produced
locally with madmom, which is itself not redistributed.

## Engines Riffsheet can install for you

Two engines are offered as a one-click install. **Nothing about them is in a
Riffsheet release**: the binaries contain only the sidecar script and the
hash-pinned package lists the installer reads (`shell/Resources/engines/`, about
20 KB of text in total). Their code, weights and Python packages are downloaded
on the user's own machine, into `<Application Support>/Riffsheet/engines/`, when
the user asks for them — which is why a one-click offer is limited to engines
whose licences permit that without dragging a term into the user's own work.

*Instrument-Agnostic AMT* by anime-song (<https://github.com/anime-song/instrument-agnostic-amt>)
is MIT, code and weights alike, copyright © 2026 anime-song. Riffsheet installs
the source tree at commit `2964b39af3d122ab087010e562ead53005c57e5d` and the
`best_model_bass_v2.pth` and `best_model.pth` checkpoints from
<https://huggingface.co/anime-song/instrument_agnostic_amt> at revision
`2be1b9eb21c9b61163c773bd8361e299c60cfcad`. Every one of those files is pinned by
sha256 in `shell/Source/engines/EngineCatalog.cpp` and
`shell/Source/engines/EngineInstaller.cpp` and is verified after download.
`shell/Resources/engines/amt_sidecar.py` is Riffsheet's own code; it calls
upstream's `infer.py` entry point and reimplements none of it.

*Transkun* by Yujia Yan (<https://pypi.org/project/transkun/>) is MIT, and its
weights ship inside its own wheel. Riffsheet installs `transkun==2.0.1` and its
dependencies from PyPI with pip, against
`shell/Resources/engines/transkun-requirements-<platform>.txt` (only `macos-arm64`
is committed today), which pins every package and every artefact's sha256 and is
enforced with `pip --require-hashes`.

*SOME* (<https://github.com/openvpi/SOME>) was evaluated and works, and is
deliberately **not** offered. Its code is MIT but its published model weights are
CC BY-NC-SA per its own release notes, and Riffsheet will not download
non-commercial weights onto a user's machine on their behalf as part of a tool
they may be using for paid work. There is no code path to it: it is not a row in
the engine table.

*MuScriptor* is a row in the engine table with a **guided** setup only — never a
download and never a bundle. Riffsheet's compiled-in manifest records its weights
as **CC BY-NC 4.0, licence-gated**, and its code licence as undetermined ("see
upstream"); see `shell/Source/engines/EngineCatalog.cpp`. The user installs it
themselves from PyPI, and that separate non-commercial license then applies to
them. No MuScriptor weights or code are part of this repository or of a release
package.

Audiveris is an optional, separately installed AGPL application. It is not
included in the Riffsheet source tree or release packages.

The complete corresponding source for each official binary release is available from the
matching release tag at <https://github.com/Kanebos9/riffsheet>. GitHub's release page provides
the source archive alongside the platform binaries.
