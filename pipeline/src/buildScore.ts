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
 * DURATIONS ARE NOT NEGOTIATED. Station 2b used to lengthen every note over the silence behind
 * it; that pass is deleted (simplify.ts explains why at length). What reaches bar construction
 * is the played length, snapped to the grid and clamped so one voice never holds two notes at
 * once. Silence that was played is printed as a rest, including a short one.
 */

import { DIVISIONS, notationIntentTicks, type IRBar, type IRBeat, type IRKeySignature, type IRNote, type IRVoice, type RiffsheetIR, type DurationType } from './ir.js';
import { Rational } from './rational.js';
import { resolveSettings, type BuildInput, type BuildSettings, type InputNote } from './types.js';
import { applyGuards } from './guards.js';
import { buildTimeSkeleton, compoundEvidence, type TimeSkeleton } from './timeSkeleton.js';
import { placeSymbolicEvents, type SymbolicEvent } from './symbolic.js';
import { validateIR } from './validate.js';
import { clampOverlaps, collectChords, type ChordEvent } from './chords.js';
import { quantizeOnsets, type QuantNote } from './quantize.js';
import { clampEventOverlaps, snapLeadingOnset, type SimplifyEvent } from './simplify.js';
import {
  buildBarMetric,
  glyphFor,
  simplestDurationList,
  toDurationList,
  tupletUnitPieces,
  tupletWrittenLen,
  VOCABULARY,
  type BarMetric
} from './meter.js';
import { detectKey } from './key.js';
import { accidentalDisplayForMeasure, spellNoteList, type DisplayNote } from './spelling.js';
import { chooseClefs, grandClefPair, grandStaffSplitter } from './clef.js';
import { assignStrings, detectLegatoPairs, survivingLegato, type TabNoteInput } from './tab.js';
import { applyBeams, markTupletEdges } from './beaming.js';
import { toMusicXML } from './musicxml.js';
import { toMidi } from './midi.js';
import { toAlphaTabModelData, type AlphaTabScoreData } from './alphatab.js';

export interface BuildDiagnostics {
  meterReason: string;
  jitterTicks: number;
  compound: ReturnType<typeof compoundEvidence>;
  basicQuantTicks: number;
  /**
   * HOW MANY SOURCE VOICES WERE FLATTENED INTO THE ONE THE PIPELINE ENGRAVES.
   *
   * 0 (or 1) means nothing was lost. Anything higher means the source really did contain
   * independent voices and this build printed them as one: overlapping notes were clamped at the
   * next attack and unisons between voices were dropped, because a single voice cannot hold two
   * notes at once or print the same notehead twice. That is the sanctioned phase-1 behaviour and
   * it is REPORTED rather than silent — a half note in voice 1 under a voice-2 quarter used to
   * come back as two sequential quarters with nothing anywhere saying so.
   */
  flattenedVoices: number;
  /** Beats whose written positions were finer than a 1/32 and were widened onto it. */
  reducedSymbolicBeats: number;
  /** True when a symbolic source changed meter mid-piece — engraved, but out of scope. */
  mixedMeter: boolean;
}

export interface BuildResult {
  ir: RiffsheetIR;
  diagnostics: BuildDiagnostics;
  /** The shared clock this part was engraved against. Multi-part MIDI needs it per part. */
  skeleton: TimeSkeleton;
  /** The guarded notes this part was engraved from — the as-played MIDI export is made of them. */
  notes: InputNote[];
  toMusicXML(): string;
  toMidi(quantized: boolean): Uint8Array;
  toAlphaTabModelData(): AlphaTabScoreData;
}

/**
 * THE MULTI-PART HOOK, and the only one. See multipart.ts.
 *
 * A score with N parts is N ordinary builds sharing one clock; everything else about a part —
 * its clefs, its staff split, its tuning, its tab, its rests — is decided from its own notes,
 * exactly as a single-part build decides them. Two decisions are NOT a part's own, because a
 * score has one of each and not N:
 *
 *   the TIME SKELETON  (origin, anacrusis, meter, bar count) — otherwise a bass part that comes
 *                      in on bar 3 would number its first bar 1 and no two parts would line up;
 *   the KEY SIGNATURE  — otherwise the guitar prints two sharps and the bass one.
 *
 * Both are derived from `sharedNotes` when it is present: every note in the SCORE, across every
 * part, pre-guard (this function applies the same guards to them that it applies to its own).
 * Absent — the ordinary single-part call — the part's own notes are the score's notes and
 * nothing changes, which is what keeps single-part output byte-identical.
 */
