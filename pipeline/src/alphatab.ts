/**
 * STATION 6c — the alphaTab hand-off (Team B's screen path).
 *
 * This is plain JSON, not an alphaTab import. alphaTab has NO MIDI importer (open request since
 * July 2017) and its model requires explicit values — `Duration` is an enum, rests are explicit
 * beats, ties are explicit. So we own the whole model, and this function is the ~200-line
 * mapping the renderer research described: `IRBar -> Bar + Voice`, `IRBeat -> Beat`,
 * `IRNote -> Note`.
 *
 * ONE INVERSION TO WATCH — and only one, now that the IR follows alphaTab's own convention:
 *
 *   `IRNote.string` already counts 1 from the LOWEST string, exactly as alphaTab does, so it
 *   passes through UNCHANGED. (MusicXML is the odd one out and its emitter does the flip.)
 *   But alphaTab's `Staff.stringTuning.tunings` is ordered HIGH to LOW, while
 *   `IRInstrument.tuningMidi` (and MusicXML's `<staff-tuning line>`) run LOW to HIGH.
 *   `tuningsHighToLow` below is the converted array; use it verbatim.
 *
 * IDENTITY. Every note carries `id`, the id of the source InputNote. Building
 * `Map<alphaTab.model.Note, id>` while constructing the alphaTab model is what makes
 * click-to-edit work, and it replaces the old app's `RenderAtom` sidecar entirely.
 */

import type { DurationType, RiffsheetIR } from './ir.js';
import { grandClefPair } from './clef.js';

/** alphaTab `Duration` enum names. */
export type AlphaTabDuration =
  | 'Whole'
  | 'Half'
  | 'Quarter'
  | 'Eighth'
  | 'Sixteenth'
  | 'ThirtySecond';

const DURATION_MAP: Record<DurationType, AlphaTabDuration> = {
  whole: 'Whole',
  half: 'Half',
  quarter: 'Quarter',
  eighth: 'Eighth',
  '16th': 'Sixteenth',
  '32nd': 'ThirtySecond'
};

export interface AlphaTabNoteData {
  /** Source InputNote id — the identity thread for click-to-edit. */
  id: string;
  /** Sounding MIDI pitch. */
  midi: number;
  /** alphaTab `Note.octave` / `Note.tone`: octave * 12 + tone === midi. */
  octave: number;
  tone: number;
  /** 1 = the LOWEST (fattest) string — alphaTab's own convention, passed through unchanged. */
  string?: number;
  fret?: number;
  isTieOrigin: boolean;
  isTieDestination: boolean;
  isStaccato: boolean;
  /** v1 never prints these; they are recorded so a later version can. */
  isHammerPullOrigin?: boolean;
  accidental?: string;
  dynamics?: number;
  sourceStaffIndex?: number;
}

export interface AlphaTabBeatData {
  /** Bar-relative tick at `RiffsheetIR.divisions` per quarter. */
  startTick: number;
  durTicks: number;
  duration: AlphaTabDuration;
  dots: number;
  isEmpty: boolean;
  /** alphaTab renders a whole-bar rest when this is set. */
  isFullBarRest?: boolean;
  tupletNumerator: number;
  tupletDenominator: number;
  /** MusicXML-style beam states per level; alphaTab can auto-beam instead if preferred. */
  beams?: string[];
  notes: AlphaTabNoteData[];
}

export interface AlphaTabBarData {
  index: number;
  /** alphaTab `Clef`: 'F4' bass, 'G2' treble. */
  clef: 'F4' | 'G2';
  voices: { beats: AlphaTabBeatData[] }[];
}

export interface AlphaTabMasterBarData {
  index: number;
  number: number;
  isAnacrusis: boolean;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  /** alphaTab `MasterBar.keySignature` is the same -7..+7 integer as MusicXML <fifths>. */
  keySignature: number;
  keySignatureType: 'Major' | 'Minor';
  /** Ticks at `divisions` per quarter. */
  startTick: number;
  durTicks: number;
}

