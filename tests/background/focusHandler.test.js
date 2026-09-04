// tests/background/focusHandler.test.js — Modo enfoque + suspensión (Fase 9.2/9.3):
// cero pérdida (sesión efímera SIEMPRE antes de cerrar), whitelist y undo.

import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { repository as repo } from '../../core/repository.js';
import { focusSession, suspendInactiveTabs } from '../../background/handlers/focus.js';

/** @type {ReturnType<typeof installChromeMock>} */
let h;

beforeEach(() => {
  h = installChromeMock();
  h.reset();
  repo.invalidate();
});

/** @param {string[]} urls */
async function seedSessionWithTabs(urls) {
  await repo.saveSession({
    id: 'focus-target',
    name: 'Target',
    created: 1,
    updated: 1,
    groups: [],
    ungroupedTabs: urls.map((/** @type {string} */ url, /** @type {number} */ i) => ({
      id: `t${i}`,
      url,
      title: url,
      favicon: '',
      note: '',
      tags: [],
      savedAt: 1,
    })),
    metadata: { groupCount: 0, tabCount: urls.length },
  });
}

describe('focusSession', () => {
  it('cierra las ajenas, crea sesión efímera ↺ y devuelve undoId', async () => {
    await seedSessionWithTabs(['https://keep.com/a']);
    const winId = h.seedWindow({}, [
      { url: 'https://keep.com/a', title: 'keep' },
      { url: 'https://close-me.com/x', title: 'close' },
      { url: 'https://also-close.net/y', title: 'close2' },
    ]);

    const res = await focusSession('focus-target', { windowId: winId });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.closed).toBe(2);
      expect(res.undoId).toBeTruthy();
    }

    // sesión efímera con EXACTAMENTE las cerradas (cero pérdida)
    const undo = res.ok ? await repo.getSession(res.undoId) : null;
    expect(undo?.name).toContain('↺ Focus undo');
    expect(undo?.metadata?.tabCount).toBe(2);
    expect(undo?.ungroupedTabs.map((/** @type {any} */ t) => t.url).sort()).toEqual([
      'https://also-close.net/y',
      'https://close-me.com/x',
    ]);

    // las tabs se cerraron de verdad
    const remaining = h.model.tabs
      .filter((/** @type {any} */ t) => t.windowId === winId)
      .map((/** @type {any} */ t) => t.url);
    expect(remaining).toEqual(['https://keep.com/a']);
  });

  it('whitelist por dominio nunca se cierra', async () => {
    await seedSessionWithTabs(['https://keep.com/a']);
    const winId = h.seedWindow({}, [
      { url: 'https://keep.com/a', title: 'keep' },
      { url: 'https://mail.google.com/inbox', title: 'mail' },
    ]);
    const res = await focusSession('focus-target', { windowId: winId, whitelist: ['mail.google.com'] });
    expect(res.ok && res.closed === 0).toBe(true);
    expect(h.model.tabs.length).toBe(2);
  });

  it('chrome:// y chrome-extension:// jamás se cierran; sesión inexistente → error', async () => {
    await seedSessionWithTabs(['https://keep.com/a']);
    const winId = h.seedWindow({}, [
      { url: 'chrome://settings/', title: 'settings' },
      { url: 'chrome-extension://abc/popup.html', title: 'ext' },
    ]);
    const res = await focusSession('focus-target', { windowId: winId });
    expect(res.ok && res.closed === 0).toBe(true);
    expect(h.model.tabs.length).toBe(2);

    const missing = await focusSession('nope', { windowId: winId });
    expect(missing).toEqual({ ok: false, error: 'Session not found' });
  });
});

describe('suspendInactiveTabs', () => {
  it('cierra inactivas no-pinned a sesión "Suspended —"', async () => {
    const winId = h.seedWindow({}, [
      { url: 'https://active.com/a', title: 'active', active: true },
      { url: 'https://idle1.com/a', title: 'idle1' },
      { url: 'https://idle2.com/b', title: 'idle2', pinned: true },
    ]);
    const res = await suspendInactiveTabs({ windowId: winId, hours: 4 });
    expect(res.ok && res.closed).toBe(1);

    const suspended = res.ok ? await repo.getSession(res.sessionId) : null;
    expect(suspended?.name).toContain('Suspended —');
    expect(suspended?.ungroupedTabs[0]?.url).toBe('https://idle1.com/a');

    const remaining = h.model.tabs.map((/** @type {any} */ t) => t.url);
    expect(remaining).toContain('https://idle2.com/b'); // pinned sobrevive
    expect(remaining).toContain('https://active.com/a');
  });

  it('sin candidatas → closed 0, sessionId ""', async () => {
    const winId = h.seedWindow({}, [{ url: 'https://only.com/a', title: 'only', active: true }]);
    const res = await suspendInactiveTabs({ windowId: winId });
    expect(res.ok && res.closed === 0 && res.sessionId === '').toBe(true);
  });
});
