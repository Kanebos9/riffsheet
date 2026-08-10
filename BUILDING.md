# Building Riffsheet

Riffsheet is two builds stacked on each other. The web app in `webcore/` is built first with
Node, and the native shell in `shell/` then **embeds that build inside the binary** and compiles
into a VST3, a Standalone app, and (macOS only) an AU.

The order is not optional. If `webcore/dist` is missing when you configure the shell, CMake
falls back to a placeholder test panel and you get a plugin with no app in it.

---

## 1. What you need on every platform

| | |
|---|---|
| **JUCE** | **8.0.1 or newer; 8.0.13 is recommended and used in CI.** Older JUCE has no WebView native-integration API, and the entire editor is a WebView. |
| **CMake** | 3.22+ to build Riffsheet. **3.28+ to build ONNX Runtime**, which is its own project with its own floor. |
| **Node** | 22 (Vite 7 needs 20.19+/22.12+). |
| **ONNX Runtime** | **1.28.0, built from source, static.** The built-in transcription engine is an ONNX graph and JUCE has no inference of any kind. Section 4a below is the whole story; it is a one-time cost of about half an hour per platform. |

**JUCE lookup order:** `-DJUCE_DIR=…`, then `$JUCE_DIR`, then `~/JUCE`,
then `%USERPROFILE%\JUCE`. If none of those exist the configure stops and tells you so.

**ONNX Runtime lookup order:** `-DRIFFSHEET_ORT_DIR=…`, then `$RIFFSHEET_ORT_DIR`, then `$ORT_DIR`.
If none of those exist the configure stops and prints the build command.

---

## 2. Step one, on all three platforms: the web app

```bash
cd webcore
npm ci
npm run build        # tsc --noEmit, then Vite -> webcore/dist
```

Vite produces one classic-script application bundle and copies the required Bravura fonts and
licence from the pinned alphaTab dependency. The main bundle is an IIFE because JUCE's macOS
WebView does not load an ES-module entry point over its custom URL scheme.

`npm run build` also typechecks `../pipeline/src`, which webcore consumes as TypeScript source
rather than as a published package — so you need the whole repo checked out, not just `webcore/`.

`webcore/dist` is gitignored. Every machine, and every CI run, builds it.

---

## 2a. Step one and a half: ONNX Runtime

**Do this once per machine.** Riffsheet's built-in engine (Spotify's Basic Pitch) is an ONNX
graph, JUCE has no inference of any kind, and the runtime is linked **statically** — a `.dylib`
or `.so` beside a plugin bundle is a loader-path problem in every DAW and a code-signing problem
on macOS.

**Nothing Microsoft publishes is usable, and that is why this section exists.** The macOS and
Linux releases are dynamic-only. The Windows releases are `/MD`, and `shell/CMakeLists.txt` links
the static CRT (`MultiThreaded`) so users do not need the VC++ Redistributable — `/MD` objects
will not link into a `/MT` binary. So it gets built from source.

It takes about 25 minutes on an M1 with 8 GB and roughly 8 GB of disk while it works. The result
lives **outside this repository** and is never committed.

```bash
export ORT=~/riffsheet-ort
git clone --depth 1 --branch v1.28.0 --recurse-submodules --shallow-submodules \
    https://github.com/microsoft/onnxruntime "$ORT/src"

python3 "$ORT/src/tools/ci_build/build.py" \
    --build_dir "$ORT/build/macos-arm64" --config Release \
    --parallel 6 --skip_tests --compile_no_warning_as_error \
    --cmake_generator Ninja \
    --osx_arch arm64 --apple_deploy_target 11.0 \
    --disable_ml_ops \
    --cmake_extra_defines onnxruntime_BUILD_UNIT_TESTS=OFF \
                          CMAKE_IGNORE_PREFIX_PATH=/opt/homebrew \
                          CMAKE_IGNORE_PATH=/opt/homebrew

# re2 has to be asked for by name: ONNX Runtime only reaches it through the
# shared-library target, which a static build never builds. Without this the
# Riffsheet link dies on undefined re2:: symbols from RegexFullMatch and the
# contrib Tokenizer, with nothing in the message about re2 being missing.
cmake --build "$ORT/build/macos-arm64/Release" --target re2

# Stage it: one merged archive plus the public headers.
mkdir -p "$ORT/dist/macos-arm64/lib" "$ORT/dist/macos-arm64/include"
libtool -static -no_warning_for_no_symbols -o "$ORT/dist/macos-arm64/lib/libonnxruntime.a" \
    $(find "$ORT/build/macos-arm64/Release" -name '*.a' -not -path '*CMakeFiles*' | sort)
cp "$ORT/src/include/onnxruntime/core/session/"*.h "$ORT/dist/macos-arm64/include/"
cp "$ORT/src/include/onnxruntime/core/session/"*.inc "$ORT/dist/macos-arm64/include/" 2>/dev/null || true

export RIFFSHEET_ORT_DIR="$ORT/dist/macos-arm64"
```

Three things in there are load-bearing and each cost a rebuild to discover:

