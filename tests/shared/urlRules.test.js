// tests/shared/urlRules.test.js — Única fuente de verdad de URLs capturables (M6).
import { describe, it, expect } from 'vitest';
import { BLOCKED_PREFIXES, isValidTabUrl } from '../../shared/urlRules.js';

describe('shared/urlRules', () => {
  it('acepta URLs http/https/file', () => {
    expect(isValidTabUrl('https://github.com/tabvault')).toBe(true);
    expect(isValidTabUrl('http://localhost:3000/app?x=1')).toBe(true);
    expect(isValidTabUrl('file:///C:/docs/file.pdf')).toBe(true);
  });

  it('rechaza todos los prefijos bloqueados', () => {
    for (const prefix of BLOCKED_PREFIXES) {
      expect(isValidTabUrl(`${prefix}settings`)).toBe(false);
    }
  });

  it('rechaza javascript:, data: y otros esquemas no capturables', () => {
    expect(isValidTabUrl('javascript:alert(1)')).toBe(false);
    expect(isValidTabUrl('data:text/html,<b>x</b>')).toBe(false);
    expect(isValidTabUrl('mailto:user@example.com')).toBe(false);
    expect(isValidTabUrl('ws://example.com')).toBe(false);
  });

  it('rechaza entrada no-string, vacía o demasiado larga', () => {
    expect(isValidTabUrl(undefined)).toBe(false);
    expect(isValidTabUrl(null)).toBe(false);
    expect(isValidTabUrl(42)).toBe(false);
    expect(isValidTabUrl('')).toBe(false);
    expect(isValidTabUrl('https://a.com/' + 'x'.repeat(4000))).toBe(false);
  });

  it('rechaza strings que no parsean como URL', () => {
    expect(isValidTabUrl('no es una url')).toBe(false);
    expect(isValidTabUrl('http://')).toBe(false);
  });
});
