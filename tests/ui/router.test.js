// tests/ui/router.test.js — Pila de vistas con scroll preservado (Fase 4.5).

import { describe, it, expect } from 'vitest';
import { createStore } from '../../ui/store.js';
import { createRouter } from '../../ui/router.js';
import { rootReducer, initialState } from '../../ui/reducers.js';
import { A } from '../../ui/actions.js';

function setup() {
  const store = createStore(rootReducer, initialState());
  /** @type {{scrollTop:number}} */
  const mount = { scrollTop: 0 };
  const router = createRouter(store);
  router.bind(/** @type {any} */ (mount));
  /** @type {string[]} */
  const views = [];
  store.subscribe((/** @type {any} */ s) => views.push(s.view));
  return { store, router, mount, views };
}

describe('router', () => {
  it('arranca en sessions sin historial', () => {
    const { router } = setup();
    expect(router.current().view).toBe('sessions');
    expect(router.canBack()).toBe(false);
  });

  it('setRoot cambia la vista raíz y despacha NAVIGATED', () => {
    const { store, views } = setup();
    // router propio para no reusar el bind del helper
    const router = createRouter(store);
    router.setRoot('trash');
    expect(store.getState().view).toBe('trash');
    expect(views).toContain('trash');
  });

  it('push apila detail y back vuelve con scroll restaurado', () => {
    const { store, router, mount } = setup();
    mount.scrollTop = 140;
    router.push('detail', { detailSessionId: 's1' });
    expect(store.getState().view).toBe('detail');
    expect(store.getState().detailSessionId).toBe('s1');
    expect(router.canBack()).toBe(true);

    mount.scrollTop = 0; // la vista detalle arranca arriba
    const wentBack = router.back();
    expect(wentBack).toBe(true);
    expect(store.getState().view).toBe('sessions');
    expect(store.getState().detailSessionId).toBeNull();
    expect(mount.scrollTop).toBe(140); // scroll de la lista preservado
  });

  it('push duplicado al mismo detalle es no-op (sin entradas repetidas)', () => {
    const { router } = setup();
    router.push('detail', { detailSessionId: 's1' });
    router.push('detail', { detailSessionId: 's1' });
    expect(router._stack.length).toBe(2);
  });

  it('back en la raíz es no-op y devuelve false', () => {
    const { router } = setup();
    expect(router.back()).toBe(false);
  });

  it('NAVIGATED resetea bulk mode (navegar limpia selección)', () => {
    const { store, router } = setup();
    store.dispatch({ type: A.BULK_MODE_TOGGLED, on: true });
    store.dispatch({ type: A.BULK_CHECK_TOGGLED, id: 'a' });
    router.push('settings');
    expect(store.getState().bulkMode).toBe(false);
    expect(store.getState().bulkSelected).toEqual([]);
  });

  it('setRoot reinicia la pila completa', () => {
    const { router } = setup();
    router.push('detail', { detailSessionId: 'x' });
    router.setRoot('groups');
    expect(router._stack.length).toBe(1);
    expect(router.canBack()).toBe(false);
  });
});
