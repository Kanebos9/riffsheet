/**
 * THE SHEET'S CONTEXT MENU — the one piece of new visible UI in this wave.
 *
 * WHY A CUSTOM MENU AND NOT THE NATIVE ONE. The native menu is the browser's, and inside a JUCE
 * webview it offers Reload, Inspect Element and Back — none of which mean anything in a plugin
 * window and one of which throws the player's take away. It also cannot carry a checkmark
 * against the note's CURRENT written value, which is most of what this menu is for: the player
 * needs to see what the note is before choosing what it should become.
 *
 * WHAT IT DELIBERATELY IS NOT. Not a popover with steppers in it — that was tried on this same
 * surface and removed (see `App.onNoteClick`), because it covered the music you were reading and
 * cost two clicks to do one thing. This appears on right-click only, does one thing per item,
 * and closes on Esc, on a click anywhere else, on scroll and on the next render.
 *
 * DISABLED ITEMS ARE SHOWN, WITH THE REASON ON THEM. "Insert bar" on a recorded take and every
 * item on an imported part are refusals with a cause, and a menu that silently omits them makes
 * the player think the feature does not exist. `reason` becomes the tooltip and a dim line of
 * text, so the answer is on screen rather than in a manual.
 *
 * STYLED INLINE, ON PURPOSE. Everything here is set on the elements themselves rather than in
 * ui/styles.css, reading the app's own CSS custom properties for colour so it follows the theme.
 * The menu is one transient element owned by one file; a stylesheet rule for it would be a
 * second place to look for the same twelve lines.
 */

export interface SheetMenuItem {
  label: string;
  /** Ticked, for a value the target already has. */
  checked?: boolean;
  /** Greyed out. `reason` says why, and is shown as well as being the tooltip. */
  disabled?: boolean;
  reason?: string;
  /** A rule above this item, for grouping. */
  separatorBefore?: boolean;
  onPick?: () => void;
}

const MENU_CLASS = 'sheet-menu';

function readColors(): { paper: string; ink: string; line: string; accent: string; dim: string } {
  const s = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    paper: pick('--bg-raised', '#ffffff'),
    ink: pick('--text', '#111111'),
    line: pick('--border', 'rgba(0,0,0,0.18)'),
    accent: pick('--accent', '#7a5cff'),
    dim: pick('--text-dim', 'rgba(0,0,0,0.45)')
  };
}

/**
 * One menu at a time, anywhere in the app.
 *
 * Module-level rather than per-instance because that is the actual invariant: two open context
 * menus is never a state anybody wants, and an owner-per-surface would allow exactly that when
 * the pointer crosses from the sheet to the roll with a menu already up.
 */
let open: { el: HTMLElement; dispose: () => void } | null = null;

export function closeSheetMenu(): void {
  open?.dispose();
}

export function sheetMenuOpen(): boolean {
  return open !== null;
}

/** What is on screen right now, for the harness — labels, state, and nothing about pixels. */
export function sheetMenuProbe(): {
  open: boolean;
  items: Array<{ label: string; checked: boolean; disabled: boolean; reason: string | null }>;
} {
  if (!open) return { open: false, items: [] };
  const items = [...open.el.querySelectorAll<HTMLElement>('[data-menu-item]')].map((el) => ({
    label: el.getAttribute('data-menu-item') ?? '',
    checked: el.getAttribute('aria-checked') === 'true',
    disabled: el.getAttribute('aria-disabled') === 'true',
    reason: el.getAttribute('data-reason') || null
  }));
  return { open: true, items };
}

/**
 * Put the menu on screen at a client point, flipped so it never hangs off an edge.
 *
 * Appended to `document.body` rather than to the sheet, because the sheet is a scroller with
 * `overflow: hidden` on one axis and a menu inside it would be clipped by the pane it belongs to.
 */
