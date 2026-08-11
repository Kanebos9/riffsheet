/**
 * STATION 6a — MusicXML 4.0 (score-partwise).
 *
 * PORTED FORWARD from the old app's `src/renderer/src/engine/musicxml.ts`. The research is
 * clear that the old serializer was never the bug — "it is a correct printer fed bad input. No
 * fix belongs here" (midi-to-notation-research.md §4.5). What came across:
 *   - the XSD element ordering, which that file had already got right and commented;
 *   - the explicit meter-aware <beam> emission (the old autoBeam:true path made VexFlow throw);
 *   - the "no pitched <note> without a <type>, ever" guard, which was a documented sheet-crash;
 *   - the two-staff tab layout with <staff-details>/<staff-tuning> and the backup-by-what-staff-
 *     one-actually-advanced rule (an unconditional barTicks backup corrupts short measures);
 *   - print-object="no" on tab tie-continuations, so a tied note does not repeat its fret digit.
 *
 * WHAT CHANGED, and it is the octave trap of §8.3 — the bug most likely to ship:
 * the old file wrote `pitch = sounding + 12` together with
 * `<transpose><octave-change>-1</octave-change>`. Riffsheet's rule is to use NEITHER mechanism:
 * plain `<clef><sign>F</sign><line>4</line></clef>`, SOUNDING pitches, no `<transpose>`, no
 * `<clef-octave-change>`. Using both double-applies, and MuseScore has itself shipped that as a
 * bug. Every reader handles the plain form identically. `assertNoOctaveTrap` below is a
 * standing guard against it coming back.
 *
 * Divisions is 24 (see ir.ts). Assertions G.4 (measure cursor) and G.5 (tuplet balance) run on
 * every emit and throw — a schema-valid file with a wrong <backup> renders silently wrong, and
 * that is exactly the failure the research says to catch with an assertion.
 *
 * STAFF COUNT IS NOT FIXED AT TWO. A part is a stack of layers — one to three of them — and the
 * measure body is written by walking that stack: emit a layer, assert it landed on the barline,
 * back up by what it advanced, emit the next. Notation staves come first and the TAB staff last,
 * so `<staves>` is 1 (plain), 2 (notation + tab, or a grand staff) or 3 (grand staff + tab).
 */

import type { IRBar, IRBeat, IRNote, RiffsheetIR } from './ir.js';
import { musicXmlStringFromIrString, staffTuningLineFromIrString } from './tab.js';
import { tpcToStep } from './spelling.js';
import { grandClefPair } from './clef.js';

const esc = (s: string): string =>
  s
    // XML 1.0 forbids C0 controls other than tab/LF/CR. Filenames are untrusted input.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export interface MusicXmlOptions {
  /**
   * 'two-staves' (the default) adds a tablature staff below the notation when the part has
   * strings; 'omit' emits notation only. The name is historical: with a grand staff the notation
   * is already two staves and the tab makes a third.
   */
  tab?: 'two-staves' | 'omit';
  partName?: string;
  /** General MIDI program - 1. 33 = Electric Bass (finger). */
  midiProgram?: number;
  /**
   * How to handle the fact that bass and guitar sound an octave below written pitch.
   *
   *   'none'  (default)  — §8.3's rule: SOUNDING pitches, plain clef, no <transpose> and no
   *                        <clef-octave-change>. Pitch round-trips exactly; the staff reads an
   *                        octave lower than a printed bass part conventionally does.
   *   'conventional'     — written pitch = sounding + 12 with a part-level
   *                        <transpose><octave-change>-1</octave-change>. This is what a bass
   *                        chart normally looks like, and what alphaTab shows on screen via
   *                        displayTranspositionPitch. NEVER combined with
   *                        <clef-octave-change>: using both mechanisms double-applies, which is
   *                        the bug MuseScore itself shipped.
   *
   * If the screen and the exported file must agree octave-for-octave, use 'conventional'.
   */
  octaveTransposition?: 'none' | 'conventional';
}

function pitchName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function projectedBeats(beats: IRBeat[], include: (note: IRNote) => boolean): IRBeat[] {
  return beats.map((beat) => {
    const notes = beat.notes.filter(include);
    if (beat.isRest || notes.length) return { ...beat, notes };
    return { ...beat, isRest: true, notes: [], beams: undefined };
  });
}

const NOTE_INDENT = '      ';

function pitchXml(n: IRNote, octaveShift: number): string {
  const alter = n.alter ? `<alter>${n.alter}</alter>` : '';
  return `<pitch><step>${n.step}</step>${alter}<octave>${n.octave + octaveShift / 12}</octave></pitch>`;
}

