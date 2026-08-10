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
  type AlphaTabScoreData,
  type BuildInput,
  type BuildSettings,
  type ExternalGrid,
  type InputNote,
  type RiffsheetIR
} from '@pipeline-impl';

import type { AppSettings } from '../app/state';
import { customTuning, TUNING_PRESETS, tuningById, type TuningPreset } from '../score/tuning';

export type { AlphaTabScoreData, RiffsheetIR, InputNote };

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
  const secPerTick = 60 / (score.tempoBpm || 100) / (score.ir.divisions || 12);
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
  title?: string;
}

function selectedNotationTuning(settings: AppSettings): TuningPreset | null {
  if (settings.tabMode === 'off') return null;
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
function instrumentKind(settings: AppSettings, tuningMidi: number[]): BuildSettings['instrument'] {
  if (settings.tabMode === 'off') return 'staff';
  if (settings.tabMode === 'guitar') return 'guitar6';
  if (settings.tabMode === 'custom' && Math.min(...tuningMidi) >= 35) return 'guitar6';
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
  triplet: '1/8T',
  free: 'free'
};

export function toBuildSettings(settings: AppSettings, title?: string): BuildSettings {
  const tuning = selectedNotationTuning(settings);
  const tuningMidi = tuning ? [...tuning.midiLowToHigh] : [];
  const instrument = instrumentKind(settings, tuningMidi);
  return {
    grid: GRID_MAP[settings.grid],
    fillGaps: settings.fillGaps,
    instrument,
    tuningMidi,
    fingeringStyle: settings.fingering === 'minimize-movement' ? 'minMovement' : 'low',
    ...(settings.tempoBpm !== undefined ? { bpmOverride: settings.tempoBpm } : {}),
    ...(settings.timeSignature
      ? { timeSigOverride: [settings.timeSignature.numerator, settings.timeSignature.denominator] as [number, number] }
      : {}),
    clefMode: settings.clefMode,
    ...(settings.keyFifths !== undefined ? { keyFifths: settings.keyFifths } : {}),
    capo: settings.capo,
    showStaccato: true,
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
    ...(request.blankBars !== undefined ? { blankBars: request.blankBars } : {})
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
    tuningLowToHigh: ir.instrument.tuningMidi,
    stringCount: ir.instrument.stringCount,
    capo: ir.instrument.capo,
    diagnostics
  };
}
