// tests/core/repository.test.js — Repositorio transaccional: serialización, coherencia, validación.
// Sustituye a tests/shared/storage.test.js (StorageManager eliminado).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Repository } from '../../core/repository.js';
import { sessionToMarkdown } from '../../core/exporters/markdown.js';
import { installChromeMock } from '../mocks/chrome.js';
import { makeSession, makeGroup, makeTab } from '../fixtures/sessions.js';

/** @type {ReturnType<typeof installChromeMock>} */
let mock;
/** @type {Repository} */
let repo;
/** @type {Repository} */
let reader;

beforeEach(() => {
  mock = installChromeMock();
  repo = new Repository({ writable: true });
  reader = new Repository({ writable: false });
  repo.attach();
  reader.attach();
});

afterEach(() => {
  mock.unmock();
  vi.useRealTimers();
});

const seed = async (over = {}) => {
  const s = makeSession(over);
  await repo.saveSession(s);
  return s.id;
};

describe('CRUD básico', () => {
  it('saveSession normaliza y sella updated', async () => {
    const id = await seed({ id: 's1', name: 'A' });
    const saved = await repo.getSession(id);
    expect(saved?.name).toBe('A');
    expect(saved?.updated).toBeGreaterThanOrEqual(saved?.created ?? 0);
    // metadata recalculada aunque venga mentirosa
    await seed({
      id: 's2',
      groups: [makeGroup({ tabs: [makeTab()] })],
      metadata: { groupCount: 9, tabCount: 0 },
    });
    expect((await repo.getSession('s2'))?.metadata).toEqual({ groupCount: 1, tabCount: 1 });
  });

  it('getSession devuelve null para desconocidos', async () => {
    expect(await repo.getSession('nope')).toBeNull();
  });

  it('updateSession lanza si no existe; mezcla patch si existe', async () => {
    await expect(repo.updateSession('ghost', { name: 'x' })).rejects.toThrow(/not found/);
    await seed({ id: 's1', name: 'old' });
    const upd = await repo.updateSession('s1', { name: 'new', pinned: true });
    expect(upd).toMatchObject({ name: 'new', pinned: true });
  });

  it('updateSession con patch hostil repara en vez de corromper', async () => {
    await seed({ id: 's1' });
    const out = await repo.updateSession(
      's1',
      /** @type {any} */ ({
        groups: 'no-soy-array',
        ungroupedTabs: [{ url: 'javascript:x' }, { url: 'https://ok.dev' }],
        metadata: { groupCount: 999, tabCount: 999 },
      })
    );
    expect(out.groups).toEqual([]);
    expect(out.ungroupedTabs).toHaveLength(1);
    expect(out.metadata.tabCount).toBe(1);
  });
});

describe('Coherencia de caché (fix C2)', () => {
  it('escritura EXTERNA es visible sin invalidate() manual', async () => {
    await seed({ id: 's1' });
    expect(await repo.getSession('s1')).not.toBeNull();

    // escritura "externa" simulando al otro contexto
    const cur = /** @type {{ sessions: Record<string, unknown> }} */ (
      await chrome.storage.local.get('sessions')
    );
    cur.sessions.s2 = makeSession({ id: 's2', name: 'from-sw' });
    await chrome.storage.local.set({ sessions: cur.sessions });

    // el listener onChanged debe refrescar la caché automáticamente
    const seen = await repo.getSession('s2');
    expect(seen?.name).toBe('from-sw');

    // y también para el lector (popup)
    expect((await reader.getSession('s2'))?.name).toBe('from-sw');
  });

  it('subscribe() notifica el área tocada tras escrituras propias y externas', async () => {
    /** @type {string[]} */
    const events = [];
    const off = reader.subscribe((area) => events.push(area));
    await seed({ id: 'x1' }); // escritura propia → set dispara onChanged del mock
    off();
    expect(events).toContain('sessions');
  });

  it('invalidate() sigue funcionando como escape manual', async () => {
    await seed({ id: 'a' });
    reader.invalidate();
    expect(Object.keys(await reader.getSessions())).toEqual(['a']);
  });
});

