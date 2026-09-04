// background/handlers/autosave.js — Auto-saves resilientes (Fase 3).
//
// Fix C1: el snapshot de tabs de cada ventana vive en chrome.storage.session,
// NO en memoria del SW. Si el service worker está dormido (cold start) y llega
// windows.onRemoved, el handler lee el snapshot persistido → nunca guarda vacío.
// storage.session sobrevive al sleep del SW y se limpia sola al cerrar el navegador.
//
// Fix C5: TODOS los auto-saves usan el capturador compartido (handlers/capture.js),
// que reconstruye los grupos desde tab.groupId.

import { repository as repo } from '../../core/repository.js';
import { newId } from '../../core/domain.js';
import { buildSessionFromTabs, captureAllWindows } from './capture.js';

/** @typedef {import('../../shared/types.js').Session} Session */

const SNAPSHOT_KEY = 'windowSnapshots';
/** Debounce de re-snapshot tras eventos de tabs. */
const SNAPSHOT_DEBOUNCE_MS = 250;

/** @typedef {{ id?: number, url?: string, title?: string, favIconUrl?: string, groupId?: number, pinned?: boolean, active?: boolean }} RawTab */
/** @typedef {{ id: number, title?: string, color?: string }} RawGroup */
/** @typedef {{ incognito: boolean, tabs: RawTab[], groups: RawGroup[] }} WindowSnapshot */

/** @returns {Promise<Record<string, WindowSnapshot>>} */
async function readSnapshots() {
  try {
    const res = /** @type {Record<string, any>} */ (await chrome.storage.session.get(SNAPSHOT_KEY));
    return /** @type {Record<string, WindowSnapshot>} */ (res[SNAPSHOT_KEY] ?? {});
  } catch {
    return {};
  }
}

/** @param {Record<string, WindowSnapshot>} map */
async function writeSnapshots(map) {
  try {
    await chrome.storage.session.set({ [SNAPSHOT_KEY]: map });
  } catch (e) {
    console.warn('[TabVault] session snapshot write failed:', /** @type {any} */ (e)?.message);
  }
}

/**
 * Snapshot completo de una ventana viva hacia storage.session.
 * @param {number} winId
 */
export async function snapshotWindow(winId) {
  try {
    const [win, tabs, groups] = await Promise.all([
      chrome.windows.get(winId),
      chrome.tabs.query({ windowId: winId }),
      safeQueryGroups(winId),
    ]);
    const map = await readSnapshots();
    map[String(winId)] = {
      incognito: !!win.incognito,
      tabs: tabs.map(plainTab),
      groups: groups.map((g) => ({ id: g.id, title: g.title ?? '', color: g.color })),
    };
    await writeSnapshots(map);
  } catch {
    // La ventana ya no existe (cierre en curso): limpiar su entrada si quedó.
    const map = await readSnapshots();
    if (map[String(winId)]) {
      delete map[String(winId)];
      await writeSnapshots(map);
    }
  }
}

/**
 * Reconstruye el mapa COMPLETO desde las ventanas vivas (boot / onStartup).
 * Elimina claves huérfanas de ventanas que ya no existen.
 */
export async function snapshotAllWindows() {
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    /** @type {Record<string, WindowSnapshot>} */
    const map = {};
    for (const win of wins) {
      if (win.id == null) continue;
      /** @type {any[]} */
      const groups = [];
      try {
        groups.push(...(await chrome.tabGroups.query({ windowId: win.id })));
      } catch {
        /* sin grupos */
      }
      map[String(win.id)] = {
        incognito: !!win.incognito,
        tabs: (win.tabs ?? []).map(plainTab),
        groups: groups.map((g) => ({ id: g.id, title: g.title ?? '', color: g.color })),
      };
    }
    await writeSnapshots(map);
  } catch (e) {
    console.warn('[TabVault] snapshotAllWindows failed:', /** @type {any} */ (e)?.message);
  }
}

/** @param {chrome.tabs.Tab} t @returns {RawTab} */
function plainTab(t) {
  return {
    id: t.id ?? undefined,
    url: t.url,
    title: t.title,
    favIconUrl: t.favIconUrl,
    groupId: typeof t.groupId === 'number' ? t.groupId : undefined,
    pinned: !!t.pinned,
    active: !!t.active,
  };
}

/** Debounce por ventana para no reescribir storage en ráfagas de eventos. */
const debounceTimers = new Map();

/** @param {number} winId */
export function scheduleWindowSnapshot(winId) {
  const prev = debounceTimers.get(winId);
  if (prev) clearTimeout(prev);
  debounceTimers.set(
    winId,
    setTimeout(() => {
      debounceTimers.delete(winId);
      snapshotWindow(winId);
    }, SNAPSHOT_DEBOUNCE_MS)
  );
}

/**
 * Auto-save por cierre de ventana (fix C1). Lee el snapshot PERSISTIDO:
 * funciona aunque el SW despertara frío por este mismo evento.
 * @param {number} windowId
 * @returns {Promise<Session|null>} sesión guardada o null si no correspondía guardar
 */
export async function onWindowRemoved(windowId) {
  const snapshots = await readSnapshots();
  const snap = snapshots[String(windowId)];
  // Limpieza SIEMPRE: la ventana ya no existe.
  delete snapshots[String(windowId)];
  await writeSnapshots(snapshots);

  if (!snap || !Array.isArray(snap.tabs)) return null;

  const settings = await repo.getSettings();
  if (!settings.autoSaveOnClose) return null;
  if (snap.incognito && !settings.includeIncognito) return null;

  const built = await buildSessionFromTabs(snap.tabs, snap.groups ?? []);
  if (built.metadata.tabCount < (settings.minAutoSaveTabs ?? 2)) return null;

  const session = {
    id: newId(),
    name: `Auto: ${formatSessionDate()}`,
    created: Date.now(),
    updated: Date.now(),
    groups: built.groups,
    ungroupedTabs: built.ungroupedTabs,
    autoSaved: true,
    metadata: built.metadata,
  };
  return repo.saveSession(session);
}

/**
 * Auto-save periódico (fix C5): usa el capturador compartido → grupos intactos.
 * @returns {Promise<number>} cantidad de sesiones guardadas
 */
export async function runPeriodicAutoSave() {
  const settings = await repo.getSettings();
  const captured = await captureAllWindows({ includeIncognito: settings.includeIncognito });
  let saved = 0;
  for (const win of captured) {
    if (win.metadata.tabCount < (settings.minAutoSaveTabs ?? 2)) continue;
    await repo.saveSession({
      id: newId(),
      name: `Periodic: ${formatSessionDate()}`,
      created: Date.now(),
      updated: Date.now(),
      groups: win.groups,
      ungroupedTabs: win.ungroupedTabs,
      autoSaved: true,
      metadata: win.metadata,
    });
    saved++;
  }
  return saved;
}

/**
 * Fecha formateada determinista (los SW no garantizan locales de toLocaleString).
 * @returns {string}
 */
export function formatSessionDate() {
  const d = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${months[d.getMonth()]} ${d.getDate()}, ${h12}:${m} ${ampm}`;
}

/** tabGroups puede no estar disponible en algunos contextos. @param {number} winId @returns {Promise<any[]>} */
async function safeQueryGroups(winId) {
  try {
    return await chrome.tabGroups.query({ windowId: winId });
  } catch {
    return [];
  }
}