/**
 * §8.3 guard. The trap is not "transposing" — it is applying BOTH mechanisms, which
 * double-applies and drops the part an octave. So: <clef-octave-change> is never allowed at all,
 * and <transpose> only in 'conventional' mode.
 */
function assertNoOctaveTrap(xml: string, transposed: boolean): void {
  if (/<clef-octave-change>/.test(xml)) {
    throw new Error('MusicXML octave trap: <clef-octave-change> is never emitted (§8.3)');
  }
  const hasTranspose = /<transpose>/.test(xml);
  if (!transposed && hasTranspose) {
    throw new Error('MusicXML octave trap: sounding-pitch mode must not emit <transpose> (§8.3)');
  }
  if (transposed && !hasTranspose) {
    throw new Error('MusicXML octave trap: conventional mode must declare <transpose> (§8.3)');
  }
}

export function toMusicXML(ir: RiffsheetIR, options: MusicXmlOptions = {}): string {
  const useTab = (options.tab ?? 'two-staves') === 'two-staves' && ir.instrument.stringCount > 0;
  const isBass = ir.instrument.kind.startsWith('bass');
  const isStaffOnly = ir.instrument.stringCount === 0;
  const basePartName = isStaffOnly ? 'Music' : isBass ? 'Bass' : 'Guitar';
  const tuningSummary = ir.instrument.tuningMidi.map(pitchName).join(' ');
  const partName = options.partName ?? (isStaffOnly ? basePartName : `${basePartName} — Tuning low → high: ${tuningSummary}`);
  const program = options.midiProgram ?? (isStaffOnly ? 0 : isBass ? 33 : 27);
  const writtenShift = options.octaveTransposition === 'conventional'
    ? 12
    : options.octaveTransposition === 'none'
      ? 0
      : ir.displayPitchOffset ?? 0;
  // A grand staff no longer cancels itself when the part has strings: the notation is two staves
  // and the tab, when asked for, is a THIRD. `<staves>` counts them; nothing below assumes 2.
  const useGrand = ir.grandStaff;
  const grandClefs = ir.grandStaffClefs ?? grandClefPair();
  /** Staff numbers are 1-based and printed top to bottom: notation staves first, TAB last. */
  const notationStaves = useGrand ? 2 : 1;
  const tabStaff = notationStaves + 1;
  const staffCount = notationStaves + (useTab ? 1 : 0);
  // The split lives in the IR (clef.ts `grandStaffSplitter`) so this emitter and alphatab.ts can
  // no longer disagree about which staff a note belongs to.
  const onStaff = (index: 0 | 1) => (note: IRNote): boolean => (note.staffIndex ?? 0) === index;
  /** One standard-notation layer. `staff` is omitted entirely on a one-staff part, as before. */
  const notationLayer = (voice: number, staff?: number): EmitOptions => ({
    voice,
    staff,
    isTab: false,
    // string/fret ride on the tab staff when there is one; without it they stay on the notation
    // note, which is the only place left for a reader to find them.
    withTechnical: !useTab,
    withBeams: true,
    withTuplets: true,
    divisions: ir.divisions,
    octaveShift: writtenShift,
    stringCount: ir.instrument.stringCount
  });

  const L: string[] = [];
  L.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  L.push(
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">'
  );
  L.push('<score-partwise version="4.0">');
  L.push(`  <work><work-title>${esc(ir.title)}</work-title></work>`);
  L.push('  <identification>');
  if (ir.composer) L.push(`    <creator type="composer">${esc(ir.composer)}</creator>`);
  L.push('    <encoding><software>Riffsheet pipeline</software></encoding>');
  L.push('  </identification>');
  L.push('  <part-list>');
  L.push('    <score-part id="P1">');
  L.push(`      <part-name>${esc(partName)}</part-name>`);
  L.push(`      <score-instrument id="P1-I1"><instrument-name>${esc(partName)}</instrument-name></score-instrument>`);
  L.push(`      <midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>${program + 1}</midi-program></midi-instrument>`);
  L.push('    </score-part>');
  L.push('  </part-list>');
  L.push('  <part id="P1">');

  let lastTimeSig: string | null = null;
  let lastClef: string | null = null;
  let lastFifths: number | null = null;

  ir.bars.forEach((bar, bi) => {
    L.push(`    <measure number="${bar.number}"${bar.implicit ? ' implicit="yes"' : ''}>`);

    const timeKey = `${bar.timeSig[0]}/${bar.timeSig[1]}`;
    const clefKey = useGrand ? 'grand' : `${bar.clef.sign}${bar.clef.line}`;
    const needTime = timeKey !== lastTimeSig && !bar.implicit;
    const needClef = clefKey !== lastClef;
    const needKey = bar.keyFifths !== lastFifths;
    const needAttributes = bi === 0 || needTime || needClef || needKey;

    if (needAttributes) {
      L.push('      <attributes>');
      if (bi === 0) L.push(`        <divisions>${ir.divisions}</divisions>`);
      if (needKey || bi === 0) {
        const mode = ir.key.mode && bar.keyFifths === ir.key.fifths ? `<mode>${ir.key.mode}</mode>` : '';
        L.push(`        <key><fifths>${bar.keyFifths}</fifths>${mode}</key>`);
        lastFifths = bar.keyFifths;
      }
      if (needTime || bi === 0) {
        L.push(`        <time><beats>${bar.timeSig[0]}</beats><beat-type>${bar.timeSig[1]}</beat-type></time>`);
        lastTimeSig = timeKey;
      }
      if (bi === 0 && staffCount > 1) L.push(`        <staves>${staffCount}</staves>`);
      if (useGrand && bi === 0) {
        grandClefs.forEach((clef, i) =>
          L.push(`        <clef number="${i + 1}"><sign>${clef.sign}</sign><line>${clef.line}</line></clef>`)
        );
        lastClef = clefKey;
      } else if (needClef || bi === 0) {
        // Plain clef. No <clef-octave-change>: sounding pitches, §8.3.
        L.push(`        <clef${useTab ? ' number="1"' : ''}><sign>${bar.clef.sign}</sign><line>${bar.clef.line}</line></clef>`);
        lastClef = clefKey;
      }
      if (bi === 0 && useTab) {
        const n = ir.instrument.stringCount;
        L.push(`        <clef number="${tabStaff}"><sign>TAB</sign><line>${n}</line></clef>`);
        L.push(`        <staff-details number="${tabStaff}" show-frets="numbers">`);
        // 'alternate' = the same music shown twice (notation + tab); stops conforming
        // importers playing it back twice.
        L.push('          <staff-type>alternate</staff-type>');
        L.push(`          <staff-lines>${n}</staff-lines>`);
        // <staff-tuning line> counts from the BOTTOM (lowest pitch) while <string> counts from
        // the top. One conversion function, §8.1.
        ir.instrument.tuningMidi.forEach((midi, idx) => {
          // <staff-tuning line> counts from the bottom, which is the IR's own string numbering.
          const line = staffTuningLineFromIrString(idx + 1);
          const written = midi + writtenShift;
          const pc = ((written % 12) + 12) % 12;
          const tpc = [0, 7, 2, 9, 4, -1, 6, 1, 8, 3, 10, 5][pc];
          const step = tpcToStep(tpc);
          const alter = Math.floor((tpc + 1) / 7);
          const octave = Math.floor((written - alter) / 12) - 1;
          L.push(
            `          <staff-tuning line="${line}"><tuning-step>${step}</tuning-step>${
              alter ? `<tuning-alter>${alter}</tuning-alter>` : ''
            }<tuning-octave>${octave}</tuning-octave></staff-tuning>`
          );
        });
        if (ir.instrument.capo > 0) L.push(`          <capo>${ir.instrument.capo}</capo>`);
        L.push('        </staff-details>');
      }
      // XSD order: ... clef -> staff-details -> TRANSPOSE
      if (bi === 0 && writtenShift !== 0) {
        L.push(`        <transpose><chromatic>0</chromatic><octave-change>${-writtenShift / 12}</octave-change></transpose>`);
      }
      L.push('      </attributes>');
    }

    const tempoChanges = ir.tempo.changes?.length
      ? ir.tempo.changes
      : [{ tick: 0, bpm: ir.tempo.displayBpm }];
    for (const change of tempoChanges.filter((candidate) =>
      candidate.tick >= bar.startTick && candidate.tick < bar.startTick + bar.durTicks
    )) {
      L.push('      <direction placement="above">');
      L.push('        <direction-type><metronome><beat-unit>quarter</beat-unit>');
      L.push(`          <per-minute>${change.bpm}</per-minute></metronome></direction-type>`);
      const offset = change.tick - bar.startTick;
      if (offset > 0) L.push(`        <offset>${offset}</offset>`);
      L.push(`        <sound tempo="${change.bpm}"/>`);
      L.push('      </direction>');
    }

    const voice = bar.voices[0] ?? { id: 1, beats: [] };

    /**
     * THE MEASURE IS A STACK OF LAYERS, one per staff, and this list is the whole layout.
     *
     * It used to be an if/else hardwired for exactly two staves ("staff 1, then either the lower
     * grand staff or the tab staff"), which is why grand + tab could not exist: there was no
     * third arm to write. Voice numbers are pinned per ROLE, not derived from the staff number,
     * so tab stays voice 5 whether it is staff 2 or staff 3 and existing files are unchanged.
     */
    const layers: { beats: IRBeat[]; options: EmitOptions }[] = useGrand
      ? [
          { beats: projectedBeats(voice.beats, onStaff(0)), options: notationLayer(1, 1) },
          { beats: projectedBeats(voice.beats, onStaff(1)), options: notationLayer(2, 2) }
        ]
      : [{ beats: voice.beats, options: notationLayer(1, useTab ? 1 : undefined) }];
    if (useTab) {
      layers.push({
        beats: voice.beats,
        options: {
          voice: 5,
          staff: tabStaff,
          isTab: true,
          withTechnical: true,
          // <tuplet> notations duplicated onto the tab staff made VexFlow throw in the old app;
          // <time-modification> alone keeps the tab durations correct.
          withBeams: false,
          withTuplets: false,
          divisions: ir.divisions,
          octaveShift: writtenShift,
          stringCount: ir.instrument.stringCount
        }
      });
    }

    // THE CURSOR RULE, unchanged in substance and now applied N-1 times: back up by what the
    // PREVIOUS layer actually advanced, never by a nominal bar length (an unconditional
    // barTicks backup corrupts short measures — that is the pickup bar). Every layer must land
    // the cursor on the same barline, and G.4 says so out loud for each of them, because a
    // wrong <backup> is a schema-valid file that simply renders in the wrong place.
    let advanced = 0;
    layers.forEach((layer, index) => {
      if (index > 0 && advanced > 0) L.push(`      <backup><duration>${advanced}</duration></backup>`);
      advanced = emitBeats(L, layer.beats, layer.options);
      assertMeasureLength(advanced, bar);
    });

    assertTupletBalance(voice.beats, bar);
    L.push('    </measure>');
  });

  L.push('  </part>');
  L.push('</score-partwise>');
  const xml = L.join('\n');
  assertNoOctaveTrap(xml, writtenShift !== 0);
  return xml;
}

