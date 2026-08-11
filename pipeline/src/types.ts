/**
 * Public input surface of the pipeline. Nothing here touches the DOM, the filesystem or
 * audio — `buildScore` is a pure function of these two objects.
 */

/** One detected/played note. Times are seconds in the source audio's timeline. */
export interface InputNote {
  startSec: number;
  endSec: number;
  midi: number;
  velocity?: number;
  /** Detector confidence 0..1. Carried through to the IR untouched. */
  confidence?: number;
  /**
   * Stable identity for round-tripping edits. Generated from the note's index in THIS array if
   * absent — before any guard drops anything, so an id never shifts when a neighbour is filtered.
   */
  id?: string;
  /** Honoured by the tab assigner (station 5) when the user has pinned a string in the IR. */
  stringOverride?: number;
  /**
   * Exact written timing from a symbolic source. When present on every note in an event, the
   * pipeline converts these ticks directly instead of quantizing reconstructed seconds.
   */
  sourceTiming?: { startTick: number; endTick: number; ppq: number };
  /** Source staff clef, when the importer supplied an unambiguous G2/F4 clef. */
  sourceClef?: 'treble' | 'bass';
  /** Source structure, retained so an importer does not have to encode it into note ids. */
  sourceTrackIndex?: number;
  sourceStaffIndex?: number;
  sourceBarIndex?: number;
  sourceVoiceIndex?: number;
  /** Written staff offset from canonical sounding MIDI, applied only by notation emitters. */
  displayPitchOffset?: number;
  /** Exact symbolic bar map, attached once by score import and consumed before input guards. */
  sourceBars?: {
    startTick: number;
    durationTicks: number;
    ppq: number;
    timeSig: [number, number];
    number: number;
    implicit: boolean;
  }[];
  /** Exact symbolic tempo map, attached once by score import. */
  sourceTempoChanges?: { tick: number; ppq: number; bpm: number }[];
}

/**
 * A grid handed down by a host that already knows it — a DAW project tempo, a click track, a
 * user-typed BPM. AUTHORITATIVE: when present, beat detection is skipped entirely and the
 * beat/downbeat grid is synthesised from these numbers. Every downstream station is unchanged.
 */
export interface ExternalGrid {
  /**
   * QUARTER notes per minute, the universal DAW convention — not "beats of the meter" per
   * minute. The beat period is derived from `timeSig`: a 6/8 bar at bpm 120 has a
   * dotted-quarter pulse of 0.75 s, not 0.5 s.
   */
  bpm: number;
  timeSig: [number, number];
  /**
   * Bar start times in seconds. When given these are the downbeats verbatim — they override
   * anything derived from bpm, which is what makes an odd-bar or edited arrangement work.
   */
  barStartsSec?: number[];
  /** Piecewise-constant tempo map. Each entry takes effect at `atSec` and holds until the next. */
  tempoChanges?: { atSec: number; bpm: number }[];
}

export interface BuildInput {
  notes: InputNote[];
  /** Beat times in seconds, ascending. From Beat This! (MIT) or a MIDI tempo map. */
  beats?: number[];
  /** Downbeat times in seconds — a subset of `beats` up to the anticipation tolerance. */
  downbeats?: number[];
  /**
   * Audio length in seconds. Station 7's past-end filter drops notes starting at or after it.
   * Omit to disable the filter.
   */
  audioDurationSec?: number;
  /**
   * Move the time origin: bar 1 / beat 1 anchors here. Material before it is KEPT — within a
   * beat it becomes an anacrusis, further back it gets as many implicit pre-measures as it
   * needs and leading rests are fine. Declaring the origin also disables the automatic
   * downbeat re-phase (§3.5), because the caller has already said where bar 1 is.
   */
  startOffsetSec?: number;
  /** Host-supplied grid. When present, `beats`/`downbeats` are ignored. */
  externalGrid?: ExternalGrid;
  /** Number of full-rest bars requested for a new empty document. Ignored when notes exist. */
  blankBars?: number;
}

export type GridSetting = 'auto' | '1/4' | '1/8' | '1/16' | '1/8T' | 'free';
/**
 * The page we are writing, not a guess about what produced the recording.
 *
 * `staff` is the universal/default path: standard notation only, with no invented
 * string or fret position. The fretted profiles add tablature when the player has
 * explicitly chosen an instrument and tuning.
 */
