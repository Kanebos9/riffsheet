/**
 * THE THEMES (G3) — four designed palettes, one row of cards, no colour pickers.
 *
 * ==========================================================================================
 * WHY THE PALETTES ARE DATA AND NOT CSS BLOCKS
 * ==========================================================================================
 *
 * Everything on this face is already drawn from tokens: `ui/styles.css` declares them on
 * `:root`, and the two canvases read the SAME tokens through `getComputedStyle` rather than
 * carrying literals (`view/pianoroll.ts §readColors`, `ui/waveform.ts §readColors`). So a theme
 * does not need a stylesheet of its own — it needs the tokens to hold different values.
 *
 * They are a TABLE here rather than four `:root[data-theme=…]` blocks for one reason: a
 * contrast rule that lives in a comment is a contrast rule nobody checks. `theme.test.ts`
 * walks this table and asserts every readable pair (text on each of the three surfaces, the
 * dim text, the ink on a filled accent, the sheet's own ink on its paper) at 4.5:1 or better,
 * which is only possible because the values are addressable from a test. A palette that fails
 * cannot be shipped: the suite goes red before the screenshot is ever taken.
 *
 * The default theme's values are EXACTLY the ones in `ui/styles.css :root`. Applying it is
 * therefore a no-op on screen, and the stylesheet stays the single declaration of the design.
 *
 * ==========================================================================================
 * HOW A SWITCH REACHES THE CANVASES
 * ==========================================================================================
 *
 * `applyTheme()` writes the tokens as inline custom properties on `:root`, which the cascade
 * puts over the stylesheet's own, and sets `color-scheme` so the platform's own furniture (the
 * native drop-down popups, the scrollbars, the focus rings) turns over with the rest.
 *
 * CSS follows at once. THE TWO CANVASES DO NOT: `PianoRoll` and `WaveformStrip` read their
 * colours ONCE, in their constructors, into a private table — so a theme change with nothing
 * else done to it leaves the roll and the waveform painted in the old palette until something
 * unrelated happens to rebuild them. That is why `setTheme()` is handed a redraw callback by
 * `ui/settings.ts` and `ui/app.ts` answers it with a full `renderMain()`, which destroys and
 * rebuilds both surfaces (`app.ts §renderMain`). The sheet is SVG under the same tokens and
 * needs nothing.
 */

/** One token table. The keys are the CSS custom property names without their leading dashes. */
export interface ThemeTokens {
  bg: string;
  'bg-raised': string;
  'bg-panel': string;
  border: string;
  text: string;
  'text-dim': string;
  accent: string;
  'accent-hover': string;
  'accent-ink': string;
  'accent-soft': string;
  /**
   * THE ACCENT AS IT IS DRAWN ON THE ENGRAVING'S PAPER — selection rings, hover rings.
   *
   * A SEPARATE TOKEN because the paper is not any of the three surfaces the accent was ever
   * checked against. `--accent` is tuned to sit on `--bg-panel` and its friends, which in three
   * of the four themes are near-black; the paper is near-white in all four. Ember's orange
   * measures 2.24:1 on its own paper and Tide's cyan 2.28:1 — both well under the 3:1 a shape
   * needs, which is why a selection ring could be technically present and practically invisible
   * regardless of how thick it was drawn. Thickening it (see `triview.ts` §SELECTION TREATMENT)
   * fixes the size half of finding 11; this fixes the contrast half, and the two are independent.
   *
   * Where the accent already clears the bar on paper the value IS the accent, unchanged — this
   * is not a second palette, it is the same colour with the two themes that needed it darkened.
   */
  'accent-on-paper': string;
  /**
   * The wash INSIDE a selection ring on paper. Alpha, like `--accent-soft`, and for the same
   * reason not contrast-checked: it is a tint behind engraving ink, never a colour anything is
   * read against.
   *
   * Stronger than `--accent-soft` (which is 20%) because that token's job is a gentle chrome
   * state — a hovered label, an armed card — and this one's is "you cannot miss which note this
   * is". Sharing the chrome's tint is how selection came to be described as not attracting.
   */
  'accent-select': string;
  paper: string;
  ink: string;
  danger: string;
  warn: string;
  ok: string;
  success: string;
  wave: string;
  'wave-played': string;
  playhead: string;
  'roll-row': string;
  'roll-note': string;
}