* **`CMAKE_IGNORE_PREFIX_PATH=/opt/homebrew`** — without it CMake finds Homebrew's protobuf and
  ONNX Runtime links `libprotobuf-lite.dylib` out of `/opt/homebrew`. The result is a "static"
  runtime that runs only on the machine that built it. With it, ONNX Runtime fetches and builds
  protobuf itself. Not needed on Windows or Linux runners; harmless there.
* **`--target re2`**, as above.
* **The merged archive is a convenience, not a requirement.** `shell/cmake/OnnxRuntime.cmake`
  globs `lib/*.a` (`lib/*.lib` on Windows) and links whatever it finds — on Linux inside a
  `--start-group`, because GNU ld resolves archives in command order and ONNX Runtime's archives
  reference each other in both directions. Copying all ~82 archives across works just as well.

### Other platforms and architectures

| Target | The change to the invocation above |
|---|---|
| **macOS universal** (what CI builds) | ONNX Runtime cannot produce a universal static library in one pass. Build `--osx_arch arm64` and `--osx_arch x86_64` into separate directories, merge each with `libtool`, then `lipo -create <arm64>/libonnxruntime.a <x86_64>/libonnxruntime.a -output <universal>/lib/libonnxruntime.a`. Configuring universal against a single-arch runtime is refused by name, before the link. |
| **Windows** | Add `--enable_msvc_static_runtime` (this is the `/MT` requirement above), drop the two macOS-only flags, and copy `lib/*.lib` instead of merging. |
| **Linux** | Drop the macOS-only flags. Everything else is identical; this is the easy one. |

### If the size budget is ever blown

`shell/cmake/ReleaseAudit.cmake` fails the release when a product zip exceeds 35 MB or the bundle
exceeds 100 MB. The levers, cheapest first, all of them ONNX Runtime build options:

1. `--include_ops_by_config <config>` plus `--enable_reduced_operator_type_support`, where the
   config is generated by `python3 tools/python/create_reduced_build_config.py -f ONNX <models>`
   over **every model this build ships**, not just one. Generating it from `nmp.onnx` alone would
   silently break wave 4's beat-tracking model, which needs its own kernels.
2. `--disable_rtti`.
3. `--minimal_build`, which is the smallest of all — but a minimal build cannot load `.onnx` at
   all, only ORT-format `.ort`, so `nmp.onnx` would have to be converted and would no longer be
   the byte-for-byte upstream file that `NOTICE.md` says it is. Weigh that before reaching for it.

None of these is applied today because they are not needed: the measured numbers are in section 5.

---

## 3. Step two: the native shell

### macOS

The supported path is the script, because it also handles the two macOS gotchas below:

```bash
cd shell
export RIFFSHEET_ORT_DIR=~/riffsheet-ort/dist/macos-arm64   # section 2a
./scripts/build.sh --release              # current architecture
./scripts/build.sh --release --universal  # arm64 + x86_64 distribution build
```

`scripts/build.sh` passes no ONNX Runtime path of its own, so the environment variable is how it
finds one. Without it the configure stops and prints the build command from section 2a.

That installs to `~/Library/Audio/Plug-Ins/VST3/Riffsheet.vst3`,
`~/Library/Audio/Plug-Ins/Components/Riffsheet.component` and `/Applications/Riffsheet.app`,
after every target has built and passed signing verification. It then removes older copies so two
bundles with one plugin UID cannot confuse a DAW scanner. `scripts/build.sh` is the authority on
its own flags.

By hand, if you want the raw CMake:

```bash
cmake -S shell -B shell/build -G Xcode \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DJUCE_DIR=/path/to/JUCE \
  -DRIFFSHEET_RELEASE=ON \
  -DRIFFSHEET_REQUIRE_WEBCORE=ON
cmake --build shell/build --config Release --parallel
```

Two macOS things that are already solved and should not be "fixed" again:

- **Code signing is disabled in CMake on purpose.** Cloud-synchronised worktrees can add Finder
  metadata that makes Xcode's CodeSign phase fail. `scripts/build.sh` strips extended attributes
  and ad-hoc signs each finished bundle afterwards, which is sufficient for a local build. Public
  distribution still needs Developer ID signing and notarisation if Gatekeeper-free installation
  is required.
- **The standalone ships with the microphone input turned off.** CoreAudio *blocks* while the
  macOS permission prompt is unanswered, and if the prompt cannot be shown the app looks hung with
  no window. `~/Library/Application Support/Riffsheet.settings` therefore carries
  `audioDeviceInChans="0"`. To record from an interface: Options → Audio/MIDI Settings, pick an
  input, answer the prompt.

### Windows (x64)

Windows needs the **WebView2 SDK** before CMake will configure, because the whole UI is a WebView
and `NEEDS_WEBVIEW2` makes JUCE run `find_package(WebView2 REQUIRED)`. There is no system-wide
SDK to fall back on — JUCE only looks in a local NuGet package folder.

```powershell
nuget install Microsoft.Web.WebView2 -Version 1.0.3485.44 -OutputDirectory C:\wv2
```

