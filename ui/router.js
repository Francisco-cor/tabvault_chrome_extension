// ui/router.js — Router de vistas con pila interna (sin hash).
// push/setRoot navegan; back() vuelve al punto exacto: misma vista, mismo scroll.
// `Esc` desde el teclado global llama a back() (Fase 4.5).

import { A } from './actions.js';

/**
 * @typedef {{ view: string, params: Record<string, any>, scrollY: number }} RouteEntry
 */

/**
 * @param {import('./store.js').Store<any>} store
 */
export function createRouter(store) {
  /** @type {RouteEntry[]} */
  const stack = [{ view: 'sessions', params: {}, scrollY: 0 }];
  /** @type {HTMLElement|null} */
  let mount = null;

  const current = () => stack[stack.length - 1];

  function captureScroll() {
    if (mount) current().scrollY = mount.scrollTop;
  }

  return {
    /** Elemento contenedor cuyo scrollTop se preserva entre vistas. */
    bind(/** @type {HTMLElement} */ el) {
      mount = el;
    },

    current,
    canBack: () => stack.length > 1,

    /**
     * Cambia la vista raíz (pestañas del header): reinicia la pila.
     * @param {string} view
     */
    setRoot(view) {
      if (stack.length === 1 && current().view === view) return;
      captureScroll();
      stack.length = 0;
      stack.push({ view, params: {}, scrollY: 0 });
      store.dispatch({ type: A.NAVIGATED, view });
    },

    /**
     * Apila una vista sobre la actual (detalle, settings).
     * @param {string} view
     * @param {Record<string, any>} [params]
     */
    push(view, params = {}) {
      const top = current();
      if (
        top.view === view &&
        top.params.detailSessionId === params.detailSessionId &&
        stack.length > 0 &&
        view === 'detail'
      )
        return;
      captureScroll();
      stack.push({ view, params, scrollY: 0 });
      store.dispatch({ type: A.NAVIGATED, view, ...params });
    },

    /**
     * Pop de la pila. Restaura vista y scroll. No-op en la raíz.
     * @returns {boolean} true si navegó hacia atrás.
     */
    back() {
      if (stack.length <= 1) return false;
      captureScroll();
      stack.pop();
      const target = current();
      store.dispatch({ type: A.VIEW_BACK, view: target.view });
      // dispatch dispara el render síncronamente (suscriptor del store);
      // con el DOM nuevo ya podemos restaurar el scroll de la vista destino.
      if (mount) mount.scrollTop = target.scrollY;
      return true;
    },

    /** Solo para tests. */
    _stack: stack,
  };
}
