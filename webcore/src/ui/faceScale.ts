/**
 * THE ONE-PROPORTION LAW (G1) — the whole face is drawn at ONE size and scaled by ONE number.
 *
 * ==========================================================================================
 * THE LAW
 * ==========================================================================================
 *
 * The face — every row of chrome, every pane, every menu, every canvas — is DESIGNED at a
 * single base size, {@link FACE_BASE_W} x {@link FACE_BASE_H}. It is never re-flowed, never
 * re-laddered and never re-broken by a breakpoint. A window smaller than the base gets the same
 * picture, smaller; a window larger than the base gets the same picture with the SURPLUS given
 * to the flexible gaps and to the panes, which is where surplus belongs — nobody drags a plugin
 * window out to get bigger buttons, they do it to see more music.
 *
 *     scale = min(1, viewportW / FACE_BASE_W, viewportH / FACE_BASE_H)
 *
 * THE INVARIANT THAT MAKES EVERYTHING ELSE FREE, and it is worth stating as arithmetic because
 * every no-clip claim in the app now rests on it:
 *
 *     logicalW = viewportW / scale  >=  FACE_BASE_W       (for every viewport size)
 *     logicalH = viewportH / scale  >=  FACE_BASE_H
 *
 *   - if scale is 1, both ratios were >= 1, so logicalW = viewportW >= FACE_BASE_W;
 *   - if scale is viewportW / FACE_BASE_W, logicalW is exactly FACE_BASE_W and logicalH is larger;
 *   - if scale is viewportH / FACE_BASE_H, logicalH is exactly FACE_BASE_H and logicalW is larger.
 *
 * So THE LAYOUT NEVER SEES A VIEWPORT SMALLER THAN THE ONE IT WAS DESIGNED FOR. A row that fits
 * at the base size fits at every window size there is, down to REAPER's 360x280 and below it.
 * That is why the entire responsive ladder could be DELETED rather than disabled: there is no
 * longer any width at which the design is under pressure, so there is nothing for a breakpoint
 * to react to.
 *
 * NO LOWER CLAMP, DELIBERATELY. The shell REQUESTS a minimum window size, and its own header
 * says a host may refuse (`shell/Source/ui/PluginEditor.h:41` — REAPER can and does clip a
 * plugin below its stated minimum). A clamp would be the one thing that breaks the invariant
 * above: clamped at 0.5, a 400px-wide host would hand the layout 800 logical px, less than the
 * base, and the rows would overflow again. So below the comfortable floor the face keeps
 * shrinking and stays WHOLE — small type is a hostile host's fault and is legible again the
 * moment the window is dragged out; a control off the edge of the window is ours and is not.
 *
 * ==========================================================================================
 * THE MECHANISM: `zoom`, ON THE BODY, ONCE
 * ==========================================================================================
 *
 * `zoom` and not `transform: scale()`. A transform leaves the element laid out at its old size,
 * so the page keeps a scrollbar for space that is not occupied and layout percentages resolve
 * against the wrong box. `zoom` scales LAYOUT as well as paint: the body's containing block
 * becomes `viewport / scale` logical pixels, `height: 100%` still fills the window exactly, and
 * `position: fixed` children (the settings overlay, the sheet menu, toasts, tips) scale and
 * place themselves in the same logical space. One declaration covers the app and every portal
 * mounted beside it, which is what "ONE root factor" has to mean to be worth anything.
 *
 * ON THE BODY rather than on `#app`, because the menus, dialogs and popovers are mounted under
 * `document.body`, not under `#app` — scaling `#app` would leave every popover at a different
 * size from the face that opened it.
 *
 * ==========================================================================================
 * THE PRICE, AND THE ONE PLACE IT IS PAID: VISUAL vs LOGICAL PIXELS
 * ==========================================================================================
 *
 * Under `zoom`, a page has two coordinate systems and the DOM reports both without saying which:
 *
 *   VISUAL (device-side, what the user's finger is in):
 *       `PointerEvent.clientX/clientY`, `getBoundingClientRect()`, `window.innerWidth/innerHeight`,
 *       `elementFromPoint` arguments.
 *   LOGICAL (the design's own pixels, what every stylesheet number and every piece of engraved
 *   or painted geometry is in):
 *       `clientWidth/clientHeight`, `offsetWidth`, `scrollLeft/scrollTop`, `scrollWidth`,
 *       computed styles, alphaTab's bounds lookup, the roll's painted rects, canvas drawing units.
 *
 * Mixing them is invisible at scale 1 and wrong at every other scale — which is exactly why the
 * OLD ladder (`zoom` on `#app` and on the two bars) shipped hit-testing that drifted at the
 * plugin sizes people actually use, and why this had to land before any gesture or hit-test fix
 * could be believed. So there is ONE conversion in the app, {@link logicalPoint}, and every
 * surface that turns a pointer into geometry goes through it.
 *
 * ==========================================================================================
 * WHAT THIS SCALE IS NOT
 * ==========================================================================================
 *
 * It is not alphaTab's `display.scale` and it is not the roll's time zoom. Those two are the
 * MUSIC's magnification, which belongs to the player: pinching the sheet still re-engraves at a
 * new `display.scale` and pinching the roll still changes seconds-per-pixel, at every face
 * scale, with unchanged semantics. The law scales the FACE.
 *
 * The engraving stays sharp with no help from here because alphaTab renders SVG
 * (`view/atSettings.ts` sets `core.engine = 'svg'`), and vector art under `zoom` is rasterised
 * at device resolution. The two RASTER surfaces — the waveform strip and the piano roll — are
 * the ones that would go soft, and {@link fitCanvasBackingStore} is what keeps them crisp: their
 * backing stores are sized from the RENDERED size (logical x face scale) times the device pixel
 * ratio, so a canvas is drawn at the resolution it is actually displayed at.
 */

