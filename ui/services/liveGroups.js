// ui/services/liveGroups.js — Datos de grupos vivos + listeners en tiempo real.
// Un único set de listeners por sesión del popup: ensure()/stop() son idempotentes.
// Fase 7.6 (M13): captura TODAS las ventanas → state.liveWindows para el
// selector; liveGroups/liveUngrouped siguen siendo los de la ventana enfocada
// (contrato que consume el CTA de guardado en SessionsView).

import { A } from '../actions.js';
import { isValidTabUrl } from '../../shared/urlRules.js';

/**
 * Construye grupos+ungrouped desde tabs crudas y sus grupos nativos. Pura.
 * @param {{ id?: number|null, url?: string, title?: string, favIconUrl?: string, groupId?: number }[]} tabs
 * @param {{ id: number, title?: string, color?: string }[]} nativeGroups
 * @returns {{ groups: any[], ungrouped: any[] }}
 */
export function groupify(tabs, nativeGroups) {
  /** @type {Map<number, any>} */
  const map = new Map();
  for (const g of nativeGroups) {
    map.set(g.id, { id: g.id, name: g.title || 'Untitled', color: g.color, tabs: [] });
  }
  /** @type {any[]} */
  const ungrouped = [];
  for (const t of tabs) {
    const tab = {
      id: t.id,
      url: t.url || '',
      title: t.title || t.url || '…',
      favicon: t.favIconUrl || '',
    };
    if (typeof t.groupId === 'number' && t.groupId > 0 && map.has(t.groupId)) {
      map.get(t.groupId).tabs.push(tab);
    } else if (isValidTabUrl(t.url)) {
      ungrouped.push(tab);
    }
  }
  return { groups: [...map.values()], ungrouped };
}

/** @type {(q?: { populate?: boolean }) => Promise<any[]>} */
async function safeGetWindows(q) {
  try {
    return await chrome.windows.getAll(q);
  } catch {
    return [];
  }
}

async function safeQueryGroups() {
  try {
    return await chrome.tabGroups.query({});
  } catch {
    return [];
  }
}

/**
 * Entrada de ventana normalizada para el selector. Pura.
 * @param {any} w @param {{ id: number, title?: string, color?: string }[]} nativeGroups
 */
function windowEntry(w, nativeGroups) {
  const tabs = Array.isArray(w.tabs) ? w.tabs : [];
  const built = groupify(tabs, nativeGroups);
  return {
    id: w.id,
    incognito: !!w.incognito,
    focused: !!w.focused,
    groups: built.groups,
    ungrouped: built.ungrouped,
    tabCount: tabs.length,
  };
}

/**
 * Captura TODAS las ventanas con sus grupos vivos (Fase 7.6).
 * @returns {Promise<{ windows: any[], activeWindowId: number|null,
 *            groups: any[], ungrouped: any[] }>}
 */
export async function captureAllWindowsLive() {
  const [wins, allGroups] = await Promise.all([safeGetWindows({ populate: true }), safeQueryGroups()]);

  /** @type {any[]} */
  const windows = [];
  for (const w of wins) {
    if (w.id == null) continue;
    windows.push(
      windowEntry(
        w,
        allGroups.filter((g) => g.windowId === w.id)
      )
    );
  }

  const focusedWin = windows.find((w) => w.focused);
  const active = focusedWin ?? windows.find((w) => !w.incognito) ?? /** @type {any} */ (windows[0] ?? null);
  return {
    windows,
    activeWindowId: active?.id ?? null,
    // Contrato heredado: la ventana enfocada alimenta el CTA de guardar.
    // Incógnito excluida por defecto (consistente con captureAllWindows).
    groups: active && !active.incognito ? active.groups : [],
    ungrouped: active && !active.incognito ? active.ungrouped : [],
  };
}

/**
 * Captura grupos y tabs sueltos de la ventana actual (contrato Fases 3–6).
 * Reimplementado sobre groupify para una única lógica de agrupación.
 * @returns {Promise<{ groups: any[], ungrouped: any[] }>}
 */
export async function captureLiveGroups() {
  const win = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ currentWindow: true });
  /** @type {any[]} */
  let nativeGroups = [];
  try {
    nativeGroups = await chrome.tabGroups.query({ windowId: win.id });
  } catch {
    nativeGroups = [];
  }
  return groupify(tabs, nativeGroups);
}

/**
 * Crea el controlador de datos vivos para un store dado.
 * @param {import('../store.js').Store<any>} store
 */
export function createLiveGroups(store) {
  let listening = false;
  let debounceTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
  /** @type {{ scheduleRefresh: () => void, onTabUpdated: (...a: any[]) => void } | null} */
  let handles = null;

  async function refreshNow() {
    try {
      const data = await captureAllWindowsLive();
      store.dispatch({
        type: A.LIVE_DATA_UPDATED,
        groups: data.groups,
        ungrouped: data.ungrouped,
        windows: data.windows,
        activeWindowId: data.activeWindowId,
      });
    } catch {
      /* ventana puede haberse cerrado entre query y dispatch */
    }
  }

  function scheduleRefresh() {
    clearTimeout(/** @type {Exclude<ReturnType<typeof setTimeout>, null>} */ (debounceTimer));
    debounceTimer = setTimeout(() => {
      if (store.getState().view !== 'groups') return;
      void refreshNow();
    }, 120);
  }

  return {
    /** Captura inicial multi-ventana (para el bootstrap). */
    captureAll: captureAllWindowsLive,

    /** Compatibilidad: solo la ventana actual. */
    capture: captureLiveGroups,

    /** Empieza a escuchar cambios si aún no se está escuchando. */
    ensure() {
      if (listening) return;
      listening = true;
      /**
       * @param {number} _id
       * @param {{ title?: string, url?: string, groupId?: number }} change
       */
      const onTabUpdated = (_id, change) => {
        if (change.title !== undefined || change.url !== undefined || change.groupId !== undefined) {
          scheduleRefresh();
        }
      };
      chrome.tabs.onCreated.addListener(scheduleRefresh);
      chrome.tabs.onRemoved.addListener(scheduleRefresh);
      chrome.tabs.onUpdated.addListener(onTabUpdated);
      chrome.tabGroups.onCreated.addListener(scheduleRefresh);
      chrome.tabGroups.onRemoved.addListener(scheduleRefresh);
      chrome.tabGroups.onUpdated.addListener(scheduleRefresh);
      handles = { scheduleRefresh, onTabUpdated };
      if (store.getState().view === 'groups') void refreshNow();
    },

    stop() {
      if (!listening || !handles) return;
      listening = false;
      clearTimeout(/** @type {Exclude<ReturnType<typeof setTimeout>, null>} */ (debounceTimer));
      chrome.tabs.onCreated.removeListener(handles.scheduleRefresh);
      chrome.tabs.onRemoved.removeListener(handles.scheduleRefresh);
      chrome.tabs.onUpdated.removeListener(handles.onTabUpdated);
      chrome.tabGroups.onCreated.removeListener(handles.scheduleRefresh);
      chrome.tabGroups.onRemoved.removeListener(handles.scheduleRefresh);
      chrome.tabGroups.onUpdated.removeListener(handles.scheduleRefresh);
      handles = null;
    },
  };
}