export interface AlphaTabScoreData {
  /** Shape version, so Team B can pin against changes. */
  schema: 1;
  title: string;
  artist?: string;
  tempo: number;
  tempoChanges: { tick: number; bpm: number }[];
  divisions: number;
  masterBars: AlphaTabMasterBarData[];
  tracks: {
    name: string;
    /** General MIDI program. */
    program: number;
    /**
     * ONE alphaTab Track, one to three Staves, in printed order top to bottom:
     *
     *   plain            [ notation (+ tab on the same staff when the part has strings) ]
     *   grand            [ treble, bass ]
     *   grand + strings  [ treble, bass, TAB ]
     *
     * A three-staff track is a real alphaTab arrangement (`Track.staves` is a list and webcore
     * loops it), NOT an alphaTex string — this hand-off has never been alphaTex, so alphaTex's
     * one-staff-pair limit does not apply. The TAB staff is deliberately LAST so a consumer that
     * remembers "the last staff's tuning" (webcore's ScoreIndex does) still reads the real one.
     */
    staves: {
      showStandardNotation: boolean;
      showTablature: boolean;
      /** HIGH to LOW — alphaTab's order, the inverse of the IR's. */
      tuningsHighToLow: number[];
      capo: number;
      /** alphaTab Staff.displayTranspositionPitch (subtracted from sounding pitch for display). */
      displayTranspositionPitch: number;
      bars: AlphaTabBarData[];
    }[];
  }[];
  /** Whether the IR asked for a grand staff. */
  grandStaff: boolean;
}

