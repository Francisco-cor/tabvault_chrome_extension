// tests/core/fase8repo.test.js — Fase 8 en Repository: import con estrategias
// (update/keep-both/skip), backup 'pre-import' SIEMPRE previo, ring-buffer de
// backups, restoreBackup con undo natural y round-trip export→wipe→import.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Repository } from '../../core/repository.js';
import { installChromeMock } from '../mocks/chrome.js';
import { makeSession, makeGroup, makeTab } from '../fixtures/sessions.js';

/** @type {ReturnType<typeof installChromeMock>} */
let mock;
/** @type {Repository} */
let repo;

beforeEach(() => {
  mock = installChromeMock();
  repo = new Repository({ writable: true });
});

afterEach(() => mock.unmock());

/** El reloj de Windows tiene granularidad ~15ms: los ts de backups deben distinguirse. */
const tick = (/** @type {number} */ ms = 35) => new Promise((r) => setTimeout(r, ms));

const fileFor = (/** @type {any[]} */ sessions) =>
  JSON.stringify({
    _tabvault: true,
    version: 3,
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
  });

const seedExisting = async () => {
  await repo.saveSession(
    makeSession({
      id: 's1',
      name: 'Original',
      pinned: true,
      order: 3,
      openCount: 7,
      lastOpened: 123,
      ungroupedTabs: [makeTab({ id: 't-old', url: 'https://old.dev' })],
    })
  );
};

describe('importAll — merge inteligente (8.1)', () => {
  it("strategy 'update': actualiza contenido y PRESERVA estado local del vault", async () => {
    await seedExisting();
    const incoming = makeSession({
      id: 's1',
      name: 'Incoming',
      ungroupedTabs: [makeTab({ id: 't-new', url: 'https://new.dev' })],
    });
    const res = await repo.importAll(fileFor([incoming]), {
      mode: 'merge',
      strategy: 'update',
    });

    const s = await repo.getSession('s1');
    expect(res.updated).toBe(1);
    expect(s?.name).toBe('Incoming');
    expect(s?.ungroupedTabs[0]?.url).toContain('new.dev');
    // estado local intacto
    expect(s?.pinned).toBe(true);
    expect(s?.order).toBe(3);
    expect(s?.openCount).toBe(7);
    // backup pre-import capturó el estado ANTERIOR
    const rings = await repo.getBackups();
    expect(rings.event[0]?.label).toBe('pre-import');
    expect(rings.event[0]?.data.sessions?.s1?.name).toBe('Original');
  });

  it("strategy 'keep-both' (default): colisión → id nuevo, nada se pisa", async () => {
    await seedExisting();
    const res = await repo.importAll(fileFor([makeSession({ id: 's1', name: 'Copy' })]), {
      mode: 'merge',
    });
    const sessions = await repo.getSessions();
    expect(Object.keys(sessions)).toHaveLength(2);
    expect(res.added).toBe(1);
    expect(res.updated).toBe(0);
    const copy = Object.values(sessions).find((s) => s.name === 'Copy');
    expect(copy?.id).not.toBe('s1');
  });

  it('skipIncomingIds omite sesiones similares Y sus versiones', async () => {
    await seedExisting();
    const similar = makeSession({
      id: 'dup-1',
      name: 'Similar',
      ungroupedTabs: [makeTab({ url: 'https://old.dev' })],
    });
    const fresh = makeSession({ id: 'fresh-1', name: 'Fresh' });
    const json = JSON.stringify({
      _tabvault: true,
      sessions: { 'dup-1': similar, 'fresh-1': fresh },
      versions: { 'dup-1': [{ snapshot: makeSession({ id: 'dup-1' }), savedAt: 1 }] },
    });
    const res = await repo.importAll(json, { mode: 'merge', skipIncomingIds: ['dup-1'] });
    expect(res.skipped).toBe(1);
    expect(res.imported).toBe(1);
    const versions = /** @type {any} */ ((await mock.dumpLocal()).versions);
    expect(versions['dup-1']).toBeUndefined();
  });

  it('JSON inválido falla SIN crear backup ni tocar storage', async () => {
    await seedExisting();
    const before = mock.dumpLocal();
    await expect(repo.importAll('{not-json', { mode: 'replace' })).rejects.toThrow(/Invalid JSON/);
    await expect(repo.importAll('{"nope":1}', { mode: 'replace' })).rejects.toThrow(/Not a valid TabVault/);
    expect(mock.dumpLocal().sessions).toEqual(before.sessions);
    const rings = await repo.getBackups();
    expect(rings.event).toHaveLength(0);
  });
});

