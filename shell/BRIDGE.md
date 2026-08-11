# Riffsheet bridge contract

What the web app (webcore, Team B) can call in the native shell, and what the
shell pushes back. This file and `Source/bridge/NativeBridge.cpp` are the same
contract — if they disagree, the C++ wins and this file is a bug.

Verified working on macOS 26.4, JUCE 8.0.13, in Standalone and in REAPER (VST3).

---

## 0. READ THIS FIRST — the bundle must use classic scripts

**`<script type="module">` does not work.** WKWebView refuses to load ES modules
over the `juce://` scheme JUCE serves the page from:

```
dynamic import FAILED: Importing a module script failed.
```

Measured in the shipping shell, not guessed. Everything else over `juce://` is
fine:

| Feature | Over `juce://juce.backend/` |
|---|---|
| `fetch()` | works (200, correct content-type) |
| classic `<script src>` | works |
| `<script type="module">` / `import()` | **BLOCKED** |
| `new Worker(url)` | works |
| `new Worker(url, {type:"module"})` | works |
| Blob workers | works |
| `AudioContext` | works |

Only the **main document's** scripts are affected. Workers may be modules.

This is why JUCE's own reference GUI (`examples/Plugins/WebViewPluginDemoGUI`)
uses `react-scripts`/webpack, which emits classic scripts.

### What Team B has to change

`webcore/dist/index.html` currently emits:

```html
<script type="module" crossorigin src="./assets/main-CtAjqq34.js"></script>
```

That will not run in the plugin. Build a single classic bundle instead — for Vite:

```js
// vite.config.ts
export default defineConfig({
  base: './',                       // relative asset URLs
  worker: { format: 'es' },         // module workers ARE fine
  build: {
    target: 'es2020',
    modulePreload: false,           // no <link rel=modulepreload crossorigin>
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true, // one file, no dynamic import()
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
```

Drop `crossorigin` from the generated tags (`modulePreload: false` plus the IIFE
format removes them). Then `index.html` should look like:

```html
<script src="./assets/main.js"></script>
```