function pitchName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export function toAlphaTabModelData(ir: RiffsheetIR): AlphaTabScoreData {
  const tuningsHighToLow = [...ir.instrument.tuningMidi].sort((a, b) => b - a);
  const isBass = ir.instrument.kind.startsWith('bass');
  const isStaffOnly = ir.instrument.stringCount === 0;

  const masterBars: AlphaTabMasterBarData[] = ir.bars.map((bar) => ({
    index: bar.index,
    number: bar.number,
    isAnacrusis: bar.implicit,
    timeSignatureNumerator: bar.timeSig[0],
    timeSignatureDenominator: bar.timeSig[1],
    keySignature: bar.keyFifths,
    keySignatureType: ir.key.mode === 'minor' ? 'Minor' : 'Major',
    startTick: bar.startTick,
    durTicks: bar.durTicks
  }));

  /**
   * @param clefOverride the fixed clef of a grand-staff staff; omitted, the bar's own clef wins.
   * @param include which notes this staff prints. A beat whose notes all belong to the other
   *   staff becomes a rest, so both staves keep the full rhythm of the bar.
   * @param withPositions whether the notes carry string/fret. FALSE on the notation staves of a
   *   grand staff: those staves have an empty tuning, and alphaTab reads a stringed note's pitch
   *   out of its staff's tuning array, so a string number there would resolve against nothing.
   *   The frets belong to the TAB staff, which has the tuning.
   */
  const makeBars = (
    clefOverride?: 'F4' | 'G2',
    include?: (note: IRNoteForAlphaTab) => boolean,
    withPositions = true
  ): AlphaTabBarData[] => ir.bars.map((bar) => ({
    index: bar.index,
    clef: clefOverride ?? (bar.clef.sign === 'G' ? 'G2' : 'F4'),
    voices: bar.voices.map((v) => ({
      beats: v.beats.map((beat) => ({
        startTick: beat.startTick,
        durTicks: beat.durTicks,
        duration: DURATION_MAP[beat.durationType],
        dots: beat.dots,
        isEmpty: beat.isRest || (!!include && !beat.notes.some(include)),
        ...(beat.measureRest ? { isFullBarRest: true } : {}),
        tupletNumerator: beat.tuplet ? beat.tuplet.actual : 1,
        tupletDenominator: beat.tuplet ? beat.tuplet.normal : 1,
        ...(beat.beams?.length ? { beams: [...beat.beams] } : {}),
        notes: beat.notes.filter((note) => !include || include(note)).map((n) => ({
          id: n.id,
          midi: n.midi,
          // alphaTab model Note.octave is its raw 12-semitone bucket, not scientific-pitch
          // notation. MIDI 60 is therefore octave 5/tone 0; fromPipeline must receive C4.
          octave: Math.floor(n.midi / 12),
          tone: ((n.midi % 12) + 12) % 12,
          ...(withPositions && n.string !== undefined ? { string: n.string } : {}),
          ...(withPositions && n.fret !== undefined ? { fret: n.fret } : {}),
          isTieOrigin: n.tieStart,
          isTieDestination: n.tieStop,
          isStaccato: !!n.staccato,
          ...(n.legato ? { isHammerPullOrigin: true } : {}),
          ...(n.accidentalDisplay ? { accidental: n.accidentalDisplay } : {}),
          ...(n.velocity !== undefined ? { dynamics: n.velocity } : {}),
          ...(n.sourceStaffIndex !== undefined ? { sourceStaffIndex: n.sourceStaffIndex } : {})
        }))
      }))
    }))
  }));

  const bars = makeBars();
  const displayTranspositionPitch = ir.displayPitchOffset !== undefined
    ? -ir.displayPitchOffset
    : ir.instrument.stringCount > 0
      ? -12
      : 0;
  // THE FLAG IS NO LONGER CONDITIONAL ON THE PART HAVING NO STRINGS. It used to be
  // (`ir.grandStaff && isStaffOnly`), so a fretted instrument asked for a grand staff got one
  // silently-discarded flag and a single bass clef full of ledger lines. Strings now add a THIRD
  // staff instead of cancelling the first two.
  const hasStrings = ir.instrument.stringCount > 0;
  const [upperClef, lowerClef] = ir.grandStaffClefs ?? grandClefPair();
  const signOf = (sign: string): 'F4' | 'G2' => (sign === 'G' ? 'G2' : 'F4');
  // The split itself was decided in the IR (clef.ts `grandStaffSplitter`); this only reads it.
  const onStaff = (index: 0 | 1) => (note: IRNoteForAlphaTab): boolean => (note.staffIndex ?? 0) === index;
  const staves = ir.grandStaff
    ? [
        {
          showStandardNotation: true,
          showTablature: false,
          tuningsHighToLow: [],
          capo: 0,
          displayTranspositionPitch,
          bars: makeBars(signOf(upperClef.sign), onStaff(0), false)
        },
        {
          showStandardNotation: true,
          showTablature: false,
          tuningsHighToLow: [],
          capo: 0,
          displayTranspositionPitch,
          bars: makeBars(signOf(lowerClef.sign), onStaff(1), false)
        },
        // The tab staff shows the WHOLE part: tablature is one fretboard, and it is not split by
        // the notation's middle-C boundary.
        ...(hasStrings
          ? [
              {
                showStandardNotation: false,
                showTablature: true,
                tuningsHighToLow,
                capo: ir.instrument.capo,
                displayTranspositionPitch,
                bars
              }
            ]
          : [])
      ]
    : [
        {
          showStandardNotation: true,
          showTablature: hasStrings,
          tuningsHighToLow,
          capo: ir.instrument.capo,
          displayTranspositionPitch,
          bars
        }
      ];

  return {
    schema: 1,
    title: ir.title,
    ...(ir.composer ? { artist: ir.composer } : {}),
    tempo: ir.tempo.displayBpm,
    tempoChanges: ir.tempo.changes?.length ? ir.tempo.changes.map((change) => ({ ...change })) : [{ tick: 0, bpm: ir.tempo.displayBpm }],
    divisions: ir.divisions,
    masterBars,
    tracks: [
      {
        name: isStaffOnly
          ? 'Music'
          : `${isBass ? 'Bass' : 'Guitar'} — Tuning low → high: ${ir.instrument.tuningMidi.map(pitchName).join(' ')}`,
        program: isStaffOnly ? 0 : isBass ? 33 : 27,
        staves
      }
    ],
    grandStaff: ir.grandStaff
  };
}

type IRNoteForAlphaTab = RiffsheetIR['bars'][number]['voices'][number]['beats'][number]['notes'][number];
