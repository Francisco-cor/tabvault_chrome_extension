// tests/core/organization.test.js — Organización pura (Fase 7):
// propagación global de tags, workspaces, orden manual y filtros serializables.

import { describe, it, expect } from 'vitest';
import {
  collectTags,
  renameTagEverywhere,
  deleteTagEverywhere,
  sessionWorkspace,
  workspacesOf,
  filterByWorkspace,
  applyManualOrder,
  moveIdInList,
  serializeFilters,
  parseFilters,
  applyCombinedFilters,
  passesDateRange,
  WORKSPACE_PREFIX,
} from '../../core/organization.js';
import { makeSession, makeGroup, makeTab } from '../fixtures/sessions.js';

const DAY = 86_400_000;
const NOW = 1_700_200_000_000;

/** @param {{ tag?: string, groupTag?: string, tabTags?: string[] }} [o] */
function taggedSession({ tag = 'work', groupTag = 'docs', tabTags = ['code'] } = {}) {
  return makeSession({
    id: 's1',
    tags: [tag],
    groups: [
      makeGroup({ id: 'g1', name: 'G', tags: [groupTag], tabs: [makeTab({ id: 't1', tags: tabTags })] }),
    ],
    ungroupedTabs: [makeTab({ id: 't2', tags: ['loose'] })],
  });
}

describe('collectTags', () => {
  it('inventaria los tres niveles', () => {
    const rows = collectTags({ s1: taggedSession() });
    const byTag = Object.fromEntries(rows.map((r) => [r.tag, r]));
    expect(byTag['work']).toMatchObject({ sessions: 1, groups: 0, tabs: 0 });
    expect(byTag['docs']).toMatchObject({ sessions: 1, groups: 1, tabs: 0 });
    expect(byTag['code']).toMatchObject({ sessions: 1, groups: 0, tabs: 1 });
    expect(byTag['loose']).toMatchObject({ sessions: 1, groups: 0, tabs: 1 });
  });

  it('case-insensitive: Work y work son la misma fila', () => {
    const a = makeSession({ id: 'a', tags: ['Work'] });
    const b = makeSession({ id: 'b', groups: [makeGroup({ tags: ['work'], tabs: [] })] });
    const rows = collectTags({ a, b });
    expect(rows.filter((r) => r.tag.toLowerCase() === 'work')).toHaveLength(1);
  });
});

describe('renameTagEverywhere — CRITERIO DE ACEPTACIÓN Fase 7', () => {
  it('propaga en sesiones + grupos + tabs de UNA pasada y es pura', () => {
    const before = taggedSession();
    const { sessions, entities } = renameTagEverywhere({ s1: before }, 'work', 'trabajo');

    const after = /** @type {any} */ (sessions).s1;
    expect(after.tags).toEqual(['trabajo']);
    expect(after.groups[0].tabs[0].tags).toEqual(['code']); // otras intactas
    expect(entities).toBeGreaterThanOrEqual(1);
    expect(before.tags).toEqual(['work']); // original sin mutar
  });

  it('fusionar sobre una existente NO duplica y respeta mayúsculas del target', () => {
    const s = makeSession({
      id: 's',
      tags: ['Work'],
      groups: [makeGroup({ id: 'g', tabs: [makeTab({ id: 't', tags: ['work'] })] })],
    });
    const { sessions } = renameTagEverywhere({ s }, 'work', 'Trabajo');
    const out = /** @type {any} */ (sessions).s;
    expect(out.tags.filter((/** @type {string} */ t) => t.toLowerCase() === 'trabajo')).toHaveLength(1);
    expect(out.groups[0].tabs[0].tags).toEqual(['Trabajo']);
  });

  it('tags inexistentes → sin cambios e identidad preservada', () => {
    const map = { s: taggedSession() };
    const res = renameTagEverywhere(map, 'nope', 'x');
    expect(res.entities).toBe(0);
    expect(res.sessions.s).toBe(map.s);
  });
});

describe('deleteTagEverywhere', () => {
  it('borra en todos los niveles dejando el resto intacto', () => {
    const { sessions, entities } = deleteTagEverywhere({ s1: taggedSession() }, 'work');
    const after = /** @type {any} */ (sessions).s1;
    expect(after.tags).toEqual([]);
    expect(after.groups[0].tabs[0].tags).toEqual(['code']);
    expect(after.groups[0].tags).toEqual(['docs']);
    expect(entities).toBeGreaterThanOrEqual(1);
  });
});