interface EmitOptions {
  voice: number;
  staff?: number;
  /**
   * Whether this layer IS the tablature staff. It used to be inferred as `staff === 2`, which
   * was true only while a part could never have more than two staves — on a grand staff + tab
   * part, staff 2 is the BASS NOTATION staff, and the inference would have hidden its noteheads
   * and swallowed its accidentals. The layer says what it is instead of being guessed at.
   */
  isTab: boolean;
  withTechnical: boolean;
  withBeams: boolean;
  withTuplets: boolean;
  divisions: number;
  /** Semitones added to the WRITTEN pitch. 0 in sounding-pitch mode, 12 in conventional. */
  octaveShift: number;
  /** Number of strings, for the IR -> MusicXML <string> flip. */
  stringCount: number;
}

function emitBeats(L: string[], beats: IRBeat[], o: EmitOptions): number {
  let advanced = 0;
  for (const beat of beats) {
    if (beat.isRest) {
      emitRest(L, beat, o);
      advanced += beat.durTicks;
      continue;
    }
    beat.notes.forEach((n, i) => emitNote(L, beat, n, i > 0, o));
    advanced += beat.durTicks;
  }
  return advanced;
}

function emitRest(L: string[], beat: IRBeat, o: EmitOptions): void {
  L.push(`${NOTE_INDENT}<note>`);
  L.push(`${NOTE_INDENT}  ${beat.measureRest ? '<rest measure="yes"/>' : '<rest/>'}`);
  L.push(`${NOTE_INDENT}  <duration>${beat.durTicks}</duration>`);
  L.push(`${NOTE_INDENT}  <voice>${o.voice}</voice>`);
  // A measure rest carries no <type>: it is a whole-bar symbol, not a whole note.
  if (!beat.measureRest) {
    L.push(`${NOTE_INDENT}  <type>${beat.durationType}</type>${'<dot/>'.repeat(beat.dots)}`);
  }
  if (o.staff !== undefined) L.push(`${NOTE_INDENT}  <staff>${o.staff}</staff>`);
  L.push(`${NOTE_INDENT}</note>`);
}

