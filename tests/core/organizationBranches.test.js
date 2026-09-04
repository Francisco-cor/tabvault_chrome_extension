// tests/core/organizationBranches.test.js — Branches de core/organization.js:
// collectTags con shapes hostiles, rename/delete no-ops, workspaces, filtros.

import { describe, it, expect } from 'vitest';
import {
  collectTags,
  renameTagEverywhere,
  deleteTagEverywhere,
  workspacesOf,
  sessionWorkspace,
  parseFilters,
  serializeFilters,
  emptyFilters,
} from '../../core/organization.js';

/** @param {string[]} tags */
const tab = (tags) => ({
  id: 't',
  url: 'https://x.com',
  title: 'x',
  favicon: '',
  note: '',
  tags,
  savedAt: 1,
});
/** @param {string[]} tags @param {any[]} [tabs] */
const group = (tags, tabs = []) => ({ id: 'g', name: 'G', color: 'blue', tags, note: '', tabs });
/** @param {Record<string, any>} [over] @returns {any} */
const session = (over = {}) => ({
  id: 's1',
  name: 'S',
  created: 1,
  updated: 1,
  groups: [],
  ungroupedTabs: [],
  ...over,
});

describe('collectTags (branches de shapes hostiles)', () => {
  it('null/undefined → []', () => {
    expect(collectTags(/** @type {any} */ (null))).toEqual([]);
    expect(collectTags(/** @type {any} */ (undefined))).toEqual([]);
  });

  it('recorre sesión+grupos+tabs y deduplica con conteos s/g/t', () => {
    const sessions = {
      s1: session({
        tags: ['work'],
        groups: [group(['work', 'code'], [tab(['code']), tab([])])],
        ungroupedTabs: [tab(['urgent'])],
      }),
    };
    const out = collectTags(sessions);
    const byTag = Object.fromEntries(out.map((t) => [t.tag, t]));
    // 'work': sesión directa + grupo → sessions 2 (comportamiento shipped); sin tabs
    expect(byTag['work']).toMatchObject({ sessions: 2, groups: 1, tabs: 0 });
    expect(byTag['code']).toMatchObject({ sessions: 1, groups: 1, tabs: 1 });
    expect(byTag['urgent']).toMatchObject({ sessions: 1, groups: 0, tabs: 1 });
  });

  it('contrato: las tags son strings (schema normaliza); no-string lanza', () => {
    const sessions = {
      s1: session({ tags: [/** @type {any} */ (null)] }),
    };
    expect(() => collectTags(sessions)).toThrow();
  });
});

describe('renameTagEverywhere / deleteTagEverywhere (no-ops y casos límite)', () => {
  const rich = session({
    tags: ['a'],
    groups: [group(['a'], [tab(['a'])])],
    ungroupedTabs: [tab(['a', 'b'])],
  });

  it('from/to vacíos o iguales → sin cambios (entities 0)', () => {
    expect(renameTagEverywhere({ s1: rich }, '', 'x').entities).toBe(0);
    expect(renameTagEverywhere({ s1: rich }, 'a', '').entities).toBe(0);
    expect(renameTagEverywhere({ s1: rich }, 'a', 'A').entities).toBe(0); // mismo tras lowercase
    expect(renameTagEverywhere(/** @type {any} */ (null), 'a', 'b').entities).toBe(0);
  });

  it('deleteTag con tag vacía → 0; con tag presente → 4 entidades', () => {
    expect(deleteTagEverywhere({ s1: rich }, '').entities).toBe(0);
    expect(deleteTagEverywhere(/** @type {any} */ (null), 'a').entities).toBe(0);
    const { sessions, entities } = deleteTagEverywhere({ s1: rich }, 'a');
    expect(entities).toBe(4); // sesión + grupo + tab grupo + tab ungrouped
    expect(sessions.s1.tags).toEqual([]);
    expect(sessions.s1.groups[0].tags).toEqual([]);
    expect(sessions.s1.groups[0].tabs[0].tags).toEqual([]);
    expect(sessions.s1.ungroupedTabs[0].tags).toEqual(['b']);
  });
});

describe('workspaces (branches)', () => {
  it('isWorkspaceTag en sesión, grupo y tab; General excluye', () => {
    const sessions = {
      s1: session({ tags: ['@workspace:alpha'] }),
      s2: session({ groups: [group(['@workspace:beta'])] }),
      s3: session({ ungroupedTabs: [tab(['@workspace:gamma'])] }),
      s4: session({ tags: ['plain'] }),
    };
    const out = workspacesOf(sessions);
    const names = out.map((w) => w.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
    expect(sessionWorkspace(/** @type {any} */ (sessions.s1))).toBe('alpha');
    expect(sessionWorkspace(/** @type {any} */ (sessions.s4))).toBe('');
  });

  it('workspacesOf con entrada hostil → []', () => {
    expect(workspacesOf(/** @type {any} */ (null))).toEqual([]);
  });
});

describe('parseFilters / serializeFilters (tolerancia y round-trip)', () => {
  it('hash basura → filtros vacíos sin lanzar', () => {
    expect(parseFilters('#&&&###')).toEqual(emptyFilters());
    expect(parseFilters('%%')).toEqual(emptyFilters());
    expect(parseFilters('#d=')).toEqual(emptyFilters());
  });

  it('round-trip de dominio/rango/pin', () => {
    const f = /** @type {any} */ ({
      ...emptyFilters(),
      domain: 'github.com',
      range: 'week',
      pinnedOnly: true,
    });
    const hash = serializeFilters(f);
    expect(parseFilters('#' + hash)).toEqual(f);
  });

  it('pares sin "=" → clave con valor vacío', () => {
    const f = parseFilters('#d');
    expect(f).toEqual(emptyFilters());
  });
});
