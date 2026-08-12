/**
 * @riffsheet/pipeline — performed notes + beats -> readable notation.
 *
 * One entry point, three outputs, zero runtime dependencies and zero DOM access.
 *
 *   const { ir, toMusicXML, toMidi, toAlphaTabModelData } = buildScore(input, settings);
 *
 * See IR.md for the RiffsheetIR contract and the station-by-station map.
 */

export { buildScore } from './buildScore.js';
export { applyBeams, markTupletEdges, projectStaffBeats } from './beaming.js';
export type { BuildResult, BuildDiagnostics, BuildOptions } from './buildScore.js';

// ---- multi-part: N instruments, one document (see multipart.ts and IR.md) -------------------
export { buildMultiPartScore, alignPartBars, MAX_PARTS } from './multipart.js';
export type {
  ScorePart,
  PartRole,
  PartBuild,
  SharedBuildInput,
  MultiPartBuildResult,
  ScoreNoteId
} from './multipart.js';

export type {
  BuildInput,
  BuildSettings,
  ExternalGrid,
  InputNote,
  GridSetting,
  Instrument,
  FingeringStyle,
  ClefMode
} from './types.js';
export { DEFAULT_TUNINGS, DEFAULT_ANCHOR_FRET, resolveSettings } from './types.js';

export type {
  RiffsheetIR,
  IRBar,
  IRBeat,
  IRNote,
  IRVoice,
  IRClef,
  IRKeySignature,
  IRTuplet,
  IRStats,
  IRRepeatSuspect,
  DurationType,
  BeamState,
  StepName,
  AccidentalName
} from './ir.js';
export { DIVISIONS, THIRTYSECOND_TICKS } from './ir.js';

export { Rational, R, MIN_REST, MIN_DIVISION, MIN_ALLOWED_DURATION } from './rational.js';

export {
  buildBarMetric,
  depthAt,
  toDurationList,
  simplestDurationList,
  durationCount,
  glyphFor,
  nextBeatAfter,
  tupletWrittenLen,
  tupletActualLen,
  VOCABULARY
} from './meter.js';
export type { BarMetric, DurationKind, Glyph } from './meter.js';

export { clampEventOverlaps, snapLeadingOnset } from './simplify.js';
export type { SimplifyEvent, SimplifyResult } from './simplify.js';

export { buildTimeSkeleton, compoundEvidence, DOWNBEAT_ANTICIPATION_SEC } from './timeSkeleton.js';
export type { TimeSkeleton, BarSkeleton, CompoundEvidence } from './timeSkeleton.js';

// ---- the tick <-> seconds map (see IR.md, "Tick/seconds conversion") -----------------------
export { buildTickSecondsMap } from './tickSeconds.js';
export type { TickSecondsMap, TempoSegment, TempoSource } from './tickSeconds.js';

export { placeSymbolicEvents } from './symbolic.js';
export type { SymbolicEvent, SymbolicPlacement } from './symbolic.js';

export { validateIR, writtenTicks } from './validate.js';

export { quantizeOnsets } from './quantize.js';
export type { QuantNote, QuantResult, QuantTupletGroup } from './quantize.js';

export { collectChords, clampOverlaps, chordWindowSec, CHORD_WINDOW_MIN_SEC } from './chords.js';
export type { ChordEvent } from './chords.js';

export { detectKey, semitoneTransitionScores, majorTonicOf } from './key.js';
export type { KeyInput } from './key.js';

export {
  spellNoteList,
  accidentalDisplayForMeasure,
  keySignatureAlter,
  tpcToStep,
  tpcToAlter,
  tpcToOctave,
  tpcToPitchClass
} from './spelling.js';
export type { SpelledPitch, DisplayNote } from './spelling.js';

export {
  chooseClefs,
  grandClefPair,
  grandStaffSplitter,
  CLEF_LOW_THRESHOLD,
  CLEF_HIGH_THRESHOLD,
  GRAND_SPLIT_MIDI
} from './clef.js';
export type { ClefDecision } from './clef.js';

export {
  assignStrings,
  assignStringsLowestFret,
  detectLegatoPairs,
  survivingLegato,
  irStringFromTuningIndex,
  tuningIndexFromIrString,
  musicXmlStringFromIrString,
  irStringFromMusicXmlString,
  staffTuningLineFromIrString,
  LEGATO_GAP_SEC,
  LEGATO_MAX_INTERVAL
} from './tab.js';
export type { TabNoteInput, TabAssignment, TabPosition, LegatoPair } from './tab.js';

export { applyGuards, detectRepeatLoops, MIN_NOTE_SEC, REPEAT_MIN_RUN, REPEAT_IOI_STDDEV_SEC } from './guards.js';
export type { GuardResult } from './guards.js';

export { toMusicXML, toMultiPartMusicXML, defaultPartName } from './musicxml.js';
export type { MusicXmlOptions, MusicXmlPart } from './musicxml.js';

export { toMidi, toMultiPartMidi, MIDI_PPQ } from './midi.js';
export type { MidiPart } from './midi.js';

export { toAlphaTabModelData, toMultiPartAlphaTabModelData } from './alphatab.js';
export type {
  AlphaTabPart,
  AlphaTabScoreData,
  AlphaTabBarData,
  AlphaTabBeatData,
  AlphaTabNoteData,
  AlphaTabMasterBarData,
  AlphaTabDuration
} from './alphatab.js';
