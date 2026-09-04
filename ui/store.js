// ui/store.js — Única fuente de verdad observable (pub/sub mínimo).
// API: getState(), dispatch(action), subscribe(fn) | subscribe(selector, fn).
// Con selector, el suscriptor solo se notifica cuando la firma JSON del slice cambia.

/**
 * @template T
 * @typedef {{ getState: () => T, dispatch: (action: any) => void,
 *             subscribe: (a: any, b?: (s: T) => void) => () => void }} Store<T>
 */

/**
 * Crea el store.
 * @template T
 * @param {(state: T, action: {type: string, [k: string]: any}) => T} reducer
 * @param {T} initialState
 * @returns {Store<T>}
 */
export function createStore(reducer, initialState) {
  let state = initialState;
  /** @type {Set<(s: T) => void>} */
  const globalSubs = new Set();
  /**
   * Suscriptores con selector. Cada entrada memoiza la última firma JSON.
   * @type {Map<(s: T) => void, { selector: (s: T) => unknown, last: string }>}
   */
  const keyedSubs = new Map();

  let dispatching = false;

  return {
    getState: () => state,

    /**
     * @param {{ type: string, [k: string]: any }} action
     */
    dispatch(action) {
      if (dispatching) throw new Error('No se permite dispatch dentro de un subscriber');
      const next = reducer(state, action);
      if (next === state) return;
      state = next;
      dispatching = true;
      try {
        for (const fn of globalSubs) fn(state);
        for (const [fn, entry] of keyedSubs) {
          const sig = JSON.stringify(entry.selector(state));
          if (sig !== entry.last) {
            entry.last = sig;
            fn(state);
          }
        }
      } finally {
        dispatching = false;
      }
    },

    /**
     * subscribe(fn) → notificado en cada cambio.
     * subscribe(selector, fn) → notificado solo si cambia el slice seleccionado.
     * @param {(s: T) => unknown} a
     * @param {(s: T) => void} [b]
     */
    subscribe(a, b) {
      if (typeof b === 'function') {
        keyedSubs.set(b, { selector: a, last: JSON.stringify(a(state)) });
        return () => keyedSubs.delete(b);
      }
      globalSubs.add(a);
      return () => globalSubs.delete(a);
    },
  };
}
