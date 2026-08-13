/**
 * Adapter to Team C's pipeline (`@riffsheet/pipeline` at ../pipeline).
 *
 * Their contract landed richer than the one Team B had sketched, and in the good direction:
 * `startOffsetSec` and `externalGrid` are first-class inputs (exactly what the bar-1 marker
 * and the DAW-grid capture needed), and `toAlphaTabModelData()` already does the IR ->
 * alphaTab mapping as plain JSON. So this file is a translator, not a reimplementation:
 *
 *   webcore UI settings  ->  BuildSettings
 *   webcore source state ->  BuildInput
 *   BuildResult          ->  RiffScore (what the rest of webcore consumes)
 *
 * ONE INVERSION LIVES HERE AND NOWHERE ELSE. Team C's `string` counts 1 from the HIGHEST
 * string (the MusicXML convention). alphaTab's `Note.string` counts 1 from the LOWEST.
 * The conversion is in `src/score/fromPipeline.ts`; this file passes their number through
 * untouched so there is exactly one place to look when the tab comes out mirrored.
 */

import {
  buildScore as teamCBuildScore,
  buildTickSecondsMap,
  type AlphaTabScoreData,
  type BuildInput,
  type BuildResult,
  type BuildSettings,
  type ExternalGrid,
  type InputNote,
  type NotationIntent,
  type RiffsheetIR,
  type TempoSegment,
  type TempoSource,
  type TickSecondsMap,
  notationIntentTicks,
  NOTATION_INTENT_DENOMINATORS,
  CHORD_WINDOW_MIN_SEC
} from '@pipeline-impl';

import type { AppSettings } from '../app/state';
import { customTuning, TUNING_PRESETS, tuningById, type TuningPreset } from '../score/tuning';

export type { AlphaTabScoreData, RiffsheetIR, InputNote, NotationIntent, TempoSegment, TempoSource, TickSecondsMap };

/**
 * THE PROJECTION'S OWN VOCABULARY, re-exported so consumers can name an outcome without reaching
 * past this adapter. See `RiffScore.projection`; the contract is `pipeline/IR.md §Projection`.
 */
export type {
  ChordGroupProjection,
  DropReason,
  GlyphRef,
  IntentIgnored,
  MergeReason,
  NoteProjection,
  Projection as PipelineProjection
} from '@pipeline-impl';
export { chordGroupsOf } from '@pipeline-impl';

/**
 * THE WRITTEN-VALUE VOCABULARY, re-exported so the editing surface and the engraver agree.
 *
 * The duration menu offers exactly the values `notationIntentTicks` can convert, and greys out
 * the one combination the union admits but the tick domain cannot hold (a dotted 1/32). Reading
 * the vocabulary from the pipeline rather than restating it here is what makes that true by
 * construction instead of by a comment.
 */
export { notationIntentTicks, NOTATION_INTENT_DENOMINATORS };

/**
 * ONE ANSWER TO "ARE THESE TWO NOTES THE SAME CHORD", SHARED WITH THE ENGRAVER (P1).
 *
 * The editor used to ask this question with a microsecond epsilon while the pipeline groups
 * attacks inside a window measured in TENS OF MILLISECONDS (`pipeline/src/chords.ts` §4.3b:
 * `max(35 ms, 1/64 whole note)`, the human-motor-slop floor a strum needs). Two numbers, two
 * answers, and the disagreement was not academic: a double stop played 3 ms apart is ONE
 * engraved chord on the page and was TWO colliding notes in the reducer, so the duration
 * command clipped the note the player had just chosen a value for against its own chord mate
 * and the roll rectangle collapsed to the minimum. That is the reported "each click makes it
 * shorter" loop, and it is a units bug rather than a policy one.
 *
 * The FLOOR is re-exported rather than `chordWindowSec(beatPeriod)` — the tempo-aware widening
 * — on purpose. The window only ever grows above this number, so grouping on the floor can
 * merge fewer pairs than the pipeline does but never more: the editor can be slightly stricter
 * than the page and still never split something the page draws as one chord, which is the only
 * direction of disagreement that does not produce a visible fault. Taking the full
 * `chordWindowSec` would need the beat period at the edited note's own position, which is a
 * tempo-map walk per collision test for a difference that is zero below 250 BPM.
 */
