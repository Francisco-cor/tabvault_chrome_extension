// tests/ui/fase7.test.js — UI de la Fase 7: reducers nuevos, vistas sobre el
// motor de búsqueda, orden manual, workspaces, filtros combinados, tags y
// comandos del Quick Switcher. Todo puro (sin DOM salvo strings HTML).

import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '../../ui/store.js';
import { rootReducer, initialState } from '../../ui/reducers.js';
import { A } from '../../ui/actions.js';
import { SessionsView, sortSessions, collectAllTags } from '../../ui/views/SessionsView.js';
import { SearchView } from '../../ui/views/SearchView.js';
import { GroupsView, selectedWindowData } from '../../ui/views/GroupsView.js';
import { DetailView } from '../../ui/views/DetailView.js';
import { buildCommands, matchCommands } from '../../ui/services/commands.js';
import { resetSearchVault } from '../../core/searchIndex.js';
import { makeSession, makeGroup, makeTab } from '../fixtures/sessions.js';

const SETTINGS = { theme: 'dark', sortBy: 'newest', autoSaveMinutes: 0 };

function makeStore() {
  return createStore(rootReducer, initialState());
}

/** @param {any} store @param {Record<string, import('../../shared/types.js').Session>} sessions */
function boot(store, sessions) {
  store.dispatch({
    type: A.APP_READY,
    sessions,
    trash: {},
    settings: SETTINGS,
    liveGroups: [],
    liveUngrouped: [],
    windows: [],
    activeWindowId: null,
  });
}

beforeEach(() => resetSearchVault());

describe('reducers Fase 7', () => {
  it('FILTERS_PATCHED/CLEARED y WORKSPACE_CHANGED', () => {
    const store = makeStore();
    store.dispatch({ type: A.FILTERS_PATCHED, patch: { domain: 'github.com', range: 'week' } });
    expect(store.getState().activeFilters).toEqual({
      domain: 'github.com',
      range: 'week',
      pinnedOnly: false,
    });
    store.dispatch({ type: A.WORKSPACE_CHANGED, workspace: 'Trabajo' });
    expect(store.getState().workspace).toBe('Trabajo');
    store.dispatch({ type: A.FILTERS_CLEARED });
    expect(store.getState().activeFilters.domain).toBe('');
  });

  it('APP_READY parsea filtros del hash y workspace desde settings', () => {
    const store = makeStore();
    // jsdom no corre aquí: location puede no existir → parseFilters('') default
    store.dispatch({
      type: A.APP_READY,
      sessions: {},
      trash: {},
      settings: { ...SETTINGS, workspace: 'Personal' },
      liveGroups: [],
      liveUngrouped: [],
    });
    expect(store.getState().workspace).toBe('Personal');
    expect(store.getState().activeFilters.range).toBe('any');
  });

  it('LIVE_DATA_UPDATED acepta windows/activeWindowId sin romper contrato previo', () => {
    const store = makeStore();
    const wins = [{ id: 1, focused: true, groups: [], ungrouped: [] }];
    store.dispatch({
      type: A.LIVE_DATA_UPDATED,
      groups: [],
      ungrouped: [],
      windows: wins,
      activeWindowId: 1,
    });
    expect(store.getState().liveWindows).toBe(wins);
    expect(store.getState().activeWindowId).toBe(1);
    // payload viejo (Fases 3-6) no pisa lo existente
    store.dispatch({ type: A.LIVE_DATA_UPDATED, groups: [{ id: 9 }], ungrouped: [] });
    expect(store.getState().liveWindows).toBe(wins);
  });

  it('ACTIVE_WINDOW_CHANGED', () => {
    const store = makeStore();
    store.dispatch({ type: A.ACTIVE_WINDOW_CHANGED, windowId: 42 });
    expect(store.getState().activeWindowId).toBe(42);
  });
});

