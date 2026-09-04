// tests/shared/logger.test.js — Logger local con niveles y ring-buffer (Fase 10.5)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import {
  log,
  setLevel,
  getLevel,
  createLogger,
  getRecentLogs,
  buildSupportReport,
  __resetForTests,
} from '../../shared/logger.js';

/** @type {ReturnType<typeof installChromeMock>|null} */
let handle;

beforeEach(() => {
  handle = installChromeMock();
  handle.chrome.runtime.getManifest = () => /** @type {any} */ ({ version: '1.0.0' });
  __resetForTests();
  setLevel('debug');
});
afterEach(() => {
  handle?.unmock();
  handle?.reset();
  setLevel('warn');
  vi.restoreAllMocks();
});

describe('niveles', () => {
  it('setLevel/getLevel round-trip', () => {
    setLevel('error');
    expect(getLevel()).toBe('error');
    setLevel('debug');
    expect(getLevel()).toBe('debug');
  });

  it('filtra por umbral: con level=warn, debug/info no llegan al ring', async () => {
    setLevel('warn');
    log('debug', 'test', 'no debería entrar');
    log('info', 'test', 'tampoco');
    log('warn', 'test', 'sí');
    log('error', 'test', 'y esto');
    const logs = await getRecentLogs();
    const levels = logs.map((/** @type {any} */ l) => l.level);
    expect(levels).toEqual(['warn', 'error']);
  });
});

describe('ring-buffer en storage.session', () => {
  it('append + lectura con área/mensaje/timestamp', async () => {
    log('info', 'capture', 'hola', { tabs: 3 });
    const logs = await getRecentLogs();
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatchObject({ level: 'info', area: 'capture', message: 'hola' });
    expect(typeof logs[0].at).toBe('number');
  });

  it('respeta el cap de 200 entradas', async () => {
    for (let i = 0; i < 210; i++) log('info', 'bulk', `m${i}`);
    const logs = await getRecentLogs();
    expect(logs.length).toBe(200);
    expect(logs[0].message).toBe('m10'); // los más viejos fueron expulsados
    expect(logs[199].message).toBe('m209');
  });

  it('extra no serializable se degrada sin romper', async () => {
    const circular = /** @type {any} */ ({});
    circular.self = circular;
    expect(() => log('warn', 'x', 'msg', circular)).not.toThrow();
    const logs = await getRecentLogs();
    expect(logs.length).toBe(1);
  });
});

describe('createLogger', () => {
  it('prefija el área en cada nivel', async () => {
    const lg = createLogger('restore');
    lg.debug('d');
    lg.info('i');
    lg.warn('w');
    lg.error('e');
    const logs = await getRecentLogs();
    expect(logs.map((/** @type {any} */ l) => `${l.area}:${l.level}:${l.message}`)).toEqual([
      'restore:debug:d',
      'restore:info:i',
      'restore:warn:w',
      'restore:error:e',
    ]);
  });
});

describe('fallback en memoria (sin chrome.storage.session)', () => {
  it('degrada a ring en memoria y getRecentLogs lo sirve', async () => {
    handle?.unmock(); // sin chrome global
    __resetForTests();
    log('warn', 'mem', 'sin storage');
    const logs = await getRecentLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ area: 'mem', message: 'sin storage' });
  });
});

describe('buildSupportReport', () => {
  it('incluye versión, UA, nivel y logs; sin URLs de navegación', async () => {
    log('info', 'boot', 'sw started');
    const report = await buildSupportReport({ errors: [{ at: 1, message: 'boom' }] });
    expect(report).toContain('TabVault diagnostics');
    expect(report).toContain('version: 1.0.0');
    expect(report).toContain('logLevel: debug');
    expect(report).toContain('[boot] sw started');
    expect(report).toContain('boom');
    expect(report).toContain('local only');
  });
});
