// tests/background/restoreFase6.test.js — Fase 6: modo incógnito, restauración
// parcial por tabIds y tracking lastOpened (plantillas exentas).
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { repository as repo } from '../../core/repository.js';
import { restoreSessionById } from '../../background/handlers/restore.js';
import { makeSession, makeTab } from '../fixtures/sessions.js';

/** Centinela: encola una op del repo DETRÁS de cualquier fire-and-forget pendiente. */
async function drainQueue() {
  await repo.saveSettings({});
}

describe('restore Fase 6', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
    repo.invalidate();
    repo.attach();
  });

  it("modo 'incognito' abre ventana privada con las tabs", async () => {
    await repo.saveSession(
      makeSession({
        id: 's-inc',
        ungroupedTabs: [
          makeTab({ id: 't1', url: 'https://a.com' }),
          makeTab({ id: 't2', url: 'https://b.com' }),
        ],
      })
    );

    const res = await restoreSessionById('s-inc', { mode: 'incognito' });
    expect(res).toEqual({ ok: true, opened: 2 });

    const win = h.model.wins[h.model.wins.length - 1];
    expect(win.incognito).toBe(true);
    const urls = h.model.tabs
      .filter((/** @type {any} */ t) => t.windowId === win.id)
      .map((/** @type {any} */ t) => t.url);
    // safeUrl normaliza href → trailing slash
    expect(urls.sort()).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('restauración parcial: solo los tabIds incluidos se abren', async () => {
    const session = makeSession({
      id: 's-part',
      groups: [],
      ungroupedTabs: [
        makeTab({ id: 'keep-1', url: 'https://keep1.com' }),
        makeTab({ id: 'skip-1', url: 'https://skip1.com' }),
        makeTab({ id: 'keep-2', url: 'https://keep2.com' }),
      ],
    });
    await repo.saveSession(session);

    const res = await restoreSessionById('s-part', { tabIds: ['keep-1', 'keep-2'] });
    expect(res).toEqual({ ok: true, opened: 2 });

    const openedUrls = h.model.tabs.map((/** @type {any} */ t) => t.url);
    expect(openedUrls).toContain('https://keep1.com/'); // href normalizado
    expect(openedUrls).toContain('https://keep2.com/');
    expect(openedUrls).not.toContain('https://skip1.com');
  });

  it('restaurar sesión NORMAL marca lastOpened (se "usa")', async () => {
    await repo.saveSession(
      makeSession({
        id: 's-normal',
        ungroupedTabs: [makeTab({ id: 'n1', url: 'https://normal.io' })],
      })
    );
    expect(h.dumpLocal().sessions['s-normal'].lastOpened).toBeUndefined();

    const res = await restoreSessionById('s-normal');
    expect(res.ok).toBe(true);
    await drainQueue(); // lastOpened es fire-and-forget: esperar su turno en la cola

    expect(h.dumpLocal().sessions['s-normal'].lastOpened).toBeGreaterThan(0);
  });

  it('CRITERIO 6.3: restaurar PLANTILLA no marca uso (lastOpened intacto)', async () => {
    await repo.saveSession(
      makeSession({
        id: 's-tpl',
        isTemplate: true,
        ungroupedTabs: [makeTab({ id: 'p1', url: 'https://template.dev' })],
      })
    );
    // saveSession ya estampa updated; lo que importa es que RESTAURAR no lo toque
    const updatedAfterSave = h.dumpLocal().sessions['s-tpl'].updated;

    const res = await restoreSessionById('s-tpl');
    expect(res.ok).toBe(true);
    await drainQueue();

    const stored = h.dumpLocal().sessions['s-tpl'];
    expect(stored.lastOpened).toBeUndefined();
    expect(stored.updated).toBe(updatedAfterSave);
    // pero la tab SÍ se abrió
    expect(h.model.tabs.some((/** @type {any} */ t) => t.url === 'https://template.dev/')).toBe(true);
  });

  it('tabIds que no matchean nada → error claro, sin abrir nada', async () => {
    await repo.saveSession(
      makeSession({
        id: 's-empty',
        ungroupedTabs: [makeTab({ id: 'real', url: 'https://real.com' })],
      })
    );
    const res = await restoreSessionById('s-empty', { tabIds: ['ghost-id'] });
    expect(res).toEqual({ ok: false, error: 'No valid tabs to restore' });
    expect(h.model.tabs.filter((/** @type {any} */ t) => t.url === 'https://real.com')).toHaveLength(0);
  });
});
