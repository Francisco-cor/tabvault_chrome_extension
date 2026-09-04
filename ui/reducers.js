// ui/reducers.js — Reducers puros del store de UI, compuestos por dominio.
// Sin DOM, sin efectos: (state, action) → state. 100% testeables con Vitest.

import { A } from './actions.js';
import { parseFilters, emptyFilters } from '../core/organization.js';

/** @typedef {import('../shared/types.js').Session} Session */
/** @typedef {import('../shared/types.js').Settings} Settings */

/**
 * Estado inicial de la app.
 * `notes` guarda borradores de notas en vuelo (clave `sid|gid|tid`) para que
 * un re-render disparado por un auto-save del SW nunca pierda texto (M8).
 */
export function initialState() {
  return {
    ready: false,
    loading: true,
    view: 'sessions',
    detailSessionId: null,
    showVersions: false,
    versionsBySession: {},
    searchQuery: '',
    sortBy: 'newest',
    theme: 'dark',
    filterTags: [],
    bulkMode: false,
    bulkSelected: /** @type {string[]} */ ([]),
    expanded: /** @type {string[]} */ ([]),
    kbIndex: -1,
    /** Filtro "solo plantillas" de la vista Sessions (Fase 6.3). */
    templatesOnly: false,
    /**
     * Tabs DESmarcadas del detalle (restauración parcial, Fase 6.2).
     * Lista vacía = todo seleccionado (modelo implícito-positivo).
     * @type {string[]}
     */
    detailUnchecked: [],
    sessions: {},
    trash: {},
    /** Ring-buffer de backups visible en Settings (Fase 8.3). */
    backups: { daily: [], event: [] },
    /** Rutinas programadas (Fase 9.4). */
    routines: /** @type {import('../shared/types.js').Routine[]} */ ([]),
    /** Reglas de auto-tag (Fase 9.5). */
    autoTagRules: /** @type {import('../shared/types.js').AutoTagRule[]} */ ([]),
    /** Resultados de historial para búsqueda (Fase 9.7). */
    historyResults: /** @type {any[]} */ ([]),
    /** Store LRU de favicons por dominio (Fase 10.2). */
    favicons: /** @type {import('../core/favicons.js').FaviconStore} */ ({ entries: {}, bytes: 0 }),
    liveGroups: [],
    liveUngrouped: [],
    /** Ventanas vivas para el selector multi-ventana de GroupsView (7.6). @type {any[]} */
    liveWindows: [],
    /** Ventana seleccionada en GroupsView (null = la enfocada). */
    activeWindowId: /** @type {number|null} */ (null),
    /**
     * Workspace activo del switcher del header ('' = todos, Fase 7.4).
     * Persistido en settings.workspace para sobrevivir al cierre del popup.
     */
    workspace: '',
    /** Filtros combinados persistentes (tag va aparte en filterTags). */
    activeFilters: emptyFilters(),
    notes: {},
    /** Reloj de la UI (epoch ms): TICKED cada 60s refresca timestamps relativos. */
    now: Date.now(),
    /** @type {Settings|null} Preferencias normalizadas (disponibles tras APP_READY). */
    settings: null,
    error: null,
  };
}

/** Clave estable para borradores de nota y focus-keeping.
 * @param {string|null} sessionId @param {string|null} groupId @param {string|null} tabId
 */
export const noteKey = (sessionId, groupId, tabId) => `${sessionId}|${groupId ?? ''}|${tabId ?? ''}`;

/**
 * Raíz: composición por dominio. Cada reducer es puro e independiente.
 * @param {ReturnType<typeof initialState>} state
 * @param {{ type: string, [k: string]: any }} action
 */
export function rootReducer(state, action) {
  return dataReducer(navReducer(uiReducer(state, action), action), action);
}

// ─── Ciclo de vida ───────────────────────────────────────────────────────────

/**
 * @param {any} state
 * @param {{ type: string, [k: string]: any }} action
 */
