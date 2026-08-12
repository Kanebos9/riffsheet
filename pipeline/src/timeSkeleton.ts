/**
 * STATION 1 — TIME SKELETON.
 *
 * seconds -> beat domain -> ticks, with a PER-BEAT tempo track and a PER-BAR tick origin.
 *
 * midi-semantics-research.md §9 names this the single highest-leverage decision in the whole
 * pipeline: PM2S measured Finale at Fme 9.9 and MuseScore at 15.3 on metrical alignment, and
 * the published diagnosis is that both "quantize according to a constant tempo estimated over
 * the whole music piece". Nothing here ever multiplies seconds by a global BPM. Beat positions
 * come from np.interp-style piecewise-linear interpolation against the supplied beat times, and
 * tick positions are rebuilt from each bar's own downbeat so error cannot accumulate.
 *
 * THREE SOURCES OF A GRID, in priority order:
 *   1. `input.externalGrid`  — a host DAW's grid. Authoritative; beat detection is skipped.
 *   2. `input.beats`         — Beat This! (MIT) or a MIDI tempo map.
 *   3. neither               — a uniform grid from `bpmOverride`, else 120 BPM.
 *
 * WRITTEN (not ported). The old app's `timemap.ts` could not express any of this — it was a
 * single linear function of one `settings.bpm` constant (midi-to-notation-research.md §3.3).
 */

import { Rational, R } from './rational.js';
import { DIVISIONS } from './ir.js';
import { buildTickSecondsMap } from './tickSeconds.js';
import type { BuildInput, BuildSettings, ExternalGrid, InputNote } from './types.js';

/** A downbeat may anticipate its beat by this much and still count as that beat. */
export const DOWNBEAT_ANTICIPATION_SEC = 0.05;
/** §3.4: fewer complete bars than this and we do not trust a non-4/4 reading. */
const MIN_BARS_FOR_METER = 4;
/** §3.4: fraction of inter-downbeat intervals that must agree on the beat count. */
const METER_AGREEMENT = 0.8;
/** §3.4: inter-downbeat interval must sit within +-15% of count x median beat period. */
const METER_INTERVAL_TOLERANCE = 0.15;
/** Fallback tempo when there are neither beats nor a bpmOverride. */
const DEFAULT_BPM = 120;
const EPS = 1e-6;
/**
 * FLOOR ON AN EXTRAPOLATED BEAT (finding 12). `extendGrid` walks outwards using the first and
 * last supplied gaps; two near-coincident beat times make that gap ~0 and the loop then tries to
 * allocate however many beats fit in the span, which is an unbounded array from a two-element
 * input. 20 ms is 3000 BPM — no beat tracker means it and no music contains it.
 */
const MIN_EXTENSION_INTERVAL_SEC = 0.02;
/** ...and a hard budget on top, so a pathological span cannot allocate without limit either. */
const MAX_EXTENSION_BEATS = 8192;

export interface BarSkeleton {
  index: number;
  /** Integer beat index of this bar's downbeat, in the (extended) beat array. */
  startBeatIdx: number;
  /** Beats this bar actually spans. Normally the meter numerator. */
  beats: number;
  /** Absolute tick of the bar start. */
  startTick: number;
  ticks: number;
  timeSig: [number, number];
  timeSigChanged: boolean;
  number: number;
  implicit: boolean;
}

/** The bar map a symbolic source (MusicXML / MIDI / Guitar Pro) attaches to its notes. */
export type SymbolicBarSource = NonNullable<InputNote['sourceBars']>[number];
/** The tempo map the same source attaches. Ticks are in the source's own ppq. */
export type SymbolicTempoSource = NonNullable<InputNote['sourceTempoChanges']>[number];

export interface SkeletonOptions {
  /**
   * THE SOURCE'S OWN BARS, and they are consumed BEFORE the skeleton decides anything.
   *
   * They used to be applied afterwards, by overwriting `bars`, `timeSig` and `totalTicks` on a
   * finished skeleton (`applySymbolicBars`). Everything derived from the meter had already been
   * captured by then — above all `ticksPerBeat`, which every one of the conversion closures
   * closes over — so a 6/8 import announced 6/8 in its public bar objects while its
   * tick-to-seconds map went on behaving as 4/4: the second downbeat of a two-bar 6/8 source
   * came back at 1.0 s instead of 1.5 s. The meter has to exist before the beat unit is chosen,
   * which is what this option is for.
   */
  symbolicBars?: SymbolicBarSource[];
  /** The source's tempo map, used to lay the beat grid when there is nothing else to lay it on. */
  symbolicTempo?: SymbolicTempoSource[];
}

/** A validated symbolic bar map, converted into the IR's tick domain. */
export interface SymbolicClock {
  bars: Omit<BarSkeleton, 'startBeatIdx'>[];
  timeSig: [number, number];
  compound: boolean;
  /**
   * TRUE WHEN THE SOURCE CHANGES METER MID-PIECE, which this wave explicitly does not support.
   * The bars keep their own signatures (they always have) and the score still engraves, but the
   * TRACKED PULSE is bar 1's throughout, so seconds inside a differently-metered later bar are
   * only as good as that pulse. Callers surface this; nothing here silently pretends otherwise.
   */
  mixedMeter: boolean;
  totalTicks: number;
}

/**
 * Convert and validate a source bar map. Returns null when the map is unusable — a non-finite
 * or non-positive ppq, a zero-length bar, or bars that do not tile a contiguous span — in which
 * case the caller falls back to the ordinary detected/synthesised skeleton.
 */
