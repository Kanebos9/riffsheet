/**
 * AlphaTabScoreData (Team C, plain JSON) -> a real alphaTab Score object graph.
 *
 * This is the only file in webcore that constructs alphaTab model objects, which is what
 * keeps the renderer swappable: the documented exit path (VexFlow 5) would replace this
 * file and nothing else.
 *
 * STRING NUMBERING — the trap, and why this file does not simply trust a number.
 *
 * There are three systems in play and two run in opposite directions:
 *   RiffsheetIR / alphaTab   string 1 = the LOWEST (fattest) string
 *   MusicXML <string>        string 1 = the HIGHEST pitched string
 *   Staff.stringTuning       index 0  = the HIGHEST pitched string
 *
 * Team C's IR deliberately follows alphaTab, so no conversion is needed — but the doc
 * comment on their `AlphaTabNoteData.string` currently claims the MusicXML convention,
 * and believing it produced a tab that was vertically mirrored while looking entirely
 * plausible. The Phase 0 spike caught it; a human reviewer very likely would not have.
 *
 * So we DERIVE the string instead of trusting any convention: the open pitch is
 * `midi - fret - capo`, and there is exactly one tuning entry with that value. The
 * declared number is only a fallback, and a mismatch is reported. This is immune to
 * either side changing its mind.
 *
 * `tuningsHighToLow` is already in alphaTab's order and is used verbatim.
 */

import * as alphaTab from '@coderline/alphatab';
import type { AlphaTabScoreData } from '../pipeline';

export interface NoteInfo {
  /** Team C's stable InputNote id — the identity thread for click-to-edit and undo. */
  id: string;
  /** Sounding MIDI, straight from the pipeline. Never re-derived from string/fret. */
  midi: number;
  /** Original MIDI velocity. Kept beside the live model so edits do not flatten dynamics. */
  velocity?: number;
}

/**
 * Identity map, built while constructing the model.
 *
 * This replaces the previous app's `RenderAtom` sidecar and its positional re-pairing
 * entirely: we build the Note objects, so we simply remember which is which.
 */
export interface ScoreIndex {
  noteToInfo: Map<alphaTab.model.Note, NoteInfo>;
  /**
   * id -> the FIRST notehead of that note, which is the one that owns the fret digit.
   *
   * "First" is load-bearing and used to be "last", which was a real bug the player found. One
   * performed note held across a bar line is engraved as SEVERAL noteheads joined by ties, and
   * the pipeline gives every one of them the same id on purpose (the id names the note that was
   * played, not the glyph). This map was written once per glyph, so the last one overwrote the
   * rest — and the last one is a tie DESTINATION, which by the rules of notation carries no fret
   * number, because you do not pluck it again.
   *
   * The result on screen: clicking the first notehead selected the second, and changing the
   * pitch moved a note that had no tab digit under it, so the tab appeared not to respond at all.
   * Use `idToNotes` for anything that must touch the whole held note.
   */
  idToNote: Map<string, alphaTab.model.Note>;
  /** id -> EVERY notehead of that note, in time order. One entry unless it is tied. */
  idToNotes: Map<string, alphaTab.model.Note[]>;
  idToBarIndex: Map<string, number>;
  stringCount: number;
  tuningLowToHigh: number[];
  capo: number;
  /** Non-empty when the pipeline's declared string numbers disagreed with the pitches. */
  stringWarnings: string[];
  /** Notes the pipeline could not place inside the fret limit, placed best-effort instead. */
  pastFretLimit: number;
}

export interface BuiltAlphaTabScore {
  score: alphaTab.model.Score;
  index: ScoreIndex;
}

const DURATION: Record<string, alphaTab.model.Duration> = {
  Whole: alphaTab.model.Duration.Whole,
  Half: alphaTab.model.Duration.Half,
  Quarter: alphaTab.model.Duration.Quarter,
  Eighth: alphaTab.model.Duration.Eighth,
  Sixteenth: alphaTab.model.Duration.Sixteenth,
  ThirtySecond: alphaTab.model.Duration.ThirtySecond
};

