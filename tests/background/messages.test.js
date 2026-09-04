// tests/background/messages.test.js — Router uniforme {ok,data?,error?}, whitelist
// REPO_OP, timeouts, y fixes M1/M2/M5 (context menus namespaced + badge por alarm).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { repository as repo } from '../../core/repository.js';
import { handleMessage, withTimeout } from '../../background/handlers/messages.js';
import {
  flashBadge,
  handleBadgeAlarm,
  openVaultUi,
  registerContextMenus,
} from '../../background/handlers/lifecycle.js';
import { MSG } from '../../shared/messages.js';
import { newId } from '../../core/domain.js';

describe('handleMessage', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
    repo.invalidate();
  });

  it('mensajes malformados → error controlado', async () => {
    expect((await handleMessage(/** @type {any} */ (null))).ok).toBe(false);
    expect((await handleMessage({})).ok).toBe(false);
    expect((await handleMessage({ type: 'NOPE' })).error).toMatch(/Unknown message type/);
  });

  it('GET_STATS devuelve conteos', async () => {
    await repo.saveSession({
      id: newId(),
      name: 's1',
      created: 1,
      updated: 1,
      groups: [],
      ungroupedTabs: [
        { id: newId(), url: 'https://a.com', title: 'A', favicon: '', note: '', tags: [], savedAt: 1 },
      ],
      metadata: { groupCount: 0, tabCount: 1 },
    });
    const res = await handleMessage({ type: MSG.GET_STATS });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ sessionCount: 1, tabCount: 1, trashCount: 0 });
  });

  it('REPO_OP respeta la whitelist (ADR-0002)', async () => {
    const bad = await handleMessage({ type: MSG.REPO_OP, op: '__proto__', args: [] });
    expect(bad.ok).toBe(false);

    const good = /** @type {any} */ (
      await handleMessage({
        type: MSG.REPO_OP,
        op: 'saveSession',
        args: [
          {
            id: newId(),
            name: 'via repo op',
            created: 1,
            updated: 1,
            groups: [],
            ungroupedTabs: [],
            metadata: { groupCount: 0, tabCount: 0 },
          },
        ],
      })
    );
    expect(good.ok).toBe(true);
    expect(Object.keys(h.dumpLocal().sessions ?? {})).toHaveLength(1);
  });

  it('CAPTURE_SESSION guarda la ventana enfocada con grupos', async () => {
    const winId = h.seedWindow({}, [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B', groupId: 21 },
      { url: 'https://c.com', title: 'C', groupId: 21 },
    ]);
    h.seedGroup(winId, 21, 'Pair', 'red');

    const res = await handleMessage({ type: MSG.CAPTURE_SESSION, name: 'Manual' });
    expect(res.ok).toBe(true);
    expect(/** @type {any} */ (res.data).name).toBe('Manual');
    const [session] = Object.values(h.dumpLocal().sessions ?? {});
    expect(session.groups[0].name).toBe('Pair');
    expect(session.metadata.tabCount).toBe(3);
  });

  it('CAPTURE_ALL_WINDOWS crea una sesión por ventana (M13)', async () => {
    h.seedWindow({ focused: true }, [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ]);
    h.seedWindow({}, [
      { url: 'https://c.com', title: 'C' },
      { url: 'https://d.com', title: 'D' },
    ]);

    const res = await handleMessage({ type: MSG.CAPTURE_ALL_WINDOWS });
    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(2);
    expect(Object.keys(h.dumpLocal().sessions)).toHaveLength(2);
  });

  it('STASH_TAB sin tab válida responde error controlado', async () => {
    const res = await handleMessage({ type: MSG.STASH_TAB });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cannot be stashed/i);
  });

  it('withTimeout corta handlers colgados', async () => {
    vi.useFakeTimers();
    try {
      const p = withTimeout(new Promise(() => {}), 50);
      const assertion = expect(p).rejects.toThrow(/timed out/);
      vi.advanceTimersByTime(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('CONVERT_FAVICON responde forma uniforme', async () => {
    const res = await handleMessage({ type: MSG.CONVERT_FAVICON, url: '' });
    expect(res.ok).toBe(true);
    expect(/** @type {any} */ (res.data).dataUrl).toBe('');
  });
});

describe('lifecycle (M1/M2/M5)', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
  });

  it('flashBadge programa limpieza por ALARM, no setTimeout (M5)', async () => {
    const before = Date.now();
    await flashBadge('AUTO', '#4169E1');
    expect(h.badgeState.text).toBe('AUTO');

    const alarm = h.alarms.find((/** @type {any} */ a) => a.name === 'tabvault-badge-clear');
    expect(alarm).toBeDefined();
    expect(alarm.when).toBeGreaterThanOrEqual(before + 3000 - 10);

    // la alarma dispara la limpieza aunque el "SW" haya muerto y revivido
    await handleBadgeAlarm({ name: 'tabvault-badge-clear' });
    expect(h.badgeState.text).toBe('');
  });

  it('handleBadgeAlarm ignora alarmas ajenas', async () => {
    expect(await handleBadgeAlarm({ name: 'otra-alarma' })).toBe(false);
  });

  it('registerContextMenus usa ids namespaced y es idempotente (M1)', () => {
    registerContextMenus();
    let ids = h.chrome.contextMenus.createdDefs.map((/** @type {any} */ d) => d.id);
    expect(ids).toEqual(['tabvault_save_session', 'tabvault_stash_page', 'tabvault_open_popup']);

    registerContextMenus(); // removeAll limpia antes de re-crear
    ids = h.chrome.contextMenus.createdDefs.map((/** @type {any} */ d) => d.id);
    expect(ids).toEqual(['tabvault_save_session', 'tabvault_stash_page', 'tabvault_open_popup']);
  });

  it('openVaultUi cae a tabs.create cuando openPopup no existe (M2)', () => {
    expect(typeof h.chrome.action.openPopup).not.toBe('function');
    openVaultUi();
    expect(h.model.tabs.map((/** @type {any} */ t) => t.url)).toContain(
      'chrome-extension://tabvault-test/popup/popup.html'
    );
  });

  it('openVaultUi usa openPopup cuando existe', async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    h.chrome.action.openPopup = spy;
    openVaultUi();
    expect(spy).toHaveBeenCalledTimes(1);
    delete h.chrome.action.openPopup;
  });
});
