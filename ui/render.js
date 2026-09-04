// ui/render.js — Render por vistas con diffing barato.
// Cada vista declara render(state)→htmlString puro, deps(state)→serializable y un
// hook after() opcional para efectos. Solo se re-pinta la vista activa y solo si su
// firma JSON cambió. El foco/cursor sobrevive al swap vía focusKeeper.
// Un throw en cualquier vista queda atrapado por el error boundary (4.6).

import { captureFocus, restoreFocus } from './components/focusKeeper.js';

/**
 * @typedef {Object} ViewDef
 * @property {(state: any) => string} render
 * @property {(state: any) => unknown[]} deps
 * @property {(ctx: any, state: any) => void} [after]
 */

/** @param {unknown} s */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Escape para ATRIBUTOS HTML (Fase 10.3: sanitizador único del repo).
 * Mismo juego de entidades que escapeHtml: seguro para comillas dobles/simples,
 * así ningún valor interpolado puede romper el atributo ni inyectar handlers.
 * @param {unknown} s
 */
export function escapeAttr(s) {
  return escapeHtml(s);
}

/**
 * Vista de error amigable (error boundary). El botón usa la delegación global.
 * @param {{ message?: string }} e
 */
export function errorView(e) {
  return `
  <div class="empty-state" role="alert">
    <h4>Algo salió mal</h4>
    <p class="text-dim">${escapeHtml(e?.message ?? 'Error desconocido')}</p>
    <button class="btn-primary" data-action="reload-ui">Recargar</button>
  </div>`;
}

// Skeleton loaders (Fase 5.4): en vez de spinner plano, se anticipa la forma
// real de la vista de sesiones (CTA + 3 cards) para que la carga no salte.
const LOADING_HTML = `
  <div class="loading-state" style="align-items:stretch;justify-content:flex-start;gap:0" aria-busy="true" aria-label="Loading">
    <div class="skeleton skeleton-card" style="height:58px;margin-bottom:8px"></div>
    <div class="skeleton skeleton-card"><div class="skeleton-line w60"></div></div>
    <div class="skeleton skeleton-card"><div class="skeleton-line w60"></div></div>
    <div class="skeleton skeleton-card"><div class="skeleton-line w60"></div></div>
  </div>`;

/**
 * Crea el renderizador suscrito al store.
 * @param {{ store: import('./store.js').Store<any>, mount: HTMLElement,
 *          views: Record<string, ViewDef>, ctx: any }} cfg
 */
export function createRenderer({ store, mount, views, ctx }) {
  let lastSig = /** @type {string|null} */ (null);

  /** Fuerza el próximo repintado aunque la firma no cambie. */
  function invalidate() {
    lastSig = null;
  }

  function render() {
    const state = store.getState();
    try {
      if (state.loading || !state.ready) {
        if (lastSig !== 'loading') {
          captureFocus(mount);
          mount.innerHTML = LOADING_HTML;
          lastSig = 'loading';
        }
        return;
      }

      const def = views[state.view] ?? views.sessions;
      const sig = JSON.stringify([state.view, def.deps(state)]);
      if (sig === lastSig) return;
      lastSig = sig;

      captureFocus(mount);
      let html;
      try {
        html = def.render(state);
      } catch (e) {
        console.error('[TabVault UI] render error', e);
        html = errorView(/** @type {Error} */ (e));
      }
      mount.innerHTML = html;
      restoreFocus(mount);
      def.after?.(ctx, state);
    } catch (e) {
      // Boundary exterior: ni deps ni el swap pudieron completarse.
      console.error('[TabVault UI] fatal render error', e);
      mount.innerHTML = errorView(/** @type {Error} */ (e));
      lastSig = null;
    }
  }

  store.subscribe(render);

  return { render, invalidate };
}
