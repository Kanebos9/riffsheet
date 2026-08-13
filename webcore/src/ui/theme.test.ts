/**
 * G3 — THE THEME PALETTES, CHECKED WITHOUT A BROWSER.
 *
 * RUN IT:
 *
 *     cd webcore && node scripts/run-ts-tests.mjs src/ui/theme.test.ts
 *
 * ===========================================================================================
 * WHY A TEST AND NOT AN EYE
 * ===========================================================================================
 *
 * A screenshot proves a theme looks like something. It cannot prove the dim status line under
 * the engine card is still readable in it — that is arithmetic, and arithmetic is exactly what
 * gets skipped when four palettes are being tuned by hand at one in the morning.
 *
 * So every readable pair in every theme is asserted here (`ui/theme.ts §CONTRAST_PAIRS`): body
 * text on all three surfaces, the DIM text on all three (it carries sentences, not decoration),
 * the ink printed on a filled accent, the accent where it is used as text, and the engraved
 * page's ink on its paper — 4.5:1 or better, WCAG AA for normal text. The shapes — the accent
 * as a fill, the waveform's silhouette, the roll's note bodies — are held to 3:1, which is the
 * bar for a non-text object.
 *
 * AND THE DEFAULT IS PINNED TO THE STYLESHEET. `midnight` is not a palette somebody invented
 * for this file: it is the app's own `:root`, copied. If the two ever drift, switching to the
 * default theme would repaint the app in something subtly other than what it boots as — a bug
 * that is nearly invisible and permanent. The check below parses `ui/styles.css` and compares
 * every token, so the drift fails here instead.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONTRAST_PAIRS,
  DEFAULT_THEME_ID,
  THEMES,
  contrastFailures,
  contrastRatio,
  parseHex,
  relativeLuminance,
  themeById,
  type ThemeTokens
} from './theme';

let passed = 0;
let failed = 0;

function check(ok: boolean, what: string): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failed++;
    console.log(`  FAIL ${what}`);
  }
}

// ---------------------------------------------------------------------------
console.log('the arithmetic itself');
// ---------------------------------------------------------------------------
{
  check(contrastRatio('#ffffff', '#000000') === 21, 'white on black is 21:1, the maximum');
  check(contrastRatio('#777777', '#777777') === 1, 'a colour on itself is 1:1');
  check(
    Math.abs(contrastRatio('#ffffff', '#767676') - 4.54) < 0.01,
    'the WCAG worked example (#767676 on white) comes out at 4.54'
  );
  check(
    contrastRatio('#8b5cf6', '#16181d') === contrastRatio('#16181d', '#8b5cf6'),
    'the ratio does not care which colour is named first'
  );
  check(parseHex('#abc')?.r === 0xaa && parseHex('#abc')?.b === 0xcc, 'three-digit hex expands');
  check(
    parseHex('#8b5cf633')?.g === 0x5c && relativeLuminance('#8b5cf633') === relativeLuminance('#8b5cf6'),
    'an eight-digit hex drops its alpha rather than being rejected'
  );
  check(parseHex('not a colour') === null, 'a word that is not a colour parses as nothing');
}

// ---------------------------------------------------------------------------
console.log('\nthe palettes');
// ---------------------------------------------------------------------------
{
  check(THEMES.length >= 4, `there are ${THEMES.length} designed themes`);
  check(
    THEMES.some((t) => t.id === DEFAULT_THEME_ID) && THEMES[0].id === DEFAULT_THEME_ID,
    'the default is one of them, and it is the first card in the row'
  );
  check(
    THEMES.filter((t) => t.colorScheme === 'light').length >= 1,
    'at least one of them is a light theme'
  );
  check(
    new Set(THEMES.map((t) => t.tokens.accent)).size === THEMES.length,
    'no two themes share an accent — each card is a different idea'
  );
  check(
    new Set(THEMES.map((t) => t.id)).size === THEMES.length,
    'every id is unique, so a stored preference can only mean one thing'
  );
  check(themeById('nonsense').id === DEFAULT_THEME_ID, 'an unknown id falls back to the default');

  const tokenCount = Object.keys(THEMES[0].tokens).length;
  for (const theme of THEMES) {
    check(
      Object.keys(theme.tokens).length === tokenCount &&
        Object.values(theme.tokens).every((v) => parseHex(v) !== null),
      `${theme.id}: declares all ${tokenCount} tokens, every one a real colour`
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\ncontrast — every readable pair in every theme');
// ---------------------------------------------------------------------------
{
  for (const theme of THEMES) {
    const failures = contrastFailures(theme);
    check(
      failures.length === 0,
      `${theme.id}: all ${CONTRAST_PAIRS.length} pairs clear their minimum` +
        (failures.length
          ? ` — ${failures.map((f) => `${f.what} ${f.ratio.toFixed(2)}:1 < ${f.min}`).join('; ')}`
          : '')
    );
    // Printed whatever happens: a number nobody can see is a number nobody maintains.
    for (const pair of CONTRAST_PAIRS) {
      const ratio = contrastRatio(theme.tokens[pair.fg], theme.tokens[pair.bg]);
      console.log(
        `       ${theme.id.padEnd(9)} ${ratio.toFixed(2).padStart(5)}:1  (min ${pair.min})  ${pair.what}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\nthe default palette is the stylesheet, exactly');
// ---------------------------------------------------------------------------
{
  const cssPath = resolve(process.cwd(), 'src/ui/styles.css');
  const css = readFileSync(cssPath, 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
  const declared = new Map<string, string>();
  for (const m of root.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) declared.set(m[1], m[2]);

  check(declared.size > 12, `the stylesheet's :root declares ${declared.size} colour tokens`);

  const midnight = themeById(DEFAULT_THEME_ID).tokens;
  const drift: string[] = [];
  for (const [token, value] of Object.entries(midnight)) {
    const css = declared.get(token);
    // `--accent-ink` is the one deliberate difference, and it is documented where it is made:
    // the stylesheet's value is a fifth of a step under 4.5:1 on the accent it prints on.
    if (token === 'accent-ink') continue;
    if (css && css.toLowerCase() !== value.toLowerCase()) drift.push(`${token}: css ${css} vs theme ${value}`);
  }
  check(drift.length === 0, `the default theme matches :root token for token${drift.length ? ` — ${drift.join(', ')}` : ''}`);

  const missing = [...declared.keys()].filter(
    (token) => !(token in midnight) && token !== 'radius'
  );
  check(
    missing.length === 0,
    `every colour token the stylesheet declares is themeable${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`
  );

  // The canvases read tokens the stylesheet does not declare (they fall back to literals in
  // `view/pianoroll.ts §readColors`). A theme that leaves them out would paint the roll's keys
  // and note outlines in the DEFAULT palette's colours whatever else it did.
  const canvasTokens: Array<keyof ThemeTokens> = ['wave', 'wave-played', 'playhead', 'roll-row', 'roll-note'];
  check(
    THEMES.every((theme) => canvasTokens.every((token) => parseHex(theme.tokens[token]) !== null)),
    'every theme answers for the two canvases as well as for the chrome'
  );
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`${failed} check(s) failed`);
}