or, the PowerShell route JUCE documents:

```powershell
Register-PackageSource -provider NuGet -name nugetRepository -location https://www.nuget.org/api/v2
Install-Package Microsoft.Web.WebView2 -Scope CurrentUser -RequiredVersion 1.0.3485.44 -Source nugetRepository
```

Then:

```powershell
cmake -S shell -B shell/build -A x64 `
      -DJUCE_WEBVIEW2_PACKAGE_LOCATION=C:\wv2 `
      -DRIFFSHEET_RELEASE=ON
cmake --build shell/build --config Release --parallel
```

`JUCE_WEBVIEW2_PACKAGE_LOCATION` is the directory *containing* the package folder, not the package
folder itself. Omit it entirely if you used `Install-Package`, which puts it where JUCE looks by
default.

The MSVC runtime is linked **statically** (`MultiThreaded`), so users do not need the VC++
Redistributable. That is set in `shell/CMakeLists.txt`.

Formats built: **VST3 and Standalone.** No AU — AU is a macOS format.

Artefacts land in `shell\build\Riffsheet_artefacts\Release\{VST3,Standalone}`.

### Linux (x64)

```bash
sudo apt-get install -y libasound2-dev libjack-jackd2-dev \
  libfreetype6-dev libfontconfig1-dev libgl1-mesa-dev libx11-dev \
  libxext-dev libxrandr-dev libxinerama-dev libxcursor-dev \
  libcurl4-openssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev ninja-build lsof

cmake -S shell -B shell/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DRIFFSHEET_RELEASE=ON
cmake --build shell/build --parallel
```

`libwebkit2gtk-4.1-dev` is the one that matters. JUCE's Linux `WebBrowserComponent` is WebKitGTK,
and Riffsheet's editor **is** the web view — without it there is no UI at all, not a degraded one.
`lsof` is also a runtime dependency of the current orphan-MuScriptor cleanup path; without it the
app still opens, but cannot discover and reap a transcription server left by a crashed process.

The release zip does not bundle WebKitGTK. On an Ubuntu machine that is only *running* Riffsheet
rather than building it, install `libwebkit2gtk-4.1-0` and `lsof`. JUCE 8's Linux browser is
X11-based and explicitly selects GTK's X11 backend, so a Wayland desktop also needs XWayland.

Formats built: **VST3 and Standalone.**

---

## 4. Optional PDF/image score import

MusicXML, compressed MXL and Guitar Pro files need no extra application. Printed score PDFs and
images use **Audiveris** as a separate local recognizer, then feed its MXL output through the same
Riffsheet importer. Audiveris's desktop installers include their Java runtime.

Install Audiveris normally and Riffsheet checks the standard locations on macOS, Windows and
Linux, followed by `PATH`. A portable/custom install can be selected explicitly:

```bash
export RIFFSHEET_AUDIVERIS="/path/to/Audiveris"
```

The release zip does not bundle Audiveris. Without it, audio/MIDI/MusicXML/Guitar Pro continue to
work and PDF/image import reports the missing dependency plainly. Recognition is for clean printed
standard notation; handwriting and tab-only pages are not supported.

---

## 4a. One-click engines: the installer, the venvs, and how to add one

Riffsheet ships one engine (Basic Pitch, compiled in) and can *install* two more on the user's own
machine: **Instrument-Agnostic AMT** (`bass-v2`) and **Transkun v2** (`transkun`). Nothing about
either is in a release. The binaries carry only `shell/Resources/engines/` — one sidecar script and
the pip lock files, about 20 KB of text — and everything else is downloaded when the user asks for
it, into `<Application Support>/Riffsheet/engines/`.

### What the installer does, in order

1. **Checks.** Finds a Python satisfying the manifest's requirement (`>=3.10,<3.13` for both), and
   requires free space of three times the larger of "bytes to download" and "installed size".
   **Riffsheet never installs Python.** If none fits it says which interpreters it found and what
   versions they were, and the card falls back to guide steps.
2. **Downloads** every pinned asset over https, from a compiled-in host allowlist that is re-checked
   after **every redirect** (`EngineInstall::HostPolicy`), resuming a previous attempt with a
   `Range` request where the server supports it, and verifies each finished file against the
   sha256 compiled into `EngineCatalog.cpp` / `EngineInstaller.cpp`. A wrong digest deletes the
   file rather than leaving a prefix something could resume onto.
3. **Unpacks** into `<appSupport>/engines/<id>.incoming/`.
4. **Builds the virtual environment** there and runs
   `pip install --require-hashes -r <id>-requirements-<platform>.txt`.
5. **Probes** — a real run of the engine on a one-second tone generated in C++. "The files are on
   disk" is a claim about the disk; the user's question is whether it works on this machine.
6. **Commits** by moving the finished tree onto `<appSupport>/engines/<id>/`.

A crash or cancel at any point leaves the previous install or nothing. Verified partial downloads
stay under `<appSupport>/engines/.downloads/<id>/` so a retry after a dropped connection is cheap;
`uninstallEngine` removes those too and reports what it freed.