describe('SessionsView · orden manual + workspace + filtros combinados', () => {
  it("sort 'manual' respeta order ascendente con pinned arriba", () => {
    const a = makeSession({ id: 'a', name: 'A', order: 2 });
    const b = makeSession({ id: 'b', name: 'B', order: 1 });
    const pin = makeSession({ id: 'p', name: 'P', order: 3, pinned: true });
    const sorted = sortSessions([a, b, pin], 'manual');
    expect(sorted.map((s) => s.id)).toEqual(['p', 'b', 'a']);
    // sin order → al final por updated desc
    const x = makeSession({ id: 'x', name: 'X', updated: 500 });
    const y = makeSession({ id: 'y', name: 'Y', updated: 900 });
    expect(sortSessions([x, a], 'manual').map((s) => s.id)).toEqual(['a', 'x']);
    expect(sortSessions([x, y, a], 'manual').map((s) => s.id)).toEqual(['a', 'y', 'x']);
  });

  it('cards solo arrastrables en modo manual y nunca las pinned/bulk', () => {
    const s = makeSession({ id: 's' });
    const pinned = makeSession({ id: 'p', pinned: true });
    const store = makeStore();
    boot(store, { s, p: pinned });

    store.dispatch({ type: A.SORT_CHANGED, sortBy: 'manual' });
    const html = SessionsView.render(store.getState());
    expect(html).toContain('draggable="true"');
    expect(html.match(/draggable="true"/g)?.length).toBe(1); // la pinned no

    store.dispatch({ type: A.SORT_CHANGED, sortBy: 'newest' });
    const html2 = SessionsView.render(store.getState());
    expect(html2).not.toContain('draggable="true"');
  });

  it('sortBar ofrece Manual con pista de arrastre', () => {
    const store = makeStore();
    boot(store, { a: makeSession({ id: 'a' }), b: makeSession({ id: 'b' }) });
    store.dispatch({ type: A.SORT_CHANGED, sortBy: 'manual' });
    const html = SessionsView.render(store.getState());
    expect(html).toContain('<option value="manual" selected');
    expect(html).toContain('drag to reorder');
  });

  it('workspace filtra visibleSessions; General = sin @workspace', () => {
    const ws = makeSession({ id: 'w', tags: ['@workspace:Work'] });
    const plain = makeSession({ id: 'g' });
    const store = makeStore();
    boot(store, { w: ws, g: plain });
    store.dispatch({ type: A.WORKSPACE_CHANGED, workspace: 'work' });
    expect(visibleIds(store)).toEqual(['w']);
    store.dispatch({ type: A.WORKSPACE_CHANGED, workspace: 'General' });
    expect(visibleIds(store)).toEqual(['g']);
  });

  it('filtros combinados: dominio parcial + solo pinned + rango', () => {
    const now = Date.now();
    const hit = makeSession({
      id: 'hit',
      pinned: true,
      updated: now - 2 * 86_400_000,
      groups: [makeGroup({ tabs: [makeTab({ url: 'https://mail.github.dev/x' })] })],
    });
    const miss = makeSession({
      id: 'miss',
      pinned: true,
      updated: now - 2 * 86_400_000,
      groups: [makeGroup({ tabs: [makeTab({ url: 'https://other.com/x' })] })],
    });
    const old = makeSession({ id: 'old', pinned: true, updated: now - 40 * 86_400_000 });
    const store = makeStore();
    boot(store, { hit, miss, old });
    store.dispatch({
      type: A.FILTERS_PATCHED,
      patch: { domain: 'github.dev', pinnedOnly: true, range: 'month' },
    });
    expect(visibleIds(store)).toEqual(['hit']);
  });

  it('tags de sesión y de tab alimentan chips y filtro', () => {
    const s = makeSession({
      id: 's',
      tags: ['archived'],
      groups: [makeGroup({ tags: ['docs'], tabs: [makeTab({ tags: ['spec'] })] })],
      ungroupedTabs: [makeTab({ tags: ['loose'] })],
    });
    const store = makeStore();
    boot(store, { s });
    expect(collectAllTags(store.getState())).toEqual(['archived', 'docs', 'loose', 'spec']);
    store.dispatch({ type: A.TAG_FILTER_TOGGLED, tag: 'spec' });
    expect(visibleIds(store)).toEqual(['s']);
    // chip mini de sesión presente en la card
    expect(SessionsView.render(store.getState())).toContain('session-tags-row');
  });

  it('botón Manage aparece cuando hay tags', () => {
    const store = makeStore();
    boot(store, { s: tagged() });
    expect(SessionsView.render(store.getState())).toContain('data-action="manage-tags"');
  });
});

function tagged() {
  return makeSession({ id: 't1', groups: [makeGroup({ tags: ['work'], tabs: [] })] });
}

/** @param {any} store */
function visibleIds(store) {
  // visibleSessions no se exporta; derivar vía render es frágil → usar pipeline:
  // importamos indirectamente a través de SessionsView.deps/render no sirve.
  // Solución: reordenar usando la vista (los data-id del HTML).
  const html = SessionsView.render(store.getState());
  /** @type {string[]} */
  const ids = [];
  for (const m of html.matchAll(/class="session-card" data-id="([^"]+)"/g)) ids.push(m[1]);
  return ids;
}