describe('Serialización (fix C3) — estrés de concurrencia', () => {
  it('200 operaciones concurrentes → estado final exacto, 0 lost updates', async () => {
    const N = 200;
    /** @type {Promise<unknown>[]} */
    const pending = [];

    // 100 creaciones + 100 updates sobre la misma sesión, TODOS lanzados sin await
    for (let i = 0; i < N / 2; i++) {
      pending.push(repo.saveSession(makeSession({ id: `bulk-${i}`, name: `n${i}`, ungroupedTabs: [] })));
    }
    for (let i = 0; i < N / 2; i++) {
      pending.push(repo.updateSession('bulk-0', { name: `iter-${i}` }));
    }
    await Promise.allSettled(pending);

    const sessions = await repo.getSessions();
    // las 100 sesiones creadas existen
    for (let i = 0; i < N / 2; i++) {
      expect(sessions[`bulk-${i}`]).toBeDefined();
    }
    // la sesión martillada conserva el ÚLTIMO nombre encolado (FIFO garantizado)
    expect(sessions['bulk-0'].name).toBe(`iter-${N / 2 - 1}`);
  });

  it('mezcla crea/borra/pin concurrente sin corrupción estructural', async () => {
    /** @type {Promise<unknown>[]} */
    const ops = [];
    for (let i = 0; i < 50; i++) ops.push(repo.saveSession(makeSession({ id: `m-${i}` })));
    for (let i = 0; i < 20; i++) ops.push(repo.deleteSession(`m-${i}`));
    for (let i = 20; i < 30; i++) ops.push(repo.togglePin(`m-${i}`));
    await Promise.allSettled(ops);

    const sessions = await repo.getSessions();
    const trash = await repo.getTrash();
    expect(Object.keys(sessions)).toHaveLength(30); // m-20..m-49
    expect(Object.keys(trash)).toHaveLength(20); // m-0..m-19
    for (let i = 20; i < 30; i++) expect(sessions[`m-${i}`].pinned).toBe(true);
  });

  it('un fallo en la cola no bloquea a las siguientes operaciones', async () => {
    await seed({ id: 'keep' });
    await expect(repo.updateSession('ghost', { name: 'x' })).rejects.toThrow();
    const ok = await repo.updateSession('keep', { name: 'after-error' });
    expect(ok.name).toBe('after-error');
  });
});

describe('Read-only enforcement (ADR-0002)', () => {
  it('mutaciones desde contexto no-writable lanzan ReadOnlyError (sync)', async () => {
    await seed({ id: 'ro' });
    // _assertWritable lanza ANTES de crear la promesa → throw síncrono
    expect(() => reader.updateSession('ro', { name: 'x' })).toThrow(/repoClient|writable/);
    expect(() => reader.saveSettings({ theme: 'light' })).toThrow(ReadOnlyErrorName);
    // lectura sí permitida
    expect(await reader.getSession('ro')).not.toBeNull();
  });
});

/** matcher por nombre para no depender del export interno */
const ReadOnlyErrorName = /requiere contexto writable/;

describe('Papelera', () => {
  it('delete → trash con deletedAt; restore quita deletedAt y conserva pinned', async () => {
    await seed({ id: 'p1', pinned: true, name: 'Pinned' });
    await repo.deleteSession('p1');
    expect(await repo.getSession('p1')).toBeNull();

    const restored = await repo.restoreFromTrash('p1');
    expect(restored.pinned).toBe(true);
    expect(/** @type {any} */ (restored).deletedAt).toBeUndefined();
    expect(Object.keys(await repo.getTrash())).toHaveLength(0);
  });

  it('restoreFromTrash lanza si no está', async () => {
    await expect(repo.restoreFromTrash('nope')).rejects.toThrow(/Not in trash/);
  });

  it('purgeOldTrash respeta días custom', async () => {
    const now = Date.now();
    await chrome.storage.local.set({
      trash: {
        old: { ...makeSession({ id: 'old' }), deletedAt: now - 10 * 86_400_000 },
        fresh: { ...makeSession({ id: 'fresh' }), deletedAt: now - 86_400_000 },
      },
    });
    repo.invalidate();
    const changed = await repo.purgeOldTrash(7);
    expect(changed).toBe(true);
    const trash = await repo.getTrash();
    expect(trash.old).toBeUndefined();
    expect(trash.fresh).toBeDefined();
  });

  it('deletePermanently limpia versiones huérfanas', async () => {
    await seed({ id: 'dp' });
    await repo.saveVersion('dp');
    await repo.deleteSession('dp');
    await repo.deletePermanently('dp');
    expect(await repo.getVersions('dp')).toHaveLength(0);
    expect(Object.keys(await repo.getTrash())).toHaveLength(0);
  });
});

