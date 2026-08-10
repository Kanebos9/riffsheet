/**
 * buildScore — the one entry point. Pure function of (input, settings).
 *
 * THE ORDER OF THE STATIONS IS THE PRODUCT. midi-semantics-research.md §9 lists six ordering
 * constraints and calls each one "a bug if violated". All six are enforced here and nowhere
 * else, so this file is the place to check them:
 *
 *   1. chord grouping BEFORE quantization              (collectChords, in seconds)
 *   2. tuplet detection BEFORE quantization            (inside quantizeOnsets, per beat)
 *   3. legato-pair detection BEFORE string assignment  (detectLegatoPairs -> assignStrings)
 *   4. key BEFORE spelling BEFORE accidental display   (detectKey -> spellNoteList -> display)
 *   5. beaming AFTER the time signature and tie-split  (computeBeams, on the finished bars)
 *
 * And the one that owns the user's actual complaint: the rest killer runs BETWEEN quantization
 * and bar construction, so that by the time anything constructs a rest, the gaps are gone.
 */

import { DIVISIONS, type IRBar, type IRBeat, type IRKeySignature, type IRNote, type IRVoice, type RiffsheetIR, type BeamState, type DurationType } from './ir.js';
import { Rational } from './rational.js';
import { resolveSettings, type BuildInput, type BuildSettings, type InputNote } from './types.js';
import { applyGuards } from './guards.js';
import { buildTimeSkeleton, compoundEvidence, type TimeSkeleton } from './timeSkeleton.js';
import { clampOverlaps, collectChords, type ChordEvent } from './chords.js';
import { quantizeOnsets, type QuantNote } from './quantize.js';
import { minimizeNumberOfRests, snapLeadingOnset, type SimplifyBar, type SimplifyEvent } from './simplify.js';
import { buildBarMetric, glyphFor, toDurationList, tupletWrittenLen, VOCABULARY, type BarMetric } from './meter.js';
import { detectKey } from './key.js';
import { accidentalDisplayForMeasure, spellNoteList, type DisplayNote } from './spelling.js';
import { chooseClefs } from './clef.js';
import { assignStrings, detectLegatoPairs, survivingLegato, type TabNoteInput } from './tab.js';
import { toMusicXML } from './musicxml.js';
import { toMidi } from './midi.js';
import { toAlphaTabModelData, type AlphaTabScoreData } from './alphatab.js';

export interface BuildDiagnostics {
  meterReason: string;
  jitterTicks: number;
  compound: ReturnType<typeof compoundEvidence>;
  basicQuantTicks: number;
}

export interface BuildResult {
  ir: RiffsheetIR;
  diagnostics: BuildDiagnostics;
  toMusicXML(): string;
  toMidi(quantized: boolean): Uint8Array;
  toAlphaTabModelData(): AlphaTabScoreData;
}

interface PlacedEvent {
  chord: ChordEvent;
  startTick: number;
  offTick: number;
  tupletId?: string;
  staccato: boolean;
}

const BEAM_LEVEL: Partial<Record<DurationType, number>> = { eighth: 1, '16th': 2, '32nd': 3 };

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function exactTiming(chord: ChordEvent): { startTick: number; endTick: number } | null {
  const source = chord.notes.map((note) => note.sourceTiming);
  if (!source.length || source.some((timing) => !timing || !Number.isFinite(timing.ppq) || timing.ppq <= 0)) return null;
  const ppq = source[0]!.ppq;
  if (source.some((timing) => timing!.ppq !== ppq)) return null;
  const scale = DIVISIONS / ppq;
  return {
    startTick: Math.min(...source.map((timing) => timing!.startTick)) * scale,
    endTick: Math.max(...source.map((timing) => timing!.endTick)) * scale
  };
}

/** Add ordinary bars only when a snapped final onset (or exact symbolic duration) needs one. */
function extendSkeletonThrough(skel: TimeSkeleton, requiredTick: number): void {
  let guard = 0;
  while (requiredTick >= skel.totalTicks && guard++ < 256) {
    const previous = skel.bars[skel.bars.length - 1];
    if (!previous) break;
    const next = {
      index: skel.bars.length,
      startBeatIdx: previous.startBeatIdx + previous.beats,
      beats: previous.beats,
      startTick: skel.totalTicks,
      ticks: previous.ticks,
      timeSig: previous.timeSig,
      timeSigChanged: false,
      number: previous.implicit ? 1 : previous.number + 1,
      implicit: false
    };
    skel.bars.push(next);
    skel.totalTicks += next.ticks;
    skel.downbeatTimesSec.push(skel.beatIdxToSeconds(next.startBeatIdx));
  }
}