export interface Theme {
  id: string;
  /** What the card says. Two words at most — the row holds four of them. */
  name: string;
  /** The one-line description under the name. */
  note: string;
  /** What the platform should draw its own furniture as. */
  colorScheme: 'dark' | 'light';
  tokens: ThemeTokens;
}

/**
 * THE FOUR.
 *
 * One default (the dark purple this app has always been), one light, and two accent variants —
 * the brief was "4-5 designed presets", and four distinguishable ones beat five where two are
 * the same idea at different saturations.
 *
 * Every non-default palette moves the SURFACES as well as the accent. An accent-only swap reads
 * as a stuck highlight rather than as a theme: the waveform, the roll's note fill and the
 * played half of the strip all belong to the same family as the chips, and they move together
 * or the face stops looking like one thing.
 */
export const THEMES: readonly Theme[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    note: 'The original. Deep slate under a violet accent.',
    colorScheme: 'dark',
    tokens: {
      bg: '#16181d',
      'bg-raised': '#1e2128',
      'bg-panel': '#23262e',
      border: '#2e3340',
      text: '#e8eaee',
      'text-dim': '#9aa0ab',
      accent: '#8b5cf6',
      'accent-hover': '#a78bfa',
      // #150c26 stood here and measured 4.46:1 against the accent it is printed on — a fifth of
      // a step short of the 4.5 this file asserts, on 12.5px semibold text. Three shades darker
      // and it is 4.75. Nothing else on the face uses it, and the two are indistinguishable
      // side by side: it was always "near-black, not white" (`ui/styles.css §--accent-ink`).
      'accent-ink': '#110a1e',
      'accent-soft': '#8b5cf633',
      // 3.92:1 on this theme's paper — clear of the 3:1 a shape needs, so the accent itself.
      'accent-on-paper': '#8b5cf6',
      'accent-select': '#8b5cf64d',
      paper: '#f8f6f0',
      ink: '#16181d',
      danger: '#e05252',
      warn: '#e8b34a',
      ok: '#57b87b',
      success: '#62d6b5',
      wave: '#7c869b',
      'wave-played': '#8b5cf6',
      playhead: '#ffffff',
      'roll-row': '#191c22',
      'roll-note': '#6b7695'
    }
  },
  {
    id: 'daylight',
    name: 'Daylight',
    note: 'Paper-white chrome for a bright room.',
    colorScheme: 'light',
    tokens: {
      // The three surfaces run the other way round from the dark themes — the panel is the
      // LIGHTEST here, because a raised thing catches more light, not less.
      bg: '#e9ebf0',
      'bg-raised': '#f4f5f8',
      'bg-panel': '#ffffff',
      border: '#c2c8d4',
      text: '#181a20',
      'text-dim': '#565d6b',
      // A DARKER violet than the dark themes'. #8b5cf6 on white is 3.2:1 — fine as a fill
      // behind near-black ink, and not fine as the colour of the active chip's own text, which
      // is what the accent also is (`ui/styles.css §.chip.active`).
      accent: '#5b32c4',
      'accent-hover': '#4a27a8',
      'accent-ink': '#ffffff',
      'accent-soft': '#5b32c422',
      // 7.78:1 on white. The light theme's accent was already darkened for text and this inherits it.
      'accent-on-paper': '#5b32c4',
      'accent-select': '#5b32c440',
      paper: '#ffffff',
      ink: '#181a20',
      danger: '#b3261e',
      warn: '#7a5200',
      ok: '#1c6b3d',
      success: '#116353',
      wave: '#606a7e',
      'wave-played': '#5b32c4',
      // Black, not white: the playhead is drawn ON the light strip here.
      playhead: '#181a20',
      'roll-row': '#dfe3ea',
      'roll-note': '#6f7b96'
    }
  },
  {
    id: 'ember',
    name: 'Ember',
    note: 'Warm amber on a brown-black stage.',
    colorScheme: 'dark',
    tokens: {
      bg: '#1a1614',
      'bg-raised': '#241e1a',
      'bg-panel': '#2b2420',
      border: '#3d332c',
      text: '#f0e9e3',
      'text-dim': '#b3a698',
      accent: '#e8913c',
      'accent-hover': '#f5a95c',
      'accent-ink': '#22150a',
      'accent-soft': '#e8913c33',
      // #e8913c measures 2.24:1 on this paper — the worst of the four and the reason this token
      // exists. Darkened until it clears 3:1 with margin (4.44:1); still recognisably Ember's
      // orange, because the hue is unchanged and only the light is turned down.
      'accent-on-paper': '#a85f14',
      'accent-select': '#a85f1440',
      paper: '#f8f4ec',
      ink: '#1a1614',
      danger: '#e05252',
      warn: '#e8b34a',
      ok: '#57b87b',
      success: '#62d6b5',
      wave: '#9c8a78',
      'wave-played': '#e8913c',
      playhead: '#ffffff',
      'roll-row': '#1d1917',
      'roll-note': '#8a7462'
    }
  },
  {
    id: 'tide',
    name: 'Tide',
    note: 'Cool teal on deep navy.',
    colorScheme: 'dark',
    tokens: {
      bg: '#111a20',
      'bg-raised': '#17222b',
      'bg-panel': '#1c2933',
      border: '#293b47',
      text: '#e4edf2',
      'text-dim': '#93a6b2',
      accent: '#31b6c4',
      'accent-hover': '#5bd0dc',
      'accent-ink': '#04191d',
      'accent-soft': '#31b6c433',
      // #31b6c4 measures 2.28:1 on this paper. Same treatment as Ember: hue held, light down,
      // 5.64:1.
      'accent-on-paper': '#0e6d78',
      'accent-select': '#0e6d7840',
      paper: '#f4f8f8',
      ink: '#111a20',
      danger: '#e05252',
      warn: '#e8b34a',
      ok: '#57b87b',
      success: '#62d6b5',
      wave: '#6f8d9c',
      'wave-played': '#31b6c4',
      playhead: '#ffffff',
      'roll-row': '#141d24',
      'roll-note': '#5f8496'
    }
  }
];

