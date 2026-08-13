/**
 * MULTI-PART SCORES — N instruments, ONE document.
 *
 * A guitar part over a bass part is not a new pipeline. It is N ordinary `buildScore` runs that
 * share a clock, merged at the OUTPUT layer: one `score-partwise` document with a real
 * `<part-list>`, one `AlphaTabScoreData` with N tracks, one format-1 MIDI file. The IR itself is
 * untouched and stays what it has always been — ONE part's engraving — because every invariant it
 * carries (ties, tuplet balance, type-vs-duration, the measure cursor, the grand-staff split) is a
 * statement about one part's staves and means nothing across parts. Teaching those invariants to
 * count to N would have been the invasive change; keeping N of them is the cheap one.
 *
 * WHAT PARTS SHARE, AND IT IS EXACTLY TWO THINGS:
 *
 *   THE CLOCK.  Same tempo, same meter, same bars, bar 1 aligned. The time skeleton is derived
 *               once from every note in the score (see `buildScore`'s `sharedNotes`), so a bass
 *               that comes in on bar 3 does not number that bar 1, and a guitar with a pickup
 *               does not hand the bass an anacrusis it never played. A part may still be nudged
 *               against that clock by a fixed offset in seconds — see `nudgeSec`.
 *   THE KEY.    One key signature per score, for the same reason: two parts of one piece printing
 *               different accidentals is not a transcription, it is a bug.
 *
 * EVERYTHING ELSE IS THE PART'S OWN. Clefs, grand staff, tuning, tab, string assignment, rests,
 * beams, stats, diagnostics — all decided from that part's notes alone, exactly as they are on a
 * single-part build. One part's content can never reach another's engraving, because no code path
 * exists by which it could.
 *
 * A SINGLE-PART SCORE COMES OUT UNCHANGED, BYTE FOR BYTE, on all three emitters. That is not a
 * happy accident; it is the point of merging at the output layer, and `multipart.test.ts` proves
 * it against every golden case. webcore can therefore route ALL builds through
 * `buildMultiPartScore` and never branch on part count.
 */

import { buildScore, type BuildDiagnostics, type BuildResult } from './buildScore.js';
import { applyGuards } from './guards.js';
import { type Projection } from './projection.js';
import { buildTimeSkeleton } from './timeSkeleton.js';
import { type IRBar, type RiffsheetIR } from './ir.js';
import { toMultiPartMusicXML, abbreviatePartName, defaultPartName, type MusicXmlOptions } from './musicxml.js';
import { toMultiPartMidi } from './midi.js';
import { toMultiPartAlphaTabModelData, type AlphaTabScoreData } from './alphatab.js';
import {
  DEFAULT_FINGERING_STYLE,
  DEFAULT_TUNINGS,
  type BuildInput,
  type BuildSettings,
  type ClefMode,
  type FingeringStyle,
  type InputNote,
  type Instrument
} from './types.js';

/**
 * The cap, and it is a product decision rather than a technical one: four staves is what fits on
 * a page and what the part picker was designed for. Nothing below would break at five.
 */
export const MAX_PARTS = 4;

/** Which take a part is. Only the live one is ever played; imported parts are engraved only. */
export type PartRole = 'live' | 'imported';

/**
 * ONE PART OF THE SCORE. Array order is PRINTED ORDER, top to bottom.
 *
 * `notes` is the part's content in the form the app already produces it: audio detections for the
 * live take, and for an imported part the same `InputNote`s carrying `sourceTiming` / `sourceBars`
 * / `sourceClef` that a MusicXML or MIDI import attaches today. The pipeline's internal 'exact'
 * path is chosen per part exactly as it is on a single-part build, so an imported part keeps its
 * written ticks while the live take beside it is quantized.
 */