### The pip lock files, and why they are per platform

`shell/Resources/engines/<id>-requirements-<platform>.txt` pins **every** package — including every
transitive one — to a version *and* to the sha256 of the exact artefact, and pip is run with
`--require-hashes`. A bare `pip install transkun` next to a sha256-pinned download would be an
unverified network install, so it is not what happens.

A wheel hash is per platform, so the lock file is too. **Only `macos-arm64` is committed today.**
On any other platform `EngineInstall::planFor()` refuses with a sentence saying so and the card
becomes a guide — it does not guess. To add one, on that platform:

```bash
python3 -m venv /tmp/lockenv && /tmp/lockenv/bin/pip install -U pip
/tmp/lockenv/bin/pip install --dry-run --report r.json \
    "torch==2.13.0" "torchaudio==2.11.0" "einops==0.8.2" "numpy==2.2.6" \
    "pretty_midi==0.2.11.post0" "scipy==1.15.3" "soundfile==0.14.0" "tqdm==4.70.0"
# then one "name==version \ --hash=sha256:..." per entry of r.json's install list
```

and commit it as `bass-v2-requirements-<platform>.txt`. The top-level list above is derived from the
imports on the engine's inference path, not from its own `requirements.txt`: upstream pins
`torch==2.7.0+cu128` from the CUDA index, which has no macOS wheel at all. Stock PyPI torch 2.13.0
runs the model.

`file(GLOB ...)` in `shell/CMakeLists.txt` picks up anything in `Resources/engines/`, so a new lock
file needs no build change. Note that `juce_add_binary_data` mangles a filename into a C++
identifier by turning dots into underscores and **deleting** hyphens, so the installer looks
resources up through `BinaryData::originalFilenames` rather than guessing the symbol.

### Adding a one-click engine

Four things, and no C++ beyond them: a row in `EngineCatalog.cpp` (with a real sha256 — the
`static_assert` refuses to compile an unpinned one), a branch in `EngineInstall::planFor()` for any
extra assets, a lock file, and — for an engine whose command line is not already what Riffsheet
needs — a sidecar `.py` in `Resources/engines/`. `SidecarAdapter` is manifest-driven and is never
edited to add an engine.

The adapter reads notes back from a JSON object at `{json}` or on stdout, and falls back to reading
the MIDI file at `{midi}` with `SidecarMidi` (which is `juce::MidiFile` plus the decisions JUCE does
not make). `transkun` takes the MIDI route; `bass-v2` takes the JSON route through its sidecar, and
its MIDI file is still returned to the page as `midiBase64`.

### Linux HTTPS

`JUCE_USE_CURL=1` **on Linux only** (`shell/CMakeLists.txt`). JUCE's Linux `WebInputStream` without
curl is a raw POSIX socket with no TLS at all, so an `https://` download there does not fail
loudly — it fails obscurely, and the installer is entirely https downloads. macOS uses
`NSURLSession` and Windows uses WinHTTP, and both keep `JUCE_USE_CURL=0` so nothing about the
existing localhost HTTP client changes. `libcurl4-openssl-dev` is in the Linux dependency list
above and in the CI's apt line for exactly this.

### Measured on this machine (M-series Mac, 8 GB, warm pip cache)

| | `bass-v2` | `transkun` |
|---|---|---|
| Downloaded | 108.5 MB (source zip + two checkpoints) | 0 — the weights are in the wheel |
| Installed size | ~1.0 GB | ~1.0 GB |
| Peak RSS during a job | ~1.7 GB | ~1.4 GB |

Both are `exclusiveMachineWide`, so they queue on the same machine-wide lock as MuScriptor. That is
not a guess about their weight; it is those numbers.

---

## 5. Useful CMake options

| Option | What it does |
|---|---|
| `-DRIFFSHEET_RELEASE=ON` | Clean product name `Riffsheet`, and no auto-install after build. Without it you get a timestamped dev name (`Riffsheet 20260809-1412`) that auto-installs, so iterative rebuilds never leave two bundles sharing one plugin UID. |
| `-DRIFFSHEET_WEBCORE_DIR=…` | Embed a specific web build instead of auto-detecting `../webcore/dist`. `shell/scripts/build.sh --placeholder` uses this to embed the shell's own test panel. |
| `-DRIFFSHEET_REQUIRE_WEBCORE=ON` | **Refuse to configure** if `../webcore/dist` is missing or module-based, instead of quietly falling back to the placeholder. CI always passes this. Use it in any automated build. |
| `-DJUCE_DIR=…` | Where JUCE lives. |
| `-DJUCE_WEBVIEW2_PACKAGE_LOCATION=…` | Windows only; the folder containing the WebView2 NuGet package. |
| `-DRIFFSHEET_ORT_DIR=…` | The staged ONNX Runtime from section 2a: a folder with `include/` and `lib/`. Also read from `$RIFFSHEET_ORT_DIR` or `$ORT_DIR`. |
| `-DRIFFSHEET_WITHOUT_BASIC_PITCH=ON` | **Builds with no inference runtime at all.** No built-in engine, no beat tracking, and a machine with no MuScriptor installed cannot transcribe anything. It exists so somebody iterating on the web UI does not have to build ONNX Runtime first. **Never for a release** — the configure prints a warning saying so. |
| `-DRIFFSHEET_BUILD_TESTS=ON` | Builds `RiffsheetTests` and registers it with CTest. Separate build directory (`shell/build_tests/`), so it neither reconfigures nor rebuilds a release tree. |

