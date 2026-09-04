// ui/views/SessionsView.js — Vista principal: CTA guardar, workspace activo,
// filtros por tag + combinados (dominio/rango/pinned, Fase 7.3), orden manual
// con D&D (7.5), modo bulk y tarjetas virtualizadas por encima del umbral.

import { SessionCard } from '../components/SessionCard.js';
import { VIRTUALIZE_THRESHOLD, VL_ATTR, virtualize } from '../components/VirtualList.js';
import { Icon } from '../components/Icon.js';
import { escapeHtml } from '../render.js';
import { filterByWorkspace, applyCombinedFilters } from '../../core/organization.js';
import { shouldRemindExport } from '../../core/backups.js';

const CARD_ROW_HEIGHT = 88;

/**
 * Set de TODAS las tags de una sesión (nivel sesión, grupo y tab). Puro.
 * @param {any} session
 * @returns {Set<string>}
 */
export function sessionTagSet(session) {
  const tags = new Set();
  for (const t of session?.tags ?? []) tags.add(t);
  for (const g of session?.groups ?? []) {
    for (const t of g.tags ?? []) tags.add(t);
  }
  return addTabListTags(tags, session);
}

/** @param {Set<string>} tags @param {any} session */
function addTabListTags(tags, session) {
  const lists = [
    ...(session?.groups ?? []).map((/** @type {any} */ g) => g.tabs ?? []),
    session?.ungroupedTabs ?? [],
  ];
  for (const tabs of lists) {
    for (const tab of tabs) {
      for (const t of tab.tags ?? []) tags.add(t);
    }
  }
  return tags;
}

/** @param {import('../../shared/types.js').Session[]} sessions @param {string[]} filterTags */
export function filterByTags(sessions, filterTags) {
  if (filterTags.length === 0) return sessions;
  return sessions.filter((session) => {
    const sessionTags = sessionTagSet(session);
    return filterTags.every((tag) => sessionTags.has(tag));
  });
}

/** Comparadores de orden por criterio (pinned se maneja aparte). */
const COMPARATORS = {
  oldest: (/** @type {any} */ a, /** @type {any} */ b) => a.updated - b.updated,
  az: (/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name),
  za: (/** @type {any} */ a, /** @type {any} */ b) => b.name.localeCompare(a.name),
  tabs: (/** @type {any} */ a, /** @type {any} */ b) =>
    (b.metadata?.tabCount ?? 0) - (a.metadata?.tabCount ?? 0),
  newest: (/** @type {any} */ a, /** @type {any} */ b) => b.updated - a.updated,
  // Manual (7.5): campo `order` ascendente; sin order → al final por updated.
  manual: (/** @type {any} */ a, /** @type {any} */ b) =>
    (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || b.updated - a.updated,
};

/** Orden puro: pinned primero, luego criterio.
 * @param {import('../../shared/types.js').Session[]} arr @param {string} sortBy
 */
export function sortSessions(arr, sortBy) {
  const compare = COMPARATORS[/** @type {keyof typeof COMPARATORS} */ (sortBy)] ?? COMPARATORS.newest;
  return [...arr].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return compare(a, b);
  });
}

/**
 * Todas las tags del vault (para la barra de filtros y el autocomplete).
 * Incluye nivel sesión y nivel tab desde Fase 7.3. @param {{sessions: any}} state
 */
export function collectAllTags(state) {
  const tags = new Set();
  for (const session of Object.values(state.sessions)) {
    for (const t of sessionTagSet(session)) tags.add(t);
  }
  return [...tags].sort();
}

/**
 * Filtro de plantillas (Fase 6.3): sección filtrable propia.
 * Puro y testeable.
 * @param {import('../../shared/types.js').Session[]} sessions @param {boolean} templatesOnly
 */
export function applyTemplateFilter(sessions, templatesOnly) {
  return templatesOnly ? sessions.filter((s) => s.isTemplate === true) : sessions;
}

/**
 * Pipeline completo de visibilidad: workspace → plantillas → tags → combinados → sort.
 * @param {any} state
 * @returns {import('../../shared/types.js').Session[]}
 */
export function visibleSessions(state) {
  const filtered = applyCombinedFilters(
    filterByTags(
      applyTemplateFilter(
        filterByWorkspace(Object.values(state.sessions), state.workspace),
        state.templatesOnly
      ),
      state.filterTags
    ),
    state.activeFilters,
    state.now
  );
  return sortSessions(filtered, state.sortBy);
}

