// background/handlers/restore.js — Restauración robusta (Fase 3, fix C9).
// - Creación de tabs EN PARALELO (Promise.all) → velocidad ×N con 50+ tabs.
// - Preserva pinned y re-activa la tab que era activa al capturar.
// - Modos: 'new' (ventana nueva), 'append' (esta ventana), 'replace'
//   (reemplaza la ventana actual: queda EXACTAMENTE con las tabs de la sesión)
//   e 'incognito' (ventana nueva privada; requiere permiso del usuario).
// Fase 6: restauración PARCIAL por tabIds + tracking lastOpened (plantillas exentas).

import { repository as repo } from '../../core/repository.js';
import { VALID_COLORS } from '../../shared/utils.js';
import { isValidTabUrl } from '../../shared/urlRules.js';

/** @typedef {{ url: string, pinned: boolean, active: boolean, groupIndex: number }} PlanEntry */

/**
 * @param {string} sessionId
 * @param {{ windowId?: number|null, mode?: 'new'|'append'|'replace'|'incognito', tabIds?: string[] }} [opts]
 * @returns {Promise<{ ok: true, opened: number } | { ok: false, error: string }>}
 */
export async function restoreSessionById(sessionId, opts = {}) {
  try {
    return await restoreInto(sessionId, opts);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * @param {string} sessionId
 * @param {{ windowId?: number|null, mode?: 'new'|'append'|'replace'|'incognito', tabIds?: string[] }} [opts]
 * @returns {Promise<{ ok: true, opened: number } | { ok: false, error: string }>}
 */
async function restoreInto(sessionId, opts = {}) {
  const session = await repo.getSession(sessionId);
  if (!session) return { ok: false, error: 'Session not found' };

  const settings = await repo.getSettings();
  const mode = opts.mode ?? (opts.windowId ? 'append' : 'new');

  const onlyIds = opts.tabIds?.length ? new Set(opts.tabIds) : null;
  const { plan, groups } = collectPlan(session, onlyIds);
  if (plan.length === 0) return { ok: false, error: 'No valid tabs to restore' };

  // IMPORTANTE: identificar la ventana a reemplazar ANTES de crear la nueva
  // (getLastFocused tras windows.create devolvería la ventana recién creada).
  const target = await resolveTargetWindow(mode, opts.windowId ?? null, plan[0].url);
  const existingByUrl = await findExistingUrls(settings.dedupeOnRestore, target.consumedFirst, target.winId);

  const idByPlanIndex = await createPlannedTabs(plan, target, existingByUrl);
  const opened = idByPlanIndex.filter(Boolean).length;

  await applyPins(plan, idByPlanIndex);
  await rebuildGroups(groups, plan, idByPlanIndex, target.winId);
  await activateCapturedTab(plan, idByPlanIndex, target.winId);

  // Replace: la ventana original se cierra AL FINAL, sin pérdida. Si el
  // usuario tiene auto-save-on-close, la ventana reemplazada queda además
  // rescatada como sesión "Auto:" (undo natural).
  if (target.oldWindowToClose != null) {
    await closeWindowQuietly(target.oldWindowToClose);
  }

  // Fase 6.3: "usada" = bumped al tope del sort; las plantillas nunca se marcan.
  // Fase 7.1: openCount alimenta el ranking del buscador (frecuencia de apertura).
  if (opened > 0 && !session.isTemplate) recordOpened(sessionId, session);
  return { ok: true, opened };
}

/**
 * Marca la sesión como usada (fire-and-forget: no bloquea el resultado).
 * @param {string} sessionId @param {{ openCount?: number }} session
 */
function recordOpened(sessionId, session) {
  repo
    .updateSession(sessionId, {
      lastOpened: Date.now(),
      openCount: (session.openCount ?? 0) + 1,
    })
    .catch(() => {});
}

/**
 * Crea en paralelo las tabs del plan; devuelve ids alineados con sus índices.
 * @param {PlanEntry[]} plan
 * @param {{ winId: number, consumedFirst: boolean }} target
 * @param {Map<string, number>} existingByUrl
 * @returns {Promise<(number|null)[]>}
 */
async function createPlannedTabs(plan, target, existingByUrl) {
  const pending = plan.map((entry, i) => {
    const consumed = i === 0 && target.consumedFirst;
    if (consumed || existingByUrl.has(entry.url)) return null;
    return /** @type {Promise<number|null>} */ (
      chrome.tabs.create({ windowId: target.winId, url: entry.url }).then((t) => t.id)
    );
  });
  const settled = await Promise.all(pending.map((p) => p ?? Promise.resolve(null)));
  const ids = /** @type {(number|null)[]} */ (settled.map((id) => id ?? null));

  if (target.consumedFirst && ids[0] == null) {
    // La primera entrada fue consumida por windows.create: es la tab inicial.
    const winTabs = await chrome.tabs.query({ windowId: target.winId }).catch(() => []);
    ids[0] = winTabs[0]?.id ?? null;
  }
  return ids;
}

/** @param {number} winId */
async function closeWindowQuietly(winId) {
  try {
    await chrome.windows.remove(winId);
  } catch {
    /* ya no existe */
  }
}

/**
 * Plan plano preservando orden: ungrouped primero, luego grupos en orden.
 * `onlyIds` (restauración parcial, Fase 6.2) filtra por id de tab; los grupos
 * que quedan sin tabs incluidas desaparecen del plan.
 * @param {import('../../shared/types.js').Session} session
 * @param {Set<string>|null} [onlyIds]
 * @returns {{ plan: PlanEntry[], groups: import('../../shared/types.js').Group[] }}
 */
function collectPlan(session, onlyIds = null) {
  const wanted = (/** @type {import('../../shared/types.js').TabItem} */ t) =>
    isValidTabUrl(t.url) && !(onlyIds && !onlyIds.has(t.id));
  /** @type {PlanEntry[]} */
  const plan = [];
  for (const t of (session.ungroupedTabs ?? []).filter(wanted)) {
    plan.push({ url: t.url, pinned: !!t.pinned, active: !!t.active, groupIndex: -1 });
  }
  const groups = (session.groups ?? [])
    .map((g) => ({ ...g, restorable: (g.tabs ?? []).filter(wanted) }))
    .filter((g) => g.restorable.length > 0);
  groups.forEach((g, gi) => {
    for (const t of g.restorable) {
      plan.push({ url: t.url, pinned: !!t.pinned, active: !!t.active, groupIndex: gi });
    }
  });
  return { plan, groups };
}

/**
 * Determina la ventana destino según modo.
 * @param {'new'|'append'|'replace'|'incognito'} mode
 * @param {number|null} requestedWindowId
 * @param {string} firstUrl
 * @returns {Promise<{ winId: number, consumedFirst: boolean, oldWindowToClose: number|null }>}
 */
async function resolveTargetWindow(mode, requestedWindowId, firstUrl) {
  if (mode === 'append' && requestedWindowId) {
    return { winId: requestedWindowId, consumedFirst: false, oldWindowToClose: null };
  }
  if (mode === 'incognito') {
    // Lanza si el usuario no habilitó la extensión en incógnito → error claro.
    const newWin = await chrome.windows.create({ url: firstUrl, incognito: true });
    if (!newWin?.id) throw new Error('Could not create incognito window');
    return {
      winId: /** @type {number} */ (newWin.id),
      consumedFirst: true,
      oldWindowToClose: null,
    };
  }
  const oldWindowToClose = mode === 'replace' ? (requestedWindowId ?? (await pickCurrentWindowId())) : null;
  const newWin = await chrome.windows.create({ url: firstUrl });
  if (!newWin?.id) throw new Error('Could not create window');
  const winId = /** @type {number} */ (newWin.id);
  return { winId, consumedFirst: true, oldWindowToClose };
}

/**
 * Anti-duplicados opcional (setting): URLs ya abiertas en la ventana destino.
 * Solo aplica cuando la primera tab NO fue consumida creando la ventana.
 * @param {boolean} enabled
 * @param {boolean} consumedFirst
 * @param {number} winId
 * @returns {Promise<Map<string, number>>}
 */
async function findExistingUrls(enabled, consumedFirst, winId) {
  /** @type {Map<string, number>} */
  const map = new Map();
  if (!enabled || consumedFirst) return map;
  try {
    for (const t of await chrome.tabs.query({ windowId: winId })) {
      if (isValidTabUrl(t.url) && t.id != null) map.set(/** @type {string} */ (t.url), t.id);
    }
  } catch {
    /* ventana pudo cerrarse; seguir sin dedupe */
  }
  return map;
}

/** @param {PlanEntry[]} plan @param {(number|null)[]} ids */
async function applyPins(plan, ids) {
  await Promise.all(
    plan
      .map((entry, i) => ({ entry, id: ids[i] }))
      .filter(({ entry, id }) => entry.pinned && id != null)
      .map(({ id }) => chrome.tabs.update(/** @type {number} */ (id), { pinned: true }))
  );
}

/**
 * Agrupa post-creación (orden estable dentro de cada grupo).
 * @param {import('../../shared/types.js').Group[]} groups
 * @param {PlanEntry[]} plan
 * @param {(number|null)[]} ids
 * @param {number} winId
 */
async function rebuildGroups(groups, plan, ids, winId) {
  for (let gi = 0; gi < groups.length; gi++) {
    /** @type {number[]} */
    const tabIds = [];
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] != null && plan[i].groupIndex === gi) tabIds.push(/** @type {number} */ (ids[i]));
    }
    if (tabIds.length === 0) continue;
    const g = groups[gi];
    const nativeId = /** @type {number} */ (
      await /** @type {any} */ (
        chrome.tabs.group(/** @type {any} */ ({ tabIds, createProperties: { windowId: winId } }))
      )
    );
    await chrome.tabGroups.update(nativeId, {
      title: g.name || '',
      color: VALID_COLORS.includes(g.color) ? g.color : 'purple',
    });
  }
}

/** @param {PlanEntry[]} plan @param {(number|null)[]} ids @param {number} winId */
async function activateCapturedTab(plan, ids, winId) {
  const activeIdx = plan.findIndex((entry) => entry.active);
  const candidate = activeIdx !== -1 ? ids[activeIdx] : (ids.find(Boolean) ?? null);
  if (candidate == null) return;
  try {
    await chrome.tabs.update(candidate, { active: true });
    await chrome.windows.update(winId, { focused: true });
  } catch {
    /* la tab pudo cerrarse entre creación y activación */
  }
}

/** @returns {Promise<number|null>} */
async function pickCurrentWindowId() {
  try {
    const win = await chrome.windows.getLastFocused();
    if (win.id != null) return win.id;
  } catch {
    /* fall through */
  }
  const wins = await chrome.windows.getAll();
  return wins.find((w) => !w.incognito)?.id ?? null;
}