export function normalizeSymbolicBars(source: readonly SymbolicBarSource[]): SymbolicClock | null {
  if (!source.length) return null;
  const bars: Omit<BarSkeleton, 'startBeatIdx'>[] = [];
  for (let index = 0; index < source.length; index++) {
    const bar = source[index];
    if (
      !Number.isFinite(bar.ppq) || bar.ppq <= 0 ||
      !Number.isFinite(bar.startTick) || !Number.isFinite(bar.durationTicks)
    ) {
      return null;
    }
    const scale = DIVISIONS / bar.ppq;
    const startTick = Math.round(bar.startTick * scale);
    const ticks = Math.round(bar.durationTicks * scale);
    if (startTick < 0 || ticks <= 0) return null;
    const previous = index > 0 ? source[index - 1] : undefined;
    // A written source states its own signature, but it is still a signature: a denominator that
    // names no note value is unprintable here for exactly the reasons `printableTimeSig` gives.
    const timeSig = printableTimeSig(bar.timeSig[0], bar.timeSig[1]);
    const previousSig = previous ? printableTimeSig(previous.timeSig[0], previous.timeSig[1]) : undefined;
    bars.push({
      index,
      beats: isCompound(timeSig[0], timeSig[1]) ? timeSig[0] / 3 : timeSig[0],
      startTick,
      ticks,
      timeSig,
      timeSigChanged:
        index === 0 ||
        previousSig![0] !== timeSig[0] ||
        previousSig![1] !== timeSig[1],
      number: bar.number,
      implicit: bar.implicit
    });
  }
  for (let index = 1; index < bars.length; index++) {
    if (bars[index].startTick !== bars[index - 1].startTick + bars[index - 1].ticks) return null;
  }
  const first = bars[0].timeSig;
  const mixedMeter = bars.some((bar) => bar.timeSig[0] !== first[0] || bar.timeSig[1] !== first[1]);
  return {
    bars,
    timeSig: [first[0], first[1]],
    compound: isCompound(first[0], first[1]),
    mixedMeter,
    totalTicks: bars[bars.length - 1].startTick + bars[bars.length - 1].ticks
  };
}

export interface TimeSkeleton {
  divisions: number;
  /** Ticks in one tracked beat: 24 for a simple beat, 36 for a compound (dotted) beat. */
  ticksPerBeat: number;
  /** Length of one tracked beat as a fraction of a whole note: 1/4 simple, 3/8 compound. */
  beatUnit: Rational;
  timeSig: [number, number];
  compound: boolean;
  displayBpm: number;
  bars: BarSkeleton[];
  /** The beat grid actually used, extended past both ends of the material. */
  beatTimesSec: number[];
  /** Index into `beatTimesSec` of bar 1 beat 1 — the origin the score is numbered from. */
  originBeatIdx: number;
  downbeatTimesSec: number[];
  /** true when the grid was synthesised rather than detected. */
  synthesised: boolean;
  /** true when `externalGrid` supplied the grid. */
  external: boolean;
  /** Human-readable diagnosis of the meter decision, for the UI. */
  meterReason: string;
  totalTicks: number;
  /** true when the bar map came from a symbolic source rather than being laid down here. */
  symbolic: boolean;
  /** true when that source changes meter mid-piece — out of scope, surfaced, never silent. */
  mixedMeter: boolean;