export { CHORD_WINDOW_MIN_SEC };

/**
 * THE AUTHORITATIVE TICK <-> SECONDS CONVERSION, handed to webcore.
 *
 * Every second<->tick helper on this side of the wall is a single multiply by
 * `60 / displayBpm / divisions`, and that expression is a lie the moment a score carries
 * `ir.tempo.changes`: one number cannot describe two tempi, so the bar lines, the loop bounds and
 * the notes handed to the synth all drift further apart the further past the change you look.
 * `buildTickSecondsMap` is the pipeline's piecewise answer — the same one the MIDI writer and the
 * MusicXML tempo directions come from — so a consumer that goes through it agrees with the file
 * we export by construction.
 *
 * It is re-exported rather than reimplemented because a second copy of this arithmetic is exactly
 * how the pipeline came to disagree with itself in the first place. Build it from a score's
 * `ir` (a `RiffsheetIR` is already a `TempoSource`); it is a plain object with no back-reference
 * to the IR, so a caller may cache one per score for as long as that score exists.
 */
export { buildTickSecondsMap };

/** What every consumer in webcore actually holds. */
export interface RiffScore {
  /** The renderer's input — plain JSON, converted to real alphaTab objects in score/fromPipeline.ts. */
  data: AlphaTabScoreData;
  ir: RiffsheetIR;
  musicxml(): string;
  /** Team C owns the MIDI writer too; `quantized: false` is the as-played variant. */
  midi(quantized: boolean): Uint8Array;

  // --- convenience, derived once so the UI never digs through the IR ---------
  tempoBpm: number;
  timeSignature: { numerator: number; denominator: number };
  divisions: number;
  durationSec: number;
  beatTimesSec: number[];
  tuningLowToHigh: number[];
  stringCount: number;
  capo: number;
  diagnostics: string[];
  /**
   * THE BUILD'S TOTAL CORRESPONDENCE RESULT — what became of every note it was handed.
   *
   * `pipeline/IR.md §Projection` is the contract; the short form is that `byId` holds exactly one
   * outcome per input id and the three are exhaustive: `engraved` (with every glyph it became),
   * `merged` (naming the input id whose glyph now speaks for it, resolved transitively so it is
   * always one pointer and never a chain), or `dropped` (with the rule that removed it).
   *
   * WHY IT IS ON `RiffScore` RATHER THAN LEFT IN `BuildResult`. Everything the sheet↔roll seam
   * needs to stop guessing is in here. Before it, a note that the guards dropped and a note that
   * the quantizer fused into its neighbour were both simply ABSENT from the engraved score, and
   * absence was the only signal any consumer had — so selecting either one lit the roll and drew
   * nothing on the page, with no way to tell that from a bug. `score/projection.ts` consumes this
   * and turns it into an answer the interface can give.
   *
   * `chordGroups` is the same idea for membership: the chord law is a greedy partition, so no
   * threshold a caller holds can reproduce it (`pipeline/src/chords.ts §chordWindowSec`), and the
   * only correct way to ask is to read what the build decided.
   */
  projection: BuildResult['projection'];
}

/**
 * WRITTEN SECOND 0, EXPRESSED ON THE RECORDING'S CLOCK. The one definition; everything that
 * has to line up with the sound goes through here.
 *
 * Two clocks exist and they are not the same clock. The recording's clock is what the
 * waveform, the shell's playback and the transport all speak. The score's clock starts at
 * bar 1, because the pipeline anchors bar 1 at the user's bar-1 marker and KEEPS whatever
 * came before it as an anacrusis. So a riff with a count-in has written second 0 sitting
 * `barOneSec` into the recording — minus whatever the pickup bar itself occupies, since it
 * is bar 1 and not tick 0 that the marker names.
 *
 *   audioSec = writtenSec + scoreOriginSec(...)
 *   writtenSec = audioSec - scoreOriginSec(...)
 *
 * Consumers: the piano roll's rectangles (`view/pianoroll.ts`), the sheet cursor and the
 * notes handed to the synth (`ui/app.ts`). In v1.1 the last two skipped it, and the cursor
 * ran ahead of the sound it was pointing at by exactly this number.
 */
