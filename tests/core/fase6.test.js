// tests/core/fase6.test.js — Fase 6: auto-nombrado puro + normalización de los
// campos nuevos de Settings/Session.
import { describe, it, expect } from 'vitest';
import { suggestSessionName, prettyHost, fallbackSessionName } from '../../core/domain.js';
import { normalizeSettings, normalizeSession, DEFAULT_SETTINGS } from '../../core/schema.js';
import { makeSession, makeTab } from '../fixtures/sessions.js';

describe('suggestSessionName (Fase 6.1)', () => {
  it('dominio predominante primero; empate → alfabético', () => {
    const name = suggestSessionName([
      { url: 'https://github.com/a' },
      { url: 'https://github.com/b' },
      { url: 'https://apple.com' },
      { url: 'https://amazon.com' },
    ]);
    expect(name).toBe('GitHub · Amazon · Apple');
  });

  it('más de 3 dominios colapsa el resto en (N)', () => {
    const name = suggestSessionName([
      { url: 'https://a.com' },
      { url: 'https://b.com' },
      { url: 'https://c.com' },
      { url: 'https://d.com' },
      { url: 'https://e.com' },
    ]);
    expect(name).toBe('A · B · C (2)');
  });

  it('nombres bonitos para dominios frecuentes', () => {
    expect(prettyHost('mail.google.com')).toBe('Gmail');
    expect(prettyHost('github.com')).toBe('GitHub');
    expect(prettyHost('docs.google.com')).toBe('Docs');
  });

  it('www se ignora y la primera etiqueta se capitaliza como fallback', () => {
    const name = suggestSessionName([{ url: 'https://www.stackoverflow.com/q/1' }]);
    expect(name).toContain('Stack Overflow');
  });

  it('sin URLs válidas → fallback determinista por fecha', () => {
    const fixed = Date.UTC(2026, 7, 22);
    expect(fallbackSessionName(fixed)).toMatch(/session$/);
    expect(suggestSessionName([{ url: 'about:blank' }, { url: 'nope' }, {}], fixed)).toMatch(/session$/);
  });
});

describe('normalizeSettings — campos nuevos (Fase 6)', () => {
  it('defaults: dedupeOnSave ON, umbral 80, sin dominios excluidos', () => {
    const s = normalizeSettings(undefined);
    expect(s.dedupeOnSave).toBe(true);
    expect(s.dupThreshold).toBe(80);
    expect(s.excludedDomains).toEqual([]);
  });

  it('umbral fuera de 50–95 cae al default', () => {
    expect(normalizeSettings({ dupThreshold: 49 }).dupThreshold).toBe(DEFAULT_SETTINGS.dupThreshold);
    expect(normalizeSettings({ dupThreshold: 120 }).dupThreshold).toBe(DEFAULT_SETTINGS.dupThreshold);
    expect(normalizeSettings({ dupThreshold: 95 }).dupThreshold).toBe(95);
  });

  it('dedupeOnSave undefined → true; explícito false se respeta', () => {
    expect(normalizeSettings({}).dedupeOnSave).toBe(true);
    expect(normalizeSettings({ dedupeOnSave: false }).dedupeOnSave).toBe(false);
  });

  it('excludedDomains sanea hostnames y respeta el cap de 64', () => {
    const s = normalizeSettings({
      excludedDomains: ['HTTPS://GitHub.com/path', 'News.ycombinator.com/', 42, '', 'javascript:x'],
    });
    expect(s.excludedDomains).toEqual(['github.com', 'news.ycombinator.com']);

    const many = Array.from({ length: 80 }, (_, i) => `d${i}.com`);
    expect(normalizeSettings({ excludedDomains: many }).excludedDomains).toHaveLength(64);
  });
});

describe('normalizeSession — flags de Fase 6', () => {
  it('preserva isTemplate/stash/lastOpened', () => {
    const s = normalizeSession(makeSession({ id: 'x', isTemplate: true, stash: false, lastOpened: 1234 }));
    expect(s?.isTemplate).toBe(true);
    expect(s?.stash).toBeUndefined(); // solo true se persiste
    expect(s?.lastOpened).toBe(1234);
  });

  it('lastOpened inválido (≤0) no se persiste', () => {
    const s = normalizeSession(makeSession({ id: 'y', lastOpened: 0 }));
    expect(s?.lastOpened).toBeUndefined();
  });

  it('una tab de plantilla conserva pinned tras normalizar', () => {
    const s = normalizeSession(makeSession({ ungroupedTabs: [makeTab({ pinned: true })] }));
    expect(s?.ungroupedTabs[0].pinned).toBe(true);
  });
});
