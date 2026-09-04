// tests/ui/reducers.test.js — Reducers puros de la UI (Fase 4.1).
// Cubre navegación, filtros, bulk, borradores de notas (M8), expansion, settings.

import { describe, it, expect } from 'vitest';
import { A } from '../../ui/actions.js';
import { rootReducer, initialState, noteKey } from '../../ui/reducers.js';
import { makeSession, makeGroup, makeTab } from '../fixtures/sessions.js';

const boot = (extra = {}) =>
  rootReducer(initialState(), {
    type: A.APP_READY,
    sessions: {},
    trash: {},
    settings: { theme: 'dark', sortBy: 'newest' },
    liveGroups: [],
    liveUngrouped: [],
    ...extra,
  });

describe('reducers · ciclo de vida', () => {
  it('APP_READY marca ready y carga datos', () => {
    const s = rootReducer(initialState(), {
      type: A.APP_READY,
      sessions: { a: makeSession({ id: 'a' }) },
      trash: {},
      settings: { theme: 'light', sortBy: 'az' },
      liveGroups: [{ id: 1 }],
      liveUngrouped: [],
    });
    expect(s.ready).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.sessions.a).toBeTruthy();
    expect(s.theme).toBe('light');
    expect(s.sortBy).toBe('az');
  });

  it('acciones desconocidas no cambian nada', () => {
    const s = boot();
    expect(rootReducer(s, { type: 'NOPE' })).toBe(s);
  });
});

describe('reducers · sync reactivo', () => {
  it('SESSIONS_SYNCED reemplaza sesiones pero PRESERVA borradores de notas (M8)', () => {
    let s = boot({
      sessions: { a: makeSession({ id: 'a' }) },
    });
    const key = noteKey('a', null, 't1');
    s = rootReducer(s, { type: A.NOTE_DRAFT, key, value: 'texto en vuelo' });
    s = rootReducer(s, {
      type: A.SESSIONS_SYNCED,
      sessions: { a: makeSession({ id: 'a', updated: 999 }) },
    });
    expect(s.notes[key]).toBe('texto en vuelo');
  });

  it('NOTE_DRAFT_CLEARED elimina solo esa clave', () => {
    let s = boot();
    s = rootReducer(s, { type: A.NOTE_DRAFT, key: 'k1', value: 'x' });
    s = rootReducer(s, { type: A.NOTE_DRAFT, key: 'k2', value: 'y' });
    s = rootReducer(s, { type: A.NOTE_DRAFT_CLEARED, key: 'k1' });
    expect(Object.keys(s.notes)).toEqual(['k2']);
  });

  it('TRASH_SYNCED reemplaza papelera', () => {
    let s = boot();
    s = rootReducer(s, { type: A.TRASH_SYNCED, trash: { t: makeSession({ id: 't' }) } });
    expect(Object.keys(s.trash)).toEqual(['t']);
  });
});

describe('reducers · navegación', () => {
  it('NAVIGATED a detalle fija detailSessionId y resetea bulk/kb/versions', () => {
    let s = boot();
    s = rootReducer(s, { type: A.BULK_MODE_TOGGLED, on: true });
    s = rootReducer(s, { type: A.BULK_CHECK_TOGGLED, id: 'a' });
    s = rootReducer(s, { type: A.KB_INDEX_MOVED, index: 3 });
    s = rootReducer(s, { type: A.NAVIGATED, view: 'detail', detailSessionId: 'a' });
    expect(s.view).toBe('detail');
    expect(s.detailSessionId).toBe('a');
    expect(s.bulkMode).toBe(false);
    expect(s.bulkSelected).toEqual([]);
    expect(s.kbIndex).toBe(-1);
    expect(s.showVersions).toBe(false);
  });

  it('NAVIGATED limpia la búsqueda salvo al entrar a search', () => {
    let s = boot();
    s = rootReducer(s, { type: A.SEARCH_QUERY_CHANGED, query: 'git' });
    s = rootReducer(s, { type: A.NAVIGATED, view: 'sessions' });
    expect(s.searchQuery).toBe('');
    s = rootReducer(s, { type: A.SEARCH_QUERY_CHANGED, query: 'git' });
    s = rootReducer(s, { type: A.NAVIGATED, view: 'search' });
    expect(s.searchQuery).toBe('git');
  });

  it('VIEW_BACK vuelve a la vista sin tocar filtros ni expansión', () => {
    let s = boot();
    s = rootReducer(s, { type: A.TAG_FILTER_TOGGLED, tag: 'x' });
    s = rootReducer(s, { type: A.EXPANSION_TOGGLED, key: 'live-7' });
    s = rootReducer(s, { type: A.VIEW_BACK, view: 'sessions' });
    expect(s.view).toBe('sessions');
    expect(s.filterTags).toEqual(['x']);
    expect(s.expanded).toContain('live-7');
  });
});

