/**
 * Synthetic performances, as the pipeline would receive them.
 *
 * These are `InputNote[]` in seconds — NOT pre-quantized notation — so the spike and the
 * browser demo exercise the real Team C pipeline end to end rather than a hand-built score
 * that skips it. The triplet fixture exists to stress alphaTab issue #2657 (hit-test drift
 * inside expanded tuplet ranges) and Team C's tuplet quantizer at the same time.
 */

import type { InputNote } from '../pipeline';

export interface Performance {
  notes: InputNote[];
  beats: number[];
  bpm: number;
  durationSec: number;
}

/**
 * The one bar whose beat 4 is HELD over the bar line, or -1 when the riff is too short to
 * have a bar line to hold over.
 *
 * Bar 4 of the default 8 — the middle of the phrase, and the place a bass player lands on
 * the root and lets it ring into the next bar instead of playing another fill. It is the
 * only note in any fixture that crosses a bar line, so it is the only thing that makes the
 * engraver emit a tie: several noteheads, one id. The tie checks in `scripts/verify.mjs`
 * measure exactly that, and before this note existed they were passing on an empty set.
 *
 * A held note needs SILENCE under it or `clampOverlaps` in the pipeline truncates it back to
 * the next attack, so this costs two things: beat 4 of that bar is one long note instead of
 * a triplet, and the following bar comes in on the off-beat rather than the downbeat. Both
 * are how the phrase would really be played.
 */
function heldBarIndex(bars: number): number {
  return bars >= 2 ? Math.min(3, bars - 2) : -1;
}

/**
 * A triplet-heavy bass riff. Each bar is:
 *   beat 1  two straight eighths
 *   beat 2  an eighth-note triplet
 *   beat 3  a quarter double-stop (root + fifth)
 *   beat 4  another eighth-note triplet, descending
 *
 * With ONE exception, at `heldBarIndex(bars)`: that bar's beat 4 is a single root held for
 * a beat and a half, over the bar line, and the bar after it therefore starts on the
 * off-beat. See `heldBarIndex`.
 */
export function tripletRiff(bars: number, bpm = 96): Performance {
  const beatSec = 60 / bpm;
  const notes: InputNote[] = [];
  const beats: number[] = [];
  const root = [28, 31, 33, 35]; // E1 G1 A1 B1
  let id = 0;

  const push = (startSec: number, lengthSec: number, midi: number) => {
    notes.push({
      id: `f${id++}`,
      startSec,
      endSec: startSec + lengthSec * 0.92,
      midi,
      velocity: 96
    });
  };

  const held = heldBarIndex(bars);

  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * 4 * beatSec;
    const base = root[bar % root.length];
    for (let b = 0; b < 4; b++) beats.push(barStart + b * beatSec);

    // beat 1 — two eighths, minus the downbeat in the bar the held root rings into. That
    // silence is what lets the tie exist; an attack on the bar line would clamp it away.
    if (bar !== held + 1 || held < 0) push(barStart, beatSec / 2, base);
    push(barStart + beatSec / 2, beatSec / 2, base + 12);

    // beat 2 — eighth triplet
    const t = beatSec / 3;
    [0, 3, 5].forEach((interval, i) => push(barStart + beatSec + i * t, t, base + interval));

    // beat 3 — double stop on a quarter
    push(barStart + 2 * beatSec, beatSec, base);
    push(barStart + 2 * beatSec, beatSec, base + 7);

    if (bar === held) {
      // beat 4 — the root, held a beat and a half, THROUGH the bar line. Written out rather
      // than pushed, because `push` shortens every note to 0.92 of its length (the reason no
      // fixture note has ever reached the next bar) and this one has to arrive exactly at the
      // next attack: a beat of bar `held` plus an eighth of the bar after it, engraved as a
      // quarter tied to an eighth.
      notes.push({
        id: `f${id++}`,
        startSec: barStart + 3 * beatSec,
        endSec: barStart + 4.5 * beatSec,
        midi: base,
        velocity: 96
      });
    } else {
      // beat 4 — descending eighth triplet
      [7, 5, 3].forEach((interval, i) => push(barStart + 3 * beatSec + i * t, t, base + interval));
    }
  }

  return { notes, beats, bpm, durationSec: bars * 4 * beatSec };
}

