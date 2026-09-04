// tests/core/faviconsRepo.test.js — Store LRU de favicons en Repository (Fase 10.2):
// lectura read-through, escritura single-writer con poda, coherencia onChanged
// y ReadOnlyError desde contexto popup.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { Repository } from '../../core/repository.js';

/** @type {ReturnType<typeof installChromeMock>} */
let handle;

beforeEach(() => {
  handle = installChromeMock();
});
afterEach(() => {
  handle.unmock();
  handle.reset();
});

/** @param {number} n */
const ICON = (n) => `data:image/png;base64,${'A'.repeat(n)}`;

describe('Repository.getFavicons / rememberFavicons', () => {
  it('read-through: store vacío → {entries:{},bytes:0}; persistido → normalizado', async () => {
    const repo = new Repository({ writable: true });
    repo.attach();
    expect(await repo.getFavicons()).toEqual({ entries: {}, bytes: 0 });

    await handle.chrome.storage.local.set({
      favicons: { entries: { 'a.com': { data: ICON(10), usedAt: 5 } }, bytes: ICON(10).length },
    });
    expect(Object.keys((await repo.getFavicons()).entries)).toEqual(['a.com']);
  });

  it('rememberFavicons persiste, notifica y es idempotente en bytes', async () => {
    const repo = new Repository({ writable: true });
    /** @type {string[]} */
    const notified = [];
    repo.subscribe((area) => notified.push(area));

    const out = await repo.rememberFavicons([
      { url: 'https://a.com/x', dataUrl: ICON(100) },
      { domain: 'b.com', dataUrl: ICON(50) },
    ]);
    expect(Object.keys(out.entries).sort()).toEqual(['a.com', 'b.com']);
    expect(notified).toContain('favicons');

    const stored = handle.dumpLocal().favicons;
    expect(Object.keys(stored.entries).sort()).toEqual(['a.com', 'b.com']);

    // re-escritura del mismo dato: mismos bytes, sin duplicados
    const out2 = await repo.rememberFavicons([{ url: 'https://a.com/y', dataUrl: ICON(100) }]);
    expect(out2.bytes).toBe(out.bytes);
    expect(Object.keys(out2.entries).length).toBe(2);
  });

  it('caché invalidada por onChanged externo (coherencia C2)', async () => {
    const repo = new Repository({ writable: true });
    repo.attach();
    await repo.rememberFavicons([{ domain: 'a.com', dataUrl: ICON(10) }]);
    expect(Object.keys((await repo.getFavicons()).entries)).toEqual(['a.com']);

    // escritura EXTERNA (otro contexto) → la siguiente lectura la ve
    await handle.chrome.storage.local.set({
      favicons: { entries: { 'z.com': { data: ICON(7), usedAt: 1 } }, bytes: 7 },
    });
    expect(Object.keys((await repo.getFavicons()).entries)).toEqual(['z.com']);
  });

  it('ReadOnlyError desde contexto popup (single-writer, throw síncrono)', () => {
    const repo = new Repository({ writable: false });
    expect(() => repo.rememberFavicons([{ domain: 'a.com', dataUrl: ICON(1) }])).toThrow(
      /requiere contexto writable/
    );
  });
});