function emitNote(L: string[], beat: IRBeat, n: IRNote, isChordMember: boolean, o: EmitOptions): void {
  // A tied TAB continuation carries duration and tie semantics but no second fret attack;
  // hiding just that staff-2 glyph avoids a repeated digit while the notation staff keeps its
  // tie arc. Both variants still emit their tie/tied elements.
  const suppressTabContinuation = o.isTab && n.tieStop;
  const suppressPrint =
    o.isTab && (suppressTabContinuation || n.unplayable || n.string === undefined || n.fret === undefined);

  L.push(`${NOTE_INDENT}<note${suppressPrint ? ' print-object="no"' : ''}>`);
  if (isChordMember) L.push(`${NOTE_INDENT}  <chord/>`); // must precede <pitch> (XSD order)
  L.push(`${NOTE_INDENT}  ${pitchXml(n, o.octaveShift)}`);
  L.push(`${NOTE_INDENT}  <duration>${beat.durTicks}</duration>`);
  if (n.tieStop) L.push(`${NOTE_INDENT}  <tie type="stop"/>`);
  if (n.tieStart) L.push(`${NOTE_INDENT}  <tie type="start"/>`);
  L.push(`${NOTE_INDENT}  <voice>${o.voice}</voice>`);
  // THE UNCONDITIONAL LAW: a pitched <note> always ships a <type>.
  L.push(`${NOTE_INDENT}  <type>${beat.durationType}</type>${'<dot/>'.repeat(beat.dots)}`);
  if (n.accidentalDisplay && !o.isTab) {
    L.push(`${NOTE_INDENT}  <accidental>${n.accidentalDisplay}</accidental>`);
  }
  if (beat.tuplet) {
    L.push(
      `${NOTE_INDENT}  <time-modification><actual-notes>${beat.tuplet.actual}</actual-notes><normal-notes>${beat.tuplet.normal}</normal-notes></time-modification>`
    );
  }
  if (o.staff !== undefined) L.push(`${NOTE_INDENT}  <staff>${o.staff}</staff>`);
  if (o.withBeams && !isChordMember && beat.beams?.length) {
    beat.beams.forEach((state, i) => L.push(`${NOTE_INDENT}  <beam number="${i + 1}">${state}</beam>`));
  }

  const notations: string[] = [];
  if (n.tieStop) notations.push('<tied type="stop"/>');
  if (n.tieStart) notations.push('<tied type="start"/>');
  if (o.withTuplets && beat.tuplet?.start) notations.push('<tuplet type="start" number="1" bracket="yes"/>');
  if (o.withTuplets && beat.tuplet?.stop) notations.push('<tuplet type="stop" number="1"/>');
  if (n.staccato && !o.isTab) notations.push('<articulations><staccato/></articulations>');
  if (o.withTechnical && !suppressTabContinuation && n.string !== undefined && n.fret !== undefined && !n.unplayable) {
    // THE FLIP: the IR counts 1 from the lowest string, MusicXML from the highest (§8.1).
    notations.push(
      `<technical><string>${musicXmlStringFromIrString(n.string, o.stringCount)}</string><fret>${n.fret}</fret></technical>`
    );
  }
  if (notations.length) L.push(`${NOTE_INDENT}  <notations>${notations.join('')}</notations>`);
  L.push(`${NOTE_INDENT}</note>`);
}

/**
 * G.4: "assert the running cursor sum equals the expected measure length and fail loudly".
 * A wrong <backup> produces a schema-valid, well-formed file that renders voice 2 in the wrong
 * horizontal position. It never throws. It just looks wrong. One assertion catches most of it.
 */
function assertMeasureLength(advanced: number, bar: IRBar): void {
  if (advanced !== bar.durTicks) {
    throw new Error(
      `MusicXML measure ${bar.number} (index ${bar.index}) advanced ${advanced} ticks but the bar is ${bar.durTicks}`
    );
  }
}

/** G.5: tuplet starts and stops must balance per measure. */
function assertTupletBalance(beats: IRBeat[], bar: IRBar): void {
  const open = new Map<string, number>();
  for (const b of beats) {
    if (!b.tuplet) continue;
    if (b.tuplet.start) open.set(b.tuplet.id, (open.get(b.tuplet.id) ?? 0) + 1);
    if (b.tuplet.stop) open.set(b.tuplet.id, (open.get(b.tuplet.id) ?? 0) - 1);
  }
  for (const [id, n] of open) {
    if (n !== 0) throw new Error(`MusicXML measure ${bar.number}: tuplet ${id} start/stop unbalanced (${n})`);
  }
}
