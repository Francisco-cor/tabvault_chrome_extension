// core/domain.js — Funciones puras del dominio. Sin chrome.*, sin I/O, 100% testeables.

/** @typedef {import('../shared/types.js').Session} Session */
/** @typedef {import('../shared/types.js').Group} Group */
/** @typedef {import('../shared/types.js').TabItem} TabItem */

// ─── IDs ─────────────────────────────────────────────────────────────────────

/** Único punto de generación de ids (facilita tests deterministas). @returns {string} */
export function newId() {
  return crypto.randomUUID();
}

// ─── Metadata derivada ───────────────────────────────────────────────────────

/**
 * Recalcula metadata desde las entidades reales. Nunca confiar en la almacenada.
 * @param {Session} session
 * @returns {{ groupCount: number, tabCount: number }}
 */
export function computeMetadata(session) {
  const groups = session.groups ?? [];
  return {
    groupCount: groups.length,
    tabCount: groups.reduce((n, g) => n + (g.tabs?.length ?? 0), 0) + (session.ungroupedTabs?.length ?? 0),
  };
}

// ─── Clonado limpio ──────────────────────────────────────────────────────────

const INTERNAL_FIELDS = new Set(['_score', '_matchingTabs', '_groupName']);

/**
 * Clon profundo sin campos internos de la capa de UI/búsqueda.
 * Sustituye el hack de destructure-rest que vivía en saveVersion.
 * @param {Session} session
 * @returns {Session}
 */
export function cloneCleanSession(session) {
  const clone = structuredClone(session);
  return stripInternals(clone);
}

/** @param {any} node objeto YA clonado (muta) */
function stripInternals(node) {
  if (!node || typeof node !== 'object') return node;
  for (const k of Object.keys(node)) {
    if (INTERNAL_FIELDS.has(k)) delete node[k];
    else if (typeof node[k] === 'object') stripInternals(node[k]);
  }
  return node;
}

// ─── Deduplicación ───────────────────────────────────────────────────────────

/**
 * Fusiona tabs con misma URL dentro de una sesión.
 * Conserva la posición de la PRIMERA aparición; el título/savedAt más recientes;
 * favicon/note no vacíos tienen prioridad; tags se unen sin duplicar.
 *
 * @param {Session} session SE CLONA antes de mutar; el original no se toca.
 * @returns {{ session: Session, removed: number }}
 */
export function dedupeTabsInSession(session) {
  const clean = cloneCleanSession(session);
  let removed = 0;

  /** @param {TabItem[]} tabs @returns {TabItem[]} */
  const dedupeList = (tabs) => {
    /** @type {Map<string, TabItem>} */
    const byUrl = new Map();
    for (const tab of tabs) {
      const existing = byUrl.get(tab.url);
      if (!existing) {
        byUrl.set(tab.url, tab);
        continue;
      }
      removed++;
      // El más reciente gana título y savedAt
      if ((tab.savedAt ?? 0) >= (existing.savedAt ?? 0)) {
        existing.title = tab.title || existing.title;
        existing.savedAt = tab.savedAt ?? existing.savedAt;
      }
      // Los no-vacíos ganan en favicon/nota
      if (!existing.favicon && tab.favicon) existing.favicon = tab.favicon;
      if (!existing.note && tab.note) existing.note = tab.note;
      existing.tags = [...new Set([...(existing.tags ?? []), ...(tab.tags ?? [])])];
    }
    return [...byUrl.values()];
  };

  for (const g of clean.groups) g.tabs = dedupeList(g.tabs);
  clean.ungroupedTabs = dedupeList(clean.ungroupedTabs);
  clean.metadata = computeMetadata(clean);
  return { session: clean, removed };
}

// ─── Merge de sesiones ───────────────────────────────────────────────────────

/**
 * Combina varias sesiones en una nueva (ids de grupos/tabs regenerados).
 * Pura: no toca los originales ni storage.
 * @param {Session[]} sources
 * @param {string} name
 * @returns {Session}
 */
export function mergeSessionsInto(sources, name) {
  /** @type {Group[]} */
  const allGroups = [];
  /** @type {TabItem[]} */
  const allUngrouped = [];

  for (const s of sources) {
    for (const g of s.groups ?? []) {
      allGroups.push({
        ...structuredClone(g),
        id: newId(),
        tabs: (g.tabs ?? []).map((t) => ({ ...t, id: newId() })),
      });
    }
    for (const t of s.ungroupedTabs ?? []) {
      allUngrouped.push({ ...t, id: newId() });
    }
  }

  const now = Date.now();
  return {
    id: newId(),
    name: name || 'Merged Session',
    created: now,
    updated: now,
    groups: allGroups,
    ungroupedTabs: allUngrouped,
    metadata: {
      groupCount: allGroups.length,
      tabCount: allGroups.reduce((n, g) => n + g.tabs.length, 0) + allUngrouped.length,
    },
  };
}

