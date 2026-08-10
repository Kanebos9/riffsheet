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
