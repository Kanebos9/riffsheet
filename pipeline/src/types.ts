/**
 * Public input surface of the pipeline. Nothing here touches the DOM, the filesystem or
 * audio — `buildScore` is a pure function of these two objects.
 */

import type { NotationIntent } from './ir.js';

/**
 * Re-exported from ir.ts, which owns the written domain. It is part of the INPUT surface too:
 * an editing surface attaches it to an `InputNote`, so a caller must be able to name the type
 * without importing the IR module.
 */
export type { NotationIntent } from './ir.js';
export { notationIntentTicks, NOTATION_INTENT_DENOMINATORS } from './ir.js';

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
  /**
   * WRITTEN DURATION, DECLARED RATHER THAN MEASURED. See `NotationIntent` in ir.ts.
   *
   * Present, this note's written value IS the declaration and `endSec` no longer decides it: the
   * quantizer stops rounding the off-time onto the admitted grid for this note (quantize.ts,
   * "SPEC RULE R4") and hands the declared length straight to the engraver. Absent — every note
   * a detector ever produced — nothing changes anywhere.
   *
   * THREE LAWS STILL OUTRANK IT, because they are what makes a page legal rather than what makes
   * it accurate:
   *   the BAR      a declared value longer than the room left in the bar is split and TIED
   *                across the barline, exactly as a measured one is;
   *   the NEXT
   *   ATTACK       one voice cannot hold two notes at once, so a declared span that reaches past
   *                the next onset is trimmed back to it (simplify.ts `clampEventOverlaps`) —
   *                the same trim a rounded off-time gets;
   *   the TUPLET
   *   LATTICE      a declared end landing strictly inside a tuplet group moves onto that group's
   *                own lattice. Nothing else can be printed there: a span that is not a whole
   *                number of tuplet units has no written value at all.
   *
   * On the symbolic/exact path (`sourceTiming` on every note of the score) the source already
   * decided every written tick and the declaration is ignored — there is nothing left to decide.
   */
  notationIntent?: NotationIntent;
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
   * THE NOTES NO LONGER SHARE THE AUDIO'S TIMELINE.
   *
   * The past-end guard encodes one assumption — that the note list is a TRANSCRIPT of the audio,
   * so anything past the last sample is a detector that never stopped. Bar insert/delete breaks
   * that assumption on purpose: inserting a bar is a pure note-time edit that shifts real,
   * user-owned material later, and the waveform is immutable underneath it. Four inserted bars
   * push the tail of a 30 s take to 38 s, and the guard would answer that edit by deleting
   * everything it moved — the score would silently shorten back to the audio every time.
   *
   * So the caller declares it: with `detachedTimeline`, the score's timeline is its own and
   * `audioDurationSec` stops being an authority over it. Notes beyond the audio are engraved
   * normally and the skeleton grows to hold them (its length has always come from the material
   * and `minimumBars`, never from the audio). `audioDurationSec` may still be passed — it stays
   * meaningful to the app as the waveform's extent — it simply no longer clips anything.
   *
   * NOTHING ELSE CHANGES. The sub-30 ms filter is a statement about detection quality, not about
   * where the audio stops, so it still applies; so do chord grouping, quantization and the
   * repeat-loop flag. This flag turns off exactly one rule.
   */
  detachedTimeline?: boolean;
  /**
   * Move the time origin: bar 1 / beat 1 anchors here. Material before it is KEPT — within a
   * beat it becomes an anacrusis, further back it gets as many implicit pre-measures as it
   * needs and leading rests are fine. Declaring the origin also disables the automatic
   * downbeat re-phase (§3.5), because the caller has already said where bar 1 is.
   */
  startOffsetSec?: number;
  /** Host-supplied grid. When present, `beats`/`downbeats` are ignored. */
  externalGrid?: ExternalGrid;
  /**
   * MINIMUM DOCUMENT LENGTH, in printed (non-pickup) bars. 1..256, or absent for "as long as the
   * material needs".
   *
   * IT COEXISTS WITH NOTES, and that is the whole change from the `blankBars` it replaces. That
   * field extended the document only while there were exactly zero notes, so a blank score the
   * user had asked for eight bars of collapsed to one the moment the first note was placed in it,
   * and deleting the last note grew it back — a document whose length was a function of its
   * contents rather than a property of itself. Bar operations (insert/delete) need the opposite:
   * a length the caller owns, which content is written into and deleted out of without the page
   * reflowing underneath. So this is a FLOOR. The score is always at least this many bars and is
   * longer whenever the material reaches further; nothing here ever shortens a document.
   *
   * Pickup/implicit measures are not counted — they are not a bar of the piece, they are the
   * approach to bar 1, and a caller asking for eight bars means eight numbered ones.
   */
  minimumBars?: number;
  /**
   * DEPRECATED NAME for `minimumBars`, with its semantics: a blank-document bar count is just a
   * minimum length that happened to be requested while the document was empty. Callers that pass
   * it keep working and now keep their bars once notes arrive; `minimumBars` wins if both appear.
   */
  blankBars?: number;
}

