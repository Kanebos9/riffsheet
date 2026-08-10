/**
 * RiffsheetIR — the one intermediate representation, three consumers.
 *
 *   RiffsheetIR ──> toMusicXML()          .musicxml interchange
 *               ──> toMidi(quantized)     .mid export (quantized + as-played)
 *               ──> toAlphaTabModelData()  Team B's screen renderer
 *
 * Prose spec, invariants and the negotiation surface for Team B: see pipeline/IR.md.
 * This file is the normative shape; IR.md explains it.
 *
 * TICKS. Every tick in the IR is an integer at `divisions` per QUARTER note.
 * `divisions` is 12 — the smallest value that keeps eighth-triplets (4), sixteenth-triplets
 * (2), sixteenths (3), eighths (6) and dotted eighths (9) all exact integers. A compound
 * beat (dotted quarter) is 18 ticks, which is why the docs say "12 ticks/beat, 18 for
 * compound": divisions-per-quarter never changes, the beat length does.
 */

export type StepName = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
export type DurationType = 'whole' | 'half' | 'quarter' | 'eighth' | '16th' | '32nd';
export type AccidentalName = 'sharp' | 'flat' | 'natural' | 'double-sharp' | 'double-flat';
export type ClefSign = 'F' | 'G' | 'TAB';

export const DIVISIONS = 12;

export interface IRClef {
  sign: ClefSign;
  /** Staff line the clef sits on: F clef -> 4, G clef -> 2. */
  line: number;
  /** True on the first bar of a clef run (the bar where the clef must be printed). */
  changed: boolean;
}

export interface IRKeySignature {
  /** MusicXML <fifths>, -7..+7. 0 means "open key", which is a decision, not a default (§1.4). */
  fifths: number;
  /** Emitted only when the major/minor margin is decisive; otherwise omitted (§1.3). */
  mode?: 'major' | 'minor';
  /** Top-1 collapsed correlation, 0..1. */
  confidence: number;
  /** Whether the gate accepted a non-zero signature. */
  accepted: boolean;
  /** Top 3 for the UI dropdown (§1.4 D.4). */
  candidates: { fifths: number; score: number; label: string }[];
  /** Why the gate refused, when it did — surfaced so the UI can explain itself. */
  reason?: string;
}

export interface IRNote {
  /** Stable id of the source InputNote this glyph came from. */
  id: string;
  /** Sounding MIDI pitch. NOT transposed: see §8.3, we write sounding pitch on a plain clef. */
  midi: number;
  /** Spelled pitch (station 3). */
  step: StepName;
  /** -2..+2; the spelling stage never emits |alter| >= 2 (§2.4). */
  alter: number;
  octave: number;
  /** Whether the accidental must be PRINTED (music21 display cascade, §2.6). */
  accidentalDisplay?: AccidentalName;
  /**
   * IR/alphaTab numbering: **1 is the LOWEST (fattest) string**, which is the inverse of
   * MusicXML's. The MusicXML emitter flips it; nothing else should. See tab.ts (§8.1).
   */
  string?: number;
  fret?: number;
  /** No position on this instrument/tuning — printed on the notation staff only. */
  unplayable?: boolean;
  /**
   * Semitones (always whole octaves) the TAB position was shifted by to bring an out-of-range
   * pitch onto the fretboard. `midi` is still the true sounding pitch and the notation staff is
   * unaffected; only the fret number moved. Absent means the position is exact.
   */
  tabOctaveShift?: number;
  tieStart: boolean;
  tieStop: boolean;
  /** From the lengthening pass: >= STACCATO_TOL of the written value was invented padding. */
  staccato?: boolean;
  /**
   * Legato pair marker from station 5. v1 emits NO hammer-on/pull-off symbols — this only
   * records that the pair survived string assignment, so a later version can print them
   * without re-deriving anything. `to` is the id of the following note.
   */
  legato?: { kind: 'hammer' | 'pull'; to: string };
  velocity?: number;
  /** Detector confidence 0..1, passed straight through. Below ~0.5 the UI flags it. */
  confidence?: number;
  /** The ORIGINAL detected times, carried through. The "as played" MIDI export is made of these. */
  startSec?: number;
  endSec?: number;
  /** Symbolic source staff identity, used to retain real grand-staff placement. */
  sourceStaffIndex?: number;
}