// ─── Detección de duplicados (lógica extraída del popup — testable) ──────────

/**
 * URLs de una sesión como Set (grupos + ungrouped, sin vacías). Puro.
 * @param {Session} session
 * @returns {Set<string>}
 */
export function urlsOfSession(session) {
  return new Set(
    [
      ...(session.groups ?? []).flatMap((g) => (g.tabs ?? []).map((t) => t.url)),
      ...(session.ungroupedTabs ?? []).map((t) => t.url),
    ].filter(Boolean)
  );
}

/**
 * Similitud Jaccard entre dos conjuntos de URLs: |A∩B| / |A∪B| (0–1).
 * @param {Set<string>} a @param {Set<string>} b
 */
export function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const u of small) if (large.has(u)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * @typedef {Object} DupMatch
 * @property {Session} session
 * @property {number} score Jaccard 0–1
 */

/**
 * Encuentra la sesión guardada más parecida al conjunto de URLs actuales.
 * @param {Set<string>} currentUrls urls NO vacías
 * @param {Record<string, Session>} sessions
 * @param {number} [threshold=0.8]
 * @returns {DupMatch|null}
 */
export function findDuplicateOf(currentUrls, sessions, threshold = 0.8) {
  if (currentUrls.size === 0) return null;
  /** @type {DupMatch|null} */
  let best = null;
  let bestScore = 0;

  for (const session of Object.values(sessions)) {
    const sessionUrls = urlsOfSession(session);
    if (sessionUrls.size === 0) continue;
    const score = jaccardSimilarity(currentUrls, sessionUrls);
    if (score > bestScore) {
      bestScore = score;
      best = { session, score };
    }
  }
  return best && bestScore >= threshold ? best : null;
}

// ─── Auto-nombrado (Fase 6.1) ────────────────────────────────────────────────

/** Nombres bonitos para dominios frecuentes (el resto: primera etiqueta capitalizada). */
const PRETTY_HOSTS = new Map([
  ['mail.google.com', 'Gmail'],
  ['github.com', 'GitHub'],
  ['stackoverflow.com', 'Stack Overflow'],
  ['docs.google.com', 'Docs'],
  ['drive.google.com', 'Drive'],
]);

/** @param {string} url @returns {string} hostname sin www o '' si no parsea */
function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * "github.com" → "GitHub"; primera etiqueta no-genérica capitalizada como fallback.
 * @param {string} host
 */
export function prettyHost(host) {
  const special = PRETTY_HOSTS.get(host);
  if (special) return special;
  const labels = host.split('.');
  const generic = new Set(['www', 'com', 'org', 'net', 'io', 'dev', 'app', 'co']);
  const label = labels.find((l) => l && !generic.has(l)) ?? labels[0] ?? host;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Nombre sugerido por dominios predominantes — "GitHub · Gmail · Docs (2)".
 * Top-3 por frecuencia (empate → alfabético); el resto colapsa en "(N)".
 * Pura y determinista: misma entrada, mismo nombre.
 * @param {{ url?: string }[]} tabs
 * @param {number} [now] epoch ms inyectable para el fallback por fecha
 * @returns {string}
 */
export function suggestSessionName(tabs, now = Date.now()) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const t of tabs ?? []) {
    const h = hostnameOf(t?.url ?? '');
    if (!h) continue;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  if (counts.size === 0) return fallbackSessionName(now);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = sorted.slice(0, 3).map(([h]) => prettyHost(h));
  const rest = sorted.length - shown.length;
  return shown.join(' · ') + (rest > 0 ? ` (${rest})` : '');
}

/** Fallback determinista estilo el default histórico del modal. @param {number} now */
export function fallbackSessionName(now = Date.now()) {
  return new Date(now).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' session';
}

// ─── Favicons ────────────────────────────────────────────────────────────────

/**
 * Re-adjunta favicons del estado ACTUAL a una estructura restaurada (p.ej. snapshot
 * de versión que fue persistido sin favicons). Match por URL exacta.
 * @template {Session} T
 * @param {T} target estructura destino (muta su copia ya desacoplada)
 * @param {Session|null} source estado actual con favicons
 * @returns {T}
 */
export function reattachFavicons(target, source) {
  if (!source) return target;
  /** @type {Map<string, string>} */
  const favicons = new Map();
  const collect = (/** @type {TabItem|undefined} */ t) => {
    if (t?.url && t.favicon) favicons.set(t.url, t.favicon);
  };
  for (const g of source.groups ?? []) for (const t of g.tabs ?? []) collect(t);
  for (const t of source.ungroupedTabs ?? []) collect(t);
  if (favicons.size === 0) return target;

  const apply = (/** @type {TabItem|undefined} */ t) => {
    if (!t) return;
    const fav = favicons.get(t.url);
    if (fav) t.favicon = fav;
  };
  for (const g of target.groups ?? []) for (const t of g.tabs ?? []) apply(t);
  for (const t of target.ungroupedTabs ?? []) apply(t);
  return target;
}