function authoritativeKey(value: number): IRKeySignature {
  const fifths = Math.max(-7, Math.min(7, Math.round(value)));
  return {
    fifths,
    confidence: 1,
    accepted: true,
    candidates: [{ fifths, score: 1, label: `Manual (${fifths} fifths)` }]
  };
}

function applySymbolicBars(skel: TimeSkeleton, source: NonNullable<InputNote['sourceBars']>): boolean {
  if (!source.length) return false;
  const mapped = source.map((bar, index) => {
    if (!Number.isFinite(bar.ppq) || bar.ppq <= 0 || !Number.isFinite(bar.startTick) || !Number.isFinite(bar.durationTicks)) return null;
    const scale = DIVISIONS / bar.ppq;
    const startTick = Math.round(bar.startTick * scale);
    const ticks = Math.round(bar.durationTicks * scale);
    if (startTick < 0 || ticks <= 0) return null;
    const compound = bar.timeSig[1] === 8 && bar.timeSig[0] > 3 && bar.timeSig[0] % 3 === 0;
    return {
      index,
      startBeatIdx: 0,
      beats: compound ? bar.timeSig[0] / 3 : bar.timeSig[0],
      startTick,
      ticks,
      timeSig: bar.timeSig,
      timeSigChanged:
        index === 0 ||
        source[index - 1].timeSig[0] !== bar.timeSig[0] ||
        source[index - 1].timeSig[1] !== bar.timeSig[1],
      number: bar.number,
      implicit: bar.implicit
    };
  });
  if (mapped.some((bar) => !bar)) return false;
  const bars = mapped as TimeSkeleton['bars'];
  for (let index = 1; index < bars.length; index++) {
    if (bars[index].startTick !== bars[index - 1].startTick + bars[index - 1].ticks) return false;
  }
  bars[0].startBeatIdx = skel.originBeatIdx;
  for (let index = 1; index < bars.length; index++) {
    bars[index].startBeatIdx = bars[index - 1].startBeatIdx + bars[index - 1].beats;
  }
  skel.bars.splice(0, skel.bars.length, ...bars);
  skel.totalTicks = bars[bars.length - 1].startTick + bars[bars.length - 1].ticks;
  skel.timeSig = [bars[0].timeSig[0], bars[0].timeSig[1]];
  skel.compound = bars[0].timeSig[1] === 8 && bars[0].timeSig[0] > 3 && bars[0].timeSig[0] % 3 === 0;
  skel.downbeatTimesSec.splice(0, skel.downbeatTimesSec.length, ...bars.map((bar) => skel.tickToSeconds(bar.startTick)));
  return true;
}

