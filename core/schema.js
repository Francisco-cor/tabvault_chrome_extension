// core/schema.js — Validadores y normalizadores puros del dominio TabVault.
// Sin dependencias. Toda lectura de storage pasa por normalizar; toda escritura, por validar.
// Regla de oro: normalizar NUNCA lanza — repara lo reparable y descarta lo irrecuperable.

import { newId } from './domain.js';

/** @typedef {import('../shared/types.js').Session} Session */
/** @typedef {import('../shared/types.js').Group} Group */
/** @typedef {import('../shared/types.js').TabItem} TabItem */
/** @typedef {import('../shared/types.js').Settings} Settings */

// ─── Límites anti-bloat ───────────────────────────────────────────────────────

export const LIMITS = Object.freeze({
  NAME: 200,
  TITLE: 500,
  NOTE: 4000,
  TAG: 40,
  TAGS_PER_ENTITY: 24,
  FAVICON_CHARS: 60_000,
  URL: 4000,
  DOMAIN: 120,
  EXCLUDED_DOMAINS: 64,
  // Fase 8: límites globales del importador (DoS / bloat).
  IMPORT_CHARS: 20_000_000,
  IMPORT_SESSIONS: 5_000,
});

// ─── URL sanitization (mitiga C8 a nivel de datos) ───────────────────────────

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'file:']);

/**
 * Devuelve la URL normalizada SOLO si el protocolo es seguro; si no, ''.
 * Bloquea javascript:, data:, chrome:, etc. como href/src almacenados.
 * @param {unknown} raw
 * @returns {string}
 */