export function scoreOriginSec(score: RiffScore, barOneSec: number): number {
  const bar = score.ir.bars.find((b) => !b.implicit) ?? score.ir.bars[0];
  // 24, not 12: the IR's `DIVISIONS` was doubled to carry a real 1/32 (#31), and this fallback
  // was left behind at the old value. It only fires for an IR with no `divisions` at all, but a
  // wrong one halves every tick-to-seconds conversion here — it is the score's origin, so the
  // whole take would sit at the wrong offset. The facade does not re-export DIVISIONS, hence
  // the literal; see the IR module for the one that is authoritative.
  const secPerTick = 60 / (score.tempoBpm || 100) / (score.ir.divisions || 24);
  return barOneSec - (bar ? bar.startTick * secPerTick : 0);
}

/**
 * The DAW's own tempo and meter, to build the sheet on instead of guessing.
 *
 * Two shapes, and the difference is `barStartsSec`:
 *
 *  - **A capture** knows exactly where the DAW's bar lines fell inside the recording, because
 *    the shell wrote them down block by block while the take was rolling. Those are the
 *    downbeats, verbatim — nothing is inferred.
 *  - **Anything else** (a wav dropped onto a plugin whose host reports a tempo) knows the
 *    tempo and the meter but has no idea how the file lines up with the DAW's timeline. So it
 *    supplies neither bar starts nor a lie about them, and the pipeline lays a grid of that
 *    tempo down from the bar-1 marker instead. That is the honest version of "use my DAW's
 *    tempo", and it is what the user was asking for when they set REAPER to 222 BPM and got a
 *    sheet at 102.
 */
export interface HostGridInput {
  hostBpm: number;
  hostTimeSig: { numerator: number; denominator: number };
  /** Omitted or empty when the audio's alignment to the DAW's timeline is unknown. */
  barStartsSec?: number[];
}

export interface BuildRequest {
  notes: InputNote[];
  beats?: number[];
  downbeats?: number[];
  audioDurationSec?: number;
  /** Where bar 1 / beat 1 sits — the auto-trim point, or wherever the user dragged the marker. */
  startOffsetSec?: number;
  /** The DAW's own grid, when a plugin capture supplied one. Authoritative when present. */
  hostGrid?: HostGridInput;
  /** Full-rest bars requested by the empty-document setup. */
  blankBars?: number;
  /**
   * THE SCORE'S TIMELINE IS ITS OWN (workstream C). Forwarded verbatim as
   * `BuildInput.detachedTimeline`.
   *
   * With it, `audioDurationSec` above stops being an authority over the notes: the pipeline's
   * guards stop dropping notes past the end of the tape and stop clamping ring-out against it,
   * and the bar skeleton is derived from the notes and `minimumBars` instead. That is exactly
   * what a bar insert needs — it moves real material later in NOTE time while the recording stays
   * precisely as long as it was recorded — and without it the guard answers "insert a bar" by
   * deleting everything the insert pushed past the old end.
   *
   * `audioDurationSec` is still passed when it is known, because it remains true about the audio.
   */
  detachedTimeline?: boolean;
  title?: string;
}

/**
 * THE PART'S IDENTITY, which "Tab: Off" is not allowed to change (X1).
 *
 * Turning the tablature staff off used to return null here, so the build received an empty tuning
 * and `instrument: 'staff'`. That is a DIFFERENT INSTRUMENT, not a different view of this one,
 * and the written octave rides on the instrument: a bass or guitar part is engraved an octave
 * above what it sounds, and a "staff" part is engraved at pitch. So switching Tab off dropped the
 * whole notation an octave onto ledger lines, silently, with no other setting touched.
 *
 * The tuning is therefore chosen the same way whatever `tabMode` says, and 'off' is expressed
 * where it belongs — `BuildSettings.tab: 'omit'`, which hides the staff and changes nothing else.
 */