export function buildAlphaTabScore(
  data: AlphaTabScoreData,
  settings: alphaTab.Settings
): BuiltAlphaTabScore {
  const index: ScoreIndex = {
    noteToInfo: new Map(),
    idToNote: new Map(),
    idToNotes: new Map(),
    idToBarIndex: new Map(),
    stringCount: 0,
    tuningLowToHigh: [],
    capo: 0,
    stringWarnings: [],
    pastFretLimit: 0
  };

  const score = new alphaTab.model.Score();
  score.title = '';

  /**
   * BUILD ORDER MATTERS, and not in an obvious way.
   *
   * alphaTab's `MasterBar.keySignature` SETTER propagates the key through
   * `score.tracks[0].staves[...]` to the corresponding `Bar`. So it throws unless the
   * track, the staff AND that staff's bar for this index already exist. Two orderings
   * fail with unhelpful messages:
   *   - setting it before addMasterBar  -> "cannot read properties of undefined ('tracks')"
   *   - setting it before the staff/bars-> "cannot read properties of undefined ('staves')"
   *
   * Hence three phases: master bars (structure only), then tracks/staves/bars, then the
   * key signatures in a final pass.
   */
  const masterBars: alphaTab.model.MasterBar[] = [];
  for (const mb of data.masterBars) {
    const masterBar = new alphaTab.model.MasterBar();
    score.addMasterBar(masterBar);
    masterBar.timeSignatureNumerator = mb.timeSignatureNumerator;
    masterBar.timeSignatureDenominator = mb.timeSignatureDenominator;
    masterBar.isAnacrusis = mb.isAnacrusis;

    masterBars.push(masterBar);
  }

  // Score.tempo is a getter over master-bar tempo automation. Symbolic imports can carry
  // changes inside a bar, represented by alphaTab's ratioPosition rather than flattened to BPM 1.
  const tempoChanges = data.tempoChanges.length ? data.tempoChanges : [{ tick: 0, bpm: data.tempo }];
  for (const change of tempoChanges) {
    let barIndex = 0;
    for (let index = 1; index < data.masterBars.length; index++) {
      if (data.masterBars[index].startTick > change.tick) break;
      barIndex = index;
    }
    const barData = data.masterBars[barIndex];
    const masterBar = masterBars[barIndex];
    if (!barData || !masterBar) continue;
    const automation = new alphaTab.model.Automation();
    automation.type = alphaTab.model.AutomationType.Tempo;
    automation.value = change.bpm;
    automation.ratioPosition = Math.max(0, Math.min(1, (change.tick - barData.startTick) / Math.max(1, barData.durTicks)));
    masterBar.tempoAutomations.push(automation);
  }

  for (const trackData of data.tracks) {
    const track = new alphaTab.model.Track();
    track.name = trackData.name;
    track.shortName = trackData.name.slice(0, 4);
    track.playbackInfo.program = trackData.program;
    track.playbackInfo.primaryChannel = 0;
    track.playbackInfo.secondaryChannel = 1;
    score.addTrack(track);

    for (const staffData of trackData.staves) {
      const staff = new alphaTab.model.Staff();
      track.addStaff(staff);
      staff.showStandardNotation = staffData.showStandardNotation;
      staff.showTablature = staffData.showTablature;
      staff.stringTuning.tunings = [...staffData.tuningsHighToLow]; // already alphaTab's order
      staff.capo = staffData.capo;
      const stringCount = staffData.tuningsHighToLow.length;
      // Bass and guitar are conventionally written an octave above sounding pitch. The
      // universal staff is concert pitch: applying this to an imported piano/violin/etc.
      // would move every note by an octave merely because an old bass tuning was remembered.
      staff.displayTranspositionPitch = staffData.displayTranspositionPitch;
      index.stringCount = stringCount;
      index.tuningLowToHigh = [...staffData.tuningsHighToLow].sort((a, b) => a - b);
      index.capo = staffData.capo;

      for (const barData of staffData.bars) {
        const bar = new alphaTab.model.Bar();
        bar.clef = barData.clef === 'G2' ? alphaTab.model.Clef.G2 : alphaTab.model.Clef.F4;
        staff.addBar(bar);

        const voices = barData.voices.length ? barData.voices : [{ beats: [] }];
        for (const voiceData of voices) {
          const voice = new alphaTab.model.Voice();
          bar.addVoice(voice);

          if (voiceData.beats.length === 0) {
            const rest = new alphaTab.model.Beat();
            rest.duration = alphaTab.model.Duration.Whole;
            rest.isEmpty = true;
            voice.addBeat(rest);
            continue;
          }

          for (const beatData of voiceData.beats) {
            const beat = new alphaTab.model.Beat();
            beat.duration = DURATION[beatData.duration] ?? alphaTab.model.Duration.Quarter;
            beat.dots = beatData.dots;
            beat.tupletNumerator = beatData.tupletNumerator;
            beat.tupletDenominator = beatData.tupletDenominator;

            if (beatData.isEmpty || beatData.notes.length === 0) {
              beat.isEmpty = true;
              // A full-bar rest is a whole rest regardless of the meter.
              if (beatData.isFullBarRest) beat.duration = alphaTab.model.Duration.Whole;
              voice.addBeat(beat);
              continue;
            }

            for (const noteData of beatData.notes) {
              const note = new alphaTab.model.Note();

              if (noteData.string !== undefined && noteData.fret !== undefined) {
                note.fret = noteData.fret;
                note.string = resolveString(noteData, staffData.tuningsHighToLow, staffData.capo, index);
              } else if (staffData.showTablature) {
                // The pipeline found no position inside the fret limit. A pitch-only note is
                // NOT a safe thing to hand a tablature staff: alphaTab keys its tab glyphs by
                // `note.string` and indexes its staff-line array with `tuning.length - string`,
                // so a note with no string reads past the end of that array and throws
                // (`undefined is not an object`) inside collectSpaces — killing the render of
                // the whole score, silently if it happens in a worker. Measured on a real
                // transcription where 34 of 63 notes were past the limit.
                //
                // So place it honestly instead: same pitch, nearest string, whatever fret that
                // takes. The fret may exceed the user's limit (and goes negative below the
                // lowest string), which reads as obviously odd — which is the point. The
                // pitch on the staff stays exact either way.
                const pos = bestEffortPosition(noteData.midi, staffData.tuningsHighToLow, staffData.capo);
                note.string = pos.string;
                note.fret = pos.fret;
                index.pastFretLimit++;
                if (index.stringWarnings.length < 5) {
                  index.stringWarnings.push(
                    `note ${noteData.id}: no position within the fret limit — shown at string ${pos.string}, fret ${pos.fret}`
                  );
                }
              } else {
                note.octave = noteData.octave;
                note.tone = noteData.tone;
              }

              // Note.isTieOrigin is read-only in alphaTab — it is derived from the NEXT
              // note's isTieDestination during score.finish(). Setting the destination
              // side is both necessary and sufficient.
              note.isTieDestination = noteData.isTieDestination;
              note.isStaccato = noteData.isStaccato;

              beat.addNote(note);
              index.noteToInfo.set(note, {
                id: noteData.id,
                midi: noteData.midi,
                ...(noteData.dynamics !== undefined ? { velocity: noteData.dynamics } : {})
              });
              // Every glyph of the note, in the order they are engraved...
              const chain = index.idToNotes.get(noteData.id);
              if (chain) chain.push(note);
              else index.idToNotes.set(noteData.id, [note]);
              // ...and FIRST wins here, not last. See the comment on ScoreIndex.idToNote: the
              // last glyph of a tie carries no fret, so resolving to it made the tab look broken.
              if (!index.idToNote.has(noteData.id)) index.idToNote.set(noteData.id, note);
              if (!index.idToBarIndex.has(noteData.id)) index.idToBarIndex.set(noteData.id, barData.index);
            }
            voice.addBeat(beat);
          }
        }
      }
    }
  }

  // Phase 3: key signatures, now that every track, staff and bar exists.
  data.masterBars.forEach((mb, i) => {
    const masterBar = masterBars[i];
    if (!masterBar) return;
    masterBar.keySignature = mb.keySignature as alphaTab.model.KeySignature;
    masterBar.keySignatureType =
      mb.keySignatureType === 'Minor'
        ? alphaTab.model.KeySignatureType.Minor
        : alphaTab.model.KeySignatureType.Major;
  });

  // Beaming is deliberately left to alphaTab. Team C emits MusicXML-style beam states per
  // level, which the MusicXML export uses; alphaTab's own auto-beaming produces the same
  // result for the meters we support, and feeding it explicit beams would mean maintaining
  // two beaming opinions that can disagree on screen versus on paper.

  // finish() computes durations, ties, beams and the playback timeline. Without it the score
  // draws but the tick cache is empty, so the playhead has nothing to follow.
  score.finish(settings);

  return { score, index };
}