/** One rhythmic slot: a chord, a single note, or a rest. alphaTab calls this a Beat. */
export interface IRBeat {
  /** Bar-relative, in `divisions`-per-quarter ticks. */
  startTick: number;
  durTicks: number;
  isRest: boolean;
  /** Printed note value; with `dots` this reconstructs `durTicks` exactly. */
  durationType: DurationType;
  dots: 0 | 1;
  tuplet?: IRTuplet;
  /** MusicXML <beam> states per beam level (1 = eighth beam). Empty = flagged/unbeamed. */
  beams?: BeamState[];
  /** A rest filling the whole bar: printed as a centred whole rest (`<rest measure="yes"/>`). */
  measureRest?: boolean;
  notes: IRNote[];
}

export type BeamState = 'begin' | 'continue' | 'end' | 'forward hook' | 'backward hook';

export interface IRTuplet {
  id: string;
  actual: number;
  normal: number;
  start: boolean;
  stop: boolean;
}

export interface IRVoice {
  /** 1 or 2. v1 of the pipeline only ever produces voice 1 (bass riffs, §4.3 cap). */
  id: number;
  beats: IRBeat[];
}

export interface IRBar {
  index: number;
  /** Printed bar number. A pickup bar is number 0 with `implicit: true` (§3.5). */
  number: number;
  implicit: boolean;
  /** Absolute tick of the bar start, from bar 0. */
  startTick: number;
  /** Bar length in ticks. A pickup bar is short and that is legal MusicXML (§3.5). */
  durTicks: number;
  timeSig: [number, number];
  timeSigChanged: boolean;
  keyFifths: number;
  keyChanged: boolean;
  clef: IRClef;
  /** Beam-group boundaries, bar-relative ticks, ascending, [0 ... durTicks] (§3.6). */
  beamBoundaries: number[];
  voices: IRVoice[];
}

export interface IRRepeatSuspect {
  /** Indices into the ORIGINAL input note array. */
  noteIndices: number[];
  midi: number;
  count: number;
  meanIoiSec: number;
  stddevIoiSec: number;
  startSec: number;
  endSec: number;
}

export interface IRStats {
  noteGlyphs: number;
  restGlyphs: number;
  /** restGlyphs / (noteGlyphs + restGlyphs). The success criterion of station 2. */
  restDensity: number;
  restsShorterThanEighth: number;
  tupletRests: number;
  tiedGlyphs: number;
  staccatoNotes: number;
  /** Gaps the lengthening pass swallowed. */
  gapsAbsorbed: number;
}

export interface RiffsheetIR {
  version: 1;
  /** Ticks per QUARTER note. Always 12 (see file header). */
  divisions: number;
  /** Alias of `divisions`, under the name webcore/IR.md uses. Always equal to it. */
  ppq: number;
  /** false when `grid: 'free'` — nothing was snapped to a musical grid. */
  quantized: boolean;
  /** Sounding length of the source material in seconds. */
  durationSec: number;
  /** Human-readable notes for the settings panel's engine row. */
  diagnostics: string[];
  title: string;
  composer?: string;
  key: IRKeySignature;
  tempo: {
    /** 60 / median(inter-beat interval), rounded. One number for the whole score. */
    displayBpm: number;
    /** The per-beat tempo track. This is the highest-leverage datum in the pipeline (§9). */
    beatTimesSec: number[];
    downbeatTimesSec: number[];
    /** Symbolic tempo changes at absolute IR ticks; tick 0 is included when known. */
    changes?: { tick: number; bpm: number }[];
    /** true when no beats were supplied and a uniform grid was synthesised. */
    synthesised: boolean;
  };
  timeSig: [number, number];
  /** Whether the meter is compound (beat = dotted value). Only via timeSigOverride. */
  compound: boolean;
  /** Uniform written-staff offset from sounding MIDI, retained from symbolic/OMR import. */
  displayPitchOffset?: number;
  instrument: {
    kind: string;
    /** Open-string MIDI numbers, LOW to HIGH. */
    tuningMidi: number[];
    stringCount: number;
    capo: number;
  };
  /** The range/policy requests a stable grand staff; it never means alternating bar clefs. */
  grandStaff: boolean;
  bars: IRBar[];
  suspects: {
    /** Runs the webcore must resolve with audio evidence; the pipeline only marks them. */
    repeatLoops: IRRepeatSuspect[];
    /** Count of notes dropped by the past-end filter. */
    pastEndDropped: number;
    /** Count of notes dropped as sub-30 ms artefacts (§7.3 rule 1). */
    tooShortDropped: number;
  };
  stats: IRStats;
}
