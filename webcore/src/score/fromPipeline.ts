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
   * THE NAME BESIDE EVERY SYSTEM, NOT JUST THE FIRST ONE.
   *
   * Standard engraving practice for a score of several instruments, and the one thing a reader
   * turning to the middle of a two-part page needs: the full name against the first system, the
   * abbreviation against every one after it. MusicXML has said this with
   * `<part-name>`/`<part-abbreviation>` for as long as it has existed, the pipeline emits both
   * halves (`AlphaTabScoreData.tracks[].name` / `.shortName`), and until now the pair was thrown
   * away one line short of the page — alphaTab's defaults are FirstSystem + ShortName, so a
   * two-part sheet labelled system 1 with two ABBREVIATIONS and then left the whole rest of the
   * document anonymous.
   *
   * It is on the SCORE and not in `atSettings`, because that is where alphaTab keeps it
   * (`RenderStylesheet`, read by `StaffSystem._calculateAccoladeSpacing` / `paintPartial`) — which
   * also means the screen and the PDF get it from one place, since both go through this function.
   *
   * A ONE-TRACK SCORE KEEPS THE FIRST SYSTEM ONLY, and that is the standard too: `singleTrack…`
   * is left at alphaTab's `FirstSystem` on purpose. Repeating "Bass" down the left of all eight
   * systems of a solo take is not what an engraver does, and at the 390px floor it is width the
   * page cannot spare for an answer that was never in doubt. The rule is "say who is playing when
   * there is more than one answer", so the policy that changes is the multi-track one.
   *
   * THE FIRST SYSTEM PRINTS THE FULL NAME ONLY WHEN THE FULL NAME IS A NAME — measured, after
   * setting it unconditionally and looking at the result. Nobody has renamed a plain take, so what
   * the pipeline calls its one part is a DESCRIPTION of the instrument rather than a name for it:
   * "Bass — Tuning low → high: E1 A1 D2 G2" (`pipeline/src/musicxml.ts §defaultPartName`). Printed
   * as a first-system label that is a 213px column of sideways text down the left of the page, for
   * a fact the string letters beside the tab already state.
   *
   * The test is the pipeline's OWN, not a guess about lengths: `abbreviatePartName` splits a name
   * on `— – :` and keeps the head, because "everything from the em-dash on is a description of the
   * instrument, not its name, and no engraver prints it beside a system". So a name carrying one
   * of those separators is a described part and its label is the abbreviation; a name without one
   * — every name a caller supplied, which is every part on a multi-part sheet and every take the
   * player has renamed (`score/parts.ts §livePartName`) — is printed in full.
   *
   * One rule, no special case for the track count, and it is the rule the two emitters already
   * agree on.
   */
  const described = data.tracks.some((trackData) => /[—–:]/.test(trackData.name));
  score.stylesheet.multiTrackTrackNamePolicy = alphaTab.model.TrackNamePolicy.AllSystems;
  score.stylesheet.firstSystemTrackNameMode = described
    ? alphaTab.model.TrackNameMode.ShortName
    : alphaTab.model.TrackNameMode.FullName;
  score.stylesheet.otherSystemsTrackNameMode = alphaTab.model.TrackNameMode.ShortName;

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

  /**
   * THE FRETBOARD THIS SCORE IS ABOUT — chosen, not left to whichever staff happens to be last.
   *
   * `index.stringCount`, `index.tuningLowToHigh` and `index.capo` are ONE answer for the whole
   * score: `edit/actions.ts` reaches for them to place a fret when a note is dragged, and
   * `view/stringLetters.ts` draws them down the left of the tab. They used to be assigned inside
   * the staff loop below, so the last staff of the last track overwrote every earlier one.
   *
   * For the shapes this app builds itself that was right by accident — the pipeline emits the tab
   * staff last (`pipeline/src/alphatab.ts`), including on a grand staff, where the two notation
   * staves carry an empty tuning. It is wrong the moment a score has more than one track, which
   * a symbolic import routinely does: a guitar track followed by a piano track left the index
   * holding the piano's empty tuning, and with no tuning `assignFret` declines to move anything,
   * so dragging a note on the tab did nothing at all.
   *
   * So the tab staff is picked by what it IS. First a staff that shows tablature and has strings
   * to show; failing that any staff with a tuning (a score that carries a fretboard without
   * printing one still edits like a fretted instrument); failing that the first staff there is,
   * which is where a capo with no strings under it comes from and keeps the old answer for every
   * single-track shape.
   *
   * Nothing here touches the MODEL: each staff is still built from its own `staffData` below,
   * and no note's string, fret or pitch is derived from this choice. Playback dumps either side
   * of this change are identical for every fixture, which is the condition it was made under.
   */
  const allStaves = data.tracks.flatMap((trackData) => trackData.staves);
  const tabStaff =
    allStaves.find((staffData) => staffData.showTablature && staffData.tuningsHighToLow.length > 0) ??
    allStaves.find((staffData) => staffData.tuningsHighToLow.length > 0) ??
    allStaves[0];
  if (tabStaff) {
    index.stringCount = tabStaff.tuningsHighToLow.length;
    index.tuningLowToHigh = [...tabStaff.tuningsHighToLow].sort((a, b) => a - b);
    index.capo = tabStaff.capo;
  }

  for (const trackData of data.tracks) {
    const track = new alphaTab.model.Track();
    track.name = trackData.name;
    /*
     * THE ABBREVIATION COMES FROM THE PIPELINE, WHICH IS THE ONLY PLACE THAT KNOWS IT.
     *
     * `trackData.name.slice(0, 4)` stood here, and it is wrong in both directions on real names:
     * "Bass — Tuning low → high: E1 A1 D2 G2" came out as "Bass" by luck, "Guitar" came out as
     * "Guit", and a part somebody had renamed "Rhythm gtr" came out as "Rhyt". Now that the label
     * is printed against EVERY system after the first (see `score.stylesheet` above), a four
     * character slice is not a detail — it is what most of the page says.
     *
     * `pipeline/src/musicxml.ts §abbreviatePartName` is the one definition: conventional
     * engraving abbreviations first ("Guitar" -> "Gtr.", "Bass" -> "Bass"), the instrument
     * description after the em-dash dropped, and anything unrecognised cut to four letters plus
     * the dot that says it was cut. The pipeline hands the result over as `shortName` and its
     * contract says consumers must use it rather than truncate `name` themselves, precisely so
     * that the sheet, the PDF and the exported `<part-abbreviation>` cannot disagree.
     *
     * `|| trackData.name` because a label is never left empty: an empty shortName would name
     * system 1 and leave the rest of the document anonymous, which is the fault being fixed.
     */
    track.shortName = trackData.shortName || trackData.name;
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
      // Bass and guitar are conventionally written an octave above sounding pitch. The
      // universal staff is concert pitch: applying this to an imported piano/violin/etc.
      // would move every note by an octave merely because an old bass tuning was remembered.
      staff.displayTranspositionPitch = staffData.displayTranspositionPitch;
      // (index.stringCount / tuningLowToHigh / capo are NOT set here — see `tabStaff` above.)

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
            if (!staffData.showRests) hideTabRests(rest);
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
              // F2a: the pipeline says whether this staff prints rests. See `hideTabRests`.
              if (!staffData.showRests) hideTabRests(beat);
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
 * Fully transparent — the paint that makes a glyph not appear without moving anything.
 *
 * `Color` takes r,g,b,a; alpha 0 is a no-op fill in both the SVG and the canvas engine.
 */
const INVISIBLE = new alphaTab.model.Color(0, 0, 0, 0);

/**
 * F2a — SUPPRESS THE REST GLYPHS ON A STAFF THAT DOES NOT PRINT THEM, AND NOTHING ELSE.
 *
 * The pipeline sets `staves[].showRests = false` on the tab-only staff of a grand + tab
 * arrangement, because alphaTab decides for itself with `TabBarRenderer.showRests`, which it
 * turns ON for any staff whose own `showStandardNotation` is off — true of exactly that one
 * layout, which is why exactly that one layout grew a duplicate column of rests under the tab.
 *
 * HOW, and why it is not the obvious thing. The obvious thing is to leave `Beat.isEmpty` false
 * on a note-less beat, and it does not work: alphaTab's `Beat.isRest` is
 * `isEmpty || (!deadSlapped && notes.length === 0)`, so a beat with no notes is a rest either
 * way and `TabBeatGlyph` builds a `TabRestGlyph` for it regardless. The only thing that beat
 * flag would change is whether the NOTATION staves print their rests too, which is not what was
 * asked for and would be wrong.
 *
 * What `TabRestGlyph.paint` actually consults is the canvas colour, opened from
 * `ElementStyleHelper.beat(canvas, BeatSubElement.GuitarTabRests, beat)` — a per-beat style
 * override alphaTab provides for exactly this purpose. Setting that one sub-element to a
 * transparent colour paints the rest and leaves no ink.
 *
 * SOUND-SACRED, AND PROVABLY SO. This writes a COLOUR. It does not touch `isEmpty`, the
 * duration, the dots, the tuplet, the notes or the order of beats, so nothing that decides when
 * a note sounds or for how long can see it — the harness asserts that by dumping every beat's
 * `absolutePlaybackStart`, `playbackDuration` and note list with and without the flag and
 * requiring the two dumps to be byte-identical ("playback dump is byte-identical").
 *
 * THE BEAT STAYS, AT FULL LENGTH. That is the pipeline's contract and the reason the glyph is
 * hidden rather than the beat dropped: the rest carries the bar's timing, and a tab staff short
 * of a beat would not line up with the notation above it.
 */
function hideTabRests(beat: alphaTab.model.Beat): void {
  const style = beat.style ?? new alphaTab.model.BeatStyle();
  style.colors.set(alphaTab.model.BeatSubElement.GuitarTabRests, INVISIBLE);
  beat.style = style;
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