export const SessionsView = {
  deps: (/** @type {any} */ state) => [
    state.sessions,
    state.liveGroups.length,
    state.liveUngrouped.length,
    state.filterTags,
    state.templatesOnly,
    state.sortBy,
    state.bulkMode,
    state.bulkSelected,
    state.workspace,
    state.activeFilters,
    // El reloj de 60s repinta las cards para refrescar "2m ago" → "3m ago".
    Math.floor(state.now / 60000),
    // Recordatorio de export (Fase 8.3): depende de settings y del reloj.
    state.settings?.lastManualExport ?? 0,
    state.settings?.reminderDismissedAt ?? 0,
  ],

  /** @param {any} state */
  render(state) {
    const sorted = visibleSessions(state);
    const allTags = collectAllTags(state);
    const hasTemplates = Object.values(/** @type {any} */ (state.sessions)).some(
      (/** @type {any} */ s) => s.isTemplate === true
    );

    const cards =
      sorted.length === 0
        ? emptyState(state.filterTags.length > 0 || hasActiveFilters(state), state.templatesOnly)
        : sorted.length > VIRTUALIZE_THRESHOLD
          ? `<div class="virtual-list" ${VL_ATTR}="1" data-vl-total="${sorted.length}" data-vl-row="${CARD_ROW_HEIGHT}"></div>`
          : sorted.map((/** @type {any} */ s, i) => card(s, state, i)).join('');

    return `
    <div class="save-cta" id="save-cta">
      <div class="save-cta-text">
        <strong>Save current session</strong>
        <span>${state.liveGroups.length} group${state.liveGroups.length !== 1 ? 's' : ''} · ${countCurrentTabs(state)} tabs open</span>
      </div>
      <button class="btn-primary" data-action="open-save-modal">Save</button>
    </div>
    ${exportReminderBanner(state)}
    ${filterBar(allTags, state, hasTemplates)}
    ${sortBar(sorted, state)}
    ${cards}`;
  },

  /**
   * Pinta/conecta la región virtualizada si corresponde.
   * @param {any} ctx @param {any} state
   */
  after(ctx, state) {
    const sorted = visibleSessions(state);
    if (sorted.length <= VIRTUALIZE_THRESHOLD) return;
    virtualize(ctx.mount, (win) => {
      const slice = sorted
        .slice(win.start, win.end)
        .map((/** @type {any} */ s, i) => card(s, state, win.start + i))
        .join('');
      return `<div style="height:${win.padTop}px"></div>${slice}<div style="height:${win.padBottom}px"></div>`;
    });
  },
};

/** ¿Hay filtros combinados o workspace activos? @param {any} state */
function hasActiveFilters(state) {
  const f = state.activeFilters;
  return !!f && (Boolean(f.domain) || f.range !== 'any' || f.pinnedOnly);
}

/**
 * Banner de recordatorio de export manual (Fase 8.3): ≥14 días sin exportar
 * ni descartar, y con datos que proteger. Dismissible.
 * @param {any} state
 */
function exportReminderBanner(state) {
  const s = state.settings;
  if (!s || Object.keys(state.sessions).length === 0) return '';
  if (!shouldRemindExport(s.lastManualExport ?? 0, s.reminderDismissedAt ?? 0, state.now)) return '';
  const last = s.lastManualExport
    ? `last export ${formatRelative(state.now - s.lastManualExport)} ago`
    : 'never exported';
  return `
  <div class="export-reminder" role="status">
    <span>${Icon('upload', 12)}</span>
    <p><strong>Protect your data.</strong> You have ${last}. A backup takes one click.</p>
    <button class="btn-secondary" data-action="export-from-reminder">Export now</button>
    <button class="btn-ghost" data-action="dismiss-export-reminder" aria-label="Dismiss reminder">Dismiss</button>
  </div>`;
}