Anything the bundle loads at runtime (alphaTab's worker and Bravura) keeps working — those go
through `fetch`/`Worker`, both of which are fine. Riffsheet does not ship or load alphaTab's
optional soundfont.

### Getting at the bridge from a classic script

The shell serves a generated classic build of JUCE's frontend library:

```html
<script src="./juce/juce-global.js"></script>
<script>
  const getShellInfo = Juce.getNativeFunction("getShellInfo");
  getShellInfo().then(info => console.log(info));
</script>
```

`window.Juce` exposes `getNativeFunction`, `getSliderState`, `getToggleState`,
`getComboBoxState`, `getBackendResourceAddress`, `ControlParameterIndexUpdater` —
the same names JUCE's ES module exports. It is generated at build time from the
JUCE version being compiled against, so it never drifts.

If you would rather bundle it yourself, `npm i <JUCE>/modules/juce_gui_extra/native/javascript`
(package name `juce-framework-frontend`) and import it — bundling resolves the
import at build time, so the module restriction does not apply. Either way works;
the served `juce/index.js` (the raw ES module) exists but **cannot** be imported
at runtime.

---

## 1. Where the page comes from

The page is served by a JUCE resource provider, so it has a real origin
(`juce://juce.backend/` on macOS, `http://juce.backend/` on Windows) — not
`file://`. Relative URLs, `fetch`, Workers and Web Audio all behave normally.

Two sources, in priority order:

1. **`RIFFSHEET_WEBCORE_DIR`** — if this environment variable points at a
   directory containing `index.html`, it is served straight off disk. Edit a
   file, reload the plugin window, see the change. No rebuild.
2. **Embedded bundle** — otherwise the zip compiled into the binary. Built from
   `../webcore/dist` when that exists, else `shell/Resources/webcore`.

A request with no file extension falls back to `index.html`, so client-side
routing works.

`juce/juce-global.js` and `juce/index.js` are injected into the bundle by the
build; they are always available regardless of which source is in use.

---

## 1b. The layout must be fluid — this is a hard requirement

**A fresh window opens at 1100x700. Must stay usable down to 900x600. Must not
break down to 360x280.**

(1100x700 since v1.1 — the old 1180x760 was more window than a riff needs on
first open. It is only a DEFAULT: the size is user-resizable and persisted per
instance, so nobody who has already dragged their window is affected. The single
place it is defined is `defaultEditorWidth`/`defaultEditorHeight` in
`Source/ui/PluginEditor.h`.)

Why the low floor matters: REAPER does **not** refuse a drag that would take its
FX window below the plugin's stated minimum. It shrinks the frame anyway and
clips the editor — the page keeps its old layout and the user simply loses the
right and bottom edges. That was reported from the field and it is why the
shell's hard minimum is 360x280 rather than 900x600.

Measured on this Mac by dragging the window: REAPER's docked FX window spends
about **232pt on the plug-in list** and **85pt on the header**, and refuses to go
below roughly **622x422** — which leaves the editor about **390x337**. Undocked /
floating FX windows give nearly the full width.

So:

- No fixed-px page canvas. Percentage / `fr` / `minmax(0, …)` widths.
- Every grid or flex track that can shrink needs `min-width: 0` / `min-height: 0`,
  otherwise the content's intrinsic width wins and the page overflows.
- Wide things (score, tab, tables) scroll **inside their own container**, never
  by making the page itself wider than the viewport.
- Collapse to a single column somewhere around 760px.
- Test at 360x280 before calling a layout done. That is REAPER's own smallest
  docked FX window, minus its chrome — the smallest the page can ever be asked
  to render.

The shell also pushes a `viewportResized` event on every editor bounds change:

```js
window.__JUCE__.backend.addEventListener("viewportResized", ({width, height}) => {
  // re-engrave / re-measure here
});
```

Use it for anything that has to be recomputed rather than reflowed (canvas
sizing, score engraving). WKWebView can be lazy about firing its own `resize`
during a fast drag; this one is driven from the native side and always arrives.

---

## 2. Native functions

Every one returns a Promise. Errors are **resolved, not rejected** — check
`ok`:

```js
{ ok: false, error: "human readable reason" }
{ ok: false, cancelled: true }        // user dismissed a file dialog
```

Long operations resolve immediately with `{ ok: true, jobId, pending: true }`
and finish via an event (see §3).

### Shell / host

```ts
getShellInfo(): Promise<{
  ok: true,
  version: string,            // "0.1.0"
  juce: string,               // "JUCE v8.0.13"
  platform: string,           // "Mac OSX 26.4"
  webcoreSource: string,      // "bundled" | "disk:/path/to/dir"
  muscriptorBaseUrl: string,  // "http://127.0.0.1:8223"
  pcmUrlPrefix: string,       // "/native/pcm/"
}>
```

**`muscriptorBaseUrl` is a guess until a server has actually been resolved.** It
reports the configured port (8223) before anything has been adopted or started,
even when the app is about to adopt one on 8222. Nothing in webcore reads it.
`engineStatus().port` is the truthful answer — `0` when nothing is running.

```ts
getHostInfo(): Promise<{
  isPlugin: boolean,                        // false in Standalone
  format: string,                           // "VST3" | "AudioUnit" | "Standalone"
  hostName: string,                         // "Reaper", "Logic", "Unknown"
  hostBpm: number | null,                   // null in Standalone or if host is silent
  hostTimeSigNumerator: number | null,
  hostTimeSigDenominator: number | null,
  isPlaying: boolean,
  ppqPosition: number | null,
  timeSec: number | null,
  hasHostTimeline: boolean,                 // v1.2
  ppqPositionOfLastBarStart: number | null, // v1.2
}>
```

Nulls mean "the host told us nothing" and are deliberately distinct from `0`.
Confirmed live in REAPER: `hostBpm: 120`, `4/4`, `hostName: "Reaper"`.

**`hasHostTimeline`** is true when the host has given the plugin a playhead
carrying something musically usable — a tempo, or a musical position. A host that
reports only a sample count has a playhead but no timeline, and Standalone has
neither. Use it as the "can I build a DAW grid at all?" test.

**`ppqPositionOfLastBarStart`** is the DAW's own bar line, in quarter notes. With
it plus `ppqPosition` and the meter you can build a grid for audio that was
**not** captured in the plugin — a dropped wav can now use the DAW's tempo too,
which was impossible before v1.2 because only `captureStop()` carried a timeline.
JUCE never synthesises this field; it is whatever the host put in
`kBarPositionValid` (VST3) or `outCurrentMeasureDownBeat` (AU), and `null` when
the host said nothing.

**Changed in v1.2:** `ppqPosition` and `timeSec` used to report `0` when the host
had reported nothing, which reads as "bar 1, exactly". They are `null` now, like
every other unreported field.

> **Everything here is strictly what the host said.** JUCE's wrappers copy the
> numbers through with no rounding and no power-of-two check on the time
> signature denominator, and report nothing at all when the host does not raise
> the matching validity flag — so REAPER set to `3/6` arrives as `3/6`. It
> follows that **every 4/4 and every 120 BPM you can see is a default somebody
> downstream supplied**, never something the shell transformed. If you need to
> know which, call `hostTimelineProbe()`.

### Audio in

```ts
pickAudioFile(options?: { sampleRate?: number }): Promise<AudioRef>
pickInputFile(options?: { sampleRate?: number }): Promise<AudioRef | InputBytes>
loadAudioPath(path: string, options?: { sampleRate?: number }): Promise<AudioRef>
loadAudioBytes(name: string, base64: string,
               options?: { sampleRate?: number }): Promise<AudioRef>
importDroppedFile(name: string, base64: string,
                  options?: { sampleRate?: number }): Promise<AudioRef>
```

```ts
type AudioRef = {
  ok: true,
  token: string,            // hand this to playbackLoad / transcribe
  path: string,             // durable Riffsheet app-support WAV
  name: string,
  sampleRate: number,       // rate of the PCM behind pcmUrl
  numFrames: number,
  durationSec: number,
  sourceSampleRate: number, // the file's own rate
  sourceChannels: number,
  channels: 1,              // always mono-summed
  pcmUrl: string,           // "/native/pcm/<token>.f32"
}

type InputBytes = {
  ok: true,
  kind: 'bytes',
  path: string,
  name: string,
  contents: string // base64; MIDI, MusicXML, Guitar Pro, PDF or score image
}
```

`pickInputFile` is the main Open button's native picker. Audio returns an `AudioRef`; symbolic
and printed-score formats return `InputBytes` for the web importer. This avoids relying on an
HTML `<input type="file">`, which is not reliable inside every DAW WebView. Byte inputs are
limited to 64 MB and checked before allocation/base64 conversion.

Every picked/dropped audio file is decoded and copied to Riffsheet's durable `takes` directory
before its `AudioRef.path` is returned. `loadAudioPath` accepts one of those owned take paths, or a
path this user has chosen in Riffsheet **at some point on this machine**. This is a trust boundary:
a DAW project file can contain an untrusted web-state blob, so restore must never turn a string in
that blob into an arbitrary filesystem read/upload.

`loadAudioBytes` is the path-free twin of `loadAudioPath`, for a v2 `.riffsheet` document, which
carries its recording inside it. Restoring one gives the page samples but no `token`, so everything
that runs in the SHELL — `transcribe` above all — was still tied to the original file being where
the document said it was, which is the assumption embedding the audio existed to remove. This mints
a take from the bytes instead: staged under a random name in the system temp directory, decoded
exactly like `importDroppedFile` (with which it shares `NativeBridge::stageBytesAndReply`), and
promoted to the durable `takes` directory before the `AudioRef` is returned; the staging file is
owned by the `PcmStore::Entry` and dies with it.

It is deliberately **not** gated the way `loadAudioPath` is, and that is not an exception to the
trust boundary above — it is outside it. The gate exists because a *path* names something this
process can reach and the page cannot. Bytes are the opposite: the page must already hold every one
of them, so the worst it can obtain is audio it could already read. Nothing on disk is named, opened
or authorized here. `name` is used only for the staging file's extension, which is how the format
manager picks a decoder — pass the original file name, not a bare title.

"At some point", not "in this editor". The editor is destroyed and rebuilt on every track click, so
a per-editor set is empty almost always, and gating on it made the app's own Recent list — which is
`localStorage['riffsheet.recent']`, WebView storage local to this machine, never carried inside a
shared project — permanently unopenable. The record is durable instead:
`<appSupport>/opened-files.json`, newest first, capped at 64, written by
`NativeBridge::authorizeAudioPath` from every picker and drop callback and re-read on a miss so the
standalone and each plugin instance agree. An attacker's path in a shared blob was never chosen
here, so it is still refused.

```ts
authorizeRecentPaths(paths: string[]): Promise<{ ok: true, authorized: number, skipped: number }>
```

One-time adoption of the page's own Recent list into that record, for entries made before the
record existed. Pass **only** paths read from `localStorage['riffsheet.recent']`. At most 16 per
call, and each must currently exist and match the decoder's audio wildcards.

**Getting the samples.** They do not come through the JSON bridge — a few
million floats would be absurdly slow. Fetch them as binary:

```js
const ref = await pickAudioFile({ sampleRate: 22050 });
const pcm = new Float32Array(await (await fetch(ref.pcmUrl)).arrayBuffer());
// pcm.length === ref.numFrames, mono, little-endian Float32
```

`sampleRate` defaults to **44100** (keeps A/B playback of the original sounding
right). Pass `22050` when you only want a smaller array to draw a waveform from.
It does not affect transcription quality: `transcribe()` uploads the source file,
not this buffer.

`importDroppedFile` receives browser bytes, not a reopenable native path. Before
it replies, the shell atomically writes the decoded audio as a 24-bit WAV under
Riffsheet's application-support `takes` folder. The returned `name` remains the
browser's original filename; `path` is durable user data that survives reloads
and reboots and is never removed as temporary data. Only the staging input is
entry-owned and cleaned up automatically.

#### How long a token lives — changed in v1.3

**A take now lives exactly as long as something is using it, and is released the
moment nothing is.** Before v1.3 the shell's `PcmStore` was an unbounded map with
no eviction anywhere: every recording opened in a session stayed resident for the
life of the plugin instance, and the transport kept a **second** full copy of
whichever one was loaded. A ten-minute 44.1 kHz mono take is ~106 MB, so five
takes was over a gigabyte on an 8 GB machine.

This is a **lifetime, not a cap.** Nothing is evicted, nothing is capped, and no
number needs tuning. The store holds weak references and an entry is destroyed
when its last owner lets go. The owners are:

| Owner | Holds it while |
|---|---|
| the playback transport | that token is loaded — until `playbackLoad` is given another token or `null` |
| **the shell's automatic hold** | it is the most recently handed-out token — until the shell hands out another or you call `pcmRetain` |
| your declared set | you said so with `pcmRetain` — until you say otherwise |
| a transcription in flight | the job is running, however it ends |
| any native call in progress | for the duration of the call |

**You do not have to do anything for the common case.** Until your first
declaration, the shell keeps the take it most recently handed you, so
`pickAudioFile` → `fetch(pcmUrl)` → `playbackLoad(token)` →
`transcribe({token})` all work with no bookkeeping. Once `pcmRetain` succeeds,
its declared set is authoritative and the provisional automatic hold is
released. A plugin whose editor has been destroyed still owns every take held by
that declared set, playback, or transcription (those holds live on the
processor, not the editor — see §5, and design notes §5.5 for why that matters).

What you **should** do is say what you are using, so the shell can let go of what
you are not:

```ts
pcmRetain(tokens: string | string[] | null): Promise<PcmHoldState>
pcmRelease(tokens?: string | string[]):      Promise<PcmHoldState>
```

```ts
type PcmHoldState = {
  ok: true,
  held: string[],       // what this session holds now
  dropped: string[],    // what this call let go of
  unknown?: string[],   // asked for, but no such live token — not an error
  store: PcmStoreStats, // see pcmDiagnostics()
}
```

`pcmRetain` is **declarative**: the array is the *complete* set this session is
using and it replaces whatever you declared before. That is deliberate — a page
interrupted halfway through swapping takes cannot leak, because the next
declaration sweeps up, and re-declaring the same set costs nothing.

```js
// on opening a take
const ref = await pickAudioFile();
await pcmRetain(ref.token);            // "this, and nothing else"

// while a new take decodes but the old one is still on screen
await pcmRetain([oldToken, newToken]);
await pcmRetain(newToken);             // the old one is released here

// leaving audio behind entirely (a MIDI import over a wav)
await pcmRetain(null);
await playbackLoad(null);              // the transport is a holder too
```

`unknown` is a fact, not a failure: a token from a previous run of the plugin, or
one already released, simply is not there any more. A dead token behaves exactly
as it always has — `playbackLoad` answers `{ok:false, error:"unknown pcm token"}`
and `fetch(pcmUrl)` misses — which is the same path a project reload already
takes, so restore code that falls back to `loadAudioPath` needs no change.

### Printed score PDF/image in

```ts
omrStatus(): Promise<{
  ok: true,
  available: boolean,
  executable: string,
  version: string,
  message: string
}>

recognizeScoreImage(name: string, base64Contents: string): Promise<{
  ok: true,
  sourceName: string,
  name: string,             // compressed MusicXML filename (.mxl)
  contents: string,         // base64 .mxl bytes
  convertedBy: 'audiveris',
  elapsedMs: number,
  log: string
}>
```

Recognition runs off the message/audio threads and invokes an installed Audiveris process with
its batch CLI. The shell searches the normal install locations on macOS, Windows and Linux, then
`PATH`; `RIFFSHEET_AUDIVERIS` overrides discovery. Input is capped at 64 MB, output/log capture is
bounded, work is cancelled when the shell shuts down, and all staging files are removed.

The result is **MXL, not MIDI**. Webcore passes those bytes to the same score importer used for
MusicXML and Guitar Pro, which provides editable stable-id notes and MIDI export. This route reads
printed standard notation. Audiveris deliberately ignores tab staff contents and does not support
handwriting; a staff+tab page can recover the staff and let Riffsheet regenerate tab, while a
tab-only image cannot.

### Transcription

```ts
transcribe(options: {
  token?: string,          // from an AudioRef  (or)
  path?: string,           // a file on disk
  instruments?: string[],  // e.g. ["electric_bass"] - HARD constraint on output
  detectTempo?: boolean | "best-effort",   // default "best-effort"
  preciseBeats?: boolean,  // default false; see below
  engineId?: string,       // optional per-transcription override; see "Which engine"
  normalizeBeforeTranscribe?: boolean,      // default TRUE; see "Before an engine hears it"
  correctTuningBeforeTranscribe?: boolean,  // default TRUE
}): Promise<{ ok: true, jobId: number, pending: true }>
```

`engineId` overrides the stored engine choice **for this one transcription**. It
is accepted and honoured by the shell; no UI sets it yet. It exists so *"listen
again with Basic Pitch"* is later a button rather than a refactor. An id that is
unknown, or that this build has no engine for, is refused immediately with
`{ ok:false, error }` — the job never starts, so nothing queues.

```ts
transcribeCancel(jobId?: number): Promise<{ ok: true, cancelled: number }>
```

Resolves immediately. The work happens on a worker thread and reports through
`transcribeProgress` / `transcribeResult` events.

`transcribeCancel()` with no argument cancels every job this window started; with
a `jobId`, just that one. `cancelled` is how many were flagged. A cancelled job
finishes with `transcribeResult { ok: false, error: "cancelled" }`. **A job that
is still waiting in the queue is cancellable too** — waiting behind somebody
else's transcription must never be a trap.

The shell starts MuScriptor on demand, or **adopts one already running** — it
probes ports 8223 then 8222 (8222 is what the user's own `START*.command`
launchers use) so a second copy of the model is never loaded on an 8 GB machine.
Verified: with the user's server up on 8222, a transcribe reported
`"Using the transcription server already running on port 8222"`.

#### One transcription at a time, machine-wide

MuScriptor holds about 1.5 GB while it works and does **one job at a time** — a
second client gets HTTP 503, which the user saw as a bare *"busy with another
job"*. On an 8 GB machine two of them at once is the difference between a slow
transcription and a swap storm.

So `transcribe()` now takes a **machine-wide** turn before it does anything, and
waiters are served in arrival order. Machine-wide, not per-process: the
standalone app and the plugin can both be open, and several plugin instances in
one REAPER are several objects in one process.

- While waiting you get `transcribeProgress { stage: "queued", queuePosition }`
  (see §3). `queuePosition` is 1-based; **1 means "you are next"**.
- The wait happens on the worker pool, where the transcription already ran.
  Nothing blocks the message thread or the audio thread.
- A hard-killed owner frees the engine **immediately** — the exclusion is a
  kernel file lock, which the OS drops when the process dies, so there is no
  stale-lock timeout to sit through. Measured: a waiter took over 20 ms after a
  `SIGKILL`.
- The bookkeeping lives in `~/Library/Application Support/Riffsheet/` —
  `engine.lock` (zero bytes, the lock itself), `engine-owner.json` (who has it
  and since when, refreshed by a heartbeat) and `queue/*.ticket` (one per
  waiter). All of it is readable; none of it needs cleaning up by hand.
- **The 503 is still handled**, as the last line of defence. Reaching it now
  means something *outside* Riffsheet is using the server — the user's own
  `START-MEDIUM.command` window, or MuScriptor's own web page — and the message
  says so.

Poll `engineStatus()` for the whole picture, including who is busy and how long
the queue is.

#### Before an engine hears it — A440 and −12 dBFS

Two real transformations of the player's recording, applied by the shell between
taking its turn and handing anything to an engine:

- **Level.** The peak is brought to **−12 dBFS**, which is the level these models
  were trained near — in *both* directions, so a hot take comes down too. Skipped
  entirely below −60 dBFS (amplifying silence amplifies only noise) and the boost
  is capped at +30 dB.
- **Tuning.** If the recording is not at concert pitch it is resampled until it
  is. A guitar a quarter-tone flat otherwise comes back a semitone wrong from
  every model in the catalog.

Three rules govern them, and none of them is optional:

1. **Per engine, from the manifest.** `needsGainNorm` / `needsTuningNorm` decide.
   MuScriptor wants both; **Basic Pitch wants neither** — it normalises
   internally and was measured gain-invariant — so it is handed the file
   untouched no matter what the two options say.
2. **Never over the user's file.** `PcmStore::ensureSourceFile()` returns the
   user's own file when there is one, so nothing is ever written in place. When
   work is needed the shell writes a **new** mono 24-bit WAV in the temp
   directory and deletes it when the job ends; when no work is needed it uses
   the original file and writes nothing at all. Mono is not a shortcut: every
   engine downmixes anyway, and "−12 dBFS peak" is only a meaningful number when
   it is measured on the signal the engine actually hears.
3. **Only when the estimate is confident.** The tuning estimate is a
   magnitude-weighted circular mean of each partial's distance from the nearest
   A440 semitone. It is acted on only when it is more than **8 cents** off, at
   least **200** partials were weighed and their **agreement is above 0.25** —
   and it is refused outright within a cent of the ±50 wrap, where sharp and
   flat are literally the same answer. A whole tone up is *not* a detuning and
   is correctly read as 0 cents.

**Correcting pitch by resampling also changes time, and the shell undoes that
before the result leaves it.** Every `notes[].start`/`end`, `onsetDelay`,
`beatGrid.firstDownbeat`/`beats[]` and `preciseBeats.beats[]`/`downbeats[]` is
multiplied by `preprocess.pitchRatio`, and every `bpm` is divided by it, so
**everything the page receives is already in the original recording's timebase**
and nothing on the web side has to know a correction happened. `sourcePath` is
always the user's own file, never the prepared copy.

`midiBase64` is emptied when a tuning correction was applied: the SMF the engine
returned is in the prepared copy's timebase and would disagree with the note list
beside it. The page rebuilds MIDI from `notes` and reads that field nowhere.

`transcribeProgress` gains one stage while this runs:

```ts
{ jobId, stage: "preparing", message: string }   // getting the recording ready
```

Both options **default to true**, so a page that does not send them gets the
documented behaviour. They correspond to the two Settings checkboxes
(`normalizeBeforeTranscribe` / `correctTuningBeforeTranscribe`). Sending both as
`false` is byte for byte the behaviour of a shell without any of this: no decode,
no analysis, no file.

Measured on synthetic fixtures (`shell/test/PreprocessTests.cpp`): a 440 Hz tone
reads 0.20 cents; 452 Hz reads 46.87 (true value 46.59); white noise yields zero
usable partials and is refused; a 30-cent-sharp click track corrected and mapped
back lands **0.047 ms** from the undetuned reference, against **273.9 ms** if the
map is skipped.

Valid `instruments` values (35): `acoustic_piano, electric_piano,
chromatic_percussion, organ, acoustic_guitar, clean_electric_guitar,
distorted_electric_guitar, acoustic_bass, electric_bass, violin, viola, cello,
contrabass, orchestral_harp, timpani, string_ensemble, synth_strings, voice,
orchestra_hit, trumpet, trombone, tuba, french_horn, brass_section,
soprano_and_alto_sax, tenor_sax, baritone_sax, oboe, english_horn, bassoon,
clarinet, flutes, synth_lead, synth_pad, drums`. An unknown name is an error.

### Beats on their own — `trackBeats`

```ts
trackBeats(options: { token?: string, path?: string }): Promise<{
  ok: true,
  beats: number[],
  downbeats: number[],
  bpm: number | null,
  beatsPerBar: number | null,
}>
```

The same bundled beat tracker `transcribe({ preciseBeats: true })` runs, reached
without starting a transcription. It exists for the engine that runs in the page
(see *The engine that runs in the page*): beat tracking has never belonged to an
engine here — it is a model this process runs for all of them — so a locally
transcribed take would otherwise have notes and no grid, and the only way to get
one was to start a whole job and throw its notes away.

- **No turn in the engine queue and no lock.** Same reasoning as an in-process
  transcription (§1.3b): the model is small and runs here, and making a beat grid
  wait behind somebody else's four-minute MuScriptor job would put the fallback
  path behind the slow path for nothing.
- **The user's own audio, untouched.** `transcribe` runs the tracker over the
  *prepared* copy so notes and beats share one timebase; there is no prepared
  copy here, because the engine that produced the notes heard the original
  samples in the page. Both halves are already in the recording's timebase and
  there is nothing to map back.
- Registration is the capability test, as always: a page on an older shell keeps
  its notes and goes without a grid rather than hanging.

### "I already have this one" — `validateExistingEngineInstall`

```ts
validateExistingEngineInstall(id: string, path: string): Promise<{
  ok: boolean,
  detail: string,          // a sentence either way
  path?: string,           // where it is, on ok
  searched?: string[],     // every place looked at, in order
}>
```

The other door beside a one-click install, for somebody who installed the same
engine last year and does not want several hundred megabytes fetched again.

- `path === ''` **sniffs**: Riffsheet's own layout first, then the places this
  engine normally lives (and, for a console-script engine, every directory on
  `PATH`).
- a non-empty `path` **validates that one place**, and says what was missing when
  it is not one.

What counts as a working copy is per engine and is deliberately a **file check,
not an execution**:

| engine | working means |
|---|---|
| `transkun` (pip console script) | the `transkun` program in an environment's `bin/` — the venv itself, a folder holding one, or a path straight at the program |
| `bass-v2` (repo checkout) | `infer.py` **and** a checkpoints folder with weights actually in it, in that folder or one level down (which is how a zip unpacks) |

Nothing is run to find out. Executing a stranger's script to see whether it is
installed is a bigger promise than this call makes, it is slow, and on a broken
venv it hangs. An **empty** checkpoints folder is refused — a cloned repo whose
weights were never fetched is the commonest half-install there is.

A validated location is written to `<appSupport>/engines/<id>.location` and read
by `SidecarAdapter::installDirectory()` when there is no copy Riffsheet
installed itself. A bundled engine is refused outright: it ships inside
Riffsheet, so there is no other copy to point at.

### The engine: which weights, who is using it

```ts
engineStatus(id?: string): Promise<{
  ok: true,
  state: 'stopped' | 'starting' | 'ready' | 'failed',
  port: number,                 // 0 when nothing is running
  adopted: boolean,             // true when we joined a server we did not start

  model: string,                // the weights actually in use, best known
  modelSource: string,          // where that answer came from
  configuredModel: string,      // 'auto' | 'small' | 'medium' | 'large'
  resolvedModel: string,        // what 'auto' currently means
  modelReason: string,          // a plain sentence explaining the choice
  installedModels: string[],    // weights found on disk, e.g. ["medium"]
  models: Array<{               // ALL THREE sizes, installed or not — see below
    name: 'small' | 'medium' | 'large',
    approxResidentMb: number,   // 900 | 1800 | 5000
    installed: boolean,         // usable weights in the HuggingFace cache
    fits: boolean,              // ≤ 40% of physical RAM — the auto rule's own answer
  }>,
  venv: string,                 // discovered/configured environment root
  executable: string,           // expected muscriptor executable
  engineInstalled: boolean,
  setupDirectory: string,       // portable per-user install contract

  busy: boolean,                // a transcription is running anywhere on this machine
  busyOwner: 'self' | 'other' | null,
  busyLabel: string,            // "Riffsheet - riff.wav", for showing a human
  busySeconds: number,          // how long it has been going
  queueLength: number,          // jobs waiting, this process included, plus the holder
  queuePosition: number,        // OUR place in the queue, 0 = not queued

  ramTotalMb: number,
  ramFreeMb: number,            // what could be handed out without swapping; 0 = unknown

  stopsAfterEachJob: true,      // the engine dies at the end of every job; see below
  idleSeconds: number,          // since the last job finished anywhere on this machine
  canStop: boolean,             // stopEngine() would actually do something
  externalServer: boolean,      // a server is up that Riffsheet did NOT start
  canStopExternal: boolean,     // stopExternalEngine() would actually try
  memoryMb: number | null,      // resident size of the server process; null = unknown

  searchedPaths: string[],      // every venv location discovery looked in, in order
  engineConfigPath: string,     // <appSupport>/engine.json, shown whether or not it exists
  engineConfigExists: boolean,
  error: string | null,

  // --- which engine this payload is about (added with the engine picker) ----
  id: string,                   // 'muscriptor' | 'basic-pitch' | ...
  configuredEngine: string,     // 'auto' | '<id>'  - what the user chose
  resolvedEngine: string,       // what 'auto' means right now; always a real id
  engineReason: string,         // a plain sentence, like modelReason
  install: 'bundled' | 'one-click' | 'guide',
  guideSteps: Array<{ what: string, detail: string }>,   // [] unless install === 'guide'
  guideStepsText: string[],     // the same steps, one line each
}>
```

Pull-only and cheap — safe to poll. Anything expensive (health probes, reading
another process's command line) happens on the worker pool and is cached, at most
once every three seconds.

**With no argument it answers for the resolved engine**, exactly as it always
has — there was only ever one engine to answer for. With an `id` it answers for
that engine. An unknown id answers `{ ok:false, error: 'unknown engine "x"' }`.

**Every field that existed before still exists and still means what it meant.**
For an engine that is not MuScriptor the MuScriptor-shaped fields are still
present, with honest values rather than missing keys — `installedModels: []`,
`venv: ""`, `modelSource: "not applicable to this engine"` — because a missing
field reads as *unknown* and these are *irrelevant*. Three of them shift meaning
slightly, in the only way that generalises:

- `engineInstalled` is "this engine is on this machine" — unchanged in meaning
  for MuScriptor (its executable exists), always true for a bundled engine, and
  still true for an engine whose last start failed, because that engine is
  installed and its own error is the one worth reading.
- `executable` is the engine's location — `"built in"` for a bundled engine.
- `searchedPaths` is `[]` for an engine that searches nothing.
- `busy` is the machine-wide lock **or** an in-process job in this process. An
  in-process engine takes no file lock (it holds tens of megabytes, not 1.5 GB,
  and has no server to answer 503), so without the second term the UI would
  report idle while it worked. `busyOwner` is `"self"` for such a job.
- `engineConfigPath` still points at `<appSupport>/engine.json`, which is now
  also where the engine choice lives.
- `models` and the two `*External*` booleans are MuScriptor-shaped like the
  rest: `[]` and `false` for every other engine, because no other engine has
  weights to choose between or a server somebody else could have started.

**`models` is the whole size table, not just what is on disk.** `installedModels`
answers "what do you have"; `models` answers "what are the choices, and what
would each one cost me" — which is the question somebody deciding whether to
download `large` is actually asking, and which the card previously could not
answer at all. `approxResidentMb` is `ModelCatalog::estimatedResidentMb()` — the
same 0.9 / 1.8 / 5 GB the auto rule uses, Python and the Metal buffers included,
not the size of the weights file. `fits` is that rule's own step-1 answer
(`ModelCatalog::fitsInPhysicalRam()`), sent rather than recomputed in TypeScript
so the card cannot end up disagreeing with the resolver about what this machine
can carry. On this 8 GB Mac: small `fits: true`, medium `fits: true`, large
`fits: false`.

**Hiding the install guide when the engine is present**: `engineInstalled` is
the boolean to test, in `engineStatus`. It is true whenever the engine is on
this machine — including when its last start *failed*, because a broken install
is still an install and its own `error` is the sentence worth reading, not the
setup steps. `listEngines` carries the same thing per card as `installed`.

**`guideSteps` is a list of pairs `{ what, detail }`, not of strings.** The
setup screen draws `what` in a `<strong>` and `detail` in a `<div class="dim">`,
and a flat list would silently lose half of every step — `pip install
muscriptor` lives in a `detail`. (The page accepts a bare string as a heading
with no detail, but the shell never sends one.) `guideStepsText` carries the
same steps flattened to one line each, for anything that only wants to print
them. The steps come from the shell's compiled manifest, so the guide the engine
ships with is the guide the user reads — `webcore/src/ui/settings.ts` no longer
keeps a copy.

```ts
recheckEngine(): Promise<same payload as engineStatus>
```

**Runs discovery again, live**, then re-probes the ports and answers with the
ordinary status payload. It is what the setup screen's *Check again* button
calls: discovery otherwise runs once when the plugin loads, which is no use to
somebody who has just finished installing the engine with the window open — they
would have to restart their DAW to be found. It only changes where the engine is
looked FOR; a server already running is left exactly as it is.

Runs on the worker pool (it stats a dozen paths and may health-probe two ports).
It now re-runs discovery for **every** engine, not only MuScriptor's — "look
again, now" is a statement about this machine — and answers with the resolved
engine's status, as before.

### Which engine — `listEngines` and `selectEngine`

```ts
listEngines(): Promise<{
  ok: true,
  configuredEngine: string,        // 'auto' | '<id>'
  resolvedEngine: string,          // what 'auto' means right now, always a real id
  engineReason: string,            // "Auto is using Riffsheet - it is built in and needs no setup."
  nativeFallbackEngine: string,    // what the SHELL would run; see "The engine that runs in the page"
  engines: Array<{
    id: string,                    // 'riffsheet' | 'basic-pitch' | 'muscriptor' | ...
    name: string,
    tier: string,                  // "Built in" | "Best quality - guided setup" | "One-click"
    summary: string,
    sourceUrl: string,
    install: 'bundled' | 'one-click' | 'guide',
    state: 'ready' | 'installed' | 'not-installed' | 'broken',
    selected: boolean,             // resolvedEngine === id
    instrumentStrengths: string[], // ["Bass"] - for the card's capability line
    installed: boolean,            // state !== 'not-installed'; hide the guide on true
    acceptsInstrumentConstraint: boolean,
    producesBeatGrid: boolean,
    producesConfidence: boolean,
    producesVelocity: boolean,
    approxDiskBytes: number,       // 0 when nothing is downloaded
    approxPeakRssMb: number,
    installing: boolean,           // an install job for this id is in flight
    detail: string,                // one sentence, may be ""
    error: string | null,
  }>
}>
```

Cheap and pull-only: it reads the shell's compiled-in engine table plus each
engine's cached status. Safe to poll at the settings panel's existing 2 s
cadence — ask for it alongside `engineStatus()`, and **do not add a second
timer**. The field names are exactly `EngineListResult` / `EngineSummary` in
`webcore/src/bridge/types.ts`; those two declarations and this block are the
same contract written twice, and they must be changed together.

Two things it deliberately does:

- An engine Riffsheet may not fetch the bytes of (one-click, licence not
  verified) is **not in the array at all**. A card with an Install button that
  must refuse is worse than no card.
- An engine that is in the table but has no implementation compiled into *this*
  build is listed as `not-installed`, with `detail` saying so. Hiding it would
  make the picker disagree with the product.

```ts
selectEngine(id: 'auto' | string): Promise<
    { ok: true, configuredEngine: string, resolvedEngine: string, reason: string }
  | { ok: false, error: string }>
```

Stores the choice in `<appSupport>/engine.json` beside the venv — the one
setting a Finder-launched DAW can actually read — and answers with what that
choice resolves to. Modelled on `setEngineModel`, including its refusal:

- **It refuses while anything on this machine is transcribing.** Swapping the
  engine under a running job is the same class of bug as swapping the weights.
- **It refuses an unknown id**, or one that is not offered in this build.
- **It does NOT refuse an engine that is not installed yet.** That is how a
  card's *Select* works alongside *Install*: the choice is stored,
  `resolvedEngine` falls back to something that can actually run, and `reason`
  says why in a sentence.

**What `auto` means: the first engine in `EngineCatalog::autoOrder()` that is
present on this machine.** Today that order is:

```
riffsheet  ->  muscriptor  ->  basic-pitch
```

- **`riffsheet`** first. It is the app's own transcriber, it runs in the page,
  it needs nothing installed and it answers in under a second. For a single-note
  line — which is most of what gets recorded into this app — it is at least as
  good as the alternatives, and it is the only engine that can say *"this is not
  for me"*: a take it hears as chordal falls through to the next row here
  automatically. Leading with it therefore costs a chordal take one extra second
  and nothing else.
- **`muscriptor`** second. When it is installed it is the best thing on the
  machine, and somebody who went through its guided setup meant it.
- **`basic-pitch`** last, because it is compiled in, so the chain cannot run out.

The order lives in `EngineCatalog.cpp` and is `static_assert`ed to name real
rows with no duplicates. `EngineRegistry` only walks it.

If the chosen engine cannot run and nothing else can either, resolution stays on
the chosen engine — falling back to an equally unavailable one would replace an
honest error ("MuScriptor was not found; here is where I looked") with a vaguer
one.

#### The engine that runs in the page

`riffsheet` has `AdapterKind::inPageClient`, and it is the one row in the table
the shell **does not execute**. The transcriber is TypeScript in the web view
(`webcore/src/audio/riffsheetEngine.ts`); the samples it listens to are already
on that side of the bridge, so shipping them down to C++ and the notes back up
would be pure cost. The shell still carries a row and an adapter
(`ClientEngineAdapter`) because the picker, `auto`, `selectEngine` and the cards
are the one place the user's engine choice lives, and a second mechanism for one
engine would be a second thing to keep in step.

Its adapter reports `ready` always — it ships inside the web bundle the app
cannot start without, so there is no state in which the app is running and this
engine is not installed — and **refuses `transcribe()`** with a sentence saying
where it really runs. That refusal is unreachable through the normal path, and
that is the point of the next paragraph.

**Resolution has two answers, and callers must pick the right one.**

| question | call | used by |
|---|---|---|
| which engine is the USER on? | `resolve()` | `listEngines`, the picker, the cards |
| which engine would THIS PROCESS run? | `resolve(true)` | `transcribe`, `engineStatus()` with no id |

`resolve(true)` skips in-page engines. Two consequences worth stating:

- `transcribe()` with no `engineId` never lands on `riffsheet` — the page runs
  that one itself and never asks the shell to — so a native transcription
  resolves past it to MuScriptor or Basic Pitch. `nativeFallbackEngine` in
  `listEngines()` is that same answer, handed to the page so a refusal can name
  the engine it is passing the take to instead of re-deriving the order in
  TypeScript.
- `engineStatus()` with no id answers for the native engine too. Every field in
  that payload is about a *listener process* — a port, an adopted server, the
  weights in memory, whether it can be stopped — and the in-page engine has none
  of them. Answering for it would have silently retired the "left running,
  1.5 GB" notice about somebody else's MuScriptor the moment `auto` preferred
  Riffsheet, which is exactly the notice that exists because a player could not
  tell what was eating their machine.

**What the page does with all this.** When `resolvedEngine === 'riffsheet'`,
`App.runTranscription` runs the local pass instead of calling `transcribe`, and
produces the same `DetectedNoteDTO` shape — with a real `confidence` per note
(the share of that note's frames that agreed on the pitch), no velocity, and no
beat grid of its own. On a refusal it shows one sentence ("Sounded like chords
— handed to X") and calls `transcribe({ engineId: nativeFallbackEngine })`.

`RIFFSHEET_ENGINE` overrides the file for scripted runs, exactly as
`RIFFSHEET_MUSCRIPTOR_MODEL` overrides the model: a hard override that nothing
auto-selects around. `selectEngine` still writes the file, so the choice is
there when the override goes away.

Both calls are registered with `withNativeFunction`, so
`hasNativeFunction('listEngines')` is a truthful capability test on an older
shell. An unregistered native call hangs forever rather than rejecting, which is
why registration *is* the test.

### One-click install — `installEngine`, `cancelInstall`, `uninstallEngine`

```ts
installEngine(id: string): Promise<{ ok: true, jobId: number, pending: true }
                                  | { ok: false, error: string, guideSteps?: string[] }>
cancelInstall(jobId?: number): Promise<{ ok: true, cancelled: number }>
uninstallEngine(id: string): Promise<{ ok: true, id: string, freedBytes: number }
                                   | { ok: false, error: string }>
```

Modelled on `transcribe` beat for beat, because that shape is already
implemented, already documented, already cancellable while queued and already
understood by the page: the call resolves at once with `{ ok, jobId, pending }`
and the outcome arrives as an event.

`installEngine` refuses **before starting**, with no job id, when:

- the id is unknown or not offered;
- the engine is not `one-click` — MuScriptor's manifest has no download at all,
  which is where the licence constraint stops being a sentence and becomes a
  missing field;
- an install for that id is already in flight in this window;
- this build has no verified package list for this platform (answers with
  `guideSteps`, so the card becomes a guide rather than a dead end);
- free space on the volume is below three times what the install will move.

Finding a suitable Python takes several process launches, so *that* refusal
arrives as an `engineInstallResult` with `ok:false` and `guideSteps` rather than
holding the message thread. Both routes carry the same fields; render either.

**Riffsheet never installs Python.** It looks for one that satisfies the
engine's requirement (`>=3.10,<3.13` for both one-click engines today) in the
usual places, in a fixed order, and if none fits it says which ones it found and
what versions they were. `RIFFSHEET_PYTHON` overrides the search for scripted
runs.

```ts
// engineInstallProgress — change-gated, at most 5 Hz
{ jobId, id, stage: 'checking'    , message, receivedBytes, totalBytes, fraction, bytesPerSec, etaSec }
{ jobId, id, stage: 'downloading' , ... }   // fraction spans the WHOLE install, not one file
{ jobId, id, stage: 'verifying'   , ... }   // sha256 of what just arrived
{ jobId, id, stage: 'extracting'  , ... }
{ jobId, id, stage: 'installing'  , ... }   // the virtual environment and pip
{ jobId, id, stage: 'probing'     , ... }   // a real run against a generated 1 s clip

// engineInstallResult — exactly once per job
{ jobId, id, ok: true , bytesOnDisk: number, elapsedMs: number, location: string }
{ jobId, id, ok: false, error: string, cancelled?: true, elapsedMs, guideSteps: string[] }
```

`etaSec` is `null` when it is not yet knowable, never a guess. `totalBytes` is
`0` for the stages that are not moving bytes; `fraction` is always in `[0, 1]`.

**No bytes ever cross the bridge.** The download streams to disk in C++ and
every frame carries integers and short strings, so the WebView payload ceiling
is irrelevant to installs by construction rather than by a length check. Nobody
should add a `previewBytes` field.

**What an install actually does**, because "one click" should not mean "and then
something unknown happens on your disk":

1. checks Python and free space;
2. downloads every pinned asset over https from a compiled-in host allowlist,
   re-checked after every redirect, resuming a previous attempt where the server
   allows it, and verifies each file's sha256 against the compiled-in pin;
3. unpacks into `<appSupport>/engines/<id>.incoming/`;
4. builds a virtual environment there and runs pip with `--require-hashes`
   against a committed lock file that pins every package and every artefact
   hash;
5. **runs the engine for real** on a generated one-second tone;
6. and only then moves the finished tree onto `<appSupport>/engines/<id>/`.

A crash or a cancel at any point therefore leaves the previous install or
nothing — never a half-built engine that `listEngines()` would call installed.
Verified partial downloads survive under `<appSupport>/engines/.downloads/<id>/`,
which is what makes pressing Install again after a dropped connection cheap.

`uninstallEngine` refuses for `bundled` and `guide` engines — Riffsheet did not
put those there and does not get to remove them, the same principle as never
killing a server it did not start — and refuses while the engine being removed
is the one currently transcribing. It answers with `freedBytes` measured before
deletion, because "it did something" is the only useful thing to say.

`cancelInstall()` with no argument cancels every install this window started. The
flag is checked between every 64 KiB of download and every 100 ms of a child
process, so it lands in well under a second even in the middle of pip.

All three are registered with `withNativeFunction`, so
`hasNativeFunction('installEngine')` is a truthful capability test on an older
shell, and the shapes match `EngineInstallProgress` / `EngineInstallResult` in
`webcore/src/bridge/types.ts` and the browser mock.

#### The engine lives for one job

The user's decision, in his words: *"i dont want idle timeout to be 5 minutes. i
want musicriptor to be killed immediately after its done its job. listening again
can trigger again, but it should still die right after."*

So there is no idle timer, no countdown and no `idleTimeoutSec` any more. The
engine is started by `ensureRunning()` when a transcription needs it and stopped
by `MuScriptorServer::stopAfterJob()` the moment that transcription ends —
**success, failure or cancel**. The next transcription, including *Listen again*,
cold-starts it.

**`state: "stopped"` is therefore the normal resting state**, not an error. UI
that draws it as a fault is wrong.

The two rules the shutdown may never break, and how each is kept:

- **Never stop a server Riffsheet did not start.** Ownership comes only from
  `ServerRegistry` — the pid we wrote down when we spawned it — plus the
  process's own command line at the moment of the kill. An adopted server (the
  user's `START-MEDIUM.command` on 8222) is disconnected from, never killed.
  The single deliberate exception is `stopExternalEngine()` below, which no
  automatic path ever calls and which only a human can ask for.
- **Never stop it mid-job, anywhere on this machine.** The end of a job releases
  the machine-wide `EngineLock` **first**, so anybody queued behind it takes the
  engine within ~200 ms; the shutdown then refuses while the lock is held or any
  queue ticket exists. The queue drains and **the last finisher stops the
  server**. Two Riffsheets transcribing back to back therefore share one warm
  server and pay one shutdown, not two.

One log line per job, either way, e.g.

```
Riffsheet/MuScriptor: Closed the transcription server on port 8223 and gave back
1402 MB. (immediately after the transcription finished)
Riffsheet/MuScriptor: transcription finished; engine left running - Another
transcription is waiting to start, so the server stays up until the last one has
finished with it.
```

`stopEngine()` still exists for the chip in the header. It is mostly redundant
now — what is left for it is a server left up because the last job was queued
behind somebody else's — and it obeys exactly the same two rules.

#### `stopExternalEngine` — the way out of "Left running"

```ts
stopExternalEngine(): Promise<{
  ok: true,
  stopped: boolean,
  reason: string,               // always a sentence, whichever way it went
  port: number,                 // where it was; 0 when there was nothing
  pid: number,                  // what was ended; 0 when nothing was
  freedMb: number | null,       // what it was holding; null = unmeasurable
}>
```

Rule 1 above — *never stop a server Riffsheet did not start* — is the right
**default** and was a dead end. Somebody who force-quit the DAW that started the
server, or closed the Terminal window it came from, was being told by the *Left
running* notice to go and close a window that no longer exists, while 1.5 GB sat
there. This call is the same action with a human's explicit consent behind it,
and it is **the only path in the shell that may end a process Riffsheet did not
spawn**. Nothing calls it automatically.

**It takes no arguments, and it never will.** A `port` parameter would let the
page aim a kill, and the page is the least trustworthy thing in the system. The
target is only ever the server the *shell* found on its own reuse ports and is
already reporting through `engineStatus()`; the pid is re-derived from that port
inside the shell.

**What it proves before killing anything**, freshly, after taking the
machine-wide turn so nothing can start using the server between the proof and
the kill:

1. something is listening on that port and the listening **pid can be read** —
   no pid, no kill (so this does nothing at all on Windows, by design);
2. `ServerRegistry` has **no record** of that pid — a record would mean it is
   ours after all, and ours is `stopEngine()`'s job;
3. the process's **own command line** says `muscriptor` *and* `serve` — the same
   two-halves test the orphan reaper uses, so a shell sitting in the muscriptor
   folder or an editor with the source open is never a candidate;
4. it is **answering `/health`** as a MuScriptor right now.

Then `SIGTERM`, wait up to 5 s, `SIGKILL` if it is still there. If any of the
four fails the process is left completely alone and `reason` says which one.

**`stopped` is decided by the port, not only by the pid.** A killed process
whose parent has not reaped it yet is a zombie: it exists, holds no memory,
answers nothing and has released its socket. Reporting *"it would not stop, it
may belong to another user"* about one would be a lie, and that message is what
a user would act on. So the success test is "the process is gone **or** nothing
is listening on that port any more" — which is also strictly stronger for the
case the failure message is really about, since a process we genuinely may not
signal is still listening afterwards.

**Refusals are `stopped: false`, never `ok: false`.** "It is busy", "that is not
a MuScriptor", "it turned out to be ours" are *answers*, not faults — the same
convention `stopEngine()` already follows. It also refuses outright while
anything on this machine is transcribing or queued to: an external server is
exactly the kind another Riffsheet window borrowed and is mid-job against, and
their transcription is not ours to throw away either. That refusal cannot be
overridden.

**When to offer the button**: `engineStatus().canStopExternal`. Do not derive it
from `adopted` or from `externalServer` alone — on Windows the listening pid's
command line cannot be read, so `externalServer` is true while
`canStopExternal` is false, and a button drawn from the first can only ever
refuse. `hasNativeFunction('stopExternalEngine')` is the capability test for an
older shell, exactly as it is for `listEngines`.

The log line, either way:

```
Riffsheet/MuScriptor: Stopped the transcription server on port 8222 that
Riffsheet did not start, and gave back 1487 MB. (you asked to stop a server
Riffsheet did not start)
```

```ts
openEngineSetup(): Promise<{
  ok: true, path: string, venv: string, searched: string, instructions: string
} | { ok: false, error: string }>
```

This creates/reveals the platform's Riffsheet `engine` folder and writes `README.txt`; it never
downloads code or weights. `searched` is the newline-separated list of venv locations discovery
actually tried on this machine, and the same list is written into `README.txt`.

Discovery order (`resolveDefaultVenv` in `MuScriptorServer.cpp`), first hit that contains
`bin/muscriptor` wins:

1. `RIFFSHEET_MUSCRIPTOR_VENV`, when set.
2. `venv` from `<appSupport>/engine.json` — what worked last time.
3. The recommended per-user folder, `<appSupport>/engine/venv`, then `<appSupport>/muscriptor/venv`.
4. Bundled/portable layouts beside the executable.
5. Hand-built locations from before there was a contract: `~/.riffsheet/muscriptor/venv`,
   `~/Desktop/bakeoff/muscriptor/venv`, `~/Desktop/muscriptor/venv`,
   `~/Documents/muscriptor/venv`, `~/muscriptor/venv`, `/opt/muscriptor/venv`,
   `/usr/local/muscriptor/venv`.
6. `muscriptor` on `PATH`.

**`engine.json` is the setting that works inside a DAW.** A Finder-launched host inherits
launchd's environment, not the user's shell, so `RIFFSHEET_MUSCRIPTOR_VENV` is only reachable when
the host itself was started from a terminal. `<appSupport>/engine.json` —
`{"venv": "/path/to/venv", "selectedEngine": "auto"}` — always is, and the shell writes it itself
the first time discovery succeeds anywhere other than the recommended folder. When nothing is
found, the error names every location in the list above. The engine choice lives in the same file
(see `selectEngine`); each writer reads the object back and replaces only its own key, so neither
setting can clobber the other.

**The setup screen guides and finds; it never installs MuScriptor.** Settings → *Engine setup*
renders from `engineStatus()`: found-at/not-found, the numbered install steps (Python → venv →
`pip install muscriptor` → accept the model licence), the whole `searchedPaths` list, the
`engineConfigPath` to copy for a custom install, and *Check again* → `recheckEngine()`. The browser
mock reports the same fields so the screen is testable without a JUCE host
(`webcore/scripts/verify.mjs`).

**That screen is now one card among several.** The decision that used to be
open here has been taken: Riffsheet drives several engines, the setup screen is
a card per engine (`listEngines()`), and the Main menu carries a picker. The
MuScriptor card keeps every `data-role` the screen has today, because the
harness checks read them by name. What does **not** change is the rule this
paragraph was written for: **MuScriptor's weights are non-commercial and gated,
so Riffsheet can never install it for you** — its manifest carries no download
URL at all, and the build refuses to compile one that does. Engines that are
MIT/Apache and pass an audition get a real one-click install (`installEngine`,
landing with the installer wave); everything else stays a guide.

**`model` is the honest answer, not our setting.** Three cases:

| situation | `model` | `modelSource` |
|---|---|---|
| a server we started | the size we passed to `--model` | `"started by Riffsheet"` |
| somebody else's server, readable | the size from **its own command line** | `"read from the command line of the server on port 8222"` |
| somebody else's server, unreadable | `"unknown - this server was already running"` | `"unknown"` |
| nothing running yet | what `auto` would start | `"nothing is running yet"` |

MuScriptor's `/health` answers `{"status":"ok"}` and nothing else, and no other
endpoint names the model (checked against the installed `server.py`), so reading
the listening process's command line is the only truthful way to answer for a
server we did not start. When even that fails, the string says so rather than
guessing.

**`installedModels`** comes from the HuggingFace cache —
`<cache>/models--MuScriptor--muscriptor-{small,medium,large}` with real weights
behind the snapshot symlink. `HF_HOME` and `HUGGINGFACE_HUB_CACHE` are honoured.

```ts
setEngineModel(model: 'auto' | 'small' | 'medium' | 'large'): Promise<
    { ok: true,  model: string, restarted: boolean, reason: string, message?: string }
  | { ok: false, error: string }>
```

`restarted: true` means the old server has been **closed**; the new weights load
on the next transcription rather than blocking this call for up to four minutes.
`message` says that in a sentence you can show.

It refuses, politely, in two cases:

- **we adopted somebody else's server** — our setting is irrelevant to it, and
  saying "large" while their medium does the work would be the worst kind of lie;
- **something is transcribing right now** — restarting the server underneath a
  running job would lose it.

**What `auto` means.** Prefer the largest installed weights, then step down for
memory. Loaded, the server holds roughly 0.9 GB (small), 1.8 GB (medium) or 5 GB
(large), Python and the Metal buffers included.

1. Drop any size needing more than **40% of physical RAM** — so small wants a
   2.3 GB machine, medium 4.5 GB and large 12.5 GB. This 8 GB Mac therefore
   never picks large.
2. Then, if **free** RAM is under the model's estimate plus 400 MB, step down one
   size — but **never below the smallest thing installed**, because choosing
   something that is not on disk would start a download instead of helping.
3. Nothing installed at all → ask for `"medium"` and let the server download it,
   exactly as before.

Measured on this machine: 8192 MB total, ~1370 MB free, only `medium` installed →
**medium**, "Using the largest weights you have installed that this machine can
carry".

`RIFFSHEET_MUSCRIPTOR_MODEL` still overrides everything and disables
auto-selection.

### hostTimelineProbe — "what did the DAW actually say?"

```ts
hostTimelineProbe(): Promise<{
  ok: true,
  isPlugin: boolean,
  format: string,
  hostName: string,
  playHead: {
    hasPosition, isPlaying, isRecording, isLooping,
    hasBpm,                        bpm: number | null,
    hasTimeSignature,              timeSigNumerator: number | null,
                                   timeSigDenominator: number | null,
    hasPpqPosition,                ppqPosition: number | null,
    hasPpqPositionOfLastBarStart,  ppqPositionOfLastBarStart: number | null,
    hasTimeInSeconds,              timeInSeconds: number | null,
    hasTimeInSamples,              timeInSamples: number | null,
    hasBarCount,                   barCount: number | null,
    hasEditOriginTime,             editOriginTime: number | null,
    hasLoopPoints,                 loopStartPpq, loopEndPpq: number | null,
    hasFrameRate,                  frameRate: number | null,
  },
  captureMarks: { count, capacity, hitLimit, sampleRate, framesCaptured, marks: [...] },
  captureContext: CaptureContext,
  notes: string[],                 // plain sentences about what is missing and why it matters
}>
```

**This is the diagnostic to reach for before guessing.** Every value is paired
with whether the host reported it at all, nothing is derived, and `captureMarks`
is every playhead sample `TrackCapture` holds, raw. `notes` names the traps that
apply right now — a missing time signature, a denominator that is not a power of
two, the AU "beats vs quarter notes" mismatch.

It exists because of the `222 BPM 3/6 → 102 BPM 4/4` report: four layers could
have defaulted, and one call now says which.

### Original playback (the "original" side of the A/B fader)

```ts
playbackLoad(token: string | null): Promise<PlaybackState>
playbackTransport(action: "play" | "pause" | "stop" | "seek",
                  seconds?: number): Promise<PlaybackState>
playbackSetGain(linearGain: number): Promise<PlaybackState>   // 0.0 .. 4.0
playbackDiagnostics(): Promise<PlaybackDiagnostics>
```

**`playbackLoad(null)` unloads** — new in v1.3, and not cosmetic. The transport is
one of the things that keeps a take in memory (see *How long a token lives*), so
replacing a wav with a MIDI file has to be able to say "nothing". Without it the
wav's ~100 MB stays held by a transport nobody is listening to for the life of
the instance. It answers `{ loaded: false, token: "" }` and is never an error.

```ts
type PlaybackState = {
  loaded: boolean, isPlaying: boolean,
  positionSec: number, lengthSec: number,
  gain: number, token: string,
}
```

Audio comes out of the plugin's own output, mixed on top of whatever the track
is already carrying, so it is audible in the DAW. The MIDI side of the fader is
webcore's job (Web Audio).

**`positionSec` is a correction, not a clock.** It arrives up to 20 times a
second and only when it changed, so "no report" and "position 0" and "the audio
thread stopped running" all look the same from the page. A transport that reads
its time from this stream freezes whenever the stream does. Anchor on
`performance.now()` and use these reports to nudge the anchor — that is what
`webcore/src/audio/transport.ts` does, and why.

**`loaded: false` means there is nothing behind the transport** (a token that
never made it across). Do not wait for it to become true; carry on and say so.

#### playbackDiagnostics — numbers for "playback stalled"

```ts
type PlaybackDiagnostics = {
  ok: true,
  blocksRendered: number,        // audio blocks that actually mixed
  blocksSkippedLocked: number,   // try-lock failed -> that block was silence
  blocksSkippedEmpty: number,    // asked to play with nothing loaded
  sampleRate: number,
  loaded, isPlaying, positionSec, lengthSec,
}
```

Pull-only, never pushed: these move every audio block, and `playbackPosition` is
change-gated precisely so an idle plugin is silent. Reading them:

| symptom | reading |
|---|---|
| `blocksRendered` stopped climbing | the host is not calling us at all |
| `blocksSkippedLocked` climbing | the message thread is starving the audio thread |
| `blocksSkippedEmpty` climbing | told to play with nothing loaded |
| all three healthy, playhead frozen | the fault is on the web side, not here |

webcore folds this into `await window.__RIFFSHEET_CLOCK__()`, which prints the
shell's counters and the page's clock counters side by side.

#### pcmDiagnostics — is the audio store growing?

```ts
pcmDiagnostics(): Promise<PcmStoreStats & { ok: true }>
```

```ts
type PcmStoreStats = {
  entries: number,        // takes something is still holding — THE number
  trackedTokens: number,  // map slots, live plus not-yet-swept
  frames: number,
  bytes: number,
  megabytes: number,
  holds: {
    handedOut: string,    // the shell's automatic hold, "" when there is none
    playback: string,     // what the transport holds, "" when unloaded
    session: string[],    // what you declared with pcmRetain
  },
  list: Array<{
    token: string, name: string,
    sampleRate: number, durationSec: number,
    frames: number, bytes: number, megabytes: number,
    holders: number,          // how many references it still has
    hasSourceFile: boolean,
    sourceFileIsTemp: boolean, // a temp WAV the shell wrote; deleted with the entry
  }>,
}
```

Pull-only, like `playbackDiagnostics()` — nothing pushes it, so an idle plugin
stays silent. The same object is returned as `store` by `pcmRetain` and
`pcmRelease`.

**This exists to make the leak impossible to reintroduce.** Open several takes in
a row and `entries` must come back **down**. If it climbs once per open,
something is holding on, and `holds` plus `list[].holders` says what.

| symptom | reading |
|---|---|
| `entries` climbing with every take opened | a holder is not letting go — the regression |
| `entries` small, `megabytes` large | normal. One ten-minute take is ~106 MB by itself |
| `trackedTokens` >> `entries` | harmless. Dead slots are swept on the next lookup; the audio is already gone |
| `holders` is 0 for a live entry | it is being read right now by the call you just made, and nothing else wants it |

### Track capture — transcribe the DAW track directly

```ts
captureStart(options?: {
  armToTransport?: boolean,   // wait for the host to roll, stop when it stops
  maxSeconds?: number,        // default 300 (5 min); capture stops at the cap
}): Promise<CaptureState>

captureStop(): Promise<AudioRef & {
  isCapture: true,
  hitLimit: boolean,
  captureContext: CaptureContext,
}>

captureStatus(): Promise<CaptureState>
```

```ts
type CaptureState = {
  mode: "off" | "armed" | "recording" | "finished",
  armedToTransport: boolean,
  secondsCaptured: number,
  maxSeconds: number,
  sampleRate: number,
  hitLimit: boolean,
}
```

Records the plugin's **input** — the track's own audio, before anything Riffsheet
adds. Mono-summed, kept at the host's sample rate, no resampling.

The returned `AudioRef.path` is a finished 24-bit WAV under Riffsheet's
application-support `takes` folder. It is written through a same-folder partial
and renamed only after the WAV header is flushed. Unlike a PCM token, this path
survives a process/project reload; unlike transcription scratch files, durable
takes are user data and are never deleted automatically.

**The shell does not trim.** You get the raw take including leading silence,
because webcore and the pipeline need the true offsets to line the score up with
the host timeline. Trimming is yours to do.

`armToTransport: true` returns an error in Standalone (there is no host
transport). Plain `captureStart()` works in Standalone, but note the JUCE
standalone mutes audio input by default to avoid a feedback loop — the user has
to enable input under Options → Audio/MIDI Settings first, or the take is silence.

#### CaptureContext — the host's musical timeline

```ts
type CaptureContext = {
  hasHostTimeline: boolean,          // false in Standalone / a silent host
  hostBpm: number | null,            // tempo at the moment capture started
  hostBpmKnown: boolean,
  hostTimeSigNumerator: number | null,
  hostTimeSigDenominator: number | null,
  hostTimeSigKnown: boolean,         // v1.2
  hostTimeSigInferred: boolean,      // v1.2 - the host reported it late
  hostTimeSigChanged: boolean,       // v1.2 - it changed during the take
  hostTimeSigUnusual: boolean,       // v1.2 - denominator not a power of two
  startPpq: number | null,           // host ppq at capture start
  startPpqOfLastBarStart: number | null,   // v1.2, null when the host did not say
  marksHitLimit: boolean,            // v1.2 - more tempo changes than we can record
  barStartsSec: number[],            // bar lines, in seconds from capture start
  tempoChanges: Array<{
    timeSec: number,                 // seconds from capture start
    bpm: number | null,
    timeSigNumerator: number | null,
    timeSigDenominator: number | null,
    ppqPosition: number | null,
  }>,
  ambiguities: string[],             // v1.2 - plain sentences, safe to show a user
}
```

Sampled from the playhead on the audio thread. A mark is recorded at the start of
the take and again whenever tempo, time signature or ppq continuity actually
changes, so a constant-tempo take costs one mark and a tempo ramp still gets
captured properly (cap: 4096 marks, and `marksHitLimit` says when that was hit).

`barStartsSec` is walked across the tempo segments, so bar lines stay correct
across a tempo change. Everything is `null` / empty when the host reports
nothing — do not treat that as 0 bpm.

**Changed in v1.2, and this is the DAW-grid bug.** The meter used to be read from
the **first block of the take** alone. A host that raises `kTimeSigValid` a block
or two late left `hostTimeSigNumerator` null, and null was then read downstream as
`?? 4` — which is how a DAW set to 3/6 could be drawn as 4/4. Now:

- the meter comes from the **first mark that actually carries one**, with
  `hostTimeSigInferred: true` when that was not the first block;
- when no mark carries one, the numbers stay `null`, `hostTimeSigKnown` is
  `false`, and `ambiguities` explains it in a sentence;
- and **no bar lines are emitted at all** in that case. The old code laid bars
  down on an assumed 4/4, which puts every bar line in the wrong place while
  looking completely confident. Bar lines nobody reported are invented musical
  information (design notes §4.8), and a bar line in the wrong place is worse than
  no bar line.

**Never fill a missing number in with a default.** If `hostTimeSigKnown` is false,
say the DAW did not report a meter — do not show 4/4. `ambiguities` is written to
be shown as-is.

### Output

```ts
exportFile(name: string, base64Contents: string): Promise<
    { ok: true,  path: string, bytes: number }
  | { ok: false, cancelled: true }        // user dismissed the panel
  | { ok: false, error: string }>         // something actually went wrong
```

**A save has three outcomes, not two.** Cancelled is not an error and not a
success. Treating it as success is what made the app toast "Exported" after the
user pressed Cancel — check `cancelled` before you say anything.

```ts
exportFiles(files: Array<{ name: string, contents: string }>): Promise<
    { ok: true,  paths: string[], path: string, bytes: number }
  | { ok: false, cancelled: true }
  | { ok: false, error: string }>
```

**Several related files, ONE save panel.** The first entry names the panel;
whatever the user types there becomes the stem for all of them, with each
entry's own suffix kept:

```js
await exportFiles([
  { name: "riff.mid",           contents: b64(quantized) },
  { name: "riff-as-played.mid", contents: b64(asPlayed)  },
]);
// user types "take3.mid" -> take3.mid + take3-as-played.mid
```

The suffix is the part of an entry's name that the *first* entry's name does not
have (`riff-as-played` minus `riff` → `-as-played`). Everything is decoded before
the panel opens and cancelling writes nothing at all, so a half-written set is
not a state that exists.

```ts
beginMidiDrag(name: string, base64Contents: string): Promise<
    { ok: true,  started: true,  path: string, bytes: number }
  | { ok: false, started: false, path: string, error: string }
  | { ok: false, error: string }>
```

Stages the bytes as a real file and starts an **operating-system** drag carrying
its path — which is what a DAW track accepts. See §4b for the timing rules,
which are not optional.

```ts
log(level: string, message: string): Promise<{ ok: true }>
```

`log()` puts a line in the same stream as the native logs, which in a DAW is the
only place plugin output is visible. Use it.

### Per-instance state — the fix for plugin amnesia

```ts
getPersistedState(): Promise<{ ok: true, state: string | null, bytes: number }>
setPersistedState(json: string | null): Promise<
    { ok: true,  bytes: number }
  | { ok: false, error: string }>        // over the 8 MB cap; the old blob is kept
```

**Read this before touching anything about page lifetime.** In REAPER, clicking
another track or another FX **destroys the plugin editor**. The `WebBrowserComponent`
goes with it, the document is torn down, and every JavaScript object in the page —
the loaded take, the engraved score, the user's edits — ceases to exist. Coming
back constructs a brand-new editor and loads the page from scratch. The user
reported this twice as "the plugin is empty when I come back".

Nothing in the page can survive that, so nothing important may live only in the
page. `getPersistedState`/`setPersistedState` park a blob on the **processor**,
which is the thing that outlives the editor (§5). The page writes on every
meaningful change and reads once on boot.

- The string is **opaque to the shell**. It is never parsed here. webcore owns the
  schema and versions it (`webcore/src/app/persist.ts`), so the two sides move
  independently.
- `state: null` means *nothing has ever been stored* — a fresh instance. It is
  deliberately distinct from `""`, which is what a page that cleared itself wrote.
- The same blob is written into **`getStateInformation()`**, so it also survives
  saving and reopening the DAW project, and — via JUCE's own standalone wrapper,
  which reloads plugin state on launch and saves it on quit — across restarts of
  the standalone app. One mechanism, three lifetimes.
- 8 MB cap (`RiffsheetAudioProcessor::maxPersistedWebStateBytes`). Over it, the
  call answers `{ok:false}` and the **previous** blob is left intact. It exists to
  catch a bug, not to constrain honest use: a riff's notes, quantised waveform
  peaks and edit log come to ~13 KB.
- Both are registered unconditionally, so `hasNativeFunction('getPersistedState')`
  is a truthful capability test. An older shell simply does not offer them and the
  page degrades to "no session restore", which is the pre-existing behaviour.

**What webcore puts in there, and why it is small:** the detected notes, not the
score. The score is a pure function of the notes, the settings and the bar-1
position, and rebuilding it costs milliseconds against seconds for a
transcription — so a restore never re-listens to the audio. The waveform peaks
ride along quantised to one byte per bucket (~5 KB) so the strip draws without
re-fetching a few million floats.

**Recovering the audio itself** is a separate problem, because a `token` is only
good for the life of the process. webcore stores the token *and* the path and
tries them in that order: the token covers the editor-destroyed case (the
`PcmStore` is still sitting on the processor), `loadAudioPath` covers the
project-reload case. Every captured, picked or dropped recording is promoted to
the owned `takes` directory first, so restore remains functional without granting
an untrusted project-state blob permission to read arbitrary filesystem paths.

---

## 3. Events (native → JS)

```js
window.__JUCE__.backend.addEventListener("playbackPosition", (p) => { ... });
```

| Event | Payload | When |
|---|---|---|
| `playbackPosition` | `PlaybackState` | up to 20 Hz, only when it changed |
| `captureState` | `CaptureState` | up to 20 Hz, only when it changed |
| `hostInfo` | same as `getHostInfo()` | up to 20 Hz, only when it changed |
| `transcribeProgress` | see below | during a transcription |
| `transcribeResult` | see below | once, when a transcription ends |
| `inputFileDropped` | `AudioRef`, `InputBytes`, or `{ok:false,name,error}` | OS-drop fallback; same universal import result as `pickInputFile` |

All three state events are change-gated: identical payloads are not re-sent, so
an idle plugin is silent.

```ts
// transcribeProgress
{ jobId, stage: "queued",       queuePosition, holder, message: string } // waiting our turn
{ jobId, stage: "server",       message: string }                       // startup
{ jobId, stage: "transcribing", completed, total, fraction }            // 5s chunks
{ jobId, stage: "beats",        message: string }                       // preciseBeats
```

`stage: "queued"` arrives while another transcription — in another plugin
instance, in the standalone app, or in another process entirely — has the engine.
`queuePosition` is 1-based, so **1 means "you are next"**. `holder` is a
human-readable label for whoever has it, or `""` if that is not known yet. It
repeats when the position changes and every couple of seconds otherwise, so the
UI can stay alive rather than looking hung. Cancel it with `transcribeCancel()`.

```ts
// transcribeResult
{
  jobId: number,
  ok: true,
  notes: Array<{
    pitch: number,        // MIDI note number (GM percussion key when instrument==="drums")
    start: number,        // seconds, onsetDelay already subtracted
    end: number,
    instrument: string,
    index: number,
    confidence?: number,  // 0..1, ONLY from engines that measure it — see below
  }>,
  beatGrid: {
    bpm: number,
    beatsPerBar: number | null,   // null when the meter was not confident
    firstDownbeat: number,        // seconds
    onsetDelay: number,
  } | null,                       // null when no stable tempo was found
  onsetDelay: number,
  midiBase64: string,             // a complete SMF (format 1, 480 PPQ)
  truncated: boolean,             // stream ended early
  elapsedMs: number,
  sourcePath: string,
  preciseBeats?: { beats: number[], downbeats: number[], bpm, beatsPerBar },
  preciseBeatsError?: string,

  // Present ONLY when this engine asked for preprocessing and the player left it
  // on - so a job with nothing to prepare reports exactly the payload it always
  // did. Every time above is ALREADY mapped back; this is the receipt, not work
  // for the caller. See "Before an engine hears it".
  preprocess?: {
    applied: boolean,       // a prepared copy was made; false = the original file was used
    note: string,           // one sentence for the player, never empty
    cents: number,          // what the estimate said, acted on or not; 0 when none was made
    concentration: number,  // 0 = the partials disagree, 1 = they agree
    peaks: number,          // partials weighed; 0 means no estimate ran
    pitchRatio: number,     // 1 when the timebase was not touched
    gainDb: number,         // 0 when the level was not touched
    peakDbfs: number,       // of the mono mix the engine would hear, before any gain
  },
}
// or
{ jobId, ok: false, error: string }
```

Notes on the note list:

- **There is no velocity.** MuScriptor's model emits a binary on/off and its MIDI
  writer hardcodes 100. Do not render dynamics from it.
- **`confidence` is per engine and optional.** Basic Pitch reports the mean frame
  probability over the note, clamped to 0..1
  (`BasicPitchAdapter.cpp:224`); MuScriptor and the sidecar engines report
  nothing, because a binary on/off and a MIDI file have no such number to give.
  A missing field therefore means "this engine does not measure it", never "this
  note is doubtful". The page carries it through the bridge and draws nothing
  from it today.
- `start`/`end` are seconds on a 10 ms grid, with the server's `onsetDelay`
  already subtracted (the raw stream runs late against the beat grid; the
  server's own MIDI export corrects for it, so the shell does too).
- `beatGrid` gives a **constant-tempo** grid only. The HTTP API deliberately
  drops the tracked per-beat times. For a rubato take, pass
  `preciseBeats: true` — the shell then runs `beat_this` over a bundled ONNX
  model **in this process** and returns real beat/downbeat times in
  `preciseBeats`. It needs no venv and no Python, so it works on every engine
  including the built-in one. It costs an extra pass, so it is off by default.

Measured on a 6 s synthetic 100 bpm bass riff: 7 notes, 4.9 s wall clock,
`beatGrid.bpm = 100.03`.

---

## 4. Drag and drop

Two paths, because the WebView usually eats native drops before JUCE sees them:

1. **HTML5 (use this).** The page's own `drop` handler gets `DataTransfer.files`
   normally. Read the bytes and hand them over:

   ```js
   const buf = await file.arrayBuffer();
   const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));  // chunk it for big files
   const ref = await importDroppedFile(file.name, b64);
   ```

   The returned path is the durable app-support WAV described in **Audio in**,
   not the temporary file used to transfer the browser bytes.

2. **Native (`inputFileDropped` event).** Fires only if JUCE receives the drop
   rather than the WebView. Audio is decoded and promoted exactly like Open;
   MIDI, symbolic scores, printed scores and `.riffsheet` documents arrive as
   bounded `InputBytes` and enter the same universal web importer.

Handle both; they are not mutually exclusive.

---

## 4b. Dragging a file OUT — onto a DAW track

`beginMidiDrag(name, base64)` (§2) is the only way to do this. An HTML5 drag can
hand bytes to another **web page**; it cannot hand a **file** to another
application, and a REAPER track will only take a file. So the page supplies the
bytes and the shell stages them and starts a genuine OS drag carrying the path.

**The timing is the whole trick, and it is easy to get wrong.** macOS will only
open a dragging session from inside a live mouse-drag — JUCE reaches for the
window's `currentEvent`, and if that is not a mouse event there is nothing to
attach the session to. So:

- call it on **pointermove while the button is still down**, after a few pixels
  of travel;
- **not** from an HTML5 `dragstart` handler — that fires asynchronously and the
  event has gone by the time it runs;
- **not** from `click` — far too late.

```js
button.addEventListener('pointerdown', (down) => {
  if (!bridge.beginMidiDrag) return;          // browser: no OS drag exists
  let armed = true;
  const move = (e) => {
    if (!armed || Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 4) return;
    armed = false;
    cleanup();
    void bridge.beginMidiDrag('riff.mid', midiBytes);   // mouse is still down
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', cleanup);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', cleanup);
});
```

Also set `draggable="false"` on the button, or WebKit's own drag machinery
starts first and swallows the gesture.

`started: false` means the OS refused the session — report it and leave the
normal save dialog as the way out; never let the user drag and get nothing.

The staged file lives in a per-instance temp folder that is cleared on the next
drag and deleted when the editor closes, so `canMoveFiles` is **false**: the DAW
copies what it wants at drop time.

Only registered on platforms where it works, so `hasNativeFunction('beginMidiDrag')`
is a truthful capability test rather than a call that might reject.

---

## 5. Threading and lifetime

- Native functions are invoked on the message thread. Anything slow (decoding,
  transcription) runs on a 2-thread pool and completes the Promise from there.
- The PCM store and the MuScriptor server live on the **processor**, not the
  editor. Closing the plugin window does not kill a transcription in flight.
- **The editor is disposable and the processor is not.** In REAPER, selecting
  another track destroys the editor and the whole WebView with it. Anything that
  must survive that belongs on the processor: the PCM store, the server, the
  editor size, **every hold on a decoded take** (§2, *How long a token lives*),
  and — since the amnesia fix — the web app's own state blob (§2,
  *Per-instance state*). If you find yourself adding a member to
  `RiffsheetAudioProcessorEditor` that the user would be upset to lose, it is on
  the wrong object. `NativeBridge` is an editor member, which is exactly why the
  token holds are not on it.
- `processBlock` never allocates or locks: capture storage is preallocated by
  `captureStart()` and published to the audio thread by a release-store; the
  playhead snapshot and MIDI queue use `tryEnter` and simply skip a block rather
  than block the audio thread.
- **The audio thread never touches a `shared_ptr` refcount.** Since v1.3 playback
  reads the shared immutable `PcmStore::Entry` directly instead of a second copy
  of it. The entry is kept alive by `loadedEntry` on the processor, which is only
  ever swapped under `playbackLock` by the message thread; `processBlock` reads a
  raw pointer, a length and a rate published under that same lock. The reason the
  audio thread must not copy or reset that pointer is that a refcount decrement
  which happened to be the last one would run `~Entry` — a ~100 MB free plus, for
  a capture, deleting its temp WAV — on the audio thread. For the same reason,
  the displaced entry in `updateTransportSourceFor()` is released *after* the
  lock is dropped: freeing 100 MB while holding `playbackLock` would fail every
  `processBlock` try-lock for the duration, which is an audible dropout in
  disguise. (That is the same fault the old `makeCopyOf`-under-the-lock had; the
  copy is gone, the reasoning is not.)
- **Temp files belong to their entry.** A capture rendered to WAV by
  `transcribe()`, and a file dropped onto the page (which arrives as bytes and is
  staged in `/tmp`), are deleted when the entry that owns them is destroyed. A
  transcription therefore holds its entry for the whole job, so the file
  MuScriptor is uploading cannot be pulled out from under it. A force-quit still
  leaves them behind, the same way it leaves an orphan server.
- **Waiting for the engine happens on the worker pool**, in the same job that
  runs the transcription. It can take minutes and that is fine there. Closing the
  plugin window raises a shutdown flag that every job polls, so a queued job
  abandons in about 200 ms instead of leaving the message thread waiting on the
  pool.

### What Riffsheet keeps in Application Support

`~/Library/Application Support/Riffsheet/` (`%APPDATA%\Riffsheet` on Windows,
`~/.config/Riffsheet` on Linux). All of it is small, readable, and safe to
delete while Riffsheet is not running.

| File | What it is |
|---|---|
| `engine.lock` | zero bytes. The **kernel file lock** that makes "one transcription at a time" true across processes. Released by the OS the instant the owning process dies, which is why a force-quit during a transcription blocks nobody. |
| `engine-owner.json` | who holds it, since when, and a label — refreshed by a heartbeat while held. Purely for showing a human; it never decides who gets the engine. |
| `queue/*.ticket` | one per waiter, named with the millisecond it arrived. Oldest goes next. A ticket whose process is gone, or whose heartbeat is over ten seconds old, is deleted by whoever notices. |
| `servers.json` | every MuScriptor server Riffsheet started: server pid, port, the Riffsheet that owns it, and the model. |
| `engine.json` | the two settings a Finder-launched DAW can actually read: `venv` (where MuScriptor was found) and `selectedEngine` (`'auto'` or an engine id, written by `selectEngine`). Hand-editable; each writer preserves the other's key. |

**The orphan-server fix.** Riffsheet used to kill only the child it started, and
only on a clean shutdown — so a force-quit left a server running with 1.5 GB and
nobody left who knew it was there (design notes §5.3, §6.2). On startup Riffsheet
now walks `servers.json` and, for each entry:

- pid gone → forget it. Pids get recycled; **never kill**.
- alive, but its own command line is not a MuScriptor server → forget it, never
  kill. That pid belongs to somebody else now.
- the Riffsheet that started it is still running → leave it completely alone.
- **orphan that answers `/health`** → do not kill it. Take responsibility for it:
  it is a perfectly good warm server, the adopt path will reuse it, and recording
  ourselves as its new owner means this run's clean shutdown finally clears it up.
- **orphan that does not answer** → close it. This is the actual harm — a wedged
  process sitting on port 8223 that nothing can use and nothing will clean up.

Nothing is killed unless Riffsheet wrote the pid down **and** the process's own
command line still identifies it as a MuScriptor server **and** nobody is using it
**and** it has stopped answering. A server the user started themselves is never in
`servers.json` and so can never be a candidate. On Windows another process's
command line cannot be read cheaply, so the identification always fails and the
reaper does nothing at all — the right way round to be wrong.

The reaping runs on a worker thread (it shells out to `ps` and `lsof`), once per
process, before the first transcription or the first `engineStatus()` poll.

---

## 6. Asked for by webcore, and not needed after all

Recorded so nobody builds these on spec.

**A general file read (`readFile(path)`) — not needed.** The playback sampler
("Finger bass (samples)", `webcore/src/audio/sampler.ts`) was going to read the
user's own multisample folder through the bridge. It does not: the nine notes
are copied into `webcore/public/samples/finger-bass/` — 1.3 MB in total, MIT
licensed — and fetched like any other bundled asset. That works over `juce://`,
over `http://` in the browser, and needs no filesystem permission anywhere.
Adding a path-taking read call to a plugin bridge for 1.3 MB of static audio
would be all cost and no benefit.

**HTML-to-PDF — not needed.** The PDF button renders its own bytes in the page
and hands them to `exportFile`, so it wants nothing from the shell beyond the
save panel that already exists. `WKWebView::createPDF` would give vector text
instead of a 200 dpi raster, which is a genuine upgrade if file size ever
matters — but it is a nice-to-have, macOS-only, and nothing is blocked on it.