/**
 * alphaTab's `Note.string` (1 = lowest) for a pipeline note.
 *
 * Derived from the pitch, not from the declared number — see the file header. Falls back to
 * the declared number (which uses alphaTab's convention) when the pitch does not match any
 * open string, e.g. when a capo or a bend puts it out of the simple model.
 */
function resolveString(
  noteData: { id: string; midi: number; string?: number; fret?: number },
  tuningsHighToLow: number[],
  capo: number,
  index: ScoreIndex
): number {
  const stringCount = tuningsHighToLow.length;
  const open = noteData.midi - (noteData.fret ?? 0) - capo;
  const highFirstIndex = tuningsHighToLow.indexOf(open);

  if (highFirstIndex >= 0) {
    // tuningsHighToLow[0] is the highest string; alphaTab numbers 1 from the lowest.
    const derived = stringCount - highFirstIndex;
    if (noteData.string !== undefined && noteData.string !== derived && index.stringWarnings.length < 5) {
      index.stringWarnings.push(
        `note ${noteData.id}: pipeline said string ${noteData.string}, pitch says ${derived} — using ${derived}`
      );
    }
    return derived;
  }

  if (noteData.string !== undefined) return noteData.string;
  return 1;
}

/**
 * A tab position for a pitch the fret limit could not accommodate.
 *
 * Picks the string that needs the smallest non-negative fret — the position a player would
 * actually reach for — and does not cap the fret. Below the lowest open string there is no
 * real position, so the fret goes negative rather than the pitch being changed to suit the
 * instrument: a wrong-looking number is recoverable, a silently wrong note is not.
 */
function bestEffortPosition(
  midi: number,
  tuningsHighToLow: number[],
  capo: number
): { string: number; fret: number } {
  const stringCount = tuningsHighToLow.length;
  let best: { string: number; fret: number } | null = null;

  for (let i = 0; i < stringCount; i++) {
    const fret = midi - capo - tuningsHighToLow[i];
    // tuningsHighToLow[0] is the highest string; alphaTab numbers 1 from the lowest.
    if (fret >= 0 && (best === null || fret < best.fret)) best = { string: stringCount - i, fret };
  }

  return best ?? { string: 1, fret: midi - capo - tuningsHighToLow[stringCount - 1] };
}

/** Sounding MIDI for a note, taken from the pipeline rather than re-derived. */
export function soundingMidi(index: ScoreIndex, note: alphaTab.model.Note): number {
  const info = index.noteToInfo.get(note);
  if (info) return info.midi;
  // Fallback for notes created by an edit before the next pipeline run.
  const staff = note.beat.voice.bar.staff;
  const tunings = staff.stringTuning.tunings;
  const open = tunings[tunings.length - note.string] ?? 0;
  return open + note.fret + (staff.capo ?? 0);
}
