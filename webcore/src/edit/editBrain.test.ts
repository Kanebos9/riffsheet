/**
 * THE FIXED-POINT TEST. Browser-free, deterministic, and the reason `edit/editBrain.ts` exists.
 *
 * RUN IT:
 *
 *     cd webcore && node scripts/run-ts-tests.mjs src/edit/editBrain.test.ts
 *
 * (The repo's existing runner. It bundles this file with the package's own esbuild and runs it
 * on the Node that launched it — no new dependency, no new npm script, nothing to install.)
 *
 * ===========================================================================================
 * WHAT IT PROVES
 * ===========================================================================================
 * 1. THE ACCEPTANCE PROPERTY. Running the auto-edit pass over `transcribeRiffsheet`'s output
 *    proposes ZERO edits, on every fixture below and at every grid the roll can be on. The app
 *    is not allowed to disagree with itself about a take it transcribed itself — the player
 *    trusts the green edits, and three of them on our own transcription is the bug this whole
 *    module answers.
 *
 * 2. THAT THE FIXTURES CAN FAIL IT. Every fixture is also run with `unsettled: true`, which is
 *    the engine as it behaved before the two implementations were fused. Two of them produce
 *    edits that way, and the test asserts they do — because "the pass now finds nothing" is
 *    worth nothing as evidence if the fixture could never have produced anything. This is the
 *    regression lock: unpick the unification and these two assertions fail first.
 *
 * 3. THAT NEITHER SIDE REGRESSED STANDALONE. The pass's own guardrails (split, ghost, cluster,
 *    exempt, fill, noisy, quiet) and the engine's own verdicts (a monophonic take transcribes,
 *    a chordal one refuses, the range prior moves an impossible octave) are checked here, ported
 *    from the browser probes `__RIFFSHEET_AUTOPLAN__` and `__RIFFSHEET_LOCALENGINE__` in
 *    `ui/app.ts` so they can be run without a window.
 *
 * Every fixture is synthesised here with an explicit formula and a seeded pseudo-noise floor:
 * `Math.random` would make a check that fails once a month, and a shipped WAV would make a
 * check nobody can read.
 */

import { detectOnsets, type Onset } from '../audio/onsets';
import { transcribeRiffsheet, type RiffsheetOptions } from '../audio/riffsheetEngine';
import {
  applyAutoEdits,
  classifyOnsetEnergy as passClassify,
  clusterOnsets as passCluster,
  fragmentFloorSec as passFloor,
  planAutoEdits,
  readNoteEvidence as passReadEvidence,
  takePeakOf as passTakePeak
} from './autoEdits';
import {
  MIN_FILL_SEC,
  MIN_FRAGMENT_SEC,
  classifyOnsetEnergy,
  clusterOnsets,
  fragmentFloorSec,
  planEdits,
  readNoteEvidence,
  settle,
  takePeakOf
} from './editBrain';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let failed = 0;
let passed = 0;