export function showSheetMenu(clientX: number, clientY: number, items: readonly SheetMenuItem[]): void {
  closeSheetMenu();
  if (items.length === 0) return;
  const colors = readColors();

  const menu = document.createElement('div');
  menu.className = MENU_CLASS;
  menu.setAttribute('role', 'menu');
  Object.assign(menu.style, {
    position: 'fixed',
    zIndex: '9000',
    minWidth: '178px',
    // Wide enough for the longest refusal on ONE line. Nothing in this app is allowed to
    // truncate, so the alternative to the width is a two-line row, which reads as a mistake.
    maxWidth: '360px',
    padding: '4px',
    borderRadius: '8px',
    border: `1px solid ${colors.line}`,
    background: colors.paper,
    color: colors.ink,
    boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
    font: '500 12.5px ui-sans-serif, system-ui, sans-serif',
    userSelect: 'none'
  } satisfies Partial<CSSStyleDeclaration>);

  for (const item of items) {
    if (item.separatorBefore) {
      const rule = document.createElement('div');
      Object.assign(rule.style, {
        height: '1px',
        margin: '4px 2px',
        background: colors.line
      } satisfies Partial<CSSStyleDeclaration>);
      menu.appendChild(rule);
    }
    const row = document.createElement('div');
    row.setAttribute('role', 'menuitem');
    row.setAttribute('data-menu-item', item.label);
    row.setAttribute('aria-checked', item.checked ? 'true' : 'false');
    row.setAttribute('aria-disabled', item.disabled ? 'true' : 'false');
    if (item.reason) {
      row.setAttribute('data-reason', item.reason);
      row.title = item.reason;
    }
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      padding: '5px 9px 5px 7px',
      borderRadius: '5px',
      cursor: item.disabled ? 'default' : 'pointer',
      opacity: item.disabled ? '0.45' : '1',
      whiteSpace: 'nowrap'
    } satisfies Partial<CSSStyleDeclaration>);

    const tick = document.createElement('span');
    tick.textContent = item.checked ? '✓' : '';
    Object.assign(tick.style, {
      width: '11px',
      flex: '0 0 auto',
      color: colors.accent,
      fontWeight: '700'
    } satisfies Partial<CSSStyleDeclaration>);
    row.appendChild(tick);

    const label = document.createElement('span');
    label.textContent = item.label;
    label.style.flex = '1 1 auto';
    row.appendChild(label);

    // The refusal, said out loud next to the item it belongs to. Truncation is not allowed
    // anywhere in this app, so the menu widens for it instead and wraps at its own maximum.
    if (item.disabled && item.reason) {
      const why = document.createElement('span');
      why.textContent = item.reason;
      Object.assign(why.style, {
        color: colors.dim,
        font: '400 11px ui-sans-serif, system-ui, sans-serif',
        whiteSpace: 'normal',
        flex: '0 1 auto',
        textAlign: 'right'
      } satisfies Partial<CSSStyleDeclaration>);
      row.appendChild(why);
    }

    if (!item.disabled) {
      row.addEventListener('pointerenter', () => {
        row.style.background = colors.accent;
        row.style.color = colors.paper;
        tick.style.color = colors.paper;
      });
      row.addEventListener('pointerleave', () => {
        row.style.background = '';
        row.style.color = colors.ink;
        tick.style.color = colors.accent;
      });
      // ON `pointerup`, NOT `click`. The menu is opened from `contextmenu`, and on a right-press
      // the browser dispatches `click` for the LEFT button only — so a `click` handler would
      // require a second press to reach. `pointerup` is the press the player actually makes.
      row.addEventListener('pointerup', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pick = item.onPick;
        closeSheetMenu();
        pick?.();
      });
      // A left-click on the row must not fall through to the sheet underneath either.
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  // Measured after it is in the document, because the width depends on the longest label and
  // there is no honest way to know that in advance.
  const rect = menu.getBoundingClientRect();
  const x = Math.max(4, Math.min(clientX, window.innerWidth - rect.width - 4));
  const y = Math.max(4, Math.min(clientY, window.innerHeight - rect.height - 4));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSheetMenu();
    }
  };
  const onAway = (e: Event) => {
    if (e.target instanceof Node && menu.contains(e.target)) return;
    closeSheetMenu();
  };
  const dispose = () => {
    if (open?.el !== menu) return;
    open = null;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onAway, true);
    window.removeEventListener('wheel', onAway, true);
    window.removeEventListener('resize', dispose);
    window.removeEventListener('blur', dispose);
    document.removeEventListener('scroll', dispose, true);
    menu.remove();
  };
  // Capture phase throughout: a click away must close the menu BEFORE the surface underneath
  // acts on it, or a click meant to dismiss would also seek.
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onAway, true);
  window.addEventListener('wheel', onAway, true);
  window.addEventListener('resize', dispose);
  window.addEventListener('blur', dispose);
  document.addEventListener('scroll', dispose, true);

  open = { el: menu, dispose };
}