export interface ScorePart {
  notes: InputNote[];
  /**
   * Printed part name ("Guitar", "Bass"). Omitted, the part names itself after its instrument and
   * tuning, which is what a single-part score has always printed.
   */
  name?: string;
  /**
   * THE SHORT LABEL BESIDE EVERY SYSTEM AFTER THE FIRST — `<part-abbreviation>` in MusicXML,
   * `Track.shortName` in the alphaTab hand-off. Omitted, it is derived from this part's resolved
   * name (`abbreviatePartName`), so a part is never anonymous from system 2 onwards and a renamed
   * part's short label follows the rename.
   */
  abbreviation?: string;
  /** Defaults to 'live' for the FIRST part and 'imported' for the rest. */
  role?: PartRole;
  /**
   * MOVE THIS PART AGAINST THE SHARED CLOCK, in seconds, applied BEFORE quantization. Positive is
   * later. Default 0.
   *
   * A part that carries its own written ticks (`sourceTiming`) is shifted in ticks too, by
   * `nudgeSec` at the score's display tempo — one CONSTANT shift for the whole part, so the part's
   * internal rhythm survives it exactly. Sliding each note by the tempo local to it would stretch
   * the part, and a nudge is a translation, not a stretch.
   *
   * What a nudge never moves is `sourceBars` / `sourceTempoChanges`: those ARE the shared clock,
   * and moving them would move every part at once.
   */
  nudgeSec?: number;
  /**
   * THIS PART'S INSTRUMENT PROFILE — engraving-only overrides, and every one of them is folded
   * into the `BuildSettings` this part is BUILT with, not applied at emit time. Any part can
   * therefore carry its own TAB staff, its own capo and its own written octave.
   *
   * The fallbacks are one rule: the FRETBOARD half (`tuningMidi`, `fingeringStyle`, `anchorFret`,
   * `capo`, `maxFret`, `tab`, `octaveTransposition`) follows the INSTRUMENT. A part that resolves
   * to the shared instrument inherits the shared settings' fretboard half; a part with an
   * instrument of its own starts from that instrument's defaults, so the live take's tuning, capo
   * or Tab Off can never reach into an imported guitar. An explicit field here always wins.
   * `clefMode` is a notation policy rather than a fretboard field and inherits from the shared
   * settings for every part, unless named here.
   *
   * `instrument` itself defaults to the shared instrument for the live part and to `'staff'` for
   * an imported one — an imported chart gets no invented fretboard — though naming an instrument
   * here gives it tab like any other part.
   */
  instrument?: Instrument;
  tuningMidi?: number[];
  fingeringStyle?: FingeringStyle;
  anchorFret?: number;
  capo?: number;
  maxFret?: number;
  clefMode?: ClefMode;
  /**
   * 'omit' drops the tablature staff even on a fretted part. Default 'two-staves'.
   *
   * TAB NEEDS A FRETBOARD: 'two-staves' on a part with no strings is a request that cannot be
   * honoured, and it is REPORTED (`PartBuild.notices`, and the same sentence in `ir.diagnostics`)
   * rather than thrown — the part is engraved as notation and the rest of the document is fine.
   */
  tab?: 'two-staves' | 'omit';
  /** §8.3. Per part: one may print conventional octave-transposed pitch while another does not. */
  octaveTransposition?: 'none' | 'conventional';
  /** General MIDI program - 1. Defaults from the instrument. */
  midiProgram?: number;
}

/** The shared half of `BuildInput`: everything except the notes, which come from the parts. */
export type SharedBuildInput = Omit<BuildInput, 'notes'>;