describe('workspaces', () => {
  const inWork = makeSession({ id: 'w', tags: [`${WORKSPACE_PREFIX}Trabajo`] });
  const byTab = makeSession({
    id: 'p',
    groups: [makeGroup({ tabs: [makeTab({ tags: [`${WORKSPACE_PREFIX}personal`] })] })],
  });
  const plain = makeSession({ id: 'g' });
  const all = { w: inWork, p: byTab, g: plain };

  it('derivación por prioridad; sin workspace → General', () => {
    expect(sessionWorkspace(inWork)).toBe('Trabajo');
    expect(sessionWorkspace(byTab)).toBe('personal');
    expect(sessionWorkspace(plain)).toBe('');
  });

  it('descubre workspaces con conteos', () => {
    expect(workspacesOf(all)).toEqual([
      { name: 'personal', count: 1 },
      { name: 'Trabajo', count: 1 },
    ]);
  });

  it('filtro todos / específico / General', () => {
    expect(filterByWorkspace(Object.values(all), '')).toHaveLength(3);
    expect(filterByWorkspace(Object.values(all), 'TRABAJO').map((s) => s.id)).toEqual(['w']);
    expect(filterByWorkspace(Object.values(all), 'General').map((s) => s.id)).toEqual(['g']);
  });
});

describe('orden manual', () => {
  it('applyManualOrder asigna 1-based en orden visual', () => {
    expect(applyManualOrder(['c', 'a', 'b'])).toEqual({ c: 1, a: 2, b: 3 });
  });

  it('moveIdInList ajusta el hueco y detecta no-ops', () => {
    const ids = ['a', 'b', 'c'];
    // b → antes de a: el hueco desplaza el objetivo
    expect(moveIdInList(ids, 'b', 0, true)).toEqual(['b', 'a', 'c']);
    // mismo lugar → misma referencia (no-op)
    expect(moveIdInList(ids, 'b', 1, true)).toBe(ids);
    // id inexistente → no-op
    expect(moveIdInList(ids, 'zzz', 0, true)).toBe(ids);
    // al final
    expect(moveIdInList(ids, 'a', 2, false)).toEqual(['b', 'c', 'a']);
  });
});

describe('filtros combinados serializables', () => {
  it('round-trip serialize ↔ parse', () => {
    /** @type {import('../../core/organization.js').ActiveFilters} */
    const f = { domain: 'github.com', range: 'week', pinnedOnly: true };
    const parsed = parseFilters(`#${serializeFilters(f)}`);
    expect(parsed).toEqual(f);
  });

  it('defaults se omiten y parse es tolerante a basura', () => {
    expect(serializeFilters({ domain: '', range: 'any', pinnedOnly: false })).toBe('');
    expect(parseFilters('#r=bignum&d=&zz=1&p=x')).toEqual(emptyDefaults());
    expect(parseFilters(null)).toEqual(emptyDefaults());
    expect(parseFilters('#d=a%2Fb').domain).toBe('a/b');
  });

  function emptyDefaults() {
    return { domain: '', range: 'any', pinnedOnly: false };
  }

  it('passesDateRange con reloj inyectable', () => {
    expect(passesDateRange(NOW - 2 * DAY, 'today', NOW)).toBe(false);
    expect(passesDateRange(NOW - 2 * DAY, 'week', NOW)).toBe(true);
    expect(passesDateRange(NOW - 40 * DAY, 'month', NOW)).toBe(false);
    expect(passesDateRange(NOW - 40 * DAY, 'any', NOW)).toBe(true);
  });

  it('applyCombinedFilters combina pinned + rango + dominio', () => {
    const mk = (/** @type {string} */ id, /** @type {any} */ over = {}) =>
      makeSession({
        id,
        updated: NOW - 2 * DAY,
        groups: [makeGroup({ tabs: [makeTab({ url: `https://${id}.dev/x` })] })],
        ...over,
      });
    const list = [
      mk('alpha.dev', { pinned: true }),
      mk('beta.com'),
      mk('gamma.io', { updated: NOW - 90 * DAY }),
    ];
    const out = applyCombinedFilters(list, { domain: 'dev', range: 'week', pinnedOnly: true }, NOW);
    expect(out.map((s) => s.id)).toEqual(['alpha.dev']);
  });
});
