// tests/background/fase7.test.js — Fase 7 en el SW: guardar grupo vivo como
// sesión, openCount/lastOpened al restaurar (plantillas exentas) y comandos
// globales de teclado (+3 del manifest).

import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { repository as repo } from '../../core/repository.js';
import { handleMessage } from '../../background/handlers/messages.js';
import { handleGlobalCommand, consumeUiIntent } from '../../background/handlers/lifecycle.js';
import { MSG } from '../../shared/messages.js';
import { normalizeSession } from '../../core/schema.js';

describe('SAVE_GROUP_AS_SESSION (Fase 7.6)', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
    repo.invalidate();
  });

  function seedGroupWindow() {
    const winId = h.seedWindow({ focused: true }, [
      { url: 'https://docs.google.com/a', title: 'Doc A', groupId: 501 },
      { url: 'https://docs.google.com/b', title: 'Doc B', groupId: 501 },
      { url: 'https://loose.com', title: 'Loose', groupId: -1 },
    ]);
    h.seedGroup(winId, 501, 'Research docs', 'blue');
    return winId;
  }

  it('guarda SOLO las tabs del grupo con su nombre y color', async () => {
    const winId = seedGroupWindow();
    const res = await handleMessage({ type: MSG.SAVE_GROUP_AS_SESSION, windowId: winId, groupId: 501 });
    expect(res.ok).toBe(true);

    const saved = /** @type {any} */ (res.data);
    expect(saved.metadata.tabCount).toBe(2);
    expect(saved.groups).toHaveLength(1);
    expect(saved.groups[0].name).toBe('Research docs');
    expect(saved.groups[0].color).toBe('blue');
    expect(saved.ungroupedTabs).toHaveLength(0); // la tab loose NO entra

    const stored = /** @type {any} */ (h.dumpLocal().sessions)[saved.id];
    expect(stored.name).toContain('Research docs');
  });

  it('valida argumentos y grupo inexistente sin colgar', async () => {
    const bad = await handleMessage({ type: MSG.SAVE_GROUP_AS_SESSION });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/required/);

    const winId = seedGroupWindow();
    const missing = await handleMessage({ type: MSG.SAVE_GROUP_AS_SESSION, windowId: winId, groupId: 999 });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not found/i);
  });
});

describe('openCount + lastOpened al restaurar (Fase 7.1 × 6.3)', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
    repo.invalidate();
  });

  async function seedSaved(template = false) {
    return repo.saveSession({
      id: 'sess-x',
      name: template ? 'Template' : 'Normal',
      created: Date.now(),
      updated: Date.now(),
      groups: [],
      ungroupedTabs: [
        { id: 't1', url: 'https://example.com/a', title: 'A', favicon: '', tags: [], savedAt: Date.now() },
      ],
      metadata: { groupCount: 0, tabCount: 1 },
      ...(template ? { isTemplate: true } : {}),
    });
  }

  it('restore normal bumpa lastOpened Y openCount=1, luego 2', async () => {
    await seedSaved(false);
    const r1 = await handleMessage({ type: MSG.RESTORE_SESSION, sessionId: 'sess-x' });
    expect(r1.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget updateSession
    let after = await repo.getSession('sess-x');
    expect(after?.lastOpened).toBeGreaterThan(0);
    expect(after?.openCount).toBe(1);

    const r2 = await handleMessage({ type: MSG.RESTORE_SESSION, sessionId: 'sess-x' });
    expect(r2.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    after = await repo.getSession('sess-x');
    expect(after?.openCount).toBe(2);
  });

  it('plantillas quedan exentas (ni lastOpened ni openCount)', async () => {
    await seedSaved(true);
    const res = await handleMessage({ type: MSG.RESTORE_SESSION, sessionId: 'sess-x' });
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const after = await repo.getSession('sess-x');
    expect(after?.lastOpened).toBeUndefined();
    expect(after?.openCount).toBeUndefined();
  });
});

describe('comandos globales (+3, Fase 7.2)', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
    repo.invalidate();
  });

  it('toggle-theme alterna dark↔light SIN abrir UI; desconocido → false', async () => {
    /** @type {string[]} */
    const opened = [];
    await handleGlobalCommand('toggle-theme', {
      repo,
      openUi: () => opened.push('ui'),
    });
    expect((await repo.getSettings()).theme).toBe('light');
    expect(opened).toEqual([]);

    await handleGlobalCommand('toggle-theme', { repo, openUi: () => opened.push('ui') });
    expect((await repo.getSettings()).theme).toBe('dark');

    await handleGlobalCommand('nope', { repo, openUi: () => opened.push('ui') });
    expect(opened).toEqual([]);
  });

  it('quick-switcher deja intención en storage.session y consumeUiIntent la lee UNA vez', async () => {
    /** @type {boolean[]} */
    const opened = [];
    const handled = await handleGlobalCommand('quick-switcher', {
      repo,
      openUi: () => opened.push(true),
    });
    expect(handled).toBe(true);
    expect(opened).toHaveLength(1); // se abrió la UI

    expect(await consumeUiIntent()).toBe('quick-switcher');
    expect(await consumeUiIntent()).toBeNull(); // consumida: no repite
  });

  it('quick-search marca la intención de búsqueda', async () => {
    await handleGlobalCommand('quick-search', { repo, openUi: () => {} });
    expect(await consumeUiIntent()).toBe('quick-search');
  });
});

describe('ops nuevas vía REPO_OP (whitelist single-writer)', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
    repo.invalidate();
  });

  /**
   * Aserción de fixture: normalizeSession puede devolver null.
   * @param {import('../../shared/types.js').Session | null | undefined} s
   * @returns {import('../../shared/types.js').Session}
   */
  const must = (s) => {
    if (s == null) throw new Error('fixture inválida');
    return s;
  };

  it('renameTag propaga desde un mensaje del popup', async () => {
    const s = must(
      normalizeSession({
        id: 's1',
        name: 'S',
        groups: [{ id: 'g1', name: 'G', tags: ['old'], tabs: [] }],
        ungroupedTabs: [],
      })
    );
    await repo.saveSession(s);

    const res = await handleMessage({ type: MSG.REPO_OP, op: 'renameTag', args: ['old', 'new'] });
    expect(res.ok).toBe(true);
    const fresh = await repo.getSession('s1');
    expect(fresh?.groups[0].tags).toEqual(['new']);
  });

  it('setSessionOrder persiste el orden manual', async () => {
    for (const id of ['a', 'b']) {
      const s = must(normalizeSession({ id, name: id.toUpperCase(), groups: [], ungroupedTabs: [] }));
      await repo.saveSession(s);
    }
    const res = await handleMessage({
      type: MSG.REPO_OP,
      op: 'setSessionOrder',
      args: [['b', 'a']],
    });
    expect(res.ok).toBe(true);
    const a = await repo.getSession('a');
    const b = await repo.getSession('b');
    expect(b?.order).toBe(1);
    expect(a?.order).toBe(2);
  });

  it('op fuera de whitelist sigue rechazada', async () => {
    const res = await handleMessage({ type: MSG.REPO_OP, op: 'dropTables', args: [] });
    expect(res.ok).toBe(false);
  });
});
