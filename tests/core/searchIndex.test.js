// tests/core/searchIndex.test.js — Motor de búsqueda (Fase 7.1).
// Cubre: tokenización, escalas de scoring, operadores, filtros AND, ranking
// combinado (frescura/pins/aperturas), mantenimiento incremental y presupuesto
// de rendimiento con corpus sintético (~5k tabs).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  tokenize,
  fuzzyScore,
  parseQuery,
  buildDoc,
  createSearchIndex,
  searchVault,
  resetSearchVault,
  passesFilters,
  freshnessBonus,
  usageBonus,
} from '../../core/searchIndex.js';
import { makeSession, makeGroup, makeTab } from '../fixtures/sessions.js';

const NOW = 1_700_100_000_000;
const H = 3_600_000;

/** @param {import('../../shared/types.js').Session[]} sessions */
function idxWith(...sessions) {
  const idx = createSearchIndex();
  /** @type {Record<string, import('../../shared/types.js').Session>} */
  const map = {};
  for (const s of sessions) {
    map[s.id] = s;
    idx.upsert(s.id, s);
  }
  return { idx, map };
}

beforeEach(() => resetSearchVault());

describe('tokenize', () => {
  it('lowercase, separa por no-alfanumérico y descarta vacíos', () => {
    expect(tokenize('GitHub · Pull-Requests!')).toEqual(['github', 'pull', 'requests']);
  });
  it('unicode-aware', () => {
    expect(tokenize('Árbol Niño')).toEqual(['árbol', 'niño']);
  });
});

describe('fuzzyScore (escalas mejoradas)', () => {
  it('exact > startsWith > word-start > contains', () => {
    expect(fuzzyScore('work', 'work')).toBe(100);
    expect(fuzzyScore('net', 'network')).toBe(85);
    expect(fuzzyScore('docs', 'project docs online')).toBe(72);
    expect(fuzzyScore('twork', 'networking')).toBe(60);
  });
  it('fuzzy disperso base 30; racha ≥70% sube a 42 (wzard→wizard)', () => {
    expect(fuzzyScore('wzard', 'wizard')).toBe(42); // z-a-r-d en una racha de 4/5
    expect(fuzzyScore('wzd', 'wizard')).toBe(30); // rachas de 1: disperso real
    expect(fuzzyScore('wzrd', 'wizard')).toBe(30); // 2/4 < umbral
  });
  it('sin match → 0; vacíos → 0', () => {
    expect(fuzzyScore('zzz', 'abc')).toBe(0);
    expect(fuzzyScore('', 'abc')).toBe(0);
  });
});

describe('parseQuery — operadores', () => {
  it('términos libres y frases', () => {
    const q = parseQuery('react "design system"');
    expect(q.terms).toEqual(['react']);
    expect(q.phrases).toEqual(['design system']);
  });
  it('domain:, tag:, in:name|url|notes con término inmediato', () => {
    const q = parseQuery('domain:github.com tag:work in:name sprint in:url api in:notes todo');
    expect(q.domains).toEqual(['github.com']);
    expect(q.tags).toEqual(['work']);
    expect(q.inFields.name).toEqual(['sprint']);
    expect(q.inFields.url).toEqual(['api']);
    expect(q.inFields.notes).toEqual(['todo']);
    expect(q.terms).toEqual([]);
  });
  it('in: consume SOLO el siguiente token; lo demás es libre', () => {
    const q = parseQuery('in:name react hooks');
    expect(q.inFields.name).toEqual(['react']);
    expect(q.terms).toEqual(['hooks']);
  });
  it('alias name:/url:/note:', () => {
    const q = parseQuery('name:sprint note:kpis');
    expect(q.inFields.name).toEqual(['sprint']);
    expect(q.inFields.notes).toEqual(['kpis']);
  });
});