### The release audit

`cmake --build shell/build --target riffsheet_release_audit` walks `shell/Resources/models/**` and
refuses anything that is not declared in `shell/Resources/models/MANIFEST.sha256` with a matching
digest — and any manifest line whose file is missing. `-DRIFFSHEET_RELEASE=ON` makes it a
dependency of the plugin, so a release cannot be built without it passing. It is what stops
non-commercial or gated weights being dropped into `Resources/` and shipped by accident;
`EngineCatalog.cpp`'s `static_assert` covers the other direction.

The size half runs from the same file and is called by CI after staging:

```bash
cmake -DMODE=sizes -DSTAGE_DIR="$PWD/Riffsheet-0.1.0-macOS" -P shell/cmake/ReleaseAudit.cmake
```

It zips each product on its own and then the whole staged folder, and fails if any product exceeds
**35 MB** or the bundle exceeds **100 MB**.

### What ONNX Runtime actually costs, measured

Measured on the machine this was built on — Apple M1, 8 GB, macOS 26.4, arm64 Release, LTO on —
by building the same tree twice, once with `-DRIFFSHEET_WITHOUT_BASIC_PITCH=ON` and once without.
Statically linked ONNX Runtime 1.28.0 (CPU only, `--disable_ml_ops`, all operators) plus the
225 KiB `nmp.onnx`:

| | Binary, no engine | Binary, with engine | Delta | Zipped, no engine | Zipped, with engine |
|---|---|---|---|---|---|
| VST3 | 17.4 MB | 41.5 MB | **+24.1 MB** | 13.4 MB | **20.0 MB** |
| AU | 17.4 MB | 41.4 MB | **+24.0 MB** | 13.4 MB | **20.0 MB** |
| Standalone | 17.9 MB | 41.5 MB | **+23.6 MB** | 13.6 MB | **20.3 MB** |
| Whole release bundle | | | | 40.4 MB | **60.4 MB** |

So the cost is about **24 MB of machine code per product, three times over on macOS, and 6.6 MB per
product once zipped** — the largest single product is 20.3 MB against a 35 MB budget, and the
bundle is 60.4 MB against 100 MB. That is why none of the size levers above is applied: they trade
build complexity for headroom nobody needs yet. Re-measure before adding the second model.

### The second model, measured

Wave 4 added `shell/Resources/models/beat-this/small0.onnx` — 10.1 MiB, embedded in `BinaryData`
alongside `nmp.onnx`, so it is paid three times on macOS. Measured the same way, on the same
machine, against the table above:

| | Zipped, wave 3 | Zipped, wave 4 | Delta |
|---|---|---|---|
| VST3 | 20.0 MB | **27.7 MB** | +7.7 MB |
| AU | 20.0 MB | **27.7 MB** | +7.7 MB |
| Standalone | 20.3 MB | **27.7 MB** | +7.4 MB |
| Whole release bundle | 60.4 MB | **83.3 MB** | +22.9 MB |

Largest product 27.7 MB against the 35 MB budget; bundle 83.3 MB against 100 MB. Both still pass,
with less room than before — **the next model of this size does not fit**, and the levers in "If
the size budget is ever blown" above become real work rather than a note.

### The universal build is not the measured build — so macOS ships per architecture

Every number above was measured on **one architecture**. CI is not one architecture: the macOS leg
configures with `-DCMAKE_OSX_ARCHITECTURES="arm64;x86_64"`, and a universal Mach-O carries two
complete copies of everything, including the embedded data. Measured 2026-08-10 on the arm64
Release tree:

| | Bytes | Note |
|---|---|---|
| `webcore.zip` in `BinaryData` | 11.1 MB | already a zip — cannot compress again |
| `beat-this/small0.onnx` | 10.1 MB | float weights — compresses barely |
| arm64 `__text` (all code) | 17.4 MB | compresses well, to roughly 6 MB |
| One product, zipped | **27.8 MB** | inside the 35 MB budget |
| Whole bundle, zipped | **83.6 MB** | inside the 100 MB budget |

The ~21 MB of embedded data is incompressible and is paid **per slice**, not per product, and
deflate's 32 KB window cannot dedupe two copies sitting 54 MB apart — concatenating the binary
with itself and zipping the result gives 55.7 MB, not 27.8 MB. So a universal product would be
about **56 MB, and ~168 MB for the bundle**: 1.6× and 1.7× over budget. Windows and Linux are
single-slice and pass with the numbers in the table.

The budget was deliberately **not** raised to paper over this. Three ways out were on the table,
all product decisions rather than build fixes:

