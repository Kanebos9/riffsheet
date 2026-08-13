/**
 * THE GESTURE RECORDER (D2) — the owner's real trackpad, written to a file we can replay.
 *
 * ==========================================================================================
 * WHY THIS SHIPS RATHER THAN LIVING IN A PROBE
 * ==========================================================================================
 *
 * Every claim this repo makes about WKWebView's trackpad behaviour is currently a claim about a
 * SHAPE. `scripts/gesture-test.ts` replays two fixtures through the one state machine that
 * decides (`view/gesture.ts`), and it is honest about which is which: `roll-ctrlwheel-chromium`
 * is `provenance: "captured"` — a real stream, recorded off a real browser — and
 * `roll-webkit-both-roads` is `provenance: "constructed"`, written from WebKit's `GestureEvent`
 * contract because no headless engine in this repository's CI has ever implemented `GestureEvent`
 * at all. Chromium cannot produce the event we most need to be right about.
 *
 * The only machine that can is the owner's, running the real plugin in a real host. So the
 * recorder stops being a snippet pasted into a console — which requires a devtools window that a
 * plugin webview does not have — and becomes a thing the shipped build can be asked to do.
 *
 * ==========================================================================================
 * THE ONE-STEP RECIPE, FOR THE OWNER
 * ==========================================================================================
 *
 *   1. Turn it on. Either open the app with `?gesturerec=1` on the URL, or — in the plugin,
 *      where there is no address bar — set the flag once from anywhere that can run one line of
 *      script and it survives restarts:
 *
 *          localStorage.setItem('riffsheet.gestureRecorder', '1')
 *
 *      The recorder announces itself in the console on every boot while the flag is set, so
 *      "did I leave it on" is answerable without looking.
 *
 *   2. PINCH. Two fingers on the trackpad, over the sheet or over the roll, for a few seconds.
 *      Do the thing that is wrong: the pinch that does nothing over the engraved music, the one
 *      that works over the empty paper below it. Both go into the same trace, in order, with the
 *      element each one landed on.
 *
 *   3. Save it. `window.__RSGT__.save()` writes `gesture-trace-<n>.json` through the app's own
 *      export door — the same one the PDF and the MIDI use, so it lands wherever exports land
 *      and needs no download permission. With no export bridge (a plain browser) it falls back
 *      to a normal download, and if even that is refused the JSON is on the clipboard and in the
 *      console.
 *
 *   4. Drop the file into `webcore/scripts/fixtures/gesture/` and add one line to `TRACES` in
 *      `scripts/gesture-test.ts`. Nothing else changes: the file is already in the fixture
 *      format, `provenance` already says `captured`, and the test reads that field.
 *
 * `window.__RSGT__.events` is the live array if you would rather copy it by hand;
 * `.clear()` starts a fresh take; `.count()` is the honest answer to "is it recording".
 *
 * ==========================================================================================
 * WHAT IT RECORDS, AND WHY EACH FIELD IS THERE
 * ==========================================================================================
 *
 * The fixture shape, exactly — `PinchInput` plus the provenance fields the test asserts on:
 *
 *   kind/atMs/delta/deltaMode/scale/ctrlKey/metaKey/altKey   what the LAW reads (view/gesture.ts).
 *   isTrusted        the difference between a hardware capture and a synthesised stream. A
 *                    recorder that could not tell them apart would let a probe's own dispatches
 *                    be filed as evidence about a trackpad.
 *   cancelable       whether the handler was even ALLOWED to swallow it. A passive listener
 *                    cannot, and "the pinch does nothing" has that as one of its candidate causes.
 *   defaultPrevented patched in on the way back UP the tree, so it says what the app's handlers
 *                    actually did rather than what they were about to do.
 *   phase            'capture' or 'bubble' — which side of the tree the event was seen on. This
 *                    is the P4 question stated as data: if the capture pass sees an event that
 *                    the bubble pass never does, something between the two swallowed it.
 *   target/path      the element under the fingers and the first few ancestors, so "over the
 *                    engraving" and "over the empty paper" are distinguishable in the file
 *                    instead of being remembered.
 *
 * CAPTURE PHASE, ON `window`, so the record exists before any handler runs and cannot be
 * suppressed by one. PASSIVE, so the recorder itself can never change what the app does with a
 * gesture — an observer that alters the thing it observes is not evidence.
 */

