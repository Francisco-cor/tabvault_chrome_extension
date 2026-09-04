// tests/ui/statsView.test.js — StatsView (Fase 9.1): render puro de KPIs, barras
// y sparkline sobre el estado; vacío cuando no hay sesiones.

import { describe, it, expect } from 'vitest';
import { StatsView } from '../../ui/views/StatsView.js';
import { initialState } from '../../ui/reducers.js';

const NOW = 1_700_000_000_000;
/** @param {string} id @param {string[]} tabs @returns {any} */
const mkSession = (id, tabs) => ({
  id,
  name: `S ${id}`,
  created: NOW - 86_400_000, // ayer: cuenta en el sparkline de 30 días
  updated: NOW,
  groups: [],
  ungroupedTabs: tabs.map((/** @type {string} */ url, /** @type {number} */ i) => ({
    id: `${id}t${i}`,
    url,
    title: url,
    favicon: '',
    note: '',
    tags: [],
    savedAt: 1,
  })),
  metadata: { groupCount: 0, tabCount: tabs.length },
});

describe('StatsView.render', () => {
  it('vault vacío → empty state', () => {
    const state = { ...initialState(), ready: true, sessions: {}, trash: {}, now: NOW };
    const html = StatsView.render(state);
    expect(html).toContain('empty-state');
  });

  it('con sesiones → KPIs, top dominios y sparkline', () => {
    const sessions = {
      a: mkSession('a', ['https://github.com/1', 'https://github.com/2', 'https://x.dev/3']),
      b: mkSession('b', ['https://github.com/4', 'https://y.dev/5']),
    };
    const state = { ...initialState(), ready: true, sessions, trash: {}, now: NOW };
    const html = StatsView.render(state);
    expect(html).toContain('stats-view');
    expect(html).toContain('stat-card');
    expect(html).toContain('stats-bars');
    expect(html).toContain('sparkline');
    expect(html).toContain('github.com'); // top dominio
    // valores escapados, sin crudos
    expect(html).not.toContain('<script');
  });

  it('deps incluye sesiones/trash/now (firma estable)', () => {
    const state = { ...initialState(), sessions: {}, trash: {}, now: 5 };
    expect(StatsView.deps(state)).toEqual([{}, {}, 5]);
  });
});
