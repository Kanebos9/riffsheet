/**
 * alphaTab settings, in one place.
 *
 * Offline recipe (research §6.4 / §7): Bravura lives in public/font and alphaTab's Vite
 * plugin rewrites worker URLs, so we never touch a CDN. The optional alphaTab soundfont
 * is deliberately not shipped because playback is ExternalMedia and Riffsheet uses its
 * own credited sample sets.
 */

import * as alphaTab from '@coderline/alphatab';

/** Pinned in package.json; alphaTab does not expose its own version at runtime. */
export const ALPHATAB_VERSION = '1.8.4';

/**
 * alphaTab's own page padding, in px — the air it leaves around the engraving.
 *
 * Its default is the two-element `[35, 35]`, meaning 35 left-and-right and 35
 * top-and-bottom. We always write the four-element `[left, top, right, bottom]` form
 * instead, because the tri-view needs the LEFT one on its own (see `setLeftPadding`), and
 * a two-element array cannot say that. Writing 35 into the other three keeps everything
 * except the left edge exactly where alphaTab put it.
 *
 * It is NOT scaled by `display.scale`: alphaTab divides it by the scale during layout and
 * multiplies the finished coordinates back, so this number is real screen pixels whatever
 * the zoom. Measured in 1.8.4, not assumed.
 */
export const PAGE_PADDING_PX = 35;

/**
 * Set only the left padding, keeping the other three at alphaTab's default.
 *
 * Safe to call on a live `Settings`; follow it with `api.updateSettings()` and a render.
 */
export function setLeftPadding(settings: alphaTab.Settings, px: number): void {
  settings.display.padding = [
    Math.max(0, px),
    PAGE_PADDING_PX,
    PAGE_PADDING_PX,
    PAGE_PADDING_PX
  ];
}

export interface ViewSettings {
  /** Horizontal is the riff view: one continuous line, no wrapping. */
  horizontal: boolean;
  /** 0.6 .. 2.0 */
  scale: number;
  /**
   * Render only the partials that are on screen.
   *
   * MUST STAY FALSE, for the same family of reason as `useWorkers` below.
   *
   * With lazy loading on, `boundsLookup` only holds geometry for partials that have
   * actually been painted. Everything the tri-view publishes about WHERE something is —
   * `tickToContentX`, `contentXToTick`, the note-names row, the playhead — is derived from
   * those bounds, and the piano roll now borrows that same x-axis so the two strips line
   * up. Off screen there would be no bounds, so the roll would simply stop drawing past
   * the right edge of the sheet's viewport and the user would see a picture that empties
   * itself as they scroll.
   *
   * The cost of turning it off is small at riff length, and it is measured, not assumed:
   * the Phase 0 spike put a whole 32-bar render at 7–27 ms on the UI thread. A riff is
   * shorter than that.
   *
   * The print path was already forced to false for a third, separate reason (see
   * `createPrintSettings`), so nothing in the app asks for it any more.
   */
  lazyLoading: boolean;
  /**
   * Render in a worker instead of on the UI thread.
   *
   * MUST STAY FALSE. In the JUCE shell (WKWebView, `juce://` scheme) a worker-backed
   * renderer produces **nothing at all, silently**: alphaTab initialises, the font loads,
   * the cursor markup appears, and no SVG is ever emitted — no error, no console output,
   * no `renderFinished`. Measured in the shipping plugin on macOS 26.4 / JUCE 8.0.13.
   * The worker script itself is fine over that scheme (it fetches 200 and starts as a
   * module worker), so the fault is in the round trip, not in loading it.
   *
   * The cost of turning it off is small at riff length: the Phase 0 spike measured whole
   * renders at 7–27 ms for 8–32 bars, on the UI thread. The print path was already
   * forced to false for a different reason (see below), so this also removes the
   * "only one worker-backed instance per page" landmine entirely.
   */
  useWorkers: boolean;
  player: 'off' | 'external-media';
  /**
   * Reserve the staff<->tab gap for the note-names row.
   *
   * True whenever the names row is on screen; false for print and for a names-off view, so
   * hiding the names closes the hole rather than leaving one.
   */
  namesGap: boolean;
  /**
   * Empty space kept at the LEFT of the engraving, in px.
   *
   * This is alphaTab's `display.padding[0]`. The default here is alphaTab's own 35, which
   * is what the print path wants. The tri-view overrides it so that the sheet reserves the
   * same left-hand column the piano roll uses for its pitch labels — see
   * `LEFT_INSET_PX` in view/triview.ts.
   */
  leftPadPx: number;
}

