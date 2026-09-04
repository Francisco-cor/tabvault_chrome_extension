// core/organization.js — Operaciones puras de organización (Fase 7).
// Tags de nivel superior con propagación global (renombrar/fusionar/borrar),
// workspaces retrocompatibles vía tag especial `@workspace:x`, orden manual
// persistente y filtros combinados serializables al hash del popup.
// Sin chrome.*, sin I/O. Las escrituras reales las hace Repository (single-writer).

/** @typedef {import('../shared/types.js').Session} Session */
/** @typedef {import('../shared/types.js').Group} Group */
/** @typedef {import('../shared/types.js').TabItem} TabItem */
/** @typedef {import('../shared/types.js').SessionMap} SessionMap */

export const WORKSPACE_PREFIX = '@workspace:';
export const GENERAL_WORKSPACE = 'General';
export const DATE_RANGES = /** @type {const} */ (['any', 'today', 'week', 'month']);

// ─── Recolección de tags ──────────────────────────────────────────────────────

/**
 * @typedef {Object} TagUsage
 * @property {string} tag        forma original más común encontrada
 * @property {number} sessions   sesiones que la llevan (en cualquier nivel)
 * @property {number} groups
 * @property {number} tabs
 */

/**
 * Inventario completo de tags del vault con conteos por nivel.
 * Case-insensitive: 'Work' y 'work' son LA MISMA tag (se reporta la primera vista).
 * Pura. Ordenada alfabéticamente.
 * @param {SessionMap} sessions
 * @returns {TagUsage[]}
 */
