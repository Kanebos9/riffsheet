# Credits and third-party code

Riffsheet's web core stands on other people's work. This file records what, and under what terms.

---

## alphaTab — the notation renderer

**License:** Mozilla Public License 2.0
**Copyright © Daniel Kuschny and Contributors**
<https://github.com/CoderLine/alphaTab> · <https://alphatab.net>

Used as a dependency (`@coderline/alphatab`, pinned to 1.8.4) and its Vite plugin
(`@coderline/alphatab-vite`). Not modified. MPL-2.0 is a file-level copyleft: as long as we do not
modify alphaTab's own source files, our code is unaffected. If we ever vendor and patch it, the
patched files must stay MPL-2.0 and be published.

alphaTab engraves the standard staff and the tablature in one layout pass, and publishes
`BoundsLookup` — the per-note geometry API that the note-names row and all hit-testing are built
on.

alphaTab's own licence header also records the components incorporated in its distributed bundle:
TinySoundFont (MIT, Bernhard Schelling), SFZero (MIT, Steve Folta), the Haxe standard library
(MIT, Haxe Foundation), SharpZipLib (MIT, its contributors), NVorbis (MIT, Andrew Ward), and
libvorbis-derived code (BSD-3-Clause, Xiph.org Foundation). The pinned package contains the full
MPL-2.0 text and detailed notices in `LICENSE` and `LICENSE.header`; the build copies both to
`dist/third-party/alphatab/`, so they are included in every embedded release bundle.

### Bravura — the music font

**License:** SIL Open Font License 1.1
**Copyright © Steinberg Media Technologies GmbH**
Shipped inside `@coderline/alphatab` (`dist/font/`) and copied from that pinned dependency during
the web build. The OFL, FAQ and FONTLOG travel with it in `dist/font/`.

### SONiVOX soundfont

alphaTab includes this as an optional player asset, but Riffsheet does not copy or distribute it.
alphaTab runs in `PlayerMode.EnabledExternalMedia` and follows Riffsheet's clock; the audible score
voices are the credited sample sets below.

---

## Bundled playback samples

Every sample directory carries its own `LICENSE.txt`; those files are copied
unchanged into the embedded web bundle and remain the authoritative notices.

**Where they came from, in one line:** these are not sampled by Riffsheet. They
were taken from the author's own multisample library — assembled for BASAMAK, an
earlier project of his, and reused here by the same copyright holder — and that
library's own sources are the two freely licensed sets credited below. The
sections below name the upstream for each set, which is what the licences ask
for; BASAMAK is only the route the files travelled, and adds no terms of its own.

### Finger bass, electric piano, electric guitar and steel guitar

**License:** MIT
**Copyright © 2000-2002, 2008, 2013 Frank Wen**

Samples extracted from the **FluidR3 GM** soundfont by Frank Wen, by way of the
author's BASAMAK library. The source sets were converted to PCM WAV so the JUCE
webviews do not depend on an optional platform FLAC decoder. They live in
`public/samples/finger-bass/`, `electric-piano/`, `electric-guitar/`, and
`steel-guitar/`. The MIT notice travels with each folder as `LICENSE.txt`.

### Upright piano and marimba

**License:** Creative Commons CC0 1.0 (public-domain dedication)

Samples from the **Versilian Community Sample Library (VCSL)**, by way of the
same BASAMAK library. They live in `public/samples/upright-piano/` and
`public/samples/marimba/`. Riffsheet's WAV conversions and tail fades do not add
restrictions to the source material.

---

## @riffsheet/pipeline — the notation pipeline

**License:** GPL-3.0-only; part of this project.

Not third-party, but recorded here because webcore depends on it completely: every bar, every
tuplet, the MusicXML and both MIDI variants come from `../pipeline`. webcore's own mock IR, mock
quantizer and MIDI writer were deleted once it landed rather than kept as a parallel path. The
seam, and the two integration traps, are documented in [`IR.md`](IR.md).

---

## Escala — the editing command pattern

**License:** MIT
**Copyright (c) 2022 Gabriel Allegretti**
<https://github.com/gallegretti/escala>

`src/edit/actions.ts` is an adaptation, not a copy. What was taken is the *design*: an
action object with paired `do`/`undo`, a previous-value memento captured at `do` time, and the
split where actions merely report `{ requiresRerender, requiresMidiUpdate }` while a single place
performs the render and the MIDI reload. Also taken: the specific list of cross-note relationships
(`hammerPullOrigin`, `hammerPullDestination`, `slideOrigin`, `slideTarget`) that must be unlinked
before removing a note, which is the kind of detail you only learn by hitting the crash.

Three deliberate departures, documented in the file header and repeated here because they matter:

1. **A bug was fixed on the way in.** Escala's `EditorActions.doAction` truncates the redo tail
   with `this.actions.slice(this.actionsIndex + 1)`, which keeps the *undone* tail and discards the
   real history — do A, do B, undo, do C leaves `['B','C']` instead of `['A','C']`. Ours uses
   `slice(0, index + 1)`. Their test suite never exercises undo-then-new-action, which is why it
   survived. Worth reporting upstream.
2. **Stable ids instead of live object references.** Escala's undo stack holds `alphaTab.model.Note`
   instances, so any reload invalidates it and they clear history on open/new. Riffsheet rebuilds
   the score whenever the pipeline re-runs (a settings change, a bar-1 marker drag), so ours keys on
   the IR's stable note ids and resolves to live objects at apply time.
3. **Composite actions.** One user gesture is one undo entry. Escala pushes N entries for what the
   user experienced as one action.

Also noted from their code and *not* copied: they cast `loadMidiForScore()` through `as any`
because it was private in alphaTab 1.3. It has been public since 1.6.0, so we call it directly.

---

## Basscribe — the predecessor

The previous app by the same copyright holder is GPL-3.0. Three patterns were ported, each with
its bugs fixed:

- **The tooltip system** (`src/ui/tips.ts`) — registration via the plain `title` attribute, hoisted
  into `data-riff-tip` so the native OS tooltip never fires, with a capture-phase document listener.
  Fixed: the hoist was permanent, so turning tooltips off left every already-hovered element
  showing tips forever, and an off→on cycle resurrected the native tooltip. Also fixed: edge
  clamping was right/bottom only, so tips could run off the left in a narrow window.
- **The clock discipline** (`src/audio/transport.ts`) — rAF *samples* an authoritative audio clock
  rather than accumulating its own time. This is the single best idea in the old codebase.
  Fixed: `stop()` is now composed as pause-then-rewind, because `seek(0)` alone resumed playback
  from the top when pressed mid-play.
- **The equal-power crossfade law** (`cos`/`sin`) — kept exactly. Fixed: both sides now live in one
  WebAudio graph with ramped `setTargetAtTime` gains instead of one `el.volume` and one `GainNode`
  assigned per pixel of drag, which was zipper noise.
- **The waveform peak drawing** — inverted to iterate screen columns rather than peak buckets, so
  density is correct at any width.

The design tokens in `src/ui/styles.css` are deliberately inherited so the two apps read as
siblings.

---

## Research

The renderer choice, offline font recipe and alphaTab integration hazards came from the project's
completed Phase-0 measurements and alphaTab's public documentation. The temporary measurement
page is no longer part of the product; the load-bearing results remain documented beside the code
they govern.