function selectedNotationTuning(settings: FretboardChoice): TuningPreset | null {
  if (settings.tabMode === 'off') {
    // Whatever the part WAS. The remembered tuning is the last one the user chose, which is the
    // only honest answer to "what instrument is this" while its tab is hidden.
    const remembered = tuningById(settings.tuningId);
    return remembered.midiLowToHigh.length >= 2 ? remembered : null;
  }
  if (settings.tabMode === 'custom') {
    const custom = customTuning(settings.customTuningMidi);
    return custom.midiLowToHigh.length >= 2
      ? custom
      : customTuning([40, 45, 50, 55, 59, 64]);
  }
  const remembered = tuningById(settings.tuningId);
  if (remembered.instrument === settings.tabMode) return remembered;
  return TUNING_PRESETS.find((preset) => preset.instrument === settings.tabMode) ?? null;
}

/** TAB choice + exact tuning -> the closest legacy metadata discriminator. */
function instrumentKind(settings: FretboardChoice, tuningMidi: number[]): BuildSettings['instrument'] {
  // 'staff' means "this part has no strings", which is a statement about the INSTRUMENT. Only a
  // part with no tuning at all earns it; hiding the tab does not (see selectedNotationTuning).
  if (!tuningMidi.length) return 'staff';
  const remembered = tuningById(settings.tuningId);
  if (settings.tabMode === 'off') return remembered.instrument === 'guitar' ? 'guitar6' : bassKind(tuningMidi);
  if (settings.tabMode === 'guitar') return 'guitar6';
  if (settings.tabMode === 'custom' && Math.min(...tuningMidi) >= 35) return 'guitar6';
  return bassKind(tuningMidi);
}

function bassKind(tuningMidi: number[]): BuildSettings['instrument'] {
  switch (tuningMidi.length) {
    case 5:
      return 'bass5';
    case 6:
      return 'bass6';
    default:
      return 'bass4';
  }
}

/**
 * The NOTATION grid only. `AppSettings.rollGrid` is deliberately not in this file at all:
 * the piano roll's ruler is a drawing and editing aid, and the moment it could reach a
 * `BuildSettings` the sheet would start changing because somebody wanted bigger cells to
 * draw into.
 *
 * 'auto' passes straight through to Team C's word of the same name, which is what turns the
 * quantizer's full state set on (straight 8ths/16ths AND triplets, chosen per beat by the
 * Viterbi in pipeline/src/quantize.ts). Every other value is an override that narrows it.
 */
const GRID_MAP: Record<AppSettings['grid'], BuildSettings['grid']> = {
  auto: 'auto',
  quarter: '1/4',
  eighth: '1/8',
  sixteenth: '1/16',
  // 1/32. The finest straight override the quantizer offers. `NotationGrid` grew this word and
  // this map did not, and a `Record<NotationGrid, …>` missing a key is an error rather than a
  // gap — it was the one typecheck failure webcore was carrying.
  //
  // The only entry whose two sides are the SAME word. Every other line here translates the
  // app's vocabulary into Team C's ('sixteenth' -> '1/16'), but their `GridSetting` spells this
  // one 'thirtysecond' rather than '1/32', so the identity mapping is correct and not a
  // copy-paste slip. Check `pipeline/src/types.ts` before "fixing" it.
  thirtysecond: 'thirtysecond',
  triplet: '1/8T',
  free: 'free'
};

/**
 * The same translation for fingering: the app's words, Team C's words.
 *
 * All four of the pipeline's styles are reachable now. `open-strings` and `around-fret` were
 * added to its tab planner and had no way in from here, which is a feature that exists in the
 * build and not in the product.
 */
const FINGERING_MAP: Record<AppSettings['fingering'], BuildSettings['fingeringStyle']> = {
  'low-positions': 'low',
  'minimize-movement': 'minMovement',
  'open-strings': 'openStrings',
  'around-fret': 'aroundFret'
};