export const DEFAULT_THEME_ID = 'midnight';

const THEME_KEY = 'riffsheet.theme';

/**
 * NOT IN `AppSettings`, and deliberately.
 *
 * A `.riffsheet` document carries the settings block it was saved with, and everything in that
 * block is applied to the store when the document is opened (`app/state.ts
 * §applyDocumentSettings`). A theme in there would mean opening somebody else's file repaints
 * your app — the exact class of leak that split the document's settings from the player's in
 * the first place. It is a preference about the PERSON, so it lives beside the tooltip switch
 * in its own key (`ui/tips.ts` does the same for the same reason).
 */
let current = DEFAULT_THEME_ID;

export function themeById(id: string): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

/** The theme in force. */
export function currentTheme(): Theme {
  return themeById(current);
}

/** What was stored, sanitised: an id nothing recognises is the default, not a broken screen. */
export function loadTheme(): string {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw && THEMES.some((theme) => theme.id === raw) ? raw : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/**
 * Put a palette on the page. Called once at boot, before anything is drawn, and on every switch.
 *
 * Idempotent and total: every token in the table is written every time, so switching from a
 * palette that declared a value to one that did not is impossible by construction.
 */
export function applyTheme(id: string): Theme {
  const theme = themeById(id);
  current = theme.id;
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--${token}`, value);
  }
  root.style.setProperty('color-scheme', theme.colorScheme);
  // Readable from a probe and from a stylesheet, without either having to parse a colour.
  root.setAttribute('data-theme', theme.id);
  return theme;
}

/**
 * Choose a theme: apply it, remember it, and tell the app to rebuild what CSS cannot reach.
 *
 * `redraw` is the canvases' half — see the header. It is a parameter rather than an import so
 * this module stays free of the app, and so a test can switch themes without a DOM full of one.
 */
export function setTheme(id: string, redraw?: () => void): Theme {
  const theme = applyTheme(id);
  try {
    localStorage.setItem(THEME_KEY, theme.id);
  } catch {
    /* private browsing or quota — the theme simply does not outlive the session */
  }
  redraw?.();
  return theme;
}

// ---------------------------------------------------------------------------
// Contrast, as arithmetic
// ---------------------------------------------------------------------------

/** `#rgb`, `#rrggbb` and `#rrggbbaa` (the alpha is ignored — see `contrastRatio`). */
export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const raw = hex.trim().replace(/^#/, '');
  const full =
    raw.length === 3
      ? raw.split('').map((c) => c + c).join('')
      : raw.length === 8
        ? raw.slice(0, 6)
        : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * WCAG contrast ratio, 1 to 21.
 *
 * Alpha is deliberately dropped rather than composited: the only token carrying any is
 * `--accent-soft`, which is a WASH behind existing text and never a text colour itself, so a
 * ratio for it would be a number about nothing.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** One readable pair, named so a failure says which one. */
export interface ContrastPair {
  what: string;
  fg: keyof ThemeTokens;
  bg: keyof ThemeTokens;
  min: number;
}

/**
 * WHAT EVERY THEME MUST BE ABLE TO SAY.
 *
 * The 4.5:1 rows are TEXT: body text on each of the three surfaces it is ever drawn on, the dim
 * text (which carries real sentences — the status rows, the tempo detail, the engine read-out —
 * and is not decoration), the ink on a filled accent, and the engraved page's own ink on its
 * paper. The 3:1 rows are non-text: the accent as a chip fill and a slider track, the waveform's
 * silhouette and the roll's note bodies, all of which are SHAPES against their ground.
 *
 * THE ACCENT IS TWO JOBS AND THIS TABLE IS WHERE THEY SEPARATED. `--accent` is the FILL — the
 * filled chip, the slider track, the played half of the strip — and is asked for 3:1, which is
 * the bar for a shape. `--accent-hover` is the accent AS TEXT: the version line in the brand
 * block, the lit end of the blend fader, a ticked row in a menu. Those were `--accent` and
 * measured 4.19:1 on the app background, which is a real reading failure on 10-12.5px type; they
 * are the lighter partner now (`ui/styles.css` §.brand-version, §.fader .end.active, §.menu-item
 * .on) and clear 6:1. Nothing about the app's colour changed — the lighter step already existed
 * and already meant "the same colour with the light turned up".
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { what: 'body text on the app background', fg: 'text', bg: 'bg', min: 4.5 },
  { what: 'body text on a raised surface', fg: 'text', bg: 'bg-raised', min: 4.5 },
  { what: 'body text on a panel', fg: 'text', bg: 'bg-panel', min: 4.5 },
  { what: 'dim text on the app background', fg: 'text-dim', bg: 'bg', min: 4.5 },
  { what: 'dim text on a raised surface', fg: 'text-dim', bg: 'bg-raised', min: 4.5 },
  { what: 'dim text on a panel', fg: 'text-dim', bg: 'bg-panel', min: 4.5 },
  { what: 'the ink on a filled accent', fg: 'accent-ink', bg: 'accent', min: 4.5 },
  { what: 'the accent as text on the app background', fg: 'accent-hover', bg: 'bg', min: 4.5 },
  { what: 'the accent as text on a panel', fg: 'accent-hover', bg: 'bg-panel', min: 4.5 },
  { what: "the engraving's ink on its paper", fg: 'ink', bg: 'paper', min: 4.5 },
  /*
   * THE SELECTION RING ON THE PAGE — the pair this table did not have, and the audit's finding 11.
   *
   * Every other row here is about the CHROME. The engraving is the one surface in the app with a
   * near-white ground in all four themes, and the only mark the app draws on it in its own accent
   * is the selection/hover ring — so the accent's legibility there was never asked about. It
   * turned out that two of the four themes could not answer: Ember's orange measured 2.24:1 on
   * its paper and Tide's cyan 2.28:1, against the 3:1 a shape needs. That is a highlight the
   * player has to hunt for however thick it is drawn, and it is half of "selection does not
   * really attract" (the other half being the face-scale weight collapse, fixed in `triview.ts`).
   *
   * 3:1 rather than 4.5:1 because a ring is a SHAPE, like the chip fill and the waveform above.
   */
  { what: 'the selection ring on the page', fg: 'accent-on-paper', bg: 'paper', min: 3 },
  { what: 'the accent as a fill on a panel', fg: 'accent', bg: 'bg-panel', min: 3 },
  { what: 'the waveform against its pane', fg: 'wave', bg: 'bg-raised', min: 3 },
  { what: 'the played waveform against its pane', fg: 'wave-played', bg: 'bg-raised', min: 3 },
  { what: "the roll's notes against its rows", fg: 'roll-note', bg: 'roll-row', min: 3 },
  { what: 'the border against the app background', fg: 'border', bg: 'bg', min: 1.2 }
];

/** Every pair that fails, for one theme. Empty means the palette is shippable. */
export function contrastFailures(
  theme: Theme
): Array<{ what: string; ratio: number; min: number }> {
  const failures: Array<{ what: string; ratio: number; min: number }> = [];
  for (const pair of CONTRAST_PAIRS) {
    const ratio = contrastRatio(theme.tokens[pair.fg], theme.tokens[pair.bg]);
    if (ratio + 0.005 < pair.min) failures.push({ what: pair.what, ratio, min: pair.min });
  }
  return failures;
}