/** One built part, with the identity webcore needs to map the page back to a source. */
export interface PartBuild {
  /** 0-based printed order; 0 is the TOP part. */
  index: number;
  /** `P1`, `P2`, ... — the MusicXML part id, and the index into `AlphaTabScoreData.tracks`. */
  id: string;
  name: string;
  /** Always resolved — the caller's, else derived from `name`. The label systems 2..N print. */
  abbreviation: string;
  role: PartRole;
  /**
   * WHAT WAS PREPENDED TO THIS PART'S NOTE IDS, and it is `''` for the first part.
   *
   * `IRNote.id` has to be unique across the whole SCORE — webcore keys selection, undo and
   * click-to-edit on it, and two parts both numbering their notes `n0, n1, ...` would collide.
   * The first part keeps its ids untouched so a single-part build is unchanged; every later part
   * is namespaced `p2-`, `p3-`, ... Strip this prefix to recover the id the caller passed in.
   */
  idPrefix: string;
  nudgeSec: number;
  ir: RiffsheetIR;
  diagnostics: BuildDiagnostics;
  /**
   * WHAT THIS PART ASKED FOR AND DID NOT GET, in plain sentences, empty when nothing was refused.
   *
   * Today it holds exactly one thing: a tablature staff requested on a part with no fretted
   * profile. The same sentences are appended to `ir.diagnostics`, so a surface that already prints
   * the build's diagnostics shows them without changing anything; this array is for a surface that
   * wants to show only what THIS part's own settings did.
   */
  notices: string[];
  /**
   * THIS PART'S TOTAL PROJECTION, keyed by the NAMESPACED id (`p2-n0`), which is the id the IR
   * and both emitters carry. A part is an ordinary build, so this is exactly the projection that
   * build produced; the score-wide view is the union of them, and `resolveNoteId` says which part
   * an id belongs to. See buildScore.ts `BuildResult.projection`.
   */
  projection: Projection;
}

/**
 * A note's real identity in a multi-part score: WHICH PART, and its id INSIDE that part.
 *
 * The flat string is a transport format — one id space, one prefix per part — and it is what the
 * IR and both emitters carry, because that is what alphaTab and MusicXML can hold. It is not the
 * identity itself, and code that treated it as one is how `p2-n0` came to mean two different
 * notes. Resolve it here rather than by splitting on '-': part prefixes are chosen at build time
 * and only the build knows them.
 */
export interface ScoreNoteId {
  /** `P1`, `P2`, ... — the same id `PartBuild.id` carries. */
  partId: string;
  /** 0-based printed order. */
  partIndex: number;
  /** The id the caller passed in for this note, with no namespace on it. */
  noteId: string;
}

export interface MultiPartBuildResult {
  parts: PartBuild[];
  /** Index of the live take — the only part the app plays. -1 if the caller declared none. */
  liveIndex: number;
  /** Flat score-wide note id -> {part, note}. Null when no part claims it. */
  resolveNoteId(id: string): ScoreNoteId | null;
  toMusicXML(): string;
  toMidi(quantized: boolean): Uint8Array;
  toAlphaTabModelData(): AlphaTabScoreData;
}

/**
 * MOVE A WRITTEN NOTE BY A WRITTEN AMOUNT.
 *
 * `quartersShift` is the nudge expressed in quarter notes, and it is a real number: it comes from
 * the user's seconds and a rounded display tempo, so it lands wherever it lands. Rounding it
 * straight into the SOURCE's resolution — `Math.round(quarters * 960)` — moves a part to a tick
 * that is not a written position at all: at 960 ppq the result is exact to a 1/960th of a quarter,
 * which is a number no notation vocabulary contains, so a nudged import came back covered in
 * pointless ties and the app grew a caller-side "snap the nudge to a 1/32" workaround to hide it.
 *
 * The snap belongs here, and it belongs in the WRITTEN domain: the shift is rounded to the finest
 * value the IR can print — a 1/32, an eighth of a quarter — and only then converted into each
 * source's own ppq. Every ppq a score editor emits is a multiple of 8, so that conversion is
 * exact and the nudged material lands back on the same lattice it came from.
 */
function nudgeNote(note: InputNote, nudgeSec: number, quartersShift: number): InputNote {
  if (nudgeSec === 0) return note;
  const moved: InputNote = { ...note, startSec: note.startSec + nudgeSec, endSec: note.endSec + nudgeSec };
  if (note.sourceTiming) {
    const thirtySeconds = Math.round(quartersShift * 8);
    const shift = Math.round((thirtySeconds * note.sourceTiming.ppq) / 8);
    moved.sourceTiming = {
      ...note.sourceTiming,
      startTick: note.sourceTiming.startTick + shift,
      endTick: note.sourceTiming.endTick + shift
    };
  }
  return moved;
}