export function buildScore(input: BuildInput, settings: BuildSettings): BuildResult {
  const s = resolveSettings(settings);

  // ---- station 7 (input half): guards ------------------------------------------------------
  // Ids are assigned from the ORIGINAL index BEFORE anything is filtered. webcore/IR.md is
  // explicit that ids must be stable across pipeline re-runs: Team B's undo stack, selection and
  // edit popover are all keyed on them, and the pipeline re-runs on every settings change and
  // every drag of the "bar 1" marker. Numbering after the guard would renumber every later note
  // the moment one artefact is dropped.
  const identified: InputNote[] = (input.notes ?? []).map((n, i) => ({ ...n, id: n.id ?? `n${i}` }));
  const guard = applyGuards(identified, input.audioDurationSec);
  const notes: InputNote[] = guard.notes;

  // ---- station 1: time skeleton -------------------------------------------------------------
  const skel = buildTimeSkeleton({ ...input, notes }, s);
  const sourceCarrier = identified.find((note) => note.sourceBars?.length);
  const sourceBarsApplied = sourceCarrier?.sourceBars ? applySymbolicBars(skel, sourceCarrier.sourceBars) : false;
  const ibis: number[] = [];
  for (let i = 1; i < skel.beatTimesSec.length; i++) {
    ibis.push(skel.beatTimesSec[i] - skel.beatTimesSec[i - 1]);
  }
  const beatPeriod = median(ibis) || 0.5;

  // ---- station 4: chords, BEFORE quantization ----------------------------------------------
  const chords = clampOverlaps(collectChords(notes, beatPeriod));

  // ---- station 1b: quantize ------------------------------------------------------------------
  const sourceTiming = chords.map(exactTiming);
  const exactSymbolicTiming = sourceTiming.length > 0 && sourceTiming.every((timing) => timing !== null);
  const quantInput: QuantNote[] = chords.map((c, i) => {
    const exact = sourceTiming[i];
    return {
      id: `e${i}`,
      rawStartTick: exact ? exact.startTick : skel.secondsToTick(c.onsetSec),
      rawOffTick: exact ? Math.max(exact.startTick + 1, exact.endTick) : skel.secondsToTick(Math.max(c.endSec, c.onsetSec + 1e-4))
    };
  });
  const rawQuant = quantizeOnsets(quantInput, {
    grid: exactSymbolicTiming ? 'free' : s.grid,
    ticksPerBeat: skel.ticksPerBeat,
    compound: skel.compound,
    totalTicks: skel.totalTicks
  });

  const quant = rawQuant;

  const qNotes = [...quant.notes].sort((a, b) => a.startTick - b.startTick);
  if (qNotes.length) {
    const requiredTick = exactSymbolicTiming
      ? Math.max(...qNotes.map((note) => note.offTick)) - 1
      : Math.max(...qNotes.map((note) => note.startTick));
    extendSkeletonThrough(skel, requiredTick);
  }

  const metrics: BarMetric[] = skel.bars.map((b) => {
    const compound = b.timeSig[1] === 8 && b.timeSig[0] > 3 && b.timeSig[0] % 3 === 0;
    return buildBarMetric(b.timeSig[0], b.timeSig[1], compound);
  });
  const simplifyBars: SimplifyBar[] = skel.bars.map((b, i) => ({
    startTick: b.startTick,
    ticks: b.ticks,
    metric: metrics[i]
  }));

  const chordById = new Map(quantInput.map((q, i) => [q.id, chords[i]]));
  if (qNotes.length && !exactSymbolicTiming) {
    qNotes[0].startTick = snapLeadingOnset(qNotes[0].startTick, simplifyBars[0].startTick, DIVISIONS);
  }

  // ---- station 2: the rest killer ------------------------------------------------------------
  // sounding/IOI per event, measured in SECONDS before quantization — the staccato gate (§5.1).
  const soundingRatios = new Map<string, number>();
  quantInput.forEach((qi, i) => {
    const c = chords[i];
    const next = chords[i + 1];
    const ioi = next ? next.onsetSec - c.onsetSec : c.endSec - c.onsetSec;
    soundingRatios.set(qi.id, ioi > 0 ? (c.endSec - c.onsetSec) / ioi : 1);
  });
  const simplifyEvents: SimplifyEvent[] = qNotes.map((n) => ({
    startTick: n.startTick,
    offTick: n.offTick,
    ...(n.tupletId ? { tupletId: n.tupletId } : {}),
    ...(soundingRatios.has(n.id) ? { soundingRatio: soundingRatios.get(n.id)! } : {})
  }));
  const tupletMap = new Map(
    quant.tuplets.map((t) => [t.id, { startTick: t.startTick, endTick: t.endTick, unitTicks: t.unitTicks }])
  );
  const lengthened = minimizeNumberOfRests(simplifyEvents, {
    divisions: DIVISIONS,
    bars: simplifyBars,
    basicQuantTicks: quant.basicQuantTicks,
    compound: skel.compound,
    tuplets: tupletMap,
    fillGaps: s.fillGaps && s.grid !== 'free' && !exactSymbolicTiming,
    showStaccato: s.showStaccato
  });

  // A final ring-out may not extend past the last bar: there is nothing there to tie to, and a
  // dangling <tie type="start"/> is a broken file.
  //
  // ZIP FIRST, FILTER SECOND. `lengthened[i]` is positional against `qNotes`; filtering before
  // the map silently pairs each surviving note with the wrong result.
  const placed: PlacedEvent[] = qNotes
    .map((n, i) => ({
      chord: chordById.get(n.id)!,
      startTick: n.startTick,
      offTick: Math.min(lengthened[i].offTick, skel.totalTicks),
      ...(n.tupletId ? { tupletId: n.tupletId } : {}),
      staccato: lengthened[i].staccato
    }))
    .filter((p) => p.startTick < skel.totalTicks && p.offTick > p.startTick);

  // ---- station 5: tab (legato pairs FIRST) ---------------------------------------------------
  const tabInputs: TabNoteInput[] = notes.map((n) => ({
    id: n.id!,
    midi: n.midi,
    startSec: n.startSec,
    endSec: n.endSec,
    ...(n.stringOverride !== undefined ? { stringOverride: n.stringOverride } : {})
  }));
  const legatoPairs = detectLegatoPairs(tabInputs);
  const assignments = assignStrings(tabInputs, {
    tuningMidi: s.tuningMidi,
    fingeringStyle: s.fingeringStyle,
    capo: s.capo,
    ...(s.maxFret !== undefined ? { maxFret: s.maxFret } : {}),
    legatoPairs
  });
  const assignmentById = new Map(assignments.map((a) => [a.id, a]));
  const surviving = survivingLegato(legatoPairs, assignments);
  const legatoById = new Map(surviving.map((p) => [p.fromId, p]));

  // ---- station 3a: key -----------------------------------------------------------------------
  const durationSec = notes.length ? Math.max(...notes.map((n) => n.endSec)) - Math.min(...notes.map((n) => n.startSec)) : 0;
  const key = s.keyFifths !== undefined
    ? authoritativeKey(s.keyFifths)
    : detectKey(
        notes.map((n) => ({ midi: n.midi, weight: Math.max(0, n.endSec - n.startSec) })),
        { bars: skel.bars.filter((b) => !b.implicit).length, durationSec }
      );

  // ---- bars: rests are constructed here, and only here ---------------------------------------
  const built = buildBars(placed, skel, metrics, quant.tuplets, s.showStaccato, key.fifths);
  built.stats.gapsAbsorbed = lengthened.filter((l) => l.absorbedTicks > 0).length;

  // ---- station 3b: spelling, then accidental display -----------------------------------------
  const orderedSourceNotes: { id: string; midi: number }[] = [];
  const seenSource = new Set<string>();
  for (const bar of built.bars) {
    for (const v of bar.voices) {
      for (const beat of v.beats) {
        for (const n of beat.notes) {
          if (!seenSource.has(n.id)) {
            seenSource.add(n.id);
            orderedSourceNotes.push({ id: n.id, midi: n.midi });
          }
        }
      }
    }
  }
  const spelled = spellNoteList(
    orderedSourceNotes.map((n) => n.midi),
    key.fifths
  );
  const spellingById = new Map(orderedSourceNotes.map((n, i) => [n.id, spelled[i]]));
  for (const bar of built.bars) {
    const display: DisplayNote[] = [];
    const refs: IRNote[] = [];
    let slot = 0;
    for (const v of bar.voices) {
      for (const beat of v.beats) {
        for (const n of beat.notes) {
          const sp = spellingById.get(n.id)!;
          n.step = sp.step;
          n.alter = sp.alter;
          n.octave = sp.octave;
          display.push({ step: sp.step, alter: sp.alter, octave: sp.octave, tieStop: n.tieStop, slot });
          refs.push(n);
        }
        slot++;
      }
    }
    const shown = accidentalDisplayForMeasure(display, key.fifths);
    shown.forEach((acc, i) => {
      if (acc) refs[i].accidentalDisplay = acc;
    });
  }

  // ---- station 3c: clefs ----------------------------------------------------------------------
  const barPitches = built.bars.map((b) =>
    b.voices.flatMap((v) => v.beats.flatMap((beat) => beat.notes.map((n) => n.midi)))
  );
  const clefs = chooseClefs(barPitches, s.instrument, s.clefMode);
  built.bars.forEach((b, i) => {
    b.clef = clefs.perBar[i] ?? { sign: 'F', line: 4, changed: i === 0 };
  });
  // Imported F4/G2 clefs are authoritative where unambiguous. A true grand staff can expose
  // two source clefs in the same bar; the single-staff IR cannot represent both, so retain the
  // stable base clef and raise grandStaff rather than guessing which source staff wins.
  const sourceClefById = new Map(notes.filter((note) => note.sourceClef).map((note) => [note.id!, note.sourceClef!]));
  let previousSourceClef: 'treble' | 'bass' | undefined;
  let simultaneousSourceClefs = false;
  for (const bar of built.bars) {
    const inBar = new Set(
      bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes.map((note) => sourceClefById.get(note.id)).filter(Boolean)))
    );
    if (inBar.size > 1) {
      simultaneousSourceClefs = true;
      continue;
    }
    const sourceClef = [...inBar][0] as 'treble' | 'bass' | undefined;
    if (!sourceClef) {
      // Empty source measures inherit the last authoritative source clef. A non-empty measure
      // without a supported source clef keeps the stable generated clef rather than guessing.
      const hasNotes = bar.voices.some((voice) => voice.beats.some((beat) => beat.notes.length > 0));
      if (previousSourceClef && !hasNotes) {
        bar.clef = {
          sign: previousSourceClef === 'treble' ? 'G' : 'F',
          line: previousSourceClef === 'treble' ? 2 : 4,
          changed: false
        };
      }
      continue;
    }
    const sign = sourceClef === 'treble' ? 'G' : 'F';
    const line = sourceClef === 'treble' ? 2 : 4;
    bar.clef = { sign, line, changed: previousSourceClef === undefined || sourceClef !== previousSourceClef };
    previousSourceClef = sourceClef;
  }

  // ---- tab + legato onto the IR notes ---------------------------------------------------------
  for (const bar of built.bars) {
    for (const v of bar.voices) {
      for (const beat of v.beats) {
        for (const n of beat.notes) {
          const a = assignmentById.get(n.id);
          if (a?.position) {
            n.string = a.position.string;
            n.fret = a.position.fret - s.capo;
            if (a.tabOctaveShift) n.tabOctaveShift = a.tabOctaveShift;
          } else {
            n.unplayable = true;
          }
          const pair = legatoById.get(n.id);
          if (pair) n.legato = { kind: pair.kind, to: pair.toId };
        }
      }
    }
  }

  // ---- beams (after tie-splitting, per §3.6) ---------------------------------------------------
  for (const bar of built.bars) {
    for (const v of bar.voices) applyBeams(v.beats, bar.beamBoundaries);
  }

  const diagnosticLines = [
    skel.meterReason,
    skel.external ? 'grid: host DAW (external)' : skel.synthesised ? 'grid: synthesised, no beats supplied' : 'grid: detected beats',
    `quantizer: basicQuant ${quant.basicQuantTicks} ticks, jitter ${quant.jitterTicks.toFixed(2)} ticks`,
    key.accepted ? `key: fifths ${key.fifths} (confidence ${key.confidence})` : (key.reason ?? 'key: open'),
    `rests: ${built.stats.restGlyphs} of ${built.stats.restGlyphs + built.stats.noteGlyphs} glyphs (${(built.stats.restDensity * 100).toFixed(1)}%), ${built.stats.gapsAbsorbed} gaps absorbed`,
    ...(exactSymbolicTiming
      ? [`timing: exact symbolic ticks preserved${sourceBarsApplied ? ' with source bars/meter' : ''}`]
      : []),
    ...(guard.pastEndDropped ? [`${guard.pastEndDropped} note(s) dropped past the end of the audio`] : []),
    ...(guard.tooShortDropped ? [`${guard.tooShortDropped} sub-30ms fragment(s) dropped`] : []),
    ...(guard.repeatLoops.length ? [`${guard.repeatLoops.length} repeat-loop suspect(s) flagged for audio review`] : [])
  ];

  const ir: RiffsheetIR = {
    version: 1,
    divisions: DIVISIONS,
    ppq: DIVISIONS,
    quantized: s.grid !== 'free' && !exactSymbolicTiming,
    durationSec,
    diagnostics: diagnosticLines,
    title: s.title,
    ...(s.composer ? { composer: s.composer } : {}),
    key,
    tempo: {
      displayBpm: skel.displayBpm,
      beatTimesSec: skel.beatTimesSec,
      downbeatTimesSec: skel.downbeatTimesSec,
      synthesised: skel.synthesised,
      ...(sourceCarrier?.sourceTempoChanges?.length
        ? {
            changes: sourceCarrier.sourceTempoChanges.map((change) => ({
              tick: Math.round((change.tick * DIVISIONS) / change.ppq),
              bpm: change.bpm
            }))
          }
        : {})
    },
    timeSig: skel.timeSig,
    compound: skel.compound,
    ...(() => {
      const offsets = [...new Set(notes.map((note) => note.displayPitchOffset).filter((value): value is number => value !== undefined))];
      return offsets.length === 1 ? { displayPitchOffset: offsets[0] } : {};
    })(),
    instrument: {
      kind: s.instrument,
      tuningMidi: s.tuningMidi,
      stringCount: s.tuningMidi.length,
      capo: s.capo
    },
    grandStaff: clefs.grandStaff || simultaneousSourceClefs,
    bars: built.bars,
    suspects: {
      repeatLoops: guard.repeatLoops,
      pastEndDropped: guard.pastEndDropped,
      tooShortDropped: guard.tooShortDropped
    },
    stats: built.stats
  };

  const diagnostics: BuildDiagnostics = {
    meterReason: skel.meterReason,
    jitterTicks: quant.jitterTicks,
    compound: compoundEvidence(notes.map((n) => n.startSec), skel),
    basicQuantTicks: quant.basicQuantTicks
  };

  return {
    ir,
    diagnostics,
    toMusicXML: () => toMusicXML(ir),
    toMidi: (quantized: boolean) => toMidi(ir, skel, notes, quantized),
    toAlphaTabModelData: () => toAlphaTabModelData(ir)
  };
}