export interface BuildOptions {
  sharedNotes?: InputNote[];
}

/** Iterative, never `Math.max(...notes)`: a big import throws `RangeError` on the spread. */
function spanSec(notes: InputNote[]): number {
  let first = Infinity;
  let last = -Infinity;
  for (const n of notes) {
    if (n.startSec < first) first = n.startSec;
    if (n.endSec > last) last = n.endSec;
  }
  return notes.length ? last - first : 0;
}

interface PlacedEvent {
  chord: ChordEvent;
  startTick: number;
  offTick: number;
  tupletId?: string;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The chord's written span, in the SOURCE's own ticks and at the source's own resolution.
 *
 * It used to scale into IR ticks here and throw the resolution away, which is why nothing
 * downstream could tell an eighth-note triplet from a rounding artefact: 160 source ticks and
 * "8-ish IR ticks" are the same number, but only the first one still says what it means. The
 * conversion now happens in symbolic.ts, which needs the source domain to reconstruct tuplets.
 */
function exactTiming(chord: ChordEvent): { startTick: number; endTick: number; ppq: number } | null {
  const source = chord.notes.map((note) => note.sourceTiming);
  if (!source.length || source.some((timing) => !timing || !Number.isFinite(timing.ppq) || timing.ppq <= 0)) return null;
  const ppq = source[0]!.ppq;
  if (source.some((timing) => timing!.ppq !== ppq)) return null;
  let startTick = Infinity;
  let endTick = -Infinity;
  for (const timing of source) {
    if (timing!.startTick < startTick) startTick = timing!.startTick;
    if (timing!.endTick > endTick) endTick = timing!.endTick;
  }
  return { startTick, endTick, ppq };
}

/**
 * THE CHORD'S DECLARED WRITTEN LENGTH in ticks, or undefined when nobody declared one.
 *
 * A chord is ONE rhythmic slot with one written value, so its members cannot hold different ones.
 * The editing surface sets the same intent on every note of a chord it retimes, which makes this a
 * formality in practice; when they disagree anyway the LONGEST declaration wins, because the
 * alternative is silently shortening a note the user explicitly lengthened. Notes without an
 * intent do not vote — a chord where one member was edited is a chord with that member's value.
 */
function intentTicksOf(chord: ChordEvent): number | undefined {
  let longest: number | null = null;
  for (const note of chord.notes) {
    const ticks = notationIntentTicks(note.notationIntent);
    if (ticks !== null && (longest === null || ticks > longest)) longest = ticks;
  }
  return longest ?? undefined;
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

export function buildScore(input: BuildInput, settings: BuildSettings, options: BuildOptions = {}): BuildResult {
  const s = resolveSettings(settings);

  // ---- station 7 (input half): guards ------------------------------------------------------
  // Ids are assigned from the ORIGINAL index BEFORE anything is filtered. webcore/IR.md is
  // explicit that ids must be stable across pipeline re-runs: Team B's undo stack, selection and
  // edit popover are all keyed on them, and the pipeline re-runs on every settings change and
  // every drag of the "bar 1" marker. Numbering after the guard would renumber every later note
  // the moment one artefact is dropped.
  const identified: InputNote[] = (input.notes ?? []).map((n, i) => ({ ...n, id: n.id ?? `n${i}` }));
  const guard = applyGuards(identified, input.audioDurationSec, input.detachedTimeline);
  const notes: InputNote[] = guard.notes;

  // ---- station 1: time skeleton -------------------------------------------------------------
  // The SCORE's notes, not this part's: identical to `notes` on an ordinary single-part build,
  // the union of every part on a multi-part one. See BuildOptions.
  const scoreNotes = options.sharedNotes
    ? applyGuards(options.sharedNotes, input.audioDurationSec, input.detachedTimeline).notes
    : notes;
  const sourceCarrier = (options.sharedNotes ?? identified).find((note) => note.sourceBars?.length);
  const tempoCarrier = (options.sharedNotes ?? identified).find((note) => note.sourceTempoChanges?.length);
  // THE SOURCE'S BARS GO IN, THEY ARE NOT PAINTED ON AFTERWARDS (finding 2). `applySymbolicBars`
  // used to overwrite `bars`/`timeSig`/`totalTicks` on a FINISHED skeleton, by which time every
  // conversion closure had already captured `ticksPerBeat` from the detected meter — so a 6/8
  // import announced 6/8 and converted as 4/4, putting its second downbeat at 1.0 s instead of
  // 1.5 s. The meter now exists before the beat unit is chosen.
  const skel = buildTimeSkeleton({ ...input, notes: scoreNotes }, s, {
    ...(sourceCarrier?.sourceBars?.length ? { symbolicBars: sourceCarrier.sourceBars } : {}),
    ...(tempoCarrier?.sourceTempoChanges?.length ? { symbolicTempo: tempoCarrier.sourceTempoChanges } : {})
  });
  const sourceBarsApplied = skel.symbolic;
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
    // The FALLBACK conversion, used only when the symbolic placer declines (mixed resolutions).
    const scale = exact ? DIVISIONS / exact.ppq : 1;
    // A declared written value is the editor's instruction about a PERFORMED note. A symbolic
    // source already carries written ticks for every note in the score, so there is nothing for a
    // declaration to decide there and the exact path is left untouched (types.ts says so).
    const intentTicks = exactSymbolicTiming ? undefined : intentTicksOf(c);
    return {
      id: `e${i}`,
      rawStartTick: exact ? exact.startTick * scale : skel.secondsToTick(c.onsetSec),
      rawOffTick: exact
        ? Math.max(exact.startTick * scale + 1, exact.endTick * scale)
        : skel.secondsToTick(Math.max(c.endSec, c.onsetSec + 1e-4)),
      ...(intentTicks !== undefined ? { intentTicks } : {})
    };
  });
  /** Quant ids whose written length was declared rather than measured. */
  const declaredIds = new Set(quantInput.filter((q) => q.intentTicks !== undefined).map((q) => q.id));
  // A symbolic source already decided every written tick, so it takes the internal 'exact' path.
  // It must NOT borrow 'free': free now has real notation semantics (a 1/32 view of a
  // performance) and snapping an imported eighth-triplet onto that lattice would corrupt it.
  const freeSymbols = s.grid === 'free' && !exactSymbolicTiming;

