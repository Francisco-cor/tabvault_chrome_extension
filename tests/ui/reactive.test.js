// tests/ui/reactive.test.js — Cadena reactiva completa: escritura externa (SW) →
// storage.onChanged → Repository → store → vista. Es la verificación en unit del
// flujo popup↔SW que Fase 2 dejó pendiente para "junto al store" (Fase 4).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { Repository } from '../../core/repository.js';
import { createStore } from '../../ui/store.js';
import { rootReducer, initialState } from '../../ui/reducers.js';
import { A } from '../../ui/actions.js';
import { SessionsView } from '../../ui/views/SessionsView.js';
import { makeSession } from '../fixtures/sessions.js';

/** @type {ReturnType<typeof installChromeMock>} */
let mock;

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  mock.unmock();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('UI reactiva al SW', () => {
  it('un auto-save externo se refleja en el store y en la vista sin invalidate() manual', async () => {
    // Popup: repo local de solo lectura + store de UI, cableados como en ui/main.js
    const reader = new Repository({ writable: false });
    reader.attach();
    const store = createStore(rootReducer, initialState());
    reader.subscribe((key) => {
      if (key !== 'sessions') return;
      void reader.getSessions().then((sessions) => {
        store.dispatch({ type: A.SESSIONS_SYNCED, sessions });
      });
    });

    const initial = makeSession({ id: 'a', name: 'Primera' });
    await mock.chrome.storage.local.set({
      meta: { schemaVersion: 3 },
      sessions: { a: initial },
    });
    store.dispatch({
      type: A.APP_READY,
      sessions: await reader.getSessions(),
      trash: {},
      settings: { theme: 'dark', sortBy: 'newest' },
      liveGroups: [],
      liveUngrouped: [],
    });

    expect(SessionsView.render(store.getState())).toContain('Primera');

    // El SW escribe una segunda sesión (auto-save / guardado desde otro contexto)
    await mock.chrome.storage.local.set({
      sessions: {
        a: initial,
        b: makeSession({ id: 'b', name: 'Auto-guardada' }),
      },
    });
    await flush();

    // Store actualizado…
    expect(Object.keys(store.getState().sessions)).toEqual(['a', 'b']);
    // …y la vista lo pinta sin ningún refresco manual.
    expect(SessionsView.render(store.getState())).toContain('Auto-guardada');
  });

  it('los borradores de notas sobreviven a ese mismo ciclo (M8 extremo a extremo)', async () => {
    const reader = new Repository({ writable: false });
    reader.attach();
    const store = createStore(rootReducer, initialState());
    reader.subscribe((key) => {
      if (key !== 'sessions') return;
      void reader.getSessions().then((sessions) => {
        store.dispatch({ type: A.SESSIONS_SYNCED, sessions });
      });
    });

    const tab = { id: 't1', url: 'https://x.y/', title: 'X', note: '', tags: [], savedAt: 1 };
    const session = {
      id: 's1',
      name: 'S',
      created: 1,
      updated: 1,
      groups: [{ id: 'g1', name: 'G', color: 'blue', tags: [], note: '', tabs: [tab] }],
      ungroupedTabs: [],
      metadata: { groupCount: 1, tabCount: 1 },
    };
    await mock.chrome.storage.local.set({ meta: { schemaVersion: 3 }, sessions: { s1: session } });
    store.dispatch({
      type: A.APP_READY,
      sessions: await reader.getSessions(),
      trash: {},
      settings: { theme: 'dark', sortBy: 'newest' },
      liveGroups: [],
      liveUngrouped: [],
    });

    // Usuario teclea una nota…
    store.dispatch({ type: A.NOTE_DRAFT, key: 's1|g1|t1', value: 'no perder esto' });
    // …el SW pisa sessions…
    await mock.chrome.storage.local.set({
      sessions: { s1: { ...session, updated: 999 } },
    });
    await flush();

    // …y el textarea renderiza el borrador intacto.
    expect(SessionsView.render(store.getState())).toBeDefined();
    expect(/** @type {any} */ (store.getState().notes)['s1|g1|t1']).toBe('no perder esto');
  });
});
