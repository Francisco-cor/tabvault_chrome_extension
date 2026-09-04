// tests/ui/fase6.test.js — Fase 6: selección de restauración parcial (reducers),
// filtro de plantillas y helpers puros del modal de guardado.
import { describe, it, expect } from 'vitest';
import { createStore } from '../../ui/store.js';
import { rootReducer, initialState } from '../../ui/reducers.js';
import { A } from '../../ui/actions.js';
import {
  buildSavePreviewRows,
  domainOf,
  sessionTopDomains,
  includedTabIds,
} from '../../ui/actions/sessionActions.js';
import { applyTemplateFilter, visibleSessions } from '../../ui/views/SessionsView.js';
import { includedCount } from '../../ui/views/DetailView.js';
import { makeSession, makeGroup, makeTab } from '../fixtures/sessions.js';

function makeStore() {
  return createStore(rootReducer, initialState());
}

describe('Restauración parcial — reducers (Fase 6.2)', () => {
  it('toggle marca/desmarca; on:true fuerza marcado', () => {
    const store = makeStore();
    store.dispatch({ type: A.DETAIL_TAB_CHECKED, tabId: 't1' });
    expect(store.getState().detailUnchecked).toEqual(['t1']);
    store.dispatch({ type: A.DETAIL_TAB_CHECKED, tabId: 't2' });
    expect(store.getState().detailUnchecked).toEqual(['t1', 't2']);
    store.dispatch({ type: A.DETAIL_TAB_CHECKED, tabId: 't1' });
    expect(store.getState().detailUnchecked).toEqual(['t2']);
    store.dispatch({ type: A.DETAIL_TAB_CHECKED, tabId: 't2', on: true });
    expect(store.getState().detailUnchecked).toEqual([]);
  });

  it('abrir detalle / navegar resetea la selección', () => {
    const store = makeStore();
    store.dispatch({ type: A.DETAIL_TAB_CHECKED, tabId: 't1' });
    store.dispatch({ type: A.NAVIGATED, view: 'detail', detailSessionId: 's1' });
    expect(store.getState().detailUnchecked).toEqual([]);
    store.dispatch({ type: A.DETAIL_TAB_CHECKED, tabId: 't9' });
    store.dispatch({ type: A.VIEW_BACK, view: 'sessions' });
    expect(store.getState().detailUnchecked).toEqual([]);
  });

  it('filtro de plantillas alterna y NO interfiere con tags', () => {
    const store = makeStore();
    expect(store.getState().templatesOnly).toBe(false);
    store.dispatch({ type: A.TEMPLATES_FILTER_TOGGLED });
    expect(store.getState().templatesOnly).toBe(true);
    expect(store.getState().filterTags).toEqual([]);
    store.dispatch({ type: A.TEMPLATES_FILTER_TOGGLED });
    expect(store.getState().templatesOnly).toBe(false);
  });
});

describe('Helpers puros del modal de guardado (Fase 6.1/6.4)', () => {
  const liveTabs = [
    { url: 'https://github.com/a', title: 'Repo', favicon: '' },
    { url: 'https://news.ycombinator.com/x', title: 'HN' },
    { url: 'chrome://settings', title: 'no capturable' },
  ];

  it('buildSavePreviewRows filtra URLs inválidas y aplica exclusiones', () => {
    const rows = buildSavePreviewRows(liveTabs, ['news.ycombinator.com']);
    expect(rows).toHaveLength(2); // chrome:// fuera
    expect(rows.find((r) => r.domain === 'github.com')?.checked).toBe(true);
    expect(rows.find((r) => r.domain === 'news.ycombinator.com')?.checked).toBe(false);
  });

  it('domainOf normaliza www y devuelve "" en basura', () => {
    expect(domainOf('https://www.github.com/x')).toBe('github.com');
    expect(domainOf('not a url')).toBe('');
  });

  it('sessionTopDomains ordena por frecuencia', () => {
    const session = makeSession({
      groups: [
        makeGroup({ tabs: [makeTab({ url: 'https://a.com/1' }), makeTab({ url: 'https://a.com/2' })] }),
      ],
      ungroupedTabs: [makeTab({ url: 'https://b.com' })],
    });
    expect(sessionTopDomains(session, 2)).toEqual(['a.com', 'b.com']);
  });

  it('includedTabIds: todo menos los desmarcados; extremos → todo', () => {
    const session = makeSession({
      ungroupedTabs: [makeTab({ id: 't1' }), makeTab({ id: 't2' }), makeTab({ id: 't3' })],
    });
    expect(includedTabIds(session, [])).toHaveLength(3);
    expect(includedTabIds(session, ['t9'])).toHaveLength(3); // desconocido no resta
    expect(includedTabIds(session, ['t2'])).toEqual(['t1', 't3']);
    expect(includedTabIds(session, ['t1', 't2', 't3'])).toHaveLength(3); // nada marcado → todo
  });
});

describe('Plantillas en SessionsView (Fase 6.3)', () => {
  const tpl = makeSession({ id: 'tpl', isTemplate: true });
  const normal = makeSession({ id: 'norm' });

  it('applyTemplateFilter aísla plantillas', () => {
    expect(applyTemplateFilter([tpl, normal], true)).toEqual([tpl]);
    expect(applyTemplateFilter([tpl, normal], false)).toHaveLength(2);
  });

  it('visibleSessions honra el flag del estado y la card muestra badge/marcador', () => {
    const store = makeStore();
    store.dispatch({
      type: A.APP_READY,
      sessions: { tpl, norm: normal },
      trash: {},
      settings: /** @type {any} */ ({ theme: 'dark', sortBy: 'newest', autoSaveMinutes: 0 }),
      liveGroups: [],
      liveUngrouped: [],
    });
    store.dispatch({ type: A.TEMPLATES_FILTER_TOGGLED });
    const state = store.getState();
    expect(visibleSessions(state).map((s) => s.id)).toEqual(['tpl']);
  });

  it('includedCount cuenta total menos desmarcadas reales', () => {
    const session = makeSession({
      ungroupedTabs: [makeTab({ id: 't1' }), makeTab({ id: 't2' })],
      groups: [makeGroup({ tabs: [makeTab({ id: 'g1' })] })],
    });
    expect(includedCount(session, [])).toBe(3);
    expect(includedCount(session, ['g1'])).toBe(2);
    expect(includedCount(session, ['ghost'])).toBe(3);
  });
});