/**
 * THE DESIGN SIZE. Every stylesheet number in this app is a number at THIS window size.
 *
 * MEASURED, not chosen — the three rows of chrome are the constraint, because they are the only
 * things in the face that cannot be made shorter by shrinking a pane. Measured with every
 * drop-down cut to the option it is SHOWING (`ui/dom.ts §fitSelects`), nothing shrunk, nothing
 * dropped and nothing wrapped, at a viewport wide enough that no row was under pressure:
 *
 *     row                 needs   what is in it at its widest
 *     -----------------   -----   -------------------------------------------------------------
 *     notation toolbar     1299   label, part, clef, key, quantize | tab, frets, "around fret",
 *                                 custom tuning, strings, capo  (the custom-tuning case)
 *     transport            1238   play, stop, undo/redo, loop, clock, fader at its 182px floor,
 *                                 sound picker, tempo source with its detail sentence
 *     header               1190   brand, a 172px take name, Main menu, view chips, engine chip,
 *                                 Export, gear
 *
 * 1320 is the widest of the three with a margin, and it is asserted rather than trusted:
 * `scripts/verify.mjs` sweeps all three rows for clipping and for ellipsis at the base size and
 * below it, and those checks fail if this number is ever too small for the design.
 *
 * THE TAKE'S NAME GETS THE MARGIN, and that is deliberate. The header's other contents come to
 * about 1010px with the engine chip up and 896 without it, so a name may run to roughly 310–420
 * logical pixels — 45 to 60 characters — before it has eaten the spacer and started pushing the
 * row. That is why `fitHeaderName()` could be deleted rather than merely retired: the old rule
 * dropped the name WHOLE at 900px of window, where it had 36px for 161px of text, and the law
 * gives it ten times that at every window size there is.
 *
 * The height is the shorter constraint: three rows of chrome (about 132px), the waveform strip,
 * the roll at its default height, the horizontal scroller and a sheet pane worth looking at come
 * to about 550px, so 700 leaves the sheet real room. In practice the width is what binds — at
 * 900x600 the ratios are 0.68 and 0.86 — which is the right way round for a plugin window that
 * is short before it is narrow.
 *
 * Both numbers are the size the shell REQUESTS from the host. Neither is a size any host is
 * obliged to grant, and nothing here depends on one being granted.
 */
export const FACE_BASE_W = 1320;
export const FACE_BASE_H = 700;

/** The CSS custom property the stylesheet reads. Declared on `:root`, applied on `body`. */
const FACE_SCALE_PROP = '--face-scale';

/**
 * The event fired on `window` after the face scale has actually changed.
 *
 * Only the raster surfaces need it: their backing stores are sized in DEVICE pixels, so a face
 * that got smaller has left them over-sized and a face that got larger has left them soft. The
 * chrome needs nothing — it is CSS, and CSS has already moved.
 */
export const FACE_SCALE_EVENT = 'riffsheet-face-scale';

let scale = 1;
let installed = false;

/**
 * THE ONE ROOT FACTOR, as a number.
 *
 * Read it rather than measuring an element's `rect.width / offsetWidth`: `offsetWidth` is an
 * integer, so the measured ratio carries a rounding error that grows into a visible offset on a
 * long canvas, and the value here is the exact one the stylesheet was given.
 */
export function faceScale(): number {
  return scale;
}

/** The viewport the LAYOUT sees, in logical pixels. Never smaller than the base size. */
export function faceViewport(): { width: number; height: number } {
  return { width: window.innerWidth / scale, height: window.innerHeight / scale };
}

/** A visual (device-side) length — a pointer delta, a hit radius — in logical pixels. */
export function toLogical(px: number): number {
  return px / scale;
}

