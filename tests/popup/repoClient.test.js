// tests/popup/repoClient.test.js — Fachada popup (ADR-0002): lecturas locales
// instantáneas, escrituras enrutadas al SW por REPO_OP, whitelist dinámica.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';

/** @type {ReturnType<typeof installChromeMock>} */
let handle;
/** @type {typeof import('../../popup/repoClient.js')['repo']} */
let repo;

beforeEach(async () => {
  handle = installChromeMock();
  handle.reset();
  // canal de mensajes: el "SW" responde ejecutando la misma op sobre storage
  handle.chrome.runtime.sendMessage = async (/** @type {any} */ msg) => {
    if (msg?.type !== 'REPO_OP') return { ok: false, error: 'unknown' };
    // whitelist real del SW (REMOTE_OPS) antes de despachar
    const { Repository, REMOTE_OPS } = await import('../../core/repository.js');
    if (!REMOTE_OPS.has(msg.op)) return { ok: false, error: `Unknown repo op: ${msg.op}` };
    // simula el SW: muta storage.local directamente vía un repo writable real
    const swRepo = new Repository({ writable: true });
    try {
      const data = await /** @type {any} */ (swRepo)[msg.op](...(msg.args ?? []));
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  // Import DINÁMICO tras el stub: repoClient llama local.attach() al cargar.
  ({ repo } = await import('../../popup/repoClient.js'));
});

afterEach(() => {
  handle.unmock();
  handle.reset();
});

describe('repoClient (fachada popup)', () => {
  it('lecturas se sirven localmente (sin sendMessage)', async () => {
    let sent = 0;
    handle.chrome.runtime.sendMessage = async () => {
      sent++;
      return { ok: true };
    };
    const settings = await repo.getSettings();
    expect(settings.theme).toBe('dark');
    expect(sent).toBe(0);
  });

  it('escritura saveSession va por REPO_OP y persiste en storage', async () => {
    const saved = await repo.saveSession({
      id: 'via-popup',
      name: 'Desde popup',
      created: 1,
      updated: 1,
      groups: [],
      ungroupedTabs: [],
    });
    expect(saved.id).toBe('via-popup');
    const dump = handle.dumpLocal();
    expect(dump.sessions['via-popup']).toBeTruthy();
  });

  it('error del SW se propaga como excepción', async () => {
    handle.chrome.runtime.sendMessage = async () => ({ ok: false, error: 'boom' });
    await expect(repo.saveSession({ id: 'x', name: 'n', created: 1, updated: 1 })).rejects.toThrow('boom');
  });

  it('op fuera de whitelist es rechazada por el SW', async () => {
    const res = await handle.chrome.runtime.sendMessage({
      type: 'REPO_OP',
      op: 'deleteEverything',
      args: [],
    });
    expect(res).toEqual({ ok: false, error: 'Unknown repo op: deleteEverything' });
  });
});