1. **Ship macOS per architecture** — two zips, each 27.8 MB, both inside the budget, and each
   download half the size. The only option that makes downloads *smaller* rather than the ceiling
   higher. **This is what Riffsheet does.**
2. **Move `webcore.zip` and the models out of `juce_add_binary_data`** into `Contents/Resources`.
   That makes the 21 MB per-product instead of per-slice: about 35 MB per universal product —
   at the ceiling, not under it, and it needs the staging and signing changes described below.
3. **Raise the ceiling**, knowingly, to something like 60 MB per product and 180 MB per bundle.

**How option 1 works.** The macOS leg still compiles **once**, universal. Staging then copies the
built products per architecture and runs `lipo -thin arm64` / `lipo -thin x86_64` over every
Mach-O in each copy, re-signs the thinned bundles ad-hoc (thinning rewrites the binary, so the
signature has to come after it, and a bundle that fails to verify fails the leg), and audits each
set against the same 35 MB / 100 MB budget on its own. The result is two artefacts per release:

| Asset | For |
|---|---|
| `Riffsheet-<version>-macOS-arm64.zip` | Apple Silicon (M1 and later) |
| `Riffsheet-<version>-macOS-x86_64.zip` | Intel |

Each carries an `ARCHITECTURE.txt` saying which is which. Measured locally on the arm64 Release
tree: 27.8 MB per product, 83.6 MB per bundle — the table above, unchanged, which is the point.

Nothing here shrinks the payload itself; if that is wanted, the 18 MB of `webcore/public/samples`
(7.8 MB `upright-piano`, 5.2 MB `marimba`) is where the bytes are.

Why embedded and not a bundle resource, when the rule in `engine-architecture.md` §6.6 says
anything over 1 MB ships as a resource: that rule's stated reason is "an embedded byte is paid
three times", and a bundle resource is paid three times too, because each of the three products
carries its own `Contents/Resources`. What actually separates the two options is that the resource
route needs changes to the staging and code-signing steps in `.github/workflows/build.yml` and
`shell/scripts/build.sh`, and has no bundle to live in at all on Windows or Linux. The numbers
above are what that decision rests on.

### Re-exporting the beat model

There is no official ONNX release of *Beat This!*, so Riffsheet exported it. To reproduce
`small0.onnx` byte for byte, in a throwaway virtualenv with `beat_this==1.1.0`, `torch==2.13.0`
and `onnx` (never in a venv you use for anything else):

```python
import torch
from beat_this.inference import load_model

class BeatThisOnnx(torch.nn.Module):          # the module returns a dict; ONNX wants a tuple
    def __init__(self, model): super().__init__(); self.model = model
    def forward(self, spect):
        out = self.model(spect)
        return out["beat"], out["downbeat"]

model = BeatThisOnnx(load_model("small0", "cpu")).eval()
torch.onnx.export(
    model, (torch.zeros((1, 1500, 128), dtype=torch.float32),), "small0.onnx",
    input_names=["spect"], output_names=["beat", "downbeat"],
    dynamic_axes={"spect": {1: "frames"}, "beat": {1: "frames"}, "downbeat": {1: "frames"}},
    opset_version=17, do_constant_folding=True, dynamo=False)
```

**The dynamic time axis is not optional.** Upstream pads a piece shorter than 30 s to its own
length plus twelve frames, not to 1500, so a fixed-shape graph would need zero padding that the
transformer would attend to — and the beats would move. `dynamo=False` keeps the TorchScript
exporter, whose output was checked against PyTorch at 205, 500, 1500 and 1512 frames (worst
absolute logit difference 1.4 × 10⁻⁵).

Then update `shell/Resources/models/MANIFEST.sha256` — the release audit will refuse the build
otherwise — and re-capture `shell/test/golden/beats-*.json` from Python, because the goldens are
tied to the exact checkpoint whose digest they record.

### How fast it is, measured

| Clip | Audio | Wall clock | Of that, inference | Ratio |
|---|---|---|---|---|
| `shell/test/BasicPitchFixture.wav` | 4.30 s, 3 windows | 56 ms | 56 ms | **77× real time** |
| `aug7.wav`, a real bass take | 29.05 s, 18 windows | 415 ms | 324 ms | **70× real time** |

Beat tracking, added in wave 4, on the same machine (`RiffsheetTests BeatTracker`, which prints
these numbers on every run):

| Clip | Audio | Model pass | Ratio |
|---|---|---|---|
| a 3.84 s held-note clip | 3.84 s, 1 chunk | 44 ms | **87× real time** |
| synthetic click track | 35.02 s, 2 chunks | 1377 ms | **25× real time** |

Only `shell/test/BasicPitchFixture.wav` and the synthetic click track are in the repository. The
two real recordings above were local takes used to take the measurement; the beat-tracker test
now builds its held-note fixture from a formula instead, so nothing here needs a `.wav` you do
not have.

Slower per second than Basic Pitch because a chunk is 30 s of audio through a six-layer
transformer, and it is only ever run when the user asks for `preciseBeats`. The DBN on top of it
is under 200 ms for a 35 s take, both bar lengths included.