/** A logical length in visual pixels. The inverse of {@link toLogical}. */
export function toVisual(px: number): number {
  return px * scale;
}

/**
 * A POINTER, IN THE HOST'S OWN PIXELS. The one conversion in the app.
 *
 * `clientX/clientY` are visual and `getBoundingClientRect()` is visual, so their difference is a
 * visual offset — and every geometry it is about to be compared against (a painted rect, an
 * engraved notehead, a gutter width, a ruler height) is logical. Dividing by the face scale is
 * the whole of the correction, and doing it in one function is what stops the next surface from
 * forgetting.
 */
export function logicalPoint(
  host: Element,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const rect = host.getBoundingClientRect();
  return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
}

/** The x half of {@link logicalPoint}, for the surfaces that only have an x. */
export function logicalX(host: Element, clientX: number): number {
  return (clientX - host.getBoundingClientRect().left) / scale;
}

/**
 * An element's box in LOGICAL pixels, measured from the logical viewport's origin.
 *
 * For the popovers and menus that are `position: fixed`: under `zoom` a fixed element's `left`
 * and `top` are logical, so a menu placed at a raw `clientX` lands at `clientX / scale` visual
 * pixels — off by the reciprocal of the scale, and further off the smaller the window is.
 */
export function logicalRect(el: Element): { left: number; top: number; width: number; height: number } {
  const r = el.getBoundingClientRect();
  return { left: r.left / scale, top: r.top / scale, width: r.width / scale, height: r.height / scale };
}

/**
 * SIZE A CANVAS'S BACKING STORE FOR THE FACE IT IS DRAWN ON, and return the drawing transform.
 *
 * A canvas is displayed at `logical x faceScale` visual pixels and rasterised at
 * `visual x devicePixelRatio` device pixels, so the backing store has to be the product of all
 * three or the picture is resampled — soft at a small face scale, and blocky on a Retina panel
 * where the old `clientWidth x dpr` was already only half of what the screen could show.
 *
 * The returned number is what the caller passes to `ctx.setTransform(k, 0, 0, k, 0, 0)`, so all
 * painting code keeps drawing in LOGICAL pixels and none of it has to know this exists.
 *
 * ONE factor for both axes, and the store is rounded from it rather than each axis being rounded
 * on its own: independent rounding puts up to half a device pixel of anisotropy into a canvas
 * that is then hit-tested against un-rounded geometry.
 */
export function fitCanvasBackingStore(
  canvas: HTMLCanvasElement,
  logicalW: number = canvas.clientWidth,
  logicalH: number = canvas.clientHeight
): number {
  const k = scale * (window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(logicalW * k));
  const h = Math.max(1, Math.round(logicalH * k));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return k;
}

/** The law, as arithmetic. Exported so the harness can assert the same expression the app runs. */
export function faceScaleFor(viewportW: number, viewportH: number): number {
  if (!(viewportW > 0) || !(viewportH > 0)) return 1;
  return Math.min(1, viewportW / FACE_BASE_W, viewportH / FACE_BASE_H);
}

/**
 * Install the law: compute the scale, write it, and keep it true as the window moves.
 *
 * Coalesced onto one animation frame — a window drag delivers a resize per frame and this writes
 * a style that forces layout — and idempotent, so a second call cannot install a second listener.
 *
 * `visualViewport` is listened to as well as `window`: in a WKWebView the outer window can be
 * told about a resize that the visual viewport has not caught up with yet, and the scale must
 * follow the box the page is actually painted into.
 */
export function installFaceScale(): void {
  if (installed) return;
  installed = true;

  let pending = 0;
  const apply = (): void => {
    pending = 0;
    const next = faceScaleFor(window.innerWidth, window.innerHeight);
    if (Math.abs(next - scale) < 0.0005) return;
    scale = next;
    document.documentElement.style.setProperty(FACE_SCALE_PROP, String(next));
    window.dispatchEvent(new CustomEvent(FACE_SCALE_EVENT, { detail: { scale: next } }));
  };
  const schedule = (): void => {
    if (pending) return;
    pending = requestAnimationFrame(apply);
  };

  // The first one is immediate rather than scheduled: the app is about to measure itself, and
  // a first frame drawn at the wrong scale is a first frame of wrong canvas backing stores.
  scale = faceScaleFor(window.innerWidth, window.innerHeight);
  document.documentElement.style.setProperty(FACE_SCALE_PROP, String(scale));

  window.addEventListener('resize', schedule, { passive: true });
  window.visualViewport?.addEventListener('resize', schedule, { passive: true });
  // A window dragged between a Retina and a non-Retina display changes the device pixel ratio
  // without changing its size, and the canvases are the ones that care.
  window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`)?.addEventListener?.(
    'change',
    () => window.dispatchEvent(new CustomEvent(FACE_SCALE_EVENT, { detail: { scale } }))
  );
}
