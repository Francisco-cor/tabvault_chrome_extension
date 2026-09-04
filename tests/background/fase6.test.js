// tests/background/fase6.test.js — Fase 6: captura selectiva, dedupe al guardar,
// overwrite de duplicados, multi-ventana en una sesión y STASH_TAB real.
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { repository as repo } from '../../core/repository.js';
import { handleMessage } from '../../background/handlers/messages.js';
import { MSG } from '../../shared/messages.js';

describe('CAPTURE_SESSION — opciones de Fase 6', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
    repo.invalidate();
  });

  it('dedupeOnSave (default ON) fusiona URLs duplicadas e informa la cifra', async () => {
    h.seedWindow({ focused: true }, [
      { url: 'https://a.com/x', title: 'A old' },
      { url: 'https://a.com/x', title: 'A new' },
      { url: 'https://b.com', title: 'B' },
      { url: 'https://b.com', title: 'B again' },
      { url: 'https://c.com', title: 'C' },
    ]);

    const res = await handleMessage({ type: MSG.CAPTURE_SESSION, name: 'Dupes' });
    expect(res.ok).toBe(true);
    const saved = /** @type {any} */ (res.data);
    expect(saved.dedupeRemoved).toBe(2);
    expect(saved.metadata.tabCount).toBe(3); // a.com ×1 + b.com ×1 + c.com
  });

  it('con dedupeOnSave OFF se guardan las tabs tal cual', async () => {
    await repo.saveSettings({ dedupeOnSave: false });
    h.seedWindow({ focused: true }, [
      { url: 'https://a.com/x', title: 'A old' },
      { url: 'https://a.com/x', title: 'A new' },
    ]);

    const res = await handleMessage({ type: MSG.CAPTURE_SESSION, name: 'Raw' });
    expect(res.ok).toBe(true);
    expect(/** @type {any} */ (res.data).metadata.tabCount).toBe(2);
    expect(/** @type {any} */ (res.data).dedupeRemoved ?? 0).toBe(0);
  });

  it('excludeUrls descarta por URL exacta (captura selectiva)', async () => {
    h.seedWindow({ focused: true }, [
      { url: 'https://a.com/keep', title: 'Keep' },
      { url: 'https://a.com/drop', title: 'Drop' },
    ]);

    const res = await handleMessage({
      type: MSG.CAPTURE_SESSION,
      name: 'Selective',
      excludeUrls: ['https://a.com/drop'],
    });
    expect(res.ok).toBe(true);
    expect(/** @type {any} */ (res.data).metadata.tabCount).toBe(1);
    const [session] = Object.values(h.dumpLocal().sessions ?? {});
    expect(session.ungroupedTabs[0].url).toBe('https://a.com/keep');
  });

  it('allWindows fusiona todas las ventanas en UNA sesión', async () => {
    h.seedWindow({ focused: true }, [{ url: 'https://a.com', title: 'A' }]);
    h.seedWindow({}, [{ url: 'https://b.com', title: 'B' }]);

    const res = await handleMessage({
      type: MSG.CAPTURE_SESSION,
      name: 'Everything',
      allWindows: true,
    });
    expect(res.ok).toBe(true);
    const sessions = Object.values(h.dumpLocal().sessions ?? {});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].metadata.tabCount).toBe(2);
    expect(sessions[0].name).toBe('Everything');
  });

  it('overwrite + duplicateId versiona y REEMPLAZA manteniendo el id', async () => {
    h.seedWindow({ focused: true }, [
      { url: 'https://old.com/a', title: 'Old A' },
      { url: 'https://old.com/b', title: 'Old B' },
    ]);
    await repo.saveSession({
      id: 'dup-1',
      name: 'Existing',
      created: 1,
      updated: 1,
      groups: [],
      ungroupedTabs: [],
      metadata: { groupCount: 0, tabCount: 0 },
    });

    const res = await handleMessage({
      type: MSG.CAPTURE_SESSION,
      name: 'Existing v2',
      duplicateId: 'dup-1',
      overwrite: true,
    });
    expect(res.ok).toBe(true);

    const dump = h.dumpLocal();
    const sessions = Object.values(dump.sessions ?? {});
    expect(sessions).toHaveLength(1); // no crea una nueva
    const replaced = dump.sessions['dup-1'];
    expect(replaced.name).toBe('Existing v2');
    expect(replaced.metadata.tabCount).toBe(2);
    // snapshot previo disponible como undo natural
    expect((dump.versions?.['dup-1'] ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('duplicateId sin overwrite versiona y guarda NUEVA sesión', async () => {
    h.seedWindow({ focused: true }, [{ url: 'https://new.com', title: 'New' }]);
    await repo.saveSession({
      id: 'orig',
      name: 'Orig',
      created: 1,
      updated: 1,
      groups: [],
      ungroupedTabs: [],
      metadata: { groupCount: 0, tabCount: 0 },
    });

    const res = await handleMessage({
      type: MSG.CAPTURE_SESSION,
      name: 'Same-ish',
      duplicateId: 'orig',
    });
    expect(res.ok).toBe(true);
    const dump = h.dumpLocal();
    expect(Object.keys(dump.sessions ?? {})).toHaveLength(2);
    expect((dump.versions?.['orig'] ?? []).length).toBe(1); // undo natural intacto
    expect(dump.sessions['orig'].name).toBe('Orig');
  });
});

describe('STASH_TAB (Fase 6.1)', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
    repo.invalidate();
  });

  it('crea la sesión Stash con flag y añade la tab', async () => {
    h.seedWindow({ focused: true }, [{ url: 'https://stashed.io/article', title: 'Article' }]);
    const tab = h.model.tabs[0];

    const res = await handleMessage({ type: MSG.STASH_TAB, tabId: tab.id });
    expect(res.ok).toBe(true);
    const data = /** @type {any} */ (res.data);
    expect(data.added).toBe(true);
    expect(data.stashCount).toBe(1);

    const stash = Object.values(h.dumpLocal().sessions ?? {}).find((s) => s.stash === true);
    expect(stash?.name).toBe('Stash');
    expect(stash?.ungroupedTabs[0].url).toBe('https://stashed.io/article');
    // badge persistente con el contador
    expect(h.badgeState.text).toBe('1');
  });

  it('re-stashear la misma URL NO duplica (added:false)', async () => {
    h.seedWindow({ focused: true }, [{ url: 'https://x.io', title: 'X' }]);
    const first = await handleMessage({ type: MSG.STASH_TAB, tabId: h.model.tabs[0].id });
    expect(/** @type {any} */ (first.data).added).toBe(true);

    const second = await handleMessage({ type: MSG.STASH_TAB, tabId: h.model.tabs[0].id });
    expect(second.ok).toBe(true);
    expect(/** @type {any} */ (second.data).added).toBe(false);
    expect(/** @type {any} */ (second.data).stashCount).toBe(1);

    const stash = Object.values(h.dumpLocal().sessions ?? {}).find((s) => s.stash === true);
    expect(stash?.ungroupedTabs).toHaveLength(1);
  });

  it('URL no capturable → error controlado, sin tocar storage', async () => {
    const res = await handleMessage({ type: MSG.STASH_TAB, tabId: 9999 });
    expect(res.ok).toBe(false);
    expect(h.dumpLocal().sessions ?? {}).toEqual({});
  });
});
