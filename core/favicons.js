// core/favicons.js — Store LRU de favicons claveado por DOMINIO (Fase 10.2).
//
// Problema que muere: cada tab guardaba su propia data-URL (hasta 32KB × tab)
// sin dedupe ni eviction → bloat masivo de storage. Ahora existe UNA entrada por
// dominio en `chrome.storage.local.favicons`; las tabs no guardan nada.
//
// Garantías:
//  1. PURO: todas las funciones son deterministas y sin I/O (el repo hace el set/get).
//  2. LRU doble tope: MAX_DOMAINS entradas Y MAX_BYTES acumulados; expulsa lo
//     menos recientemente usado primero.
//  3. Nunca lanza: entrada hostil → store vacío / '' (misma regla de oro que schema.js).

/** Topes del store (documentados en docs/security.md y ADR-0004). */
export const FAVICON_LIMITS = Object.freeze({
  /** Máximo de dominios retenidos. */
  MAX_DOMAINS: 2000,
  /** Presupuesto aproximado en bytes de data-URLs (~20 MB con unlimitedStorage). */
  MAX_BYTES: 20 * 1024 * 1024,
});

/**
 * Dominio (host lowercase) de una URL; '' si es inválida/insegura.
 * Solo http(s)/file tienen favicon con sentido; mailto etc. → ''.
 * @param {unknown} url
 * @returns {string}
 */