/**
 * BAR-FOR-BAR ALIGNMENT, and it is a hard requirement of both output formats: MusicXML stacks
 * parts by measure number, and alphaTab keys every track against ONE master-bar list. A part
 * whose bars ran out early would render past the end of the timeline on screen and produce a
 * document with unequal measure counts on disk.
 *
 * The shared clock already gives every part the same bars, so the only way they diverge is a part
 * whose final note rings past the last barline and pushes one more measure out of
 * `extendSkeletonThrough`. Short parts are therefore padded with whole-bar rests copied from the
 * longest part's structure — the same glyph `buildBars` writes for an empty measure — and any
 * disagreement about a bar they BOTH have is a broken clock rather than something to paper over,
 * so it throws.
 */
export function alignPartBars(irs: RiffsheetIR[]): void {
  let reference = irs[0];
  for (const ir of irs) if (ir.bars.length > reference.bars.length) reference = ir;

  for (const ir of irs) {
    for (let i = 0; i < ir.bars.length; i++) {
      const own = ir.bars[i];
      const ref = reference.bars[i];
      if (
        own.startTick !== ref.startTick ||
        own.durTicks !== ref.durTicks ||
        own.number !== ref.number ||
        own.implicit !== ref.implicit ||
        own.timeSig[0] !== ref.timeSig[0] ||
        own.timeSig[1] !== ref.timeSig[1]
      ) {
        throw new Error(
          `multi-part: bar ${i} does not agree across parts ` +
            `(${own.number}@${own.startTick}+${own.durTicks} ${own.timeSig.join('/')} vs ` +
            `${ref.number}@${ref.startTick}+${ref.durTicks} ${ref.timeSig.join('/')}); the shared clock is broken`
        );
      }
    }
    for (let i = ir.bars.length; i < reference.bars.length; i++) {
      const ref = reference.bars[i];
      const previous = ir.bars[ir.bars.length - 1];
      const bar: IRBar = {
        index: i,
        number: ref.number,
        implicit: ref.implicit,
        startTick: ref.startTick,
        durTicks: ref.durTicks,
        timeSig: [ref.timeSig[0], ref.timeSig[1]],
        timeSigChanged: ref.timeSigChanged,
        keyFifths: previous.keyFifths,
        keyChanged: false,
        clef: { ...previous.clef, changed: false },
        beamBoundaries: [...ref.beamBoundaries],
        voices: [
          {
            id: 1,
            beats: [
              {
                startTick: 0,
                durTicks: ref.durTicks,
                isRest: true,
                durationType: 'whole',
                dots: 0,
                measureRest: true,
                notes: []
              }
            ]
          }
        ]
      };
      ir.bars.push(bar);
      ir.stats.restGlyphs++;
    }
    const total = ir.stats.noteGlyphs + ir.stats.restGlyphs;
    ir.stats.restDensity = total ? ir.stats.restGlyphs / total : 0;
  }
}

/**
 * BUILD ONE SCORE FROM N PARTS. See the module header for what is shared and what is not.
 *
 * `sharedInput` is `BuildInput` minus the notes (beats, downbeats, `externalGrid`,
 * `startOffsetSec`, `audioDurationSec`, `detachedTimeline`, `blankBars`); `sharedSettings` is the ordinary
 * `BuildSettings`, and the timing/key/title half of it (`grid`, `timeSigOverride`, `bpmOverride`,
 * `keyFifths`, `title`, `composer`) is authoritative for the whole score. Only the engraving half
 * can be overridden per part, and `ScorePart` lists exactly which fields those are.
 */