/**
 * ==============================================================================================
 * THE FRETBOARD HALF OF A PART, ON ITS OWN — so EVERY part can have one (per-part TAB).
 * ==============================================================================================
 *
 * WHY IT IS A SEPARATE TYPE. `toBuildSettings` translates the whole of `AppSettings` because the
 * LIVE take is the document's settings. An imported part is not: it carries its own instrument,
 * tuning, capo, fret ceiling and fingering, stored on the part (`score/parts.ts §PartTabProfile`)
 * and edited through the same toolbar controls with the same words. Everything else in
 * `BuildSettings` — the quantize grid, the key, the meter, the tempo — is shared by construction
 * and must stay shared, so it is not in here.
 *
 * The keys are deliberately the same names `AppSettings` uses, so `toBuildSettings` and this
 * function are two readings of one vocabulary rather than two vocabularies, and an `AppSettings`
 * is a valid `FretboardChoice` without conversion.
 */
export interface FretboardChoice {
  tabMode: AppSettings['tabMode'];
  tuningId: string;
  customTuningMidi: number[];
  capo: number;
  maxFret: number;
  fingering: AppSettings['fingering'];
  anchorFret: number;
}

/** What one part's fretboard choice means to the pipeline. Exactly the `ScorePart` profile fields. */
export interface PartFretboard {
  instrument: BuildSettings['instrument'];
  tuningMidi: number[];
  fingeringStyle: BuildSettings['fingeringStyle'];
  anchorFret?: number;
  capo: number;
  maxFret: number;
  tab: 'two-staves' | 'omit';
}

/**
 * One part's profile, resolved.
 *
 * `tab: 'omit'` is VISIBILITY and never identity — the same rule `toBuildSettings` follows and for
 * the same reason (X1): the instrument and its string count survive the tab being switched off, so
 * turning it back on restores the tuning that was there rather than inventing a default, and the
 * written octave does not drop onto ledger lines in the meantime.
 *
 * `instrument: 'staff'` is the one honest way to say "this part has no strings", and it is what a
 * part whose profile names no tuning at all resolves to — the pipeline then engraves plain
 * notation and reports the refusal rather than throwing (`IR.md §The per-part profile`).
 */
export function toPartFretboard(choice: FretboardChoice): PartFretboard {
  const tuning = selectedNotationTuning(choice);
  const tuningMidi = tuning ? [...tuning.midiLowToHigh] : [];
  return {
    instrument: instrumentKind(choice, tuningMidi),
    tuningMidi,
    fingeringStyle: FINGERING_MAP[choice.fingering],
    ...(choice.fingering === 'around-fret' ? { anchorFret: choice.anchorFret } : {}),
    capo: choice.capo,
    maxFret: choice.maxFret,
    tab: choice.tabMode === 'off' || !tuningMidi.length ? 'omit' : 'two-staves'
  };
}

export function toBuildSettings(settings: AppSettings, title?: string): BuildSettings {
  const tuning = selectedNotationTuning(settings);
  const tuningMidi = tuning ? [...tuning.midiLowToHigh] : [];
  const instrument = instrumentKind(settings, tuningMidi);
  return {
    grid: GRID_MAP[settings.grid],
    instrument,
    tuningMidi,
    fingeringStyle: FINGERING_MAP[settings.fingering],
    ...(settings.fingering === 'around-fret' ? { anchorFret: settings.anchorFret } : {}),
    ...(settings.tempoBpm !== undefined ? { bpmOverride: settings.tempoBpm } : {}),
    ...(settings.timeSignature
      ? { timeSigOverride: [settings.timeSignature.numerator, settings.timeSignature.denominator] as [number, number] }
      : {}),
    clefMode: settings.clefMode,
    ...(settings.keyFifths !== undefined ? { keyFifths: settings.keyFifths } : {}),
    capo: settings.capo,
    showStaccato: true,
    // VISIBILITY, not identity. The instrument above is unchanged by this line (X1).
    ...(settings.tabMode === 'off' ? { tab: 'omit' as const } : {}),
    title: title ?? 'Riff'
  };
}

