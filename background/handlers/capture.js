// background/handlers/capture.js — Capturador compartido (Fase 3).
// UN solo camino de captura para: guardado manual, auto-save periódico,
// auto-save por cierre y captura multi-ventana. Fin de la divergencia C5:
// los grupos nativos se reconstruyen desde tab.groupId en TODOS los flujos.

import { newId } from '../../core/domain.js';
import { repository as repo } from '../../core/repository.js';
import { isValidTabUrl } from '../../shared/urlRules.js';
import { applyRulesToTabs } from '../../core/autoTagRules.js';
import { domainOf } from '../../core/favicons.js';

/** @typedef {import('../../shared/types.js').Group} Group */
/** @typedef {import('../../shared/types.js').TabItem} TabItem */

/** Tab viva (chrome.tabs.Tab) o tab cruda de snapshot en storage.session. */
/** @typedef {{ id?: number, url?: string, title?: string, favIconUrl?: string, groupId?: number, pinned?: boolean, active?: boolean }} RawTab */

/**
 * Descarga el favicon con tope estricto de tamaño/tiempo (anti-bloat).
 * @param {string|undefined} url
 * @returns {Promise<string>} data-URL o ''
 */
export async function faviconToDataUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return '';
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > 32768) return '';
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const type = resp.headers.get('content-type') || 'image/png';
    return `data:${type};base64,${btoa(binary)}`;
  } catch (e) {
    console.warn('[TabVault] favicon fetch failed:', url, /** @type {any} */ (e)?.message);
    return '';
  }
}

/**
 * Construye la estructura de sesión desde tabs crudas (vivas o de snapshot).
 * Fase 10.2: las tabs ya NO incrustan data-URLs; los favicons se resuelven UNA
 * vez por dominio y se devuelven en `favicons` para que el llamador los
 * persista en el store LRU (repo.rememberFavicons).
 *
 * @param {RawTab[]} rawTabs tabs EN ORDEN DE ÍNDICE de ventana
 * @param {{ id: number, title?: string, color?: string }[]} [rawGroups]
 * @param {{ name?: string, fetchFavicons?: boolean, excludeUrls?: string[], autoTagRules?: import('../../shared/types.js').AutoTagRule[] }} [opts]
 * @returns {Promise<{ groups: Group[], ungroupedTabs: TabItem[], metadata: { groupCount: number, tabCount: number }, validCount: number, favicons: { domain: string, dataUrl: string }[] }>}
 */
export async function buildSessionFromTabs(rawTabs, rawGroups = [], opts = {}) {
  const { fetchFavicons = true, excludeUrls } = opts;
  const groupMap = buildGroupMap(rawGroups);
  const valid = filterValidTabs(rawTabs, excludeUrls);
  const faviconPairs = fetchFavicons ? await resolveFaviconsByDomain(valid) : [];

  /** @type {TabItem[]} */
  const ungroupedTabs = [];
  for (const tab of valid) {
    assignTab(toTabItem(tab), tab.groupId, groupMap, ungroupedTabs);
  }

  const groups = [...groupMap.values()].filter((g) => g.tabs.length > 0);
  // Fase 9.5: aplicar reglas de auto-tag sobre las tabs recién construidas
  if (Array.isArray(opts.autoTagRules) && opts.autoTagRules.length > 0) {
    for (const g of groups) applyRulesToTabs(g.tabs, opts.autoTagRules);
    applyRulesToTabs(ungroupedTabs, opts.autoTagRules);
  }
  return {
    groups,
    ungroupedTabs,
    metadata: {
      groupCount: groups.length,
      tabCount: groups.reduce((s, g) => s + g.tabs.length, 0) + ungroupedTabs.length,
    },
    validCount: valid.length,
    favicons: faviconPairs,
  };
}

/** @param {{ id: number, title?: string, color?: string }[]} rawGroups @returns {Map<number, Group>} */
function buildGroupMap(rawGroups) {
  /** @type {Map<number, Group>} */
  const groupMap = new Map();
  for (const g of rawGroups) {
    groupMap.set(g.id, {
      id: newId(),
      name: g.title || 'Untitled Group',
      color: /** @type {any} */ (g).color ?? 'grey',
      tags: [],
      note: '',
      tabs: [],
    });
  }
  return groupMap;
}

/**
 * Filtra URLs válidas. excludeUrls (captura selectiva, Fase 6.1) descarta por
 * URL EXACTA.
 * @param {RawTab[]} rawTabs
 * @param {string[]} [excludeUrls]
 * @returns {RawTab[]}
 */
function filterValidTabs(rawTabs, excludeUrls) {
  const excluded = excludeUrls?.length ? new Set(excludeUrls) : null;
  return rawTabs.filter((tab) => isValidTabUrl(tab.url) && !(excluded && tab.url && excluded.has(tab.url)));
}

/**
 * Fase 10.2: resuelve el favicon UNA vez por DOMINIO (no por tab). La primera
 * favIconUrl vista para cada dominio se descarga; el resto de tabs del mismo
 * dominio la reutiliza sin fetch ni duplicado en storage.
 * @param {RawTab[]} valid
 * @returns {Promise<{ domain: string, dataUrl: string }[]>}
 */