/** Straight eighths — the control case, and the browser demo's calmer option. */
export function straightRiff(bars: number, bpm = 110): Performance {
  const beatSec = 60 / bpm;
  const eighth = beatSec / 2;
  const pattern = [28, 28, 35, 33, 31, 31, 33, 28];
  const notes: InputNote[] = [];
  const beats: number[] = [];
  let id = 0;

  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * 4 * beatSec;
    for (let b = 0; b < 4; b++) beats.push(barStart + b * beatSec);
    pattern.forEach((midi, i) => {
      const start = barStart + i * eighth;
      notes.push({
        id: `f${id++}`,
        startSec: start,
        endSec: start + eighth * 0.9,
        midi: midi + (bar % 2 === 1 && i === 7 ? 5 : 0),
        velocity: 96
      });
    });
  }

  return { notes, beats, bpm, durationSec: bars * 4 * beatSec };
}

/**
 * A drop-tuned riff played against a standard 4-string setting: it dips to D1 and C1, both
 * BELOW the low E of the default tuning.
 *
 * The pipeline cannot put those on the fretboard, so it folds the tab position up an octave
 * and records `IRNote.tabOctaveShift`. That path used to be invisible on screen — the tab
 * showed a position that does not sound the pitch on the staff above it, and said nothing.
 * This fixture is what the headless harness renders to prove the marker is there.
 */
export function dropTunedRiff(bars: number, bpm = 88): Performance {
  const beatSec = 60 / bpm;
  const eighth = beatSec / 2;
  //               D1  D1  C1  D1  E1  G1  A1  D1
  const pattern = [26, 26, 24, 26, 28, 31, 33, 26];
  const notes: InputNote[] = [];
  const beats: number[] = [];
  let id = 0;

  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * 4 * beatSec;
    for (let b = 0; b < 4; b++) beats.push(barStart + b * beatSec);
    pattern.forEach((midi, i) => {
      const start = barStart + i * eighth;
      notes.push({ id: `f${id++}`, startSec: start, endSec: start + eighth * 0.9, midi, velocity: 96 });
    });
  }

  return { notes, beats, bpm, durationSec: bars * 4 * beatSec };
}

/**
 * A four-bar guitar part, as MusicXML — the fixture the PARTS feature is checked against.
 *
 * Deliberately the smallest file that is a real MusicXML document: one `score-part` with a
 * `<part-name>` (which is where the chip's label has to come from), a treble clef, 4/4, and
 * quarter notes at written ticks. It sits an octave and a bit above the bass demo, so a
 * screenshot of the two of them together shows two clearly separate systems.
 *
 * It is a string rather than a file under `public/` because the harness drives the REAL import
 * path — `parseScoreFile` on bytes — and a fixture that has to be fetched would only add a
 * server round trip to a test about parts.
 */
export const GUITAR_PART_MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1">
      <part-name>Guitar</part-name>
      <part-abbreviation>Gtr.</part-abbreviation>
    </score-part>
  </part-list>
  <part id="P1">
${[
  ['E', 4, 'G', 4, 'B', 4, 'E', 5],
  ['D', 4, 'A', 4, 'D', 5, 'A', 4],
  ['C', 4, 'G', 4, 'E', 5, 'G', 4],
  ['G', 3, 'D', 4, 'B', 4, 'D', 5]
]
  .map((bar, index) => {
    const attributes =
      index === 0
        ? `      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
`
        : '';
    const notes: string[] = [];
    for (let i = 0; i < bar.length; i += 2) {
      notes.push(`      <note>
        <pitch><step>${bar[i]}</step><octave>${bar[i + 1]}</octave></pitch>
        <duration>1</duration>
        <voice>1</voice>
        <type>quarter</type>
      </note>`);
    }
    return `    <measure number="${index + 1}">
${attributes}${notes.join('\n')}
    </measure>`;
  })
  .join('\n')}
  </part>
</score-partwise>
`;