function lifecycleReducer(state, action) {
  switch (action.type) {
    case A.APP_READY:
      return {
        ...state,
        ready: true,
        loading: false,
        sessions: action.sessions,
        trash: action.trash,
        settings: action.settings,
        theme: action.settings.theme,
        sortBy: action.settings.sortBy,
        workspace: typeof action.settings.workspace === 'string' ? action.settings.workspace : '',
        // Filtros combinados desde el hash del popup (compartibles, Fase 7.3).
        activeFilters: parseFilters(typeof location !== 'undefined' ? location.hash : ''),
        liveGroups: action.liveGroups ?? state.liveGroups,
        liveUngrouped: action.liveUngrouped ?? state.liveUngrouped,
        routines: action.routines ?? state.routines,
        autoTagRules: action.rules ?? state.autoTagRules,
      };
    case A.LOADING:
      return { ...state, loading: true };
    case A.FATAL_ERROR:
      return { ...state, error: action.error };
    default:
      return state;
  }
}

// ─── Datos (sesiones, papelera, live, notas, versiones) ──────────────────────

/**
 * @param {any} state
 * @param {{ type: string, [k: string]: any }} action
 */
function dataReducer(state, action) {
  switch (action.type) {
    case A.SESSIONS_SYNCED:
      // Los borradores NO se tocan: un auto-save a mitad de edición preserva el texto.
      return { ...state, sessions: action.sessions };
    case A.TRASH_SYNCED:
      return { ...state, trash: action.trash };
    case A.ROUTINES_SYNCED:
      return { ...state, routines: action.routines ?? [] };
    case A.RULES_SYNCED:
      return { ...state, autoTagRules: action.rules ?? [] };
    case A.HISTORY_SYNCED:
      return { ...state, historyResults: action.items ?? [] };
    case A.FAVICONS_SYNCED:
      return { ...state, favicons: action.favicons ?? { entries: {}, bytes: 0 } };
    case A.LIVE_DATA_UPDATED:
      return {
        ...state,
        liveGroups: action.groups,
        liveUngrouped: action.ungrouped,
        // Multi-ventana (7.6): payload opcional; sin él se conserva lo previo.
        liveWindows: action.windows ?? state.liveWindows,
        activeWindowId: action.activeWindowId !== undefined ? action.activeWindowId : state.activeWindowId,
      };
    case A.ACTIVE_WINDOW_CHANGED:
      return { ...state, activeWindowId: Number(action.windowId) };
    case A.NOTE_DRAFT:
      return { ...state, notes: { ...state.notes, [action.key]: action.value } };
    case A.NOTE_DRAFT_CLEARED: {
      if (!(action.key in state.notes)) return state;
      const notes = { ...state.notes };
      delete notes[action.key];
      return { ...state, notes };
    }
    case A.VERSIONS_LOADED:
      return {
        ...state,
        versionsBySession: { ...state.versionsBySession, [action.sessionId]: action.versions },
      };
    default:
      return lifecycleReducer(state, action);
  }
}

// ─── Navegación y vistas ─────────────────────────────────────────────────────

/**
 * @param {any} state
 * @param {{ type: string, [k: string]: any }} action
 */
function navReducer(state, action) {
  switch (action.type) {
    case A.NAVIGATED:
      return {
        ...state,
        view: action.view,
        detailSessionId: action.detailSessionId ?? null,
        showVersions: false,
        bulkMode: false,
        bulkSelected: [],
        kbIndex: -1,
        detailUnchecked: [],
        searchQuery: action.view === 'search' ? state.searchQuery : '',
      };
    case A.VIEW_BACK:
      return {
        ...state,
        view: action.view,
        detailSessionId: action.view === 'detail' ? state.detailSessionId : null,
        showVersions: false,
        kbIndex: -1,
        detailUnchecked: [],
      };
    case A.DETAIL_OPENED:
      return {
        ...state,
        view: 'detail',
        detailSessionId: action.sessionId,
        showVersions: false,
        detailUnchecked: [],
      };
    case A.VERSIONS_TOGGLED:
      return { ...state, showVersions: !state.showVersions };
    case A.SEARCH_QUERY_CHANGED:
      return { ...state, searchQuery: action.query, kbIndex: -1 };
    case A.KB_INDEX_MOVED:
      return { ...state, kbIndex: Math.max(-1, action.index | 0) };
    default:
      return state;
  }
}

