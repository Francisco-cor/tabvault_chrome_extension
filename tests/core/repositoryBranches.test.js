// tests/core/repositoryBranches.test.js — Branches restantes de Repository:
// guards de sesión inexistente, índices fuera de rango, caps de rutinas/reglas,
// importAll con archivo enorme, sync de settings y getUsagePercent sin cuota.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { Repository } from '../../core/repository.js';

/** @type {ReturnType<typeof installChromeMock>} */
let h;

/** @param {string} id @param {string[]} [urls] @returns {any} */
const mkSession = (id, urls = ['https://a.com/x', 'https://b.com/y']) => ({
  id,
  name: `S ${id}`,
  created: 1,
  updated: 1,
  groups: urls.length
    ? [
        {
          id: `${id}g`,
          name: 'G',
          color: 'blue',
          tags: [],
          note: '',
          tabs: urls.map((u, i) => ({
            id: `${id}t${i}`,
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
  ungroupedTabs: [],
  metadata: { groupCount: urls.length ? 1 : 0, tabCount: urls.length },
});

beforeEach(() => {
  h = installChromeMock();
  h.reset();
});
afterEach(() => {
  h.unmock();
  h.reset();
});

async function seededRepo() {
  const repo = new Repository({ writable: true });
  repo.attach();
  await repo.saveSession(mkSession('r1'));
  return repo;
}

describe('guards de entidad inexistente / índices', () => {
  it('togglePin de sesión ausente → false sin escribir', async () => {
    const repo = await seededRepo();
    expect(await repo.togglePin('ghost')).toBe(false);
  });

  it('reorderTabs/reorderGroups fuera de rango o sesión ausente → undefined', async () => {
    const repo = await seededRepo();
    expect(await repo.reorderTabs('ghost', null, 0, 1)).toBeUndefined();
    expect(await repo.reorderTabs('r1', null, -1, 0)).toBeUndefined();
    expect(await repo.reorderTabs('r1', null, 0, 99)).toBeUndefined();
    expect(await repo.reorderGroups('ghost', 0, 1)).toBeUndefined();
    expect(await repo.reorderGroups('r1', 0, 5)).toBeUndefined();
  });

  it('moveTabToGroup: tab ausente, sesión ausente → undefined', async () => {
    const repo = await seededRepo();
    expect(await repo.moveTabToGroup('ghost', 't', null, null)).toBeUndefined();
    expect(await repo.moveTabToGroup('r1', 'nope', null, null)).toBeUndefined();
    expect(await repo.moveTabToGroup('r1', 'r1t0', null, 'grupo-fantasma')).toBeUndefined();
  });

  it('removeTabFromSession/removeGroupFromSession de sesión ausente lanzan', async () => {
    const repo = await seededRepo();
    await expect(repo.removeTabFromSession('ghost', null, 'x')).rejects.toThrow(/not found/i);
    await expect(repo.removeGroupFromSession('ghost', 'g')).rejects.toThrow(/not found/i);
  });

  it('addTabToSession de sesión ausente lanza', async () => {
    const repo = await seededRepo();
    await expect(
      repo.addTabToSession('ghost', /** @type {any} */ ({ url: 'https://ok.dev' }))
    ).rejects.toThrow(/not found/i);
  });

  it('setTabTags de sesión/tab ausente lanza', async () => {
    const repo = await seededRepo();
    await expect(repo.setTabTags('ghost', null, 't', ['x'])).rejects.toThrow(/not found/i);
    await expect(repo.setTabTags('r1', null, 'nope', ['x'])).rejects.toThrow(/Tab not found/i);
  });

  it('saveVersion de sesión ausente → undefined; deleteSession ausente no-op', async () => {
    const repo = await seededRepo();
    expect(await repo.saveVersion('ghost')).toBeUndefined();
    await repo.deleteSession('ghost'); // no lanza
  });

  it('mergeSessions sin fuentes válidas → sesión vacía nueva (comportamiento shipped)', async () => {
    const repo = await seededRepo();
    const merged = await repo.mergeSessions(['ghost'], 'Nueva');
    expect(merged.metadata.tabCount).toBe(0);
    expect(merged.name).toBe('Nueva');
  });

  it('deleteSessions mezcla existentes y ausentes sin romper', async () => {
    const repo = await seededRepo();
    await repo.saveSession(mkSession('r2', []));
    await repo.deleteSessions(['r1', 'ghost']);
    const trash = await repo.getTrash();
    expect(trash.r1).toBeTruthy();
    expect(trash.r2).toBeUndefined();
  });
});

describe('rutinas y reglas: caps y errores', () => {
  it('saveRoutine inválido lanza; toggleRoutine ausente lanza; deleteRoutine ausente no-op', async () => {
    const repo = new Repository({ writable: true });
    await expect(repo.saveRoutine({ sessionId: '', time: '09:00' })).rejects.toThrow(/Invalid routine/);
    await expect(repo.saveRoutine({ sessionId: 's', time: '99:00' })).rejects.toThrow(/Invalid routine/);
    await expect(repo.toggleRoutine('ghost')).rejects.toThrow(/not found/i);
    await repo.deleteRoutine('ghost'); // no lanza
  });

  it('saveAutoTagRule: sin pattern/tag lanza; cap 50 lanza; update existente ok', async () => {
    const repo = new Repository({ writable: true });
    await expect(repo.saveAutoTagRule({ pattern: '', tag: 't' })).rejects.toThrow(/required/);
    for (let i = 0; i < 50; i++) await repo.saveAutoTagRule({ id: `r${i}`, pattern: `p${i}`, tag: 't' });
    await expect(repo.saveAutoTagRule({ pattern: 'nuevo', tag: 't' })).rejects.toThrow(/Max 50/);
    const updated = await repo.saveAutoTagRule({ id: 'r0', pattern: 'p0-updated', tag: 't2' });
    expect(updated.pattern).toBe('p0-updated');
  });

  it('setAutoTagRules normaliza el lote completo', async () => {
    const repo = new Repository({ writable: true });
    const out = await repo.setAutoTagRules(
      /** @type {any} */ ([{ id: 'a', pattern: 'X.com', tag: 't' }, 'basura'])
    );
    expect(out).toEqual([{ id: 'a', pattern: 'x.com', tag: 't' }]);
  });
});

describe('importAll / backups: límites', () => {
  it('archivo > IMPORT_CHARS lanza; no-JSON lanza', async () => {
    const repo = new Repository({ writable: true });
    await expect(repo.importAll('x'.repeat(20_000_001))).rejects.toThrow(/too large/i);
    await expect(repo.importAll('{nope')).rejects.toThrow(/Invalid JSON/);
  });

  it('restoreBackup de ts inexistente lanza; deleteBackup filtra ambos anillos', async () => {
    const repo = await seededRepo();
    await repo.createBackup('manual');
    await expect(repo.restoreBackup(42)).rejects.toThrow(/not found/i);
    const rings = await repo.getBackups();
    const ts = rings.event[0]?.ts ?? rings.daily[0]?.ts;
    await repo.deleteBackup(/** @type {number} */ (ts));
    const after = await repo.getBackups();
    expect(after.daily.length + after.event.length).toBe(0);
  });

  it('import merge con skipIncomingIds y estrategia update', async () => {
    const repo = await seededRepo();
    const incoming = {
      _tabvault: true,
      version: 4,
      sessions: {
        r1: mkSession('r1', ['https://nueva.com/z']),
        extra: mkSession('extra', []),
      },
    };
    const res = await repo.importAll(JSON.stringify(incoming), {
      mode: 'merge',
      strategy: 'update',
      skipIncomingIds: ['extra'],
    });
    expect(res.skipped).toBe(1);
    expect(res.updated).toBe(1);
    const after = await repo.getSessions();
    expect(after.extra).toBeUndefined();
    expect(after.r1.ungroupedTabs.length).toBe(0);
    expect(after.r1.groups[0].tabs[0].url).toBe('https://nueva.com/z');
  });
});

describe('settings sync + cuota', () => {
  it('saveSettings con syncEnabled replica a storage.sync', async () => {
    const repo = new Repository({ writable: true });
    await repo.saveSettings({ syncEnabled: true, theme: 'light' });
    const synced = await repo.loadSyncSettings();
    expect(synced?.theme).toBe('light');
    expect(synced?.syncEnabled).toBe(true);
  });

  it('getUsagePercent sin QUOTA_BYTES → 0', async () => {
    const repo = new Repository({ writable: true });
    delete (/** @type {any} */ (h.chrome.storage.local).QUOTA_BYTES);
    expect(await repo.getUsagePercent()).toBe(0);
  });
});
