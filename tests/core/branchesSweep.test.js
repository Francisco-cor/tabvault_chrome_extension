// tests/core/branchesSweep.test.js — Barrido final de branches core (Fase 10.4):
// domain (dedupe/merge/jaccard/suggest/reattach), favicons, schema, backups.

import { describe, it, expect } from 'vitest';
import {
  computeMetadata,
  dedupeTabsInSession,
  mergeSessionsInto,
  jaccardSimilarity,
  findDuplicateOf,
  suggestSessionName,
  reattachFavicons,
  cloneCleanSession,
} from '../../core/domain.js';
import { rememberFavicons, collectFaviconsFromVault, normalizeFaviconStore } from '../../core/favicons.js';
import { normalizeSettings, normalizeTab, validateImportPayload } from '../../core/schema.js';
import { buildBackupEntry } from '../../core/backups.js';

const tab = (over = {}) => ({
  id: 't',
  url: 'https://x.com/a',
  title: 'A',
  favicon: '',
  note: '',
  tags: [],
  savedAt: 1,
  ...over,
});
/** @param {any[]} tabs @param {Record<string, any>} [over] @returns {any} */
const group = (tabs, over = {}) => ({ id: 'g', name: 'G', color: 'blue', tags: [], note: '', tabs, ...over });
const session = (over = {}) => ({
  id: 's1',
  name: 'S',
  created: 1,
  updated: 1,
  groups: [],
  ungroupedTabs: [],
  ...over,
});

describe('domain.js (branches)', () => {
  it('computeMetadata tolera groups/ungrouped ausentes', () => {
    expect(computeMetadata(/** @type {any} */ ({}))).toEqual({ groupCount: 0, tabCount: 0 });
    expect(
      computeMetadata(/** @type {any} */ ({ groups: [{ tabs: [tab()] }, {}], ungroupedTabs: undefined }))
    ).toEqual({ groupCount: 2, tabCount: 1 });
  });

  it('dedupeTabsInSession conserva el título más reciente y une tags', () => {
    const s = session({
      ungroupedTabs: [
        tab({ id: 'a', url: 'https://x.com/', title: 'viejo', savedAt: 1, tags: ['uno'] }),
        tab({ id: 'b', url: 'https://x.com/', title: 'nuevo', savedAt: 2, tags: ['dos'] }),
      ],
    });
    const { session: out, removed } = dedupeTabsInSession(/** @type {any} */ (s));
    expect(removed).toBe(1);
    expect(out.ungroupedTabs.length).toBe(1);
    expect(out.ungroupedTabs[0].title).toBe('nuevo');
    expect(out.ungroupedTabs[0].tags).toEqual(['uno', 'dos']);
  });

  it('mergeSessionsInto con grupos y sin fuentes', () => {
    const src = session({
      groups: [group([tab()])],
      ungroupedTabs: [tab({ url: 'https://y.com/b' })],
    });
    const merged = mergeSessionsInto(/** @type {any} */ ([src]), 'Merged');
    expect(merged.name).toBe('Merged');
    expect(merged.groups.length).toBe(1);
    expect(merged.ungroupedTabs.length).toBe(1);
    // ids regenerados
    expect(merged.groups[0].tabs[0].id).not.toBe('t');
  });

  it('jaccardSimilarity: ambos vacíos → 0; disjuntos → 0; parcial → ratio', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(['https://a.com']), new Set(['https://b.com']))).toBe(0);
    expect(jaccardSimilarity(new Set(['https://a.com', 'https://b.com']), new Set(['https://a.com']))).toBe(
      0.5
    );
    expect(jaccardSimilarity(new Set(['https://a.com']), new Set(['https://a.com']))).toBe(1);
  });

  it('findDuplicateOf: sin URLs actuales → null; umbral 0–1 borde', () => {
    const sessions = {
      s1: session({ ungroupedTabs: [tab({ url: 'https://a.com/1' }), tab({ url: 'https://b.com/2' })] }),
    };
    expect(findDuplicateOf(new Set(), /** @type {any} */ (sessions), 0.8)).toBeNull();
    expect(
      findDuplicateOf(new Set(['https://a.com/1', 'https://b.com/2']), /** @type {any} */ (sessions), 0.8)
        ?.session.id
    ).toBe('s1');
    expect(findDuplicateOf(new Set(['https://a.com/1']), /** @type {any} */ (sessions), 0.8)).toBeNull(); // 50% < 80%
  });

  it('suggestSessionName: vacío → fecha; host genérico usa label especial', () => {
    const named = suggestSessionName([tab({ url: 'https://mail.google.com/x' })]);
    expect(named).toContain('Gmail');
    expect(suggestSessionName([])).toBeTypeOf('string');
  });

  it('reattachFavicons: source null / sin favicons / target con grupos', () => {
    const target = session({
      groups: [group([tab({ favicon: '' })])],
      ungroupedTabs: [tab({ url: 'https://y.com/b', favicon: '' })],
    });
    expect(reattachFavicons(/** @type {any} */ (target), null)).toBe(target);
    // source con favicons en grupos y ungrouped
    const source = session({
      groups: [group([tab({ url: 'https://x.com/a', favicon: 'data:image/png;base64,G' })])],
      ungroupedTabs: [tab({ url: 'https://y.com/b', favicon: 'data:image/png;base64,U' })],
    });
    const out = reattachFavicons(/** @type {any} */ (structuredClone(target)), /** @type {any} */ (source));
    expect(out.groups[0].tabs[0].favicon).toBe('data:image/png;base64,G');
    expect(out.ungroupedTabs[0].favicon).toBe('data:image/png;base64,U');
  });

  it('cloneCleanSession clona profundo sin referencias', () => {
    const s = /** @type {any} */ (session({ groups: [group([tab()])] }));
    const copy = cloneCleanSession(s);
    copy.groups[0].tabs[0].title = 'mutado';
    expect(s.groups[0].tabs[0].title).toBe('A');
  });
});