describe('backups automáticos (8.3)', () => {
  it('createBackup diario: sin datos → null; con datos → entrada sin favicons', async () => {
    expect(await repo.createBackup('daily')).toBeNull();

    await repo.saveSession(
      makeSession({
        groups: [makeGroup({ tabs: [makeTab({ favicon: 'data:image/png;base64,X' })] })],
      })
    );
    const entry = await repo.createBackup('daily');
    expect(entry?.counts.tabs).toBe(1);
    expect(JSON.stringify(entry?.data)).not.toContain('data:image');

    const stored = /** @type {any} */ ((await mock.dumpLocal()).backups);
    expect(stored.daily).toHaveLength(1);
    expect(stored.event).toHaveLength(0); // manual/daily no tocan el anillo event
  });

  it('ring cap: 8 diarios rotan al más viejo fuera', async () => {
    await repo.saveSession(makeSession({ id: 'x' }));
    for (let i = 0; i < 8; i++) {
      await tick();
      await repo.createBackup('daily');
    }
    const rings = await repo.getBackups();
    expect(rings.daily).toHaveLength(7);
  });

  it('restoreBackup: restaura el punto Y respalda el estado actual como pre-restore', async () => {
    await seedExisting();
    const good = await repo.createBackup('manual');
    // mutación destructiva posterior
    await repo.deleteSession('s1');
    expect(await repo.getSession('s1')).toBeNull();

    await tick(); // asegura ts distinto para el snapshot pre-restore
    const res = await repo.restoreBackup(/** @type {any} */ (good).ts);
    expect(res.restored).toBe(true);
    const s = await repo.getSession('s1');
    expect(s?.name).toBe('Original');

    // undo natural: el estado "roto" quedó como pre-restore
    const rings = await repo.getBackups();
    const pre = rings.event.find((e) => e.label === 'pre-restore');
    expect(pre?.data.trash?.s1).toBeTruthy();
  });

  it('restoreBackup de ts desconocido lanza', async () => {
    await expect(repo.restoreBackup(42)).rejects.toThrow(/Backup not found/);
  });

  it('deleteBackup elimina por ts', async () => {
    await repo.saveSession(makeSession());
    const a = await repo.createBackup('manual');
    await repo.deleteBackup(/** @type {any} */ (a).ts);
    const rings = await repo.getBackups();
    expect(rings.event).toHaveLength(0);
  });

  it('exportAll NUNCA incluye el propio ring de backups', async () => {
    await repo.saveSession(makeSession({ id: 'keep' }));
    await repo.createBackup('daily');
    expect(mock.dumpLocal().backups).toBeTruthy();
    const exported = JSON.parse(await repo.exportAll());
    expect(exported.backups).toBeUndefined();
    expect(exported.sessions.keep).toBeTruthy();
  });
});

describe('CRITERIO round-trip: export → wipe → import = estado idéntico', () => {
  it('byte a byte tras normalizar', async () => {
    // Estado rico: favicons, notas, tags, pinned/order/openCount, papelera,
    // versiones y settings personalizadas.
    await repo.saveSession(
      makeSession({
        id: 'rich',
        name: 'Rich',
        tags: ['work'],
        order: 2,
        openCount: 4,
        lastOpened: 999,
        isTemplate: true,
        groups: [
          makeGroup({
            name: 'G',
            color: 'blue',
            tags: ['g-tag'],
            note: 'group note',
            tabs: [
              makeTab({
                favicon:
                  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                note: 'tab note',
                tags: ['t-tag'],
                pinned: true,
              }),
              makeTab(),
            ],
          }),
        ],
        ungroupedTabs: [makeTab({ note: 'loose', tags: ['loose'] })],
      })
    );
    await repo.saveSession(makeSession({ id: 'plain' }));
    await repo.deleteSession('plain'); // → papelera
    await repo.saveVersion('rich');
    await repo.saveSettings({ theme: 'light', accent: 'green', dupThreshold: 90, syncEnabled: false });

    const snapshotBefore = pickVaultKeys(mock.dumpLocal());
    const exported = await repo.exportAll();

    // wipe total + import replace
    await chrome.storage.local.clear();
    repo.invalidate();
    const res = await repo.importAll(exported, { mode: 'replace' });
    expect(res.mode).toBe('replace');
    expect(res.imported).toBe(1);

    const after = pickVaultKeys(mock.dumpLocal());
    expect(after.sessions).toEqual(snapshotBefore.sessions);
    expect(after.trash).toEqual(snapshotBefore.trash);
    expect(after.versions).toEqual(snapshotBefore.versions);
    expect(after.settings).toEqual(snapshotBefore.settings);
  });
});

/** Solo las claves que el round-trip garantiza. @param {Record<string, any>} dump */
function pickVaultKeys(dump) {
  return {
    sessions: dump.sessions ?? {},
    trash: dump.trash ?? {},
    versions: dump.versions ?? {},
    settings: dump.settings ?? {},
  };
}