export function buildMultiPartScore(
  parts: ScorePart[],
  sharedInput: SharedBuildInput,
  sharedSettings: BuildSettings
): MultiPartBuildResult {
  if (!parts.length) throw new Error('multi-part: a score needs at least one part');
  if (parts.length > MAX_PARTS) {
    throw new Error(`multi-part: at most ${MAX_PARTS} parts, got ${parts.length}`);
  }

  const roles: PartRole[] = parts.map((part, index) => part.role ?? (index === 0 ? 'live' : 'imported'));

  // ---- identity: one id space for the whole score -------------------------------------------
  // THE PREFIX IS A NAMESPACE, SO IT HAS TO BEHAVE LIKE ONE. `p2-` was prepended to every part
  // after the first and the first part's ids were left bare, which is not a namespace at all: a
  // live-part note actually named `p2-n0` — and score import names notes after their source
  // coordinates, so strings of exactly that shape occur — is the same STRING as part two's
  // generated `p2-n0`. Two different notes then shared one identity, and webcore's selection,
  // undo and click-to-edit all key on it.
  //
  // The first part still keeps its ids untouched (that is what makes a single-part build
  // byte-identical, and webcore relies on the live part's ids surviving a re-run), so the fix is
  // to LENGTHEN the marker until the collision is gone rather than to prefix everything.
  const ownIds = parts.map((part) => part.notes.map((note, i) => note.id ?? `n${i}`));
  const taken = new Set<string>(ownIds[0]);
  const prefixes: string[] = [''];
  for (let index = 1; index < parts.length; index++) {
    let prefix = `p${index + 1}-`;
    let guard = 0;
    while (ownIds[index].some((id) => taken.has(`${prefix}${id}`)) && guard++ < 64) prefix = `${prefix}-`;
    prefixes.push(prefix);
    for (const id of ownIds[index]) taken.add(`${prefix}${id}`);
  }
  const identified = parts.map((part, index) =>
    part.notes.map((note, i) => ({ ...note, id: `${prefixes[index]}${ownIds[index][i]}` }))
  );

  // ---- the shared clock ----------------------------------------------------------------------
  // Derived once, from every note in the score. The nudge has to be applied BEFORE this, because a
  // part moved by half a bar changes where the score's material starts and therefore where bar 1
  // falls. Tick nudging needs a tempo, so it runs in a second pass once the clock exists.
  const secondsNudged = identified.map((notes, index) => {
    const nudgeSec = parts[index].nudgeSec ?? 0;
    return nudgeSec === 0 ? notes : notes.map((note) => ({ ...note, startSec: note.startSec + nudgeSec, endSec: note.endSec + nudgeSec }));
  });
  // Only a nudged part that carries its own written ticks needs the score tempo, so the extra
  // skeleton pass is skipped entirely in the ordinary case.
  const needsTickNudge = parts.some(
    (part, index) => (part.nudgeSec ?? 0) !== 0 && identified[index].some((note) => note.sourceTiming)
  );
  const displayBpm = needsTickNudge
    ? buildTimeSkeleton(
        {
          ...sharedInput,
          notes: applyGuards(
            secondsNudged.flat(),
            sharedInput.audioDurationSec,
            sharedInput.detachedTimeline
          ).notes
        },
        sharedSettings
      ).displayBpm || 120
    : 120;

  const nudged = identified.map((notes, index) => {
    const nudgeSec = parts[index].nudgeSec ?? 0;
    if (nudgeSec === 0) return notes;
    // quarter notes per second x nudge = quarters to move; x ppq = that part's own ticks.
    const tickShiftPerPpq = (nudgeSec * displayBpm) / 60;
    return notes.map((note) => nudgeNote(note, nudgeSec, tickShiftPerPpq));
  });
  const scoreNotes = nudged.flat();

  // ---- N ordinary builds ---------------------------------------------------------------------
  // THE WHOLE INSTRUMENT PROFILE FOLLOWS THE INSTRUMENT, and `tab` is part of it.
  //
  // `tab` and `octaveTransposition` used to be forwarded to the two emitters and to nothing else,
  // so the part they were built as and the part they were printed as were two different parts:
  // `ir.tab` said one thing, the file and the screen said another, and everything reading the IR
  // (note-name lanes, string legends, octave-fold warnings, webcore's own guards) believed the IR.
  // They are settings of the BUILD, so they are resolved here with the rest of the profile.
  //
  // The tuning already followed the instrument for one specific reason — a bass tuning left behind
  // on a `'staff'` part gives it string count 4 and a tablature staff nobody asked for — and every
  // other fretboard field carries exactly the same hazard: the live take's capo shifting an
  // imported guitar's frets, the live take's Tab Off erasing an imported part's tablature. So the
  // rule is one rule: a part that resolves to the SHARED instrument inherits the shared fretboard
  // half; a part with an instrument of its own starts from that instrument's defaults. An explicit
  // field on the part always wins, whichever side it lands on.
  const builds: BuildResult[] = parts.map((part, index) => {
    const role = roles[index];
    // An imported part gets a plain notation staff unless the caller asked for an instrument.
    const instrument = part.instrument ?? (role === 'live' ? sharedSettings.instrument : 'staff');
    const ownProfile = instrument !== sharedSettings.instrument;
    /** The part's own value, else the shared one — but only while the part shares the instrument. */
    const profiled = <T>(own: T | undefined, shared: T | undefined): T | undefined =>
      own ?? (ownProfile ? undefined : shared);
    const tuningMidi = part.tuningMidi ?? (ownProfile ? DEFAULT_TUNINGS[instrument] : sharedSettings.tuningMidi);
    const fingeringStyle = profiled(part.fingeringStyle, sharedSettings.fingeringStyle) ?? DEFAULT_FINGERING_STYLE;
    const anchorFret = profiled(part.anchorFret, sharedSettings.anchorFret);
    const capo = profiled(part.capo, sharedSettings.capo);
    const maxFret = profiled(part.maxFret, sharedSettings.maxFret);
    const tab = profiled(part.tab, sharedSettings.tab);
    // §8.3 as a written-staff offset, which is the word the IR and both emitters already speak:
    // 'conventional' is +12 (the staff reads an octave above what sounds), 'none' is at pitch.
    const octaveOffset =
      part.octaveTransposition === 'conventional'
        ? 12
        : part.octaveTransposition === 'none'
          ? 0
          : profiled<number>(undefined, sharedSettings.displayPitchOffset);
    // The fretboard half is stripped from the base rather than overwritten: a conditional spread
    // can only add a key, and a part with its own instrument has to be able to NOT have one.
    const {
      tuningMidi: _tuning,
      fingeringStyle: _fingering,
      anchorFret: _anchor,
      capo: _capo,
      maxFret: _maxFret,
      tab: _tab,
      displayPitchOffset: _octave,
      ...scoreWide
    } = sharedSettings;
    const settings: BuildSettings = {
      ...scoreWide,
      instrument,
      tuningMidi,
      fingeringStyle,
      ...(anchorFret !== undefined ? { anchorFret } : {}),
      ...(capo !== undefined ? { capo } : {}),
      ...(maxFret !== undefined ? { maxFret } : {}),
      ...(tab !== undefined ? { tab } : {}),
      ...(octaveOffset !== undefined ? { displayPitchOffset: octaveOffset } : {}),
      ...(part.clefMode !== undefined ? { clefMode: part.clefMode } : {})
    };
    return buildScore({ ...sharedInput, notes: nudged[index] }, settings, { sharedNotes: scoreNotes });
  });

  alignPartBars(builds.map((build) => build.ir));

  const built: PartBuild[] = builds.map((build, index) => {
    const name = parts[index].name ?? defaultPartName(build.ir);
    // TAB WITHOUT A FRETBOARD IS A REQUEST THAT CANNOT BE HONOURED, NOT AN ERROR. Neither emitter
    // can print a tablature staff for a part with no strings — there is nothing to put on the
    // lines — so the part is engraved as notation and the caller is TOLD, in the same channel it
    // already reads for "3 notes dropped past the end of the audio". Throwing here would take a
    // whole document down over one part's checkbox, which is not a proportionate answer to a UI
    // that let someone tick Tab on a piano.
    const notices: string[] = [];
    if (parts[index].tab === 'two-staves' && build.ir.instrument.stringCount === 0) {
      const notice =
        `part ${index + 1} (${name}): tablature requested, but this part has no fretted profile ` +
        `(instrument '${build.ir.instrument.kind}', 0 strings) — engraved as notation only. ` +
        `Name a fretted instrument and its tuning to print tab.`;
      notices.push(notice);
      build.ir.diagnostics.push(notice);
    }
    return {
      index,
      id: `P${index + 1}`,
      name,
      // The same resolution both emitters perform, reported back so the app labels a part with the
      // string the file and the screen actually contain rather than a third guess at it.
      abbreviation: parts[index].abbreviation || abbreviatePartName(name),
      role: roles[index],
      idPrefix: prefixes[index],
      nudgeSec: parts[index].nudgeSec ?? 0,
      ir: build.ir,
      diagnostics: build.diagnostics,
      notices,
      projection: build.projection
    };
  });

  const xmlOptions = (index: number): MusicXmlOptions => ({
    // Passed through only when the caller set them, so an unnamed part names itself exactly as a
    // single-part score does and the byte-identity guarantee holds.
    ...(parts[index].name !== undefined ? { partName: parts[index].name } : {}),
    ...(parts[index].abbreviation !== undefined ? { partAbbreviation: parts[index].abbreviation } : {}),
    ...(parts[index].tab !== undefined ? { tab: parts[index].tab } : {}),
    ...(parts[index].midiProgram !== undefined ? { midiProgram: parts[index].midiProgram } : {}),
    ...(parts[index].octaveTransposition !== undefined ? { octaveTransposition: parts[index].octaveTransposition } : {})
  });

  // Longest prefix first, and the unprefixed live part last: an id that a longer namespace claims
  // belongs to that part, never to the bare one it happens to look like.
  const byPrefix = built
    .map((part) => ({ part, ids: new Set(identified[part.index].map((note) => note.id!)) }))
    .sort((a, b) => b.part.idPrefix.length - a.part.idPrefix.length);

  return {
    parts: built,
    liveIndex: roles.indexOf('live'),
    resolveNoteId: (id: string): ScoreNoteId | null => {
      for (const entry of byPrefix) {
        if (!entry.ids.has(id)) continue;
        return {
          partId: entry.part.id,
          partIndex: entry.part.index,
          noteId: id.slice(entry.part.idPrefix.length)
        };
      }
      return null;
    },
    toMusicXML: () =>
      toMultiPartMusicXML(builds.map((build, index) => ({ ir: build.ir, options: xmlOptions(index) }))),
    toMidi: (quantized: boolean) =>
      toMultiPartMidi(
        builds.map((build, index) => ({
          ir: build.ir,
          skeleton: build.skeleton,
          notes: build.notes,
          name: built[index].name,
          ...(parts[index].midiProgram !== undefined ? { program: parts[index].midiProgram } : {})
        })),
        quantized
      ),
    toAlphaTabModelData: () =>
      toMultiPartAlphaTabModelData(
        builds.map((build, index) => ({
          ir: build.ir,
          ...(parts[index].name !== undefined ? { name: parts[index].name } : {}),
          // THE SHORT LABEL REACHED THE FILE AND NOT THE SCREEN. `partAbbreviation` was forwarded
          // to MusicXML from the start while alphaTab never received it at all, so an abbreviation
          // the caller chose was printed on export and ignored on the page — the same
          // screen-disagrees-with-file shape as finding 8's `tab`/`octaveTransposition` pair.
          ...(parts[index].abbreviation !== undefined ? { abbreviation: parts[index].abbreviation } : {}),
          ...(parts[index].midiProgram !== undefined ? { program: parts[index].midiProgram } : {}),
          // SCREEN AND FILE SAY THE SAME THING. These two reached MusicXML only, so a guitar part
          // exported without a TAB staff and without its -12 displacement went on showing both on
          // screen — the app displayed a part it was not exporting (finding 8).
          ...(parts[index].tab !== undefined ? { tab: parts[index].tab } : {}),
          ...(parts[index].octaveTransposition !== undefined
            ? { octaveTransposition: parts[index].octaveTransposition }
            : {}),
          ...(roles[index] === 'imported' ? { notationOnly: true } : {})
        }))
      )
  };
}