function check(condition: unknown, message: string): void {
  if (condition) {
    passed++;
    console.log(`PASS  ${message}`);
    return;
  }
  failed++;
  console.log(`FAIL  ${message}`);
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

const RATE = 44100;
const hzOf = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** A struck note: hard onset, exponential decay, two quiet partials. Deterministic. */
function pluck(pcm: Float32Array, fromSec: number, toSec: number, midi: number, amp = 0.9, decay = 2.5): void {
  const hz = hzOf(midi);
  const a = Math.round(fromSec * RATE);
  const b = Math.min(pcm.length, Math.round(toSec * RATE));
  for (let i = a; i < b; i++) {
    const age = (i - a) / RATE;
    const env = amp * Math.exp(-age * decay);
    const t = i / RATE;
    pcm[i] +=
      env *
      (Math.sin(2 * Math.PI * hz * t) + 0.35 * Math.sin(4 * Math.PI * hz * t) + 0.15 * Math.sin(6 * Math.PI * hz * t));
  }
}

/** A tone with NO attack transient — for the level to STEP DOWN into, i.e. a hand-mute. */
function sustain(pcm: Float32Array, fromSec: number, toSec: number, midi: number, amp: number): void {
  const hz = hzOf(midi);
  const a = Math.round(fromSec * RATE);
  const b = Math.min(pcm.length, Math.round(toSec * RATE));
  for (let i = a; i < b; i++) {
    const t = i / RATE;
    pcm[i] += amp * (Math.sin(2 * Math.PI * hz * t) + 0.3 * Math.sin(4 * Math.PI * hz * t));
  }
}

/** Seeded pseudo-noise. Used both as a hiss floor and as an unpitched region. */
function noise(pcm: Float32Array, fromSec: number, toSec: number, amp: number, seed = 22222): void {
  let s = seed;
  const a = Math.round(fromSec * RATE);
  const b = Math.min(pcm.length, Math.round(toSec * RATE));
  for (let i = a; i < b; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    pcm[i] += amp * (s / 0x7fffffff - 0.5) * 2;
  }
}

const onsetAt = (timeSec: number, strength = 1): Onset => ({ timeSec, strength });

// ---------------------------------------------------------------------------
// 1. ONE BRAIN — there is no second copy of any of this
// ---------------------------------------------------------------------------

section('one brain');

check(passCluster === clusterOnsets, 'the pass and the brain share one clusterOnsets');
check(passClassify === classifyOnsetEnergy, 'the pass and the brain share one classifyOnsetEnergy');
check(passReadEvidence === readNoteEvidence, 'the pass and the brain share one readNoteEvidence');
check(passTakePeak === takePeakOf, 'the pass and the brain share one takePeakOf');
check(passFloor === fragmentFloorSec, 'the pass and the brain share one fragmentFloorSec');

// The transcriber settles against MIN_FRAGMENT_SEC because it has no grid. That is only safe
// while no grid can ever produce a SMALLER floor — if one could, the pass on that grid would be
// willing to split something the engine was not, and the fixed point would break on the roll's
// zoom level rather than on the audio.
{
  let smallest = Infinity;
  for (const snapSec of [0, -1, 0.001, 0.03, 0.0625, 0.125, 0.25, 0.5, 1, 4, Number.NaN, Infinity]) {
    smallest = Math.min(smallest, fragmentFloorSec(snapSec));
  }
  check(smallest >= MIN_FRAGMENT_SEC, 'no grid produces a split floor under MIN_FRAGMENT_SEC');
}

// ---------------------------------------------------------------------------
// 2. THE PASS, STANDALONE — ported from `__RIFFSHEET_AUTOPLAN__`
// ---------------------------------------------------------------------------

section('the pass, standalone');

const oneNote = [{ id: 'n0', startSec: 1, endSec: 1.5, midi: 40 }];
const planned = (over: Parameters<typeof planAutoEdits>[0]) => planAutoEdits(over);

{
  // THE REPORTED CASE: two 250 ms hits returned as one 500 ms note, with a real attack between.
  const merged = planned({
    notes: oneNote,
    onsets: [onsetAt(1), onsetAt(1.25)],
    pcm: null,
    sampleRate: RATE,
    snapSec: 0.25,
    durationSec: 3
  });
  check(merged.splits.length === 1, 'a merged note with an attack in the middle is split once');
  check(merged.splits[0]?.atSec === 1.25, '...at the attack, not at the midpoint or a grid line');

  // A ghost 40 ms before the note's END: the second fragment would be a sliver.
  const ghost = planned({
    notes: oneNote,
    onsets: [onsetAt(1), onsetAt(1.46)],
    pcm: null,
    sampleRate: RATE,
    snapSec: 0.25,
    durationSec: 3
  });
  check(ghost.splits.length === 0, 'an attack near the end of a note is refused, not split');
  check(ghost.attention.length === 1, '...and reported instead of silently dropped');

  // Two detections 40 ms apart are ONE attack, and the strongest survives.
  const cluster = planned({
    notes: oneNote,
    onsets: [onsetAt(1), onsetAt(1.25, 0.4), onsetAt(1.29, 0.9)],
    pcm: null,
    sampleRate: RATE,
    snapSec: 0.25,
    durationSec: 3
  });
  check(cluster.splits.length === 1, 'two detections inside CLUSTER_SEC produce one split');
  check(cluster.splits[0]?.atSec === 1.29, '...on the strongest line, not the earliest');

  // A note the player has already decided about is never argued with.
  const exempt = planned({
    notes: oneNote,
    onsets: [onsetAt(1), onsetAt(1.25)],
    pcm: null,
    sampleRate: RATE,
    snapSec: 0.25,
    durationSec: 3,
    userTouchedIds: new Set(['n0'])
  });
  check(exempt.splits.length === 0, 'a hand-edited note is exempt from the pass');

  // The pass over its own output: the boundary attack is no longer INSIDE anything.
  const applied = applyAutoEdits(oneNote, merged, () => 'auto1');
  const rerun = planned({
    notes: applied.notes,
    onsets: [onsetAt(1), onsetAt(1.25)],
    pcm: null,
    sampleRate: RATE,
    snapSec: 0.25,
    durationSec: 3
  });
  check(rerun.splits.length === 0, 'the pass applied to its own output proposes nothing more');
}

{
  // Gap fills need real samples: the gates are about the audio. A gap BETWEEN two written
  // notes, which is the shape a real missed note has.
  const played = [
    { id: 'n0', startSec: 0.2, endSec: 0.7, midi: 40 },
    { id: 'n1', startSec: 1.8, endSec: 2.3, midi: 40 }
  ];
  const heard = [onsetAt(0.2), onsetAt(1.2), onsetAt(1.8)];
  const around = (pcm: Float32Array) => {
    pluck(pcm, 0.2, 0.7, 28, 0.9, 0);
    pluck(pcm, 1.8, 2.3, 28, 0.9, 0);
  };
  const fillPlan = (pcm: Float32Array) =>
    planned({ notes: played, onsets: heard, pcm, sampleRate: RATE, snapSec: 0.25, durationSec: 3 });

  const steady = new Float32Array(RATE * 3);
  around(steady);
  pluck(steady, 1.2, 1.78, 45, 0.6, 0);
  const fill = fillPlan(steady);
  check(fill.fills.length === 1, 'a steady pitch in a gap the engine left empty becomes one note');
  check(fill.fills[0]?.midi === 45, '...at the pitch the tracker actually read');
  check(fill.fills[0]?.fromSec === 1.2, '...starting at the attack that was heard');
  check(typeof fill.fills[0]?.agreement === 'number' && fill.fills[0].agreement > 0.5, '...carrying its measured agreement');

  const noisy = new Float32Array(RATE * 3);
  around(noisy);
  noise(noisy, 1.2, 1.78, 0.6);
  const noisyPlan = fillPlan(noisy);
  check(noisyPlan.fills.length === 0, 'a gap with no steady pitch is refused');
  check(noisyPlan.attention.length >= 1, '...and highlighted instead');

  const faint = new Float32Array(RATE * 3);
  around(faint);
  pluck(faint, 1.2, 1.78, 45, 0.0012, 0);
  const quietPlan = fillPlan(faint);
  check(quietPlan.fills.length === 0, 'a gap under the level floor is refused');
  check(quietPlan.attention.length >= 1, '...and highlighted instead');

  const brief = new Float32Array(RATE * 3);
  around(brief);
  pluck(brief, 1.2, 1.2 + MIN_FILL_SEC * 0.5, 45, 0.6, 0);
  check(fillPlan(brief).fills.length === 0, 'a gap shorter than MIN_FILL_SEC is refused');
}

// ---------------------------------------------------------------------------
// 3. THE FIXTURES — every take the fixed point is asserted over
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  /** What about the brain's job this take is here to exercise. */
  about: string;
  pcm: Float32Array;
  durationSec: number;
  opts?: RiffsheetOptions;
  /** True when the unfused engine used to leave work for the pass on this take. */
  divergedBefore?: boolean;
}

