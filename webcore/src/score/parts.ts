/**
 * PARTS — several instruments printed as ONE sheet.
 *
 * The plugin's own take (the LIVE part) is the one it records, plays, edits and draws in the
 * roll. A player who wants the guitar printed over the bass drops a MusicXML file in beside it;
 * that becomes an IMPORTED part, which is engraved and never played.
 *
 * WHERE THE WORK HAPPENS: nowhere near here. `buildMultiPartScore` (pipeline/multipart.ts) is N
 * ordinary builds sharing one clock and one key, merged at the OUTPUT layer, and its contract
 * guarantees that a ONE-part call is byte-identical to `buildScore`. This file is the app's
 * translator for it — exactly what `src/pipeline/index.ts` is for the single-part entry point:
 *
 *   app parts model   ->  ScorePart[]
 *   BuildRequest      ->  SharedBuildInput
 *   MultiPartBuild    ->  RiffScore (+ `parts`, so the UI can map a track back to a chip)
 *
 * THE SINGLE-PART PATH NEVER COMES THROUGH HERE. `App.buildScoreFrom` calls `buildRiffScore` as
 * it always has whenever there are no imported parts, so a take with one part is not merely
 * byte-identical by the pipeline's guarantee — it does not execute one line of this file.
 *
 * `@pipeline-impl` is imported here as well as in `src/pipeline/index.ts`. That header says the
 * impl is imported "ONLY" by that file; the rule's purpose is that translation live in one place
 * per entry point, and this IS that place for the multi-part entry point. Fold the two together
 * (moving `buildPartedRiffScore` next to `buildRiffScore`) the moment both files are free to be
 * edited in one change.
 */

import {
  buildMultiPartScore,
  MAX_PARTS,
  type BuildInput,
  type BuildSettings,
  type ExternalGrid,
  type ScorePart
} from '@pipeline-impl';

import { toBuildSettings, toPartFretboard, type BuildRequest, type InputNote, type RiffScore } from '@pipeline';
import type { AppSettings } from '../app/state';

/** The cap is the pipeline's, not a second opinion about it. */
export const MAX_SCORE_PARTS = MAX_PARTS;

/**
 * The live take's slot in `SourceAudio.partOrder`.
 *
 * A sentinel rather than an entry in `importedParts`, because the live part is not a stored
 * object: it IS the take, and it exists whether or not anybody has ever opened this menu.
 */
export const LIVE_PART_ID = 'live';

/**
 * One imported part, as the document stores it.
 *
 * SYMBOLIC NOTES ONLY. `notes` is what the MusicXML importer produced — the same `InputNote[]`
 * shape a whole-document import produces, carrying `sourceTiming` so the pipeline keeps the
 * written ticks instead of quantizing somebody's engraving a second time.
 */
export interface ImportedPart {
  /** Stable within a document; namespaces this part's note ids nowhere — the pipeline does that. */
  id: string;
  name: string;
  notes: InputNote[];
  /** The chip menu's ±ms box. Reaches the pipeline as `nudgeSec`, in seconds and otherwise as
   *  typed — the pipeline is what makes it a printable shift. */
  nudgeMs: number;
  /**
   * THIS PART'S OWN FRETBOARD. Absent means "a plain notation staff", which is what every part
   * imported before this feature existed was. See `PartTabProfile`.
   */
  tab?: PartTabProfile;
}

/**
 * ==============================================================================================
 * ONE IMPORTED PART'S INSTRUMENT — the whole profile, not a visibility flag
 * ==============================================================================================
 *
 * WHY A PROFILE AND NOT A BOOLEAN (roll-purity critique §D).
 *
 * The obvious model was `ScorePart.tab: 'two-staves' | 'omit'` and nothing else, and it renders no
 * tablature at all: both alphaTab and MusicXML need a FRETTED INSTRUMENT WITH A TUNING before a
 * TAB staff can exist. `tab` only decides whether an existing tablature staff is printed; it
 * cannot turn an instrument with zero strings into a bass. So the part has to carry the whole
 * thing — what instrument it is, how it is tuned, where the capo is, how far up the neck the
 * planner may go, and how it chooses positions.
 *
 * AND THE PROFILE SURVIVES `tabMode: 'off'`, which is the other half of the requirement. Switching
 * a part's tab off must leave its tuning where it was, so switching it back on restores the
 * fretboard the player set rather than a default. That is why 'off' is a value of `tabMode` inside
 * this record instead of the record being deleted.
 *
 * THE VOCABULARY IS THE LIVE TAKE'S, exactly. These are the same seven keys the notation toolbar
 * writes into `AppSettings` for the live part, with the same names and the same meanings, so one
 * set of controls drives either scope and `src/pipeline/index.ts §toPartFretboard` reads both
 * through one function. A part is the active one or it is not; the controls do not change.
 */