// ---- bar construction --------------------------------------------------------------------------

interface BuiltBars {
  bars: IRBar[];
  stats: RiffsheetIR['stats'];
}

function newNote(src: InputNote, tieStart: boolean, tieStop: boolean, staccato: boolean): IRNote {
  return {
    id: src.id!,
    midi: src.midi,
    step: 'C',
    alter: 0,
    octave: 4,
    tieStart,
    tieStop,
    ...(staccato ? { staccato: true } : {}),
    ...(src.velocity !== undefined ? { velocity: src.velocity } : {}),
    ...(src.confidence !== undefined ? { confidence: src.confidence } : {}),
    // webcore/IR.md: "please carry the original detected times through" — the as-played MIDI
    // export is made of these, and without them it silently falls back to the quantized one.
    startSec: src.startSec,
    endSec: src.endSec,
    ...(src.sourceStaffIndex !== undefined ? { sourceStaffIndex: src.sourceStaffIndex } : {})
  };
}

function typeOf(len: Rational): { durationType: DurationType; dots: 0 | 1 } {
  const g = glyphFor(len);
  if (g) return { durationType: g.type, dots: g.dots };
  // Unreachable for anything the meter module produced; fall back to the nearest printable
  // value so a glyph without a <type> can never ship (that is the documented sheet-crash).
  let best = VOCABULARY[VOCABULARY.length - 1];
  let bestDistance = Infinity;
  for (const v of VOCABULARY) {
    const d = Math.abs(Math.log2(Math.max(1e-9, len.toNumber()) / v.len.toNumber()));
    if (d < bestDistance) {
      bestDistance = d;
      best = v;
    }
  }
  return { durationType: best.type, dots: best.dots };
}

