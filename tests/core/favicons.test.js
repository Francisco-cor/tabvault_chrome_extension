// tests/core/favicons.test.js — Store LRU por dominio + migración v3→v4 (Fase 10.2)
// Criterio clave de aceptación: reducción de storage ≥60% sobre fixture con
// data-URLs repetidas; LRU respeta AMBOS topes (count y bytes); entrada hostil
// jamás corrompe.

import { describe, it, expect } from 'vitest';
import {
  FAVICON_LIMITS,
  domainOf,
  emptyFaviconStore,
  getFaviconFor,
  rememberFavicon,
  rememberFavicons,
  normalizeFaviconStore,
  collectFaviconsFromVault,
  identiconFor,
} from '../../core/favicons.js';
import { SCHEMA_VERSION, migrateIfNeeded } from '../../core/migrations.js';

/** @param {number} n */
const ICON = (n) => `data:image/png;base64,${'A'.repeat(n)}`;

describe('domainOf', () => {
  it('extrae host lowercase de http/https/file', () => {
    expect(domainOf('https://GitHub.com/x')).toBe('github.com');
    expect(domainOf('http://WWW.Example.dev/path?q=1')).toBe('www.example.dev');
    expect(domainOf('file:///C:/page.html')).toBe('');
  });

  it('devuelve "" para inválidos, otros esquemas y no-strings', () => {
    expect(domainOf('javascript:alert(1)')).toBe('');
    expect(domainOf('chrome://extensions')).toBe('');
    expect(domainOf('mailto:a@b.c')).toBe('');
    expect(domainOf('no es una url')).toBe('');
    expect(domainOf(null)).toBe('');
    expect(domainOf(42)).toBe('');
    expect(domainOf(`https://x.com/${'a'.repeat(5000)}`)).toBe('');
  });
});

describe('rememberFavicon / getFaviconFor (LRU)', () => {
  it('inserta, lee y contabiliza bytes', () => {
    let store = emptyFaviconStore();
    store = rememberFavicon(store, 'a.com', ICON(100), 1000);
    expect(getFaviconFor(store, 'https://a.com/x')).toBe(ICON(100));
    expect(store.bytes).toBe(ICON(100).length);
    expect(Object.keys(store.entries)).toEqual(['a.com']);
  });

  it('touch actualiza usedAt sin duplicar bytes', () => {
    let store = emptyFaviconStore();
    store = rememberFavicon(store, 'a.com', ICON(50), 1000);
    store = rememberFavicon(store, 'a.com', ICON(50), 2000);
    expect(Object.keys(store.entries).length).toBe(1);
    expect(store.entries['a.com'].usedAt).toBe(2000);
    expect(store.bytes).toBe(ICON(50).length);
  });

  it('actualizar el dato recalcula la diferencia de bytes', () => {
    let store = emptyFaviconStore();
    store = rememberFavicon(store, 'a.com', ICON(100), 1);
    store = rememberFavicon(store, 'a.com', ICON(10), 2);
    expect(store.bytes).toBe(ICON(10).length);
  });

  it('entradas inválidas (dominio vacío, data vacía) son no-op', () => {
    let store = emptyFaviconStore();
    store = rememberFavicon(store, '', ICON(10), 1);
    store = rememberFavicon(store, 'a.com', '', 1);
    store = rememberFavicon(store, 'a.com', /** @type {any} */ (undefined), 1);
    expect(Object.keys(store.entries).length).toBe(0);
  });

  it('eviction por COUNT: expulsa el usado hace más tiempo', () => {
    let store = emptyFaviconStore();
    store = rememberFavicon(store, 'old.com', ICON(10), 1000);
    store = rememberFavicon(store, 'mid.com', ICON(10), 2000);
    store = rememberFavicon(store, 'new.com', ICON(10), 3000);
    store = rememberFavicon(store, 'old.com', ICON(10), 4000); // touch: mid es el más viejo
    store = rememberFavicon(store, 'extra.com', ICON(10), 5000, { maxDomains: 3 });
    expect(Object.keys(store.entries).sort()).toEqual(['extra.com', 'new.com', 'old.com']);
  });

  it('eviction por BYTES: nunca supera el presupuesto', () => {
    let store = emptyFaviconStore();
    // cada icono ~110 chars; tope 300 bytes
    for (let i = 0; i < 5; i++) {
      store = rememberFavicon(store, `d${i}.com`, ICON(100), i + 1, { maxBytes: 300 });
    }
    expect(store.bytes).toBeLessThanOrEqual(300);
    // los más recientes sobreviven
    expect(getFaviconFor(store, 'https://d4.com/')).not.toBe('');
    expect(getFaviconFor(store, 'https://d0.com/')).toBe('');
  });

  it('store hostil de storage se normaliza sin lanzar', () => {
    expect(normalizeFaviconStore(null)).toEqual({ entries: {}, bytes: 0 });
    expect(normalizeFaviconStore({ entries: 'x' })).toEqual({ entries: {}, bytes: 0 });
    const hostile = normalizeFaviconStore({
      entries: {
        'ok.com': { data: ICON(10), usedAt: 5 },
        bad: 'string',
        'nodata.com': { usedAt: 1 },
        [Symbol('x')]: null,
      },
      bytes: 'garbage',
    });
    expect(Object.keys(hostile.entries)).toEqual(['ok.com']);
  });
});

