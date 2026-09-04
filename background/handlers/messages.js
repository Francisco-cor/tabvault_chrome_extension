// background/handlers/messages.js — Router de mensajes (Fase 3, task 3.5).
// Respuesta uniforme {ok, data?, error?} + timeout: si un handler se cuelga,
// el popup recibe un error en vez de quedarse esperando para siempre.
// Fase 6: captura selectiva/dedupe/overwrite/multi-ventana + STASH_TAB real.

import { repository as repo, REMOTE_OPS } from '../../core/repository.js';
import { newId, computeMetadata, dedupeTabsInSession } from '../../core/domain.js';
import { safeUrl } from '../../core/schema.js';
import { MSG } from '../../shared/messages.js';
import { captureWindow, captureAllWindows, faviconToDataUrl, saveGroupAsSession } from './capture.js';
import { restoreSessionById } from './restore.js';
import { isValidTabUrl } from '../../shared/urlRules.js';
import { setStashBadge } from './lifecycle.js';
import { computeStats } from '../../core/stats.js';
import { focusSession, suspendInactiveTabs } from './focus.js';

/** Timeout por defecto para handlers (el canal de mensajes MV3 muere ~5 min; el SW vive 30s). */
const HANDLER_TIMEOUT_MS = 20_000;

/**
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @returns {Promise<T>}
 */