  // ---- station 1b (symbolic): rational placement, with the source's own tuplets --------------
  // Converting the ticks was never the problem; SAYING WHAT THEY MEAN was. `quantizeExact`
  // returns no tuplet groups at all, so a legal eighth-note triplet (exactly 8 IR ticks, a
  // perfect conversion) reached the straight metric splitter, came out as 6 + 2 and had the
  // remainder typed `32nd` — a glyph that is 3 ticks long. placeSymbolicEvents reconstructs the
  // groups from the written positions themselves, so the triplet stays a triplet.
  const symbolicPlacement = exactSymbolicTiming
    ? placeSymbolicEvents(
        chords.map((_, i): SymbolicEvent => ({
          id: `e${i}`,
          startTick: sourceTiming[i]!.startTick,
          endTick: sourceTiming[i]!.endTick,
          ppq: sourceTiming[i]!.ppq
        })),
        skel.ticksPerBeat,
        skel.compound
      )
    : null;
  const quant = symbolicPlacement ?? quantizeOnsets(quantInput, {
    grid: exactSymbolicTiming ? 'exact' : s.grid,
    ticksPerBeat: skel.ticksPerBeat,
    compound: skel.compound,
    totalTicks: skel.totalTicks
  });

  const qNotes = [...quant.notes].sort((a, b) => a.startTick - b.startTick);
  if (qNotes.length) {
    // Iterative, never a spread (finding 12): a large import throws `RangeError` on
    // `Math.max(...millionNotes)` in JavaScriptCore before it computes anything at all.
    let requiredTick = -Infinity;
    for (let i = 0; i < qNotes.length; i++) {
      const note = qNotes[i];
      let candidate = exactSymbolicTiming ? note.offTick - 1 : note.startTick;
      // A DECLARED WRITTEN VALUE NEEDS SOMEWHERE TO BE WRITTEN, for the same reason an exact
      // symbolic duration does: the page is otherwise clipped at the last barline and the chosen
      // half note silently comes back a quarter. It is the DECLARATION that earns the bar, not the
      // ring-out — a measured off-time is still discounted, which is what keeps a three-tick spill
      // from conjuring a measure of rests. The next attack is applied first because
      // `clampEventOverlaps` will trim there anyway, and a bar nothing reaches into is a bar of
      // rests nobody asked for.
      if (!exactSymbolicTiming && declaredIds.has(note.id)) {
        const nextStart = i + 1 < qNotes.length ? qNotes[i + 1].startTick : Infinity;
        candidate = Math.max(candidate, Math.min(note.offTick, nextStart) - 1);
      }
      if (candidate > requiredTick) requiredTick = candidate;
    }
    extendSkeletonThrough(skel, requiredTick);
  }

