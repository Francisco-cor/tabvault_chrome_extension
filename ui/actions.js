// ui/actions.js — Tipos de acción del store (contrato único reducers ↔ acciones).
// Acciones nombradas; los reducers (ui/reducers.js) son funciones puras sobre estas.

export const A = Object.freeze({
  // Ciclo de vida
  APP_READY: 'APP_READY',
  LOADING: 'LOADING',
  FATAL_ERROR: 'FATAL_ERROR',

  // Datos (sync con storage.onChanged)
  SESSIONS_SYNCED: 'SESSIONS_SYNCED',
  TRASH_SYNCED: 'TRASH_SYNCED',
  /** Lista de backups del ring-buffer (Fase 8.3). */
  BACKUPS_SYNCED: 'BACKUPS_SYNCED',

  // Navegación
  NAVIGATED: 'NAVIGATED',
  VIEW_BACK: 'VIEW_BACK',

  // Sesiones
  SORT_CHANGED: 'SORT_CHANGED',
  TAG_FILTER_TOGGLED: 'TAG_FILTER_TOGGLED',
  TEMPLATES_FILTER_TOGGLED: 'TEMPLATES_FILTER_TOGGLED',
  DETAIL_OPENED: 'DETAIL_OPENED',
  VERSIONS_LOADED: 'VERSIONS_LOADED',
  VERSIONS_TOGGLED: 'VERSIONS_TOGGLED',
  PINNED: 'PINNED',

  // Restauración parcial (Fase 6.2): ids DESmarcados del detalle (null-vacío = todo)
  DETAIL_TAB_CHECKED: 'DETAIL_TAB_CHECKED',

  // Live groups
  LIVE_DATA_UPDATED: 'LIVE_DATA_UPDATED',
  /** Ventana activa del selector multi-ventana de GroupsView (Fase 7.6). */
  ACTIVE_WINDOW_CHANGED: 'ACTIVE_WINDOW_CHANGED',

  // Organización (Fase 7)
  WORKSPACE_CHANGED: 'WORKSPACE_CHANGED',
  FILTERS_PATCHED: 'FILTERS_PATCHED',
  FILTERS_CLEARED: 'FILTERS_CLEARED',

  // Búsqueda
  SEARCH_QUERY_CHANGED: 'SEARCH_QUERY_CHANGED',

  // Bulk
  BULK_MODE_TOGGLED: 'BULK_MODE_TOGGLED',
  BULK_CHECK_TOGGLED: 'BULK_CHECK_TOGGLED',
  BULK_CLEARED: 'BULK_CLEARED',

  // Notas (borradores en vuelo — M8)
  NOTE_DRAFT: 'NOTE_DRAFT',
  NOTE_DRAFT_CLEARED: 'NOTE_DRAFT_CLEARED',

  // UI miscelánea
  EXPANSION_TOGGLED: 'EXPANSION_TOGGLED',
  KB_INDEX_MOVED: 'KB_INDEX_MOVED',
  SETTINGS_PATCHED: 'SETTINGS_PATCHED',

  // Reloj (timestamps relativos auto-refrescantes, Fase 5.4)
  TICKED: 'TICKED',

  // Fase 9: rutinas y reglas
  ROUTINES_SYNCED: 'ROUTINES_SYNCED',
  RULES_SYNCED: 'RULES_SYNCED',
  HISTORY_SYNCED: 'HISTORY_SYNCED',

  // Fase 10: store LRU de favicons por dominio
  FAVICONS_SYNCED: 'FAVICONS_SYNCED',
});