CPU execution provider, `IntraOpNumThreads=2`. **The CoreML execution provider is not compiled
in**, and on these numbers it has nothing to do: a thirty-second take is transcribed in under half
a second, and file decoding is a third of that. `OrtSession.cpp` already contains the two guarded
lines that append it, behind `RIFFSHEET_ORT_HAS_COREML`, which `shell/cmake/OnnxRuntime.cmake`
turns on by itself if it finds a CoreML-enabled runtime. Turning it on is therefore
"rebuild ONNX Runtime with `--use_coreml`", with no source change at all.

For comparison on the same 29 s take, on the same machine: MuScriptor (medium weights) takes
18.9 s wall clock and about 1.8 GB resident, most of it model loading. That ratio — 45× the time
and roughly 400× the memory — is the whole argument for bundling Basic Pitch as the
always-available engine rather than as a fallback nobody reaches.

At runtime, `RIFFSHEET_WEBCORE_DIR` as an **environment variable** makes the shell serve the web
app off disk instead of from the embedded zip, so the web side can be iterated without rebuilding
the plugin.

---

## 6. CI

`.github/workflows/build.yml` builds all three platforms on every push and uploads three zips as
downloadable artefacts (`Riffsheet-macOS`, `Riffsheet-Windows`, `Riffsheet-Linux`). Publishing a
GitHub Release also attaches those zips to the Release.

Each job: checkout → platform deps → Node 22 → `npm ci && npm run build` in `webcore/` → check a
bundle really came out → checkout JUCE → configure → build → stage → hard-verify the binary is
actually inside the staged bundle → zip on the native runner → upload.

The staging step verifies that each expected binary is really present before packaging it.
`RIFFSHEET_REQUIRE_WEBCORE=ON` also prevents a failed web build from silently producing a plugin
that contains only the placeholder panel. Linux is pinned to Ubuntu 22.04 so release artefacts do
not acquire a newer glibc baseline whenever GitHub changes `ubuntu-latest`.

---

## 7. What CI proves — read this before you trust a green badge

**A green CI badge means IT COMPILES, plus whatever `ctest` covers. That is all it means.**

Nobody has run Riffsheet on Windows. Nobody has run it on Linux. The CI does not launch the
plugin, does not load it in a host, and does not open the web view.

What it now *does* prove on all three platforms, because `RiffsheetTests` runs there: the engine
catalogue's licensing invariants hold; the engine settings file round-trips; `auto` resolves the
way it is documented to; and the built-in engine runs a real inference and reproduces
spotify/basic-pitch's own posteriorgrams and note list from a committed fixture, to within float
noise. That last one is the check worth having, because a wrong window hop or a mis-stitched
overlap produces plausible notes at wrong times rather than an error — and on macOS arm64 the
posteriorgram difference from the reference run is currently **exactly zero**.

The CI still transcribes nothing through the plugin, in any host, on any platform.

**The web view is the real risk**, and it is not a small one, because the web view is not part of
the UI — it *is* the UI. If it comes up blank on Windows, the plugin is a blank window.

The specific thing to be nervous about: **ES modules do not load** in the plugin's macOS web view;
`<script type="module">` fails over the `juce://` scheme. JUCE 8.0.13 also uses
`juce://juce.backend/` on Linux WebKitGTK; Windows WebView2 uses `https://juce.backend/`.
**Neither non-macOS backend has been re-measured in a DAW.** The restriction may apply differently
or expose a different failure.

The build is conservative about this on purpose: all three platforms get the same classic-script,
IIFE, `<script defer src>` bundle that is known to work on macOS. One unknown is better than
three. But "known to work on macOS" is not "known to work".

The same caveat covers `useWorkers: false`. On macOS, a worker-backed alphaTab render inside
the plugin's WebView returns **nothing at all and reports no error** — the file loads, the
waveform draws, the buttons light up, and the music never appears. That was measured on WKWebView
too. Do not turn workers on anywhere to "optimise", on any platform, without re-measuring inside
that platform's web view.

---

## 8. What a first Windows tester must actually check

In roughly this order, because each one gates the next:

1. **Does the standalone open a window at all?** If the frame appears and the interior is blank or
   white, the WebView2 **runtime** is probably missing. The SDK above is a build-time thing; end
   users need Microsoft's Evergreen WebView2 Runtime installed, which is standard on Windows 11
   and not guaranteed on Windows 10.
2. **Does the web app appear, or an empty page?** An empty page with a working frame is the §4.2
   scenario. Open the WebView2 devtools console and look for *"Importing a module script failed"*
   or a script that 404s.
3. **Does the music font render, or boxes?** Bravura ships inside the embedded bundle and is loaded
   over the custom scheme. Glyph boxes mean the font request is not being served.
4. **Does the score actually draw?** A UI that appears but shows no notation is the §4.3 worker
   landmine's signature — silent, no error.
5. **Does the waveform draw?** It comes from `fetch()` of `/native/pcm/<token>.f32` through the
   shell's resource provider. A blank waveform with a working score means the native data route is
   failing while static files work.
