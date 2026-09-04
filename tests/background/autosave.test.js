// tests/background/autosave.test.js — Fix C1 (race en cierre) y C5 (grupos).
// El snapshot vive en chrome.storage.session: un cold start del SW ya NO
// produce auto-saves vacíos porque el dato no depende de memoria volátil.
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { repository as repo } from '../../core/repository.js';
import {
  onWindowRemoved,
  runPeriodicAutoSave,
  scheduleWindowSnapshot,
  snapshotWindow,
  snapshotAllWindows,
} from '../../background/handlers/autosave.js';

/** @param {any} h @returns {Record<string, any>} mapa sessions de storage.local */
function sessionsIn(h) {
  return h.dumpLocal().sessions ?? {};
}

describe('auto-save por cierre de ventana (C1)', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
    repo.invalidate();
  });

  it('guarda la sesión desde el snapshot persistido aunque el SW despierte frío', async () => {
    const winId = h.seedWindow({}, [
      { url: 'https://mail.google.com', title: 'Gmail' },
      { url: 'https://github.com/x', title: 'GH', groupId: 42 },
      { url: 'https://gitlab.com/y', title: 'GL', groupId: 42 },
      { url: 'chrome://settings', title: 'ignored' },
    ]);
    h.seedGroup(winId, 42, 'Dev', 'blue');
    await snapshotWindow(winId);

    // Simula cold start: el SW "despierta" directamente por windows.onRemoved.
    // No hay NINGÚN estado en memoria: todo sale de storage.session.
    const saved = await onWindowRemoved(winId);

    expect(saved).not.toBeNull();
    const stored = sessionsIn(h);
    const all = Object.values(stored);
    expect(all).toHaveLength(1);
    expect(all[0].name).toMatch(/^Auto:/);
    expect(all[0].autoSaved).toBe(true);
    expect(all[0].metadata.tabCount).toBe(3);
    expect(all[0].groups[0].name).toBe('Dev'); // C5: grupos intactos también al cerrar
    expect(all[0].groups[0].tabs.map((/** @type {any} */ t) => t.title)).toEqual(['GH', 'GL']);
    // el snapshot de la ventana cerrada se limpia
    expect(h.dumpSession().windowSnapshots[String(winId)]).toBeUndefined();
  });

  it('no guarda nada si no hay snapshot (ventana desconocida / reinicio)', async () => {
    const saved = await onWindowRemoved(9999);
    expect(saved).toBeNull();
    expect(sessionsIn(h)).toEqual({});
  });

  it('respeta settings.autoSaveOnClose = false', async () => {
    const winId = h.seedWindow({}, [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ]);
    await snapshotWindow(winId);
    await repo.saveSettings({ autoSaveOnClose: false });
    const saved = await onWindowRemoved(winId);
    expect(saved).toBeNull();
    expect(sessionsIn(h)).toEqual({});
  });

  it('respeta el mínimo de tabs (minAutoSaveTabs)', async () => {
    const winId = h.seedWindow({}, [
      { url: 'https://a.com', title: 'A' },
      { url: 'chrome://x', title: 'x' }, // no cuenta como válida
    ]);
    await snapshotWindow(winId);
    const saved = await onWindowRemoved(winId); // solo 1 tab válida < min 2
    expect(saved).toBeNull();
  });

  it('ignora ventanas incógnito salvo includeIncognito', async () => {
    const winId = h.seedWindow({ incognito: true }, [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ]);
    await snapshotWindow(winId);

    expect(await onWindowRemoved(winId)).toBeNull();

    await repo.saveSettings({ includeIncognito: true });
    // el primer snapshot se consumió en el intento anterior; re-crear escenario
    const win2 = h.seedWindow({ incognito: true }, [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ]);
    await snapshotWindow(win2);
    const saved = await onWindowRemoved(win2);
    expect(saved).not.toBeNull();
  });
});

describe('snapshot lifecycle', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
    repo.invalidate();
  });

  it('scheduleWindowSnapshot persiste con debounce sin lanzar', async () => {
    const winId = h.seedWindow({}, [{ url: 'https://a.com', title: 'A' }]);
    scheduleWindowSnapshot(winId);
    await new Promise((r) => setTimeout(r, 300)); // > SNAPSHOT_DEBOUNCE_MS
    const snaps = h.dumpSession().windowSnapshots;
    expect(snaps[String(winId)].tabs).toHaveLength(1);
  });

  it('snapshotAllWindows reconstruye el mapa completo y purga huérfanas', async () => {
    const w1 = h.seedWindow({}, [{ url: 'https://a.com', title: 'A' }]);
    h.seedWindow({}, [{ url: 'https://b.com', title: 'B' }]);
    await snapshotAllWindows();

    // una ventana muere sin pasar por onWindowRemoved → clave huérfana
    await snapshotWindow(w1);
    h.model.wins.pop(); // desaparece la ventana 2 del modelo
    await snapshotAllWindows();

    const snaps = h.dumpSession().windowSnapshots;
    expect(Object.keys(snaps)).toHaveLength(1);
    expect(snaps[String(w1)].tabs[0].url).toBe('https://a.com'); // raw, sin normalizar
  });
});

describe('auto-save periódico (C5)', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
    repo.invalidate();
  });

  it('guarda cada ventana como sesión CON grupos (no plano en ungroupedTabs)', async () => {
    const w1 = h.seedWindow({ focused: true }, [
      { url: 'https://mail.google.com', title: 'Gmail' },
      { url: 'https://github.com/a', title: 'A', groupId: 77 },
      { url: 'https://github.com/b', title: 'B', groupId: 77 },
    ]);
    h.seedGroup(w1, 77, 'Code', 'green');

    const savedCount = await runPeriodicAutoSave();
    expect(savedCount).toBe(1);

    const [session] = Object.values(sessionsIn(h));
    expect(session.name).toMatch(/^Periodic:/);
    expect(session.autoSaved).toBe(true);
    expect(session.metadata.tabCount).toBe(3);
    expect(session.groups).toHaveLength(1);
    expect(session.groups[0].name).toBe('Code');
    expect(session.groups[0].color).toBe('green');
    expect(session.ungroupedTabs.map((/** @type {any} */ t) => t.title)).toEqual(['Gmail']);
  });

  it('omite ventanas por debajo del mínimo de tabs', async () => {
    h.seedWindow({}, [{ url: 'https://only.com', title: 'only' }]);
    const savedCount = await runPeriodicAutoSave();
    expect(savedCount).toBe(0);
    expect(sessionsIn(h)).toEqual({});
  });
});
