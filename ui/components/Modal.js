// ui/components/Modal.js — Helpers de modales persistentes (markup estático en HTML).
// Incluye focus trap mínimo: al abrir enfoca el primer input y devuelve el foco al cerrar.

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function overlay(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Modal #${id} no existe`);
  return el;
}

/** @type {HTMLElement|null} */
let lastFocused = null;

/**
 * Abre un modal, enfoca su primer input y activa el focus trap (Tab cicla dentro).
 * @param {string} id
 */
export function openModal(id) {
  const el = overlay(id);
  lastFocused = /** @type {HTMLElement} */ (document.activeElement);
  el.removeAttribute('hidden');
  const first = /** @type {HTMLInputElement|null} */ (
    el.querySelector('input, textarea, button.btn-primary')
  );
  requestAnimationFrame(() => {
    if (first && first instanceof HTMLInputElement) {
      first.focus();
      first.select();
    } else {
      /** @type {HTMLElement|null} */ (first)?.focus();
    }
  });
  el.addEventListener('keydown', trapTab, true);
}

/** @param {KeyboardEvent} e */
function trapTab(e) {
  if (e.key !== 'Tab') return;
  const overlayEl = /** @type {HTMLElement} */ (e.currentTarget);
  const focusables = Array.from(
    overlayEl.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.hasAttribute('hidden'));
  if (focusables.length === 0) return;
  const first = /** @type {HTMLElement} */ (focusables[0]);
  const last = /** @type {HTMLElement} */ (focusables[focusables.length - 1]);
  if (e.shiftKey && /** @type {HTMLElement} */ (document.activeElement) === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && /** @type {HTMLElement} */ (document.activeElement) === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Cierra un modal y restaura el foco previo.
 * @param {string} id
 */
export function closeModal(id) {
  const el = overlay(id);
  el.setAttribute('hidden', '');
  el.removeEventListener('keydown', trapTab, true);
  lastFocused?.focus?.({ preventScroll: true });
  lastFocused = null;
}

/**
 * ¿Está abierto algún modal conocido? (para el teclado global)
 * @param {...string} ids
 */
export function anyModalOpen(...ids) {
  return ids.some((id) => {
    const el = document.getElementById(id);
    return !!el && !el.hasAttribute('hidden');
  });
}
