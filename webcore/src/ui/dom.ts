/**
 * A ~60-line stand-in for a framework.
 *
 * We render alphaTab, an absolutely-positioned overlay and a 60fps playhead; a virtual
 * DOM would be in the way of all three. What we actually need is (a) terse element
 * construction and (b) a subscribable store. That is all this is.
 */

type Child = Node | string | number | false | null | undefined;

export interface ElProps {
  class?: string;
  id?: string;
  title?: string;
  text?: string;
  html?: string;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  [key: string]: unknown;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (typeof value === 'boolean') {
      if (value) node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

/**
 * A `<select>` AS WIDE AS THE WORDS IN IT, AND NOT ONE PIXEL WIDER.
 *
 * Here rather than in `ui/app.ts` because two files need it and a second implementation is how two
 * things that must behave identically stop behaving identically. `App.fitTopBars` fits the three
 * bars of chrome above the sheet; `settings.ts §soundPicker` fits its own box, because that picker
 * redraws itself whenever a sample set finishes loading and would otherwise throw away the width
 * the bar had just given it.
 *
 * THE PROBLEM IT SOLVES. A `<select>`'s intrinsic width is its LONGEST OPTION, not the one it is
 * showing, so a bar of them reserves a great deal of nothing — measured on the notation bar, about
 * 330px — and then has to shrink, and what shrinking takes is the TEXT. Sizing to the shown option
 * gives the row that width back and puts a floor under it at the same time.
 *
 * THE ARROW IS OURS, WHICH IS WHAT MAKES THIS A MEASUREMENT. `ui/styles.css` draws the chevron
 * inside `padding-right` (`SELECT_ARROW_PX`), so the frame is the element's own box model and there
 * is nothing left to estimate. With the PLATFORM arrow the reserve is not knowable from the page:
 * the engine picks a glyph region of its own and does not scale it with the `zoom` these bars carry,
 * which is how a box sized with 23 CSS px of allowance arrived with 14 visual px of it and clipped.
 *
 * Two passes rather than one, deliberately: clear every width, read every width, write every width.
 * Interleaving them is one forced layout per control instead of one for the whole bar.
 *
 * Detached elements are skipped — `getComputedStyle` on one answers with defaults rather than with
 * this page's font, and a width computed from that is a guess.
 */
let textMeasure: CanvasRenderingContext2D | null = null;

export function fitSelects(boxes: HTMLSelectElement[]): void {
  const ctx = (textMeasure ??= document.createElement('canvas').getContext('2d'));
  if (!ctx) return;
  const live = boxes.filter((select) => select.isConnected);
  for (const select of live) select.style.width = '';
  const wanted = live.map((select) => {
    const cs = getComputedStyle(select);
    ctx.font = cs.font || `${cs.fontSize} ${cs.fontFamily}`;
    const frame =
      parseFloat(cs.paddingLeft) +
      parseFloat(cs.paddingRight) +
      parseFloat(cs.borderLeftWidth) +
      parseFloat(cs.borderRightWidth);
    const shown = select.options[select.selectedIndex]?.text ?? '';
    // The two-pixel allowance is for the difference between a canvas measurement and the engine's
    // own layout of the same string; with no ellipsis to fall back on, a box one pixel short does
    // not truncate politely, it clips.
    return Math.ceil(ctx.measureText(shown).width + frame) + 2;
  });
  live.forEach((select, i) => {
    select.style.width = `${wanted[i]}px`;
  });
}

/** Replace an element's children in one go. */
export function replace(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type Listener<T> = (state: T, previous: T) => void;

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: Listener<T>): () => void;
  /** Subscribe to one slice; only fires when the slice's identity changes. */
  watch<S>(select: (state: T) => S, listener: (value: S, previous: S) => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener<T>>();

  return {
    get: () => state,
    set(patch) {
      const previous = state;
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const l of [...listeners]) l(state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    watch(select, listener) {
      let current = select(state);
      return this.subscribe((next) => {
        const value = select(next);
        if (!Object.is(value, current)) {
          const previous = current;
          current = value;
          listener(value, previous);
        }
      });
    }
  };
}

/** Trailing-edge debounce. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: number | undefined;
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  };
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