  secondsToBeatIdx(sec: number): number;
  beatIdxToSeconds(beatIdx: number): number;
  beatIdxToTick(beatIdx: number): number;
  tickToBeatIdx(tick: number): number;
  secondsToTick(sec: number): number;
  tickToSeconds(tick: number): number;
  barAt(tick: number): BarSkeleton;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Piecewise-linear lookup; xs ascending; extrapolates linearly beyond both ends (np.interp+). */
function interp(x: number, xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (n === 1) return ys[0];
  if (x <= xs[0]) {
    const slope = (ys[1] - ys[0]) / (xs[1] - xs[0]);
    return ys[0] + (x - xs[0]) * slope;
  }
  if (x >= xs[n - 1]) {
    const slope = (ys[n - 1] - ys[n - 2]) / (xs[n - 1] - xs[n - 2]);
    return ys[n - 1] + (x - xs[n - 1]) * slope;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** How many beats of `interval` reach from `span` seconds away, floored and budgeted. */
function extensionCount(span: number, interval: number): number {
  const step = Math.max(MIN_EXTENSION_INTERVAL_SEC, interval);
  if (!Number.isFinite(span) || span <= 0) return 1;
  return Math.max(1, Math.min(MAX_EXTENSION_BEATS, Math.ceil(span / step) + 1));
}

function extendGrid(beats: number[], fromSec: number, toSec: number): { grid: number[]; offset: number } {
  if (beats.length < 2) {
    const period = 60 / DEFAULT_BPM;
    const base = beats.length ? beats[0] : 0;
    const before = extensionCount(base - fromSec, period);
    const after = extensionCount(toSec - base, period);
    const grid: number[] = [];
    for (let i = -before; i <= after; i++) grid.push(base + i * period);
    return { grid, offset: before };
  }
  // MINIMUM INTERVAL AND EXTENSION BUDGET. The gap the extrapolation walks by is the FIRST (or
  // last) supplied gap, so a single pair of near-coincident beat times used to drive an
  // unbounded allocation loop; both are now floored at a musically possible interval and the
  // count itself is capped. Beyond the budget the grid simply stops — the interpolation in
  // `interp` extrapolates linearly past both ends anyway, so nothing downstream loses its map.
  const head = Math.max(MIN_EXTENSION_INTERVAL_SEC, beats[1] - beats[0]);
  const tail = Math.max(MIN_EXTENSION_INTERVAL_SEC, beats[beats.length - 1] - beats[beats.length - 2]);
  const before = extensionCount(beats[0] - fromSec, head);
  const after = extensionCount(toSec - beats[beats.length - 1], tail);
  const grid: number[] = [];
  for (let i = before; i >= 1; i--) grid.push(beats[0] - i * head);
  grid.push(...beats);
  for (let i = 1; i <= after; i++) grid.push(beats[beats.length - 1] + i * tail);
  return { grid, offset: before };
}

function nearestBeatIdx(sec: number, grid: number[]): number {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < grid.length; i++) {
    const d = Math.abs(grid[i] - sec);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return best;
}

/** Snap a downbeat time to a beat index; -1 when no beat supports it. */
function downbeatToBeatIdx(dbSec: number, grid: number[], ibi: number): number {
  const idx = nearestBeatIdx(dbSec, grid);
  const tolerance = Math.max(DOWNBEAT_ANTICIPATION_SEC, ibi * 0.25);
  return Math.abs(grid[idx] - dbSec) <= tolerance ? idx : -1;
}

function isCompound(num: number, den: number): boolean {
  return den >= 8 && num % 3 === 0 && num > 3;
}

/**
 * THE FINEST DENOMINATOR THE PAGE CAN SAY. meter.ts's `VOCABULARY` bottoms out at a 1/32, and
 * `Rational.toTicksExact` cannot even express a 1/64 at DIVISIONS=24 — it throws.
 */
const MAX_PRINTABLE_DENOMINATOR = 32;

function isPrintableDenominator(den: number): boolean {
  return Number.isInteger(den) && den >= 1 && den <= MAX_PRINTABLE_DENOMINATOR && (den & (den - 1)) === 0;
}

/**
 * A TIME SIGNATURE'S DENOMINATOR NAMES A NOTE VALUE, AND ONLY A POWER OF TWO NAMES ONE.
 *
 * REAPER (and every other DAW with a free-text meter box) will happily report 3/6, and the host
 * grid used to be believed verbatim. Nothing downstream can survive it: the tracked beat becomes
 * a SIXTH of a whole note, `ticksPerBeat` comes out 16, and 16 ticks is not the sum of ANY
 * combination of printable glyphs (the vocabulary is 3, 6, 9, 12, 18, 24, 36, 48, 72, 96 ticks).
 * `toDurationList` then recursed down its halving ladder to 1/96, `greedyDecompose` fell through
 * to its documented "un-notatable remainder", and `typeOf` rounded each 1-tick fragment to the
 * nearest thing it could name — a 32nd, which is 3 ticks. That is the whole of
 * "<type>32nd</type> is 3 ticks but the glyph lasts 1": sixteen of them per beat.
 *
 * It cannot be repaired further down. A span of 1/6 of a whole note is not engravable at any
 * resolution, so no merge, tie or absorb law can print it; the only honest fix is to refuse the
 * denominator at the door and say so in `meterReason`. The nearest power of two on a log scale
 * is used (6 -> 8), because it keeps the bar closest to the length the host meant, and the
 * result is clamped to a 1/32 because that is the finest value the page has a symbol for.
 */
export function printableTimeSig(num: number, den: number): [number, number] {
  const beats = Number.isFinite(num) && num >= 1 ? Math.round(num) : 4;
  if (isPrintableDenominator(den)) return [beats, den];
  if (!Number.isFinite(den) || den <= 0) return [beats, 4];
  const exponent = Math.min(5, Math.max(0, Math.round(Math.log2(den))));
  return [beats, 1 << exponent];
}

/**
 * §3.2 + §3.4: beats per bar is the MODE of the inter-downbeat beat counts, restricted to
 * {2,3,4}, and only accepted over the 4/4 prior when the evidence clears four gates.
 * 6/8 is never selected automatically (§3.3 — including 6 makes rock get misclassified).
 */
function inferMeter(
  spans: number[],
  ibi: number,
  downbeatTimes: number[]
): { num: number; den: number; reason: string } {
  if (spans.length < MIN_BARS_FOR_METER) {
    return { num: 4, den: 4, reason: `only ${spans.length} complete bars; 4/4 prior kept` };
  }
  const counts = new Map<number, number>();
  for (const s of spans) counts.set(s, (counts.get(s) ?? 0) + 1);
  let modeVal = 4;
  let modeCount = -1;
  for (const [v, c] of counts) {
    if (c > modeCount || (c === modeCount && v === 4)) {
      modeCount = c;
      modeVal = v;
    }
  }
  if (modeVal === 4) return { num: 4, den: 4, reason: 'mode of beats-per-bar is 4' };
  if (modeVal !== 3 && modeVal !== 2) {
    return { num: 4, den: 4, reason: `mode ${modeVal} is not in {2,3,4}; 4/4 prior kept` };
  }
  if (modeCount / spans.length < METER_AGREEMENT) {
    return { num: 4, den: 4, reason: `only ${Math.round((modeCount / spans.length) * 100)}% agreement` };
  }
  let ok = 0;
  for (let i = 0; i + 1 < downbeatTimes.length; i++) {
    const expected = modeVal * ibi;
    const actual = downbeatTimes[i + 1] - downbeatTimes[i];
    if (expected > 0 && Math.abs(actual - expected) / expected <= METER_INTERVAL_TOLERANCE) ok++;
  }
  if (downbeatTimes.length > 1 && ok / (downbeatTimes.length - 1) < METER_AGREEMENT) {
    return { num: 4, den: 4, reason: 'inter-downbeat seconds disagree with count x beat period' };
  }
  return { num: modeVal, den: 4, reason: `mode ${modeVal} accepted by all four gates` };
}

/**
 * Synthesise beats and downbeats from a host grid. The tempo map is piecewise constant, so a
 * tempo change lands exactly on the beat that follows it and the resulting `beatTimesSec` is
 * still a genuine per-beat tempo track — the rest of the pipeline cannot tell the difference
 * between this and a detected grid, which is the point.
 */
function gridFromExternal(
  ext: ExternalGrid,
  anchorSec: number,
  fromSec: number,
  toSec: number
): { beats: number[]; downbeats: number[]; beatsPerBar: number; beatUnit: Rational; compound: boolean } {
  const [num, den] = ext.timeSig;
  const compound = isCompound(num, den);
  const beatUnit = compound ? R(3, den) : R(1, den);
  const beatsPerBar = compound ? num / 3 : num;
  // bpm counts QUARTER notes; beatUnit is in whole notes, so quarters-per-beat = unit x 4.
  const quartersPerBeat = beatUnit.toNumber() * 4;
  const changes = [...(ext.tempoChanges ?? [])].sort((a, b) => a.atSec - b.atSec);
  const periodAt = (sec: number): number => {
    let bpm = ext.bpm;
    for (const c of changes) {
      if (c.atSec <= sec + EPS && c.bpm > 0) bpm = c.bpm;
      else break;
    }
    return (60 / (bpm > 0 ? bpm : DEFAULT_BPM)) * quartersPerBeat;
  };

  const forward: number[] = [anchorSec];
  let t = anchorSec;
  let guard = 0;
  while (t < toSec + periodAt(t) && guard++ < 100000) {
    t += periodAt(t);
    forward.push(t);
  }
  const backward: number[] = [];
  t = anchorSec;
  guard = 0;
  while (t > fromSec - periodAt(t) && guard++ < 100000) {
    t -= periodAt(t - periodAt(t));
    backward.unshift(t);
  }
  // Keep the anchor on a bar line when walking backwards: pad to a whole number of bars.
  while (backward.length % beatsPerBar !== 0) {
    const first = backward.length ? backward[0] : anchorSec;
    backward.unshift(first - periodAt(first));
  }

  const beats = [...backward, ...forward];
  const anchorIdx = backward.length;
  let downbeats: number[];
  if (ext.barStartsSec && ext.barStartsSec.length) {
    downbeats = [...ext.barStartsSec].sort((a, b) => a - b);
  } else {
    downbeats = [];
    for (let i = anchorIdx % beatsPerBar; i < beats.length; i += beatsPerBar) downbeats.push(beats[i]);
  }
  return { beats, downbeats, beatsPerBar, beatUnit, compound };
}

export function buildTimeSkeleton(
  input: BuildInput,
  settings: BuildSettings,
  options: SkeletonOptions = {}
): TimeSkeleton {
  const notes = input.notes;
  // ITERATIVE EXTREMA, never a spread (finding 12): `Math.min(...oneMillionNotes)` throws
  // `RangeError: Maximum call stack size exceeded` in JavaScriptCore, which is the engine the
  // plugin's WebView runs, so the published one-million-note import limit was unreachable by
  // construction. Two passes over the array cost nothing and cannot throw.
  let firstSec = Infinity;
  let lastSec = -Infinity;
  let lastOnsetSecScan = -Infinity;
  for (const n of notes) {
    if (n.startSec < firstSec) firstSec = n.startSec;
    if (n.startSec > lastOnsetSecScan) lastOnsetSecScan = n.startSec;
    if (n.endSec > lastSec) lastSec = n.endSec;
  }
  if (!notes.length) {
    firstSec = 0;
    lastSec = 0;
  }
  const symbolic = options.symbolicBars?.length ? normalizeSymbolicBars(options.symbolicBars) : null;
  // The symbolic beat unit has to exist BEFORE the fallback grid is synthesised: a 6/8 source
  // pulses in dotted quarters, and a grid laid down in quarters would place its second downbeat
  // a third of a bar early no matter what the bar objects went on to say.
  const symbolicBeatUnit = symbolic
    ? (symbolic.compound ? R(3, symbolic.timeSig[1]) : R(1, symbolic.timeSig[1]))
    : null;
  // THE HOST'S GRID IS BELIEVED, ITS DENOMINATOR IS CHECKED. A DAW's meter box takes free text;
  // the mock plugin's default (REAPER at 222 BPM in 3/6) is a real user's reproduction case, and
  // 3/6 is not a signature this or any other engraver can print. See `printableTimeSig`.
  const hostSig = input.externalGrid ? printableTimeSig(input.externalGrid.timeSig[0], input.externalGrid.timeSig[1]) : null;
  const hostSigRewritten =
    !!input.externalGrid && !!hostSig &&
    (hostSig[0] !== input.externalGrid.timeSig[0] || hostSig[1] !== input.externalGrid.timeSig[1]);
  const ext: ExternalGrid | undefined = !input.externalGrid
    ? undefined
    : hostSigRewritten
      ? { ...input.externalGrid, timeSig: hostSig! }
      : input.externalGrid;
  const explicitOrigin = input.startOffsetSec !== undefined || !!ext;
  const anchorSec = input.startOffsetSec ?? 0;

  let baseBeats: number[];
  let suppliedDownbeats: number[];
  let synthesised: boolean;
  let num: number;
  let den: number;
  let meterReason: string;
  let compound: boolean;
  let beatUnit: Rational;
  let beatsPerBar: number;
  /** True when the beat grid itself was laid down from the symbolic source's tempo map. */
  let symbolicGrid = false;

  if (ext) {
    // ---- source 1: the host grid, authoritative ------------------------------------------
    const g = gridFromExternal(
      ext,
      anchorSec,
      Math.min(firstSec, anchorSec) - 1,
      Math.max(lastSec, anchorSec) + 1
    );
    baseBeats = g.beats;
    suppliedDownbeats = g.downbeats;
    synthesised = true;
    num = ext.timeSig[0];
    den = ext.timeSig[1];
    compound = g.compound;
    beatUnit = g.beatUnit;
    beatsPerBar = g.beatsPerBar;
    meterReason =
      `external grid ${num}/${den} @ ${ext.bpm} BPM${ext.barStartsSec?.length ? ' with explicit bar starts' : ''}` +
      (hostSigRewritten
        ? ` (host reported ${input.externalGrid!.timeSig[0]}/${input.externalGrid!.timeSig[1]}, whose denominator names no note value)`
        : '');
  } else {
    // ---- source 2/3: detected beats, or a uniform fallback -------------------------------
    const supplied = (input.beats ?? []).filter((b) => Number.isFinite(b)).sort((a, b) => a - b);
    synthesised = supplied.length < 2;
    if (!synthesised) {
      baseBeats = supplied;
    } else if (symbolic && symbolicBeatUnit) {
      // A SYMBOLIC SOURCE BRINGS ITS OWN CLOCK. There is no take to detect beats in, and the
      // 120 BPM quarter-note fallback below is the wrong shape twice over for, say, a 6/8
      // source: wrong pulse length AND wrong pulse count per bar. Lay the grid on the source's
      // own tempo map instead, in the source's own beat unit, so tick-to-seconds is exact.
      const beatTicks = symbolicBeatUnit.toTicksExact(DIVISIONS);
      const fallbackBpm = settings.bpmOverride && settings.bpmOverride > 0 ? settings.bpmOverride : DEFAULT_BPM;
      const changes = (options.symbolicTempo ?? [])
        .filter((change) => Number.isFinite(change.ppq) && change.ppq > 0 && Number.isFinite(change.bpm) && change.bpm > 0)
        .map((change) => ({ tick: Math.round((change.tick * DIVISIONS) / change.ppq), bpm: change.bpm }));
      const map = buildTickSecondsMap({ divisions: DIVISIONS, tempo: { displayBpm: fallbackBpm, changes } });
      const spanBeats = Math.max(2, Math.ceil(symbolic.totalTicks / beatTicks) + 2);
      baseBeats = Array.from({ length: spanBeats }, (_, i) => anchorSec + map.tickToSec(i * beatTicks));
      symbolicGrid = true;
    } else {
      const bpm = settings.bpmOverride && settings.bpmOverride > 0 ? settings.bpmOverride : DEFAULT_BPM;
      const period = 60 / bpm;
      const start = supplied.length ? supplied[0] : Math.min(anchorSec, firstSec);
      const count = Math.max(2, Math.ceil((lastSec - start) / period) + 2);
      baseBeats = Array.from({ length: count }, (_, i) => start + i * period);
    }
    suppliedDownbeats = (input.downbeats ?? []).filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
    num = 4;
    den = 4;
    compound = false;
    beatUnit = R(1, 4);
    beatsPerBar = 4;
    meterReason = 'pending';
  }

  const ibis: number[] = [];
  for (let i = 1; i < baseBeats.length; i++) ibis.push(baseBeats[i] - baseBeats[i - 1]);
  const medianIbi = median(ibis) || 60 / DEFAULT_BPM;

  const { grid } = extendGrid(
    baseBeats,
    Math.min(firstSec, anchorSec, baseBeats[0]) - medianIbi,
    Math.max(lastSec, anchorSec, baseBeats[baseBeats.length - 1]) + medianIbi
  );
  const indices = grid.map((_, i) => i);

  const downbeatIdx: number[] = [];
  for (const db of suppliedDownbeats) {
    const idx = downbeatToBeatIdx(db, grid, medianIbi);
    if (idx >= 0 && (downbeatIdx.length === 0 || idx > downbeatIdx[downbeatIdx.length - 1])) {
      downbeatIdx.push(idx);
    }
  }

  if (!ext) {
    const override = settings.timeSigOverride;
    if (downbeatIdx.length >= 2) {
      const spans: number[] = [];
      for (let i = 1; i < downbeatIdx.length; i++) spans.push(downbeatIdx[i] - downbeatIdx[i - 1]);
      const inferred = inferMeter(spans, medianIbi, downbeatIdx.map((i) => grid[i]));
      num = inferred.num;
      den = inferred.den;
      meterReason = inferred.reason;
    } else {
      meterReason = 'fewer than two downbeats; 4/4 prior kept';
    }
    if (override) {
      // The same check as the host grid's, and it has to be here too: webcore's "Manual" tempo
      // source FREEZES whatever meter is on screen onto the take as an override, so a host's
      // unprintable signature arrives a second time by this door the moment the player switches
      // away from Follow DAW.
      const printable = printableTimeSig(override[0], override[1]);
      const rewritten = printable[0] !== override[0] || printable[1] !== override[1];
      num = printable[0];
      den = printable[1];
      compound = isCompound(num, den);
      meterReason = rewritten
        ? `manual override ${num}/${den} (asked for ${override[0]}/${override[1]}, whose denominator names no note value)`
        : `manual override ${num}/${den}`;
      if (compound) {
        const spans: number[] = [];
        for (let i = 1; i < downbeatIdx.length; i++) spans.push(downbeatIdx[i] - downbeatIdx[i - 1]);
        const typical = spans.length ? median(spans) : num / 3;
        if (Math.abs(typical - num / 3) < Math.abs(typical - num)) {
          beatsPerBar = num / 3;
          beatUnit = R(3, den);
        } else {
          beatsPerBar = num;
          beatUnit = R(1, den);
        }
      } else {
        beatsPerBar = num;
        beatUnit = R(1, den);
      }
    } else {
      beatsPerBar = num;
      beatUnit = R(1, den);
    }
  }

  // ---- the source's own meter, ahead of everything derived from it --------------------------
  if (symbolic && symbolicBeatUnit) {
    num = symbolic.timeSig[0];
    den = symbolic.timeSig[1];
    compound = symbolic.compound;
    meterReason = symbolic.mixedMeter
      ? `symbolic source bars, ${num}/${den} at bar 1 (meter changes mid-piece: every bar keeps its own signature, the tracked pulse stays bar 1's — mixed meter is not fully supported)`
      : `symbolic source bars ${num}/${den}`;
    // THE PULSE FOLLOWS THE GRID IT IS MEASURED AGAINST. When the grid came from the source
    // itself, the source's beat unit is the right one and this is what fixes the 6/8 seconds.
    // When real beats were detected (or a host supplied a grid), those beat times define the
    // pulse; adopting a dotted-quarter unit over a quarter-spaced grid would break the seconds
    // map in the other direction.
    if (symbolicGrid) {
      beatUnit = symbolicBeatUnit;
      beatsPerBar = compound ? num / 3 : num;
    }
  }

  const ticksPerBeat = beatUnit.toTicksExact(DIVISIONS);
  const barTicksNominal = R(num, den).toTicksExact(DIVISIONS);
  // A symbolic source states its opening tempo outright; that beats both the host grid's number
  // and a manual override, because it is the score's own statement about itself.
  const symbolicOpeningBpm = (options.symbolicTempo ?? [])
    .filter((change) => change.tick <= 0 && Number.isFinite(change.bpm) && change.bpm > 0)
    .map((change) => change.bpm)
    .pop();
  const displayBpm =
    symbolic && symbolicOpeningBpm
      ? Math.round(symbolicOpeningBpm)
      : ext && !ext.tempoChanges?.length
        ? Math.round(ext.bpm)
        : settings.bpmOverride && synthesised && !ext
          ? Math.round(settings.bpmOverride)
          : Math.round((60 / medianIbi) * (beatUnit.toNumber() * 4));

  // ---- origin (bar 1 / beat 1) -------------------------------------------------------------
  const firstBeatIdx = notes.length ? interp(firstSec, grid, indices) : 0;
  let originIdx: number;
  if (explicitOrigin) {
    // The caller declared where bar 1 starts. Snap it to the grid; never re-phase away from it.
    originIdx = nearestBeatIdx(anchorSec, grid);
    if (downbeatIdx.length) {
      // Prefer a real downbeat if one sits on that beat, so bar starts stay consistent.
      const exact = downbeatIdx.find((d) => d === originIdx);
      if (exact !== undefined) originIdx = exact;
    }
  } else if (downbeatIdx.length) {
    originIdx = downbeatIdx[0];
  } else {
    originIdx = Math.max(0, Math.round(firstBeatIdx));
  }
  // BAR 1 OF A SYMBOLIC SOURCE IS ITS OWN TICK ZERO, wherever its first note happens to sit. A
  // score whose first note is in bar 3 must still number bar 3 as bar 3, and the re-phase and
  // anacrusis rules below are about a beat tracker's uncertainty, which a written score has none
  // of. `anchorSec` is on the grid by construction here, so this is exact.
  if (symbolicGrid) originIdx = nearestBeatIdx(anchorSec, grid);

  // ---- pre-origin material (§3.5) ------------------------------------------------------------
  const preBarBeats: number[] = [];
  const lead = originIdx - firstBeatIdx;
  if (!symbolic && notes.length && lead > EPS) {
    if (explicitOrigin) {
      // Keep everything. Within a beat it is an anacrusis; further back it simply gets more
      // implicit measures and leading rests, which is fine.
      const leadBeats = Math.max(1, Math.ceil(lead - EPS));
      const nPre = Math.ceil(leadBeats / beatsPerBar);
      const firstLen = leadBeats - (nPre - 1) * beatsPerBar;
      preBarBeats.push(firstLen);
      for (let i = 1; i < nPre; i++) preBarBeats.push(beatsPerBar);
    } else if (lead >= beatsPerBar) {
      // §3.5: the tracker got the downbeat phase wrong. Re-phase rather than emit many pickups.
      const barsBack = Math.floor(lead / beatsPerBar);
      originIdx -= barsBack * beatsPerBar;
      const remaining = originIdx - firstBeatIdx;
      if (remaining >= 1) preBarBeats.push(Math.min(beatsPerBar - 1, Math.ceil(remaining - EPS)));
    } else if (lead >= 1) {
      preBarBeats.push(Math.min(beatsPerBar - 1, Math.ceil(lead - EPS)));
    }
    // lead < 1 beat and no explicit origin -> absorbed into bar 1, which is the default.
  }

  // ---- bars -----------------------------------------------------------------------------------
  // How far the score reaches. Note ENDS matter (a held note really does occupy later bars) but
  // a final ring-out must not conjure a bar: spilling three ticks over the last barline used to
  // add a whole extra measure of rests to every score. So the end is discounted by one beat of
  // ring-out tolerance, and the last onset is always covered.
  const lastOnsetSec = notes.length ? lastOnsetSecScan : anchorSec;
  const lastBeatIdx = notes.length
    ? Math.max(interp(lastOnsetSec, grid, indices), interp(lastSec, grid, indices) - 1)
    : originIdx;
  const bars: BarSkeleton[] = [];
  let tick = 0;
  let barNumber = 1;

  // ---- the source's bars, verbatim -----------------------------------------------------------
  // A symbolic source already contains the answer to every question below — where the bars are,
  // how long each one is, which is a pickup, what each one's signature is. The beat index of each
  // bar is chained from the origin in units of the TRACKED pulse (`ticks / ticksPerBeat`), which
  // is what keeps the seconds map consistent whether that pulse is a quarter or a dotted quarter.
  if (symbolic) {
    let beatCursor = originIdx;
    for (const bar of symbolic.bars) {
      bars.push({ ...bar, timeSig: [bar.timeSig[0], bar.timeSig[1]], startBeatIdx: beatCursor });
      beatCursor += bar.ticks / ticksPerBeat;
    }
    tick = symbolic.totalTicks;
    return finishSkeleton({
      ticksPerBeat,
      beatUnit,
      timeSig: [num, den],
      compound,
      displayBpm,
      bars,
      grid,
      indices,
      originIdx,
      // Every bar of a written source is a real bar line the roll must draw, pickup included.
      downbeatTimesSec: bars.map((bar) => interp(bar.startBeatIdx, indices, grid)),
      synthesised,
      external: !!ext,
      meterReason,
      totalTicks: tick,
      symbolic: true,
      mixedMeter: symbolic.mixedMeter
    });
  }

  const totalPreBeats = preBarBeats.reduce((a, b) => a + b, 0);
  let preStart = originIdx - totalPreBeats;
  for (const beatsIn of preBarBeats) {
    const ticks = beatsIn * ticksPerBeat;
    bars.push({
      index: bars.length,
      startBeatIdx: preStart,
      beats: beatsIn,
      startTick: tick,
      ticks,
      timeSig: [num, den],
      // An implicit measure is exempt from matching the time signature (§3.5), so no <time>
      // change is printed for it.
      timeSigChanged: bars.length === 0,
      number: 0,
      implicit: true
    });
    tick += ticks;
    preStart += beatsIn;
  }

  const anchors: number[] = [];
  for (const d of downbeatIdx) if (d >= originIdx) anchors.push(d);
  if (!anchors.length || anchors[0] !== originIdx) anchors.unshift(originIdx);
  // Extend with synthetic anchors only while material actually reaches INTO the next bar.
  // Testing `cursor < lastBeatIdx` instead adds a phantom empty bar at the end of every score,
  // whose whole rest then shows up in the rest-density measurement.
  let cursor = anchors[anchors.length - 1];
  let guard = 0;
  while (cursor + beatsPerBar < lastBeatIdx - EPS && guard++ < 100000) {
    cursor += beatsPerBar;
    anchors.push(cursor);
  }

  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i];
    if (i > 0 && start > lastBeatIdx + EPS) break;
    const next = i + 1 < anchors.length ? anchors[i + 1] : start + beatsPerBar;
    let spanBeats = next - start;
    if (spanBeats < 1 || spanBeats > beatsPerBar * 2) spanBeats = beatsPerBar;
    const ticks = spanBeats * ticksPerBeat;
    const irregular = ticks !== barTicksNominal;
    bars.push({
      index: bars.length,
      startBeatIdx: start,
      beats: spanBeats,
      startTick: tick,
      ticks,
      // An irregular interior bar gets its own printed meter so the measure arithmetic stays
      // valid (§4.5 G.4). Detection of real meter changes is a v2 feature.
      timeSig: irregular ? [Math.max(1, Math.round((ticks * den) / (DIVISIONS * 4))), den] : [num, den],
      timeSigChanged: irregular || bars.filter((b) => !b.implicit).length === 0,
      number: barNumber++,
      implicit: false
    });
    tick += ticks;
  }
  if (!bars.length) {
    bars.push({
      index: 0,
      startBeatIdx: originIdx,
      beats: beatsPerBar,
      startTick: 0,
      ticks: barTicksNominal,
      timeSig: [num, den],
      timeSigChanged: true,
      number: 1,
      implicit: false
    });
    tick = barTicksNominal;
  }

  if (!notes.length && input.blankBars !== undefined) {
    const requested = Math.max(1, Math.min(256, Math.round(input.blankBars)));
    while (bars.filter((bar) => !bar.implicit).length < requested) {
      const previous = bars[bars.length - 1];
      bars.push({
        index: bars.length,
        startBeatIdx: previous.startBeatIdx + previous.beats,
        beats: beatsPerBar,
        startTick: tick,
        ticks: barTicksNominal,
        timeSig: [num, den],
        timeSigChanged: false,
        number: previous.number + 1,
        implicit: false
      });
      tick += barTicksNominal;
    }
  }

  const totalTicks = tick;

  return finishSkeleton({
    ticksPerBeat,
    beatUnit,
    timeSig: [num, den],
    compound,
    displayBpm,
    bars,
    grid,
    indices,
    originIdx,
    downbeatTimesSec: bars.filter((b) => !b.implicit).map((b) => interp(b.startBeatIdx, indices, grid)),
    synthesised,
    external: !!ext,
    meterReason,
    totalTicks,
    symbolic: false,
    mixedMeter: false
  });
}

/**
 * THE CONVERSION CLOSURES, built once from a finished bar list.
 *
 * Extracted so the symbolic path and the detected path cannot drift: both now leave through the
 * same door, and every closure below is built AFTER `ticksPerBeat` and the bars are final. The
 * bug this structure exists to prevent is exactly the one finding 2 reported — a bar list
 * replaced after the closures had already captured a different meter's beat length.
 */
function finishSkeleton(parts: {
  ticksPerBeat: number;
  beatUnit: Rational;
  timeSig: [number, number];
  compound: boolean;
  displayBpm: number;
  bars: BarSkeleton[];
  grid: number[];
  indices: number[];
  originIdx: number;
  downbeatTimesSec: number[];
  synthesised: boolean;
  external: boolean;
  meterReason: string;
  totalTicks: number;
  symbolic: boolean;
  mixedMeter: boolean;
}): TimeSkeleton {
  const { bars, grid, indices, ticksPerBeat } = parts;

  const barAt = (t: number): BarSkeleton => {
    if (t < bars[0].startTick) return bars[0];
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].startTick <= t) lo = mid;
      else hi = mid - 1;
    }
    return bars[lo];
  };

  const barAtBeat = (b: number): BarSkeleton => {
    let chosen = bars[0];
    for (const bar of bars) {
      if (bar.startBeatIdx <= b + EPS) chosen = bar;
      else break;
    }
    return chosen;
  };

  return {
    divisions: DIVISIONS,
    ticksPerBeat,
    beatUnit: parts.beatUnit,
    timeSig: parts.timeSig,
    compound: parts.compound,
    displayBpm: parts.displayBpm,
    bars,
    beatTimesSec: grid,
    originBeatIdx: parts.originIdx,
    downbeatTimesSec: parts.downbeatTimesSec,
    synthesised: parts.synthesised,
    external: parts.external,
    meterReason: parts.meterReason,
    totalTicks: parts.totalTicks,
    symbolic: parts.symbolic,
    mixedMeter: parts.mixedMeter,

    secondsToBeatIdx: (sec) => interp(sec, grid, indices),
    beatIdxToSeconds: (b) => interp(b, indices, grid),

    // PER-BAR ORIGIN. The tick of a beat position is rebuilt from the containing bar's own
    // downbeat every time; nothing is accumulated forward across bars.
    beatIdxToTick: (b) => {
      const bar = barAtBeat(b);
      return bar.startTick + (b - bar.startBeatIdx) * ticksPerBeat;
    },
    tickToBeatIdx: (t) => {
      const bar = barAt(t);
      return bar.startBeatIdx + (t - bar.startTick) / ticksPerBeat;
    },
    secondsToTick: (sec) => {
      const b = interp(sec, grid, indices);
      const bar = barAtBeat(b);
      return bar.startTick + (b - bar.startBeatIdx) * ticksPerBeat;
    },
    tickToSeconds: (t) => {
      const bar = barAt(t);
      const b = bar.startBeatIdx + (t - bar.startTick) / ticksPerBeat;
      return interp(b, indices, grid);
    },
    barAt
  };
}