export interface PartTabProfile {
  /** 'off' | 'bass' | 'guitar' | 'custom'. 'off' keeps everything below it. */
  tabMode: AppSettings['tabMode'];
  tuningId: string;
  customTuningMidi: number[];
  capo: number;
  maxFret: number;
  fingering: AppSettings['fingering'];
  anchorFret: number;
}

/**
 * A profile for a part that has none — a plain notation staff, and the state every part imported
 * before this feature existed is in.
 *
 * `tuningId` and `customTuningMidi` are seeded so that turning the tab ON has somewhere to start;
 * they are inert while `tabMode` is 'off' (`toPartFretboard` returns `tab: 'omit'`).
 */
export function defaultPartTabProfile(settings: AppSettings): PartTabProfile {
  return {
    tabMode: 'off',
    tuningId: settings.tuningId,
    customTuningMidi: [...settings.customTuningMidi],
    capo: 0,
    maxFret: settings.maxFret,
    fingering: settings.fingering,
    anchorFret: settings.anchorFret
  };
}

/**
 * A PROFILE SEEDED FROM THE FILE, not from this take (§D, `import/scoreFile.ts:63`).
 *
 * The importer already reads the source staff's tuning, its capo and whether the file itself drew
 * a tablature staff — and `addPartFromMusicXml` threw all three away, so a Guitar Pro chart in drop
 * D arrived tuned like whatever the player's bass happens to be. The file's own word is the only
 * one that can be right about somebody else's engraving, so it wins wherever it exists.
 *
 * A tuning arrives as MIDI numbers rather than as a preset id, so it is stored as the CUSTOM
 * tuning and `tabMode: 'custom'` — which is exactly what "these specific open strings" means in
 * this vocabulary, and avoids pretending a drop-D guitar is the standard preset.
 */
export function importedPartTabProfile(
  settings: AppSettings,
  source: { tuningLowToHigh?: number[]; capo?: number; showTablature?: boolean } | null | undefined
): PartTabProfile {
  const base = defaultPartTabProfile(settings);
  const tuning = source?.tuningLowToHigh?.filter((m) => Number.isFinite(m)) ?? [];
  if (tuning.length < 2) return base;
  return {
    ...base,
    // The file said "print tablature" or it did not, and that is the honest default for a part
    // nobody has opened the menu for yet.
    tabMode: source?.showTablature ? 'custom' : 'off',
    customTuningMidi: [...tuning],
    capo: Math.max(0, Math.min(12, Math.round(source?.capo ?? 0)))
  };
}

/**
 * A slot in printed order, top to bottom.
 *
 * The live slot carries the player's NAME OVERRIDE when there is one (`SourceAudio.livePartName`),
 * so that everything downstream of `orderedPartSlots` — the menu, the build, the emitters — reads
 * one resolved list rather than each consumer having to remember to consult the document as well
 * as the settings. Absent means "no override", and `livePartName()` derives the name instead.
 */
export type PartSlot = { kind: 'live'; name?: string } | { kind: 'imported'; part: ImportedPart };

/** The longest a part name may be, typed or stored. Imported and live alike. */
export const MAX_PART_NAME_LENGTH = 40;

/** A typed or stored part name, as it is allowed to exist: trimmed, bounded, or nothing at all. */
export function cleanPartName(value: string | undefined | null): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_PART_NAME_LENGTH) : '';
}

/** What the chip row and the playback filter need to know about one engraved track. */
export interface ScorePartInfo {
  /** `LIVE_PART_ID` or the imported part's id. */
  key: string;
  /** Index into `score.data.tracks` — and, because `fromPipeline` builds them in order, into
   *  the live alphaTab model's `tracks` too. */
  trackIndex: number;
  name: string;
  role: 'live' | 'imported';
  /** What the pipeline prepended to this part's note ids (`''` for the top part). */
  idPrefix: string;
}

/** A `RiffScore` that came out of a multi-part build. */
export interface PartedScore extends RiffScore {
  parts: ScorePartInfo[];
}