export function buildRiffScore(request: BuildRequest, settings: AppSettings): RiffScore {
  const externalGrid: ExternalGrid | undefined =
    settings.useHostGrid && request.hostGrid && request.hostGrid.hostBpm > 0
      ? {
          // Team C's `bpm` is QUARTER notes per minute — the DAW convention — so the host's
          // number passes straight through even in compound meters.
          bpm: request.hostGrid.hostBpm,
          timeSig: [request.hostGrid.hostTimeSig.numerator, request.hostGrid.hostTimeSig.denominator],
          // Only when we genuinely know them. An empty array here would be read as "this take
          // contains no bar lines" rather than "we do not know where they are".
          ...(request.hostGrid.barStartsSec?.length ? { barStartsSec: request.hostGrid.barStartsSec } : {})
        }
      : undefined;

  // The manual BPM box and the time-signature picker are OVERRIDES, and an override on top of
  // the DAW's own grid is a contradiction the pipeline resolves silently in the grid's favour
  // (`bpmOverride` only reaches `displayBpm` when there is no external grid; `timeSigOverride`
  // is skipped outright). Rather than pass numbers that are quietly ignored — which is how a
  // sheet ends up disagreeing with both the box above it and the DAW — they are dropped here,
  // so `diagnostics.meterReason` says which one actually decided the meter. The UI's other
  // half of this bargain is in app.ts: typing a tempo or picking a meter turns the DAW sync
  // OFF, so the number the player just typed is the one that wins.
  const buildSettings = toBuildSettings(
    externalGrid ? { ...settings, tempoBpm: undefined, timeSignature: undefined } : settings,
    request.title
  );

  const input: BuildInput = {
    notes: request.notes,
    ...(externalGrid ? { externalGrid } : { ...(request.beats ? { beats: request.beats } : {}) }),
    ...(request.downbeats && !externalGrid ? { downbeats: request.downbeats } : {}),
    ...(request.audioDurationSec !== undefined ? { audioDurationSec: request.audioDurationSec } : {}),
    ...(request.startOffsetSec !== undefined ? { startOffsetSec: request.startOffsetSec } : {}),
    ...(request.blankBars !== undefined ? { blankBars: request.blankBars } : {}),
    ...(request.detachedTimeline ? { detachedTimeline: true } : {})
  };

  const result = teamCBuildScore(input, buildSettings);
  const data = result.toAlphaTabModelData();
  const ir = result.ir;

  const beatTimesSec = ir.tempo.beatTimesSec;
  const lastBeat = beatTimesSec.length ? beatTimesSec[beatTimesSec.length - 1] : 0;
  const beatPeriod =
    beatTimesSec.length > 1 ? (lastBeat - beatTimesSec[0]) / (beatTimesSec.length - 1) : 60 / (ir.tempo.displayBpm || 100);

  const diagnostics: string[] = [
    `meter: ${result.diagnostics.meterReason}`,
    `rest density ${(ir.stats.restDensity * 100).toFixed(0)}% · ${ir.stats.noteGlyphs} notes, ${ir.stats.restGlyphs} rests`,
    ir.tempo.synthesised ? 'tempo grid synthesised (no beats supplied)' : 'tempo from detected beats'
  ];
  if (ir.suspects.tooShortDropped > 0) {
    diagnostics.push(`${ir.suspects.tooShortDropped} very short note(s) dropped as artefacts`);
  }
  if (ir.suspects.pastEndDropped > 0) {
    diagnostics.push(`${ir.suspects.pastEndDropped} note(s) past the end of the audio dropped`);
  }
  if (ir.suspects.repeatLoops.length > 0) {
    diagnostics.push(`${ir.suspects.repeatLoops.length} possible repeated section(s) flagged`);
  }

  return {
    data,
    ir,
    musicxml: () => result.toMusicXML(),
    midi: (quantized: boolean) => result.toMidi(quantized),
    tempoBpm: ir.tempo.displayBpm,
    timeSignature: { numerator: ir.timeSig[0], denominator: ir.timeSig[1] },
    divisions: ir.divisions,
    durationSec: lastBeat + beatPeriod,
    beatTimesSec,
    // What the SCREEN has: with the tab hidden there is no fretboard on it, so the string letters,
    // the tuning legend and every other tab affordance stay exactly as they were before X1's fix.
    // The part still knows its own strings — `ir.instrument` — and that is what the notation's
    // written octave reads.
    tuningLowToHigh: ir.tab === 'omit' ? [] : ir.instrument.tuningMidi,
    stringCount: ir.tab === 'omit' ? 0 : ir.instrument.stringCount,
    capo: ir.instrument.capo,
    diagnostics,
    projection: result.projection
  };
}