  const metrics: BarMetric[] = skel.bars.map((b) => {
    const compound = b.timeSig[1] === 8 && b.timeSig[0] > 3 && b.timeSig[0] % 3 === 0;
    return buildBarMetric(b.timeSig[0], b.timeSig[1], compound);
  });
  const chordById = new Map(quantInput.map((q, i) => [q.id, chords[i]]));
  if (qNotes.length && !exactSymbolicTiming) {
    qNotes[0].startTick = snapLeadingOnset(qNotes[0].startTick, skel.bars[0].startTick, DIVISIONS);
  }

  // ---- station 2: overlap clamp ---------------------------------------------------------------
  // Durations reach the page as played. The only adjustment is cutting an off-time back to the
  // next attack when tick rounding pushed it past one — a voice cannot hold two notes at once.
  const simplifyEvents: SimplifyEvent[] = qNotes.map((n) => ({
    startTick: n.startTick,
    offTick: n.offTick,
    ...(n.tupletId ? { tupletId: n.tupletId } : {})
  }));
  const clamped = clampEventOverlaps(simplifyEvents);

  // A final ring-out may not extend past the last bar: there is nothing there to tie to, and a
  // dangling <tie type="start"/> is a broken file.
  //
  // ZIP FIRST, FILTER SECOND. `clamped[i]` is positional against `qNotes`; filtering before
  // the map silently pairs each surviving note with the wrong result.
  const placed: PlacedEvent[] = qNotes
    .map((n, i) => ({
      chord: chordById.get(n.id)!,
      startTick: n.startTick,
      offTick: Math.min(clamped[i].offTick, skel.totalTicks),
      ...(n.tupletId ? { tupletId: n.tupletId } : {})
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
    anchorFret: s.anchorFret,
    ...(s.maxFret !== undefined ? { maxFret: s.maxFret } : {}),
    legatoPairs
  });
  const assignmentById = new Map(assignments.map((a) => [a.id, a]));
  const surviving = survivingLegato(legatoPairs, assignments);
  const legatoById = new Map(surviving.map((p) => [p.fromId, p]));

  // ---- station 3a: key -----------------------------------------------------------------------
  const durationSec = spanSec(notes);
  // ONE KEY SIGNATURE PER SCORE, so it is read off the score's notes, not this part's. On a
  // single-part build the two lists are the same object and this is the call it always made.
  const key = s.keyFifths !== undefined
    ? authoritativeKey(s.keyFifths)
    : detectKey(
        scoreNotes.map((n) => ({ midi: n.midi, weight: Math.max(0, n.endSec - n.startSec) })),
        { bars: skel.bars.filter((b) => !b.implicit).length, durationSec: options.sharedNotes ? spanSec(scoreNotes) : durationSec }
      );

  // ---- bars: rests are constructed here, and only here ---------------------------------------
  const built = buildBars(placed, skel, metrics, quant.tuplets, key.fifths, freeSymbols);

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

  // ---- station 3c (b): which of the two staves prints each note -------------------------------
  // Decided HERE and nowhere else. The emitters used to hold a copy of the rule each, so a note
  // could be engraved on the treble staff and exported on the bass one; now both read
  // `IRNote.staffIndex`. Nothing is written when the score is not a grand staff.
  const grandStaff = clefs.grandStaff || simultaneousSourceClefs;
  const grandStaffClefs = clefs.pair ?? grandClefPair();
  if (grandStaff) {
    const allNotes = built.bars.flatMap((bar) => bar.voices.flatMap((v) => v.beats.flatMap((beat) => beat.notes)));
    const staffOf = grandStaffSplitter(allNotes);
    for (const note of allNotes) note.staffIndex = staffOf(note);
  }

  // ---- station 3b: spelling, then accidental display -----------------------------------------
  // AFTER THE STAFF SPLIT, DELIBERATELY (finding 9). §9's ordering rule is "key BEFORE spelling
  // BEFORE accidental display"; what it does not say, and what was wrong, is that accidental
  // display also depends on WHICH STAFF a note is printed on. The measure used to be spelled as
  // one undivided list, so an F# engraved on the bass staff marked F as "already sharp for this
  // measure" and the F# that followed it on the treble staff printed with no accidental at all —
  // an unreadable bar, because a reader tracks accidentals down one staff, not across the brace.
  // Staff assignment therefore happens above and the state below is keyed by {staff, voice}.
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
    const lanes = new Map<string, { display: DisplayNote[]; refs: IRNote[] }>();
    let slot = 0;
    for (const v of bar.voices) {
      for (const beat of v.beats) {
        for (const n of beat.notes) {
          const sp = spellingById.get(n.id)!;
          n.step = sp.step;
          n.alter = sp.alter;
          n.octave = sp.octave;
          // One accidental state per printed lane. On a single-staff, single-voice score there
          // is exactly one lane and this is the call the pipeline has always made.
          const laneKey = `${n.staffIndex ?? 0}:${v.id}`;
          const lane = lanes.get(laneKey) ?? { display: [], refs: [] };
          lane.display.push({ step: sp.step, alter: sp.alter, octave: sp.octave, tieStop: n.tieStop, slot });
          lane.refs.push(n);
          lanes.set(laneKey, lane);
        }
        slot++;
      }
    }
    for (const lane of lanes.values()) {
      const shown = accidentalDisplayForMeasure(lane.display, key.fifths);
      shown.forEach((acc, i) => {
        if (acc) lane.refs[i].accidentalDisplay = acc;
      });
    }
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

  // ---- what the single engraved voice cost, counted rather than assumed --------------------
  // The IR has always been able to hold several voices; the pipeline has never produced more
  // than one, and phase 1 does not change that. What it changes is the silence: a half note in
  // voice 1 under a voice-2 quarter came back as two sequential quarters with nothing anywhere
  // saying so. Now the source voices are counted and the loss is stated.
  const sourceVoices = new Set<number>();
  for (const note of notes) if (note.sourceVoiceIndex !== undefined) sourceVoices.add(note.sourceVoiceIndex);
  const flattenedVoices = sourceVoices.size > 1 ? sourceVoices.size : 0;
  const reducedSymbolicBeats = symbolicPlacement?.reducedBeats ?? 0;

  const diagnosticLines = [
    skel.meterReason,
    skel.external ? 'grid: host DAW (external)' : skel.synthesised ? 'grid: synthesised, no beats supplied' : 'grid: detected beats',
    `quantizer: basicQuant ${quant.basicQuantTicks} ticks, jitter ${quant.jitterTicks.toFixed(2)} ticks`,
    key.accepted ? `key: fifths ${key.fifths} (confidence ${key.confidence})` : (key.reason ?? 'key: open'),
    `rests: ${built.stats.restGlyphs} of ${built.stats.restGlyphs + built.stats.noteGlyphs} glyphs (${(built.stats.restDensity * 100).toFixed(1)}%), durations as played`,
    ...(exactSymbolicTiming
      ? [`timing: exact symbolic ticks preserved${sourceBarsApplied ? ' with source bars/meter' : ''}`]
      : []),
    ...(flattenedVoices ? [`flattened ${flattenedVoices} voices into one — overlaps clamped, cross-voice unisons dropped`] : []),
    ...(reducedSymbolicBeats ? [`${reducedSymbolicBeats} beat(s) written finer than a 1/32 were widened onto it`] : []),
    ...(symbolicPlacement?.fusedAttacks
      ? [`${symbolicPlacement.fusedAttacks} attack(s) shared a slot after that widening and were absorbed into their neighbour`]
      : []),
    ...(skel.mixedMeter ? ['meter changes mid-piece: bars keep their own signatures, the tracked pulse stays bar 1\'s (not fully supported)'] : []),
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
      // The SOURCE wins: a symbolic import states the octave it was engraved in, and the setting
      // is only the caller's request for a part that never said.
      const offsets = [...new Set(notes.map((note) => note.displayPitchOffset).filter((value): value is number => value !== undefined))];
      if (offsets.length === 1) return { displayPitchOffset: offsets[0] };
      return s.displayPitchOffset !== undefined ? { displayPitchOffset: s.displayPitchOffset } : {};
    })(),
    // TAB VISIBILITY IS NOT INSTRUMENT IDENTITY (X1). See RiffsheetIR.tab.
    ...(s.tab === 'omit' ? { tab: 'omit' as const } : {}),
    instrument: {
      kind: s.instrument,
      tuningMidi: s.tuningMidi,
      stringCount: s.tuningMidi.length,
      capo: s.capo
    },
    grandStaff,
    ...(grandStaff ? { grandStaffClefs } : {}),
    bars: built.bars,
    suspects: {
      repeatLoops: guard.repeatLoops,
      pastEndDropped: guard.pastEndDropped,
      tooShortDropped: guard.tooShortDropped
    },
    stats: built.stats
  };

  // ---- the IR is checked HERE, not in one exporter ------------------------------------------
  // `assertTypeMatchesDuration` lives in musicxml.ts, which is why finding 1's broken triplet
  // was reported as "MusicXML export throws": the same unengravable IR went to the screen and to
  // the MIDI writer without complaint, so the app displayed a bar it could not save and the user
  // found out at export time. The invariants belong at the boundary that produces the IR.
  const problems = validateIR(ir);
  if (problems.length) {
    throw new Error(`buildScore produced an unengravable score:\n  ${problems.slice(0, 8).join('\n  ')}`);
  }

  const diagnostics: BuildDiagnostics = {
    meterReason: skel.meterReason,
    jitterTicks: quant.jitterTicks,
    compound: compoundEvidence(notes.map((n) => n.startSec), skel),
    basicQuantTicks: quant.basicQuantTicks,
    flattenedVoices,
    reducedSymbolicBeats,
    mixedMeter: skel.mixedMeter
  };

  return {
    ir,
    diagnostics,
    skeleton: skel,
    notes,
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

function newNote(src: InputNote, tieStart: boolean, tieStop: boolean): IRNote {
  return {
    id: src.id!,
    midi: src.midi,
    step: 'C',
    alter: 0,
    octave: 4,
    tieStart,
    tieStop,
    ...(src.velocity !== undefined ? { velocity: src.velocity } : {}),
    ...(src.confidence !== undefined ? { confidence: src.confidence } : {}),
    // webcore/IR.md: "please carry the original detected times through" — the as-played MIDI
    // export is made of these, and without them it silently falls back to the quantized one.
    startSec: src.startSec,
    endSec: src.endSec,
    ...(src.sourceStaffIndex !== undefined ? { sourceStaffIndex: src.sourceStaffIndex } : {}),
    // The declaration travels with every piece of a split span: the editing surface asks "what is
    // this note's duration set to", and the answer is what was declared, not what the bar made
    // of it. See IRNote.notationIntent.
    ...(src.notationIntent ? { notationIntent: src.notationIntent } : {}),
    // Carried even though v1 engraves one voice: the flattening is now visible in the IR rather
    // than being a fact only the importer ever knew (finding 1).
    ...(src.sourceVoiceIndex !== undefined ? { sourceVoiceIndex: src.sourceVoiceIndex } : {})
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

/** Every tick length the printable vocabulary can name, for the check below. */
const GLYPH_TICKS = new Set(VOCABULARY.map((g) => g.len.toTicksExact(DIVISIONS)));

/**
 * A TICK LENGTH RE-SPELT AS PRINTABLE GLYPHS, tied together — or verbatim when it cannot be.
 *
 * Clipping a piece to the room left, and handing the shortfall to the last one, are both
 * arithmetic on the bar cursor that takes no interest in whether the RESULT is a glyph anybody
 * can draw. When it is not, `typeOf` falls back to the nearest value it can name and the beat
 * ships a `<type>` that contradicts its own `<duration>` — the shape of the whole bug this
 * function now closes off. So the length is decomposed over the vocabulary instead, longest
 * first, and `emitNote`/`emitRestSegment` tie or sequence the pieces exactly as they already do
 * for a metric split.
 *
 * A length that is not a whole number of 1/32s cannot be spelled at all (16 ticks — a sixth of a
 * whole note — is the case that got here, from a host reporting 3/6). It is emitted verbatim
 * rather than rounded: the bar still adds up, and `validateIR` says out loud that the score is
 * unengravable, which is the honest report. Nothing upstream produces one any more.
 */
function printableTickPieces(ticks: number): number[] {
  if (GLYPH_TICKS.has(ticks)) return [ticks];
  const spelled = simplestDurationList(Rational.fromTicks(ticks, DIVISIONS)).map((len) =>
    len.toTicksRounded(DIVISIONS)
  );
  let sum = 0;
  for (const t of spelled) sum += t;
  return sum === ticks && spelled.every((t) => GLYPH_TICKS.has(t)) ? spelled : [ticks];
}

/**
 * Turn a glyph-length list into the tick lengths actually emitted for a span of `total` ticks.
 *
 * Three jobs, all about the bar cursor being sacred: nothing may overrun the span, nothing may
 * be silently lost from it, and nothing may leave here that the engraver cannot name. A piece
 * that would overrun is clipped; a piece with no room left is dropped; and if the vocabulary
 * could not spend the whole span, the shortfall is handed to the last glyph rather than leaving
 * the cursor short (`assertMeasureLength` would throw, and a measure that does not add up
 * renders as nonsense even when it does not). Both the clip and the hand-off can land on a
 * length no symbol has, so both go through `printableTickPieces` on the way out.
 */
function resolveTickPieces(pieces: Rational[], total: number): number[] {
  const out: number[] = [];
  let remaining = total;
  for (const len of pieces) {
    if (remaining <= 0) break;
    const ticks = Math.min(len.toTicksRounded(DIVISIONS), remaining);
    if (ticks <= 0) continue;
    out.push(...printableTickPieces(ticks));
    remaining -= ticks;
  }
  if (remaining > 0) {
    out.push(...printableTickPieces((out.pop() ?? 0) + remaining));
  }
  return out;
}

function buildBars(
  placed: PlacedEvent[],
  skel: TimeSkeleton,
  metrics: BarMetric[],
  tuplets: { id: string; startTick: number; endTick: number; unitTicks: number; actual: number; normal: number }[],
  keyFifths: number,
  /** `grid: 'free'`: print the fewest glyphs that add up, not the metric split (#36). */
  freeSymbols: boolean
): BuiltBars {
  // Groups sorted by position. Everything the bar emits — notes and rests alike — is cut at
  // their edges, so a group is looked up by TICK and never by the id an event was tagged with:
  // a span can cross into a group its own event never joined.

  const groupsInOrder = [...tuplets].sort((a, b) => a.startTick - b.startTick);
  /**
   * THE BEAT A GROUP WAS DECIDED AGAINST, which is not `metric.beatLen`.
   *
   * A group spans exactly one tracked beat, so `unitTicks x actual` IS that beat and the number
   * is carried on the group itself. The bar metric's beat is a different quantity: an irregular
   * bar re-derives its own signature from its length (`timeSkeleton.ts`), and a six-eighth one
   * reads as COMPOUND — a dotted-quarter beat — while the tracked pulse behind the group is
   * still a plain eighth. Reading the written value off the bar then printed a dotted quarter,
   * 24 ticks, over an 8-tick triplet piece. The group's own arithmetic cannot disagree with
   * itself, so it is the one used.
   */
  const groupBeatLen = (g: { unitTicks: number; actual: number }): Rational =>
    Rational.fromTicks(g.unitTicks * g.actual, DIVISIONS);
  const groupAt = (tick: number): (typeof tuplets)[number] | undefined =>
    groupsInOrder.find((g) => tick >= g.startTick && tick < g.endTick);
  const nextGroupStartAfter = (tick: number): number => {
    for (const g of groupsInOrder) if (g.startTick > tick) return g.startTick;
    return Infinity;
  };
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

      // WHICH DOMAIN A SPAN IS WRITTEN IN IS DECIDED BY WHERE IT SITS, not by whose group the
      // event was admitted to. `ev.tupletId` answers "did this attack join a tuplet"; the
      // question here is "what does each part of this span cross", and a note is perfectly
      // entitled to start on a straight beat and ring on into a triplet one. When it did, the
      // whole span went to the straight splitter, which cannot spell the third of a beat hanging
      // off the end of it and fell through to its un-notatable remainder. The span is therefore
      // cut at every group edge; the piece inside a group is one tuplet glyph, the pieces outside
      // are the metric split, and the tie machinery below already joins them.
      const pieces: { ticks: number; group?: (typeof tuplets)[number] }[] = [];
      let segFrom = from;
      while (segFrom < to) {
        const group = groupAt(segFrom);
        const segTo = group ? Math.min(to, group.endTick) : Math.min(to, nextGroupStartAfter(segFrom));
        if (group) {
          // One glyph per PRINTABLE unit count, not one glyph per span: five units of a
          // sextuplet have no written value (see `tupletUnitPieces`). The tie machinery below
          // joins them exactly as it joins the pieces of a metric split.
          const span = segTo - segFrom;
          const units = Math.max(1, Math.round(span / group.unitTicks));
          const parts = tupletUnitPieces(groupBeatLen(group), units, group.normal);
          let left = span;
          parts.forEach((u, index) => {
            // The last part carries whatever is left, so the pieces always add up to the span
            // even if it was not a whole number of units.
            const ticks = index === parts.length - 1 ? left : Math.min(left, u * group.unitTicks);
            left -= ticks;
            if (ticks > 0) pieces.push({ ticks, group });
          });
        } else {
          const span = Rational.fromTicks(segTo - segFrom, DIVISIONS);
          const split = freeSymbols
            ? simplestDurationList(span)
            : toDurationList(metric, Rational.fromTicks(segFrom - barStart, DIVISIONS), span, 'note');
          // RESOLVE THE PIECES TO TICKS FIRST, then decide which one is first and which is last.
          // Doing it inside the emit loop meant a piece that clipped to zero was skipped AFTER
          // its predecessor had already been given `tieStart: true` for not being last — a
          // dangling tie start, a broken MusicXML file and a hanging slur on screen (#31 d).
          for (const ticks of resolveTickPieces(split, segTo - segFrom)) pieces.push({ ticks });
        }
        segFrom = segTo;
      }

      let t = from;
      pieces.forEach(({ ticks, group }, pi) => {
        const tieStop = pi === 0 ? tieInFirst : true;
        const tieStart = pi === pieces.length - 1 ? tieOutLast : true;
        // Written value inside a tuplet is the SOUNDING value scaled by actual/normal; the
        // MusicXML <type> is the written one while <duration> stays the sounding one.
        //
        // Outside a tuplet the glyph is read off the ticks ACTUALLY emitted rather than the
        // nominal piece length, so `<type>` and `<duration>` can never disagree.
        const shown = group
          ? typeOf(tupletWrittenLen(groupBeatLen(group), Math.max(1, Math.round(ticks / group.unitTicks)), group.normal))
          : typeOf(Rational.fromTicks(ticks, DIVISIONS));
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
          notes: ev.chord.notes.map((src) => newNote(src, tieStart, tieStop))
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
      // A REST INSIDE A TUPLET IS A TUPLET REST. meter.ts states the rule for notes — "a tuplet
      // group is laid out in its own unit domain and never handed to `toDurationList`" — and the
      // silence between two triplet members is in that domain just as much as the members are.
      // Handing it to the straight splitter instead asked for a third of a beat in straight
      // values, which no vocabulary contains: `greedyDecompose` fell through to its documented
      // "un-notatable remainder" and emitted 1/16 + 1/48, which reached the page as a 32nd rest
      // claiming 2 ticks where a 32nd is 3. MusicXML's <type>-vs-<duration> assertion threw on
      // it, and with it the whole build — the shuffle figure (play, rest, play) is the shortest
      // route to that crash, which is why "Quantize: Triplet" could produce no score at all.
      //
      // The span is therefore cut at every group edge it crosses; each piece is written in the
      // domain it belongs to, and only the pieces outside any group see the metric splitter.
      let segStart = from;
      while (segStart < to) {
        const group = groupAt(segStart);
        const segEnd = group ? Math.min(to, group.endTick) : Math.min(to, nextGroupStartAfter(segStart));
        emitRestSegment(segStart, segEnd, group);
        segStart = segEnd;
      }
    };

    const emitRestSegment = (
      from: number,
      to: number,
      group: (typeof tuplets)[number] | undefined
    ): void => {
      if (to <= from) return;
      if (group) {
        // The in-group silence, its WRITTEN value being the sounding units scaled by
        // normal/actual — the same arithmetic the notes in the group get. Onsets and off-times
        // are both snapped to the group's lattice upstream, so the unit count is whole. It is
        // ONE glyph whenever that count has a written value and a run of them when it does not
        // (`tupletUnitPieces`), because a rest with no printable value is the same defect as a
        // note with none.
        const beatLen = groupBeatLen(group);
        const units = Math.max(1, Math.round((to - from) / group.unitTicks));
        let cursorTick = from;
        let left = to - from;
        const parts = tupletUnitPieces(beatLen, units, group.normal);
        parts.forEach((u, index) => {
          const ticks = index === parts.length - 1 ? left : Math.min(left, u * group.unitTicks);
          left -= ticks;
          if (ticks <= 0) return;
          const written = tupletWrittenLen(beatLen, Math.max(1, Math.round(ticks / group.unitTicks)), group.normal);
          const shown = typeOf(written);
          stats.restGlyphs++;
          // Measured on the WRITTEN value: a one-unit rest inside an eighth-triplet is an eighth
          // rest on the page, and §3.1's "no rest shorter than an eighth" is about the page.
          if (written.lt(EIGHTH)) stats.restsShorterThanEighth++;
          beats.push({
            startTick: cursorTick - barStart,
            durTicks: ticks,
            isRest: true,
            durationType: shown.durationType,
            dots: shown.dots,
            tuplet: { id: group.id, actual: group.actual, normal: group.normal, start: false, stop: false },
            notes: []
          });
          cursorTick += ticks;
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
      for (const ticks of resolveTickPieces(pieces, to - from)) {
        const len = Rational.fromTicks(ticks, DIVISIONS);
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

    // tuplet start/stop markers, per group, per bar (beaming.ts owns the rule; a grand staff
    // re-runs it per staff after the split, which is the only way the edges can balance there).
    markTupletEdges(beats);
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