/** The parts of a score, or `[]` for the ordinary single-part one. */
export function scoreParts(score: RiffScore | null | undefined): ScorePartInfo[] {
  const parts = (score as PartedScore | null | undefined)?.parts;
  return Array.isArray(parts) ? parts : [];
}

/**
 * True for a track the app must never route to playback.
 *
 * Read off `AlphaTabScoreData.tracks[].notationOnly`, which is the pipeline's own word for it,
 * rather than off our `parts` sidecar: the flag travels with the data the sheet was built from,
 * so the two cannot drift. A single-part score carries no such flag anywhere.
 */
export function isNotationOnlyTrack(score: RiffScore, trackIndex: number): boolean {
  return score.data.tracks[trackIndex]?.notationOnly === true;
}

/**
 * The printed order, resolved.
 *
 * `order` is what the player dragged the chips into; anything it does not mention is appended in
 * storage order and the live part is guaranteed exactly one slot, so a truncated or duplicated
 * list out of an old document still produces a whole score.
 */
export function orderedPartSlots(
  imported: ReadonlyArray<ImportedPart> | undefined,
  order: ReadonlyArray<string> | undefined,
  liveName?: string
): PartSlot[] {
  const parts = (imported ?? []).slice(0, MAX_SCORE_PARTS - 1);
  const byId = new Map(parts.map((p) => [p.id, p]));
  const slots: PartSlot[] = [];
  const seen = new Set<string>();
  // The override travels on the slot rather than being looked up again by every consumer. Cleaned
  // here as well as on the way in, because a hand-edited document reaches this function too.
  const live = cleanPartName(liveName);
  const liveSlot = (): PartSlot => (live ? { kind: 'live', name: live } : { kind: 'live' });
  for (const key of order ?? []) {
    if (seen.has(key)) continue;
    if (key === LIVE_PART_ID) {
      seen.add(key);
      slots.push(liveSlot());
      continue;
    }
    const part = byId.get(key);
    if (!part) continue;
    seen.add(key);
    slots.push({ kind: 'imported', part });
  }
  if (!seen.has(LIVE_PART_ID)) slots.unshift(liveSlot());
  for (const part of parts) {
    if (!seen.has(part.id)) slots.push({ kind: 'imported', part });
  }
  return slots;
}

/** The order as it should be stored — the ids of `orderedPartSlots`, in the same order. */
export function partOrderOf(slots: ReadonlyArray<PartSlot>): string[] {
  return slots.map((slot) => (slot.kind === 'live' ? LIVE_PART_ID : slot.part.id));
}

/**
 * What the live part is CALLED — on its menu entry and on the page, which must be the same word.
 *
 * Deliberately short and derived from the settings rather than from the built IR: the part menu
 * is drawn before (and independently of) any build, and `defaultPartName(ir)` would give the
 * page a name the menu could not know.
 *
 * `override` IS THE PLAYER'S OWN WORD AND IT WINS. It is `SourceAudio.livePartName`, typed into
 * the same two fields an imported part is renamed from — the menu's Rename and the name printed
 * on the sheet — and stored on the document. Empty, missing, or whitespace falls through to the
 * derived word below, which is what makes "clear the box" mean "go back to following the
 * instrument" rather than "print an unnamed staff".
 */
export function livePartName(settings: AppSettings, override?: string): string {
  const chosen = cleanPartName(override);
  if (chosen) return chosen;
  switch (settings.tabMode) {
    case 'bass':
      return 'Bass';
    case 'guitar':
      return 'Guitar';
    case 'custom':
      return settings.instrument === 'guitar' ? 'Guitar' : settings.instrument === 'bass' ? 'Bass' : 'Tab';
    default:
      return settings.instrument === 'guitar' ? 'Guitar' : settings.instrument === 'bass' ? 'Bass' : 'Take';
  }
}

/** A part name out of a MusicXML file: the track's own name, or the file name. */
export function importedPartName(trackName: string | undefined, fileName: string): string {
  const named = cleanPartName(trackName);
  if (named) return named;
  const base = fileName.replace(/\.[^.]+$/, '');
  return cleanPartName(base) || 'Part';
}