function blank(durationSec: number): Float32Array {
  return new Float32Array(Math.round(durationSec * RATE));
}

const fixtures: Fixture[] = [];

{
  // RUN-TOGETHER NOTES: two hits of about a quarter of a second, the reported case.
  const dur = 1.5;
  const pcm = blank(dur);
  pluck(pcm, 0.2, 0.45, 45);
  pluck(pcm, 0.45, 0.7, 45);
  fixtures.push({ name: 'merged-hits', about: 'two hits the engine must not return as one note', pcm, durationSec: dur });
}

{
  // MUTE INSIDE A NOTE. The hand lands at 0.7 and the string keeps ringing quietly, then the
  // hand settles again at ~1.6.
  //
  // TWO FAULTS LIVED HERE. The engine used to keep the LAST mute as the note's end and run
  // straight through the first, leaving a cluster winner inside a note — which the pass calls a
  // split, and which it did propose on this take. That one is fixed in the SEGMENTATION (the
  // first hand wins), so it cannot be reproduced through the test seam any more; what the
  // invariant below checks instead is the general form of it — no engine note ever contains an
  // attack. What the seam still shows is the second fault: the stretch after the hand, which
  // the engine declined to start a note at and the pass filled.
  const dur = 2.0;
  const pcm = blank(dur);
  pluck(pcm, 0.2, 0.7, 45, 0.9, 1.0);
  sustain(pcm, 0.7, 1.6, 45, 0.06);
  fixtures.push({
    name: 'palm-mute',
    about: 'a note damped mid-ring: the first hand ends it, and the rest is its own note',
    pcm,
    durationSec: dur,
    divergedBefore: true
  });
}

