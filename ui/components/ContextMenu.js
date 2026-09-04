// ui/components/ContextMenu.js — Menú contextual reutilizable (instancia única).
// A11y (Fase 5.2): role="menu"/menuitem, foco en el primer ítem al abrir,
// flechas/Home/End navegan, Enter activa y el foco vuelve al ancla al cerrar.
// El cierre global con Esc lo maneja el teclado del bootstrap vía closeMenu().

/** @type {{ el: HTMLElement, cleanup: (() => void)|null } | null} */
let active = null;

/**
 * @param {HTMLElement} anchor
 * @param {{ label?: string, icon?: string, danger?: boolean, divider?: boolean,
 *           action?: () => void }[]} items
 */
export function showMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Actions');

  /** @type {HTMLButtonElement[]} */
  const options = [];
  for (const item of items) {
    if (item.divider) {
      const d = document.createElement('div');
      d.className = 'ctx-divider';
      d.setAttribute('role', 'separator');
      menu.appendChild(d);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ctx-item${item.danger ? ' danger' : ''}`;
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = `${item.icon ?? ''} ${escapeAttr(item.label ?? '')}`;
    btn.addEventListener('click', () => {
      const act = item.action;
      closeMenu();
      act?.();
    });
    options.push(btn);
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  positionMenu(menu, anchor);

  active = { el: menu, cleanup: null };

  // Teclado propio del menú: flechas navegan, Enter/Space activan (click nativo).
  menu.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (options.length === 0) return;
    const idx = options.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    let next = -1;
    if (e.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % options.length;
    else if (e.key === 'ArrowUp') next = idx <= 0 ? options.length - 1 : idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next >= 0) {
      e.preventDefault();
      e.stopPropagation();
      options[next].focus();
    }
  });

  // Foco inicial en el primer ítem (tick siguiente para asegurar el layout).
  requestAnimationFrame(() => options[0]?.focus());

  // Devolver el foco al ancla al cerrarse (patrón modal).
  const prev = document.activeElement;
  const opener =
    prev instanceof HTMLElement && prev !== document.body ? /** @type {HTMLElement} */ (prev) : anchor;

  // Cierre por click fuera (tick siguiente para no tragarse el click que lo abrió)
  requestAnimationFrame(() => {
    /** @param {MouseEvent} e */
    const handler = (e) => {
      if (!menu.contains(/** @type {Node} */ (e.target))) {
        closeMenu();
        document.removeEventListener('click', handler, true);
      }
    };
    document.addEventListener('click', handler, true);
    if (active && active.el === menu)
      active.cleanup = () => {
        document.removeEventListener('click', handler, true);
        opener?.focus?.({ preventScroll: true });
      };
  });
}

function closeMenu() {
  if (!active) return;
  const cleanup = active.cleanup;
  active.el.remove();
  active = null;
  cleanup?.();
}

export { closeMenu };

/** ¿Hay un menú abierto? (para el teclado global) */
export const isMenuOpen = () => active !== null;

/** @param {HTMLElement} menu @param {HTMLElement} anchor */
function positionMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.style.top = rect.bottom + 4 + 'px';
  // Preferir alinear al borde derecho del ancla
  const menuWidth = menu.offsetWidth;
  if (rect.right - menuWidth > 0) {
    menu.style.right = window.innerWidth - rect.right + 'px';
  } else {
    menu.style.left = rect.left + 'px';
  }
}

/** @param {string} s */
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