/**
 * A NUDGE IS A PRINTED SHIFT, SO IT CAN ONLY BE A SHIFT THE PAGE CAN PRINT — AND THE BUILD IS
 * WHERE THAT IS DECIDED.
 *
 * An imported part is engraved from its own written ticks. Sliding it by an arbitrary number of
 * milliseconds slides those ticks off the lattice notation has words for, and the tail of the
 * last note in a bar comes out as a one- or two-tick crumb — which the MusicXML emitter refuses,
 * correctly, with "`<type>32nd</type>` is 3 ticks but `<duration>` is 1". Measured: at 96 BPM
 * every nudge that is not a whole 1/32 (78.125 ms there) threw, and every one that is printed.
 *
 * `nudgeNote` (pipeline/multipart.ts) now rounds the shift to a whole 1/32 itself, in the WRITTEN
 * domain and against the display tempo the build computed, so whatever number arrives comes out
 * printable. Nothing on the build path in this file calls this any more.
 *
 * What is left for it is the chip menu, which rounds the typed number on the way IN so the box
 * shows the shift that will be applied rather than the one that was asked for. That is a display
 * courtesy and not a correctness requirement, and it is the only remaining caller.
 *
 * @param bpm the score's display tempo. A nudge in seconds is a nudge in ticks only through one.
 */
export function snapNudgeMs(ms: number, bpm: number): number {
  if (!Number.isFinite(ms) || ms === 0) return 0;
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const thirtysecondMs = (60_000 / tempo) / 8;
  return Math.round(ms / thirtysecondMs) * thirtysecondMs;
}

/**
 * One 1/32 in milliseconds — the nudge box's `step`, so its arrows move the part by a whole unit
 * of the printed vocabulary instead of by a round number of milliseconds that means nothing on a
 * page. A 1/32 is the finest value the IR prints, and the same floor `grid: 'free'` works to.
 */
export function nudgeStepMs(bpm: number): number {
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  return (60_000 / tempo) / 8;
}

/**
 * AN IMPORTED PART IS A GUEST ON THE TAKE'S CLOCK, not the owner of it.
 *
 * The importer hangs the source file's whole structure — its bar map and its tempo map — off the
 * first note of every track, because when a MusicXML file is opened as THE DOCUMENT that map is
 * the truth (`import/scoreFile.ts`). Handed to a multi-part build it means something else
 * entirely: the pipeline's contract is that an imported part's `sourceBars` /
 * `sourceTempoChanges` become the WHOLE score's, so dropping a reference chart in beside a take
 * at 96 re-lettered the page at the chart's default 120 — the printed metronome mark, and the
 * mark in the exported MusicXML, both disagreeing with the tempo box the player set.
 *
 * The take is the document. So the structure carrier is dropped and `sourceTiming` is KEPT: the
 * chart's own written ticks still print exactly, note for note, against the take's bars.
 *
 * Only the carrier notes are copied — one per track — so this is a shallow pass over the list
 * and not a duplicate of it.
 *
 * DROPPING THE CLOCK IS ALL THIS DOES. The nudge is not applied here; it travels to the pipeline
 * as `ScorePart.nudgeSec` (see `buildPartedRiffScore`).
 */
function referenceNotes(notes: ReadonlyArray<InputNote>): InputNote[] {
  return notes.map((note) => {
    if (!note.sourceBars && !note.sourceTempoChanges) return note;
    const { sourceBars: _bars, sourceTempoChanges: _tempo, ...rest } = note;
    return rest;
  });
}

/**
 * ONE SHEET OUT OF N PARTS.
 *
 * The returned `RiffScore` is deliberately mixed, and each half is the one thing that half's
 * consumers need:
 *
 *   `data` / `musicxml()` / `midi()`  the WHOLE document. The sheet, the PDF (which is a picture
 *                                     of the sheet) and the MusicXML/MIDI exports all show every
 *                                     part, which is the feature.
 *   `ir` and every derived scalar      the LIVE part. The roll, the playhead origin, the tuning
 *                                     letters, the edit identities and playback are about the
 *                                     take, and a bass player dropping a guitar chart in must not
 *                                     find their roll redrawn around somebody else's notes.
 *
 * The two halves agree about time because the pipeline derives ONE clock and ONE key from every
 * note in the score, so the live IR's ticks are the score's ticks.
 */