{
  // TWO MUTES AFTER ONE ATTACK. Both old faults at once: a mute left inside the note (a split)
  // and a stretch after it that the engine refused to start a note at (a fill), because its
  // rule is "a hand starts nothing" and the pass has no such rule.
  const dur = 2.2;
  const pcm = blank(dur);
  pluck(pcm, 0.2, 0.6, 45, 0.9, 0.6);
  sustain(pcm, 0.6, 1.1, 45, 0.1);
  sustain(pcm, 1.1, 1.8, 45, 0.012);
  fixtures.push({
    name: 'two-mutes',
    about: 'a qualifying gap the engine declined to write and the pass would have filled',
    pcm,
    durationSec: dur,
    divergedBefore: true
  });
}

{
  // A GAP THAT DOES NOT QUALIFY: an attack, then noise. Nothing steady to write down.
  const dur = 1.6;
  const pcm = blank(dur);
  pluck(pcm, 0.2, 0.9, 45);
  noise(pcm, 1.0, 1.5, 0.25);
  fixtures.push({ name: 'unpitched-gap', about: 'a gap with an attack in it and no steady pitch', pcm, durationSec: dur });
}

{
  // A GAP THAT DOES NOT QUALIFY: too quiet. −55 dB under the take is room tone.
  const dur = 1.8;
  const pcm = blank(dur);
  pluck(pcm, 0.2, 0.9, 45);
  pluck(pcm, 1.0, 1.7, 45, 0.0016, 0);
  fixtures.push({ name: 'quiet-gap', about: 'a gap under the level floor', pcm, durationSec: dur });
}

{
  // A GAP THAT DOES NOT QUALIFY: too short to write down safely.
  const dur = 1.4;
  const pcm = blank(dur);
  pluck(pcm, 0.2, 0.9, 45);
  pluck(pcm, 1.0, 1.06, 47, 0.7, 0);
  fixtures.push({ name: 'short-gap', about: 'a gap shorter than a fill is allowed to be', pcm, durationSec: dur });
}

{
  // AN ATTACK WITH AN UNPITCHED HEAD: 80 ms of pick noise, then a steady note. The two evidence
  // profiles vote over different openings (100 ms against 150 ms), so this is where they can
  // read a different note from the same frames.
  const dur = 1.6;
  const pcm = blank(dur);
  noise(pcm, 0.3, 0.38, 0.5);
  sustain(pcm, 0.38, 1.2, 52, 0.5);
  fixtures.push({ name: 'noisy-attack', about: 'the two evidence profiles reading one attack', pcm, durationSec: dur });
}

{
  // AN ORDINARY LINE. Eight notes, nothing unusual — the case that must not acquire edits.
  const dur = 3.0;
  const pcm = blank(dur);
  [40, 45, 47, 45, 43, 40, 52, 50].forEach((midi, i) => {
    pluck(pcm, 0.2 + i * 0.32, 0.5 + i * 0.32, midi, 0.9, 2.0);
  });
  fixtures.push({ name: 'riff', about: 'an ordinary monophonic line', pcm, durationSec: dur });
}

{
  // A LONG RINGING NOTE with nothing after it. A fill's length is measured, not capped, so the
  // tail is where a length cap used to invent an ending.
  const dur = 4.0;
  const pcm = blank(dur);
  pluck(pcm, 0.3, 3.9, 40, 0.95, 0.6);
  fixtures.push({ name: 'long-ring', about: 'a note left to ring, longer than any cap', pcm, durationSec: dur });
}

{
  // THE OCTAVE GUARD's range prior, on a take the tracker reads correctly but the instrument
  // says is impossible: an A2 with a tuning whose lowest open string is E4.
  const dur = 1.2;
  const pcm = blank(dur);
  pluck(pcm, 0.2, 1.1, 45, 0.9, 0.8);
  fixtures.push({
    name: 'octave-guard',
    about: 'a read outside the instrument the player said they are holding',
    pcm,
    durationSec: dur,
    opts: { tuningLowToHigh: [64], maxFret: 5 }
  });
}