// ─── UI miscelánea (filtros, bulk, settings, expansión) ──────────────────────

/**
 * Filtros y workspace (Fase 7): chips de tag, plantillas, combinados y switcher.
 * @param {any} state
 * @param {{ type: string, [k: string]: any }} action
 */
function filtersReducer(state, action) {
  switch (action.type) {
    case A.SORT_CHANGED:
      return { ...state, sortBy: action.sortBy };
    case A.TAG_FILTER_TOGGLED:
      return toggleTagFilter(state, action.tag);
    case A.TEMPLATES_FILTER_TOGGLED:
      return { ...state, templatesOnly: !state.templatesOnly };
    case A.WORKSPACE_CHANGED:
      return { ...state, workspace: String(action.workspace ?? '') };
    case A.FILTERS_PATCHED:
      return { ...state, activeFilters: { ...state.activeFilters, ...action.patch } };
    case A.FILTERS_CLEARED:
      return { ...state, activeFilters: emptyFilters() };
    default:
      return state;
  }
}

/**
 * @param {any} state
 * @param {{ type: string, [k: string]: any }} action
 */
function uiReducer(state, action) {
  switch (action.type) {
    case A.DETAIL_TAB_CHECKED:
      return { ...state, detailUnchecked: applyDetailCheck(state.detailUnchecked, action) };
    case A.PINNED:
      return {
        ...state,
        sessions: { ...state.sessions, [action.id]: { ...state.sessions[action.id], pinned: action.pinned } },
      };
    case A.EXPANSION_TOGGLED:
      return toggleExpansion(state, action.key);
    case A.SETTINGS_PATCHED:
      return { ...state, settings: { ...(state.settings ?? {}), ...action.patch } };
    case A.BACKUPS_SYNCED:
      return { ...state, backups: action.backups ?? { daily: [], event: [] } };
    case A.TICKED:
      return { ...state, now: action.now ?? Date.now() };
    default:
      return bulkReducer(filtersReducer(state, action), action);
  }
}

/** @param {any} state @param {string} tag */
function toggleTagFilter(state, tag) {
  const has = state.filterTags.includes(tag);
  const filterTags = has
    ? state.filterTags.filter((/** @type {string} */ t) => t !== tag)
    : [...state.filterTags, tag];
  return { ...state, filterTags };
}

/**
 * on=true fuerza marcado (quita de desmarcadas); si no, toggle puro. Puro.
 * @param {string[]} unchecked @param {{ tabId: string, on?: boolean }} action
 */
function applyDetailCheck(unchecked, /** @type {any} */ action) {
  const has = unchecked.includes(action.tabId);
  if (action.on === true || has) return unchecked.filter((id) => id !== action.tabId);
  return [...unchecked, action.tabId];
}

/** @param {any} state @param {string} key */
function toggleExpansion(state, key) {
  const has = state.expanded.includes(key);
  return {
    ...state,
    expanded: has ? state.expanded.filter((/** @type {string} */ k) => k !== key) : [...state.expanded, key],
  };
}

// ─── Modo bulk ───────────────────────────────────────────────────────────────

/**
 * @param {any} state
 * @param {{ type: string, [k: string]: any }} action
 */
function bulkReducer(state, action) {
  switch (action.type) {
    case A.BULK_MODE_TOGGLED:
      return { ...state, bulkMode: action.on, bulkSelected: [] };
    case A.BULK_CHECK_TOGGLED: {
      const selected = state.bulkSelected.includes(action.id)
        ? state.bulkSelected.filter((/** @type {string} */ id) => id !== action.id)
        : [...state.bulkSelected, action.id];
      return { ...state, bulkSelected: selected };
    }
    case A.BULK_CLEARED:
      return { ...state, bulkMode: false, bulkSelected: [] };
    default:
      return state;
  }
}
