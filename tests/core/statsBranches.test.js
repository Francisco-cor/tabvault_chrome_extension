// tests/core/statsBranches.test.js — Cobertura de branches de core/stats.js:
// entradas hostiles, grupos+ungrouped, límites, racha y empates de orden.

import { describe, it, expect } from 'vitest';
import {
  domainStats,
  topDomains,
  activityLast30Days,
  mostRepeatedTabs,
  usageStreak,
  estimateStorageBytes,
  computeStats,
} from '../../core/stats.js';

const NOW = new Date('2026-08-24T12:00:00').getTime();
const DAY = 86_400_000;
const startToday = new Date(NOW);
startToday.setHours(0, 0, 0, 0);
const T0 = startToday.getTime();

/** @param {string[]} groupUrls @param {string[]} [ungroupedUrls] @returns {any} */
const mkSession = (groupUrls, ungroupedUrls = []) => ({
  id: 's',
  name: 's',
  created: T0,
  updated: T0,
  groups: groupUrls.length
    ? [
        {
          id: 'g',
          name: 'G',
          color: 'blue',
          tabs: groupUrls.map((u, i) => ({
            id: `g${i}`,
            url: u,
            title: u,
            favicon: '',
            note: '',
            tags: [],
            savedAt: 1,
          })),
        },
      ]
    : [],
  ungroupedTabs: ungroupedUrls.map((u, i) => ({
    id: `u${i}`,
    url: u,
    title: u,
    favicon: '',
    note: '',
    tags: [],
    savedAt: 1,
  })),
});

describe('domainStats / topDomains (branches)', () => {
  it('null/undefined → ceros sin lanzar; URLs inválidas no cuentan dominio', () => {
    expect(domainStats(/** @type {any} */ (null))).toEqual({
      sessionCount: 0,
      tabCount: 0,
      domainCount: 0,
      domains: new Map(),
    });
    const out = domainStats({ a: mkSession([], ['no-es-url', 'https://ok.dev/x']) });
    expect(out.tabCount).toBe(2); // la tab inválida cuenta como tab
    expect(out.domainCount).toBe(1);
  });

  it('suma tabs de groups Y ungrouped; www se normaliza', () => {
    const out = domainStats({ a: mkSession(['https://www.gh.com/a'], ['https://gh.com/b']) });
    expect(out.tabCount).toBe(2);
    expect(out.domains.get('gh.com')).toBe(2);
  });

  it('topDomains: orden desc por count, empate alfabético, límite', () => {
    const sessions = {
      a: mkSession([], ['https://b.com/1', 'https://a.com/1', 'https://a.com/2', 'https://c.com/1']),
    };
    expect(topDomains(/** @type {any} */ (sessions), 2)).toEqual([
      { host: 'a.com', count: 2 },
      { host: 'b.com', count: 1 },
    ]);
    expect(topDomains(/** @type {any} */ ({}), 5)).toEqual([]);
  });
});

describe('activityLast30Days (branches)', () => {
  it('sin created → bucket ignorado; futuro dentro de hoy → bucket 29', () => {
    const sessions = {
      sin: { ...mkSession([]), created: 0 },
      futuro: { ...mkSession([]), created: T0 + 3600_000 },
    };
    const buckets = activityLast30Days(/** @type {any} */ (sessions), NOW);
    expect(buckets[29]).toBe(1);
    expect(buckets.slice(0, 29).every((n) => n === 0)).toBe(true);
  });

  it('hace 29 días entra en bucket 0; hace 30 días queda fuera', () => {
    const sessions = {
      borde: { ...mkSession([]), created: T0 - 29 * DAY },
      fuera: { ...mkSession([]), created: T0 - 30 * DAY },
    };
    const buckets = activityLast30Days(/** @type {any} */ (sessions), NOW);
    expect(buckets[0]).toBe(1);
    expect(buckets[1]).toBe(0);
  });
});

describe('mostRepeatedTabs (branches)', () => {
  it('solo count>1; título del primer avistamiento; límite y empates', () => {
    const sessions = {
      a: mkSession(
        [],
        ['https://x.com/1', 'https://x.com/1', 'https://y.com/1', 'https://y.com/1', 'https://z.com/1']
      ),
      b: mkSession([], ['https://x.com/1']),
    };
    const out = mostRepeatedTabs(/** @type {any} */ (sessions), 1);
    expect(out).toEqual([{ url: 'https://x.com/1', title: 'https://x.com/1', count: 3 }]);
    expect(mostRepeatedTabs(/** @type {any} */ ({}))).toEqual([]);
  });

  it('título custom se conserva del primer match', () => {
    const s = {
      a: {
        ...mkSession([]),
        ungroupedTabs: [
          { id: '1', url: 'https://q.com/', title: 'Bonito', favicon: '', note: '', tags: [], savedAt: 1 },
          { id: '2', url: 'https://q.com/', title: 'Feo', favicon: '', note: '', tags: [], savedAt: 2 },
        ],
      },
    };
    const out = mostRepeatedTabs(/** @type {any} */ (s));
    expect(out[0].title).toBe('Bonito');
  });
});

describe('usageStreak (branches)', () => {
  it('hoy + ayer + anteayer = 3; sin hoy = 0; futuro del día cuenta como hoy', () => {
    const three = {
      a: { ...mkSession([]), created: T0 },
      b: { ...mkSession([]), created: T0 - DAY },
      c: { ...mkSession([]), created: T0 - 2 * DAY },
    };
    expect(usageStreak(/** @type {any} */ (three), NOW)).toBe(3);

    const yesterdayOnly = { a: { ...mkSession([]), created: T0 - DAY } };
    expect(usageStreak(/** @type {any} */ (yesterdayOnly), NOW)).toBe(0);

    const futureToday = { a: { ...mkSession([]), created: T0 + 3600_000 } };
    expect(usageStreak(/** @type {any} */ (futureToday), NOW)).toBe(1);

    expect(usageStreak(/** @type {any} */ ({}), NOW)).toBe(0);
    expect(usageStreak({ a: { ...mkSession([]), created: 0 } }, NOW)).toBe(0);
  });

  it('actividad >365 días no cuenta (cap de ventana)', () => {
    const old = { a: { ...mkSession([]), created: T0 - 400 * DAY } };
    expect(usageStreak(/** @type {any} */ (old), NOW)).toBe(0);
  });
});

describe('estimateStorageBytes / computeStats', () => {
  it('estimación JSON; computeStats agrega todo', () => {
    expect(estimateStorageBytes({})).toBeGreaterThan(0);
    const sessions = /** @type {any} */ ({
      a: mkSession(['https://gh.com/a'], ['https://gh.com/b']),
    });
    const trash = /** @type {any} */ ({ gone: { ...mkSession([]), deletedAt: 1 } });
    const stats = computeStats(sessions, trash, NOW);
    expect(stats).toMatchObject({
      sessionCount: 1,
      tabCount: 2,
      domainCount: 1,
      trashCount: 1,
      streak: 1,
    });
    expect(stats.storageBytes).toBe(JSON.stringify(sessions).length);
    expect(stats.activity[29]).toBe(1);
  });
});