export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  horizontal: true,
  scale: 1.0,
  lazyLoading: false,
  useWorkers: false,
  player: 'external-media',
  namesGap: true,
  leftPadPx: PAGE_PADDING_PX
};

/**
 * Extra air above the tablature staff, in px — the room the note-names row lives in.
 *
 * The row was printed on top of the tab (user-reported; the pre-fix screenshot shows a
 * fret digit and a note name sharing pixels). Two causes, fixed here and in triview.ts:
 *
 *   1. alphaTab's staff padding defaults to 0, leaving only the staves' own overflow — a
 *      measured 48px between the bottom of the notation staff and the top tab line. A 13px
 *      label, the 10px the fret digits rise, and the room a chord stack needs above the
 *      anchor do not fit in that with anything to spare.
 *   2. Tab fret digits are centred ON the top tab line, so their boxes reach 10px above
 *      the y `BarBounds.visualBounds` calls the top of the tab. A label placed flush to
 *      that y is already on a digit. triview.ts clears TAB_DIGIT_RISE for that half.
 *
 * ONLY `notationStaffPaddingTop` is set here, and that is a measurement, not a preference.
 * It is the top padding of every render staff except the first, which — with one alphaTab
 * `Staff` showing both notation and tab — means the tab staff and nothing else, because
 * effect bands (the tempo marker, dynamics) attach to a staff rather than becoming staves
 * of their own. Its apparent mirror `notationStaffPaddingBottom` was tried at 14 and at 40
 * in 1.8.4 and moved the tab by exactly 0px both times, so it is left alone rather than
 * assigned a number that does nothing and reads as if it did something.
 */
export const STAFF_TAB_GAP = 12;

/**
 * The gap between staves of a MULTI-STAVE score, in px. Bigger, and the reason is content.
 *
 * On one staff showing notation and tab, the only thing hanging below the notation staff is a
 * stem or a beam on a single voice, and alphaTab's own 48px of overflow absorbs it. A GRAND
 * STAFF is a different picture: the treble staff carries the whole right hand, so deep beams,
 * ledger lines below the staff and the tails of a chord all reach down toward the bass staff at
 * once, and they were reported bleeding into it. Grand + tab is the same problem twice over.
 *
 * A FIXED, SAFELY LARGER NUMBER rather than a per-system measurement. alphaTab decides staff
 * distance during layout and exposes it only as these padding settings — there is no callback
 * that says "this system needs 9 more px" and no way to feed one back in without re-engraving
 * the whole score to measure it, which is a render per render. `notationStaffPaddingTop` applies
 * to every main notation stave except the first, so one number widens every gap in the system,
 * which is what "the staves must not touch" wants anyway.
 *
 * The cost is vertical space on a score that did not need it. That is the right way round: a
 * beam through a bass clef is a misreading, extra white space is a preference.
 */
export const MULTI_STAFF_GAP = 26;

/**
 * Apply the staff<->staff gap for the current names state. Safe to call on a live Settings.
 *
 * `multiStaff` is true when the track renders more than one stave — a grand staff, or a grand
 * staff plus tab. The two reasons to open the gap are independent (a row to fit in it; content
 * that would otherwise collide), so the larger of the two wins rather than one overriding the
 * other: turning the note names off must not close a gap that exists to keep beams off a clef.
 */
export function applyStaffTabGap(
  settings: alphaTab.Settings,
  namesGap: boolean,
  multiStaff = false
): void {
  // 0 is alphaTab's own default, which still leaves the 48px of overflow — plenty for two
  // staves to read as two once there is no row to fit between them.
  settings.display.notationStaffPaddingTop = Math.max(
    namesGap ? STAFF_TAB_GAP : 0,
    multiStaff ? MULTI_STAFF_GAP : 0
  );
}