export function safeUrl(raw) {
  if (typeof raw !== 'string' || raw.length > LIMITS.URL) return '';
  try {
    const u = new URL(raw);
    return SAFE_PROTOCOLS.has(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

/** El favicon solo puede ser data:image/* o http(s); todo lo demás → ''.
 * @param {unknown} raw
 * @returns {string}
 */
export function safeFavicon(raw) {
  if (typeof raw !== 'string') return '';
  if (raw.length > LIMITS.FAVICON_CHARS) return '';
  if (/^data:image\/(png|jpe?g|webp|gif|x-icon|vnd\.microsoft\.icon)/i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? raw : '';
  } catch {
    return '';
  }
}

// ─── Helpers de coerción ─────────────────────────────────────────────────────

/**
 * @param {unknown} v
 * @param {number} [max=Infinity]
 * @returns {string}
 */
function str(v, max = Infinity) {
  const s = typeof v === 'string' ? v : '';
  return s.slice(0, max);
}

/**
 * @param {unknown} v
 * @param {number} [fallback=0]
 * @returns {number}
 */
function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** @param {unknown} v @returns {boolean} */
function bool(v) {
  return v === true;
}

/** @type {(arr: unknown[], fn: (x: unknown) => string|null, cap: number) => string[]} */
const mapCapped = (arr, fn, cap) => {
  if (!Array.isArray(arr)) return [];
  /** @type {string[]} */
  const out = [];
  for (const item of arr) {
    const v = fn(item);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= cap) break;
  }
  return out;
};

/** @param {unknown} t @returns {string|null} */
const cleanTag = (t) => {
  const s = str(t, LIMITS.TAG).trim();
  return s || null;
};

// ─── Normalizadores de entidad ────────────────────────────────────────────────

/**
 * Repara una tab. Devuelve null si la URL es inválida/insegura (irrecuperable).
 * @param {unknown} raw
 * @returns {TabItem|null}
 */
export function normalizeTab(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = /** @type {Record<string, unknown>} */ (raw);
  const url = safeUrl(t.url);
  if (!url) return null;
  /** @type {TabItem} */
  const tab = {
    id: str(t.id, 64) || newId(),
    url,
    title: str(t.title, LIMITS.TITLE) || url,
    favicon: safeFavicon(t.favicon),
    note: str(t.note, LIMITS.NOTE),
    tags: mapCapped(/** @type {unknown[]} */ (t.tags ?? []), cleanTag, LIMITS.TAGS_PER_ENTITY),
    savedAt: num(t.savedAt, Date.now()),
  };
  // Fase 3: estado de ventana capturable (solo se persisten cuando son true)
  if (bool(t.pinned)) tab.pinned = true;
  if (bool(t.active)) tab.active = true;
  return tab;
}

/**
 * Repara un grupo. Los tabs inseguros se descartan individualmente.
 * @param {unknown} raw
 * @returns {Group|null}
 */
export function normalizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const g = /** @type {Record<string, unknown>} */ (raw);
  /** @type {TabItem[]} */
  const tabs = [];
  if (Array.isArray(g.tabs)) {
    for (const t of g.tabs) {
      const norm = normalizeTab(t);
      if (norm) tabs.push(norm);
    }
  }
  return {
    id: str(g.id, 64) || newId(),
    name: str(g.name, LIMITS.NAME).trim() || 'Untitled Group',
    color: VALID_GROUP_COLORS.has(/** @type {string} */ (g.color))
      ? /** @type {Group['color']} */ (g.color)
      : 'purple',
    tags: mapCapped(/** @type {unknown[]} */ (g.tags ?? []), cleanTag, LIMITS.TAGS_PER_ENTITY),
    note: str(g.note, LIMITS.NOTE),
    tabs,
  };
}

export const VALID_GROUP_COLORS = new Set([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

/**
 * Repara una sesión completa; metadata SIEMPRE se recalcula (nunca se confía).
 * Devuelve null solo si `raw` no es un objeto.
 * @param {unknown} raw
 * @returns {Session|null}
 */
export function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = /** @type {Record<string, unknown>} */ (raw);

  // Snapshot de versión o sesión con ids colisionantes pueden venir sin id propio
  const id = str(s.id, 64) || newId();

  /** @type {Group[]} */
  const groups = [];
  if (Array.isArray(s.groups)) {
    for (const g of s.groups) {
      const norm = normalizeGroup(g);
      if (norm) groups.push(norm);
    }
  }

  /** @type {TabItem[]} */
  const ungroupedTabs = [];
  if (Array.isArray(s.ungroupedTabs)) {
    for (const t of s.ungroupedTabs) {
      const norm = normalizeTab(t);
      if (norm) ungroupedTabs.push(norm);
    }
  }

  const created = num(s.created, Date.now());
  return {
    id,
    name: str(s.name, LIMITS.NAME).trim() || 'Untitled Session',
    created,
    updated: Math.max(num(s.updated, created), created),
    groups,
    ungroupedTabs,
    tags: mapCapped(/** @type {unknown[]} */ (s.tags ?? []), cleanTag, LIMITS.TAGS_PER_ENTITY),
    metadata: computeMetadataOf(groups, ungroupedTabs),
    ...(bool(s.autoSaved) ? { autoSaved: true } : {}),
    ...(bool(s.pinned) ? { pinned: true } : {}),
    ...(bool(s.isTemplate) ? { isTemplate: true } : {}),
    ...(bool(s.stash) ? { stash: true } : {}),
    ...(num(s.lastOpened, 0) > 0 ? { lastOpened: num(s.lastOpened, 0) } : {}),
    ...(num(s.order, 0) > 0 ? { order: Math.floor(num(s.order, 0)) } : {}),
    ...(num(s.openCount, 0) > 0 ? { openCount: Math.floor(num(s.openCount, 0)) } : {}),
  };
}

/** @param {Group[]} groups @param {TabItem[]} ungrouped */
function computeMetadataOf(groups, ungrouped) {
  return {
    groupCount: groups.length,
    tabCount: groups.reduce((n, g) => n + g.tabs.length, 0) + ungrouped.length,
  };
}

// ─── Settings ────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = Object.freeze({
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
  // Fase 8: recordatorio de export manual (banner dismissible).
  lastManualExport: 0,
  reminderDismissedAt: 0,
  // Fase 9: productividad avanzada
  newTabEnabled: false,
  historyEnabled: false,
  suspendHours: 4,
  focusWhitelist: [],
});