export async function withTimeout(p, ms = HANDLER_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Handler timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Punto de entrada único del router. NUNCA lanza: siempre Result.
 * @param {{ type?: string, [k: string]: unknown }} msg
 * @returns {Promise<{ ok: boolean, data?: unknown, error?: string }>}
 */
export async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { ok: false, error: 'Malformed message' };
  }
  try {
    return await withTimeout(
      route(/** @type {{ type: string, [k: string]: unknown }} */ (msg)),
      HANDLER_TIMEOUT_MS
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** @param {{ type: string, [k: string]: unknown }} msg @returns {Promise<any>} */
async function route(msg) {
  switch (msg.type) {
    case MSG.CAPTURE_SESSION:
      // C4 fix: la versión del duplicado SOLO se guarda aquí (tras confirmación).
      return captureAndSave(/** @type {any} */ (msg));

    case MSG.CAPTURE_ALL_WINDOWS:
      return captureAllWindowsHandler();

    case MSG.RESTORE_SESSION:
    case MSG.REPLACE_WINDOW_WITH_SESSION:
      return restoreFromMessage(msg);

    case MSG.GET_STATS:
      return getStats();

    case MSG.FOCUS_SESSION:
      return handleFocus(/** @type {any} */ (msg));

    case MSG.SUSPEND_TABS:
      return handleSuspend(/** @type {any} */ (msg));

    case MSG.SEARCH_HISTORY:
      return handleHistorySearch(/** @type {any} */ (msg));

    case MSG.STASH_TAB:
      return stashTabHandler(/** @type {any} */ (msg));

    case MSG.SAVE_GROUP_AS_SESSION:
      return saveGroupFromMessage(/** @type {any} */ (msg));

    case MSG.REFRESH_ALARM:
      // La re-programación la hace sw-main vía storage.onChanged + onAlarm wiring;
      // este mensaje se mantiene por compatibilidad con settings existentes.
      return { ok: true };

    case MSG.CONVERT_FAVICON: {
      const dataUrl = await faviconToDataUrl(/** @type {string} */ (msg.url));
      return { ok: true, data: { dataUrl } };
    }

    case MSG.REPO_OP:
      return handleRepoOp(/** @type {any} */ (msg));

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

/**
 * Opciones de la captura manual (Fase 6), saneadas desde el mensaje.
 * @typedef {{ name: string, duplicateId: string|null, overwrite: boolean,
 *             excludeUrls: string[]|undefined, allWindows: boolean }} CaptureOptions
 */

/** @param {any} msg @returns {CaptureOptions} */
function parseCaptureOptions(msg) {
  return {
    name: typeof msg.name === 'string' ? msg.name : '',
    duplicateId: typeof msg.duplicateId === 'string' ? msg.duplicateId : null,
    overwrite: msg.overwrite === true && typeof msg.duplicateId === 'string',
    excludeUrls: Array.isArray(msg.excludeUrls)
      ? /** @type {unknown[]} */ (msg.excludeUrls).filter((u) => typeof u === 'string')
      : undefined,
    allWindows: msg.allWindows === true,
  };
}

/**
 * Contenido bruto capturado (una ventana o todas fusionadas).
 * @param {CaptureOptions} options @param {{ includeIncognito: boolean }} settings
 */
async function captureContent(options, settings) {
  if (!options.allWindows) {
    const win = await chrome.windows.getLastFocused();
    if (win.id == null) throw new Error('No focused window');
    const captured = await captureWindow(win.id, { excludeUrls: options.excludeUrls });
    return { groups: captured.groups, ungroupedTabs: captured.ungroupedTabs };
  }
  const wins = await captureAllWindows({
    includeIncognito: settings.includeIncognito,
    excludeUrls: options.excludeUrls,
  });
  if (wins.length === 0) throw new Error('No windows with valid tabs');
  return {
    groups: wins.flatMap((w) => w.groups),
    ungroupedTabs: wins.flatMap((w) => w.ungroupedTabs),
  };
}

/**
 * Captura manual con las opciones de Fase 6:
 *  - excludeUrls: captura selectiva (URLs exactas desmarcadas en el modal).
 *  - allWindows: fusiona TODAS las ventanas en UNA sesión.
 *  - dedupeOnSave (setting): fusiona tabs con misma URL; el informe viaja en data.
 *  - duplicateId + overwrite: flujo de duplicados v2 — versionar y REEMPLAZAR
 *    (overwrite) o versionar y guardar nueva (save anyway). Cancelar no crea nada.
 *
 * NOTA: desde un mensaje del popup, "current window" es la ventana enfocada,
 * porque el contexto de ejecución es el SW.
 * @param {any} msg
 */
async function captureAndSave(msg) {
  try {
    const options = parseCaptureOptions(msg);
    const settings = await repo.getSettings();
    const content = await captureContent(options, settings);

    const metadata = computeMetadata(/** @type {any} */ (content));
    if (metadata.tabCount === 0) {
      return { ok: false, error: 'No valid tabs to save in this window' };
    }

    // Dedupe inteligente (Fase 6.1): setting ON por defecto.
    /** @type {any} */
    let session = {
      id: newId(),
      name: options.name || 'Untitled Session',
      created: Date.now(),
      updated: Date.now(),
      groups: content.groups,
      ungroupedTabs: content.ungroupedTabs,
      metadata,
    };
    let dedupeRemoved = 0;
    if (settings.dedupeOnSave) {
      const merged = dedupeTabsInSession(session);
      session = { ...session, ...merged.session };
      dedupeRemoved = merged.removed;
    }

    // Snapshot SIEMPRE antes de tocar la sesión similar (undo natural, C4).
    if (options.duplicateId) await repo.saveVersion(options.duplicateId);

    const saved = options.overwrite
      ? await repo.updateSession(/** @type {string} */ (options.duplicateId), {
          name: session.name,
          groups: session.groups,
          ungroupedTabs: session.ungroupedTabs,
          metadata: session.metadata,
        })
      : await repo.saveSession(session);

    return { ok: true, data: { ...saved, dedupeRemoved } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Captura todas las ventanas como sesiones individuales (M13). */
async function captureAllWindowsHandler() {
  try {
    const captured = await captureAllWindows({ includeIncognito: false });
    if (captured.length === 0) return { ok: false, error: 'No windows with valid tabs' };
    /** @type {unknown[]} */
    const savedSessions = [];
    for (const win of captured) {
      const saved = await repo.saveSession({
        id: newId(),
        name: `Windows — ${new Date().toLocaleDateString()}`,
        created: Date.now(),
        updated: Date.now(),
        groups: win.groups,
        ungroupedTabs: win.ungroupedTabs,
        metadata: win.metadata,
      });
      savedSessions.push(saved);
    }
    return { ok: true, data: savedSessions };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Guarda un grupo vivo como sesión (Fase 7.6). Valida el mensaje y normaliza
 * el nombre opcional.
 * @param {{ windowId?: unknown, groupId?: unknown, name?: unknown }} msg
 */
async function saveGroupFromMessage(msg) {
  if (typeof msg.windowId !== 'number' || typeof msg.groupId !== 'number') {
    return { ok: false, error: 'windowId and groupId are required' };
  }
  try {
    const saved = await saveGroupAsSession(
      msg.windowId,
      msg.groupId,
      typeof msg.name === 'string' && msg.name.trim() ? { name: msg.name.trim() } : {}
    );
    return { ok: true, data: saved };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Resuelve la tab a stashear: explícita por id o la activa de la última ventana.
 * @param {{ tabId?: unknown }} msg
 * @returns {Promise<any|null>}
 */
async function resolveStashTarget(msg) {
  if (typeof msg.tabId === 'number') {
    return chrome.tabs.get(msg.tabId).catch(() => null);
  }
  const win = await chrome.windows.getLastFocused().catch(() => null);
  const query =
    win?.id != null ? { windowId: win.id, active: true } : { active: true, lastFocusedWindow: true };
  const tabs = await chrome.tabs.query(query);
  return tabs[0] ?? null;
}

/** Stash existente o nuevo (con flag persistente). */
async function findOrCreateStash() {
  const sessions = await repo.getSessions();
  const existing = Object.values(sessions).find((s) => s.stash);
  if (existing) return existing;
  return repo.saveSession({
    id: newId(),
    name: 'Stash',
    created: Date.now(),
    updated: Date.now(),
    groups: [],
    ungroupedTabs: [],
    metadata: { groupCount: 0, tabCount: 0 },
    stash: true,
  });
}

/**
 * Stash rápido (Fase 6.1): guarda UNA tab en la sesión especial "Stash".
 * Idempotente por URL normalizada (re-stashear la misma URL no duplicada).
 * Optimista para el usuario: una sola escritura + badge; la UI se entera por onChanged.
 * @param {any} msg
 */
async function stashTabHandler(msg) {
  try {
    const tab = await resolveStashTarget(msg);
    if (!tab || !isValidTabUrl(tab.url ?? '')) {
      return { ok: false, error: 'This page cannot be stashed' };
    }
    // Comparar en forma NORMALIZADA: storage guarda el href de safeUrl
    // ('https://x.io' → 'https://x.io/'); sin esto, re-stashear duplicaría.
    const url = safeUrl(tab.url) || /** @type {string} */ (tab.url);

    // Fase 10.2: el favicon va al store LRU por dominio, no a la tab.
    const dataUrl = await faviconToDataUrl(tab.favIconUrl);
    if (dataUrl) {
      try {
        await repo.rememberFavicons([{ url, dataUrl }]);
      } catch {
        /* best-effort */
      }
    }
    const stash = await findOrCreateStash();

    if ((stash.ungroupedTabs ?? []).some((t) => t.url === url)) {
      // Ya estaba: sin duplicado; el badge sigue contando lo que hay.
      await setStashBadge(stash.metadata.tabCount);
      return { ok: true, data: { added: false, stashId: stash.id, stashCount: stash.metadata.tabCount } };
    }

    const updated = await repo.updateSession(stash.id, {
      ungroupedTabs: [
        ...(stash.ungroupedTabs ?? []),
        { id: newId(), url, title: tab.title || url, favicon: '', note: '', tags: [], savedAt: Date.now() },
      ],
    });
    await setStashBadge(updated.metadata.tabCount);
    return { ok: true, data: { added: true, stashId: updated.id, stashCount: updated.metadata.tabCount } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** KPIs para StatsView (Fase 9.1 on-demand). */
async function getStats() {
  const [sessions, trash, settings] = await Promise.all([
    repo.getSessions(),
    repo.getTrash(),
    repo.getSettings(),
  ]);
  const stats = computeStats(sessions, trash, Date.now());
  const used = await chrome.storage.local.getBytesInUse(null).catch(() => 0);
  return {
    ok: true,
    data: { ...stats, storageBytes: used, settings },
  };
}

/** @param {{ sessionId: string, windowId?: number, whitelist?: string[] }} msg */
async function handleFocus(msg) {
  if (!msg.sessionId || typeof msg.sessionId !== 'string') return { ok: false, error: 'sessionId required' };
  const settings = await repo.getSettings().catch(() => ({ focusWhitelist: [] }));
  const whitelist = Array.isArray(msg.whitelist) ? msg.whitelist : (settings.focusWhitelist ?? []);
  const res = await focusSession(msg.sessionId, { windowId: msg.windowId ?? null, whitelist });
  return res.ok ? { ok: true, data: res } : { ok: false, error: res.error };
}

/** @param {{ windowId?: number, hours?: number }} msg */
async function handleSuspend(msg) {
  const res = await suspendInactiveTabs({
    windowId: msg.windowId ?? null,
    hours: typeof msg.hours === 'number' ? msg.hours : undefined,
  });
  return res.ok ? { ok: true, data: res } : { ok: false, error: res.error };
}

/** @param {{ query: string, maxResults?: number }} msg */
async function handleHistorySearch(msg) {
  const q = String(msg.query ?? '').trim();
  if (!q) return { ok: true, data: [] };
  const max = Math.min(Math.max(Number(msg.maxResults) || 5, 1), 20);
  try {
    if (!chrome.history?.search) return { ok: true, data: [] };
    const results = await chrome.history.search({
      text: q,
      maxResults: max,
      startTime: Date.now() - 30 * 86_400_000,
    });
    return { ok: true, data: results };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** @param {{ type: string, sessionId?: unknown, windowId?: unknown, mode?: unknown, tabIds?: unknown }} msg */
function restoreFromMessage(msg) {
  const mode =
    msg.type === MSG.REPLACE_WINDOW_WITH_SESSION
      ? 'replace'
      : /** @type {'new'|'append'|'replace'|'incognito'|undefined} */ (msg.mode);
  return restoreSessionById(/** @type {string} */ (msg.sessionId), {
    windowId: /** @type {number|null} */ (msg.windowId ?? null),
    mode,
    tabIds: Array.isArray(msg.tabIds)
      ? /** @type {unknown[]} */ (msg.tabIds).filter((id) => typeof id === 'string')
      : undefined,
  });
}

/**
 * Despachador whitelist de operaciones de escritura (ADR-0002).
 * @param {{ op: string, args?: unknown[] }} msg
 */
async function handleRepoOp({ op, args = [] }) {
  if (!REMOTE_OPS.has(op)) {
    return { ok: false, error: `Unknown repo op: ${op}` };
  }
  try {
    // @ts-expect-error dispatch dinámico controlado por whitelist
    const data = await withTimeout(repo[op](...args));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