/** @param {number} ms */
function formatRelative(ms) {
  if (ms >= 86_400_000) return `${Math.floor(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

/** @param {boolean} filtered @param {boolean} [templatesOnly] */
function emptyState(filtered, templatesOnly = false) {
  if (templatesOnly) {
    return `
    <div class="empty-state">
      ${Icon('bookmark', 44, 'class="empty-icon" stroke-width="1.2"')}
      <h4>No templates</h4>
      <p>Mark a session with the bookmark icon to reuse it without losing it.</p>
    </div>`;
  }
  if (filtered) {
    return `
    <div class="empty-state">
      ${Icon('search', 44, 'class="empty-icon" stroke-width="1.2"')}
      <h4>No sessions match these filters</h4>
      <p>Try removing a filter.</p>
      <button class="btn-secondary" data-action="clear-filters">Clear all filters</button>
    </div>`;
  }
  // Empty state con acción primaria embebida (Fase 5.4).
  return `
    <div class="empty-state">
      ${Icon('grid', 44, 'class="empty-icon" stroke-width="1.2"')}
      <h4>No sessions yet</h4>
      <p>Save your current tabs as a session to get started.</p>
      <button class="btn-primary" data-action="open-save-modal">Save your first session</button>
    </div>`;
}

/** @param {any} s @param {any} state @param {number} index índice visual para D&D manual */
function card(s, state, index) {
  return SessionCard(s, {
    bulkMode: state.bulkMode,
    bulkSelected: state.bulkSelected,
    now: state.now,
    draggable: state.sortBy === 'manual' && !s.pinned,
    cardIndex: index,
  });
}

/**
 * Barra de filtros: chips de tag + plantillas + filtros combinados (7.3).
 * @param {string[]} allTags @param {any} state @param {boolean} hasTemplates
 */
function filterBar(allTags, state, hasTemplates) {
  const tagChips = allTags.map(
    (tag) => `
      <button class="tag-filter-chip ${state.filterTags.includes(tag) ? 'active' : ''}"
        data-action="toggle-filter-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`
  );
  const templateChip = hasTemplates
    ? `
      <button class="tag-filter-chip template-filter-chip ${state.templatesOnly ? 'active' : ''}"
        data-action="toggle-template-filter"
        title="Show only templates — restoring them never marks them as used">
        ${Icon('bookmark', 10)} Templates
      </button>`
    : '';
  const manageChip =
    allTags.length > 0 || hasTemplates
      ? `
      <button class="tag-filter-chip manage-chip" data-action="manage-tags"
        title="Manage tags: rename, merge or delete everywhere">
        ${Icon('settings', 9)} Manage
      </button>`
      : '';

  const combined = combinedFilterRow(state);
  if (tagChips.length === 0 && !templateChip && !manageChip && !combined) return '';
  return `<div class="tag-filter-bar">${tagChips.join('')}${templateChip}${manageChip}</div>${combined}`;
}

/**
 * Fila de filtros combinados: dominio, rango de fechas y solo-pinned.
 * Se serializa al hash del popup (compartible/recargable).
 * @param {any} state
 */
function combinedFilterRow(state) {
  const f = state.activeFilters ?? {};
  return `
  <div class="filters-row" role="group" aria-label="Advanced filters">
    <input type="text" class="search-input filters-domain" placeholder="domain…"
      value="${escapeHtml(f.domain ?? '')}" data-action="filters-domain"
      aria-label="Filter by domain" spellcheck="false">
    <select class="select filters-range" data-action="filters-range" aria-label="Date range">
      <option value="any" ${f.range === 'any' ? 'selected' : ''}>Any time</option>
      <option value="today" ${f.range === 'today' ? 'selected' : ''}>Today</option>
      <option value="week" ${f.range === 'week' ? 'selected' : ''}>This week</option>
      <option value="month" ${f.range === 'month' ? 'selected' : ''}>This month</option>
    </select>
    <button class="tag-filter-chip ${f.pinnedOnly ? 'active' : ''}" data-action="toggle-pinned-filter"
      title="Show only pinned sessions">${Icon('star', 9, `fill="${f.pinnedOnly ? 'currentColor' : 'none'}"`)} Pinned</button>
    ${
      hasActiveFilters(state)
        ? `<button class="btn-ghost" data-action="clear-filters" style="font-size:10px">Clear</button>`
        : ''
    }
  </div>`;
}

/**
 * Selector de orden (+Manual 7.5) + toggle bulk (solo con >1 sesión).
 * En modo manual se muestra una pista de arrastre.
 * @param {any[]} sorted @param {any} state
 */
function sortBar(sorted, state) {
  if (sorted.length <= 1) return '';
  const options = [
    ['newest', 'Newest'],
    ['oldest', 'Oldest'],
    ['az', 'A → Z'],
    ['za', 'Z → A'],
    ['tabs', 'Most tabs'],
    ['manual', 'Manual'],
  ];
  const isManual = state.sortBy === 'manual';
  const bulkToggle =
    Object.keys(state.sessions).length > 1
      ? `<button class="btn-ghost" data-action="bulk-toggle" style="margin-left:auto;font-size:10px">
          ${state.bulkMode ? 'Cancel' : 'Select'}
        </button>`
      : '';
  const hint =
    isManual && !state.bulkMode
      ? `<span class="manual-hint" style="margin-left:6px;font-size:10px;color:var(--text-dim)">drag to reorder</span>`
      : '';
  return `
    <div class="sort-bar">
      <span class="sort-label">Sort</span>
      <select class="select" data-action="sort-select">
        ${options
          .map(
            ([v, label]) => `<option value="${v}" ${state.sortBy === v ? 'selected' : ''}>${label}</option>`
          )
          .join('')}
      </select>
      ${hint}
      ${bulkToggle}
    </div>`;
}

/** @param {any} state */
function countCurrentTabs(state) {
  return (
    state.liveGroups.reduce((/** @type {number} */ n, /** @type {any} */ g) => n + g.tabs.length, 0) +
    state.liveUngrouped.length
  );
}
