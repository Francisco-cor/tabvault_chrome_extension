// tests/core/domain.test.js — Funciones puras del dominio

import { describe, it, expect } from 'vitest';
import {
  newId,
  computeMetadata,
  cloneCleanSession,
  dedupeTabsInSession,
  mergeSessionsInto,
  findDuplicateOf,
  reattachFavicons,
} from '../../core/domain.js';
import { makeSession, makeGroup, makeTab } from '../fixtures/sessions.js';

describe('newId', () => {
  it('genera ids únicos', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId()));
    expect(ids.size).toBe(100);
  });
});

describe('computeMetadata', () => {
  it('cuenta grupos y tabs reales', () => {
    const s = makeSession({
      groups: [makeGroup({ tabs: [makeTab(), makeTab()] }), makeGroup({ tabs: [makeTab()] })],
      ungroupedTabs: [makeTab()],
    });
    // metadata mentirosa almacenada
    s.metadata = { groupCount: 99, tabCount: 1 };
    expect(computeMetadata(s)).toEqual({ groupCount: 2, tabCount: 4 });
  });

  it('tolera arrays ausentes', () => {
    const s = makeSession({});
    delete (/** @type {any} */ (s).groups);
    delete (/** @type {any} */ (s).ungroupedTabs);
    expect(computeMetadata(s)).toEqual({ groupCount: 0, tabCount: 0 });
  });
});

describe('cloneCleanSession', () => {
  it('elimina campos internos _score/_matchingTabs/_groupName en profundidad', () => {
    const s = makeSession({
      groups: [makeGroup({ tabs: [/** @type {any} */ ({ ...makeTab(), _groupName: 'X' })] })],
    });
    /** @type {any} */
    const dirty = { ...s, _score: 42, _matchingTabs: [] };
    const clean = /** @type {any} */ (cloneCleanSession(dirty));
    expect(clean._score).toBeUndefined();
    expect(clean._matchingTabs).toBeUndefined();
    expect(clean.groups[0].tabs[0]._groupName).toBeUndefined();
    // el original no se toca
    expect(/** @type {any} */ (dirty)._score).toBe(42);
  });

  it('es clon profundo (mutar el clon no afecta al original)', () => {
    const s = makeSession({ groups: [makeGroup({ tabs: [makeTab()] })] });
    const clean = cloneCleanSession(s);
    clean.groups[0].tabs[0].title = 'mutado';
    expect(s.groups[0].tabs[0].title).not.toBe('mutado');
  });
});

describe('dedupeTabsInSession', () => {
  it('fusiona por URL conservando posición y datos más ricos', () => {
    const t1 = makeTab({ id: 'a', url: 'https://x.com/a', title: 'Viejo', savedAt: 1 });
    const t2 = makeTab({ id: 'b', url: 'https://x.com/a', title: 'Nuevo', savedAt: 9, note: 'nota' });
    const t3 = makeTab({ id: 'c', url: 'https://x.com/otra', tags: ['z'] });
    const t4 = makeTab({
      id: 'd',
      url: 'https://x.com/otra',
      favicon: 'data:image/png;base64,f',
      tags: ['w'],
    });

    const { session, removed } = dedupeTabsInSession(makeSession({ ungroupedTabs: [t1, t2, t3, t4] }));

    expect(removed).toBe(2);
    expect(session.ungroupedTabs).toHaveLength(2);
    const first = session.ungroupedTabs[0];
    expect(first.id).toBe('a'); // posición de la primera aparición
    expect(first.title).toBe('Nuevo'); // más reciente gana título
    expect(first.note).toBe('nota');
    const second = session.ungroupedTabs[1];
    expect(second.favicon).toBe('data:image/png;base64,f');
    expect((second.tags ?? []).sort()).toEqual(['w', 'z']);
    expect(session.metadata.tabCount).toBe(2); // metadata recalculada
  });

  it('deduplica también dentro de grupos', () => {
    const dup = makeTab({ url: 'https://dup.com' });
    const { session, removed } = dedupeTabsInSession(
      makeSession({ groups: [makeGroup({ tabs: [dup, { ...makeTab(), url: 'https://dup.com' }] })] })
    );
    expect(removed).toBe(1);
    expect(session.groups[0].tabs).toHaveLength(1);
  });

  it('sesión sin duplicados queda intacta (removed 0)', () => {
    const s = makeSession({ ungroupedTabs: [makeTab({ url: 'https://a.com' })] });
    const { removed } = dedupeTabsInSession(s);
    expect(removed).toBe(0);
  });
});

describe('mergeSessionsInto', () => {
  it('combina con ids regenerados en TODO el árbol y es pura', () => {
    const a = makeSession({ groups: [makeGroup({ id: 'ga', tabs: [makeTab({ id: 'ta' })] })] });
    const b = makeSession({ ungroupedTabs: [makeTab({ id: 'tb' })] });
    const merged = mergeSessionsInto([a, b], 'Combo');

    expect(merged.name).toBe('Combo');
    expect(merged.metadata.groupCount).toBe(1);
    expect(merged.metadata.tabCount).toBe(2);
    expect(merged.groups[0].id).not.toBe('ga');
    expect(merged.groups[0].tabs[0].id).not.toBe('ta');
    expect(merged.ungroupedTabs[0].id).not.toBe('tb');
    // pureza: originales intactos
    expect(a.groups[0].id).toBe('ga');
    expect(b.ungroupedTabs[0].id).toBe('tb');
  });

  it('nombre vacío usa fallback', () => {
    expect(mergeSessionsInto([], '').name).toBe('Merged Session');
  });
});

describe('findDuplicateOf', () => {
  const saved = makeSession({
    groups: [makeGroup({ tabs: [makeTab({ url: 'https://a.com' }), makeTab({ url: 'https://b.com' })] })],
    ungroupedTabs: [makeTab({ url: 'https://c.com' })],
  });

  it('detecta solapamiento ≥ umbral', () => {
    const current = new Set(['https://a.com', 'https://b.com', 'https://c.com']);
    const m = findDuplicateOf(current, { s: saved }, 0.8);
    expect(m?.session.id).toBe(saved.id);
  });

  it('por debajo del umbral devuelve null', () => {
    const current = new Set(['https://zzz.com']);
    expect(findDuplicateOf(current, { s: saved }, 0.8)).toBeNull();
  });

  it('conjunto vacío → null sin iterar', () => {
    expect(findDuplicateOf(new Set(), { s: saved })).toBeNull();
  });
});

describe('reattachFavicons', () => {
  it('re-adjunta favicons por URL exacta', () => {
    const source = makeSession({
      ungroupedTabs: [makeTab({ url: 'https://x.com', favicon: 'data:image/png;base64,F' })],
    });
    const target = makeSession({ ungroupedTabs: [makeTab({ url: 'https://x.com', favicon: '' })] });
    const out = reattachFavicons(target, source);
    expect(out.ungroupedTabs[0].favicon).toBe('data:image/png;base64,F');
  });

  it('tolera source null', () => {
    const t = makeSession({});
    expect(reattachFavicons(t, null)).toBe(t);
  });
});