describe('rememberFavicons (lote de captura)', () => {
  it('acepta pares {domain,dataUrl} y {url,dataUrl}; ignora basura', () => {
    let store = emptyFaviconStore();
    store = rememberFavicons(
      store,
      /** @type {any} */ ([
        { domain: 'A.com', dataUrl: ICON(10) },
        { url: 'https://b.com/x', dataUrl: ICON(11) },
        { url: 'no-url', dataUrl: ICON(12) },
        null,
        { dataUrl: ICON(13) },
      ]),
      42
    );
    expect(Object.keys(store.entries).sort()).toEqual(['a.com', 'b.com']);
    expect(store.entries['a.com'].usedAt).toBe(42);
  });
});

describe('collectFaviconsFromVault (dedupe migración)', () => {
  /** @param {string} url @param {string} favicon */
  const mkTab = (url, favicon) => ({ url, favicon, title: url });
  /** @param {any[]} tabs */
  const mkSession = (tabs) => ({ groups: [{ tabs }], ungroupedTabs: [] });

  it('deduplica por dominio, vacía tabs y cuenta', () => {
    const data = {
      sessions: {
        s1: mkSession([
          mkTab('https://gh.com/a', ICON(100)),
          mkTab('https://gh.com/b', ICON(100)), // duplicado
          mkTab('https://so.com/c', ICON(100)),
        ]),
        s2: mkSession([mkTab('https://gh.com/d', ICON(100))]), // duplicado cross-sesión
      },
      trash: { t1: { ...mkSession([mkTab('https://old.com/e', ICON(100))]), deletedAt: 1 } },
    };
    const { store, deduped, stripped } = collectFaviconsFromVault(data, 7);
    expect(Object.keys(store.entries).sort()).toEqual(['gh.com', 'old.com', 'so.com']);
    expect(deduped).toBe(2);
    expect(stripped).toBe(5);
    // tabs vaciadas en sitio
    expect(data.sessions.s1.groups[0].tabs[0].favicon).toBe('');
    expect(data.trash.t1.groups[0].tabs[0].favicon).toBe('');
    // el store conserva el PRIMER data-URL visto por dominio
    expect(store.entries['gh.com'].data).toBe(ICON(100));
  });

  it('favicons no-data (URLs http) se vacían pero NO entran al store', () => {
    const data = { sessions: { s1: mkSession([mkTab('https://x.com/a', 'https://cdn.x.com/f.ico')]) } };
    const { store, stripped } = collectFaviconsFromVault(data, 1);
    expect(Object.keys(store.entries).length).toBe(0);
    expect(stripped).toBe(1);
  });

  it('entrada hostil no lanza', () => {
    expect(() => collectFaviconsFromVault({ sessions: null, trash: 5 }, 1)).not.toThrow();
    expect(() => collectFaviconsFromVault({}, 1)).not.toThrow();
  });
});

describe('REDUCCIÓN DE STORAGE ≥60% (criterio Fase 10.2)', () => {
  it('fixture 500 tabs × 10 dominios con data-URLs de 5KB → ≥60% menos', () => {
    const domains = Array.from({ length: 10 }, (_, i) => `d${i}.com`);
    const icon = ICON(5000); // ~5KB por tab (peor caso heredado)
    /** @type {any} */
    const before = { sessions: {} };
    for (let s = 0; s < 25; s++) {
      before.sessions[`s${s}`] = mkSessionFixture(
        Array.from({ length: 20 }, (_, t) => ({
          url: `https://${domains[(s * 20 + t) % 10]}/p${t}`,
          favicon: icon,
        }))
      );
    }
    const sizeBefore = JSON.stringify(before).length;

    const after = structuredClone(before);
    const { store } = collectFaviconsFromVault(after, 1);
    after.favicons = store;
    const sizeAfter = JSON.stringify(after).length;

    const reduction = 1 - sizeAfter / sizeBefore;
    expect(Object.keys(store.entries).length).toBe(10);
    expect(reduction).toBeGreaterThanOrEqual(0.6);
  });

  /** helper local para no importar fixtures @param {any[]} tabs */
  function mkSessionFixture(tabs) {
    return { groups: [{ tabs }], ungroupedTabs: [] };
  }
});