const SORT_MODES = new Set(['newest', 'oldest', 'az', 'za', 'tabs', 'manual']);
const AUTOSAVE_STEPS = new Set([0, 5, 15, 30, 60]);
const THEMES = new Set(['dark', 'light', 'system']);
const ACCENTS = new Set(['blue', 'purple', 'green', 'orange']);

/**
 * @param {unknown} raw
 * @returns {Settings}
 */
export function normalizeSettings(raw) {
  const s = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' ? raw : {});
  const theme = THEMES.has(/** @type {string} */ (s.theme))
    ? /** @type {Settings['theme']} */ (s.theme)
    : DEFAULT_SETTINGS.theme;
  // Legacy: theme 'light'/'dark' se respetan; el nuevo valor 'system' también pasa.
  const legacyLight = s.theme === 'light' ? 'light' : null;
  const accent = ACCENTS.has(/** @type {string} */ (s.accent))
    ? /** @type {Settings['accent']} */ (s.accent)
    : DEFAULT_SETTINGS.accent;
  const sortBy = SORT_MODES.has(/** @type {string} */ (s.sortBy))
    ? /** @type {Settings['sortBy']} */ (s.sortBy)
    : DEFAULT_SETTINGS.sortBy;
  const minutes = num(s.autoSaveMinutes, 0);
  const autoSaveMinutes = /** @type {Settings['autoSaveMinutes']} */ (
    AUTOSAVE_STEPS.has(minutes) ? minutes : 0
  );
  const purge = num(s.trashPurgeDays, DEFAULT_SETTINGS.trashPurgeDays);
  const minTabs = Math.floor(num(s.minAutoSaveTabs, DEFAULT_SETTINGS.minAutoSaveTabs));
  const dupThreshold = Math.floor(num(s.dupThreshold, DEFAULT_SETTINGS.dupThreshold));
  const suspendH = Math.floor(num(s.suspendHours, DEFAULT_SETTINGS.suspendHours));
  return {
    theme: legacyLight ?? theme,
    accent,
    sortBy,
    autoSaveMinutes,
    autoSaveOnClose: s.autoSaveOnClose === undefined ? true : bool(s.autoSaveOnClose),
    includeIncognito: bool(s.includeIncognito),
    minAutoSaveTabs: minTabs >= 1 && minTabs <= 50 ? minTabs : DEFAULT_SETTINGS.minAutoSaveTabs,
    syncEnabled: bool(s.syncEnabled),
    trashPurgeDays: purge >= 1 && purge <= 365 ? Math.floor(purge) : DEFAULT_SETTINGS.trashPurgeDays,
    dedupeOnRestore: bool(s.dedupeOnRestore),
    dedupeOnSave: s.dedupeOnSave === undefined ? true : bool(s.dedupeOnSave),
    excludedDomains: cleanDomains(s.excludedDomains),
    dupThreshold: dupThreshold >= 50 && dupThreshold <= 95 ? dupThreshold : DEFAULT_SETTINGS.dupThreshold,
    onboardingDone: bool(s.onboardingDone),
    workspace: str(s.workspace, 40).replace(WORKSPACE_TAG_RE, '').trim(),
    lastManualExport: Math.max(0, Math.floor(num(s.lastManualExport, 0))),
    reminderDismissedAt: Math.max(0, Math.floor(num(s.reminderDismissedAt, 0))),
    newTabEnabled: bool(s.newTabEnabled),
    historyEnabled: bool(s.historyEnabled),
    suspendHours: suspendH >= 1 && suspendH <= 72 ? suspendH : DEFAULT_SETTINGS.suspendHours,
    focusWhitelist: cleanDomains(s.focusWhitelist),
  };
}

/** Prefijo de workspace que no debe almacenarse como valor del setting. */
const WORKSPACE_TAG_RE = /^@workspace:/i;

