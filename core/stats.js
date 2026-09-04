// core/stats.js — Estadísticas on-demand del vault (Fase 9.1).
// Sin I/O, 100% puro: recibe sesiones/papelera y devuelve KPIs.
// Cálculo O(tabs) sin re-indexar; <100ms para 5k tabs (ver tests).
// La vista StatsView lo invoca bajo demanda; no hay segunda copia persistente.

/** @typedef {import('../shared/types.js').Session} Session */
/** @typedef {import('../shared/types.js').SessionMap} SessionMap */

/**
 * Extrae hostname sin www o ''.
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Totales básicos + dominios únicos.
 * @param {SessionMap} sessions
 * @returns {{ sessionCount: number, tabCount: number, domainCount: number, domains: Map<string,number> }}
 */
export function domainStats(sessions) {
  const domains = new Map();
  let tabCount = 0;
  for (const s of Object.values(sessions ?? {})) {
    const lists = [...(s.groups ?? []).flatMap((g) => g.tabs ?? []), ...(s.ungroupedTabs ?? [])];
    for (const t of lists) {
      tabCount++;
      const h = hostOf(t.url ?? '');
      if (!h) continue;
      domains.set(h, (domains.get(h) ?? 0) + 1);
    }
  }
  return { sessionCount: Object.keys(sessions ?? {}).length, tabCount, domainCount: domains.size, domains };
}

/**
 * Top N dominios ordenados por frecuencia desc (empate alfabético).
 * @param {SessionMap} sessions
 * @param {number} [limit=10]
 * @returns {{ host: string, count: number }[]}
 */
export function topDomains(sessions, limit = 10) {
  const { domains } = domainStats(sessions);
  return [...domains.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
    .slice(0, limit);
}

/**
 * Actividad últimos 30 días: array 30 long con nº de sesiones creadas por día.
 * Día 0 = hoy, día 29 = hace 29 días. Reloj inyectable para tests.
 * @param {SessionMap} sessions
 * @param {number} [now=Date.now()]
 * @returns {number[]}
 */
export function activityLast30Days(sessions, now = Date.now()) {
  const buckets = Array(30).fill(0);
  const dayMs = 86_400_000;
  // inicio de hoy a las 00:00 local
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startMs = startOfToday.getTime();
  for (const s of Object.values(sessions ?? {})) {
    const created = s.created ?? 0;
    if (!created) continue;
    const diff = startMs - created;
    // created dentro de ventana [startMs - 29d, startMs+1d)
    const dayIndex = Math.floor((startMs - created) / dayMs);
    // invierte: el array va de más antiguo (0) a más reciente (29) para sparkline izquierda→derecha
    // pero contrato: index 0 = hace 29 días, 29 = hoy
    if (dayIndex >= 0 && dayIndex < 30) {
      buckets[29 - dayIndex]++;
    } else if (created >= startMs && created < startMs + dayMs) {
      buckets[29]++;
    }
  }
  return buckets;
}

/**
 * Tabs más repetidas por URL (conteo exacto). Orden por frecuencia.
 * @param {SessionMap} sessions
 * @param {number} [limit=10]
 * @returns {{ url: string, title: string, count: number }[]}
 */
export function mostRepeatedTabs(sessions, limit = 10) {
  /** @type {Map<string,{title:string,count:number}>} */
  const byUrl = new Map();
  for (const s of Object.values(sessions ?? {})) {
    const lists = [...(s.groups ?? []).flatMap((g) => g.tabs ?? []), ...(s.ungroupedTabs ?? [])];
    for (const t of lists) {
      const entry = byUrl.get(t.url);
      if (!entry) byUrl.set(t.url, { title: t.title ?? t.url, count: 1 });
      else entry.count++;
    }
  }
  return [...byUrl.entries()]
    .map(([url, v]) => ({ url, title: v.title, count: v.count }))
    .filter((x) => x.count > 1)
    .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url))
    .slice(0, limit);
}

/**
 * Racha de uso: nº de días consecutivos con al menos una sesión creada
 * hasta hoy inclusive. 0 si hoy no tuvo actividad.
 * @param {SessionMap} sessions
 * @param {number} [now=Date.now()]
 * @returns {number}
 */
export function usageStreak(sessions, now = Date.now()) {
  const dayMs = 86_400_000;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startMs = startOfToday.getTime();
  /** @type {Set<number>} días con actividad (índice desde hoy) */
  const days = new Set();
  for (const s of Object.values(sessions ?? {})) {
    const created = s.created ?? 0;
    if (!created) continue;
    const diff = startMs - created;
    if (diff < 0) {
      // creado hoy futuro (mismo día) → cuenta como hoy
      if (created >= startMs && created < startMs + dayMs) days.add(0);
      continue;
    }
    const idx = Math.floor(diff / dayMs);
    if (idx >= 0 && idx < 365) days.add(idx);
  }
  let streak = 0;
  while (days.has(streak)) streak++;
  return streak;
}

/**
 * Estimación de tamaño de storage (bytes) vía JSON. Pura y barata.
 * @param {SessionMap} sessions
 * @returns {number}
 */
export function estimateStorageBytes(sessions) {
  try {
    return JSON.stringify(sessions).length;
  } catch {
    return 0;
  }
}

/**
 * Agregado completo para StatsView. Calculado on-demand; sin persistencia.
 * @param {SessionMap} sessions
 * @param {import('../shared/types.js').TrashMap} trash
 * @param {number} [now]
 * @returns {{ sessionCount: number, tabCount: number, domainCount: number,
 *            trashCount: number, streak: number, storageBytes: number,
 *            top: ReturnType<typeof topDomains>, activity: number[],
 *            repeated: ReturnType<typeof mostRepeatedTabs> }}
 */
export function computeStats(sessions, trash, now = Date.now()) {
  const ds = domainStats(sessions);
  return {
    sessionCount: ds.sessionCount,
    tabCount: ds.tabCount,
    domainCount: ds.domainCount,
    trashCount: Object.keys(trash ?? {}).length,
    streak: usageStreak(sessions, now),
    storageBytes: estimateStorageBytes(sessions),
    top: topDomains(sessions, 10),
    activity: activityLast30Days(sessions, now),
    repeated: mostRepeatedTabs(sessions, 10),
  };
}