export type Instrument = 'staff' | 'bass4' | 'bass5' | 'bass6' | 'guitar6';
/**
 * How the tab assigner picks between the several fretboard positions that produce a pitch.
 *
 *  `low`          lowest fret wins — the published baseline, and hard to beat on easy material.
 *  `minMovement`  the hand stays where it is; edge costs dominate.
 *  `openStrings`  prefer an open string whenever one sounds the same pitch.
 *  `aroundFret`   anchor the hand near `anchorFret` and pay for leaving it.
 */
export type FingeringStyle = 'low' | 'minMovement' | 'openStrings' | 'aroundFret';
export type ClefMode = 'auto' | 'treble' | 'bass' | 'grand';

export interface BuildSettings {
  grid: GridSetting;
  /**
   * DEPRECATED AND IGNORED. Accepted so existing callers keep compiling; nothing reads it.
   *
   * This used to switch on the MuseScore lengthening pass, which pushed each note's off-time
   * forward to swallow the rest behind it. The pass is deleted (see simplify.ts): a performance
   * is written at the length it was played, so there is no longer a "fill the gaps" mode to
   * turn on. Passing `true` does not resurrect it.
   */
  fillGaps?: boolean;
  instrument: Instrument;
  /** MIDI note numbers of the open strings, LOW to HIGH. Never guessed (§8.2). */
  tuningMidi: number[];
  fingeringStyle: FingeringStyle;
  /**
   * Anchor for `fingeringStyle: 'aroundFret'`, in frets. Ignored by every other style.
   * Default 5 — first position on a bass, and where a player parks by default.
   */
  anchorFret?: number;
  /** One stable generated clef policy. Source clefs take precedence on symbolic imports. */
  clefMode?: ClefMode;
  /** Authoritative MusicXML/alphaTab fifths value, -7..7. Omit to run key detection. */
  keyFifths?: number;
  bpmOverride?: number;
  /** Forces the meter. The only way to get 6/8 or 12/8 — never auto-detected (§3.3). */
  timeSigOverride?: [number, number];
  /** Capo fret; subtracted from every fret number. Default 0. */
  capo?: number;
  /** Highest fret the assigner may use. Default 24. */
  maxFret?: number;
  /**
   * DEPRECATED AND IGNORED, for the same reason as `fillGaps`. Staccato dots were INFERRED from
   * the lengthening pass — a note earned one exactly when >= 30% of its printed value had been
   * invented. With durations printed as played there is nothing to infer from and nothing to
   * apologise for, so no articulation is synthesised. `IRNote.staccato` remains in the IR for a
   * future editing surface; the pipeline never sets it.
   */
  showStaccato?: boolean;
  /** Score/part titles for the emitters. */
  title?: string;
  composer?: string;
}

export const DEFAULT_TUNINGS: Record<Instrument, number[]> = {
  // No strings means no tablature. This is deliberately empty rather than a
  // guessed piano/guitar/bass layout: arbitrary instruments belong on a staff.
  staff: [],
  // low -> high. 4-string bass EADG = E1 28, A1 33, D2 38, G2 43 (§8.2).
  bass4: [28, 33, 38, 43],
  bass5: [23, 28, 33, 38, 43],
  bass6: [23, 28, 33, 38, 43, 48],
  guitar6: [40, 45, 50, 55, 59, 64]
};

/** Default anchor for `aroundFret`: first position. */
export const DEFAULT_ANCHOR_FRET = 5;

export function resolveSettings(s: BuildSettings): Required<
  Pick<
    BuildSettings,
    'grid' | 'instrument' | 'fingeringStyle' | 'capo' | 'anchorFret' | 'title' | 'clefMode'
  >
> &
  BuildSettings {
  return {
    ...s,
    capo: s.capo ?? 0,
    anchorFret: s.anchorFret ?? DEFAULT_ANCHOR_FRET,
    clefMode: s.clefMode ?? 'auto',
    title: s.title ?? 'Riff',
    tuningMidi:
      s.tuningMidi && s.tuningMidi.length ? [...s.tuningMidi].sort((a, b) => a - b) : DEFAULT_TUNINGS[s.instrument]
  };
}