function buildBars(
  placed: PlacedEvent[],
  skel: TimeSkeleton,
  metrics: BarMetric[],
  tuplets: { id: string; startTick: number; endTick: number; unitTicks: number; actual: number; normal: number }[],
  showStaccato: boolean,
  keyFifths: number
): BuiltBars {
  const tupletById = new Map(tuplets.map((t) => [t.id, t]));
  const bars: IRBar[] = [];
  const stats = {
    noteGlyphs: 0,
    restGlyphs: 0,
    restDensity: 0,
    restsShorterThanEighth: 0,
    tupletRests: 0,
    tiedGlyphs: 0,
    staccatoNotes: 0,
    gapsAbsorbed: 0
  };
  const EIGHTH = Rational.of(1, 8);

  let ei = 0;
  let carry: PlacedEvent | null = null;

  for (let bi = 0; bi < skel.bars.length; bi++) {
    const bar = skel.bars[bi];
    const metric = metrics[bi];
    const barStart = bar.startTick;
    const barEnd = barStart + bar.ticks;
    const beats: IRBeat[] = [];
    let cursor = barStart;
    let sawNote = false;

    const emitNote = (ev: PlacedEvent, from: number, to: number, tieInFirst: boolean, tieOutLast: boolean): void => {
      if (to <= from) return;
      sawNote = true;
      const group = ev.tupletId ? tupletById.get(ev.tupletId) : undefined;
      const pieces: Rational[] = group
        ? [Rational.fromTicks(to - from, DIVISIONS)]
        : toDurationList(
            metric,
            Rational.fromTicks(from - barStart, DIVISIONS),
            Rational.fromTicks(to - from, DIVISIONS),
            'note'
          );
      let t = from;
      pieces.forEach((len, pi) => {
        const ticks = Math.min(len.toTicksRounded(DIVISIONS), to - t);
        if (ticks <= 0) return;
        const first = pi === 0;
        const lastPiece = pi === pieces.length - 1;
        const tieStop = first ? tieInFirst : true;
        const tieStart = lastPiece ? tieOutLast : true;
        // Written value inside a tuplet is the SOUNDING value scaled by actual/normal; the
        // MusicXML <type> is the written one while <duration> stays the sounding one.
        const shown = group
          ? typeOf(tupletWrittenLen(metric.beatLen, Math.max(1, Math.round(ticks / group.unitTicks)), group.normal))
          : typeOf(len);
        const singleGlyph = pieces.length === 1 && !tieStop && !tieStart;
        const staccato = showStaccato && ev.staccato && lastPiece && singleGlyph;
        if (staccato) stats.staccatoNotes++;
        if (tieStart || tieStop) stats.tiedGlyphs++;
        stats.noteGlyphs++;
        beats.push({
          startTick: t - barStart,
          durTicks: ticks,
          isRest: false,
          durationType: shown.durationType,
          dots: shown.dots,
          ...(group
            ? {
                tuplet: {
                  id: group.id,
                  actual: group.actual,
                  normal: group.normal,
                  start: false,
                  stop: false
                }
              }
            : {}),
          notes: ev.chord.notes.map((src) => newNote(src, tieStart, tieStop, staccato))
        });
        t += ticks;
      });
    };

    const emitRest = (from: number, to: number): void => {
      if (to <= from) return;
      const wholeBar = from === barStart && to === barEnd;
      if (wholeBar) {
        stats.restGlyphs++;
        beats.push({
          startTick: 0,
          durTicks: bar.ticks,
          isRest: true,
          durationType: 'whole',
          dots: 0,
          measureRest: true,
          notes: []
        });
        return;
      }
      const pieces = toDurationList(
        metric,
        Rational.fromTicks(from - barStart, DIVISIONS),
        Rational.fromTicks(to - from, DIVISIONS),
        'rest'
      );
      let t = from;
      for (const len of pieces) {
        const ticks = Math.min(len.toTicksRounded(DIVISIONS), to - t);
        if (ticks <= 0) continue;
        const shown = typeOf(len);
        stats.restGlyphs++;
        if (len.lt(EIGHTH)) stats.restsShorterThanEighth++;
        beats.push({
          startTick: t - barStart,
          durTicks: ticks,
          isRest: true,
          durationType: shown.durationType,
          dots: shown.dots,
          notes: []
        });
        t += ticks;
      }
    };

    if (carry) {
      const to = Math.min(carry.offTick, barEnd);
      emitNote(carry, barStart, to, true, carry.offTick > barEnd);
      cursor = to;
      carry = carry.offTick > barEnd ? carry : null;
    }

    while (ei < placed.length && placed[ei].startTick < barEnd) {
      const ev = placed[ei];
      if (ev.startTick > cursor) emitRest(cursor, ev.startTick);
      const to = Math.min(ev.offTick, barEnd);
      emitNote(ev, Math.max(ev.startTick, cursor), to, false, ev.offTick > barEnd);
      cursor = Math.max(cursor, to);
      if (ev.offTick > barEnd) {
        carry = ev;
        ei++;
        break;
      }
      ei++;
    }

    if (cursor < barEnd) emitRest(cursor, barEnd);
    void sawNote;

    // tuplet start/stop markers, per group, per bar
    const seenGroups = new Map<string, IRBeat[]>();
    for (const b of beats) {
      if (!b.tuplet) continue;
      const g = seenGroups.get(b.tuplet.id) ?? [];
      g.push(b);
      seenGroups.set(b.tuplet.id, g);
    }
    for (const group of seenGroups.values()) {
      group[0].tuplet!.start = true;
      group[group.length - 1].tuplet!.stop = true;
    }
    for (const b of beats) if (b.isRest && b.tuplet) stats.tupletRests++;

    const voices: IRVoice[] = [{ id: 1, beats }];
    bars.push({
      index: bi,
      number: bar.number,
      implicit: bar.implicit,
      startTick: barStart,
      durTicks: bar.ticks,
      timeSig: bar.timeSig,
      timeSigChanged: bar.timeSigChanged,
      keyFifths,
      keyChanged: bi === 0,
      clef: { sign: 'F', line: 4, changed: bi === 0 },
      beamBoundaries: metric.beatPositions.map((p) => p.toTicksRounded(DIVISIONS)),
      voices
    });
  }

  const total = stats.noteGlyphs + stats.restGlyphs;
  stats.restDensity = total ? stats.restGlyphs / total : 0;
  return { bars, stats };
}

