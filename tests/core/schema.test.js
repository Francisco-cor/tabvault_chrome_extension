// tests/core/schema.test.js — Normalizadores y validación de imports

import { describe, it, expect } from 'vitest';
import {
  safeUrl,
  safeFavicon,
  normalizeTab,
  normalizeGroup,
  normalizeSession,
  normalizeSettings,
  validateImportPayload,
} from '../../core/schema.js';

describe('safeUrl', () => {
  it('acepta http/https/mailto/file', () => {
    expect(safeUrl('https://x.com')).toBe('https://x.com/');
    expect(safeUrl('http://x.com/a?b=1')).toBe('http://x.com/a?b=1');
    expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeUrl('file:///C:/tmp')).toBe('file:///C:/tmp');
  });

  it('bloquea javascript:, data:, chrome:', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('data:text/html,<h1>x</h1>')).toBe('');
    expect(safeUrl('chrome://settings')).toBe('');
    expect(safeUrl('vbscript:x')).toBe('');
  });

  it('URL inválida → ""', () => {
    expect(safeUrl(':::::')).toBe('');
    expect(safeUrl(42)).toBe('');
    expect(safeUrl(null)).toBe('');
  });
});

describe('safeFavicon', () => {
  it('acepta data:image e https', () => {
    expect(safeFavicon('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA');
    expect(safeFavicon('https://cdn.x/f.png')).toBe('https://cdn.x/f.png');
  });

  it('rechaza svg/html/js y tamaños absurdos', () => {
    expect(safeFavicon('data:image/svg+xml;base64,XXX')).toBe('');
    expect(safeFavicon('javascript:alert(1)')).toBe('');
    expect(safeFavicon('x'.repeat(70_000))).toBe('');
    expect(safeFavicon(undefined)).toBe('');
  });
});

describe('normalizeTab', () => {
  it('repara campos faltantes y acota longitud de nota', () => {
    const t = normalizeTab({ url: 'https://ok.dev/p' });
    expect(t).toMatchObject({ title: 'https://ok.dev/p', favicon: '', note: '', tags: [] });
    expect(t?.id).toBeTruthy();
  });

  it('descarta tabs con URL insegura (null)', () => {
    expect(normalizeTab({ url: 'javascript:alert(1)', title: 'evil' })).toBeNull();
    expect(normalizeTab({})).toBeNull();
    expect(normalizeTab(null)).toBeNull();
  });

  it('normaliza tags: recorta, limpia, deduplica, cap 24', () => {
    const tags = Array.from({ length: 30 }, (_, i) => ` t${i} `);
    const t = /** @type {any} */ (normalizeTab({ url: 'https://t.io', tags, note: 'n'.repeat(9999) }));
    expect(t.tags).toHaveLength(24);
    expect(t.tags[0]).toBe('t0');
    expect(t.note.length).toBe(4000);
  });
});

describe('normalizeGroup', () => {
  it('color inválido cae a purple; nombre vacío → Untitled Group', () => {
    const g = normalizeGroup({ name: '', color: 'neon-pink' });
    expect(g?.color).toBe('purple');
    expect(g?.name).toBe('Untitled Group');
  });

  it('filtra tabs inseguras dentro del grupo', () => {
    const g = normalizeGroup({
      name: 'g',
      tabs: [{ url: 'https://ok.com' }, { url: 'javascript:x' }],
    });
    expect(g?.tabs).toHaveLength(1);
  });
});

describe('normalizeSession', () => {
  it('metadata SIEMPRE recalculada (no se confía en la almacenada)', () => {
    const s = normalizeSession({
      name: 'S',
      groups: [makeGroupSafe()],
      ungroupedTabs: [{ url: 'https://u.com' }],
      metadata: { groupCount: 77, tabCount: 0 },
    });
    expect(s?.metadata).toEqual({ groupCount: 1, tabCount: 2 });
  });

  it('sin id genera uno; updated nunca < created', () => {
    const s = normalizeSession({ name: 'X', created: 5000, updated: 1000 });
    expect(s?.id).toBeTruthy();
    expect(s?.updated).toBeGreaterThanOrEqual(5000);
  });

  it('flags autoSaved/pinned solo si true', () => {
    expect(normalizeSession({ pinned: true })?.pinned).toBe(true);
    expect(normalizeSession({})?.pinned).toBeUndefined();
    expect(normalizeSession(null)).toBeNull();
  });

  /** helper local */
  function makeGroupSafe() {
    return { id: 'g', name: 'G', color: 'blue', tags: [], note: '', tabs: [{ url: 'https://g.com' }] };
  }
});

describe('normalizeSettings', () => {
  it('defaults completos sobre entrada vacía', () => {
    expect(normalizeSettings(undefined)).toEqual({
      theme: 'dark',
      accent: 'blue',
      sortBy: 'newest',
      autoSaveMinutes: 0,
      autoSaveOnClose: true,
      includeIncognito: false,
      minAutoSaveTabs: 2,
      syncEnabled: false,
      trashPurgeDays: 30,
      dedupeOnRestore: false,
      dedupeOnSave: true,
      excludedDomains: [],
      dupThreshold: 80,
      onboardingDone: false,
      workspace: '',
      lastManualExport: 0,
      reminderDismissedAt: 0,
      newTabEnabled: false,
      historyEnabled: false,
      suspendHours: 4,
      focusWhitelist: [],
    });
  });

  it('settings nuevas de Fase 5 se validan (theme system, accent, onboarding)', () => {
    const s = normalizeSettings({ theme: 'system', accent: 'purple', onboardingDone: true });
    expect(s.theme).toBe('system');
    expect(s.accent).toBe('purple');
    expect(s.onboardingDone).toBe(true);

    // Valores inválidos → defaults seguros; coerción booleana estricta (=== true)
    const bad = normalizeSettings({ theme: 'solarized', accent: 'magenta', onboardingDone: 'yes' });
    expect(bad.theme).toBe('dark');
    expect(bad.accent).toBe('blue');
    expect(bad.onboardingDone).toBe(false);

    // legacy 'light' se respeta igual que antes
    expect(normalizeSettings({ theme: 'light' }).theme).toBe('light');
  });

  it('settings nuevas de Fase 3 se validan y acotan', () => {
    const s = normalizeSettings({
      autoSaveOnClose: 'no',
      includeIncognito: true,
      minAutoSaveTabs: 999,
      dedupeOnRestore: true,
    });
    expect(s.autoSaveOnClose).toBe(false);
    expect(s.includeIncognito).toBe(true);
    expect(s.minAutoSaveTabs).toBe(2); // 999 fuera de rango → default
    expect(s.dedupeOnRestore).toBe(true);

    // legacy sin la clave → default true (no rompe upgrades)
    const legacy = normalizeSettings({ theme: 'dark' });
    expect(legacy.autoSaveOnClose).toBe(true);
    expect(legacy.minAutoSaveTabs).toBe(2);
  });

  it('valores fuera de whitelist vuelven a defaults seguros', () => {
    const s = normalizeSettings({
      theme: 'solarized',
      sortBy: 'random',
      autoSaveMinutes: 7,
      syncEnabled: 'yes',
      trashPurgeDays: 99999,
    });
    expect(s).toMatchObject({
      theme: 'dark',
      sortBy: 'newest',
      autoSaveMinutes: 0,
      syncEnabled: false,
      trashPurgeDays: 30,
    });
  });

  it('acepta valores válidos', () => {
    const s = normalizeSettings({ theme: 'light', sortBy: 'az', autoSaveMinutes: 15, trashPurgeDays: 7 });
    expect(s).toMatchObject({ theme: 'light', sortBy: 'az', autoSaveMinutes: 15, trashPurgeDays: 7 });
  });
});

describe('validateImportPayload', () => {
  it('rechaza sin marcador _tabvault', () => {
    expect(validateImportPayload({}).ok).toBe(false);
    expect(validateImportPayload(null).ok).toBe(false);
    expect(validateImportPayload({ _tabvault: 'yes' }).ok).toBe(false);
  });

  it('archivo hostil NO contamina: javascript: urls descartadas itemizadamente', () => {
    const r = validateImportPayload({
      _tabvault: true,
      sessions: {
        evil: {
          id: 'evil',
          name: '<script>alert(1)</script>',
          groups: [],
          ungroupedTabs: [{ url: 'javascript:alert(document.cookie)' }, { url: 'not a url' }],
        },
      },
    });
    expect(r.ok).toBe(true); // el archivo ES válido como formato…
    expect(r.value.sessions?.evil.ungroupedTabs).toHaveLength(0); // …pero sin URLs peligrosas
    expect(r.errors.join(' ')).toMatch(/descartada|omitida|inválida/);
    // el nombre hostil queda acotado pero presente como texto plano escapable por la UI
    expect(r.value.sessions?.evil.name).toContain('<script>');
  });

  it('merge de basura estructural produce errores, no excepciones', () => {
    const r = validateImportPayload({
      _tabvault: true,
      sessions: 'no-soy-un-mapa',
      versions: { s1: 'tampoco' },
      trash: { t1: null },
    });
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(r.value)).toHaveLength(0);
  });

  it('sesión sin id recibe uno nuevo en vez de rechazar el archivo', () => {
    const r = validateImportPayload({
      _tabvault: true,
      sessions: { k: { name: 'sin id' } },
    });
    expect(r.ok).toBe(true);
    const s = Object.values(r.value.sessions ?? {})[0];
    expect(s.id).toBeTruthy();
  });

  it('versiones se saneian y limitan a 20', () => {
    const list = Array.from({ length: 50 }, (_, i) => ({
      snapshot: { name: `v${i}` },
      savedAt: i + 1,
    }));
    const r = validateImportPayload({ _tabvault: true, versions: { s1: list } });
    expect(r.value.versions?.s1).toHaveLength(20);
  });
});
