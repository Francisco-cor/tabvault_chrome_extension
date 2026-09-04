// ui/views/GroupsView.js — Grupos vivos + ungrouped de LA VENTANA SELECCIONADA.
// Fase 7.6 (M13): selector multi-ventana; acciones por tab (cerrar/pin/stash)
// y por grupo (guardar como sesión individual).

import { groupColorHex, truncateUrl } from '../../shared/utils.js';
import { Icon } from '../components/Icon.js';
import { favIconHtml } from '../components/Favicon.js';
import { escapeHtml } from '../render.js';

/**
 * Derivación pura: datos de la ventana seleccionada (o la enfocada).
 * @param {any} state @returns {{ win: any|null, groups: any[], ungrouped: any[] }}
 */
export function selectedWindowData(state) {
  const wins = state.liveWindows ?? [];
  if (wins.length === 0) {
    // Compatibilidad: sin captura multi-ventana, usa el contrato heredado.
    return { win: null, groups: state.liveGroups, ungrouped: state.liveUngrouped };
  }
  const win =
    wins.find((/** @type {any} */ w) => w.id === state.activeWindowId) ??
    wins.find((/** @type {any} */ w) => w.focused) ??
    wins[0];
  return { win, groups: win?.groups ?? [], ungrouped: win?.ungrouped ?? [] };
}

export const GroupsView = {
  deps: (/** @type {any} */ state) => [
    state.liveWindows,
    state.activeWindowId,
    state.liveGroups,
    state.liveUngrouped,
    state.expanded,
    state.favicons,
  ],

  /** @param {any} state */
  render(state) {
    const { win, groups, ungrouped } = selectedWindowData(state);

    if (!win && groups.length === 0 && ungrouped.length === 0) {
      return `
      <div class="empty-state">
        ${Icon('list', 44, 'class="empty-icon" stroke-width="1.2"')}
        <h4>No tab groups</h4>
        <p>Create tab groups in Chrome by right-clicking a tab and selecting "Add to group".</p>
      </div>`;
    }

    return `${windowSelector(state)}<div class="groups-toolbar" style="display:flex;gap:6px;margin-bottom:8px"><button class="btn-secondary" data-action="suspend-now">${Icon('zap', 11)} Free memory</button><span class="text-muted" style="font-size:11px;align-self:center">Save inactive tabs into "Suspended"</span></div>${groups.map((g) => liveGroupCard(g, state)).join('')}${
      ungrouped.length > 0 ? liveGroupCard(ungroupedAsGroup(ungrouped), state) : ''
    }`;
  },
};

/**
 * Selector de ventana activa (M13). Oculto con una sola ventana normal.
 * @param {any} state
 */
function windowSelector(state) {
  const wins = (state.liveWindows ?? []).filter(
    (/** @type {any} */ w) => w.groups.length > 0 || w.ungrouped.length > 0
  );
  if (wins.length <= 1) return '';
  const current = state.activeWindowId;
  const options = wins
    .map((/** @type {any} */ w, /** @type {number} */ i) => {
      const label = `Window ${i + 1}${w.incognito ? ' · incognito' : ''}${w.focused ? ' ★' : ''}`;
      return `<option value="${w.id}" ${w.id === current ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    })
    .join('');
  return `
  <div class="window-select-bar">
    ${Icon('window', 12)}
    <select class="select" data-action="live-window-select" aria-label="Active window">${options}</select>
  </div>`;
}

/** @param {any[]} tabs */
function ungroupedAsGroup(tabs) {
  return { id: 'ungrouped', name: 'Ungrouped', color: null, tabs };
}

/**
 * @param {{ id: string|number, name: string, color: string|null, tabs: any[] }} g
 * @param {any} state estado completo (expanded)
 */
function liveGroupCard(g, state) {
  const key = `live-${g.id}`;
  const colorHex = g.color ? groupColorHex(g.color) : 'var(--text-muted)';
  const isOpen = state.expanded.includes(key);
  const isNativeGroup = typeof g.id === 'number';
  const saveBtn = isNativeGroup
    ? `<button class="btn-ghost live-save-group" data-action="save-group-session"
        data-group-id="${escapeHtml(String(g.id))}"
        title="Save this group as its own session">${Icon('plus', 10)} Save as session</button>`
    : '';
  return `
    <div class="live-group-card ${isOpen ? 'expanded' : ''}" data-group-id="${escapeHtml(String(g.id))}"
      style="border-left-color:${colorHex}">
      <div class="live-group-header" data-action="toggle-live-group" data-group-id="${escapeHtml(String(g.id))}">
        <div class="live-group-title">
          <span class="color-dot" style="background:${colorHex}"></span>
          <span class="live-group-name">${escapeHtml(g.name)}</span>
          <span class="live-group-count">${g.tabs.length} tab${g.tabs.length !== 1 ? 's' : ''}</span>
        </div>
        ${saveBtn}
        <svg class="live-group-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9,18 15,12 9,6"/></svg>
      </div>
      <div class="live-group-tabs">${g.tabs.map((/** @type {any} */ t) => liveTab(t, state.favicons)).join('')}</div>
    </div>`;
}

/** @param {{ id: number, favicon: string, title: string, url: string }} t @param {any} favicons */
function liveTab(t, favicons) {
  return `
    <div class="live-tab-item">
      ${favIconHtml(t.url, favicons)}
      <div class="live-tab-info">
        <div class="live-tab-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>
        <div class="live-tab-url" title="${escapeHtml(t.url)}">${escapeHtml(truncateUrl(t.url))}</div>
      </div>
      <span class="live-tab-actions">
        <button class="btn-ghost" data-action="live-tab-pin" data-tab-id="${t.id}" title="Toggle pin">${Icon('star', 11)}</button>
        <button class="btn-ghost" data-action="live-tab-stash" data-tab-id="${t.id}" title="Stash in TabVault">${Icon('bookmark', 11)}</button>
        <button class="btn-ghost btn-danger" data-action="live-tab-close" data-tab-id="${t.id}" title="Close tab">${Icon('x', 11)}</button>
      </span>
    </div>`;
}
