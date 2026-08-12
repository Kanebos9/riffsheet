/**
 * PART NAMES ON EVERY SYSTEM (Z2c, emit half).
 *
 * A reader labels the FIRST system of a part with its full name and every later one with its
 * abbreviation — MusicXML with `<part-name>`/`<part-abbreviation>`, alphaTab with
 * `Track.name`/`Track.shortName`. A file or hand-off that carries only the full name therefore
 * labels system 1 and leaves the rest of a multi-system page anonymous, which on a two-part score
 * means counting staves to find your instrument.
 *
 * So: both emitters always carry both labels, they are derived in ONE place so the screen and the
 * file cannot print different words for the same part, and a renamed part's short label follows the
 * rename instead of reverting to its instrument's default.
 */

import { describe, it, expect } from 'vitest';
import { buildScore } from '../src/buildScore.js';
import { buildMultiPartScore } from '../src/multipart.js';
import { abbreviatePartName, defaultPartAbbreviation, defaultPartName, toMusicXML } from '../src/musicxml.js';
import type { InputNote } from '../src/types.js';
import { BASS4, grid, input, playedNotes, settings } from './helpers.js';
import { readMusicXml } from './xmlReader.js';

const NOTES: InputNote[] = playedNotes(
  [
    { beat: 0, midi: 40 },
    { beat: 1, midi: 43 },
    { beat: 2, midi: 45 },
    { beat: 3, midi: 47 }
  ],
  0.8
);

function bass() {
  return buildScore(input(NOTES, grid(1)), settings());
}

describe('PART NAMES — the abbreviation derivation, shared by both emitters', () => {
  it('drops the tuning summary and uses the conventional short form', () => {
    expect(abbreviatePartName('Bass — Tuning low → high: E1 A1 D2 G2')).toBe('Bass');
    expect(abbreviatePartName('Guitar — Tuning low → high: E2 A2 D3 G3 B3 E4')).toBe('Gtr.');
    expect(abbreviatePartName('Music')).toBe('Mus.');
  });

  it('abbreviates a name the caller invented, word by word', () => {
    expect(abbreviatePartName('Lead Guitar')).toBe('Lead Gtr.');
    expect(abbreviatePartName('Rhythm')).toBe('Rhyt.');
    expect(abbreviatePartName('Horns')).toBe('Horns');
    // Already short: an abbreviation handed in is not abbreviated a second time.
    expect(abbreviatePartName('Bs.')).toBe('Bs.');
    expect(abbreviatePartName('Contrabassoon')).toBe('Cont.');
  });

  it('a degenerate name degrades to something printable rather than throwing', () => {
    expect(abbreviatePartName('   ')).toBe('');
    expect(abbreviatePartName('—')).toBe('—');
    // Nothing before the dash to name the part with: the first four characters are all there is.
    expect(abbreviatePartName('— Tuning low → high: E1')).toBe('— Tu');
  });

  it('the default abbreviation is the default name abbreviated, not a second guess at it', () => {
    const ir = bass().ir;
    expect(defaultPartName(ir)).toBe('Bass — Tuning low → high: E1 A1 D2 G2');
    expect(defaultPartAbbreviation(ir)).toBe(abbreviatePartName(defaultPartName(ir)));
    expect(defaultPartAbbreviation(ir)).toBe('Bass');
  });
});