/**
 * Hostnames saneados para exclusiones del modal de guardado: lowercase, sin
 * protocolo/path, cap estricto. Un valor inválido se descarta en silencio.
 * @param {unknown} raw
 * @returns {string[]}
 */
function cleanDomains(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    const d = str(item, LIMITS.DOMAIN)
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/\/.*$/, '');
    if (d && !d.includes(' ') && !d.includes(':') && !out.includes(d)) out.push(d);
    if (out.length >= LIMITS.EXCLUDED_DOMAINS) break;
  }
  return out;
}

// ─── Fase 9: rutinas y reglas (puras, reutilizan LIMITS) ─────────────────────

/**
 * Valida "HH:MM" 24h.
 * @param {unknown} v
 * @returns {boolean}
 */
function isValidTime(v) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(v);
}

/**
 * Normaliza array de rutinas. Cap 50, ids únicos, sessionId+time obligatorios.
 * @param {unknown} raw
 * @returns {Array<{ id: string, sessionId: string, time: string, enabled: boolean, created: number }>}
 */
export function normalizeRoutines(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<{ id: string, sessionId: string, time: string, enabled: boolean, created: number }>} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = /** @type {Record<string, unknown>} */ (item);
    const id = typeof r.id === 'string' ? r.id : '';
    const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
    const time = typeof r.time === 'string' ? r.time : '';
    if (!id || !sessionId || !isValidTime(time)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id: id.slice(0, 64),
      sessionId: sessionId.slice(0, 64),
      time,
      enabled: r.enabled !== false,
      created: typeof r.created === 'number' && Number.isFinite(r.created) ? r.created : Date.now(),
    });
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Normaliza array de reglas de auto-tag. Reusa límites de TAG/DOMAIN.
 * @param {unknown} raw
 * @returns {Array<{ id: string, pattern: string, tag: string }>}
 */
