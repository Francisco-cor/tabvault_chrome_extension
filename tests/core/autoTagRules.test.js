// tests/core/autoTagRules.test.js — Reglas de auto-tag puras (Fase 9.5):
// normalización, dedupe, cap 50, aplicación sobre tabs y export/import JSON.

import { describe, it, expect } from 'vitest';
import {
  normalizeRule,
  normalizeRules,
  tagsForUrl,
  applyRulesToTabs,
  exportRules,
  importRules,
} from '../../core/autoTagRules.js';

/** @param {string} id @param {string} pattern @param {string} tag @returns {any} */
const R = (id, pattern, tag) => ({ id, pattern, tag });

describe('normalizeRule', () => {
  it('normaliza pattern a lowercase y recorta tag', () => {
    expect(normalizeRule(R('r1', '  GitHub.COM ', '  code '))).toEqual({
      id: 'r1',
      pattern: 'github.com',
      tag: 'code',
    });
  });

  it('null para inválidos: sin id, pattern vacío, pattern >120, tag vacía, no-objeto', () => {
    expect(normalizeRule(null)).toBeNull();
    expect(normalizeRule('x')).toBeNull();
    expect(normalizeRule({ pattern: 'a', tag: 'b' })).toBeNull(); // sin id
    expect(normalizeRule(R('r1', '', 'b'))).toBeNull();
    expect(normalizeRule(R('r1', 'a'.repeat(121), 'b'))).toBeNull();
    expect(normalizeRule(R('r1', 'a', ''))).toBeNull();
  });
});

describe('normalizeRules', () => {
  it('deduplica por pattern|tag y respeta cap 50', () => {
    const many = Array.from({ length: 60 }, (_, i) => R(`r${i}`, `p${i}`, 't'));
    const out = normalizeRules(many);
    expect(out.length).toBe(50);
    const dupes = [R('a', 'x.com', 'code'), R('b', 'X.COM', 'code'), R('c', 'x.com', 'other')];
    expect(normalizeRules(dupes).length).toBe(2);
  });

  it('no-array → []', () => {
    expect(normalizeRules(null)).toEqual([]);
    expect(normalizeRules('x')).toEqual([]);
  });
});

describe('tagsForUrl', () => {
  const rules = [R('r1', 'github.com', 'code'), R('r2', 'docs', 'reference'), R('r3', 'git', 'vcs')];

  it('match contains case-insensitive; sin duplicados case-insensitive', () => {
    expect(tagsForUrl('https://GitHub.com/x', rules)).toEqual(['code', 'vcs']);
  });

  it('respeta tags existentes (dedup con existing)', () => {
    expect(tagsForUrl('https://github.com/x', rules, new Set(['code']))).toEqual(['vcs']);
  });

  it('sin match o sin reglas → []', () => {
    expect(tagsForUrl('https://nothing.dev/x', rules)).toEqual([]);
    expect(tagsForUrl('', rules)).toEqual([]);
    expect(tagsForUrl('https://github.com', [])).toEqual([]);
    expect(tagsForUrl('https://github.com', /** @type {any} */ (null))).toEqual([]);
  });
});

describe('applyRulesToTabs', () => {
  it('añade tags por tab y devuelve el total añadido', () => {
    const tabs = /** @type {any[]} */ ([
      { url: 'https://github.com/a', tags: [] },
      { url: 'https://docs.x.dev/b', tags: ['keep'] },
      { url: 'https://plain.dev/c', tags: [] },
    ]);
    const added = applyRulesToTabs(tabs, [R('r1', 'github.com', 'code'), R('r2', 'docs', 'reference')]);
    expect(added).toBe(2);
    expect(tabs[0].tags).toEqual(['code']);
    expect(tabs[1].tags).toEqual(['keep', 'reference']);
    expect(tabs[2].tags).toEqual([]);
  });

  it('cap defensivo de 24 tags por tab; no-op con vacíos', () => {
    const full = /** @type {any} */ ({
      url: 'https://github.com/x',
      tags: Array.from({ length: 24 }, (_, i) => `t${i}`),
    });
    // el match cuenta como añadida pero el slice(0,24) mantiene el cap
    expect(applyRulesToTabs([full], [R('r1', 'github', 'more')])).toBe(1);
    expect(full.tags.length).toBe(24);
    expect(full.tags).not.toContain('more');
    expect(applyRulesToTabs([], [R('r1', 'a', 'b')])).toBe(0);
    expect(applyRulesToTabs(/** @type {any} */ ([{ url: 'https://a.com', tags: [] }]), [])).toBe(0);
  });
});

describe('exportRules / importRules', () => {
  it('round-trip sin pérdida', () => {
    const rules = [R('r1', 'github.com', 'code'), R('r2', 'figma', 'design')];
    const { rules: back, errors } = importRules(exportRules(rules));
    expect(errors).toEqual([]);
    expect(back).toEqual(rules);
  });

  it('import tolerante: JSON roto, no-array y mezcla inválida', () => {
    expect(importRules('{broken')).toEqual({ rules: [], errors: ['Invalid JSON'] });
    expect(importRules('{"a":1}')).toEqual({ rules: [], errors: ['Not an array'] });
    const mixed = importRules(JSON.stringify([R('ok', 'a.com', 't'), R('bad', '', 't')]));
    expect(mixed.rules.length).toBe(1);
    expect(mixed.errors[0]).toContain('1 rule(s) ignored');
  });
});