/** How many events one trace may hold. A few seconds of pinching is a few hundred. */
const MAX_EVENTS = 4000;

/** The events worth recording: both pinch roads, and the scroll that is not one. */
const KINDS = ['wheel', 'gesturestart', 'gesturechange', 'gestureend'] as const;

export interface RecordedGestureEvent {
  kind: string;
  atMs: number;
  delta?: number;
  deltaMode?: number;
  scale?: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isTrusted: boolean;
  cancelable: boolean;
  defaultPrevented: boolean | null;
  phase: 'capture' | 'bubble';
  target: string | null;
  path: string[];
}

export interface GestureTrace {
  name: string;
  /** Always 'captured' here — this file only ever writes real, delivered events. */
  provenance: 'captured';
  engine: string;
  note: string;
  events: RecordedGestureEvent[];
}

export interface GestureRecorder {
  events: RecordedGestureEvent[];
  count(): number;
  clear(): void;
  /** The finished fixture, as a JSON string. */
  json(name?: string): string;
  /** Write it out. Resolves with where it went, for the console. */
  save(name?: string): Promise<string>;
}

/** The app's own export door, when there is one. Set by `installGestureRecorder`. */
type ExportFile = (name: string, bytes: Uint8Array, mimeType?: string) => Promise<unknown>;

declare global {
  interface Window {
    __RSGT__?: GestureRecorder;
  }
}

const FLAG_KEY = 'riffsheet.gestureRecorder';
const URL_PARAM = 'gesturerec';

/**
 * Is the recorder wanted? A URL parameter for a browser, a localStorage flag for the plugin.
 *
 * The URL parameter also WRITES the flag, so `?gesturerec=1` once in a browser is the same
 * durable "on" that the plugin needs — and `?gesturerec=0` is how it goes off again without
 * anybody having to remember the key.
 */
export function gestureRecorderEnabled(): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(FLAG_KEY);
  } catch {
    /* private mode, or a webview with no storage: the URL is still an answer */
  }
  let param: string | null = null;
  try {
    param = new URL(window.location.href).searchParams.get(URL_PARAM);
  } catch {
    /* an opaque or non-standard URL (juce://) that cannot be parsed: fall back to storage */
  }
  if (param !== null) {
    const on = param !== '0' && param !== 'false';
    try {
      if (on) localStorage.setItem(FLAG_KEY, '1');
      else localStorage.removeItem(FLAG_KEY);
    } catch {
      /* nothing to persist to; the parameter still governs this session */
    }
    return on;
  }
  return stored === '1' || stored === 'true';
}

let installed = false;

/**
 * Install the recorder if the flag is set. Idempotent, and a no-op when it is not.
 *
 * `exportFile` is the app's native export door; it is optional so that this module has no
 * dependency on the bridge and can be exercised in a plain page.
 */
