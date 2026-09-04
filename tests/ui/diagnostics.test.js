// tests/ui/diagnostics.test.js — Ring-buffer de errores en storage.session (4.6)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { logDiagnostic, getDiagnostics } from '../../ui/services/diagnostics.js';

/** @type {ReturnType<typeof installChromeMock>} */
let handle;

beforeEach(() => {
  handle = installChromeMock();
  handle.reset();
});
afterEach(() => {
  handle.unmock();
  handle.reset();
});

describe('logDiagnostic / getDiagnostics', () => {
  it('guarda message + stack acotado de un Error', async () => {
    await logDiagnostic(new TypeError('boom at x'));
    const list = await getDiagnostics();
    expect(list.length).toBe(1);
    expect(list[0].message).toContain('boom at x');
    expect(typeof list[0].at).toBe('number');
    expect(list[0].stack.length).toBeLessThanOrEqual(2000);
  });

  it('valores no-Error se stringifican; cap 30 entradas', async () => {
    for (let i = 0; i < 35; i++) await logDiagnostic(`err-${i}`);
    const list = await getDiagnostics();
    expect(list.length).toBe(30);
    expect(list[0].message).toBe('err-5');
    expect(list[29].message).toBe('err-34');
  });

  it('sin storage.session disponible → getDiagnostics [] sin lanzar', async () => {
    handle.unmock();
    await logDiagnostic('nada');
    expect(await getDiagnostics()).toEqual([]);
  });
});