describe('passesFilters', () => {
  const doc = buildDoc(
    'x',
    makeSession({
      id: 'x',
      name: 'Sprint board',
      tags: ['work'],
      groups: [
        makeGroup({
          name: 'Web',
          tabs: [
            makeTab({ id: 't1', url: 'https://github.com/tabvault', title: 'Repo' }),
            makeTab({ id: 't2', url: 'https://mail.google.com/x', title: 'Gmail', note: 'check inbox' }),
          ],
        }),
      ],
    })
  );

  it('domain matchea hostname exacto o subdominio', () => {
    expect(passesFilters(doc, parseQuery('domain:github.com'))).toBe(true);
    expect(passesFilters(doc, parseQuery('domain:mail.google.com'))).toBe(true);
    expect(passesFilters(doc, parseQuery('domain:gitlab.com'))).toBe(false);
  });
  it('tag case-insensitive en cualquier nivel', () => {
    expect(passesFilters(doc, parseQuery('tag:WORK'))).toBe(true);
    expect(passesFilters(doc, parseQuery('tag:nope'))).toBe(false);
  });
  it('frase exacta sobre todo el contenido concatenado', () => {
    expect(passesFilters(doc, parseQuery('"sprint board"'))).toBe(true);
    expect(passesFilters(doc, parseQuery('"board sprint"'))).toBe(false);
  });
  it('in:name / in:url / in:notes acotan el campo', () => {
    expect(passesFilters(doc, parseQuery('in:name sprint'))).toBe(true);
    expect(passesFilters(doc, parseQuery('in:name github'))).toBe(false);
    expect(passesFilters(doc, parseQuery('in:url tabvault'))).toBe(true);
    expect(passesFilters(doc, parseQuery('in:notes inbox'))).toBe(true);
  });
});

describe('búsqueda end-to-end', () => {
  const work = makeSession({ id: 'w', name: 'Work', updated: NOW - H });
  const research = makeSession({ id: 'r', name: 'Research', updated: NOW - 40 * 24 * H });

  it('sin query → todas ordenadas por updated desc (contrato heredado)', () => {
    const { idx } = idxWith(research, work);
    const res = idx.search('');
    expect(res.map((s) => s.id)).toEqual(['w', 'r']);
    expect(res[0]._score).toBeUndefined();
  });

  it('encuentra por nombre, título de tab, url, nota y tag de grupo', () => {
    const s = makeSession({
      id: 's1',
      groups: [
        makeGroup({
          name: 'Mail',
          tags: ['comms'],
          note: 'project docs',
          tabs: [makeTab({ id: 't3', title: 'Gmail', url: 'https://mail.google.com' })],
        }),
        makeGroup({
          tabs: [makeTab({ id: 't4', url: 'https://news.ycombinator.com', title: 'HN', note: 'read later' })],
        }),
      ],
    });
    const { idx } = idxWith(s);
    for (const q of ['gmail', 'arxivnope', 'read later']) {
      if (q === 'arxivnope') continue;
      expect(idx.search(q).map((r) => r.id)).toContain('s1');
    }
    // URL
    expect(idx.search('ycombinator').map((r) => r.id)).toContain('s1');
    // tag de grupo
    expect(idx.search('comms').map((r) => r.id)).toContain('s1');
  });

  it('multi-término es AND', () => {
    const a = makeSession({ id: 'a', name: 'React dashboard' });
    const b = makeSession({ id: 'b', name: 'React' });
    const { idx } = idxWith(a, b);
    expect(idx.search('react dashboard').map((r) => r.id)).toEqual(['a']);
  });

  it('fallback difuso cuando el índice no tiene el token', () => {
    const { idx } = idxWith(makeSession({ id: 'w', name: 'wizard' }));
    expect(idx.search('wzrd')[0]?._score).toBeGreaterThan(0);
  });

  it('sin resultados → []', () => {
    const { idx } = idxWith(work);
    expect(idx.search('zzzznope')).toEqual([]);
  });
});

describe('ranking combinado', () => {
  const mk = (/** @type {any} */ over) => makeSession({ id: over.id, updated: NOW - 10 * 24 * H, ...over });

  it('frescura: actualizada hoy gana a la de hace 40 días a igual texto', () => {
    const fresh = mk({ id: 'fresh', name: 'Alpha', updated: NOW - H });
    const old = mk({ id: 'old', name: 'Alpha', updated: NOW - 40 * 24 * H });
    expect(freshnessBonus(NOW - H, NOW)).toBe(8);
    expect(freshnessBonus(NOW - 5 * 24 * H, NOW)).toBe(4);
    const { idx, map } = idxWith(old, fresh);
    void map;
    const res = idx.search('alpha', { now: NOW });
    expect(res[0].id).toBe('fresh');
  });

  it('pinned suma sobre no-pinned', () => {
    const pinned = mk({ id: 'p', name: 'Beta', pinned: true });
    const plain = mk({ id: 'n', name: 'Beta' });
    const { idx } = idxWith(plain, pinned);
    expect(idx.search('beta', { now: NOW })[0].id).toBe('p');
  });

  it('openCount + lastOpened alimentan usageBonus (plantillas nunca las tienen)', () => {
    const used = mk({ id: 'u', name: 'Gamma', openCount: 4, lastOpened: NOW - H });
    const unused = mk({ id: 'g', name: 'Gamma' });
    expect(usageBonus(buildDoc('u', used), NOW)).toBeCloseTo(11, 5);
    const { idx } = idxWith(unused, used);
    expect(idx.search('gamma', { now: NOW })[0].id).toBe('u');
  });

  it('_matchingTabs plano con _groupName y ordenado por score', () => {
    const s = makeSession({
      id: 's',
      groups: [
        makeGroup({
          name: 'Docs',
          tabs: [makeTab({ id: 'd1', title: 'Spec document', url: 'https://a.dev/spec' })],
        }),
        makeGroup({
          name: 'Misc',
          tabs: [makeTab({ id: 'm1', title: 'Spec draft', url: 'https://b.dev/spec' })],
        }),
      ],
    });
    const { idx } = idxWith(s);
    const res = idx.search('spec', { now: NOW });
    const tabs = res[0]._matchingTabs;
    expect(tabs.length).toBe(2);
    expect(tabs[0]._groupName).toBeTruthy();
    expect(tabs[0].url).toContain('https://'); // shape original, no lowercase
    expect(tabs[0]._score).toBeGreaterThanOrEqual(tabs[1]._score);
  });
});

