# Riffsheet — webcore

The UI, notation rendering and editing layer. Runs inside a JUCE WebView (WKWebView) and, with a
mock bridge, in a plain browser for development.

```
npm ci
npm run dev        # browser, mock bridge          http://localhost:5273
npm run build      # typecheck + self-contained bundle into dist/
npm run build:debug # same, with sourcemaps — do not embed this one in a release
npm run verify     # headless end-to-end check of dist/ + screenshot
```

Dev URL flags: `?demo=triplet&bars=8` loads a fixture straight into the main screen ·
`?plugin` simulates plugin mode (unlocks Capture) · `?noengine` simulates a missing transcriber.

## Phase 0 spike results

Chrome 151 headless, Apple Silicon, `dist/` build, alphaTab 1.8.4.
The temporary measurement page is no longer built or shipped; the conclusions and representative
measurements remain here because they constrain the renderer configuration.

**Edit re-render, median ms (15 samples), horizontal layout, shipping build, real pipeline
output:**

| bars | rebuild data→Score + renderScore | `render()` | `+ reuseViewport` | `+ firstChangedMasterBar` |
|-----:|---:|---:|---:|---:|
| 8 | 8.6 | 7.2 | 7.5 | 11.0 |
| 16 | 10.3 | 13.3 | 12.8 | **32.7** (p90 41) |
| 32 | 23.2 | 27.4 | 25.8 | **100.7** (p90 162) |

Three things follow:

1. **No debounced edit-preview is needed.** The threshold in the brief was 150 ms at 16 bars; we
   measure ~13 ms. Edits render synchronously, so `applyResult()` in `src/ui/app.ts` has no
   debounce.
2. **`firstChangedMasterBar` is a pessimization — do not pass it.** This contradicts the research,
   which assumed it was an optimization hint. It is slower at *every* size measured, on every run;
   at 32 bars it takes the median from 25.8 ms to 100.7 ms and the p90 from 30.5 ms to 162 ms.
   `TriView.rerenderAfterEdit()` passes `reuseViewport` only, and says why.
3. Rebuilding the whole `Score` from the pipeline's output costs about the same as an in-place
   `render()`, which is why the bar-1 marker can re-run the entire pipeline on release and still
   feel instant.

**alphaTab issue #2657 (tuplet hit-test drift) did not reproduce.** On a triplet-heavy 8-bar bass
fixture — 96 tuplet beats out of 144, plus double-stops:

- `getBeatAtPos` at the beat anchor: **144/144 (100%)**
- `getBeatAtPos` on tuplet beats specifically: **96/96 (100%)**
- `getNoteAtPos` at each notehead centre: **160/160 (100%)**

The bug was presumably specific to swing/tripletFeel, which Riffsheet does not set.

**Structural findings:**

- Two `BarBounds` per master bar (staff + tab), gap **48 px** — so the note-names row can sit
  *between* the staff and the tab as the design asks, not above it. Falls back to "above" if a
  future alphaTab stops reporting the split.
- `core.includeNoteBounds` populates per-note geometry as documented.
- String numbering is verified per note, not assumed: 40/40 notes sound the pitch the pipeline
  asked for. This check **caught a real mirrored-tab bug** during integration — see IR.md.
- **Only ONE worker-backed alphaTab instance per page will ever render.** A second one never
  fires `postRenderFinished` and hangs forever; destroying the first does not release it. A second
  instance with `useWorkers: false` renders fine, which is why `createPrintSettings()` disables
  workers — the PDF path is by definition a second, hidden instance. Know this before adding any
  second score view.
- **Font gotcha, cost an hour:** the alphaTab Vite plugin copies Bravura to `dist/font/`, but
  alphaTab resolves `fontDirectory` relative to the *script* (`dist/assets/`) and 404s. Fix is
  `core.fontDirectory = new URL('font/', document.baseURI).href` in `src/view/atSettings.ts`,
  which is also what makes it work under a JUCE custom scheme and `file://`.

## Shape

```
src/
  bridge/      JUCE shell adapter + a browser mock (types.ts is the interface)
  pipeline/    adapter onto the notation pipeline           → see IR.md
  score/       pipeline data → alphaTab Score, tuning/fret logic, note names, fixtures
  view/        TriView (staff + names + tab, one timeline), alphaTab settings
  audio/       master clock, WebAudio synth, auto-trim + peaks
  edit/        undoable actions (adapted from Escala — see CREDITS.md)
  export/      PDF print path (MIDI + MusicXML come from the pipeline)
  ui/          app shell, drop zone, waveform, transport, popover, settings, tooltips
scripts/       headless Chrome runners (CDP over Node's built-in WebSocket)
```

### The two rebuild paths

The difference is why dragging the bar-1 marker feels instant:

- `rebuildNotation()` — re-runs the pipeline over notes we already have. ~10 ms. Fires on every
  settings change and on marker release.
- `runTranscription()` — listens to the audio again. Seconds. Only on new input.

### Playback

One clock. `Transport` samples an authoritative position (the bridge's reported playback position
when there is original audio; `AudioContext.currentTime` otherwise) and never accumulates its own.
alphaTab runs in `PlayerMode.EnabledExternalMedia` and follows via `output.updatePosition(ms)`, so
there is no sync negotiation. The fader is an equal-power crossfade between the bridge's original
gain and our own WebAudio synth of the score.

## Build format — classic scripts, not ES modules

WKWebView refuses `<script type="module">` over the `juce://` scheme JUCE serves the page from
(shell/BRIDGE.md §0, measured in the shipping shell). So the build emits **IIFE with
`inlineDynamicImports`**, `modulePreload: false`, and a small Vite plugin rewrites the tag to
`<script defer src=...>`.

`defer` is not cosmetic: a module script defers by default and a classic one does not, so dropping
`type="module"` alone makes the bundle run in `<head>` before `<body>` exists and every
`getElementById` returns null. That cost one debugging round; it is now in the config comment.

The app is a single IIFE build. CSS ends up inlined in the bundle, which is one fewer request
over `juce://`.

## Self-containment

No CDN and no network dependency at runtime. `base: './'`, required Bravura files copied from the
pinned alphaTab package during the build, and worker URLs rewritten by the alphaTab Vite plugin.
Workers are explicitly fine over `juce://` — only the main document's scripts are restricted. The
optional alphaTab SONiVOX player is not copied; Riffsheet uses its own sampled playback voices.

`dist/` gets zipped into the plugin binary, so the release build drops sourcemaps, the two legacy
Bravura encodings (`.svg` and `.eot`) and alphaTab's unused soundfont.

## Verified

`npm run verify` drives the built `dist/` in headless Chrome. It checks rendering, cross-view
selection, editing and undo, MIDI/MusicXML/PDF output, playback controls, compact layouts and
console failures at several viewport sizes. Screenshots land in the gitignored `spike-results/`
directory.

## Integration

The notation pipeline and native bridge are both live. Browser development uses
`src/bridge/mock.ts`; the production JUCE adapter is `src/bridge/juce.ts`, and its contract is
documented in [`../shell/BRIDGE.md`](../shell/BRIDGE.md). The exact pipeline seam is documented in
[`IR.md`](IR.md).

See [`CREDITS.md`](CREDITS.md) for third-party licences and what was adapted from where.
