// tests/ui/views.test.js — Vistas como funciones puras de estado (Fase 4.2).
// Incluye el criterio de aceptación M8: editar una nota mientras llega un
// auto-save del SW NO pierde texto tras el re-render.

import { describe, it, expect } from 'vitest';
import { createStore } from '../../ui/store.js';
import { rootReducer, initialState, noteKey } from '../../ui/reducers.js';
import { A } from '../../ui/actions.js';
import { SessionsView, sortSessions, collectAllTags } from '../../ui/views/SessionsView.js';
import { DetailView } from '../../ui/views/DetailView.js';
import { SearchView } from '../../ui/views/SearchView.js';
import { TrashView } from '../../ui/views/TrashView.js';
import { SettingsView } from '../../ui/views/SettingsView.js';
import { GroupsView } from '../../ui/views/GroupsView.js';
import { makeSession, makeGroup, makeTab } from '../fixtures/sessions.js';

function makeStore() {
  return createStore(rootReducer, initialState());
}

const SETTINGS = { theme: 'dark', sortBy: 'newest', autoSaveMinutes: 0 };

/** @param {any} store @param {Record<string, import('../../shared/types.js').Session>} sessions */
function boot(store, sessions) {
  store.dispatch({
    type: A.APP_READY,
    sessions,
    trash: {},
    settings: SETTINGS,
    liveGroups: [],
    liveUngrouped: [],
  });
}