describe('SearchView sobre el motor nuevo', () => {
  it('chips de operadores presentes e insertables', () => {
    const store = makeStore();
    boot(store, {});
    const html = SearchView.render(store.getState());
    expect(html).toContain('insert-operator');
    expect(html).toContain('domain:');
    expect(html).toContain('in:name');
  });

  it('operador tag: filtra por tag de grupo vía el índice', () => {
    const comms = makeSession({ id: 'comms-sess', groups: [makeGroup({ tags: ['comms'], tabs: [] })] });
    const other = makeSession({ id: 'other-sess' });
    const store = makeStore();
    boot(store, { comms, other });
    store.dispatch({ type: A.SEARCH_QUERY_CHANGED, query: 'tag:comms' });
    const html = SearchView.render(store.getState());
    expect(html).toContain('search-result-group');
    expect(html).not.toContain('No results');
  });

  it('contador de resultados', () => {
    const store = makeStore();
    boot(store, {
      a: makeSession({ id: 'a', name: 'Alpha' }),
      b: makeSession({ id: 'b', name: 'Alphabet' }),
    });
    store.dispatch({ type: A.SEARCH_QUERY_CHANGED, query: 'alph' });
    expect(SearchView.render(store.getState())).toContain('2 sessions');
  });
});

describe('GroupsView multi-ventana (7.6)', () => {
  function twoWindowState() {
    const store = makeStore();
    boot(store, {});
    store.dispatch({
      type: A.LIVE_DATA_UPDATED,
      groups: [],
      ungrouped: [],
      windows: [
        {
          id: 1,
          focused: true,
          incognito: false,
          groups: [
            {
              id: 11,
              name: 'Docs',
              color: 'blue',
              tabs: [{ id: 111, title: 'T', url: 'https://x.y', favicon: '' }],
            },
          ],
          ungrouped: [],
        },
        {
          id: 2,
          focused: false,
          incognito: true,
          groups: [],
          ungrouped: [{ id: 222, title: 'U', url: 'https://u.v', favicon: '' }],
        },
      ],
      activeWindowId: 1,
    });
    return store;
  }

  it('selector de ventana con incognito marcado; oculto con una sola', () => {
    const store = twoWindowState();
    const html = GroupsView.render(store.getState());
    expect(html).toContain('live-window-select');
    expect(html).toContain('incognito');

    const single = makeStore();
    boot(single, {});
    single.dispatch({
      type: A.LIVE_DATA_UPDATED,
      groups: [],
      ungrouped: [],
      windows: [{ id: 5, focused: true, incognito: false, groups: [], ungrouped: [] }],
      activeWindowId: 5,
    });
    expect(GroupsView.render(single.getState())).not.toContain('live-window-select');
  });

  it('acciones por tab y guardar-grupo presentes en la ventana activa', () => {
    const store = twoWindowState();
    const html = GroupsView.render(store.getState());
    expect(html).toContain('data-action="save-group-session"');
    expect(html).toContain('data-action="live-tab-pin"');
    expect(html).toContain('data-action="live-tab-stash"');
    expect(html).toContain('data-action="live-tab-close"');
  });

  it('selectedWindowData cae a enfocada cuando el id no está', () => {
    const state = {
      liveWindows: [{ id: 7, focused: true, groups: [{ id: 1 }], ungrouped: [] }],
      activeWindowId: 999,
      liveGroups: [],
      liveUngrouped: [],
    };
    const sel = selectedWindowData(state);
    expect(sel.win?.id).toBe(7);
    expect(sel.groups.length).toBe(1);
  });
});

describe('DetailView · tags de sesión/tab (7.3)', () => {
  it('fila de tags de sesión + input con autocomplete + botón por tab', () => {
    const s = makeSession({
      id: 's',
      name: 'Tagged',
      tags: ['archived'],
      groups: [makeGroup({ id: 'g1', tabs: [makeTab({ id: 'tb' })] })],
    });
    const store = makeStore();
    boot(store, { s });
    store.dispatch({ type: A.NAVIGATED, view: 'detail', detailSessionId: 's' });
    const html = DetailView.render(store.getState());
    expect(html).toContain('remove-session-tag');
    expect(html).toContain('add-session-tag-input');
    expect(html).toContain('tv-tag-options'); // datalist compartido
    expect(html).toContain('data-action="add-tab-tag"');
  });
});

describe('comandos del Quick Switcher (7.2)', () => {
  it('ids únicos y matching case-insensitive con keywords', () => {
    const cmds = buildCommands({});
    const ids = cmds.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);

    expect(matchCommands(cmds, 'tema').map((c) => c.id)).toContain('toggle-theme');
    expect(matchCommands(cmds, 'TRASH')).toHaveLength(1);
    expect(matchCommands(cmds, '')).toHaveLength(cmds.length);
  });
});
