/**
 * A minimal XML reader for the round-trip tests.
 *
 * The pipeline has zero runtime dependencies and the test environment has no DOM, so the
 * MusicXML round-trip is validated by actually PARSING the output into a node tree and walking
 * it — not by matching strings. ~80 lines, and it only needs to handle the subset the emitter
 * produces (elements, attributes, text, self-closing tags, one declaration, one doctype).
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export function parseXml(src: string): XmlNode {
  let i = 0;
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];

  const skipTo = (needle: string): void => {
    const at = src.indexOf(needle, i);
    i = at < 0 ? src.length : at + needle.length;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const text = src.slice(i, lt).trim();
      if (text) stack[stack.length - 1].text += text;
    }
    i = lt;
    if (src.startsWith('<?', i)) {
      skipTo('?>');
      continue;
    }
    if (src.startsWith('<!--', i)) {
      skipTo('-->');
      continue;
    }
    if (src.startsWith('<!', i)) {
      skipTo('>');
      continue;
    }
    const gt = src.indexOf('>', i);
    if (gt < 0) break;
    const raw = src.slice(i + 1, gt).trim();
    i = gt + 1;

    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const spaceAt = body.search(/\s/);
    const name = spaceAt < 0 ? body : body.slice(0, spaceAt);
    const attrs: Record<string, string> = {};
    if (spaceAt >= 0) {
      const attrSrc = body.slice(spaceAt);
      const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(attrSrc))) attrs[m[1]] = m[2];
    }
    const node: XmlNode = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}
export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}
export function textOf(node: XmlNode | undefined): string {
  return node ? node.text : '';
}
export function numberOf(node: XmlNode | undefined, fallback = 0): number {
  const t = textOf(node);
  return t === '' ? fallback : Number(t);
}
export function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export interface ReadNote {
  measure: number;
  voice: number;
  staff: number;
  /** measure-relative tick */
  tick: number;
  duration: number;
  midi: number | null;
  isRest: boolean;
  type: string;
  dots: number;
  tieStart: boolean;
  tieStop: boolean;
  string?: number;
  fret?: number;
  chord: boolean;
  /** false when the note carries print-object="no" — present for the cursor, not for the eye. */
  printed: boolean;
  /** <beam> states, beam level 1 first. Empty when the note is flagged or unbeamable. */
  beams: string[];
  /** <notations><tuplet> types on this note, in document order. */
  tuplets: string[];
  /** <time-modification>, the only thing allowed to stand between <type> and <duration>. */
  timeModification: { actual: number; normal: number } | null;
}

export interface ReadScore {
  divisions: number;
  fifths: number;
  timeSig: [number, number];
  notes: ReadNote[];
  /** measure number -> the cursor position reached on each staff */
  measureLengths: { number: number; implicit: boolean; length: number }[];
  tempo: number | null;
  staffTuning: { line: number; step: string; alter: number; octave: number }[];
  hasTranspose: boolean;
  hasClefOctaveChange: boolean;
}

/** Re-read an emitted MusicXML file the way an importer would. */
export function readMusicXml(xml: string): ReadScore {
  const doc = parseXml(xml);
  const score = child(doc, 'score-partwise');
  if (!score) throw new Error('no <score-partwise>');
  const part = child(score, 'part');
  if (!part) throw new Error('no <part>');

  let divisions = 1;
  let fifths = 0;
  let timeSig: [number, number] = [4, 4];
  let tempo: number | null = null;
  const notes: ReadNote[] = [];
  const measureLengths: ReadScore['measureLengths'] = [];
  const staffTuning: ReadScore['staffTuning'] = [];

  for (const measure of children(part, 'measure')) {
    const number = Number(measure.attrs.number ?? '0');
    const implicit = measure.attrs.implicit === 'yes';
    const attributes = child(measure, 'attributes');
    if (attributes) {
      const d = child(attributes, 'divisions');
      if (d) divisions = Number(d.text);
      const k = child(attributes, 'key');
      if (k) fifths = numberOf(child(k, 'fifths'), fifths);
      const t = child(attributes, 'time');
      if (t) timeSig = [numberOf(child(t, 'beats'), 4), numberOf(child(t, 'beat-type'), 4)];
      for (const sd of children(attributes, 'staff-details')) {
        for (const st of children(sd, 'staff-tuning')) {
          staffTuning.push({
            line: Number(st.attrs.line ?? '0'),
            step: textOf(child(st, 'tuning-step')),
            alter: numberOf(child(st, 'tuning-alter'), 0),
            octave: numberOf(child(st, 'tuning-octave'), 0)
          });
        }
      }
    }
    for (const dir of children(measure, 'direction')) {
      const sound = child(dir, 'sound');
      if (sound?.attrs.tempo) tempo = Number(sound.attrs.tempo);
    }

    // The MusicXML time cursor, exactly as the spec describes it.
    let cursor = 0;
    let maxCursor = 0;
    let lastNoteTick = 0;
    for (const el of measure.children) {
      if (el.name === 'backup') {
        cursor -= numberOf(child(el, 'duration'), 0);
        continue;
      }
      if (el.name === 'forward') {
        cursor += numberOf(child(el, 'duration'), 0);
        maxCursor = Math.max(maxCursor, cursor);
        continue;
      }
      if (el.name !== 'note') continue;
      const isChord = !!child(el, 'chord');
      const duration = numberOf(child(el, 'duration'), 0);
      const rest = child(el, 'rest');
      const pitch = child(el, 'pitch');
      const midi = pitch
        ? (numberOf(child(pitch, 'octave'), 4) + 1) * 12 +
          STEP_PC[textOf(child(pitch, 'step'))] +
          numberOf(child(pitch, 'alter'), 0)
        : null;
      const notations = child(el, 'notations') ?? { name: '', attrs: {}, children: [], text: '' };
      const technical = child(notations, 'technical');
      const ties = children(el, 'tie');
      const timeMod = child(el, 'time-modification');
      const tick = isChord ? lastNoteTick : cursor;
      notes.push({
        measure: number,
        voice: numberOf(child(el, 'voice'), 1),
        staff: numberOf(child(el, 'staff'), 1),
        tick,
        duration,
        midi,
        isRest: !!rest,
        type: textOf(child(el, 'type')),
        dots: children(el, 'dot').length,
        tieStart: ties.some((t) => t.attrs.type === 'start'),
        tieStop: ties.some((t) => t.attrs.type === 'stop'),
        ...(technical ? { string: numberOf(child(technical, 'string'), 0), fret: numberOf(child(technical, 'fret'), 0) } : {}),
        chord: isChord,
        printed: el.attrs['print-object'] !== 'no',
        beams: children(el, 'beam').map((b) => b.text),
        tuplets: children(notations, 'tuplet').map((t) => t.attrs.type ?? ''),
        timeModification: timeMod
          ? { actual: numberOf(child(timeMod, 'actual-notes'), 1), normal: numberOf(child(timeMod, 'normal-notes'), 1) }
          : null
      });
      if (!isChord) {
        lastNoteTick = cursor;
        cursor += duration;
        maxCursor = Math.max(maxCursor, cursor);
      }
    }
    measureLengths.push({ number, implicit, length: maxCursor });
  }

  return {
    divisions,
    fifths,
    timeSig,
    notes,
    measureLengths,
    tempo,
    staffTuning,
    hasTranspose: findAll(score, 'transpose').length > 0,
    hasClefOctaveChange: findAll(score, 'clef-octave-change').length > 0
  };
}