describe('SessionsView', () => {
  it('estado vacío sin sesiones', () => {
    const store = makeStore();
    boot(store, {});
    const html = SessionsView.render(store.getState());
    expect(html).toContain('No sessions yet');
    expect(html).toContain('save-cta');
  });

  it('mensaje distinto cuando hay filtro activo sin matches', () => {
    const s = makeSession({ id: 'a', groups: [makeGroup({ tags: ['work'] })] });
    const store = makeStore();
    boot(store, { a: s });
    store.dispatch({ type: A.TAG_FILTER_TOGGLED, tag: 'nope' });
    expect(SessionsView.render(store.getState())).toContain('No sessions match these filters');
    expect(SessionsView.render(store.getState())).toContain('Clear all filters');
  });

  it('pinta tarjetas con datos y pinned primero al ordenar', () => {
    const plain = makeSession({ id: 'plain', name: 'Plain', updated: 1000, pinned: false });
    const pinned = makeSession({ id: 'pin', name: 'Pinned', updated: 500, pinned: true });
    const sorted = sortSessions([plain, pinned], 'newest');
    expect(sorted[0].id).toBe('pin');

    const store = makeStore();
    boot(store, { plain, pin: pinned });
    const html = SessionsView.render(store.getState());
    expect(html).toContain('data-action="restore"');
    expect(html.indexOf('data-id="pin"')).toBeLessThan(html.indexOf('data-id="plain"'));
  });

  it('barra de filtros con todas las tags del vault', () => {
    const g1 = makeGroup({ tags: ['work'] });
    const g2 = makeGroup({ tags: ['news', 'work'] });
    const store = makeStore();
    boot(store, {
      a: makeSession({ id: 'a', groups: [g1] }),
      b: makeSession({ id: 'b', groups: [g2] }),
    });
    expect(collectAllTags(store.getState()).sort()).toEqual(['news', 'work']);
    expect(SessionsView.render(store.getState())).toContain('tag-filter-chip');
  });

  it('modo bulk añade checkboxes y respeta la selección', () => {
    const store = makeStore();
    boot(store, { a: makeSession({ id: 'a' }), b: makeSession({ id: 'b' }) });
    store.dispatch({ type: A.BULK_MODE_TOGGLED, on: true });
    store.dispatch({ type: A.BULK_CHECK_TOGGLED, id: 'a' });
    const html = SessionsView.render(store.getState());
    expect(html).toContain('bulk-check checked');
    expect(html).toContain('data-action="bulk-toggle"');
  });

  it('visibleSessions ordena por tabs correctamente', () => {
    const small = makeSession({
      id: 's',
      metadata: { groupCount: 0, tabCount: 3 },
      updated: 10,
    });
    const big = makeSession({
      id: 'b',
      metadata: { groupCount: 0, tabCount: 30 },
      updated: 20,
    });
    const out = sortSessions([small, big], 'tabs');
    expect(out[0].id).toBe('b');
  });

  it('escapa HTML en nombres de sesión (XSS inerte)', () => {
    const evil = makeSession({ id: 'e', name: '<script>alert(1)</script>' });
    const store = makeStore();
    boot(store, { e: evil });
    const html = SessionsView.render(store.getState());
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('DetailView · notas M8', () => {
  function detailSetup() {
    const tab = makeTab({ id: 't1', note: 'nota guardada' });
    const group = makeGroup({ id: 'g1', name: 'Work', tabs: [tab], note: '' });
    const session = makeSession({ id: 's1', groups: [group] });
    const store = makeStore();
    boot(store, { s1: session });
    store.dispatch({ type: A.NAVIGATED, view: 'detail', detailSessionId: 's1' });
    return { store, session };
  }

  it('renderiza la nota persistida por defecto', () => {
    const { store } = detailSetup();
    const html = DetailView.render(store.getState());
    expect(html).toContain('nota guardada');
    expect(html).toContain('data-action="note-tab"');
  });

  it('CRITERIO M8: draft + SESSIONS_SYNCED (auto-save del SW) conserva el texto', () => {
    const { store } = detailSetup();
    const key = noteKey('s1', 'g1', 't1');
    // usuario teclea…
    store.dispatch({ type: A.NOTE_DRAFT, key, value: 'escribiendo algo largo' });
    // …y en ese instante el SW auto-guarda y dispara onChanged
    const refreshed = makeSession({
      id: 's1',
      groups: [makeGroup({ id: 'g1', name: 'Work', tabs: [makeTab({ id: 't1' })] })],
    });
    store.dispatch({ type: A.SESSIONS_SYNCED, sessions: { s1: refreshed } });
    // el re-render muestra el BORRADOR, no lo persistido vacío
    const html = DetailView.render(store.getState());
    expect(html).toContain('escribiendo algo largo');
  });

  it('nota de grupo también usa borrador', () => {
    const { store } = detailSetup();
    const key = noteKey('s1', 'g1', null);
    store.dispatch({ type: A.NOTE_DRAFT, key, value: 'group draft' });
    expect(DetailView.render(store.getState())).toContain('group draft');
  });

  it('sesión inexistente no revienta la vista', () => {
    const store = makeStore();
    boot(store, {});
    store.dispatch({ type: A.NAVIGATED, view: 'detail', detailSessionId: 'ghost' });
    expect(DetailView.render(store.getState())).toContain('Session gone');
  });

  it('sección de versiones: placeholder mientras carga y lista al llegar', () => {
    const { store } = detailSetup();
    store.dispatch({ type: A.VERSIONS_TOGGLED });
    expect(DetailView.render(store.getState())).toContain('Loading history…');
    store.dispatch({
      type: A.VERSIONS_LOADED,
      sessionId: 's1',
      versions: [{ savedAt: 123, snapshot: { metadata: { tabCount: 4, groupCount: 1 } } }],
    });
    const html = DetailView.render(store.getState());
    expect(html).toContain('version-item');
    expect(html).toContain('data-action="restore-version"');
    expect(html).toContain('4 tabs');
  });
});

describe('SearchView', () => {
  it('sin query muestra sesiones recientes', () => {
    const store = makeStore();
    boot(store, { a: makeSession({ id: 'a', name: 'Recent one' }) });
    expect(SearchView.render(store.getState())).toContain('Recent sessions');
  });

  it('con query lista tabs matcheadas con href seguro', () => {
    const tab = makeTab({ url: 'https://github.com/x' });
    const store = makeStore();
    boot(store, {
      a: makeSession({ id: 'a', ungroupedTabs: [tab] }),
    });
    store.dispatch({ type: A.SEARCH_QUERY_CHANGED, query: 'example' });
    const html = SearchView.render(store.getState());
    expect(html).toContain('search-tab-item');
    expect(html).toContain('https://github.com/x');
  });

  it('URL javascript: se renderiza pero NUNCA como href navegable (C8 defensa)', () => {
    const evil = makeTab({ url: 'javascript:alert(1)', title: 'evil' });
    const store = makeStore();
    boot(store, { a: makeSession({ id: 'a', ungroupedTabs: [evil] }) });
    store.dispatch({ type: A.SEARCH_QUERY_CHANGED, query: 'evil' });
    const html = SearchView.render(store.getState());
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="#"');
  });
});

describe('TrashView y SettingsView', () => {
  it('papelera vacía y con elementos', () => {
    const store = makeStore();
    boot(store, {});
    expect(TrashView.render(store.getState())).toContain('Trash is empty');
    store.dispatch({
      type: A.TRASH_SYNCED,
      trash: { t: makeSession(/** @type {any} */ ({ id: 't', deletedAt: 99 })) },
    });
    const html = TrashView.render(store.getState());
    expect(html).toContain('trash-card');
    expect(html).toContain('data-action="restore-trash"');
  });

  it('settings refleja toggles y selects actuales', () => {
    const store = makeStore();
    boot(store, {});
    store.dispatch({
      type: A.SETTINGS_PATCHED,
      patch: { autoSaveMinutes: 15, dedupeOnRestore: true, trashPurgeDays: 60 },
    });
    const html = SettingsView.render(store.getState());
    expect(html).toContain('<option value="15" selected');
    expect(html).toContain('toggle-switch on');
    expect(html).toContain('<option value="60" selected');
    expect(html).toMatch(/aria-pressed="true"/);
  });

  it('GroupsView muestra grupos vivos y estado expandido', () => {
    const store = makeStore();
    boot(store, {});
    store.dispatch({
      type: A.LIVE_DATA_UPDATED,
      groups: [
        {
          id: 7,
          name: 'Docs',
          color: 'blue',
          tabs: [{ id: 1, title: 'T', url: 'https://x.y', favicon: '' }],
        },
      ],
      ungrouped: [],
    });
    let html = GroupsView.render(store.getState());
    expect(html).toContain('Docs');
    expect(html).not.toContain('expanded');
    store.dispatch({ type: A.EXPANSION_TOGGLED, key: 'live-7' });
    html = GroupsView.render(store.getState());
    expect(html).toContain('expanded');
  });
});