describe('Merge', () => {
  it('ids regenerados en todo el árbol; originales intactos', async () => {
    const a = makeSession({
      id: 'ma',
      groups: [makeGroup({ tabs: [makeTab({ url: 'https://a.io' })] })],
      ungroupedTabs: [],
    });
    const b = makeSession({ id: 'mb', ungroupedTabs: [makeTab({ url: 'https://b.io' })] });
    await repo.saveSession(a);
    await repo.saveSession(b);

    const merged = await repo.mergeSessions(['ma', 'mb'], 'Combo');
    expect(merged.groups[0].id).not.toBe(a.groups[0].id);
    expect(merged.groups[0].tabs[0].id).not.toBe(a.groups[0].tabs[0].id);
    expect(merged.ungroupedTabs[0].id).not.toBe(b.ungroupedTabs[0].id);
    expect((await repo.getSession('ma'))?.id).toBe('ma'); // original vivo
    expect(Object.keys(await repo.getSessions()).sort()).toEqual([merged.id, 'ma', 'mb'].sort());
  });

  it('sourceIds inexistentes se ignoran sin romper', async () => {
    const merged = await repo.mergeSessions(['ghost'], '');
    expect(merged.name).toBe('Merged Session');
    expect(merged.metadata.tabCount).toBe(0);
  });
});

describe('Versionado', () => {
  it('saveVersion strip favicons + cap 5; restoreVersion RE-ADJUNTA favicons por URL', async () => {
    const fav = 'data:image/png;base64,F';
    const s = makeSession({
      id: 'v',
      groups: [makeGroup({ tabs: [{ ...makeTab({ url: 'https://k.dev/x' }), favicon: fav }] })],
      ungroupedTabs: [],
    });
    Object.assign(/** @type {any} */ (s), { _score: 9 });
    await repo.saveSession(s);

    for (let i = 0; i < 7; i++) {
      await repo.updateSession('v', { name: `iter-${i}` });
      await repo.saveVersion('v');
    }
    let versions = await repo.getVersions('v');
    expect(versions).toHaveLength(5);
    const newest = /** @type {any} */ (versions[0]?.snapshot);
    expect(newest.name).toBe('iter-6');
    expect(newest._score).toBeUndefined();
    expect(newest.groups[0].tabs[0].favicon).toBe('');

    // mutar estado actual (cambia nombre) y restaurar versión 0
    await repo.updateSession('v', { name: 'actual' });
    await repo.restoreVersion('v', 0);

    const after = /** @type {any} */ (await repo.getSession('v'));
    expect(after.name).toBe('iter-6');
    // FIX clave: el favicon vuelve vía re-adjunto por URL
    expect(after.groups[0].tabs[0].favicon).toBe(fav);
    // el estado previo quedó versionado
    versions = await repo.getVersions('v');
    const previous = /** @type {any} */ (versions[0]?.snapshot);
    expect(previous.name).toBe('actual');
  });

  it('restoreVersion índice inválido lanza', async () => {
    await seed({ id: 'r2' });
    await expect(repo.restoreVersion('r2', 5)).rejects.toThrow(/not found/i);
  });
});

describe('Edición estructural', () => {
  beforeEach(async () => {
    await chrome.storage.local.set({
      sessions: {
        e: makeSession({
          id: 'e',
          groups: [makeGroup({ id: 'g1', tabs: [makeTab({ id: 't1' })] }), makeGroup({ id: 'g2', tabs: [] })],
          ungroupedTabs: [makeTab({ id: 'u1' })],
        }),
      },
    });
    repo.invalidate();
  });

  it('reorderTabs fuera de rango no-op (quirk preservado)', async () => {
    expect(await repo.reorderTabs('e', 'g1', 0, 99)).toBeUndefined();
    expect((await repo.getSession('e'))?.groups[0]?.tabs.map((t) => t.id)).toEqual(['t1']);
  });

  it('moveTabToGroup borra grupo fuente vacío y recalcula metadata', async () => {
    const out = await repo.moveTabToGroup('e', 't1', 'g1', 'g2');
    expect(out?.groups.map((g) => g.id)).toEqual(['g2']);
    expect(out?.groups[0].tabs.map((t) => t.id)).toEqual(['t1']);
    expect(out?.metadata.tabCount).toBe(2);
  });

  it('moveTabToGroup a destino inexistente NO pierde la tab', async () => {
    const before = (await repo.getSession('e'))?.metadata.tabCount;
    await repo.moveTabToGroup('e', 't1', 'g1', 'fantasma');
    const after = await repo.getSession('e');
    expect(after?.metadata.tabCount).toBe(before);
    expect(after?.groups.find((g) => g.id === 'g1')?.tabs).toHaveLength(1);
  });

  it('addTabToSession rechaza URL insegura', async () => {
    await expect(repo.addTabToSession('e', /** @type {any} */ ({ url: 'javascript:x' }))).rejects.toThrow(
      /Invalid tab/
    );
    const out = await repo.addTabToSession('e', makeTab({ id: 'nuevo' }));
    expect(out.ungroupedTabs.map((t) => t.id)).toContain('nuevo');
  });

  it('removeTab/removeGroup recalculan metadata', async () => {
    await repo.removeGroupFromSession('e', 'g2');
    const s1 = await repo.getSession('e');
    expect(s1?.metadata.groupCount).toBe(1);
    await repo.removeTabFromSession('e', 'g1', 't1');
    const s2 = await repo.getSession('e');
    expect(s2?.groups).toHaveLength(0); // poda de grupo vacío
    expect(s2?.metadata.tabCount).toBe(1); // queda u1
  });
});