export function installGestureRecorder(exportFile?: ExportFile): GestureRecorder | null {
  if (installed) return window.__RSGT__ ?? null;
  if (!gestureRecorderEnabled()) return null;
  installed = true;

  const events: RecordedGestureEvent[] = [];
  let saved = 0;

  const describe = (node: EventTarget | null): string | null => {
    const el = node as Element | null;
    if (!el || typeof el.tagName !== 'string') return null;
    const cls = typeof el.className === 'string' ? el.className : '';
    return `${el.tagName.toLowerCase()}${cls ? `.${cls.trim().split(/\s+/).join('.')}` : ''}`.slice(0, 80);
  };

  const record = (e: Event, phase: 'capture' | 'bubble'): void => {
    const g = e as WheelEvent & { scale?: number };
    if (phase === 'bubble') {
      // The SAME event, coming back up. Patch the one field that could not be known on the way
      // down rather than filing a second row for one gesture.
      for (let i = events.length - 1; i >= 0 && i > events.length - 8; i--) {
        if (events[i].kind === e.type && events[i].atMs === roundMs(e.timeStamp)) {
          events[i].defaultPrevented = e.defaultPrevented;
          return;
        }
      }
      return;
    }
    if (events.length >= MAX_EVENTS) return;
    const path = (typeof e.composedPath === 'function' ? e.composedPath() : [])
      .slice(0, 5)
      .map(describe)
      .filter((s): s is string => !!s);
    events.push({
      kind: e.type,
      atMs: roundMs(e.timeStamp),
      ...(e.type === 'wheel' ? { delta: g.deltaY || g.deltaX, deltaMode: g.deltaMode } : {}),
      ...(typeof g.scale === 'number' ? { scale: g.scale } : {}),
      ctrlKey: !!g.ctrlKey,
      metaKey: !!g.metaKey,
      altKey: !!g.altKey,
      isTrusted: e.isTrusted,
      cancelable: e.cancelable,
      // Filled in on the way back up, and left null when the event never got there — which is
      // itself the finding, not a gap in the record.
      defaultPrevented: null,
      phase,
      target: describe(e.target),
      path
    });
  };

  for (const kind of KINDS) {
    window.addEventListener(kind, (e) => record(e, 'capture'), { capture: true, passive: true });
    window.addEventListener(kind, (e) => record(e, 'bubble'), { capture: false, passive: true });
  }

  const recorder: GestureRecorder = {
    events,
    count: () => events.length,
    clear: () => {
      events.length = 0;
    },
    json: (name = `gesture-trace-${saved + 1}`) => {
      const trace: GestureTrace = {
        name,
        provenance: 'captured',
        engine: navigator.userAgent,
        note:
          'Recorded by view/gestureRecorder.ts from real, delivered events on the shipping build. ' +
          'Every row carries isTrusted, the phase it was seen in, and what the app handlers did ' +
          'with it. Drop this file into scripts/fixtures/gesture/ and add it to TRACES in ' +
          'scripts/gesture-test.ts to replay it.',
        events: events.slice()
      };
      return JSON.stringify(trace, null, 2);
    },
    save: async (name = `gesture-trace-${saved + 1}`) => {
      const text = recorder.json(name);
      const file = `${name}.json`;
      saved++;
      if (exportFile) {
        try {
          await exportFile(file, new TextEncoder().encode(text), 'application/json');
          console.info(`[gesture recorder] wrote ${file} (${events.length} events)`);
          return file;
        } catch (err) {
          console.warn('[gesture recorder] export refused, falling back to a download', err);
        }
      }
      try {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = file;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        console.info(`[gesture recorder] downloaded ${file} (${events.length} events)`);
        return file;
      } catch {
        /* a webview with no download support: the clipboard and the console are left */
      }
      try {
        await navigator.clipboard?.writeText(text);
        console.info(`[gesture recorder] ${file} is on the clipboard (${events.length} events)`);
        return 'clipboard';
      } catch {
        console.info(`[gesture recorder] ${file}:\n${text}`);
        return 'console';
      }
    }
  };

  window.__RSGT__ = recorder;
  console.info(
    `[gesture recorder] ON. Pinch, then run window.__RSGT__.save(). ` +
      `Turn it off with localStorage.removeItem('${FLAG_KEY}').`
  );
  return recorder;
}

/** `timeStamp` to three decimals, so a replay's clock matches the captured one exactly. */
function roundMs(ts: number): number {
  return Math.round(ts * 1000) / 1000;
}