describe('identiconFor', () => {
  it('determinista y con letra del dominio (sin www)', () => {
    const a = identiconFor('https://github.com/x');
    expect(a).toEqual(identiconFor('https://github.com/y'));
    expect(a.letter).toBe('G');
    expect(identiconFor('https://www.github.com/').letter).toBe('G');
    expect(a.hue).toBeGreaterThanOrEqual(0);
    expect(a.hue).toBeLessThan(360);
  });

  it('URL inválida → "?" con hue estable', () => {
    expect(identiconFor('garbage').letter).toBe('?');
    expect(identiconFor(null)).toEqual(identiconFor(undefined));
  });

  it('dominios distintos tienden a hues distintos (sanidad)', () => {
    const hues = new Set(['a.com', 'b.com', 'c.com', 'd.com'].map((d) => identiconFor(`https://${d}`).hue));
    expect(hues.size).toBeGreaterThan(1);
  });
});

// ─── Migración v3→v4 end-to-end ─────────────────────────────────────────────â”€â”€

/** Adapter en memoria (igual que migrations.test). @param {Record<string, unknown>} [initial] */
function memoryAdapter(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    /** @param {any} keys @returns {Promise<any>} */
    async get(keys) {
      /** @type {any} */
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (store.has(k)) out[k] = structuredClone(store.get(k));
      }
      return out;
    },
    /** @param {object} obj @returns {Promise<void>} */
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
    },
  };
}

describe('migración v3→v4 (favicons por dominio)', () => {
  const icon = ICON(2000);
  const legacyV3 = {
    meta: { schemaVersion: 3 },
    sessions: {
      s1: {
        id: 's1',
        name: 'Con favicons',
        created: 1,
        updated: 1,
        groups: [
          {
            id: 'g1',
            name: 'G',
            color: 'blue',
            tabs: [
              { id: 't1', url: 'https://gh.com/a', title: 'A', favicon: icon },
              { id: 't2', url: 'https://gh.com/b', title: 'B', favicon: icon },
            ],
          },
        ],
        ungroupedTabs: [{ id: 't3', url: 'https://so.com/c', title: 'C', favicon: icon }],
      },
    },
    trash: {},
  };

  it('mueve las data-URLs al store LRU y limpia las tabs', async () => {
    const a = memoryAdapter(structuredClone(legacyV3));
    const res = await migrateIfNeeded(a, () => {});
    expect(res.migrated).toBe(true);
    expect(res.to).toBe(SCHEMA_VERSION);
    expect(a.store.get('meta')).toEqual({ schemaVersion: SCHEMA_VERSION });

    const favicons = /** @type {any} */ (a.store.get('favicons'));
    expect(Object.keys(favicons.entries).sort()).toEqual(['gh.com', 'so.com']);

    const s1 = /** @type {any} */ (a.store.get('sessions')).s1;
    expect(s1.groups[0].tabs[0].favicon).toBe('');
    expect(s1.groups[0].tabs[1].favicon).toBe('');
    expect(s1.ungroupedTabs[0].favicon).toBe('');
    // el resto del contenido sobrevive intacto
    expect(s1.groups[0].tabs[0].url).toBe('https://gh.com/a');
  });

  it('IDEMPOTENTE: segunda ejecución es no-op y NO borra el store', async () => {
    const a = memoryAdapter(structuredClone(legacyV3));
    await migrateIfNeeded(a, () => {});
    const snapshot1 = JSON.stringify([...a.store.entries()].sort());

    // simular re-ejecución forzada de v4 sobre datos ya migrados
    a.store.set('meta', { schemaVersion: 3 });
    await migrateIfNeeded(a, () => {});
    const snapshot2 = JSON.stringify([...a.store.entries()].sort());

    const favicons = /** @type {any} */ (a.store.get('favicons'));
    expect(Object.keys(favicons.entries).sort()).toEqual(['gh.com', 'so.com']);
    // Los datos reales (sesiones/trash/versions/favicons) son IDÉNTICOS; solo
    // cambian meta (re-estampada) y el nuevo backup de rollback (intencional).
    /** @param {string} s */
    /** @param {string} s */
    const stripVolatile = (s) =>
      JSON.stringify(
        /** @type {any} */ (JSON.parse(s))
          .filter((/** @type {any} */ [k]) => k !== 'meta' && !k.startsWith('backup_preMigration'))
          .sort((/** @type {any} */ x, /** @type {any} */ y) => x[0].localeCompare(y[0]))
      );
    expect(stripVolatile(snapshot2)).toBe(stripVolatile(snapshot1));
  });

  it('vault vacío → estampa v4 sin crear store con contenido', async () => {
    const a = memoryAdapter({ meta: { schemaVersion: 3 }, sessions: {} });
    await migrateIfNeeded(a, () => {});
    expect(a.store.get('meta')).toEqual({ schemaVersion: SCHEMA_VERSION });
    const favicons = /** @type {any} */ (a.store.get('favicons'));
    expect(Object.keys(favicons?.entries ?? {}).length).toBe(0);
  });
});

describe('límites documentados', () => {
  it('topes por defecto: 2000 dominios / 20MB', () => {
    expect(FAVICON_LIMITS.MAX_DOMAINS).toBe(2000);
    expect(FAVICON_LIMITS.MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});
