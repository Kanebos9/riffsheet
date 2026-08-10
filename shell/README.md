# Riffsheet — native shell

VST3 + AU + Standalone from one codebase. The entire plugin editor is a single
`juce::WebBrowserComponent` filling the window; all UI comes from the webcore
web app. This directory is the native side only.

- **`BRIDGE.md`** — the JS ↔ C++ contract.
- `scripts/build.sh` — build, sign, install.

## Build

```bash
./scripts/build.sh                 # dev: timestamped name, auto-installs
./scripts/build.sh --release       # clean "Riffsheet" name, installs to the real paths
./scripts/build.sh --placeholder   # embed this repo's test panel, not ../webcore/dist
./scripts/build.sh --universal     # arm64 + x86_64
```

Needs JUCE 8.0.1+; 8.0.13 is used in CI. Resolution order is `-DJUCE_DIR=…`,
`$JUCE_DIR`, `~/JUCE`, then `%USERPROFILE%\JUCE`.

See the root [BUILDING.md](../BUILDING.md) for prerequisites and Windows/Linux commands.

## Build conventions

- CMake 3.22+; Xcode is the default macOS generator and Ninja is optional.
- Company/manufacturer `OZ` / `OZ95`, bundle id `com.OZ.Riffsheet`, plugin code `Rfsh`.
- Development product names include a timestamp; release builds use the stable `Riffsheet` name.
- The Windows build uses the static MSVC runtime.
- Riffsheet is an audio effect with an embedded WebView, not a software instrument.

## Two macOS details

**Code signing.** Xcode signing is disabled in `CMakeLists.txt`; `scripts/build.sh`
strips extended attributes and ad-hoc signs the finished local bundles. Public
distribution still needs Developer ID signing and notarisation if Gatekeeper-free
installation is required.

**ES modules do not load.** WKWebView refuses `<script type="module">` over
JUCE's `juce://` scheme. Classic scripts, `fetch`, Workers and Web Audio are all
fine. This dictates how the webcore bundle must be built — see `BRIDGE.md` §0.
The build refuses a module-based `../webcore/dist` and falls back to the
placeholder with a warning, rather than shipping a blank window.

## Standalone: microphone permission

The standalone opens an audio input device at startup. On first launch macOS
shows the microphone prompt, and **CoreAudio blocks until it is answered** — if
the prompt cannot be displayed the app appears to hang with no window.

If the standalone is configured with no input channels, it launches without a
permission prompt. To record from a microphone or interface: **Options →
Audio/MIDI Settings**, pick an input device, and answer the prompt. The VST3/AU
are unaffected because they receive audio from the host.

## Layout

```
Source/plugin/    PluginProcessor   audio, host playhead, transport, MIDI out
                  TrackCapture      lock-free capture of the track + host timeline
Source/ui/        PluginEditor      the window: one WebView, resizable
Source/bridge/    NativeBridge      every native function and pushed event
                  WebResources      serves the web app + raw PCM
                  PcmStore          decoded audio, handed to JS by token
                  MuScriptorServer  starts/adopts the Python transcription server
Resources/webcore/  the engine test panel (placeholder UI)
cmake/PackWebcore.cmake  bundles the web app + generates juce/juce-global.js
```
