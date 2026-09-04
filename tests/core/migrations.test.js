// tests/core/migrations.test.js — Versionado de esquema: backup, idempotencia, saneo

import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION, migrateIfNeeded } from '../../core/migrations.js';

/** Adapter en memoria que imita chrome.storage.local para migraciones
 * @param {Record<string, unknown>} [initial={}]
 */
function memoryAdapter(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    /** @param {any} keys @returns {Promise<any>} */
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      /** @type {any} */
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (store.has(k)) out[k] = structuredClone(store.get(k));
      }
      return out;
    },
    /** @param {object} obj @returns {Promise<void>} */
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
    },
  };
}

const logs = () => {
  /** @type {string[]} */
  const out = [];
  return { out, log: (/** @type {string} */ m) => out.push(m) };
};

describe('migrateIfNeeded', () => {
  it('storage vacío → estampa versión sin backup', async () => {
    const a = memoryAdapter();
    const { out, log } = logs();
    const res = await migrateIfNeeded(a, log);
    expect(res).toEqual({ migrated: true, from: 0, to: SCHEMA_VERSION });
    expect(res.backupKey).toBeUndefined();
    expect(a.store.get('meta')).toEqual({ schemaVersion: SCHEMA_VERSION });
    expect(out.length).toBeGreaterThanOrEqual(0);
  });

  it('legacy v2 con datos → normaliza sesiones y crea backup', async () => {
    const legacySession = {
      id: 'old1',
      name: '  Legacy  ',
      created: 123,
      updated: 123,
      groups: [{ id: 'g1', name: 'G', color: 'magenta', tabs: [{ url: 'https://x.dev' }] }],
      // sin ungroupedTabs ni metadata
    };
    const a = memoryAdapter({ sessions: { old1: legacySession }, settings: { theme: 'light' } });
    const res = await migrateIfNeeded(a, () => {});

    expect(res.migrated).toBe(true);
    expect(res.backupKey).toMatch(new RegExp(`^backup_preMigration_v0_v${SCHEMA_VERSION}_\\d+$`));

    const migrated = /** @type {any} */ (a.store.get('sessions')).old1;
    expect(migrated.name).toBe('Legacy'); // trim
    expect(migrated.ungroupedTabs).toEqual([]);
    expect(migrated.metadata).toEqual({ groupCount: 1, tabCount: 1 });
    expect(migrated.groups[0].color).toBe('purple'); // color inválido reparado

    const settings = /** @type {any} */ (a.store.get('settings'));
    expect(settings.theme).toBe('light');
    expect(settings.trashPurgeDays).toBe(30); // default añadido

    // el backup conserva el estado previo intacto
    const backup = a.store.get(/** @type {string} */ (res.backupKey));
    expect(/** @type {any} */ (backup).sessions.old1.metadata).toBeUndefined();
  });

  it('IDEMPOTENCIA: correr dos veces produce el mismo resultado', async () => {
    const initial = {
      sessions: {
        s1: { id: 's1', name: 'A', created: 1, updated: 1, groups: [], ungroupedTabs: [] },
      },
    };
    const a = memoryAdapter(structuredClone(initial));
    const first = await migrateIfNeeded(a, () => {});
    const snapshotAfterFirst = JSON.stringify([...a.store.entries()].sort());

    const second = await migrateIfNeeded(a, () => {});
    const snapshotAfterSecond = JSON.stringify([...a.store.entries()].sort());

    expect(second.migrated).toBe(false);
    expect(snapshotAfterSecond).toBe(snapshotAfterFirst);
    expect(first.to).toBe(SCHEMA_VERSION);
  });

  it('versión futura (> actual del código) es no-op seguro', async () => {
    const a = memoryAdapter({ meta: { schemaVersion: 99 }, sessions: {} });
    const res = await migrateIfNeeded(a, () => {});
    expect(res.migrated).toBe(false);
    expect(res.from).toBe(99);
    expect(/** @type {any} */ (a.store.get('meta')).schemaVersion).toBe(99);
  });
});