describe('mantenimiento incremental', () => {
  it('sync upserta cambiadas y elimina desaparecidas', () => {
    const idx = createSearchIndex();
    const a = makeSession({ id: 'a', name: 'Original name' });
    const b = makeSession({ id: 'b', name: 'Keeper' });
    const first = { [a.id]: a, [b.id]: b };
    idx.sync(first);
    expect(idx.size()).toBe(2);

    // a cambia de nombre (updated bump como haría updateSession)
    const renamed = makeSession({ id: 'a', name: 'Renamed unique', updated: a.updated + 5 });
    idx.sync({ [a.id]: renamed, [b.id]: b });
    expect(idx.search('originalname')).toEqual([]);
    expect(idx.search('renamed').map((r) => r.id)).toEqual(['a']);

    // b desaparece
    idx.sync({ [a.id]: renamed });
    expect(idx.size()).toBe(1);
    expect(idx.search('keeper')).toEqual([]);
  });

  it('firmas idénticas con contenido distinto NO se saltan (fixtures/imports)', () => {
    const idx = createSearchIndex();
    const v1 = makeSession({ id: 'a', ungroupedTabs: [makeTab({ id: 'x1', title: 'First content' })] });
    idx.sync({ a: v1 });
    const v2 = makeSession({ id: 'a', ungroupedTabs: [makeTab({ id: 'x2', title: 'Second content' })] });
    idx.sync({ a: v2 }); // mismo id/updated/tabCount, contenido distinto
    expect(idx.search('second').length).toBe(1);
    expect(idx.search('first')).toEqual([]);
  });

  it('searchVault singleton se auto-sincroniza entre llamadas', () => {
    const a = makeSession({ id: 'a', name: 'Solo session' });
    expect(searchVault({ [a.id]: a }, 'solo').length).toBe(1);
    expect(searchVault({}, 'solo')).toEqual([]);
  });
});

describe('presupuesto de rendimiento (criterio Fase 7)', () => {
  it('~5k tabs: búsquedas repetidas < 50ms cada una', () => {
    const idx = createSearchIndex();
    /** @type {Record<string, any>} */
    const map = {};
    let n = 0;
    for (let sIdx = 0; sIdx < 250; sIdx++) {
      const groups = [];
      for (let g = 0; g < 3; g++) {
        const tabs = [];
        for (let t = 0; t < 7; t++) {
          n++;
          tabs.push(
            makeTab({
              id: `t${n}`,
              url: `https://domain${sIdx % 37}.example.com/path${n}`,
              title: `Doc ${n} about topic${n % 97} and shared-term`,
            })
          );
        }
        groups.push(makeGroup({ id: `g${sIdx}-${g}`, name: `Group ${g}`, tabs }));
      }
      const s = makeSession({ id: `s${sIdx}`, name: `Session ${sIdx} shared-term`, groups });
      map[s.id] = s;
    }
    idx.sync(map);
    expect(idx.size()).toBe(250);

    const queries = ['shared-term', 'topic42', 'domain7', '"shared-term"', 'doc'];
    const times = [];
    for (const q of queries) {
      const t0 = performance.now();
      const res = idx.search(q);
      const dt = performance.now() - t0;
      times.push(dt);
      expect(res.length).toBeGreaterThan(0);
    }
    // Presupuesto p95 del ROADMAP (<50ms); margen holgado para CI lento.
    for (const dt of times) expect(dt).toBeLessThan(50);
  });
});