describe('PART NAMES — MusicXML carries both labels, always', () => {
  it('a single-part score names itself on system 1 and abbreviates on the rest', () => {
    const read = readMusicXml(bass().toMusicXML());
    expect(read.partList).toHaveLength(1);
    expect(read.partList[0].name).toBe('Bass — Tuning low → high: E1 A1 D2 G2');
    expect(read.partList[0].abbreviation).toBe('Bass');
  });

  it('an explicit abbreviation wins over the derivation', () => {
    const ir = bass().ir;
    const read = readMusicXml(toMusicXML(ir, { partName: 'Bass', partAbbreviation: 'B.' }));
    expect(read.partList[0].name).toBe('Bass');
    expect(read.partList[0].abbreviation).toBe('B.');
  });

  it('a renamed part takes its abbreviation with it', () => {
    const built = buildMultiPartScore(
      [{ notes: NOTES, name: 'Lead Guitar', instrument: 'guitar6' }],
      {},
      settings()
    );
    expect(built.parts[0].abbreviation).toBe('Lead Gtr.');
    const read = readMusicXml(built.toMusicXML());
    expect(read.partList[0].name).toBe('Lead Guitar');
    expect(read.partList[0].abbreviation).toBe('Lead Gtr.');
  });

  it('every part of a multi-part document carries a name and an abbreviation', () => {
    const built = buildMultiPartScore(
      [
        { notes: NOTES, instrument: 'bass4', tuningMidi: BASS4 },
        { notes: NOTES.map((n) => ({ ...n, id: `g${n.id}`, midi: n.midi + 24 })), instrument: 'guitar6' }
      ],
      {},
      settings()
    );
    const read = readMusicXml(built.toMusicXML());
    expect(read.partList).toHaveLength(2);
    for (const part of read.partList) {
      expect(part.name.length).toBeGreaterThan(0);
      expect(part.abbreviation?.length ?? 0).toBeGreaterThan(0);
    }
    expect(read.partList.map((p) => p.abbreviation)).toEqual(['Bass', 'Gtr.']);
    expect(built.parts.map((p) => p.abbreviation)).toEqual(['Bass', 'Gtr.']);
  });

  it('the abbreviation is XML-escaped like every other caller-supplied string', () => {
    const built = buildMultiPartScore(
      [{ notes: NOTES, name: 'A & B', abbreviation: 'A&B' }],
      {},
      settings()
    );
    const xml = built.toMusicXML();
    expect(xml).toContain('<part-abbreviation>A&amp;B</part-abbreviation>');
    expect(readMusicXml(xml).partList[0].abbreviation).toBe('A&amp;B');
  });
});

describe('PART NAMES — the alphaTab hand-off carries both labels, always', () => {
  it('a single-part hand-off sets name and shortName', () => {
    const data = bass().toAlphaTabModelData();
    expect(data.tracks[0].name).toBe('Bass — Tuning low → high: E1 A1 D2 G2');
    expect(data.tracks[0].shortName).toBe('Bass');
  });

  it('screen and file print the same two words for the same part', () => {
    const built = buildMultiPartScore(
      [
        { notes: NOTES, name: 'Bass', abbreviation: 'Bs.' },
        { notes: NOTES.map((n) => ({ ...n, id: `g${n.id}`, midi: n.midi + 24 })), name: 'Lead Guitar', instrument: 'guitar6' }
      ],
      {},
      settings()
    );
    const data = built.toAlphaTabModelData();
    const read = readMusicXml(built.toMusicXML());
    expect(data.tracks.map((t) => [t.name, t.shortName])).toEqual([
      ['Bass', 'Bs.'],
      ['Lead Guitar', 'Lead Gtr.']
    ]);
    expect(read.partList.map((p) => [p.name, p.abbreviation])).toEqual([
      ['Bass', 'Bs.'],
      ['Lead Guitar', 'Lead Gtr.']
    ]);
    // ...and the app is told the same strings, so it cannot label a part a third way.
    expect(built.parts.map((p) => [p.name, p.abbreviation])).toEqual([
      ['Bass', 'Bs.'],
      ['Lead Guitar', 'Lead Gtr.']
    ]);
  });

  it('a staff-only part is Music/Mus. on both sides', () => {
    const built = buildScore(
      input(NOTES, grid(1)),
      settings({ instrument: 'staff', tuningMidi: [] })
    );
    expect(built.toAlphaTabModelData().tracks[0].shortName).toBe('Mus.');
    expect(readMusicXml(built.toMusicXML()).partList[0].abbreviation).toBe('Mus.');
  });
});
