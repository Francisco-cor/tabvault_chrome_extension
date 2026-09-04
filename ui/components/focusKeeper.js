// ui/components/focusKeeper.js — Preservación de foco/cursor entre re-renders.
// Antes de reemplazar innerHTML captura el elemento enfocado dentro del contenedor
// (por su clave data-fk) y su selección; después del swap lo restaura.
// Es la mitad mecánica de la muerte de M8 (la otra mitad son los NOTE_DRAFT).

/**
 * Clave estable de un elemento enfocable. Los componentes estampan `data-fk`;
 * como fallback se deriva de data-action + data-id.
 * @param {HTMLElement} el
 */
function fkKeyOf(el) {
  if (el.dataset.fk) return el.dataset.fk;
  const parts = [
    el.dataset.action,
    el.dataset.id,
    el.dataset.sessionId,
    el.dataset.groupId,
    el.dataset.tabId,
  ];
  const key = parts.filter(Boolean).join(':');
  return key || null;
}

/** @type {{ key: string, start: number|null, end: number|null } | null} */
let captured = null;

/**
 * Captura el foco actual si vive dentro de root.
 * @param {HTMLElement} root
 */
export function captureFocus(root) {
  captured = null;
  const el = /** @type {HTMLElement} */ (document.activeElement);
  if (!el || !root.contains(el)) return;
  const isText =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el.getAttribute('contenteditable') === 'true';
  if (!isText) return;
  const key = fkKeyOf(el);
  if (!key) return;
  captured = {
    key,
    start: /** @type {any} */ (el).selectionStart ?? null,
    end: /** @type {any} */ (el).selectionEnd ?? null,
  };
}

/**
 * Restaura el foco capturado buscando el equivalente en el DOM nuevo.
 * @param {HTMLElement} root
 */
export function restoreFocus(root) {
  if (!captured) return;
  const { key, start, end } = captured;
  captured = null;
  const el = /** @type {HTMLElement} */ (root.querySelector(`[data-fk="${cssEscape(key)}"]`));
  if (!el) return;
  el.focus({ preventScroll: true });
  if (start != null && end != null && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    try {
      el.setSelectionRange(start, end);
    } catch {
      /* inputs sin selección (p.ej. type=search con dirección) */
    }
  }
}

/** @param {string} s */
function cssEscape(s) {
  // Las claves contienen | : etc. — usar escape de atributo vía CSS.escape si existe.
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(/** @type {any} */ (s))
    : s.replace(/"/g, '\\"');
}

/** Limpia la captura pendiente (p.ej. tras blur intencional). */
export function discardCapture() {
  captured = null;
}
