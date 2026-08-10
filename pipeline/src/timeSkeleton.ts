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
import type { BuildInput, BuildSettings, ExternalGrid } from './types.js';

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

export interface TimeSkeleton {
  divisions: number;
  /** Ticks in one tracked beat: 12 for a simple beat, 18 for a compound (dotted) beat. */
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

function extendGrid(beats: number[], fromSec: number, toSec: number): { grid: number[]; offset: number } {
  if (beats.length < 2) {
    const period = 60 / DEFAULT_BPM;
    const base = beats.length ? beats[0] : 0;
    const before = Math.max(1, Math.ceil((base - fromSec) / period) + 1);
    const after = Math.max(1, Math.ceil((toSec - base) / period) + 1);
    const grid: number[] = [];
    for (let i = -before; i <= after; i++) grid.push(base + i * period);
    return { grid, offset: before };
  }
  const head = beats[1] - beats[0];
  const tail = beats[beats.length - 1] - beats[beats.length - 2];
  const before = head > 0 ? Math.max(1, Math.ceil((beats[0] - fromSec) / head) + 1) : 1;
  const after = tail > 0 ? Math.max(1, Math.ceil((toSec - beats[beats.length - 1]) / tail) + 1) : 1;
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

export function buildTimeSkeleton(input: BuildInput, settings: BuildSettings): TimeSkeleton {
  const notes = input.notes;
  const firstSec = notes.length ? Math.min(...notes.map((n) => n.startSec)) : 0;
  const lastSec = notes.length ? Math.max(...notes.map((n) => n.endSec)) : 0;
  const ext = input.externalGrid;
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
    meterReason = `external grid ${num}/${den} @ ${ext.bpm} BPM${ext.barStartsSec?.length ? ' with explicit bar starts' : ''}`;
  } else {
    // ---- source 2/3: detected beats, or a uniform fallback -------------------------------
    const supplied = (input.beats ?? []).filter((b) => Number.isFinite(b)).sort((a, b) => a - b);
    synthesised = supplied.length < 2;
    if (!synthesised) {
      baseBeats = supplied;
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
      num = override[0];
      den = override[1];
      compound = isCompound(num, den);
      meterReason = `manual override ${num}/${den}`;
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

  const ticksPerBeat = beatUnit.toTicksExact(DIVISIONS);
  const barTicksNominal = R(num, den).toTicksExact(DIVISIONS);
  const displayBpm =
    ext && !ext.tempoChanges?.length
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

  // ---- pre-origin material (§3.5) ------------------------------------------------------------
  const preBarBeats: number[] = [];
  const lead = originIdx - firstBeatIdx;
  if (notes.length && lead > EPS) {
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
  const lastOnsetSec = notes.length ? Math.max(...notes.map((n) => n.startSec)) : anchorSec;
  const lastBeatIdx = notes.length
    ? Math.max(interp(lastOnsetSec, grid, indices), interp(lastSec, grid, indices) - 1)
    : originIdx;
  const bars: BarSkeleton[] = [];
  let tick = 0;
  let barNumber = 1;

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
    beatUnit,
    timeSig: [num, den],
    compound,
    displayBpm,
    bars,
    beatTimesSec: grid,
    originBeatIdx: originIdx,
    downbeatTimesSec: bars.filter((b) => !b.implicit).map((b) => interp(b.startBeatIdx, indices, grid)),
    synthesised,
    external: !!ext,
    meterReason,
    totalTicks,

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