/** The six-pluck monophonic take from `__RIFFSHEET_LOCALENGINE__`, with its hiss floor. */
function probeTake(withFifth: boolean): Float32Array {
  const pcm = new Float32Array(RATE * 6);
  const roots = [45, 43, 41, 45, 43, 40];
  const amps = [0.4, 0.55, 0.3, 0.16, 0.09, 0.05];
  const phases = [0, 0.7, 1.9, 2.6, 0.4, 1.3];
  const strike = (atSec: number, midi: number, gain: number) => {
    const from = Math.round(atSec * RATE);
    const hz = hzOf(midi);
    for (let k = 0; k + from < pcm.length; k++) {
      const t = k / RATE;
      if (t > 0.8) break;
      const env = Math.exp(-t * 2.6) * (1 - Math.exp(-t * 300)) * Math.min(1, (0.8 - t) * 20);
      let v = 0;
      for (let p = 0; p < amps.length; p++) {
        v += amps[p] * Math.exp(-t * (1.2 + p * 0.9)) * Math.sin(2 * Math.PI * hz * (p + 1) * t + phases[p]);
      }
      pcm[from + k] += gain * env * v * 0.5;
    }
  };
  roots.forEach((midi, i) => {
    strike(0.3 + i * 0.9, midi, 1);
    if (withFifth) strike(0.3 + i * 0.9, midi + 7, 0.9);
  });
  noise(pcm, 0, 6, 0.0018, 12345);
  return pcm;
}

fixtures.push({
  name: 'six-plucks',
  about: 'the engine probe’s own monophonic take, hiss floor and all',
  pcm: probeTake(false),
  durationSec: 6,
  opts: { tuningLowToHigh: [28, 33, 38, 43] }
});

// ---------------------------------------------------------------------------
// 4. THE ENGINE, STANDALONE — it still refuses and still guards
// ---------------------------------------------------------------------------

section('the engine, standalone');

{
  const mono = transcribeRiffsheet(probeTake(false), RATE, { tuningLowToHigh: [28, 33, 38, 43] });
  check(mono.ok, 'a monophonic take transcribes');
  if (mono.ok) {
    check(mono.notes.length >= 6, `...into at least the six notes that were played (got ${mono.notes.length})`);
    check(
      mono.notes.every((n) => Number.isFinite(n.confidence) && n.confidence > 0 && n.confidence <= 1),
      '...every note carrying a measured confidence, filled notes included'
    );
    check(
      mono.notes.every((n) => n.endSec > n.startSec),
      '...and no note that ends before it starts'
    );
  }

  const chord = transcribeRiffsheet(probeTake(true), RATE, { tuningLowToHigh: [28, 33, 38, 43] });
  check(!chord.ok && chord.refusal.kind === 'polyphony', 'the same take with a fifth on every note is refused');
  check(!chord.ok && chord.stats.contested >= 2, '...on the evidence of contested segments, not a hunch');

  const silence = transcribeRiffsheet(new Float32Array(RATE), RATE, {});
  check(!silence.ok && silence.refusal.kind === 'nothing-heard', 'silence is handed on, not transcribed');

  const guarded = fixtures.find((f) => f.name === 'octave-guard')!;
  const unguarded = transcribeRiffsheet(guarded.pcm, RATE, { durationSec: guarded.durationSec });
  const withRange = transcribeRiffsheet(guarded.pcm, RATE, { ...guarded.opts, durationSec: guarded.durationSec });
  check(unguarded.ok && unguarded.notes[0]?.midi === 45, 'with no tuning the read stands exactly as measured');
  check(withRange.ok && withRange.notes[0]?.midi === 57, 'a read below the lowest open string is moved an octave up');
  check(withRange.ok && withRange.stats.rangeMoves === 1, '...by the range prior, and it says so');
  check(
    unguarded.ok && withRange.ok && withRange.notes[0].confidence < unguarded.notes[0].confidence,
    '...and a moved note is less confident than one nobody argued about'
  );
}

// ---------------------------------------------------------------------------
// 5. THE ACCEPTANCE PROPERTY
// ---------------------------------------------------------------------------

section('the fixed point');

/** Every grid the roll can be on, so the split floor cannot be what makes this pass. */
const GRIDS = [0.0625, 0.125, 0.25, 0.5, 1];

