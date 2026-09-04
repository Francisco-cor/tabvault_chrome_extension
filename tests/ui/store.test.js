// tests/ui/store.test.js — Store pub/sub: dispatch, reducers, suscripciones con
// selectores memoizados por firma JSON (Fase 4.1).

import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../../ui/store.js';

/** Reducer mínimo para tests. @param {{n:number, label?:string}} state @param {{type:string, [k:string]: any}} action @returns {any} */
function counterReducer(state, action) {
  switch (action.type) {
    case 'INC':
      return { ...state, n: state.n + 1 };
    case 'LABEL':
      return { ...state, label: action.label };
    case 'SAME':
      return state; // no-op intencional
    default:
      return state;
  }
}

describe('store', () => {
  it('getState devuelve el estado inicial', () => {
    const store = createStore(counterReducer, { n: 0 });
    expect(store.getState()).toEqual({ n: 0 });
  });

  it('dispatch aplica el reducer y notifica a los suscriptores globales', () => {
    const store = createStore(counterReducer, { n: 0 });
    const spy = vi.fn();
    store.subscribe(spy);
    store.dispatch({ type: 'INC' });
    expect(store.getState().n).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(store.getState());
  });

  it('si el reducer devuelve el mismo objeto NO notifica', () => {
    const store = createStore(counterReducer, { n: 0 });
    const spy = vi.fn();
    store.subscribe(spy);
    store.dispatch({ type: 'SAME' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('unsubscribe deja de notificar', () => {
    const store = createStore(counterReducer, { n: 0 });
    const spy = vi.fn();
    const off = store.subscribe(spy);
    off();
    store.dispatch({ type: 'INC' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('suscripción con selector solo dispara cuando el slice cambia', () => {
    const store = createStore(counterReducer, { n: 0, label: 'a' });
    const spy = vi.fn();
    store.subscribe((/** @type {any} */ s) => s.label, spy);

    // cambia n → label igual → sin notificación
    store.dispatch({ type: 'INC' });
    expect(spy).not.toHaveBeenCalled();

    // cambia label → notifica
    store.dispatch({ type: 'LABEL', label: 'b' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('selector con contenido profundo igual (JSON) no re-notifica', () => {
    const store = createStore((_s, a) => (a.type === 'SET' ? { list: a.list } : _s), { list: [1, 2] });
    const spy = vi.fn();
    store.subscribe((/** @type {any} */ s) => s.list, spy);
    store.dispatch({ type: 'SET', list: [1, 2] }); // nuevo array, mismo contenido
    expect(spy).not.toHaveBeenCalled();
    store.dispatch({ type: 'SET', list: [1, 2, 3] });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('prohíbe dispatch anidado desde un subscriber', () => {
    const store = createStore(counterReducer, { n: 0 });
    store.subscribe(() => {
      store.dispatch({ type: 'INC' });
    });
    expect(() => store.dispatch({ type: 'INC' })).toThrow(/dispatch/i);
  });
});