describe('favicons.js (branches restantes)', () => {
  it('rememberFavicons con store hostil y pairs no-array', () => {
    expect(rememberFavicons(/** @type {any} */ (null), /** @type {any} */ ('nope'), 1)).toEqual({
      entries: {},
      bytes: 0,
    });
    const out = rememberFavicons(
      /** @type {any} */ ({ entries: {}, bytes: 'x' }),
      [{ url: 'https://a.com', dataUrl: 'data:image/png;base64,AA' }],
      1
    );
    expect(Object.keys(out.entries)).toEqual(['a.com']);
  });

  it('usedAt no finito cae a Date.now(); data >60k se trunca', () => {
    const out = rememberFavicons(
      /** @type {any} */ (undefined),
      [{ domain: 'big.com', dataUrl: 'data:image/png;base64,' + 'A'.repeat(70_000) }],
      Number.NaN
    );
    expect(out.entries['big.com'].data.length).toBe(60_000);
    expect(out.entries['big.com'].usedAt).toBeGreaterThan(0);
  });

  it('normalizeFaviconStore respeta cap MAX_DOMAINS y usedAt inválido', () => {
    /** @type {Record<string, any>} */
    const entries = {};
    for (let i = 0; i < 2010; i++) entries[`d${i}.com`] = { data: 'data:image/png;base64,A', usedAt: 'x' };
    const out = normalizeFaviconStore({ entries });
    expect(Object.keys(out.entries).length).toBe(2000);
    expect(out.entries['d0.com'].usedAt).toBe(0);
  });

  it('collectFaviconsFromVault salta tabs no-objeto y sesiones basura', () => {
    const data = {
      sessions: {
        s1: {
          groups: [{ tabs: [null, 'x', tab({ favicon: 'data:image/png;base64,A' })] }],
          ungroupedTabs: 'nope',
        },
      },
      trash: 'nope',
    };
    const out = collectFaviconsFromVault(/** @type {any} */ (data), 5);
    expect(Object.keys(out.store.entries)).toEqual(['x.com']);
  });
});

describe('schema.js (branches restantes)', () => {
  it('normalizeSettings: suspendHours fuera de rango cae al default', () => {
    expect(normalizeSettings({ suspendHours: 999 }).suspendHours).toBe(4);
    expect(normalizeSettings({ suspendHours: 0 }).suspendHours).toBe(4);
    expect(normalizeSettings({ suspendHours: 12 }).suspendHours).toBe(12);
  });

  it('normalizeTab no-objeto → null', () => {
    expect(normalizeTab('x')).toBeNull();
    expect(normalizeTab(null)).toBeNull();
  });

  it('validateImportPayload: claves peligrosas en versions y caps de sesiones', () => {
    // JSON.parse para crear la clave real "__proto__" (el literal la trataría
    // como prototype, no como propiedad)
    const hostileDoc = JSON.parse(
      '{"_tabvault":true,"versions":{"__proto__":[{"snapshot":{},"savedAt":1}]}}'
    );
    const hostile = validateImportPayload(hostileDoc);
    expect(hostile.errors.join(' ')).toContain('reservada');

    /** @type {Record<string, any>} */
    const many = {};
    for (let i = 0; i < 5001; i++) many[`s${i}`] = session({ id: `s${i}` });
    const capped = validateImportPayload({ _tabvault: true, sessions: many });
    expect(capped.errors.join(' ')).toContain('máximo');
    expect(Object.keys(capped.value.sessions ?? {}).length).toBe(5000);
  });
});

describe('backups.js (branches)', () => {
  it('buildBackupEntry cuenta tabs con metadata ausente', () => {
    const entry = buildBackupEntry('manual', 5, {
      sessions: { s1: /** @type {any} */ ({}) },
      trash: {},
      versions: {},
      settings: {},
    });
    expect(entry.counts.tabs).toBe(0);
    expect(entry.label).toBe('manual');
  });
});