export function buildPartedRiffScore(
  request: BuildRequest,
  settings: AppSettings,
  slots: ReadonlyArray<PartSlot>
): PartedScore {
  // ---- the shared half of the build, exactly as `buildRiffScore` assembles it ---------------
  // Mirrors src/pipeline/index.ts §buildRiffScore. Any change there belongs here too; the
  // duplication is small, and the alternative (a second entry point in that file) is a change to
  // the single-part path, which is the one path that must not move.
  const externalGrid: ExternalGrid | undefined =
    settings.useHostGrid && request.hostGrid && request.hostGrid.hostBpm > 0
      ? {
          bpm: request.hostGrid.hostBpm,
          timeSig: [request.hostGrid.hostTimeSig.numerator, request.hostGrid.hostTimeSig.denominator],
          ...(request.hostGrid.barStartsSec?.length ? { barStartsSec: request.hostGrid.barStartsSec } : {})
        }
      : undefined;

  const buildSettings: BuildSettings = toBuildSettings(
    externalGrid ? { ...settings, tempoBpm: undefined, timeSignature: undefined } : settings,
    request.title
  );

  const sharedInput: Omit<BuildInput, 'notes'> = {
    ...(externalGrid ? { externalGrid } : { ...(request.beats ? { beats: request.beats } : {}) }),
    ...(request.downbeats && !externalGrid ? { downbeats: request.downbeats } : {}),
    ...(request.audioDurationSec !== undefined ? { audioDurationSec: request.audioDurationSec } : {}),
    ...(request.startOffsetSec !== undefined ? { startOffsetSec: request.startOffsetSec } : {}),
    ...(request.blankBars !== undefined ? { blankBars: request.blankBars } : {}),
    // Forwarded on THIS path too, and it has to be: a bar operation splices every part against
    // one shared clock, so a multi-part score is exactly as detached from its recording as a
    // single-part one is. Dropping it here would re-arm the audio-length guard for the one
    // document shape where the material past the end of the tape belongs to somebody else.
    ...(request.detachedTimeline ? { detachedTimeline: true } : {})
  };

  // The override on the live slot when there is one; the derived word otherwise. Resolved once
  // here so the name in the sheet, in the MusicXML and in the `parts` sidecar is literally the
  // same string.
  const parts: ScorePart[] = slots.map((slot) =>
    slot.kind === 'live'
      ? { notes: request.notes, role: 'live', name: livePartName(settings, slot.name) }
      : {
          notes: referenceNotes(slot.part.notes),
          role: 'imported',
          name: slot.part.name,
          // THE SHIFT IS THE PIPELINE'S TO MAKE, and it is handed over in seconds exactly as the
          // player typed it. The build moves the part's seconds before it derives the shared
          // clock and its written ticks after, rounding the shift to a whole 1/32 against the
          // `displayBpm` it just computed (`nudgeNote`, pipeline/multipart.ts).
          //
          // This side of the call cannot do that, because the tempo the shift has to be rounded
          // against does not exist yet. The version this replaces applied the shift here and
          // rounded it against `scoreBpm`, a GUESS at that tempo from the take's tempo box and
          // the median beat gap; every time the guess and the real display tempo disagreed the
          // whole-1/32 shift was a whole 1/32 of the wrong tempo, the part landed between two
          // positions notation can spell, and the MusicXML emitter refused the leftover crumb
          // with "`<type>32nd</type>` is 3 ticks but `<duration>` is 1".
          nudgeSec: (slot.part.nudgeMs || 0) / 1000,
          /*
           * THIS PART'S OWN FRETBOARD, and never this take's (per-part TAB, critique §D).
           *
           * `instrument: 'staff', tab: 'omit'` stood here unconditionally, which was the right
           * default and the wrong law: it made "an imported part is a plain staff" unreachable
           * rather than merely the starting point, so a guitar chart could not be given its own
           * tablature no matter what the player asked for.
           *
           * The default is UNCHANGED — a part with no stored profile still resolves to
           * `instrument: 'staff'` through `defaultPartTabProfile`, because inventing a fretboard
           * for somebody else's engraving out of THIS take's tuning is exactly what must not
           * happen. What changes is that the part can now say otherwise, in its own words.
           *
           * Every field goes into the part's BUILD rather than being laid over it afterwards:
           * `pipeline/IR.md §The per-part profile` is explicit that an emit-time flag is how
           * `ir.tab` and the printed page came to disagree, and everything that reads the IR —
           * note-name lanes, string legends, octave-fold warnings, this app's own guards —
           * believes the IR.
           */
          ...toPartFretboard(slot.part.tab ?? defaultPartTabProfile(settings))
        }
  );

  const result = buildMultiPartScore(parts, sharedInput, buildSettings);
  const liveIndex = result.liveIndex >= 0 ? result.liveIndex : 0;
  const live = result.parts[liveIndex];
  const ir = live.ir;
  const data = result.toAlphaTabModelData();

  /**
   * NOTE IDS BACK ONTO THE APP'S OWN NAMESPACE.
   *
   * The pipeline namespaces by POSITION: the top part keeps its ids, every part below it is
   * prefixed `p2-`, `p3-`, … That is right for the file it writes, and wrong for the app the
   * moment the player drags the guitar above the bass — because then the LIVE take's ids all
   * gain a prefix, and every id the app holds (the selection, the edit log, the performance the
   * synth is retimed from) stops matching the engraving. The take would silently lose its edits
   * and its human timing for the duration of a chip drag.
   *
   * So the prefix is made a property of the PART rather than of its row: the live take keeps its
   * ids bare wherever it prints, and an imported part is namespaced by its own document id. Two
   * surfaces carry ids and both are rewritten together — `data`, which the sheet is built from,
   * and the live `ir`, which `collectTabOctaveShifts` keys against those same ids.
   */
  const canonical = (index: number): string =>
    slots[index].kind === 'live' ? '' : `${(slots[index] as { part: ImportedPart }).part.id}~`;
  const rename = (id: string, from: string, to: string): string =>
    from && id.startsWith(from) ? to + id.slice(from.length) : to + id;

  result.parts.forEach((part, index) => {
    const to = canonical(index);
    if (part.idPrefix === to) return;
    for (const staff of data.tracks[index]?.staves ?? []) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) note.id = rename(note.id, part.idPrefix, to);
          }
        }
      }
    }
    if (index !== liveIndex) return;
    for (const bar of ir.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          for (const note of beat.notes) note.id = rename(note.id, part.idPrefix, to);
        }
      }
    }
  });

  // ---- the derived scalars, off the LIVE part -----------------------------------------------
  const beatTimesSec = ir.tempo.beatTimesSec;
  const lastBeat = beatTimesSec.length ? beatTimesSec[beatTimesSec.length - 1] : 0;
  const beatPeriod =
    beatTimesSec.length > 1
      ? (lastBeat - beatTimesSec[0]) / (beatTimesSec.length - 1)
      : 60 / (ir.tempo.displayBpm || 100);

  const diagnostics: string[] = [
    `meter: ${live.diagnostics.meterReason}`,
    `rest density ${(ir.stats.restDensity * 100).toFixed(0)}% · ${ir.stats.noteGlyphs} notes, ${ir.stats.restGlyphs} rests`,
    ir.tempo.synthesised ? 'tempo grid synthesised (no beats supplied)' : 'tempo from detected beats',
    `${result.parts.length} parts on one sheet`
  ];
  if (ir.suspects.tooShortDropped > 0) {
    diagnostics.push(`${ir.suspects.tooShortDropped} very short note(s) dropped as artefacts`);
  }
  if (ir.suspects.pastEndDropped > 0) {
    diagnostics.push(`${ir.suspects.pastEndDropped} note(s) past the end of the audio dropped`);
  }
  if (ir.suspects.repeatLoops.length > 0) {
    diagnostics.push(`${ir.suspects.repeatLoops.length} possible repeated section(s) flagged`);
  }

  return {
    data,
    ir,
    musicxml: () => result.toMusicXML(),
    midi: (quantized: boolean) => result.toMidi(quantized),
    /*
     * THE LIVE PART'S PROJECTION, and only it.
     *
     * `RiffScore.projection` answers "what became of the notes THIS document can edit", and in a
     * multi-part score that is the live take — imported parts are notation-only in v1 and their
     * ids live in the pipeline's collision-proof namespace rather than in the feed the editor
     * holds. Merging every part's map together would put ids in here that no `performanceFeed`
     * contains, and `score/projection.ts` promises totality over the FEED.
     */
    projection: live.projection,
    tempoBpm: ir.tempo.displayBpm,
    timeSignature: { numerator: ir.timeSig[0], denominator: ir.timeSig[1] },
    divisions: ir.divisions,
    durationSec: lastBeat + beatPeriod,
    beatTimesSec,
    tuningLowToHigh: ir.instrument.tuningMidi,
    stringCount: ir.instrument.stringCount,
    capo: ir.instrument.capo,
    diagnostics,
    parts: result.parts.map((part, index) => ({
      key: slots[index].kind === 'live' ? LIVE_PART_ID : (slots[index] as { part: ImportedPart }).part.id,
      trackIndex: index,
      name: part.name,
      role: part.role,
      // The prefix the app's ids actually carry, after the rename above — not the one the
      // pipeline assigned by row.
      idPrefix: canonical(index)
    }))
  };
}