/** What the auto-edit pass proposes on a transcription, at one grid. */
function editsOn(notes: Array<{ startSec: number; endSec: number; midi: number }>, f: Fixture, snapSec: number) {
  const plan = planAutoEdits({
    // The ids `ui/app.ts` gives every note it receives. Without them a split is not even
    // considered, and the whole check would pass by accident.
    notes: notes.map((n, i) => ({ ...n, id: `n${i}` })),
    onsets: detectOnsets(f.pcm, RATE).onsets,
    pcm: f.pcm,
    sampleRate: RATE,
    snapSec,
    durationSec: f.durationSec
  });
  return plan;
}

let divergedTotal = 0;
for (const f of fixtures) {
  const settledTake = transcribeRiffsheet(f.pcm, RATE, { ...f.opts, durationSec: f.durationSec });
  check(settledTake.ok, `${f.name}: transcribes (${f.about})`);
  if (!settledTake.ok) continue;

  let worst = 0;
  let where = '';
  for (const snapSec of GRIDS) {
    const plan = editsOn(settledTake.notes, f, snapSec);
    const edits = plan.splits.length + plan.fills.length;
    if (edits > worst) {
      worst = edits;
      where = `${plan.splits.length} splits + ${plan.fills.length} fills at snap ${snapSec}`;
    }
  }
  check(worst === 0, `${f.name}: the pass proposes ZERO edits on the engine's output${worst ? ` (got ${where})` : ''}`);

  // ...and the same asked of the brain directly, at the floor the engine settles against.
  const again = settle(
    settledTake.notes.map((n, i) => ({ ...n, id: `n${i}` })),
    {
      onsets: detectOnsets(f.pcm, RATE).onsets,
      pcm: f.pcm,
      sampleRate: RATE,
      durationSec: f.durationSec,
      newId: () => 'x'
    }
  );
  check(again.rounds === 0 && again.settled, `${f.name}: settling the engine's output again changes nothing`);

  // The other half of the evidence: could this fixture ever have failed?
  const raw = transcribeRiffsheet(f.pcm, RATE, { ...f.opts, durationSec: f.durationSec, unsettled: true });
  if (raw.ok) {
    const before = editsOn(raw.notes, f, 0.25);
    // THE SEGMENTATION'S OWN INVARIANT, checked before the settle step can paper over it: no
    // note this engine reads ever contains a clustered attack. A note runs to the next thing
    // that happened and not one line past it, so a split is not something the settle step
    // should ever have to make on the engine's own reading — the mute bookkeeping is where that
    // used to go wrong, and this is the assertion that keeps it right.
    check(
      before.splits.length === 0,
      `${f.name}: the engine's own segmentation leaves no attack inside a note`
    );
    const count = before.splits.length + before.fills.length;
    divergedTotal += count;
    if (f.divergedBefore) {
      check(
        count > 0,
        `${f.name}: the unfused engine DID leave ${count} edit(s) here — ${before.splits.length} split(s), ${before.fills.length} fill(s)`
      );
    }
    if (count > 0) {
      check(
        settledTake.stats.settledSplits + settledTake.stats.settledFills > 0,
        `${f.name}: the engine reports having taken those decisions itself`
      );
    }
  }
}

check(divergedTotal >= 3, `the corpus reproduces the reported bug: ${divergedTotal} auto edits without the fused brain`);

// ---------------------------------------------------------------------------
// 6. THE PASS IS STILL THE PASS on somebody else's transcription
// ---------------------------------------------------------------------------

section('foreign transcriptions still get edited');

{
  // What another engine's output looks like: the two hits returned as one note. The pass must
  // still act on this — the unification must not have quietly turned the feature off.
  const f = fixtures.find((x) => x.name === 'merged-hits')!;
  const onsets = detectOnsets(f.pcm, RATE).onsets;
  const foreign = [{ id: 'f0', startSec: 0.19, endSec: 0.63, midi: 45 }];
  const plan = planAutoEdits({
    notes: foreign,
    onsets,
    pcm: f.pcm,
    sampleRate: RATE,
    snapSec: 0.25,
    durationSec: f.durationSec
  });
  check(plan.splits.length === 1, 'a foreign engine’s merged note is still split');

  const applied = applyAutoEdits(foreign, plan, () => 'auto1');
  const after = planEdits({
    notes: applied.notes,
    onsets,
    pcm: f.pcm,
    sampleRate: RATE,
    floorSec: MIN_FRAGMENT_SEC,
    durationSec: f.durationSec
  });
  check(
    after.splits.length === 0 && after.fills.length === 0,
    '...and the result of applying the pass is itself a fixed point'
  );
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`${failed} check(s) failed`);
}