/**
 * The resolved minimum document length: 0 when the caller asked for none, else 1..256.
 *
 * Exported because it is a two-way contract — webcore both SETS the field and displays the
 * document length it produced, and a UI that rounded or clamped differently from the pipeline
 * would show a number the score does not have.
 */
export function resolveMinimumBars(input: Pick<BuildInput, 'minimumBars' | 'blankBars'>): number {
  const requested = input.minimumBars ?? input.blankBars;
  if (requested === undefined || !Number.isFinite(requested)) return 0;
  return Math.max(1, Math.min(256, Math.round(requested)));
}

/**
 * The notation grid the caller asked for.
 *
 * `'thirtysecond'` is spelled out rather than `'1/32'` because it is a SHARED LITERAL: the
 * webcore settings union uses the same string, and the two must match exactly or the setting
 * silently falls through to the `default` arm on one side of the bridge. Do not "tidy" it into
 * the `1/n` family without changing webcore in the same commit.
 *
 * `'free'` is not a grid at all — see quantize.ts. It is a read-only view of the input at the
 * finest resolution notation can honestly print (a 1/32), never merged and never re-ordered.
 */
export type GridSetting = 'auto' | '1/4' | '1/8' | '1/16' | '1/8T' | 'thirtysecond' | 'free';
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
  /**
   * WHETHER THE TABLATURE STAFF IS PRINTED. 'two-staves' (the default) adds one under the
   * notation when the part has strings; 'omit' hides it and changes nothing else.
   *
   * IT IS NOT AN INSTRUMENT. Hiding the tab used to be expressed by asking for `instrument:
   * 'staff'` with an empty tuning, which is a different PART, not a different view of the same
   * one: a bass so described lost its string count, and with it the conventional written octave
   * every bass chart is engraved in, so switching Tab off dropped the notation an octave onto
   * ledger lines (X1). Visibility and identity are now separate words.
   */
  tab?: 'two-staves' | 'omit';
  /**
   * WRITTEN-STAFF OFFSET FROM SOUNDING PITCH, in whole octaves, for the whole part.
   *
   * +12 is the conventional guitar/bass engraving: the staff reads an octave above what sounds.
   * Absent, the part follows the instrument's own convention (fretted parts are written 8va,
   * everything else at pitch), which is what every build did before this existed. A symbolic
   * import that declared its own written octave still wins — its notes carry the offset and the
   * source is the authority on how it was engraved.
   */
  displayPitchOffset?: number;
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

/**
 * The fingering the assigner uses when nobody chose one — the published baseline (see
 * `FingeringStyle`). Exported because a MULTI-PART build has to name it: a part that does not
 * follow the shared instrument cannot inherit the shared style, and `BuildSettings.fingeringStyle`
 * is required, so the fallback has to be one value both sides of the bridge can point at.
 */
export const DEFAULT_FINGERING_STYLE: FingeringStyle = 'low';

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
