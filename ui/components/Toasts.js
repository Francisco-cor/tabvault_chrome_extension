// ui/components/Toasts.js — Servicios de toast simple y toast con undo.
// Son elementos persistentes fuera de #content: se controlan por API directa,
// no por render (evita re-crear timers en cada repaint).

/** @type {ReturnType<typeof setTimeout>|null} */
let toastTimer = null;

/**
 * @param {HTMLElement} el
 * @param {string} msg
 * @param {'' | 'success' | 'error'} [type]
 */
export function showToast(el, msg, type = '') {
  if (!el) return;
  el.textContent = msg;
  el.className = `toast${type ? ' ' + type : ''}`;
  el.removeAttribute('hidden');
  clearTimeout(toastTimer ?? undefined);
  toastTimer = setTimeout(() => el.setAttribute('hidden', ''), 2500);
}

/**
 * Controlador del toast con undo (5s).
 * @param {Document} doc
 */
export function createUndoToast(doc) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {(() => void)|null} */
  let fn = null;

  const root = doc.getElementById('undo-toast');
  const msgEl = doc.getElementById('undo-toast-msg');
  const progressEl = doc.getElementById('undo-progress');
  const btn = doc.getElementById('undo-btn');

  btn?.addEventListener('click', () => {
    const run = fn;
    clear();
    run?.();
  });

  function clear() {
    clearTimeout(timer ?? undefined);
    timer = null;
    fn = null;
    root?.setAttribute('hidden', '');
  }

  return {
    /** @param {string} msg @param {() => void} undoFn */
    show(msg, undoFn) {
      clear();
      fn = undoFn;
      if (msgEl) msgEl.textContent = msg;
      root?.removeAttribute('hidden');
      if (progressEl) {
        progressEl.style.animation = 'none';
        requestAnimationFrame(() => {
          progressEl.style.animation = '';
        });
      }
      timer = setTimeout(clear, 5000);
    },
    clear,
  };
}