async function resolveFaviconsByDomain(valid) {
  /** @type {Map<string, string>} primer favIconUrl por dominio */
  const candidates = new Map();
  for (const tab of valid) {
    const domain = domainOf(tab.url);
    if (!domain || candidates.has(domain)) continue;
    if (tab.favIconUrl && !tab.favIconUrl.startsWith('data:')) candidates.set(domain, tab.favIconUrl);
  }
  /** @type {{ domain: string, dataUrl: string }[]} */
  const pairs = [];
  await Promise.all(
    [...candidates.entries()].map(async ([domain, iconUrl]) => {
      const dataUrl = await faviconToDataUrl(iconUrl);
      if (dataUrl) pairs.push({ domain, dataUrl });
    })
  );
  return pairs;
}

/** @param {RawTab} tab @returns {TabItem} */
function toTabItem(tab) {
  return {
    id: newId(),
    url: /** @type {string} */ (tab.url),
    title: tab.title || /** @type {string} */ (tab.url),
    favicon: '',
    note: '',
    tags: [],
    savedAt: Date.now(),
    ...(tab.pinned ? { pinned: true } : {}),
    ...(tab.active ? { active: true } : {}),
  };
}

/** @param {TabItem} t @param {number|undefined} nativeGroupId @param {Map<number, Group>} groupMap @param {TabItem[]} ungroupedTabs */
function assignTab(t, nativeGroupId, groupMap, ungroupedTabs) {
  const dest = typeof nativeGroupId === 'number' && nativeGroupId > 0 ? groupMap.get(nativeGroupId) : null;
  if (dest) dest.tabs.push(t);
  else ungroupedTabs.push(t);
}

/**
 * Persiste los favicons resueltos en el store LRU (best-effort: un fallo de
 * escritura nunca rompe la captura).
 * @param {{ favicons?: { domain: string, dataUrl: string }[] }} built
 */
async function persistFavicons(built) {
  if (Array.isArray(built?.favicons) && built.favicons.length > 0) {
    try {
      await repo.rememberFavicons(built.favicons);
    } catch {
      /* el store LRU es prescindible por diseño */
    }
  }
}

/**
 * Captura una ventana viva preservando sus grupos.
 * Lanza si la ventana no existe; captureAllWindows filtra por ventana viva.
 * @param {number} winId
 * @param {{ fetchFavicons?: boolean, excludeUrls?: string[], autoTagRules?: import('../../shared/types.js').AutoTagRule[] }} [opts]
 * @returns {Promise<{ groups: Group[], ungroupedTabs: TabItem[], metadata: { groupCount: number, tabCount: number }, incognito: boolean, windowId: number }>}
 */
export async function captureWindow(winId, opts = {}) {
  const [win, tabs, groups] = await Promise.all([
    chrome.windows.get(winId),
    chrome.tabs.query({ windowId: winId }),
    safeQueryGroups(winId),
  ]);
  // Fase 9.5: si no vienen reglas, cargar las guardadas (auto-tag).
  let rules = opts.autoTagRules;
  if (!rules) {
    try {
      rules = await repo.getAutoTagRules();
    } catch {
      rules = [];
    }
  }
  const built = await buildSessionFromTabs(/** @type {RawTab[]} */ (tabs), groups, {
    ...opts,
    autoTagRules: rules,
  });
  await persistFavicons(built);
  return { ...built, incognito: !!win.incognito, windowId: winId };
}

/**
 * Captura TODAS las ventanas normales (M13). Incógnito según setting.
 * @param {{ includeIncognito?: boolean, fetchFavicons?: boolean, excludeUrls?: string[] }} [opts]
 */
export async function captureAllWindows(opts = {}) {
  const { includeIncognito = false } = opts;
  const wins = await chrome.windows.getAll({ populate: true });
  /** @type {Awaited<ReturnType<typeof captureWindow>>[]} */
  const out = [];
  for (const win of wins) {
    if (win.id == null) continue;
    if (win.incognito && !includeIncognito) continue;
    try {
      const captured = await captureWindow(win.id, opts);
      if (captured.metadata.tabCount > 0) out.push(captured);
    } catch {
      /* la ventana se cerró durante la captura */
    }
  }
  return out;
}

/**
 * Guarda UN grupo vivo de una ventana como sesión individual (Fase 7.6).
 * Reusa buildSessionFromTabs con el grupo nativo como único rawGroup → la
 * estructura resultante tiene exactamente ese grupo (+ ungrouped vacío).
 * @param {number} winId
 * @param {number} nativeGroupId
 * @param {{ name?: string, fetchFavicons?: boolean }} [opts]
 */
export async function saveGroupAsSession(winId, nativeGroupId, opts = {}) {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({ windowId: winId }), safeQueryGroups(winId)]);
  const native = groups.find((g) => g.id === nativeGroupId);
  if (!native) throw new Error('Group not found in this window');

  const groupTabs = tabs.filter((t) => t.groupId === nativeGroupId);
  const built = await buildSessionFromTabs(/** @type {RawTab[]} */ (groupTabs), [native], opts);
  if (built.metadata.tabCount === 0) throw new Error('No valid tabs in this group');
  await persistFavicons(built);

  const now = Date.now();
  return repo.saveSession({
    id: newId(),
    name: opts.name || `${native.title || 'Untitled Group'} — ${new Date(now).toLocaleDateString()}`,
    created: now,
    updated: now,
    groups: built.groups,
    ungroupedTabs: built.ungroupedTabs,
    metadata: built.metadata,
  });
}

/** tabGroups puede no existir en contextos de test antiguos. @param {number} winId @returns {Promise<any[]>} */
async function safeQueryGroups(winId) {
  try {
    return await chrome.tabGroups.query({ windowId: winId });
  } catch {
    return [];
  }
}