describe('reducers · filtros y orden', () => {
  it('TAG_FILTER_TOGGLED añade y quita', () => {
    let s = boot();
    s = rootReducer(s, { type: A.TAG_FILTER_TOGGLED, tag: 'work' });
    s = rootReducer(s, { type: A.TAG_FILTER_TOGGLED, tag: 'news' });
    expect(s.filterTags).toEqual(['work', 'news']);
    s = rootReducer(s, { type: A.TAG_FILTER_TOGGLED, tag: 'work' });
    expect(s.filterTags).toEqual(['news']);
  });

  it('SORT_CHANGED cambia el criterio', () => {
    let s = boot();
    s = rootReducer(s, { type: A.SORT_CHANGED, sortBy: 'tabs' });
    expect(s.sortBy).toBe('tabs');
  });
});

describe('reducers · bulk', () => {
  it('BULK_MODE_TOGGLED activa y limpia la selección', () => {
    let s = boot();
    s = rootReducer(s, { type: A.BULK_CHECK_TOGGLED, id: 'a' });
    s = rootReducer(s, { type: A.BULK_MODE_TOGGLED, on: true });
    expect(s.bulkMode).toBe(true);
    expect(s.bulkSelected).toEqual([]);
  });

  it('BULK_CHECK_TOGGLED alterna ids', () => {
    let s = boot();
    s = rootReducer(s, { type: A.BULK_MODE_TOGGLED, on: true });
    s = rootReducer(s, { type: A.BULK_CHECK_TOGGLED, id: 'a' });
    s = rootReducer(s, { type: A.BULK_CHECK_TOGGLED, id: 'b' });
    expect(s.bulkSelected).toEqual(['a', 'b']);
    s = rootReducer(s, { type: A.BULK_CHECK_TOGGLED, id: 'a' });
    expect(s.bulkSelected).toEqual(['b']);
  });
});

describe('reducers · UI miscelánea', () => {
  it('EXPANSION_TOGGLED alterna claves', () => {
    let s = boot();
    s = rootReducer(s, { type: A.EXPANSION_TOGGLED, key: 'live-ungrouped' });
    expect(s.expanded).toEqual(['live-ungrouped']);
    s = rootReducer(s, { type: A.EXPANSION_TOGGLED, key: 'live-ungrouped' });
    expect(s.expanded).toEqual([]);
  });

  it('KB_INDEX_MOVED acepta enteros y no baja de -1', () => {
    let s = boot();
    s = rootReducer(s, { type: A.KB_INDEX_MOVED, index: -5 });
    expect(s.kbIndex).toBe(-1);
    s = rootReducer(s, { type: A.KB_INDEX_MOVED, index: 4.9 });
    expect(s.kbIndex).toBe(4);
  });

  it('PINNED actualiza solo esa sesión', () => {
    const s0 = boot({ sessions: { a: makeSession({ id: 'a' }), b: makeSession({ id: 'b' }) } });
    const s = rootReducer(s0, { type: A.PINNED, id: 'a', pinned: true });
    expect(s.sessions.a.pinned).toBe(true);
    expect(s.sessions.b.pinned).toBeFalsy();
    expect(s0.sessions.a.pinned).toBeFalsy(); // inmutabilidad
  });

  it('SETTINGS_PATCHED hace merge superficial', () => {
    let s = boot({ settings: { theme: 'dark', sortBy: 'newest', autoSaveMinutes: 0 } });
    s = rootReducer(s, { type: A.SETTINGS_PATCHED, patch: { autoSaveMinutes: 15 } });
    expect(s.settings.autoSaveMinutes).toBe(15);
    expect(s.settings.theme).toBe('dark');
  });

  it('LIVE_DATA_UPDATED reemplaza grupos vivos', () => {
    let s = boot();
    s = rootReducer(s, {
      type: A.LIVE_DATA_UPDATED,
      groups: [{ id: 5, tabs: [makeTab()] }],
      ungrouped: [makeTab()],
    });
    expect(s.liveGroups[0].id).toBe(5);
    expect(s.liveUngrouped.length).toBe(1);
  });

  it('noteKey es estable por sesión/grupo/tab', () => {
    expect(noteKey('s', 'g', 't')).toBe('s|g|t');
    expect(noteKey('s', null, 't')).toBe('s||t');
    expect(noteKey('s', 'g', null)).toBe('s|g|');
  });
});

describe('reducers · grupos con estructura real', () => {
  it('las sesiones cargadas mantienen sus grupos (C5 ya muerto, sanity check)', () => {
    const g = makeGroup({ name: 'Work', tabs: [makeTab()] });
    const s = boot({ sessions: { a: makeSession({ id: 'a', groups: [g] }) } });
    expect(s.sessions.a.groups[0].name).toBe('Work');
    expect(s.sessions.a.groups[0].tabs.length).toBe(1);
  });
});