6. **Does audio play?** Web Audio inside WebView2 has its own autoplay rules; the metronome and
   playback both go through `AudioContext`.
7. **Does typing work?** `EDITOR_WANTS_KEYBOARD_FOCUS` is set, but key routing from a DAW into an
   embedded web view is exactly the sort of thing that differs per host per platform. Test text
   entry in the score UI inside a real DAW, not just the standalone.
8. **Do the export dialogs appear and write files?** MusicXML, MIDI and PDF all go out through
   `juce::FileChooser`.
9. **Does the standalone's audio input behave?** The macOS microphone workaround (§2.6, the
   preseeded `audioDeviceInChans="0"`) is a **macOS-only settings file**. On Windows the standalone
   will open the default input device on startup, and Windows 10/11 microphone privacy settings can
   make that fail. If the standalone hangs or shows no window, this is a prime suspect.
10. **Verify Engine setup before expecting transcription.** The shell discovers a venv from
    `RIFFSHEET_MUSCRIPTOR_VENV`, `<appSupport>/engine.json`, the per-user Riffsheet engine folder,
    a bundled layout, known hand-built locations, then `PATH` (full order in `shell/BRIDGE.md`).
    Settings → **Engine setup** shows found-at/not-found, the install steps, every location that
    was actually searched on this machine, the `engine.json` path to copy for a custom install,
    and a **Check again** button that re-runs discovery live — nothing there downloads or installs
    anything. Note that a Finder-launched DAW does not inherit a shell's environment, so
    `engine.json` — not the environment variable — is the override that works for plugin users.
11. **The engine is not supposed to stay running.** It starts when a transcription needs it and is
    killed the moment that transcription ends, however it ends; a stopped listener is the normal
    resting state, not a failure. Console.app shows one `Riffsheet/MuScriptor:` line per job saying
    which way it went.

---

## 9. Known broken or degraded away from macOS

These are real, they are in the code today, and none of them stop it compiling.

- **MuScriptor itself is not bundled.** Discovery is cross-platform, but a release still needs a
  separately installed MuScriptor environment and licensed weights. The recommended locations are
  `~/Library/Application Support/Riffsheet/engine/venv` (macOS),
  `%APPDATA%\Riffsheet\engine\venv` (Windows), and `~/.config/Riffsheet/engine/venv` (Linux).
  `<appSupport>/engine.json` (`{"venv": "..."}`) is the override that works from a Finder-launched
  host and is written automatically once an engine is found elsewhere; `RIFFSHEET_MUSCRIPTOR_VENV`
  still wins when it is set, and `muscriptor` on `PATH` is the last fallback.
- **Orphan server cleanup does nothing on Windows.**
  `SystemProbe::listeningProcessId` (`shell/Source/bridge/SystemProbe.cpp:180`) returns 0 on
  Windows because it is implemented with `lsof`. Everything downstream degrades from there: a
  force-quit leaves the Python server running with nothing to reap it, and the server pid is never
  recorded in the registry.
- **Linux orphan cleanup requires `lsof`.** The POSIX path shells out to it, and `SystemProbe`'s
  `withTool` only uses a tool it can find at `/usr/sbin/lsof`, `/usr/bin/lsof` or `/bin/lsof`.
  `lsof` is now in the documented build/runtime dependencies and CI image, but it is not bundled in
  the release zip. If an end user's distro omits it, cleanup quietly degrades and a force-quit can
  leave the Python server running.
- **"Which model is that server running" is unanswerable on Windows.**
  `SystemProbe::processCommandLine` (`shell/Source/bridge/SystemProbe.cpp:149`) returns `""`
  because reading another process's command line needs WMI or `NtQueryInformationProcess`. It is
  conservative on purpose — the orphan reaper never identifies a process positively, so it never
  kills one — but the UI will say *"unknown — this server was already running"* for any server
  Riffsheet did not start.
- **The machine-wide engine lock is untested on Windows.** The POSIX side uses `fcntl` write locks;
  the Windows side uses an exclusive `CreateFile` handle with no sharing
  (`shell/Source/bridge/EngineLock.cpp:63`). Both are released by the kernel on process death,
  which is the whole point, but the Windows path has never run. Test it directly: two Riffsheet
  instances in one DAW, transcribe on both, and confirm the second **queues** rather than loading a
  second copy of the model.
- **No HTTPS on Linux.** `JUCE_USE_CURL=0`, so JUCE's Linux `WebInputStream` falls back to raw
  sockets with no TLS. MuScriptor is plain HTTP on localhost so this does not affect transcription,
  but any future `https://` request from the shell will fail on Linux only.
- **State directories differ, correctly but untested.** `engine.lock`, `queue/`,
  `engine-owner.json` and `servers.json` live under `~/Library/Application Support/Riffsheet` on
  macOS, `%APPDATA%\Riffsheet` on Windows, `~/.config/Riffsheet` on Linux
  (`shell/Source/bridge/SystemProbe.cpp:84`). Worth confirming they actually appear.
