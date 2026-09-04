// tests/shared/utils.test.js — Tests de shared/utils.js
// El motor de búsqueda migró a core/searchIndex.js en Fase 7: su cobertura vive
// ahora en tests/core/searchIndex.test.js (con el fuzzy mejorado).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatRelativeTime,
  formatDate,
  truncateUrl,
  groupColorHex,
  sanitizeName,
} from '../../shared/utils.js';

describe('formatRelativeTime', () => {
  const NOW = 1_700_000_000_000;
  /** @type {import('vitest').MockInstance} */
  let dateSpy;
  beforeEach(() => {
    dateSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => dateSpy.mockRestore());

  it('"just now" bajo 1 min', () => {
    expect(formatRelativeTime(NOW - 30_000)).toBe('just now');
  });
  it('minutos', () => {
    expect(formatRelativeTime(NOW - 5 * 60_000)).toBe('5m ago');
  });
  it('horas', () => {
    expect(formatRelativeTime(NOW - 3 * 3_600_000)).toBe('3h ago');
  });
  it('días', () => {
    expect(formatRelativeTime(NOW - 2 * 86_400_000)).toBe('2d ago');
  });
  it('> 30 días cae a fecha local', () => {
    expect(formatRelativeTime(NOW - 40 * 86_400_000)).toMatch(/\d/);
  });
});

describe('truncateUrl', () => {
  it('hostname + path', () => {
    expect(truncateUrl('https://github.com/tabvault/pulls')).toBe('github.com/tabvault/pulls');
  });
  it('hostname solo si path es /', () => {
    expect(truncateUrl('https://google.com/')).toBe('google.com');
  });
  it('trunca con ellipsis al superar maxLen', () => {
    const out = truncateUrl('https://example.com/' + 'x'.repeat(60), 20);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(21);
  });
  it('URL inválida cae back a slice plano', () => {
    // ':'.repeat(10) no tiene esquema → new URL lanza → fallback slice
    expect(truncateUrl(':'.repeat(10), 7)).toBe(':::::::');
  });
  it('quirk: strings con esquema arbitrario SÍ parsean como URL', () => {
    // 'not-a-url:::' se interpreta como scheme "not-a-url" con path "::"
    expect(truncateUrl('not-a-url:::', 20)).toBe('::');
  });
});

describe('groupColorHex', () => {
  it('mapea colores válidos', () => {
    expect(groupColorHex('blue')).toBe('#1a73e8');
  });
  it('fallback purple para desconocidos', () => {
    expect(groupColorHex('magenta-neon')).toBe('#a142f4');
  });
});

describe('sanitizeName', () => {
  it('reemplaza caracteres ilegales de filename', () => {
    expect(sanitizeName('mi/sesion: "final"?')).toBe('mi-sesion- -final--');
  });
  it('vacío produce default', () => {
    expect(sanitizeName('   ')).toBe('tabvault-export');
  });
});

describe('formatDate', () => {
  it('produce string localizado no vacío', () => {
    expect(formatDate(1_700_000_000_000)).toBeTruthy();
  });
});