export function normalizeAutoTagRules(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<{ id: string, pattern: string, tag: string }>} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = /** @type {Record<string, unknown>} */ (item);
    const id = typeof r.id === 'string' ? r.id : '';
    const pattern = String(r.pattern ?? '')
      .trim()
      .toLowerCase()
      .slice(0, 120);
    const tag = String(r.tag ?? '')
      .trim()
      .slice(0, LIMITS.TAG);
    if (!id || !pattern || !tag) continue;
    const key = `${pattern}|${tag.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: id.slice(0, 64), pattern, tag });
    if (out.length >= 50) break;
  }
  return out;
}

// ─── Import validation (mitigación dura de C7 — refuerzo completo en Fase 8) ──

/** Claves que nunca deben aceptarse como id de entidad (prototype pollution). */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** @param {string} key */
function isDangerousKey(key) {
  return DANGEROUS_KEYS.has(key);
}

/** @param {unknown} raw cuenta tabs crudos en grupos+ungrouped, defensivamente */
function countRawTabs(raw) {
  const s = /** @type {Record<string, any>} */ (raw ?? {});
  let n = Array.isArray(s.ungroupedTabs) ? s.ungroupedTabs.length : 0;
  if (Array.isArray(s.groups)) {
    for (const g of s.groups) {
      n += Array.isArray(/** @type {any} */ (g)?.tabs) ? /** @type {any[]} */ (g.tabs).length : 0;
    }
  }
  return n;
}

/**
 * Valida el payload de import. NO lanza: acumula errores por-item y descarta
 * las entidades irrecuperables. Un archivo hostil no puede contaminar storage.
 *
 * @typedef {Object} ImportReport
 * @property {boolean} ok              true si el marcador existe y hay algo válido
 * @property {string[]} errors         descripciones itemizadas de lo descartado
 * @property {{ sessions?: Record<string, Session>, trash?: Record<string, Session & {deletedAt:number}>, versions?: Record<string, unknown[]>, settings?: Settings }} value payload saneado
 *
 * @param {unknown} data JSON.parse del archivo
 * @returns {ImportReport}
 */
export function validateImportPayload(data) {
  /** @type {string[]} */
  const errors = [];
  if (!data || typeof data !== 'object' || /** @type {any} */ (data)._tabvault !== true) {
    return { ok: false, errors: ['Not a valid TabVault export file'], value: {} };
  }
  const d = /** @type {Record<string, any>} */ (data);

  /** @type {Record<string, Session>} */
  const sessions = {};
  if (d.sessions != null) {
    if (typeof d.sessions !== 'object') errors.push('sessions: formato inválido, sección omitida');
    else {
      for (const [id, raw] of Object.entries(d.sessions)) {
        if (isDangerousKey(id)) {
          errors.push(`sesión "${id}": nombre de clave reservada, omitida`);
          continue;
        }
        const norm = normalizeSession(raw);
        if (!norm || isDangerousKey(norm.id)) {
          errors.push(`sesión "${id}": inválida, omitida`);
          continue;
        }
        if (norm.id !== id) errors.push(`sesión "${id}": id reparado → "${norm.id}"`);
        const rawTabs = countRawTabs(raw);
        const dropped = rawTabs - norm.metadata.tabCount;
        if (dropped > 0) {
          errors.push(`sesión "${id}": ${dropped} tab(s) con URL insegura/inválida descartada(s)`);
        }
        sessions[norm.id] = norm;
        if (Object.keys(sessions).length >= LIMITS.IMPORT_SESSIONS) {
          errors.push(`sessions: se alcanzó el máximo de ${LIMITS.IMPORT_SESSIONS}, resto omitido`);
          break;
        }
      }
    }
  }

  /** @type {Record<string, Session & {deletedAt:number}>} */
  const trash = {};
  if (d.trash != null && typeof d.trash === 'object') {
    for (const [id, raw] of Object.entries(d.trash)) {
      if (isDangerousKey(id)) {
        errors.push(`papelera "${id}": nombre de clave reservada, omitida`);
        continue;
      }
      const norm = normalizeSession(raw);
      const deletedAt = num(/** @type {Record<string, unknown>} */ (raw)?.deletedAt, 0);
      if (!norm || !deletedAt || isDangerousKey(norm.id)) errors.push(`papelera "${id}": inválida, omitida`);
      else trash[norm.id] = { ...norm, deletedAt };
    }
  }

  /** @type {Record<string, unknown[]>} */
  const versions = {};
  if (d.versions != null && typeof d.versions === 'object') {
    for (const [sid, list] of Object.entries(d.versions)) {
      if (isDangerousKey(sid)) {
        errors.push(`versiones "${sid}": nombre de clave reservada, omitidas`);
        continue;
      }
      if (!Array.isArray(list)) {
        errors.push(`versiones "${sid}": formato inválido, omitidas`);
        continue;
      }
      /** @type {unknown[]} */
      const clean = [];
      list.forEach((entry, i) => {
        const snap = normalizeSession(/** @type {Record<string, unknown>} */ (entry)?.snapshot);
        const savedAt = num(/** @type {Record<string, unknown>} */ (entry)?.savedAt, 0);
        if (!snap || !savedAt) errors.push(`versión ${i} de "${sid}": inválida, omitida`);
        else clean.push({ snapshot: snap, savedAt });
      });
      if (clean.length) versions[sid] = clean.slice(0, 20); // cap defensivo
    }
  }

  const hasAny = Object.keys(sessions).length + Object.keys(trash).length > 0;
  if (!hasAny && !d.settings) errors.push('el archivo no contiene sesiones ni papelera');

  return {
    ok: hasAny || !!d.settings,
    errors,
    value: {
      ...(Object.keys(sessions).length ? { sessions } : {}),
      ...(Object.keys(trash).length ? { trash } : {}),
      ...(Object.keys(versions).length ? { versions } : {}),
      ...(d.settings != null ? { settings: normalizeSettings(d.settings) } : {}),
    },
  };
}