/**
 * 3/4-vs-6/8 EVIDENCE — a hint, never an action.
 *
 * The distinction is interpretive, not measurable from beat times alone (§3.3): 3/4 and 6/8 are
 * the same durations grouped differently. The discriminating evidence, if you want it, is
 * SUBDIVISION — 6/8 puts onset mass at 1/3 and 2/3 of the tracked beat, 3/4 puts it at 1/2.
 *
 * We compute it and expose it, and we do NOT act on it. madmom's users report that merely
 * including 6 in `beats_per_bar` makes 4/4 rock get misclassified, and the cost matrix is
 * asymmetric: mislabelling a rock riff as 6/8 wrecks every barline and beam group, while
 * notating a genuine 6/8 riff as 4/4-with-triplets is merely ugly. So this feeds a UI
 * suggestion for the manual override, nothing more.
 */
export interface CompoundEvidence {
  /** Onset mass near the half-beat position. */
  simpleMass: number;
  /** Onset mass near the third and two-third beat positions. */
  compoundMass: number;
  suggests: 'simple' | 'compound' | 'inconclusive';
}

export function compoundEvidence(noteStartsSec: number[], skeleton: TimeSkeleton): CompoundEvidence {
  let simpleMass = 0;
  let compoundMass = 0;
  const tol = 0.12; // fraction of a beat
  for (const sec of noteStartsSec) {
    const b = skeleton.secondsToBeatIdx(sec);
    const phase = b - Math.floor(b);
    if (Math.abs(phase - 0.5) <= tol) simpleMass++;
    if (Math.abs(phase - 1 / 3) <= tol || Math.abs(phase - 2 / 3) <= tol) compoundMass++;
  }
  const total = simpleMass + compoundMass;
  if (total < 6) return { simpleMass, compoundMass, suggests: 'inconclusive' };
  const ratio = compoundMass / total;
  if (ratio > 0.7) return { simpleMass, compoundMass, suggests: 'compound' };
  if (ratio < 0.3) return { simpleMass, compoundMass, suggests: 'simple' };
  return { simpleMass, compoundMass, suggests: 'inconclusive' };
}