export function domainOf(url) {
  if (typeof url !== 'string' || url.length > 4000) return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return '';
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** @typedef {{ data: string, usedAt: number }} FaviconEntry */
/** @typedef {{ entries: Record<string, FaviconEntry>, bytes: number }} FaviconStore */

/** @returns {FaviconStore} */
export function emptyFaviconStore() {
  return { entries: {}, bytes: 0 };
}

/** Longitud ≈ bytes (data-URLs son ASCII base64). @param {unknown} s */
function approxBytes(s) {
  return typeof s === 'string' ? s.length : 0;
}

/**
 * Lee el favicon almacenado para la URL dada. @returns {string} data-URL o ''
 * @param {FaviconStore|null|undefined} store
 * @param {unknown} url
 */
export function getFaviconFor(store, url) {
  const domain = domainOf(url);
  if (!domain || !store || typeof store.entries !== 'object') return '';
  const entry = store.entries[domain];
  return entry && typeof entry.data === 'string' ? entry.data : '';
}

/**
 * Registra/actualiza UN dominio (touch LRU) y devuelve un NUEVO store ya podado.
 * Un data-URL invacío/hostil se ignora silenciosamente.
 *
 * @param {FaviconStore|undefined} store
 * @param {string} domain hostname lowercase ('' → no-op)
 * @param {string} dataUrl
 * @param {number} now epoch ms del uso
 * @param {{ maxDomains?: number, maxBytes?: number }} [limits]
 * @returns {FaviconStore}
 */
export function rememberFavicon(store, domain, dataUrl, now, limits = {}) {
  const maxDomains = limits.maxDomains ?? FAVICON_LIMITS.MAX_DOMAINS;
  const maxBytes = limits.maxBytes ?? FAVICON_LIMITS.MAX_BYTES;
  const base =
    store && typeof store.entries === 'object'
      ? /** @type {FaviconStore} */ ({ entries: { ...store.entries }, bytes: store.bytes })
      : emptyFaviconStore();
  if (!domain || typeof dataUrl !== 'string' || !dataUrl) return pruneStore(base, maxDomains, maxBytes);

  const prev = base.entries[domain];
  base.entries[domain] = { data: dataUrl.slice(0, 60_000), usedAt: Number.isFinite(now) ? now : Date.now() };
  base.bytes += approxBytes(dataUrl) - (prev ? approxBytes(prev.data) : 0);
  return pruneStore(base, maxDomains, maxBytes);
}

/**
 * Registra varios pares {domain,dataUrl} (o {url,dataUrl}) de una captura.
 * @param {FaviconStore|undefined} store
 * @param {{ domain?: string, url?: string, dataUrl?: string }[]} pairs
 * @param {number} now
 * @param {{ maxDomains?: number, maxBytes?: number }} [limits]
 * @returns {FaviconStore}
 */
export function rememberFavicons(store, pairs, now, limits = {}) {
  let out =
    store && typeof store.entries === 'object'
      ? /** @type {FaviconStore} */ ({ entries: { ...store.entries }, bytes: store.bytes })
      : emptyFaviconStore();
  if (!Array.isArray(pairs))
    return pruneStore(
      out,
      limits.maxDomains ?? FAVICON_LIMITS.MAX_DOMAINS,
      limits.maxBytes ?? FAVICON_LIMITS.MAX_BYTES
    );
  for (const p of pairs) {
    if (!p || typeof p !== 'object') continue;
    const domain = typeof p.domain === 'string' && p.domain ? p.domain.toLowerCase() : domainOf(p.url);
    if (!domain) continue;
    out = rememberFavicon(out, domain, String(p.dataUrl ?? ''), now, limits);
  }
  return out;
}

/**
 * Poda LRU: expulsa los dominios menos recientemente usados hasta quedar dentro
 * de AMBOS topes (count y bytes). Pura; O(n log n) solo cuando hay exceso.
 * @param {FaviconStore} store
 * @param {number} maxDomains
 * @param {number} maxBytes
 * @returns {FaviconStore}
 */
function pruneStore(store, maxDomains, maxBytes) {
  const domains = Object.keys(store.entries);
  if (domains.length <= maxDomains && store.bytes <= maxBytes) return store;

  domains.sort((a, b) => store.entries[a].usedAt - store.entries[b].usedAt);
  let bytes = store.bytes;
  let i = 0;
  while (i < domains.length && (domains.length - i > maxDomains || bytes > maxBytes)) {
    const d = domains[i];
    bytes -= approxBytes(store.entries[d].data);
    delete store.entries[d];
    i++;
  }
  store.bytes = Math.max(0, bytes);
  return store;
}

/**
 * Normaliza un store leído de storage (entrada hostil → vacío, nunca lanza).
 * @param {unknown} raw
 * @returns {FaviconStore}
 */
export function normalizeFaviconStore(raw) {
  if (!raw || typeof raw !== 'object') return emptyFaviconStore();
  const r = /** @type {Record<string, any>} */ (raw);
  if (!r.entries || typeof r.entries !== 'object') return emptyFaviconStore();
  /** @type {Record<string, FaviconEntry>} */
  const entries = {};
  let bytes = 0;
  for (const [domain, entry] of Object.entries(r.entries)) {
    if (!domain || typeof entry !== 'object') continue;
    const data = typeof (/** @type {any} */ (entry).data) === 'string' ? /** @type {any} */ (entry).data : '';
    if (!data) continue;
    const usedAt = Number(/** @type {any} */ (entry).usedAt);
    entries[domain] = { data, usedAt: Number.isFinite(usedAt) ? usedAt : 0 };
    bytes += approxBytes(data);
    if (Object.keys(entries).length >= FAVICON_LIMITS.MAX_DOMAINS) break;
  }
  return { entries, bytes: bytes > 0 ? bytes : typeof r.bytes === 'number' ? r.bytes : 0 };
}

// ─── Migración v3→v4: deduplicar data-URLs existentes ─────────────────────────

/**
 * Recolecta favicons data-URL por dominio desde sesiones y papelera, y VACÍA
 * el campo favicon de cada tab (mutación en sitio, como el resto de migraciones).
 * Las versiones/backups ya se persisten sin favicons: no se tocan.
 *
 * @param {{ sessions?: unknown, trash?: unknown }} data estado crudo de storage
 * @param {number} now
 * @returns {{ store: FaviconStore, deduped: number, stripped: number }}
 */
export function collectFaviconsFromVault(data, now) {
  let store = emptyFaviconStore();
  let deduped = 0;
  let stripped = 0;
  const seenInBatch = /** @type {Set<string>} */ (new Set());

  /** @param {any[]} tabs */
  const walkTabs = (tabs) => {
    for (const t of tabs) {
      if (!t || typeof t !== 'object') continue;
      const fav = t.favicon;
      if (typeof fav === 'string' && fav.startsWith('data:image/')) {
        const domain = domainOf(t.url);
        if (domain && !seenInBatch.has(domain)) {
          seenInBatch.add(domain);
          store = rememberFavicon(store, domain, fav, now);
        } else if (domain) {
          deduped++;
        }
      }
      if (t.favicon) {
        t.favicon = '';
        stripped++;
      }
    }
  };

  /** @param {any} session */
  const walkSession = (session) => {
    if (!session || typeof session !== 'object') return;
    if (Array.isArray(session.groups)) {
      for (const g of session.groups) {
        if (g && Array.isArray(g.tabs)) walkTabs(g.tabs);
      }
    }
    if (Array.isArray(session.ungroupedTabs)) walkTabs(session.ungroupedTabs);
  };

  const sessions = data?.sessions;
  if (sessions && typeof sessions === 'object') {
    for (const s of Object.values(/** @type {Record<string, any>} */ (sessions))) walkSession(s);
  }
  const trash = data?.trash;
  if (trash && typeof trash === 'object') {
    for (const s of Object.values(/** @type {Record<string, any>} */ (trash))) walkSession(s);
  }
  return { store, deduped, stripped };
}

// ─── Identicon determinista (último eslabón del fallback visual) ──────────────

/**
 * Letra + tono HSL deterministas para una URL: misma entrada → mismo color.
 * @param {unknown} url
 * @returns {{ letter: string, hue: number }}
 */
export function identiconFor(url) {
  const domain = domainOf(url);
  let hash = 5381;
  for (let i = 0; i < domain.length; i++) {
    hash = ((hash << 5) + hash + domain.charCodeAt(i)) | 0;
  }
  const first = domain.replace(/^www\./, '').charAt(0);
  const letter = /[a-z0-9]/i.test(first) ? first.toUpperCase() : '?';
  return { letter, hue: Math.abs(hash) % 360 };
}