// ---- beaming -------------------------------------------------------------------------------------

/**
 * §3.6: beam grouping is "which partition of the beam MeterSequence does this note's offset
 * fall into". Since v1 supports {4/4, 3/4, 2/4} plus overrides, the partition collapses to one
 * group per beat. THE RULE READERS ACTUALLY RELY ON: never beam across a beat boundary in 4/4.
 * A rest, a quarter-or-longer value, a boundary straddle, or a tuplet-group change all break an
 * open group; singletons keep their flag.
 */
export function applyBeams(beats: IRBeat[], boundaries: number[]): void {
  const windowOf = (b: IRBeat): number => {
    for (let w = 0; w + 1 < boundaries.length; w++) {
      if (b.startTick >= boundaries[w] && b.startTick + b.durTicks <= boundaries[w + 1]) return w;
    }
    return -1;
  };
  let group: IRBeat[] = [];
  let groupWindow = -1;
  let groupTuplet: string | undefined;

  const flush = (): void => {
    if (group.length >= 2) {
      group.forEach((b, i) => {
        const state: BeamState = i === 0 ? 'begin' : i === group.length - 1 ? 'end' : 'continue';
        b.beams = [state];
      });
      for (let lvl = 2; lvl <= 3; lvl++) {
        let runStart = -1;
        for (let i = 0; i <= group.length; i++) {
          const has = i < group.length && (BEAM_LEVEL[group[i].durationType] ?? 0) >= lvl;
          if (has && runStart < 0) runStart = i;
          if (!has && runStart >= 0) {
            if (i - runStart === 1) {
              const hook: BeamState = runStart === 0 ? 'forward hook' : 'backward hook';
              group[runStart].beams!.push(hook);
            } else {
              for (let k = runStart; k < i; k++) {
                const state: BeamState = k === runStart ? 'begin' : k === i - 1 ? 'end' : 'continue';
                group[k].beams!.push(state);
              }
            }
            runStart = -1;
          }
        }
      }
    }
    group = [];
    groupWindow = -1;
    groupTuplet = undefined;
  };

  for (const b of beats) {
    const level = b.isRest ? 0 : BEAM_LEVEL[b.durationType] ?? 0;
    if (level < 1) {
      flush();
      continue;
    }
    const w = windowOf(b);
    if (w < 0) {
      flush();
      continue;
    }
    if (group.length && (w !== groupWindow || b.tuplet?.id !== groupTuplet)) flush();
    if (!group.length) {
      groupWindow = w;
      groupTuplet = b.tuplet?.id;
    }
    group.push(b);
  }
  flush();
}