export function collectTags(sessions) {
  /** @type {Map<string, TagUsage>} */
  const byKey = new Map();
  /** @param {string} raw @param {'sessions'|'groups'|'tabs'} level @param {Set<string>} countedAtSession */
  const touch = (raw, level, countedAtSession) => {
    const key = raw.trim().toLowerCase();
    if (!key) return;
    let row = byKey.get(key);
    if (!row) {
      row = { tag: raw.trim(), sessions: 0, groups: 0, tabs: 0 };
      byKey.set(key, row);
    }
    row[level]++;
    // La sesión cuenta una sola vez por tag (aunque la lleven grupo y tabs).
    if (level !== 'sessions' && !countedAtSession.has(key)) {
      row.sessions++;
      countedAtSession.add(key);
    }
  };

  for (const s of Object.values(sessions ?? {})) {
    /** @type {Set<string>} */
    const seenInSession = new Set();
    for (const t of s.tags ?? []) touch(t, 'sessions', seenInSession);
    for (const g of s.groups ?? []) {
      for (const t of g.tags ?? []) touch(t, 'groups', seenInSession);
      for (const tab of g.tabs ?? []) for (const t of tab.tags ?? []) touch(t, 'tabs', seenInSession);
    }
    for (const tab of s.ungroupedTabs ?? []) {
      for (const t of tab.tags ?? []) touch(t, 'tabs', seenInSession);
    }
  }

  return [...byKey.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

// ─── Edición global de tags (rename / merge / delete) ────────────────────────

/**
 * Reescribe una lista de tags: reemplaza from→to case-insensitive sin duplicar.
 * El target ocupa la posición del primer match (no salta el orden visual).
 * @param {string[]} tags @param {string} fromL lowercase @param {string} toTrimmed
 * @returns {string[]|null} nueva lista o null si no cambió nada
 */
function rewriteTags(tags, fromL, toTrimmed) {
  const toL = toTrimmed.toLowerCase();
  const firstIdx = tags.findIndex((t) => t.trim().toLowerCase() === fromL);
  if (firstIdx === -1) return null;
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < tags.length; i++) {
    const low = tags[i].trim().toLowerCase();
    if (i === firstIdx) {
      out.push(toTrimmed); // el target hereda la posición
      continue;
    }
    if (low === fromL) continue; // segunda aparición: fusionada
    if (low === toL) continue; // el target ya estaba: no duplicar
    out.push(tags[i]);
  }
  return out;
}

/** Devuelve lista sin la tag objetivo, o null si no estaba. @param {string} targetL */
function stripTagFn(targetL) {
  /** @param {string[]} tags */
  return (tags) => {
    if (!tags.some((t) => t.trim().toLowerCase() === targetL)) return null;
    return tags.filter((t) => t.trim().toLowerCase() !== targetL);
  };
}

/**
 * @typedef {Object} TagOpResult
 * @property {SessionMap} sessions  mapa NUEVO (entidades intactas donde no aplica)
 * @property {number} entities     entidades (sesiones+grupos+tabs) modificadas
 */

/**
 * Recorre TODO el vault aplicando editFn a cada lista de tags (sesión, grupo,
 * tab). Devuelve mapa nuevo con identidad preservada donde no hubo cambios.
 * @param {SessionMap} sessions
 * @param {(tags: string[]) => string[]|null} editFn nueva lista o null = sin cambios
 * @returns {TagOpResult}
 */
function walkAllTags(sessions, editFn) {
  let entities = 0;

  /** @param {TabItem[]} tabs @returns {{ tabs: TabItem[], changed: boolean }} */
  const mapTabs = (tabs) => {
    let changed = false;
    const out = (tabs ?? []).map((t) => {
      const next = editFn(t.tags ?? []);
      if (next === null) return t;
      entities++;
      changed = true;
      return { ...t, tags: next };
    });
    return { tabs: out, changed };
  };

  /** @param {Group} g */
  const mapGroup = (g) => {
    const gt = editFn(g.tags ?? []);
    const { tabs, changed } = mapTabs(g.tabs ?? []);
    if (gt === null && !changed) return g;
    if (gt !== null) entities++;
    return { ...g, ...(gt !== null ? { tags: gt } : {}), tabs };
  };

  /** @type {SessionMap} */
  const out = {};
  for (const [id, s] of Object.entries(sessions ?? {})) {
    const stags = editFn(s.tags ?? []);
    const groupsBefore = s.groups ?? [];
    const groups = groupsBefore.map(mapGroup);
    const groupsChanged = groups.some((g, i) => g !== groupsBefore[i]);
    const { tabs: ungrouped, changed: ungChanged } = mapTabs(s.ungroupedTabs ?? []);

    if (stags !== null) entities++;
    if (stags === null && !groupsChanged && !ungChanged) {
      out[id] = s;
      continue;
    }
    out[id] = {
      ...s,
      ...(stags !== null ? { tags: stags } : {}),
      groups,
      ungroupedTabs: ungrouped,
    };
  }
  return { sessions: out, entities };
}

/**
 * Renombra (o fusiona) una tag EN TODO el vault: sesiones, grupos y tabs.
 * CRITERIO DE ACEPTACIÓN Fase 7: renombrar propaga en los tres niveles.
 * Fusionar sobre una tag ya presente NO duplica. Pura.
 * @param {SessionMap} sessions @param {string} from @param {string} to
 * @returns {TagOpResult}
 */
export function renameTagEverywhere(sessions, from, to) {
  const fromL = String(from ?? '')
    .trim()
    .toLowerCase();
  const toTrimmed = String(to ?? '').trim();
  if (!fromL || !toTrimmed || fromL === toTrimmed.toLowerCase()) {
    return { sessions, entities: 0 };
  }
  return walkAllTags(sessions, (tags) => rewriteTags(tags, fromL, toTrimmed));
}

/**
 * Borra una tag de todos los niveles. Pura.
 * @param {SessionMap} sessions @param {string} tag
 * @returns {TagOpResult}
 */
export function deleteTagEverywhere(sessions, tag) {
  const targetL = String(tag ?? '')
    .trim()
    .toLowerCase();
  if (!targetL) return { sessions, entities: 0 };
  return walkAllTags(sessions, stripTagFn(targetL));
}

// ─── Workspaces ───────────────────────────────────────────────────────────────

/** ¿Es una tag-workspace? @param {string} tag */
export const isWorkspaceTag = (tag) => String(tag).toLowerCase().startsWith(WORKSPACE_PREFIX);

/** Nombre limpio de workspace desde una tag ('' si no lo es). @param {string} tag */
export const workspaceNameOf = (tag) =>
  isWorkspaceTag(tag) ? tag.slice(WORKSPACE_PREFIX.length).trim() : '';

/**
 * Workspace de UNA sesión por prioridad: session.tags → groups → tabs.
 * '' si no tiene ninguna (pertenece a General).
 * @param {Session} s
 */
export function sessionWorkspace(s) {
  for (const t of s.tags ?? []) {
    const name = workspaceNameOf(t);
    if (name) return name;
  }
  for (const g of s.groups ?? []) {
    for (const t of g.tags ?? []) {
      const name = workspaceNameOf(t);
      if (name) return name;
    }
  }
  const flat = [...(s.ungroupedTabs ?? []), ...(s.groups ?? []).flatMap((g) => g.tabs ?? [])];
  for (const t of flat) {
    for (const tag of t.tags ?? []) {
      const name = workspaceNameOf(tag);
      if (name) return name;
    }
  }
  return '';
}

/**
 * Workspaces descubiertos con conteo de sesiones (sin General).
 * @param {SessionMap} sessions @returns {{ name: string, count: number }[]}
 */
export function workspacesOf(sessions) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const s of Object.values(sessions ?? {})) {
    const ws = sessionWorkspace(s);
    if (!ws) continue;
    counts.set(ws, (counts.get(ws) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Filtra sesiones por workspace. `'' | '*'` = todos; General = sin workspace.
 * @param {Session[]} list @param {string} workspace
 */
export function filterByWorkspace(list, workspace) {
  const ws = String(workspace ?? '').trim();
  if (!ws || ws === '*') return list;
  if (ws === GENERAL_WORKSPACE) return list.filter((s) => sessionWorkspace(s) === '');
  const target = ws.toLowerCase();
  return list.filter((s) => sessionWorkspace(s).toLowerCase() === target);
}

// ─── Orden manual ─────────────────────────────────────────────────────────────

/**
 * Mapa id → order (1-based) a partir de la lista visual completa tras un drop.
 * Puro; el repo persiste cada campo `order`.
 * @param {string[]} idsInOrder
 * @returns {Record<string, number>}
 */
export function applyManualOrder(idsInOrder) {
  /** @type {Record<string, number>} */
  const out = {};
  idsInOrder.forEach((id, i) => {
    out[id] = i + 1;
  });
  return out;
}

/**
 * Lista de ids tras mover draggedId antes/después del índice target.
 * Ajusta el hueco que deja el elemento movido (misma semántica que el D&D
 * del detalle). No-op seguro si el índice es inválido o el movimiento es nulo.
 * @param {string[]} currentIds @param {string} draggedId @param {number} targetIndex @param {boolean} before
 * @returns {string[]} lista nueva o LA MISMA referencia si no hay cambio
 */
export function moveIdInList(currentIds, draggedId, targetIndex, before) {
  const from = currentIds.indexOf(draggedId);
  if (from === -1) return currentIds;
  const without = currentIds.filter((_, i) => i !== from);
  const targetIdx = Math.max(0, Math.min(targetIndex, currentIds.length - 1));
  let insertAt = before ? targetIdx : targetIdx + 1;
  if (from < insertAt) insertAt--; // el hueco desplaza el objetivo
  insertAt = Math.max(0, Math.min(insertAt, without.length));
  if (insertAt === from) return currentIds;
  const out = [...without];
  out.splice(insertAt, 0, draggedId);
  return out;
}

// ─── Filtros combinados serializables (hash del popup) ───────────────────────

/**
 * @typedef {Object} ActiveFilters
 * @property {string} domain       hostname parcial ('' = off)
 * @property {'any'|'today'|'week'|'month'} range
 * @property {boolean} pinnedOnly
 */

/** @returns {ActiveFilters} */
export function emptyFilters() {
  return { domain: '', range: 'any', pinnedOnly: false };
}

/**
 * Serializa filtros activos para location.hash.
 * Formato: `d=github.com&r=week&p=1` (omite defaults). Determinista.
 * @param {ActiveFilters} f
 */
export function serializeFilters(f) {
  const parts = [];
  if (f.domain) parts.push(`d=${encodeURIComponent(f.domain)}`);
  if (f.range && f.range !== 'any') parts.push(`r=${f.range}`);
  if (f.pinnedOnly) parts.push('p=1');
  return parts.join('&');
}

/**
 * Parsea el hash de filtros. Tolerante a basura: valores desconocidos caen a
 * default (nunca lanza). Round-trip garantizado con serializeFilters.
 * @param {unknown} hash '' | '#r=week&…'
 * @returns {ActiveFilters}
 */
export function parseFilters(hash) {
  const out = emptyFilters();
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw) return out;
  for (const pair of raw.split('&')) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      if (key === 'd' && value) out.domain = decodeURIComponent(value).slice(0, 120);
      else if (key === 'r' && /** @type {readonly string[]} */ (DATE_RANGES).includes(value)) {
        out.range = /** @type {ActiveFilters['range']} */ (value);
      } else if (key === 'p' && value === '1') out.pinnedOnly = true;
    } catch {
      /* decode fallido → par ignorado */
    }
  }
  return out;
}