/**
 * Where the offline assets live, resolved against the document rather than the script.
 *
 * This matters more than it looks. The alphaTab Vite plugin copies Bravura to
 * `dist/font/`, but alphaTab's own default resolves `fontDirectory` relative to the
 * *script* location — which is `dist/assets/` — so it asks for `assets/font/Bravura.woff2`
 * and 404s. Pinning it against `document.baseURI` also makes it correct under a JUCE
 * custom URL scheme and under file://, where script-relative resolution is unreliable.
 */
export const FONT_DIRECTORY = new URL('font/', document.baseURI).href;

export function createSettings(view: Partial<ViewSettings> = {}): alphaTab.Settings {
  const v = { ...DEFAULT_VIEW_SETTINGS, ...view };
  const settings = new alphaTab.Settings();

  settings.core.engine = 'svg';
  settings.core.fontDirectory = FONT_DIRECTORY;
  // Required for BeatBounds.notes — without it there is no per-note geometry, so no
  // note-name row anchoring and no getNoteAtPos.
  settings.core.includeNoteBounds = true;
  settings.core.enableLazyLoading = v.lazyLoading;
  settings.core.useWorkers = v.useWorkers;

  settings.display.layoutMode = v.horizontal
    ? alphaTab.LayoutMode.Horizontal
    : alphaTab.LayoutMode.Page;
  // Default lets the per-staff showStandardNotation/showTablature flags decide, which is
  // what we set in build.ts. ScoreTab would force both even for a staff that wants one.
  settings.display.staveProfile = alphaTab.StaveProfile.Default;
  settings.display.scale = v.scale;
  applyStaffTabGap(settings, v.namesGap);
  setLeftPadding(settings, v.leftPadPx);

  // Hide the chrome a riff sheet does not need. EffectDynamics matters most: alphaTab
  // prints a forte marking under bar 1 by default, which lands exactly where the
  // note-names row sits. We never detect dynamics anyway, so the marking would be a lie.
  settings.notation.elements.set(alphaTab.NotationElement.EffectDynamics, false);
  settings.notation.elements.set(alphaTab.NotationElement.ScoreTitle, false);
  settings.notation.elements.set(alphaTab.NotationElement.ScoreSubTitle, false);
  settings.notation.elements.set(alphaTab.NotationElement.ScoreArtist, false);
  settings.notation.elements.set(alphaTab.NotationElement.ScoreAlbum, false);
  settings.notation.elements.set(alphaTab.NotationElement.ScoreWords, false);
  settings.notation.elements.set(alphaTab.NotationElement.ScoreMusic, false);
  settings.notation.elements.set(alphaTab.NotationElement.ScoreWordsAndMusic, false);
  settings.notation.elements.set(alphaTab.NotationElement.ScoreCopyright, false);

  if (v.player === 'off') {
    settings.player.playerMode = alphaTab.PlayerMode.Disabled;
  } else {
    // Our transport is the clock; alphaTab follows it. See audio/transport.ts.
    settings.player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia;
    settings.player.enableCursor = true;
    settings.player.enableAnimatedBeatCursor = true;
    settings.player.scrollMode = alphaTab.ScrollMode.Continuous;
  }

  return settings;
}

/**
 * Print instance settings: paginated, nothing lazy, no player, NO WORKER.
 *
 * `useWorkers: false` is load-bearing, not a tidiness choice. The Phase 0 spike found that
 * only ONE worker-backed alphaTab instance per page ever renders — a second one never fires
 * postRenderFinished and hangs forever. Since the print path is by definition a second,
 * hidden instance alongside the live tri-view, it must not ask for a worker. The same spike
 * proves a worker-free second instance renders correctly.
 *
 * `lazyLoading: false` is equally mandatory: partials are never appended to a hidden host,
 * so with lazy loading on the print document comes out empty.
 */
export function createPrintSettings(scale = 0.8): alphaTab.Settings {
  const settings = createSettings({
    horizontal: false,
    scale,
    lazyLoading: false,
    useWorkers: false,
    player: 'off',
    // The printed sheet carries no note-names row, so it must not carry the gap either.
    namesGap: false
  });
  settings.display.justifyLastSystem = false;
  settings.display.stretchForce = 0.8;
  return settings;
}
