// tests/background/restore.test.js — Restauración robusta (fix C9).
// Creación paralela, pinned/active preservados, modos new/append/replace,
// anti-duplicados opcional.
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { repository as repo } from '../../core/repository.js';
import { restoreSessionById } from '../../background/handlers/restore.js';
import { newId } from '../../core/domain.js';

/**
 * Sesión de prueba con grupos + ungrouped + pinned/active.
 * @returns {import('../../shared/types.js').Session}
 */
function makeSession() {
  return {
    id: newId(),
    name: 'Test session',
    created: Date.now(),
    updated: Date.now(),
    groups: [
      {
        id: newId(),
        name: 'Work',
        color: 'blue',
        tags: [],
        note: '',
        tabs: [
          { id: newId(), url: 'https://gh.com/a', title: 'A', favicon: '', note: '', tags: [], savedAt: 1 },
          {
            id: newId(),
            url: 'https://gh.com/b',
            title: 'B',
            favicon: '',
            note: '',
            tags: [],
            savedAt: 2,
            active: true,
          },
        ],
      },
    ],
    ungroupedTabs: [
      {
        id: newId(),
        url: 'https://news.com',
        title: 'News',
        favicon: '',
        note: '',
        tags: [],
        savedAt: 3,
        pinned: true,
      },
      { id: newId(), url: 'chrome://nope', title: 'skip', favicon: '', note: '', tags: [], savedAt: 4 },
    ],
    metadata: { groupCount: 1, tabCount: 3 },
  };
}

describe('restoreSessionById', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
    repo.invalidate();
  });

  it('modo new: crea ventana nueva, agrupa, pinea y activa la capturada como activa', async () => {
    const session = makeSession();
    await repo.saveSession(session);

    const result = /** @type {any} */ (await restoreSessionById(session.id));
    expect(result.ok).toBe(true);
    expect(result.opened).toBe(3); // chrome:// filtrado

    expect(h.model.wins).toHaveLength(1);
    const winId = h.model.wins[0].id;
    const winTabs = h.model.tabs.filter((/** @type {any} */ t) => t.windowId === winId);
    expect(winTabs).toHaveLength(3);

    // grupo reconstruido con título/color y las 2 tabs correctas
    const nativeGroup = h.model.groups.find((/** @type {any} */ g) => g.windowId === winId);
    expect(nativeGroup.title).toBe('Work');
    expect(nativeGroup.color).toBe('blue');
    const grouped = winTabs.filter((/** @type {any} */ t) => t.groupId === nativeGroup.id);
    expect(grouped.map((/** @type {any} */ t) => t.url)).toEqual(['https://gh.com/a', 'https://gh.com/b']);

    // pinned preservada en la tab ungrouped (URL normalizada a u.href por schema)
    const pinned = winTabs.find((/** @type {any} */ t) => t.url === 'https://news.com/');
    expect(pinned.pinned).toBe(true);

    // la tab marcada active al capturar quedó activa
    const active = winTabs.filter((/** @type {any} */ t) => t.active === true);
    expect(active).toHaveLength(1);
    expect(active[0].url).toBe('https://gh.com/b');
  });

  it('modo append: añade a la ventana indicada sin cerrarla', async () => {
    const session = makeSession();
    await repo.saveSession(session);
    const targetId = h.seedWindow({}, [{ url: 'https://existing.com', title: 'existing' }]);

    const result = /** @type {any} */ (await restoreSessionById(session.id, { windowId: targetId }));
    expect(result.ok).toBe(true);
    expect(h.model.wins).toHaveLength(1);
    const winTabs = h.model.tabs.filter((/** @type {any} */ t) => t.windowId === targetId);
    expect(winTabs.map((/** @type {any} */ t) => t.url)).toContain('https://existing.com');
    expect(winTabs).toHaveLength(4); // existing + 3 restauradas
  });

  it('modo replace: la ventana queda EXACTAMENTE con las tabs de la sesión', async () => {
    const session = makeSession();
    await repo.saveSession(session);
    const oldWinId = h.seedWindow({}, [
      { url: 'https://stale1.com', title: 's1' },
      { url: 'https://stale2.com', title: 's2' },
    ]);

    const result = /** @type {any} */ (await restoreSessionById(session.id, { mode: 'replace' }));
    expect(result.ok).toBe(true);

    // la vieja ventana se cerró; solo queda la nueva
    expect(h.model.wins).toHaveLength(1);
    expect(h.model.wins[0].id).not.toBe(oldWinId);
    const winTabs = h.model.tabs.filter((/** @type {any} */ t) => t.windowId === h.model.wins[0].id);
    expect(winTabs).toHaveLength(3);
    expect(winTabs.map((/** @type {any} */ t) => t.url)).not.toContain('https://stale1.com/');
  });

  it('dedupeOnRestore: enfoca la URL existente en vez de duplicarla', async () => {
    await repo.saveSettings({ dedupeOnRestore: true });
    const session = makeSession();
    await repo.saveSession(session);
    const targetId = h.seedWindow({}, [{ url: 'https://gh.com/a', title: 'A ya abierta' }]);

    const result = /** @type {any} */ (await restoreSessionById(session.id, { windowId: targetId }));
    expect(result.ok).toBe(true);
    expect(result.opened).toBe(2); // gh.com/a reutilizada

    const urls = h.model.tabs
      .filter((/** @type {any} */ t) => t.windowId === targetId)
      .map((/** @type {any} */ t) => t.url);
    expect(urls.filter((/** @type {string} */ u) => u.startsWith('https://gh.com/a'))).toHaveLength(1);
  });

  it('sesión inexistente o sin tabs válidas → error controlado', async () => {
    expect((await restoreSessionById('nope')).ok).toBe(false);

    const bad = makeSession();
    bad.id = newId();
    bad.ungroupedTabs = [];
    bad.groups = [];
    bad.metadata.tabCount = 0;
    await repo.saveSession(bad);
    const res = await restoreSessionById(bad.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/No valid tabs/);
  });
});