describe('Settings', () => {
  it('defaults normalizados + persisten + sync opcional', async () => {
    const def = await repo.getSettings();
    expect(def.trashPurgeDays).toBe(30);

    await repo.saveSettings({ ...def, theme: 'light', syncEnabled: true, trashPurgeDays: 7 });
    const stored = /** @type {{ settings: any }} */ (await chrome.storage.local.get('settings'));
    expect(stored.settings.theme).toBe('light');
    const syncData = /** @type {{ settings?: any }} */ (await chrome.storage.sync.get('settings'));
    expect(syncData.settings.trashPurgeDays).toBe(7);
    expect((await repo.getSettings()).trashPurgeDays).toBe(7);
  });

  it('valores basura vuelven a defaults seguros', async () => {
    await chrome.storage.local.set({ settings: { theme: 'hacker-green', autoSaveMinutes: 1337 } });
    repo.invalidate();
    expect(await repo.getSettings()).toMatchObject({ theme: 'dark', autoSaveMinutes: 0 });
  });
});

describe('Export / Import (fix C7)', () => {
  it('exportAll excluye backups de migración y estampa versión', async () => {
    await seed({ id: 'ex' });
    await chrome.storage.local.set({ backup_preMigration_v0_v3_1: { sessions: {} } });
    const json = JSON.parse(await repo.exportAll());
    expect(json._tabvault).toBe(true);
    expect(json.version).toBeGreaterThanOrEqual(3);
    expect(json.backup_preMigration_v0_v3_1).toBeUndefined();
    expect(json.sessions.ex).toBeDefined();
  });

  it('import replace VALIDADO: JSON corrupto lanza sin tocar storage', async () => {
    await seed({ id: 'safe' });
    const before = await repo.getSessions();
    await expect(repo.importAll('{no json]')).rejects.toThrow(/JSON/);
    await expect(repo.importAll(JSON.stringify({ hola: 1 }))).rejects.toThrow(/TabVault export/);
    expect(await repo.getSessions()).toEqual(before);
  });

  it('import replace sanea contenido hostil y estampa meta.schemaVersion', async () => {
    const payload = {
      _tabvault: true,
      sessions: {
        k: { name: 'ok', ungroupedTabs: [{ url: 'https://good.dev' }, { url: 'javascript:x' }] },
      },
    };
    const res = await repo.importAll(JSON.stringify(payload));
    expect(res.imported).toBe(1);
    expect(res.errors.length).toBeGreaterThan(0); // reporta tab descartada

    const dump = mock.dumpLocal();
    expect(dump.meta.schemaVersion).toBeGreaterThanOrEqual(3);
    const allSessions = Object.values(dump.sessions ?? {});
    const imported = /** @type {any} */ (allSessions[0])?.ungroupedTabs;
    expect(allSessions).toHaveLength(1);
    expect(imported).toHaveLength(1);
    expect(imported[0].url.startsWith('https://')).toBe(true);
  });

  it('import merge: colisión de id REGENERA id, nunca pisa', async () => {
    await seed({ id: 'dup', name: 'Original' });
    const payload = {
      _tabvault: true,
      sessions: { dup: makeSession({ id: 'dup', name: 'Importada' }) },
    };
    const res = await repo.importAll(JSON.stringify(payload), { mode: 'merge' });
    expect(res.imported).toBe(1);
    const sessions = await repo.getSessions();
    expect(sessions.dup.name).toBe('Original'); // intacta
    const importedId = Object.values(sessions).find((s) => s.name === 'Importada')?.id;
    expect(importedId).toBeTruthy();
    expect(importedId).not.toBe('dup');
  });

  it('export Markdown (Fase 8: exporter enriquecido) incluye notas de ungrouped', async () => {
    await seed({ id: 'md', name: 'MD', ungroupedTabs: [makeTab({ url: 'https://u.dev', note: 'leer' })] });
    const session = await repo.getSession('md');
    const md = sessionToMarkdown(/** @type {any} */ (session));
    expect(md).toContain('> leer');
    expect(md).toContain('[Example page](https://u.dev/)');
  });
});