const DAY_MS = 86_400_000;

/**
 * ¿La sesión pasa el rango de fechas? Pura con reloj inyectable.
 * @param {number} updated @param {ActiveFilters['range']} range @param {number} now
 */
export function passesDateRange(updated, range, now) {
  if (range === 'any') return true;
  const age = now - updated;
  if (range === 'today') return age <= DAY_MS;
  if (range === 'week') return age <= 7 * DAY_MS;
  return age <= 30 * DAY_MS;
}

/**
 * Filtro combinado: solo-pinned + rango + dominio (cualquier hostname que
 * contenga el valor). Pura con reloj inyectable.
 * @param {Session[]} list @param {ActiveFilters} f @param {number} now
 */
export function applyCombinedFilters(list, f, now) {
  const domain = f.domain.trim().toLowerCase();
  return list.filter((s) => {
    if (f.pinnedOnly && !s.pinned) return false;
    if (!passesDateRange(s.updated, f.range, now)) return false;
    if (!domain) return true;
    return sessionHasDomain(s, domain);
  });
}

/** @param {Session} s @param {string} domain */
function sessionHasDomain(s, domain) {
  const urls = [
    ...(s.groups ?? []).flatMap((g) => (g.tabs ?? []).map((t) => t.url)),
    ...(s.ungroupedTabs ?? []).map((t) => t.url),
  ];
  return urls.some((u) => hostContains(u, domain));
}

/** @param {string|undefined} url @param {string} needle */
function hostContains(url, needle) {
  try {
    return new URL(/** @type {string} */ (url)).hostname.includes(needle);
  } catch {
    return false;
  }
}
